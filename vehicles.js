import * as THREE from 'three';

// ============================================================================
// Vehicles for the race mode.
//
// Each vehicle lives in track coordinates like the ball: s (along), x (lateral),
// plus a heading psi relative to the track tangent (positive = pointing left).
// Planar motion is a bicycle model: front and rear axle slip angles produce
// lateral tyre forces capped by friction * axle load, so the rear can break away
// (drift), and drive force eats into rear grip (power oversteer).
// Each wheel has its own spring-damper suspension; the body has heave, pitch and
// roll; wheel loads feed the tyre grip (load transfer). Vehicle frame: x forward,
// y left, z up; yaw rate r positive to the left.
// ============================================================================

const V3 = THREE.Vector3;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

export const SPECS = {
  monster: { kind: 'monster', a: 1.7, b: 1.7, ht: 1.45, Rw: 0.95, ww: 0.8, L0: 0.95, k: 25, cd: 2.0, muF: 1.6, muR: 1.45, hcg: 1.3, Ip: 2.6, Ir: 1.4, Iz: 2.9, jumpV: 13, halfW: 1.9, halfL: 2.6 },
  car:     { kind: 'car',     a: 1.45, b: 1.45, ht: 1.0, Rw: 0.45, ww: 0.42, L0: 0.35, k: 60, cd: 3.4, muF: 1.75, muR: 1.6, hcg: 0.5, Ip: 1.9, Ir: 0.8, Iz: 2.1, jumpV: 11, halfW: 1.25, halfL: 2.3 },
};

export class Vehicle {
  constructor(ctx, spec, opts) {
    this.ctx = ctx; this.spec = spec;
    this.name = opts.name; this.color = opts.color; this.isPlayer = !!opts.isPlayer;
    this.F = ctx.mkF(); this.Fw = ctx.mkF();
    this.wheels = [
      { lx: spec.a, ly: spec.ht }, { lx: spec.a, ly: -spec.ht },
      { lx: -spec.b, ly: spec.ht }, { lx: -spec.b, ly: -spec.ht },
    ].map(w => ({ ...w, g: 0, F: 0, ya: 0, contact: false, spin: 0 }));
    this.z0 = spec.Rw + spec.L0 - ctx.G / (4 * spec.k);
    this.reset(0, 0, 0);
    this.ai = opts.ai || null;
    this.mesh = buildVehicleMesh(spec, opts.color, ctx.tyreTex, ctx.blobTex);
  }

  reset(s, x, v) {
    Object.assign(this, {
      s, x, psi: 0, vx: v, vy: 0, r: 0, delta: 0,
      z: this.z0, zd: 0, th: 0, thd: 0, ph: 0, phd: 0,
      ax: 0, ay: 0, contacts: 4, dead: false, fallT: 0, air: 0, drift: 0, alphaR: 0,
      finished: false, finishPlace: 0, finishTime: 0, jumpCD: 0,
    });
  }

  // speed along the track and across it
  trackVel() {
    const c = Math.cos(this.psi), sn = Math.sin(this.psi);
    return { sd: this.vx * c - this.vy * sn, xd: -this.vx * sn - this.vy * c };
  }
  setTrackVel(sd, xd) {
    const c = Math.cos(this.psi), sn = Math.sin(this.psi);
    this.vx = sd * c - xd * sn;
    this.vy = -sd * sn - xd * c;
  }

  step(dt, steer, jump, target) {
    const ctx = this.ctx, tr = ctx.track(), sp = this.spec, G = ctx.G, HW = ctx.HW();
    if (this.dead) { this.zd -= G * dt; this.z += this.zd * dt; this.fallT += dt; return; }
    const F = ctx.frameAt(this.s, this.F);
    const sm = tr.smp[F.i];
    const cps = Math.cos(this.psi), sps = Math.sin(this.psi);
    const gT = -G * F.T.y, gB = -G * F.B.y, gU = -G * F.U.y;
    const sd = this.vx * cps - this.vy * sps;

    // ---- suspension: ground height under each wheel, spring-damper force
    let Fz = 0, Mth = 0, Mph = 0, Nf = 0, Nr = 0, contacts = 0;
    for (const w of this.wheels) {
      const dT = w.lx * cps - w.ly * sps, dB = -w.lx * sps - w.ly * cps;
      const ws = this.s + dT, wx = this.x + dB;
      const Fw = ctx.frameAt(ws, this.Fw);
      const smw = tr.smp[Fw.i];
      let g = null;
      if (smw.solid && Math.abs(wx) <= HW + 0.8) {
        g = (Fw.P.x + Fw.B.x * wx - F.P.x - F.B.x * this.x) * F.U.x
          + (Fw.P.y + Fw.B.y * wx - F.P.y - F.B.y * this.x) * F.U.y
          + (Fw.P.z + Fw.B.z * wx - F.P.z - F.B.z * this.x) * F.U.z;
      }
      const ya = this.z + this.th * w.lx + this.ph * w.ly;
      const yad = this.zd + this.thd * w.lx + this.phd * w.ly;
      let f = 0;
      if (g !== null) {
        const comp = sp.L0 - (ya - g - sp.Rw);
        if (comp > 0) {
          f = sp.k * comp - sp.cd * yad;
          if (comp > sp.L0) f += 300 * (comp - sp.L0); // bump stop
          f = Math.max(0, f);
        }
      }
      w.g = g; w.F = f; w.ya = ya; w.contact = f > 0;
      if (f > 0) { contacts++; Fz += f; Mth += f * w.lx; Mph += f * w.ly; if (w.lx > 0) Nf += f; else Nr += f; }
    }
    this.contacts = contacts;

    // ---- body heave / pitch / roll
    const zdd = Fz + gU - sd * sd * F.kN;
    let thdd = (Mth + this.ax * sp.hcg) / sp.Ip;
    let phdd = (Mph + this.ay * sp.hcg) / sp.Ir;
    if (contacts === 0) { thdd = -this.th * 8 - this.thd * 3; phdd = -this.ph * 8 - this.phd * 3; this.air += dt; }
    this.zd += zdd * dt; this.z += this.zd * dt;
    this.thd += thdd * dt; this.th = clamp(this.th + this.thd * dt, -0.7, 0.7);
    this.phd += phdd * dt; this.ph = clamp(this.ph + this.phd * dt, -0.6, 0.6);
    if (sm.noDetach && this.z > this.z0 + 0.2) { this.z = this.z0 + 0.2; this.zd = Math.min(this.zd, 0); }
    this.jumpCD -= dt;
    if (jump && contacts >= 2 && !sm.noDetach && this.jumpCD <= 0) { this.zd += sp.jumpV * jump; this.jumpCD = 0.5; }

    // ---- steering: player/AI input plus a track-following assist
    const dmax = 0.55 / (1 + Math.abs(this.vx) / 22);
    const dTarget = clamp(-steer * dmax * 0.7 + (sp.a + sp.b) * (-F.kB) - 0.7 * this.psi, -0.6, 0.6);
    this.delta += (dTarget - this.delta) * (1 - Math.exp(-12 * dt));

    // ---- tyres
    const vxa = Math.max(Math.abs(this.vx), 2);
    const af = Math.atan2(this.vy + sp.a * this.r, vxa) - this.delta;
    const ar = Math.atan2(this.vy - sp.b * this.r, vxa);
    this.alphaR = ar;
    let Fx = contacts ? clamp((target - this.vx) * 1.5, -20, 22) : 0;
    Fx = clamp(Fx, -sp.muR * Nr * 1.3, sp.muR * Nr * 1.3);
    const Fyf = clamp(-7 * Nf * af, -sp.muF * Nf, sp.muF * Nf);
    const rearCap = sp.muR * Nr * Math.sqrt(Math.max(0.15, 1 - (Fx / (sp.muR * Nr * 1.3 + 1e-6)) ** 2));
    const Fyr = clamp(-7 * Nr * ar, -rearCap, rearCap);
    const gF = gT * cps - gB * sps, gL = -gT * sps - gB * cps;
    const ax = Fx - Fyf * Math.sin(this.delta) + gF * 0.55 - 0.0015 * this.vx * Math.abs(this.vx);
    const ay = Fyf * Math.cos(this.delta) + Fyr + (contacts ? gL : gL * 0.3);
    this.ax = ax; this.ay = ay;
    this.vx += (ax + this.vy * this.r) * dt;
    this.vy += (ay - this.vx * this.r) * dt;
    this.r += ((sp.a * Fyf * Math.cos(this.delta) - sp.b * Fyr) / sp.Iz) * dt;
    // stability assist (arcade ESC): yaw rate is pulled toward the road's turn rate plus what the
    // driver asks for, so the tail can slide out (drift) without spinning the vehicle round.
    // In the air the heading straightens so it lands facing down the road.
    const rWant = -F.kB * sd - (contacts ? 1.6 : 4) * this.psi - (contacts ? steer * 0.45 : 0);
    this.r += (rWant - this.r) * (1 - Math.exp(-(contacts ? 2.2 : 5) * dt));
    if (Math.abs(this.psi) > 0.9) { this.psi = Math.sign(this.psi) * 0.9; this.r *= 0.5; }
    if (this.vx < 8 && contacts) this.vx += 10 * dt;
    if (sm.minV && this.vx < sm.minV) this.vx = sm.minV;
    this.vx = clamp(this.vx, -10, 95);
    this.drift = contacts >= 2 && Math.abs(this.vx) > 12 ? Math.max(0, Math.abs(ar) - 0.1) : 0;

    // ---- integrate in track coordinates
    let tv = this.trackVel();
    if (!contacts) {
      // airborne: sideways air drag plus a little air steering, like the ball
      this.setTrackVel(tv.sd, tv.xd * Math.exp(-1.4 * dt) + steer * 10 * dt);
      tv = this.trackVel();
    }
    this.psi += (this.r + F.kB * tv.sd) * dt;
    this.s += tv.sd * dt; this.x += tv.xd * dt;
    if (contacts) this.air = 0;

    // ---- walls (raised berm on the outside of curves)
    const wall = HW - sp.halfW;
    if ((sm.berm > 0.3 && this.x > wall) || (sm.berm < -0.3 && this.x < -wall)) {
      const side = Math.sign(sm.berm);
      this.x = side * wall;
      const t2 = this.trackVel();
      if (t2.xd * side > 0) { this.setTrackVel(t2.sd * 0.97, -t2.xd * 0.4); this.psi *= 0.6; this.r *= 0.4; this.hitWall = Math.abs(t2.xd); }
    }

    // ---- falling: off the edge, or down into a gap
    const smN = tr.smp[ctx.frameAt(this.s, this.F).i];
    if ((!smN.solid && this.z < -2.5) || (Math.abs(this.x) > HW + 1.2 && this.z < this.z0 - 1.5) || this.z < -8) {
      this.dead = true; this.fallT = 0;
    }
    if (this.s >= tr.len - 1) { this.s = tr.len - 1; this.vx = 0; }
  }

  // ---------- visuals
  updateMesh(dt) {
    const m = this.mesh, F = this.ctx.frameAt(this.s, this.F), sp = this.spec;
    const c = Math.cos(this.psi), sn = Math.sin(this.psi);
    const fwd = new V3().copy(F.T).multiplyScalar(c).addScaledVector(F.B, -sn);
    const left = new V3().copy(F.T).multiplyScalar(-sn).addScaledVector(F.B, -c);
    const right = left.clone().negate(), back = fwd.clone().negate();
    m.root.position.copy(F.P).addScaledVector(F.B, this.x);
    m.root.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, F.U, back));
    m.body.position.y = this.z;
    m.body.rotation.set(this.th, 0, -this.ph);
    const roll = this.vx * dt;
    this.wheels.forEach((w, i) => {
      const mw = m.wheels[i];
      const lenMax = sp.L0;
      let wy = w.ya - lenMax;
      if (w.g !== null && w.ya - (w.g + sp.Rw) < lenMax) wy = w.g + sp.Rw;
      wy = Math.min(wy, w.ya - 0.05);
      mw.group.position.set(-w.ly, wy, -w.lx);
      if (i < 2) mw.group.rotation.y = this.delta;
      w.spin -= roll / sp.Rw;
      mw.spin.rotation.x = w.spin;
      const len = Math.max(0.05, w.ya - wy);
      mw.strut.position.set(-w.ly * 0.82, wy + len / 2, -w.lx);
      mw.strut.scale.y = len;
    });
    // contact shadow under the chassis
    m.blob.position.copy(F.P).addScaledVector(F.B, this.x).addScaledVector(F.U, 0.04);
    m.blob.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, fwd, F.U));
    const hgt = Math.max(0, this.z - this.z0);
    m.blob.visible = !this.dead && this.ctx.track().smp[F.i].solid;
    m.blob.material.opacity = clamp(0.85 - hgt * 0.05, 0.2, 0.85);
    m.blob.scale.setScalar(1 + hgt * 0.04);
  }

  wheelWorld(i, out) {
    const w = this.mesh.wheels[i].group;
    return w.getWorldPosition(out);
  }
}

// ----------------------------------------------------------------------------
// Meshes
// ----------------------------------------------------------------------------
export function makeTyreTexture() {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const x = c.getContext('2d');
  x.fillStyle = '#1c1c22'; x.fillRect(0, 0, 256, 64);
  x.fillStyle = '#34343e';
  for (let i = 0; i < 16; i++) { x.fillRect(i * 16, 6, 8, 22); x.fillRect(i * 16 + 8, 36, 8, 22); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.RepeatWrapping;
  return t;
}

function buildVehicleMesh(sp, color, tyreTex, blobTex) {
  const root = new THREE.Group(), body = new THREE.Group();
  root.add(body);
  const paint = new THREE.MeshStandardMaterial({ color, metalness: 0.55, roughness: 0.28, envMapIntensity: 1.2 });
  const dark = new THREE.MeshStandardMaterial({ color: '#202028', metalness: 0.4, roughness: 0.6 });
  const glass = new THREE.MeshStandardMaterial({ color: '#0d1630', metalness: 0.9, roughness: 0.08, envMapIntensity: 1.5 });
  const chrome = new THREE.MeshStandardMaterial({ color: '#dfe6f2', metalness: 1, roughness: 0.12 });
  const lamp = new THREE.MeshStandardMaterial({ color: '#fff6c0', emissive: '#ffe680', emissiveIntensity: 2 });
  const tail = new THREE.MeshStandardMaterial({ color: '#ff3040', emissive: '#ff2030', emissiveIntensity: 1.5 });
  const box = (w, h, d, mat, x, y, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); m.castShadow = true; body.add(m); return m; };

  if (sp.kind === 'monster') {
    box(2.0, 0.28, 3.9, dark, 0, 0, 0);                 // frame
    box(2.6, 0.75, 4.4, paint, 0, 0.62, 0);             // tub
    box(2.3, 0.9, 1.8, paint, 0, 1.4, 0.35);            // cab
    box(2.34, 0.48, 1.5, glass, 0, 1.45, 0.35);         // windows band
    box(2.1, 0.12, 4.3, paint, 0, 1.0, 0).scale.set(1.2, 1, 1); // fender line
    box(2.7, 0.3, 0.3, chrome, 0, 0.35, -2.3);          // front bumper
    box(2.7, 0.3, 0.3, chrome, 0, 0.35, 2.3);           // rear bumper
    for (const sx of [-0.75, -0.25, 0.25, 0.75]) box(0.32, 0.2, 0.18, lamp, sx, 1.93, -0.45); // roof lights
    for (const sx of [-0.95, 0.95]) { box(0.4, 0.2, 0.08, lamp, sx, 0.7, -2.22); box(0.4, 0.2, 0.08, tail, sx, 0.7, 2.22); }
    for (const sx of [-0.7, 0.7]) {
      const ex = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 1.3, 10), chrome);
      ex.position.set(sx, 1.85, 1.35); ex.castShadow = true; body.add(ex);
    }
  } else {
    box(2.0, 0.42, 4.5, paint, 0, 0.12, 0);                       // lower body
    const cab = box(1.7, 0.48, 2.1, paint, 0, 0.55, 0.25);        // cabin
    cab.scale.set(1, 1, 1);
    box(1.74, 0.36, 1.7, glass, 0, 0.58, 0.25);                   // glasses
    box(1.9, 0.08, 0.5, paint, 0, 0.62, 2.1);                     // spoiler
    for (const sx of [-0.8, 0.8]) { box(0.12, 0.35, 0.12, dark, sx, 0.42, 2.1); }
    for (const sx of [-0.7, 0.7]) { box(0.45, 0.14, 0.06, lamp, sx, 0.22, -2.26); box(0.45, 0.14, 0.06, tail, sx, 0.22, 2.26); }
    box(2.05, 0.06, 4.0, dark, 0, -0.1, 0);                       // floor
  }

  const tyreMat = new THREE.MeshStandardMaterial({ map: tyreTex, roughness: 0.9, metalness: 0 });
  const sideMat = new THREE.MeshStandardMaterial({ color: '#16161b', roughness: 0.85 });
  const strutMat = new THREE.MeshStandardMaterial({ color: sp.kind === 'monster' ? '#ffd23f' : '#888899', metalness: 0.8, roughness: 0.3 });
  const tyreGeo = new THREE.CylinderGeometry(sp.Rw, sp.Rw, sp.ww, 24, 1);
  tyreGeo.rotateZ(Math.PI / 2);
  const hubGeo = new THREE.CylinderGeometry(sp.Rw * 0.45, sp.Rw * 0.45, sp.ww + 0.04, 12);
  hubGeo.rotateZ(Math.PI / 2);
  const wheels = [];
  for (let i = 0; i < 4; i++) {
    const group = new THREE.Group(), spin = new THREE.Group();
    const tyre = new THREE.Mesh(tyreGeo, [tyreMat, sideMat, sideMat]); tyre.castShadow = true;
    const hub = new THREE.Mesh(hubGeo, chrome);
    spin.add(tyre, hub);
    // a spoke so the wheel visibly spins
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(sp.ww + 0.06, sp.Rw * 0.18, sp.Rw * 1.5), chrome);
    spin.add(spoke);
    group.add(spin);
    root.add(group);
    const strut = new THREE.Mesh(new THREE.CylinderGeometry(sp.kind === 'monster' ? 0.12 : 0.05, sp.kind === 'monster' ? 0.12 : 0.05, 1, 8), strutMat);
    strut.castShadow = true;
    root.add(strut);
    wheels.push({ group, spin, strut });
  }
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(sp.halfW * 2.6, sp.halfL * 2.4),
    new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, toneMapped: false }));
  blob.renderOrder = 2;
  return { root, body, wheels, blob };
}
