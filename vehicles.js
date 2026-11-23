import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

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
  // half the original size; springs stiffened so the static sag stays in proportion
  monster: { kind: 'monster', a: 0.85, b: 0.85, ht: 0.72, Rw: 0.48, ww: 0.42, L0: 0.48, k: 50, cd: 2.8, muF: 1.6, muR: 1.45, hcg: 0.65, Ip: 0.65, Ir: 0.35, Iz: 0.75, jumpV: 10.5, halfW: 0.95, halfL: 1.3 },
  car:     { kind: 'car',     a: 0.72, b: 0.72, ht: 0.5, Rw: 0.23, ww: 0.21, L0: 0.18, k: 120, cd: 4.8, muF: 1.75, muR: 1.6, hcg: 0.25, Ip: 0.5, Ir: 0.2, Iz: 0.55, jumpV: 9.5, halfW: 0.63, halfL: 1.15 },
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
    this.mesh = buildVehicleMesh(spec, opts, ctx.blobTex);
  }

  reset(s, x, v) {
    Object.assign(this, {
      s, x, psi: 0, vx: v, vy: 0, r: 0, delta: 0, surfTh: 0, surfH: 0,
      z: this.z0, zd: 0, th: 0, thd: 0, ph: 0, phd: 0,
      ax: 0, ay: 0, driftI: 0, stun: 0, wetT: 0, inWater: 0, onWet: 0, contacts: 4, dead: false, fallT: 0, air: 0, drift: 0, alphaR: 0,
      finished: false, finishPlace: 0, finishTime: 0, jumpCD: 0,
    });
    // wheels start at rest on the ground (before the first physics step runs)
    for (const w of this.wheels) { w.g = 0; w.ya = this.z0; w.F = this.ctx.G / 4; w.contact = true; }
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

  step(dt, steer, jump, target, canDrift = true) {
    const ctx = this.ctx, tr = ctx.track(), sp = this.spec, G = ctx.G, HW = ctx.HW();
    if (this.dead) { this.zd -= G * dt; this.z += this.zd * dt; this.fallT += dt; return; }
    if (this.stun > 0) this.stun -= dt;
    const F = ctx.frameAt(this.s, this.F);
    const sm = tr.smp[F.i];
    const cps = Math.cos(this.psi), sps = Math.sin(this.psi);
    const gT = -G * F.T.y, gB0 = -G * F.B.y, gU0 = -G * F.U.y;
    const sd = this.vx * cps - this.vy * sps;
    // the vehicle stands on the half-pipe surface: local up Uv is the surface normal at x
    const sfC = ctx.surfAt(this.x, sm);
    if (sfC) { this.surfTh = sfC.th; this.surfH = sfC.h; }
    const thC = this.surfTh || 0, hC = this.surfH || 0, ct = Math.cos(thC), st = Math.sin(thC);
    const gU = gU0 * ct - gB0 * st, gB = gB0 * ct + gU0 * st;   // gravity along the surface normal / across it
    const Ux = F.U.x * ct - F.B.x * st, Uy = F.U.y * ct - F.B.y * st, Uz = F.U.z * ct - F.B.z * st;
    const Pcx = F.P.x + F.B.x * this.x + F.U.x * hC, Pcy = F.P.y + F.B.y * this.x + F.U.y * hC, Pcz = F.P.z + F.B.z * this.x + F.U.z * hC;

    // ---- suspension: ground height under each wheel, spring-damper force
    let Fz = 0, Mth = 0, Mph = 0, Nf = 0, Nr = 0, contacts = 0;
    for (const w of this.wheels) {
      const dT = w.lx * cps - w.ly * sps, dB = -w.lx * sps - w.ly * cps;
      const ws = this.s + dT, wx = this.x + dB * ct;
      const Fw = ctx.frameAt(ws, this.Fw);
      const smw = tr.smp[Fw.i];
      let g = null;
      const sf = smw.solid ? ctx.surfAt(wx, smw) : null;
      if (sf) {
        const hw = sf.h;
        g = (Fw.P.x + Fw.B.x * wx + Fw.U.x * hw - Pcx) * Ux
          + (Fw.P.y + Fw.B.y * wx + Fw.U.y * hw - Pcy) * Uy
          + (Fw.P.z + Fw.B.z * wx + Fw.U.z * hw - Pcz) * Uz;
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
    const zdd = Fz + gU - sd * sd * F.kN * ct;
    let thdd = (Mth + this.ax * sp.hcg * 0.5) / sp.Ip;
    let phdd = (Mph + this.ay * sp.hcg * 0.35) / sp.Ir;
    if (contacts === 0) { thdd = -this.th * 8 - this.thd * 3; phdd = -this.ph * 8 - this.phd * 3; this.air += dt; }
    this.zd += zdd * dt; this.z += this.zd * dt;
    this.thd += thdd * dt; this.th = clamp(this.th + this.thd * dt, -0.5, 0.5);
    this.phd += phdd * dt; this.ph = clamp(this.ph + this.phd * dt, -0.35, 0.35);
    if (sm.noDetach && this.z > this.z0 + 0.2) { this.z = this.z0 + 0.2; this.zd = Math.min(this.zd, 0); }
    this.jumpCD -= dt;
    if (jump && contacts >= 2 && !sm.noDetach && this.jumpCD <= 0) { this.zd += sp.jumpV * jump; this.jumpCD = 0.5; }

    // ---- drift: steering hard at speed loosens the rear tyres and lets the tail swing out
    // water and wet road: wading drag in a ford; rain-soaked turns (and wet tyres just after a ford) have far less grip
    const wat = contacts ? (sm.water || 0) : 0;
    this.wetT = wat > 0 ? 1.5 : Math.max(0, this.wetT - dt);
    const slick = sm.wet ? 1 : this.wetT > 0 ? 0.4 : 0;     // storm-soaked road is close to ice
    this.inWater = wat; this.onWet = contacts && sm.wet ? 1 : 0;
    const wantDrift = canDrift && contacts >= 1 ? clamp((Math.abs(steer) - (0.45 - 0.15 * slick)) / 0.35, 0, 1) * clamp((this.vx - 10) / 10, 0, 1) : 0;
    this.driftI += (wantDrift - this.driftI) * (1 - Math.exp(-(wantDrift > this.driftI ? 10 : 3) * dt));
    const dI = this.driftI;

    // ---- steering: player/AI input plus a track-following assist
    const dmax = 0.55 / (1 + Math.abs(this.vx) / 22);
    // front wheels: driver input plus the road's curvature (heading itself is held by the assist below;
    // feeding heading back here as well made the two loops fight and the vehicle fishtail)
    const dTarget = clamp(-steer * dmax * 0.7 + (sp.a + sp.b) * (-F.kB), -0.6, 0.6);
    this.delta += (dTarget - this.delta) * (1 - Math.exp(-12 * dt));

    // ---- tyres
    const vxa = Math.max(Math.abs(this.vx), 2);
    const af = Math.atan2(this.vy + sp.a * this.r, vxa) - this.delta;
    const ar = Math.atan2(this.vy - sp.b * this.r, vxa);
    this.alphaR = ar;
    let Fx = 0;
    if (contacts) {
      const over = this.vx - target;
      if (this.finished) Fx = clamp(-over * 1.5, -20, 22);
      else if (over <= 0) Fx = Math.min(22, -over * 1.5);
      else Fx = gT > 1.5 ? 0 : -Math.min(5, over * 0.3);    // above cruise speed: coast (downhill: no braking at all)
    }
    Fx = clamp(Fx, -sp.muR * Nr * 1.3, sp.muR * Nr * 1.3);
    const dazed = this.stun > 0 ? 0.2 : 1;   // a rammed vehicle slides like on ice for a moment
    const muF = sp.muF * dazed * (1 - 0.8 * slick), muR = sp.muR * (1 - 0.75 * dI) * dazed * (1 - 0.86 * slick);
    const Fyf = clamp(-7 * Nf * af, -muF * Nf, muF * Nf);
    const rearCap = muR * Nr * Math.sqrt(Math.max(0.15, 1 - (Fx / (sp.muR * Nr * 1.3 + 1e-6)) ** 2));
    const Fyr = clamp(-7 * Nr * ar, -rearCap, rearCap);
    const gF = gT * cps - gB * sps, gL = -gT * sps - gB * cps;
    const ax = Fx - Fyf * Math.sin(this.delta) + gF * (gF > 0 ? 0.95 : 0.55) - 0.0015 * this.vx * Math.abs(this.vx) - wat * 0.9 * this.vx;
    const ay = Fyf * Math.cos(this.delta) + Fyr + (contacts ? gL : gL * 0.3);
    this.ax = ax; this.ay = ay;
    this.vx += (ax + this.vy * this.r) * dt;
    this.vy += (ay - this.vx * this.r) * dt;
    this.r += 0.2 * ((sp.a * Fyf * Math.cos(this.delta) - sp.b * Fyr) / sp.Iz) * dt;
    // stability assist (arcade ESC): yaw rate is pulled toward the road's turn rate plus what the
    // driver asks for, so the tail can slide out (drift) without spinning the vehicle round.
    // In the air the heading straightens so it lands facing down the road.
    // heading target: a small angle for normal steering, swung out to ~35 degrees in a drift
    const psiT = contacts ? -steer * (0.28 + 0.72 * dI) : 0;   // up to ~57 degrees sideways
    // rate 12/s with gain 3 gives a heading response of ~6 rad/s, critically damped
    const rWant = -F.kB * sd - (contacts ? 3 : 4) * (this.psi - psiT);
    this.r += (rWant - this.r) * (1 - Math.exp(-(contacts ? 12 * (1 - 0.3 * dI) : 5) * dt));
    // in a drift the body swings out to the drift angle directly (arcade feel, beats tyre aligning torque)
    if (dI > 0.05) this.psi += (psiT - this.psi) * (1 - Math.exp(-5 * dI * dt));
    const psiMax = 0.75 + 0.45 * dI;
    if (Math.abs(this.psi) > psiMax) { this.psi = Math.sign(this.psi) * psiMax; this.r *= 0.5; }
    if (this.vx < 8 && contacts) this.vx += 10 * dt;
    if (sm.minV && this.vx < sm.minV) this.vx = sm.minV;
    this.vx = clamp(this.vx, -10, 95);
    this.drift = contacts >= 2 && Math.abs(this.vx) > 12 ? Math.max(0, Math.abs(ar) - 0.08) : 0;

    // ---- integrate in track coordinates
    let tv = this.trackVel();
    if (dI > 0.05) {
      // drifting: the vehicle slides sideways but keeps travelling down the road
      // ...and keeps most of its speed through the slide
      const k = 1 - Math.exp(-14 * dI * dt);
      const out = clamp(-tv.sd * tv.sd * F.kB * (0.25 + 0.15 * slick), -8, 8);
      this.setTrackVel(tv.sd + Math.max(0, target * 0.96 - tv.sd) * k, tv.xd + (steer * (7 - 1.5 * slick) + out - tv.xd) * k);
      tv = this.trackVel();
    }
    if (!contacts) {
      // airborne: sideways air drag plus a little air steering, like the ball
      this.setTrackVel(tv.sd, tv.xd * Math.exp(-1.4 * dt) + steer * 10 * dt);
      tv = this.trackVel();
    }
    this.psi += (this.r + F.kB * tv.sd) * dt;
    this.s += tv.sd * dt; this.x += tv.xd * ct * dt;
    if (contacts) this.air = 0;

    // ---- walls (raised berm on the outside of curves)
    const side = Math.sign(sm.berm);
    const wall = side ? ctx.lipX(sm, side) - sp.halfW : 1e9;
    if (Math.abs(sm.berm) > 0.3 && this.x * side > wall) {
      this.x = side * wall;
      const t2 = this.trackVel();
      if (t2.xd * side > 0) { this.setTrackVel(t2.sd * 0.97, -t2.xd * 0.4); this.psi *= 0.6; this.r *= 0.4; this.hitWall = Math.abs(t2.xd); }
    }

    // ---- falling: off the edge, or down into a gap
    const smN = tr.smp[ctx.frameAt(this.s, this.F).i];
    const lip = ctx.lipX(smN, this.x < 0 ? -1 : 1);
    if ((!smN.solid && this.z < -2) || (Math.abs(this.x) > lip + 0.3 && this.z < -0.5) || this.z < -8) {
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
    // stand on the half-pipe surface: tilt the whole vehicle by the wall angle
    const th = this.surfTh || 0, ct = Math.cos(th), st = Math.sin(th);
    const Uv = new V3().copy(F.U).multiplyScalar(ct).addScaledVector(F.B, -st);
    const Bv = new V3().copy(F.B).multiplyScalar(ct).addScaledVector(F.U, st);
    fwd.copy(F.T).multiplyScalar(c).addScaledVector(Bv, -sn);
    left.copy(F.T).multiplyScalar(-sn).addScaledVector(Bv, -c);
    right.copy(left).negate(); back.copy(fwd).negate();
    m.root.position.copy(F.P).addScaledVector(F.B, this.x).addScaledVector(F.U, this.surfH || 0);
    m.root.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, Uv, back));
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
      mw.strut.position.set(-w.ly * 0.7, wy + len / 2, -w.lx);
      mw.strut.scale.y = len;
    });
    // contact shadow under the chassis
    m.blob.position.copy(m.root.position).addScaledVector(Uv, 0.04);
    m.blob.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, fwd, Uv));
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

// ----------------------------------------------------------------------------
// Toy-style models: rounded glossy plastic bodies, chunky rubber tyres with tread lugs,
// bubble canopies, racing stripes and number roundels. Bodies are modelled at twice the
// physical size and scaled by 0.5; wheels are built at physical size.
// Model axes: x right, y up, -z forward.
// ----------------------------------------------------------------------------
const geoCache = new Map();
function cached(key, make) { if (!geoCache.has(key)) geoCache.set(key, make()); return geoCache.get(key); }

function tyreGeometry(R, w, lugs, lugScale = 1) {
  const hw = w / 2, c = Math.min(w * 0.34, R * 0.32), r0 = R * 0.5, pts = [];
  pts.push(new THREE.Vector2(r0, -hw), new THREE.Vector2(R - c, -hw));
  for (let k = 1; k <= 5; k++) { const a = (k / 6) * Math.PI / 2; pts.push(new THREE.Vector2(R - c + Math.sin(a) * c, -hw + c - Math.cos(a) * c)); }
  pts.push(new THREE.Vector2(R, -hw + c), new THREE.Vector2(R, hw - c));
  for (let k = 1; k <= 5; k++) { const a = (k / 6) * Math.PI / 2; pts.push(new THREE.Vector2(R - c + Math.cos(a) * c, hw - c + Math.sin(a) * c)); }
  pts.push(new THREE.Vector2(R - c, hw), new THREE.Vector2(r0, hw));
  const parts = [new THREE.LatheGeometry(pts, 28)];
  // staggered tread lugs
  const m = new THREE.Matrix4(), lugH = R * 0.11 * lugScale;
  for (let i = 0; i < lugs; i++) {
    const a = (i / lugs) * Math.PI * 2, half = i % 2 ? 1 : -1;
    const lug = new THREE.BoxGeometry(lugH * 2, w * 0.56, (2 * Math.PI * R / lugs) * 0.5);
    lug.translate(R - lugH * 0.25, half * w * 0.2, 0);
    lug.applyMatrix4(m.makeRotationY(a));
    parts.push(lug);
  }
  const geo = mergeGeometries(parts);
  geo.rotateZ(Math.PI / 2);   // axle along x
  return geo;
}
function rimGeometry(R, w) {
  const g = new THREE.CylinderGeometry(R * 0.56, R * 0.56, w * 0.9, 22);
  g.rotateZ(Math.PI / 2); return g;
}
function rimHolesGeometry(R, w) {
  const parts = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const h = new THREE.CylinderGeometry(R * 0.13, R * 0.13, w * 0.94, 10);
    h.translate(Math.cos(a) * R * 0.33, 0, Math.sin(a) * R * 0.33);
    parts.push(h);
  }
  const g = mergeGeometries(parts); g.rotateZ(Math.PI / 2); return g;
}
function capGeometry(R, w) {
  const parts = [-1, 1].map(sd => { const s = new THREE.SphereGeometry(R * 0.17, 12, 8); s.scale(0.6, 1, 1); s.translate(sd * w * 0.45, 0, 0); return s; });
  return mergeGeometries(parts);
}
function numberTexture(n) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d');
  x.fillStyle = '#ffffff'; x.beginPath(); x.arc(64, 64, 60, 0, Math.PI * 2); x.fill();
  x.strokeStyle = '#20202c'; x.lineWidth = 7; x.stroke();
  x.fillStyle = '#20202c'; x.font = '900 84px system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(String(n), 64, 70);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}

function buildVehicleMesh(sp, opts, blobTex) {
  const root = new THREE.Group(), body = new THREE.Group();
  root.add(body);
  const plastic = (color, extra = {}) => new THREE.MeshPhysicalMaterial({ color, roughness: 0.3, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.1, envMapIntensity: 1.1, ...extra });
  const paint = plastic(opts.color);
  const white = plastic('#f6f4ee');
  const dark = plastic('#23232e', { clearcoat: 0.4 });
  const chrome = new THREE.MeshStandardMaterial({ color: '#e6ecf5', metalness: 1, roughness: 0.14 });
  const glass = new THREE.MeshPhysicalMaterial({ color: '#16284d', roughness: 0.05, metalness: 0.3, clearcoat: 1, envMapIntensity: 1.6 });
  const lamp = new THREE.MeshStandardMaterial({ color: '#fff3c4', emissive: '#ffcf5a', emissiveIntensity: 0.7, roughness: 0.2 });
  const tail = new THREE.MeshStandardMaterial({ color: '#ff3040', emissive: '#ff1c2c', emissiveIntensity: 1.4 });
  const rubber = new THREE.MeshStandardMaterial({ color: '#1a1a20', roughness: 0.82, metalness: 0, side: THREE.DoubleSide });

  const add = (geo, mat, x, y, z, shadow = false) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = shadow; body.add(m); return m; };
  const rbox = (w, h, d, r, mat, x, y, z, shadow = false) => add(new RoundedBoxGeometry(w, h, d, 4, r), mat, x, y, z, shadow);
  const ball = (r, mat, x, y, z, sx = 1, sy = 1, sz = 1) => { const m = add(new THREE.SphereGeometry(r, 16, 12), mat, x, y, z); m.scale.set(sx, sy, sz); return m; };
  const roundelMat = new THREE.MeshStandardMaterial({ map: numberTexture(opts.number || 1), roughness: 0.4 });
  const roundel = (r, x, y, z) => { for (const sd of [-1, 1]) { const m = add(new THREE.CircleGeometry(r, 24), roundelMat, sd * x, y, z); m.rotation.y = sd * Math.PI / 2; } };

  if (sp.kind === 'monster') {
    rbox(1.5, 0.34, 3.7, 0.14, dark, 0, 0, 0);                         // chassis rail
    rbox(2.3, 0.85, 4.3, 0.24, paint, 0, 0.72, 0, true);               // tub
    rbox(2.06, 0.95, 1.9, 0.38, paint, 0, 1.52, 0.2, true);            // cab
    rbox(2.12, 0.46, 1.2, 0.16, glass, 0, 1.63, 0.2);                  // side windows
    rbox(1.66, 0.46, 1.96, 0.16, glass, 0, 1.63, 0.2);                 // windscreen and rear window
    rbox(0.56, 0.05, 4.34, 0.02, white, 0, 1.14, 0);                   // stripe over bonnet and bed
    rbox(0.56, 0.05, 1.46, 0.02, white, 0, 1.985, 0.2);                // roof stripe
    for (const z of [-2.28, 2.28]) { const b = add(new THREE.CapsuleGeometry(0.17, 2.1, 6, 14), chrome, 0, 0.42, z); b.rotation.z = Math.PI / 2; }
    for (const sx of [-0.78, 0.78]) { ball(0.2, lamp, sx, 0.82, -2.13, 1, 1, 0.5); ball(0.17, tail, sx, 0.82, 2.13, 1, 1, 0.5); }
    const bar = add(new THREE.CapsuleGeometry(0.07, 1.5, 4, 10), dark, 0, 2.1, -0.38); bar.rotation.z = Math.PI / 2;
    for (const sx of [-0.6, -0.2, 0.2, 0.6]) ball(0.13, lamp, sx, 2.13, -0.44);
    for (const sx of [-1.0, 1.0]) add(new THREE.CylinderGeometry(0.1, 0.1, 1.25, 12), chrome, sx, 1.75, 1.32);
    add(new THREE.TorusGeometry(0.85, 0.08, 8, 20, Math.PI), chrome, 0, 1.14, 1.62);   // roll bar
    roundel(0.3, 1.163, 0.72, 0.2);
  } else {
    rbox(2.0, 0.55, 4.4, 0.21, paint, 0, -0.08, 0, true);              // lower body
    rbox(1.8, 0.36, 2.9, 0.17, paint, 0, 0.2, 0.25, true);             // shoulder
    const canopy = ball(1, new THREE.MeshPhysicalMaterial({ color: '#7fd4ff', roughness: 0.04, metalness: 0.1, clearcoat: 1, transparent: true, opacity: 0.5, envMapIntensity: 1.8 }), 0, 0.36, 0.2, 0.76, 0.5, 1.12);
    canopy.renderOrder = 3;
    ball(0.21, white, 0, 0.47, 0.05);                                  // the driver's helmet
    rbox(0.22, 0.07, 0.03, 0.012, dark, 0, 0.49, -0.14);               // visor
    rbox(0.5, 0.04, 4.42, 0.02, white, 0, 0.2, 0);                     // stripe, nose to tail
    rbox(0.5, 0.04, 2.92, 0.02, white, 0, 0.385, 0.25);
    for (const sx of [-0.7, 0.7]) rbox(0.1, 0.34, 0.1, 0.04, dark, sx, 0.36, 1.95);
    rbox(2.0, 0.09, 0.5, 0.045, paint, 0, 0.56, 2.0, true);            // rear wing
    for (const sx of [-0.66, 0.66]) ball(0.17, lamp, sx, -0.02, -2.16, 1, 1, 0.5);
    rbox(1.5, 0.12, 0.06, 0.03, tail, 0, 0.0, 2.2);
    rbox(2.04, 0.07, 0.34, 0.035, dark, 0, -0.34, -2.1);               // front splitter
    for (const sx of [-0.98, 0.98]) for (const z of [-2 * sp.a, 2 * sp.b]) {
      const f = add(new THREE.TorusGeometry(0.57, 0.13, 8, 16, Math.PI), paint, sx, -0.24, z); f.rotation.y = Math.PI / 2;   // wheel arches
    }
    roundel(0.2, 1.012, -0.06, 0.3);
  }
  body.scale.setScalar(0.5);

  // ---- wheels (physical size)
  const key = sp.kind;
  const tyreGeo = cached('tyre' + key, () => tyreGeometry(sp.Rw, sp.ww, sp.kind === 'monster' ? 16 : 26, sp.kind === 'monster' ? 1 : 0.35));
  const rimGeo = cached('rim' + key, () => rimGeometry(sp.Rw, sp.ww));
  const holeGeo = cached('hole' + key, () => rimHolesGeometry(sp.Rw, sp.ww));
  const capGeo = cached('cap' + key, () => capGeometry(sp.Rw, sp.ww));
  const rimMat = plastic(sp.kind === 'monster' ? '#ffd23f' : '#f6f4ee');
  const strutR = sp.kind === 'monster' ? 0.05 : 0.025;
  const strutGeo = cached('strut' + key, () => new THREE.CylinderGeometry(strutR, strutR, 1, 8));
  const wheels = [];
  for (let i = 0; i < 4; i++) {
    const group = new THREE.Group(), spin = new THREE.Group();
    const tyre = new THREE.Mesh(tyreGeo, rubber); tyre.castShadow = true;
    spin.add(tyre, new THREE.Mesh(rimGeo, rimMat), new THREE.Mesh(holeGeo, dark), new THREE.Mesh(capGeo, chrome));
    group.add(spin);
    root.add(group);
    const strut = new THREE.Mesh(strutGeo, chrome);
    root.add(strut);
    wheels.push({ group, spin, strut });
  }
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(sp.halfW * 2.6, sp.halfL * 2.4),
    new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, toneMapped: false }));
  blob.renderOrder = 2;
  return { root, body, wheels, blob };
}
