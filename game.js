import * as THREE from 'three';

// ============================================================================
// Tilt Roller: a ball rolls along a procedurally generated 3D track.
// The track is a centreline sampled every DS units, each sample carrying a
// frame (T forward, U up, B right). While grounded the ball lives in track
// coordinates (s along, x lateral); in the air it is a free body in world space.
// ============================================================================

const V3 = THREE.Vector3;
const DS = 0.5;          // track sample spacing (world units)
const G = 30;            // gravity
const BALL_R = 0.6;
const HW = 4;            // half width of the road
const DEG = Math.PI / 180;
const JUMP_V = 17;
const BOUNCE_E = 0.42, BOUNCE_MIN = 9;
const TIME_SCALE = 1.45; // game time runs faster than real time: snappier rolling, falling and jumping
const STEER_ACC = 26;
const K = { NORMAL: 0, BOOST: 1, KICK: 2, LOOP: 3, HELIX: 4, FINISH: 5, START: 6, RING: 7 };

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = t => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const params = new URLSearchParams(location.search);

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// heading h (0 = -Z, positive = turning left), pitch p (positive = up)
function dirFrom(h, p, o) { return o.set(-Math.sin(h) * Math.cos(p), Math.sin(p), -Math.cos(h) * Math.cos(p)); }
function upFrom(h, p, o) { return o.set(Math.sin(h) * Math.sin(p), Math.cos(p), Math.cos(h) * Math.sin(p)); }

// ============================================================================
// Track generation
// ============================================================================
function generateTrack(seed, level) {
  const rnd = mulberry32(seed);
  const R = (a, b) => a + (b - a) * rnd();
  const pick = a => a[Math.floor(rnd() * a.length)];
  const vt = Math.min(38 + level * 2, 56);
  const smp = [], features = [], checkpoints = [];
  const pos = new V3(); let h = 0, p = 0;
  const dir = new V3();
  const len = () => (smp.length - 1) * DS;
  const add = o => smp.push({
    pos: pos.clone(), h, p, bank: o.bank || 0, solid: o.solid !== false, berm: o.berm || 0,
    minV: o.minV || 0, boost: o.boost || 0, noDetach: !!o.noDetach, kind: o.kind || 0,
  });
  add({ kind: K.START });

  function run(L, fn) {
    const n = Math.max(1, Math.round(L / DS));
    for (let k = 1; k <= n; k++) {
      const o = fn(k / n) || {};
      if (o.h !== undefined) h = o.h;
      if (o.p !== undefined) p = o.p;
      dirFrom(h, p, dir); pos.addScaledVector(dir, DS);
      if (o.off) pos.add(o.off);
      add(o);
    }
  }
  const cp = () => checkpoints.push(smp.length - 1);
  const straight = (L, o = {}) => run(L, () => o);

  // banked curve ("berm"): yaw rate follows 6t(1-t); bank & outer wall follow it
  function curve(ang, rad, pA = 0) {
    const h0 = h, p0 = p, L = Math.abs(ang) * rad;
    const b0 = Math.sign(ang) * Math.min(35 * DEG, Math.atan(vt * vt * 1.5 / (rad * G)) * 0.8);
    run(L, t => {
      const e = 4 * t * (1 - t);
      return { h: h0 + ang * smooth(t), p: p0 + pA * Math.sin(2 * Math.PI * t), bank: b0 * e, berm: Math.sign(ang) * Math.min(1, e * 3) };
    });
    p = p0;
  }
  const chooseDir = () => (h > 25 * DEG ? -1 : h < -25 * DEG ? 1 : rnd() < 0.5 ? -1 : 1);
  function turn() {
    const d = chooseDir();
    let a = R(35, 75) * DEG;
    a = Math.max(15 * DEG, Math.min(a, 65 * DEG - d * h));
    curve(d * a, R(75, 115));
  }
  function scurve() {
    if (Math.abs(h) > 20 * DEG) return turn();
    const d = chooseDir(), a = R(30, 50) * DEG, r = R(70, 95);
    curve(d * a, r); curve(-d * a, r);
  }
  function hill(A, L) { const p0 = p; run(L, t => ({ p: p0 + A * Math.sin(2 * Math.PI * t) })); p = p0; }
  function downhill(A, L) { const p0 = p; run(L, t => ({ p: p0 - A * Math.sin(Math.PI * t) })); p = p0; }
  function bumps() { const n = 2 + Math.floor(rnd() * 3), A = R(8, 13) * DEG, L = R(26, 34); for (let i = 0; i < n; i++) hill(A, L); }
  // roller-coaster waves of varying size
  function rollers() { const n = 3 + Math.floor(rnd() * 3); for (let i = 0; i < n; i++) hill(R(10, 20) * DEG, R(34, 55)); }
  // steep drop: the convex lip throws the ball into the air at speed
  function bigDrop() {
    const A = R(22, 34) * DEG, p0 = p;
    run(R(18, 26), t => ({ p: p0 - A * smooth(t) }));
    straight(R(15, 35));
    run(R(24, 32), t => ({ p: p0 - A + A * smooth(t) }));
    p = p0;
  }
  function climb() {
    const A = R(10, 16) * DEG, p0 = p;
    run(R(20, 28), t => ({ p: p0 + A * smooth(t) }));
    straight(R(25, 50));
    run(R(20, 28), t => ({ p: p0 + A - A * smooth(t) }));
    p = p0;
  }
  // banked turn that also goes over a crest or through a dip
  function twistHill() {
    const d = chooseDir();
    let a = R(40, 80) * DEG;
    a = Math.max(15 * DEG, Math.min(a, 65 * DEG - d * h));
    curve(d * a, R(80, 115), R(8, 14) * DEG * (rnd() < 0.5 ? 1 : -1));
  }
  // off-camber straight: the road leans sideways with no wall, the player must tilt against it
  function camber() {
    const d = rnd() < 0.5 ? -1 : 1, b0 = d * (R(9, 14) + Math.min(level, 6)) * DEG;
    const twist = rnd() < 0.4;
    run(R(60, 95), t => ({ bank: twist ? b0 * Math.sin(2 * Math.PI * t) : b0 * Math.sin(Math.PI * t) }));
  }
  function booster(L, bv, mv) { run(L, t => ({ kind: K.BOOST, boost: bv, minV: t > 0.75 ? mv : 0 })); }

  function jump(mini = false) {
    const th = (mini ? 13 : 16 + Math.min(level, 5)) * DEG;
    const vexp = vt + 2;
    const Lg = mini ? R(8, 14) : clamp(0.55 * vexp * vexp * Math.sin(2 * th) / G, 16, 42);
    const vreq = Math.sqrt(Lg * G / Math.sin(2 * th));
    const bv = Math.max(vreq + 5, vt + 3);
    cp();
    if (!mini) booster(26, bv, vreq + 1.5);
    const p0 = p;
    run(mini ? 10 : 14, t => ({ p: p0 + th * smooth(t), kind: K.KICK, minV: vreq + 1.5 }));
    const s0 = len();
    run(Lg, t => ({ p: p0 + th - 2 * th * t, solid: false }));
    const s1 = len();
    features.push({ type: 'gap', s0, s1 });
    if (!mini && rnd() < 0.6) {
      // bonus ring over the gap, at the height the ball should pass at launch speed
      const vL = bv - 2, x = Lg / 2;
      const yBall = x * Math.tan(th) - G * x * x / (2 * vL * vL * Math.cos(th) ** 2) + BALL_R;
      const Rarc = Lg / (2 * th), yPath = Rarc * (1 - Math.cos(th));
      features.push({ type: 'ring', s: (s0 + s1) / 2, hgt: yBall - yPath + 0.4, r: 2.7, fire: false });
    }
    run(mini ? 24 : 34, t => ({ p: p0 - th + th * smooth(t) }));
    p = p0; cp();
  }

  function ringFire() {
    cp(); straight(12);
    const s = len() + 26;
    const xo = (rnd() * 2 - 1) * Math.min(2.2, 1.2 + level * 0.3);
    features.push({ type: 'ring', s, hgt: 4.2, r: 2.7, fire: true, xo });
    features.push({ type: 'jumpzone', s0: s - 17, s1: s - 8 });
    straight(46, { kind: K.RING });
  }

  // pit: a hole in flat road with no ramp, must be jumped (tap or jiggle the phone)
  function pit() {
    cp(); straight(45);
    const s0 = len() + 30, Lg = R(8, 11) + Math.min(level, 6) * 0.6;
    features.push({ type: 'pitzone', s0: s0 - 28, s1: s0 - 3 });
    straight(30);
    run(Lg, () => ({ solid: false }));
    features.push({ type: 'pit', s0, s1: len() });
    straight(30); cp();
  }

  function vloop() {
    cp(); booster(30, Math.max(36, vt + 4), 28); straight(4);
    const Rl = R(13, 16), L = 2 * Math.PI * Rl, p0 = p, side = rnd() < 0.5 ? -1 : 1;
    const Bv = new V3(Math.cos(h), 0, -Math.sin(h));
    const D = side * (2 * HW + 3.5);
    const s0 = len(); let prev = 0;
    run(L, t => {
      const sm = smooth(t); const off = Bv.clone().multiplyScalar(D * (sm - prev)); prev = sm;
      return { p: p0 + 2 * Math.PI * t, off, noDetach: true, minV: 24, kind: K.LOOP };
    });
    p = p0;
    features.push({ type: 'loop', s0, s1: len(), name: 'LOOP!' });
    straight(30); cp();
  }

  // horizontal 360: a descending banked spiral that passes under its own entry
  function helix() {
    cp(); booster(24, vt + 4, vt - 2);
    const Rh = R(36, 42), d = h > 15 * DEG ? -1 : h < -15 * DEG ? 1 : rnd() < 0.5 ? -1 : 1;
    const L = 2 * Math.PI * Rh, h0 = h, rise = -11;
    const b0 = d * Math.min(36 * DEG, Math.atan(vt * vt / (Rh * G)));
    const s0 = len(); let prev = 0;
    run(L, t => {
      const sm = smooth(t); const off = new V3(0, rise * (sm - prev), 0); prev = sm;
      const e = smooth(Math.min(1, t / 0.08, (1 - t) / 0.08));
      return { h: h0 + d * 2 * Math.PI * t, off, bank: b0 * e, berm: d, minV: 20, kind: K.HELIX };
    });
    h = h0;
    features.push({ type: 'loop', s0, s1: len(), name: 'SPIRAL!' });
    straight(45); cp();
  }

  straight(30, { kind: K.START }); cp();
  const kicker = () => { straight(35); jump(true); };
  const conns = [turn, scurve, bumps, camber, rollers, rollers, bigDrop, bigDrop, kicker, kicker, kicker, climb, twistHill, twistHill, () => downhill(R(10, 18) * DEG, R(50, 80))];
  const specials = ['vloop', 'helix', 'ring', 'ring', 'jump', 'jump', 'jump', 'pit', 'pit'];
  for (let i = 0; i < Math.min(level - 1, 8); i++) specials.push(pick(['ring', 'jump', 'vloop', 'helix', 'ring', 'jump', 'pit', 'pit']));
  for (let i = specials.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [specials[i], specials[j]] = [specials[j], specials[i]]; }
  const fns = { vloop, helix, ring: ringFire, jump: () => jump(false), pit };
  for (const sp of specials) {
    const nc = 2 + (rnd() < 0.5 ? 1 : 0);
    for (let c = 0; c < nc; c++) { cp(); pick(conns)(); }
    straight(40); // settle on the ground before the next special
    fns[sp]();
  }
  cp(); turn(); cp();
  straight(40, { kind: K.FINISH });
  const finishS = len();
  features.push({ type: 'finish', s: finishS });
  straight(110, { kind: K.FINISH });

  // ---- frames
  const N = smp.length;
  const P = smp.map(s => s.pos);
  const T = [], U = [], B = [];
  const kN = new Float32Array(N), kB = new Float32Array(N);
  const u = new V3(), b = new V3();
  for (let i = 0; i < N; i++) T.push(new V3().subVectors(P[Math.min(i + 1, N - 1)], P[Math.max(i - 1, 0)]).normalize());
  for (let i = 0; i < N; i++) {
    const sm = smp[i];
    upFrom(sm.h, sm.p, u);
    u.addScaledVector(T[i], -u.dot(T[i])).normalize();
    b.crossVectors(T[i], u).normalize();
    const c = Math.cos(sm.bank), s = Math.sin(sm.bank);
    B.push(new V3().copy(b).multiplyScalar(c).addScaledVector(u, s));
    U.push(new V3().copy(u).multiplyScalar(c).addScaledVector(b, -s));
  }
  const dT = new V3();
  for (let i = 1; i < N - 1; i++) {
    const ds = P[i + 1].distanceTo(P[i - 1]) || DS * 2;
    dT.subVectors(T[i + 1], T[i - 1]).divideScalar(ds);
    kN[i] = dT.dot(U[i]); kB[i] = dT.dot(B[i]);
  }
  let minY = Infinity; for (const q of P) minY = Math.min(minY, q.y);
  features.sort((a, b2) => (a.s ?? a.s0) - (b2.s ?? b2.s0));
  return { seed, level, smp, P, T, U, B, kN, kB, N, len: (N - 1) * DS, features, checkpoints, finishS, vt, minY,
    rings: features.filter(f => f.type === 'ring') };
}

let track = null;
const mkF = () => ({ P: new V3(), T: new V3(), U: new V3(), B: new V3(), kN: 0, kB: 0, i: 0 });
function frameAtT(tr, s, o) {
  let f = s / DS; const max = tr.N - 1;
  if (f < 0) f = 0; if (f > max - 1e-6) f = max - 1e-6;
  const i = Math.floor(f), t = f - i;
  o.P.lerpVectors(tr.P[i], tr.P[i + 1], t);
  o.T.lerpVectors(tr.T[i], tr.T[i + 1], t).normalize();
  o.U.lerpVectors(tr.U[i], tr.U[i + 1], t).normalize();
  o.B.lerpVectors(tr.B[i], tr.B[i + 1], t).normalize();
  o.kN = lerp(tr.kN[i], tr.kN[i + 1], t); o.kB = lerp(tr.kB[i], tr.kB[i + 1], t);
  o.i = t < 0.5 ? i : i + 1;
  return o;
}
const frameAt = (s, o) => frameAtT(track, s, o);
const F1 = mkF(), F2 = mkF(), F3 = mkF(), F4 = mkF();

// ============================================================================
// Renderer, scene, lights, sky, reflections
// ============================================================================
const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
const DPR = window.devicePixelRatio || 1;
renderer.setSize(innerWidth, innerHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
const HORIZON = new THREE.Color('#ffa77a');
const FOG_COLOR = new THREE.Color('#d8cbe6');
scene.fog = new THREE.Fog(HORIZON.clone(), 160, 700);
const camera = new THREE.PerspectiveCamera(66, innerWidth / innerHeight, 0.1, 3000);
const SUN_DIR = new V3(0.22, 0.92, 0.32).normalize();

const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false,
  uniforms: {
    top: { value: new THREE.Color('#1d1050') }, mid: { value: new THREE.Color('#7b3fa0') },
    hor: { value: HORIZON.clone() }, bot: { value: new THREE.Color('#3a2560') },
    sun: { value: SUN_DIR }, fogCol: { value: FOG_COLOR.clone() }, fogAmt: { value: 0 },
  },
  vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `uniform vec3 top, mid, hor, bot, sun, fogCol; uniform float fogAmt; varying vec3 vP;
    void main(){
      vec3 d = normalize(vP); float h = d.y; vec3 c;
      if (h > 0.0) { c = mix(hor, mid, smoothstep(0.0, 0.25, h)); c = mix(c, top, smoothstep(0.25, 0.9, h)); }
      else c = mix(hor, bot, smoothstep(0.0, 0.3, -h));
      float s = max(dot(d, normalize(sun)), 0.0);
      c += vec3(1.0, 0.8, 0.5) * (pow(s, 600.0) * 3.0 + pow(s, 12.0) * 0.3);
      c = mix(c, fogCol, fogAmt);
      gl_FragColor = vec4(c, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(1800, 32, 16), skyMat);
sky.renderOrder = -1; sky.frustumCulled = false;
scene.add(sky);

// static environment (sky) for glossy reflections on the track
const pmrem = new THREE.PMREMGenerator(renderer);
{
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), skyMat));
  scene.environment = pmrem.fromScene(envScene, 0.02, 0.1, 500).texture;
}

const hemi = new THREE.HemisphereLight('#cfd8ff', '#6a3d6e', 0.7);
scene.add(hemi);
const sun = new THREE.DirectionalLight('#fff0d8', 2.6);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -20, right: 20, top: 20, bottom: -20, near: 1, far: 220 });
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);

// dynamic reflections on the ball: a cube camera that follows it
const cubeRT = new THREE.WebGLCubeRenderTarget(128, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter });
const cubeCam = new THREE.CubeCamera(0.3, 1500, cubeRT);
scene.add(cubeCam);

function ballTexture() {
  const c = document.createElement('canvas'); c.width = 512; c.height = 256;
  const x = c.getContext('2d');
  x.fillStyle = '#ffffff'; x.fillRect(0, 0, 512, 256);
  x.fillStyle = '#2a3550';
  x.fillRect(0, 125, 512, 6);                       // equator
  x.fillRect(0, 0, 6, 256); x.fillRect(253, 0, 6, 256); // meridians
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
const ballMat = new THREE.MeshStandardMaterial({ map: ballTexture(), color: '#e9eef8', roughness: 0.04, metalness: 1.0, envMap: cubeRT.texture, envMapIntensity: 1.35 });
const ballMesh = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 40, 24), ballMat);
ballMesh.castShadow = true;
scene.add(ballMesh);

// contact shadow: a soft dark blob projected straight down onto the road under the ball
const blobTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d'), gr = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(0.5, 'rgba(0,0,0,0.7)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = gr; x.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
})();
const blob = new THREE.Mesh(new THREE.PlaneGeometry(BALL_R * 3.2, BALL_R * 3.2),
  new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, toneMapped: false }));
blob.renderOrder = 2;
scene.add(blob);

// ============================================================================
// Particles (additive fire/sparks, and confetti)
// ============================================================================
const P_VS = `attribute float size; attribute vec4 rgba; varying vec4 vC; uniform float uScale;
  void main(){ vC = rgba; vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * uScale / max(0.1, -mv.z); gl_Position = projectionMatrix * mv; }`;
const P_FS_SOFT = `varying vec4 vC; void main(){ float r = length(gl_PointCoord - 0.5); if (r > 0.5) discard;
  float a = 1.0 - smoothstep(0.0, 0.5, r); gl_FragColor = vec4(vC.rgb, vC.a * a); }`;
const P_FS_HARD = `varying vec4 vC; void main(){ gl_FragColor = vC; }`;

class Particles {
  constructor(max, additive, soft) {
    this.max = max; this.n = 0;
    this.pos = new Float32Array(max * 3); this.col = new Float32Array(max * 4); this.size = new Float32Array(max);
    this.vel = new Float32Array(max * 3); this.life = new Float32Array(max); this.ml = new Float32Array(max);
    this.c0 = new Float32Array(max * 4); this.c1 = new Float32Array(max * 4);
    this.s0 = new Float32Array(max); this.s1 = new Float32Array(max); this.grav = new Float32Array(max); this.drag = new Float32Array(max);
    const geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.aPos); geo.setAttribute('rgba', this.aCol); geo.setAttribute('size', this.aSize);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 300 } }, vertexShader: P_VS, fragmentShader: soft ? P_FS_SOFT : P_FS_HARD,
      transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(geo, this.mat); this.points.frustumCulled = false;
    this.arrays = [[this.pos, 3], [this.col, 4], [this.size, 1], [this.vel, 3], [this.life, 1], [this.ml, 1], [this.c0, 4], [this.c1, 4], [this.s0, 1], [this.s1, 1], [this.grav, 1], [this.drag, 1]];
  }
  spawn(p, v, life, c0, c1, s0, s1, grav = 0, drag = 0) {
    if (this.n >= this.max) return;
    const i = this.n++;
    this.pos.set([p.x, p.y, p.z], i * 3); this.vel.set([v.x, v.y, v.z], i * 3);
    this.life[i] = life; this.ml[i] = life; this.c0.set(c0, i * 4); this.c1.set(c1, i * 4);
    this.s0[i] = s0; this.s1[i] = s1; this.grav[i] = grav; this.drag[i] = drag;
  }
  clear() { this.n = 0; }
  update(dt) {
    let i = 0;
    while (i < this.n) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        const j = --this.n;
        if (i !== j) for (const [a, k] of this.arrays) a.copyWithin(i * k, j * k, j * k + k);
        continue;
      }
      const t = 1 - this.life[i] / this.ml[i], d = Math.exp(-this.drag[i] * dt);
      this.vel[i * 3] *= d; this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * d - this.grav[i] * dt; this.vel[i * 3 + 2] *= d;
      for (let k = 0; k < 3; k++) this.pos[i * 3 + k] += this.vel[i * 3 + k] * dt;
      for (let k = 0; k < 4; k++) this.col[i * 4 + k] = lerp(this.c0[i * 4 + k], this.c1[i * 4 + k], t);
      this.size[i] = lerp(this.s0[i], this.s1[i], t);
      i++;
    }
    this.aPos.needsUpdate = this.aCol.needsUpdate = this.aSize.needsUpdate = true;
    this.points.geometry.setDrawRange(0, this.n);
  }
}
const fx = new Particles(2500, true, true);
const confetti = new Particles(900, false, false);
scene.add(fx.points, confetti.points);

// ============================================================================
// World building (meshes for the current track)
// ============================================================================
const COL = {
  road: new THREE.Color('#3346a8'), boost: new THREE.Color('#14a7bd'), kick: new THREE.Color('#e07a2e'),
  loop: new THREE.Color('#8a3fd1'), finish: new THREE.Color('#2a9d5c'), red: new THREE.Color('#ff3355'),
  white: new THREE.Color('#f2f2f2'), side: new THREE.Color('#2a1f5c'), bottom: new THREE.Color('#1a1238'),
};
const tmpC = new THREE.Color();
function roadColor(sm, i) {
  const base = sm.kind === K.BOOST ? COL.boost : sm.kind === K.KICK ? COL.kick
    : (sm.kind === K.LOOP || sm.kind === K.HELIX) ? COL.loop : sm.kind === K.FINISH ? COL.finish : COL.road;
  return tmpC.copy(base).multiplyScalar(Math.floor(i * DS / 3) % 2 ? 0.86 : 1);
}
function profile(sm) {
  const bR = sm.berm > 0 ? sm.berm : 0, bL = sm.berm < 0 ? -sm.berm : 0;
  const lipL = 0.3 + bL * 1.7, lipR = 0.3 + bR * 1.7, wL = HW + 0.8 + bL * 0.6, wR = HW + 0.8 + bR * 0.6;
  return [[-wL, lipL], [-HW, 0], [0, 0], [HW, 0], [wR, lipR], [wR, -0.8], [-wL, -0.8]];
}

function buildTrackMesh(tr) {
  const rows = []; for (let i = 0; i < tr.N; i += 2) rows.push(i);
  if (rows[rows.length - 1] !== tr.N - 1) rows.push(tr.N - 1);
  const prof = rows.map(i => profile(tr.smp[i]));
  const segSolid = [];
  for (let r = 0; r < rows.length - 1; r++) {
    let ok = true; for (let k = rows[r]; k <= rows[r + 1]; k++) if (!tr.smp[k].solid) { ok = false; break; }
    segSolid.push(ok);
  }
  const pos = [], col = [];
  const vtx = (i, xy, c) => {
    const P = tr.P[i], B = tr.B[i], U = tr.U[i];
    pos.push(P.x + B.x * xy[0] + U.x * xy[1], P.y + B.y * xy[0] + U.y * xy[1], P.z + B.z * xy[0] + U.z * xy[1]);
    col.push(c.r, c.g, c.b);
  };
  const cap = (i, pr) => { for (let k = 1; k < 6; k++) { vtx(i, pr[0], COL.side); vtx(i, pr[k], COL.side); vtx(i, pr[k + 1], COL.side); } };
  for (let r = 0; r < rows.length - 1; r++) {
    if (!segSolid[r]) continue;
    const i0 = rows[r], i1 = rows[r + 1], sm = tr.smp[i0], p0 = prof[r], p1 = prof[r + 1];
    for (let j = 0; j < 7; j++) {
      let c;
      if (j === 1 || j === 2) c = roadColor(sm, i0);
      else if (j === 0 || j === 3) c = Math.floor(i0 * DS / 1.5) % 2 ? COL.red : COL.white;
      else if (j === 5) c = COL.bottom; else c = COL.side;
      const a0 = p0[j], b0 = p0[(j + 1) % 7], a1 = p1[j], b1 = p1[(j + 1) % 7];
      const cc = c.clone();
      vtx(i0, a0, cc); vtx(i1, a1, cc); vtx(i0, b0, cc);
      vtx(i0, b0, cc); vtx(i1, a1, cc); vtx(i1, b1, cc);
    }
    if (r === 0 || !segSolid[r - 1]) cap(i0, p0);
    if (r === rows.length - 2 || !segSolid[r + 1]) cap(i1, p1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.25, envMapIntensity: 0.9, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true; mesh.receiveShadow = true;
  return mesh;
}

function canvasTex(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
function checker(x, w, h, n, m) {
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) { x.fillStyle = (i + j) % 2 ? '#111' : '#fff'; x.fillRect(i * w / n, j * h / m, w / n + 1, h / m + 1); }
}
const basis = (x, y, z) => new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));

let flagGeos = [];
let chevMats = [];
function buildWorld(tr) {
  const g = new THREE.Group();
  g.add(buildTrackMesh(tr));
  const F = mkF();

  // ---- chevrons: boost pads (cyan) and "jump here" zones (yellow)
  const shape = new THREE.Shape();
  shape.moveTo(-1.2, -0.5); shape.lineTo(0, 0.7); shape.lineTo(1.2, -0.5); shape.lineTo(1.2, -1.1); shape.lineTo(0, 0.1); shape.lineTo(-1.2, -1.1); shape.closePath();
  const chevGeo = new THREE.ShapeGeometry(shape);
  const mkChev = (color, list) => {
    const mat = new THREE.MeshBasicMaterial({ color, toneMapped: false, transparent: true, opacity: 0.95, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide });
    const im = new THREE.InstancedMesh(chevGeo, mat, Math.max(1, list.length));
    const m = new THREE.Matrix4(), sc = new V3(1.5, 1.5, 1.5);
    list.forEach((s, k) => {
      frameAtT(tr, s, F);
      m.compose(F.P.clone().addScaledVector(F.U, 0.04), basis(F.B, F.T, F.U), sc);
      im.setMatrixAt(k, m);
    });
    im.count = list.length; chevMats.push(mat); g.add(im);
  };
  chevMats = [];
  const boostS = [], jzS = [], pitS = [];
  for (const f of tr.features) if (f.type === 'pitzone') for (let s = f.s0; s <= f.s1; s += 2.5) pitS.push(s);
  for (let i = 0; i < tr.N; i += 8) if (tr.smp[i].kind === K.BOOST) boostS.push(i * DS);
  for (const f of tr.features) if (f.type === 'jumpzone') for (let s = f.s0; s <= f.s1; s += 2.5) jzS.push(s);
  mkChev('#39f3ff', boostS); mkChev('#ffe04a', jzS); mkChev('#ff2a4a', pitS);

  // ---- rings
  for (const f of tr.rings) {
    frameAtT(tr, f.s, F);
    f.P = F.P.clone(); f.T = F.T.clone(); f.U = F.U.clone(); f.B = F.B.clone();
    f.xo = f.xo || 0;
    f.C = F.P.clone().addScaledVector(F.U, f.hgt).addScaledVector(F.B, f.xo);
    const q = basis(f.B, f.U, new V3().crossVectors(f.B, f.U));
    const torus = new THREE.Mesh(new THREE.TorusGeometry(f.r, 0.28, 12, 56),
      new THREE.MeshStandardMaterial({ color: f.fire ? '#ff7a1a' : '#ffd23f', emissive: f.fire ? '#ff4a00' : '#ffb000', emissiveIntensity: 1.6, metalness: 0.6, roughness: 0.25 }));
    torus.quaternion.copy(q); torus.position.copy(f.C); torus.castShadow = true; g.add(torus);
    const glow = new THREE.Mesh(new THREE.TorusGeometry(f.r, 0.8, 8, 48),
      new THREE.MeshBasicMaterial({ color: f.fire ? '#ff5a00' : '#ffcc33', transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    glow.quaternion.copy(q); glow.position.copy(f.C); g.add(glow);
    f.mesh = torus; f.glow = glow;
    if (f.fire) {
      const postMat = new THREE.MeshStandardMaterial({ color: '#3a2f55', metalness: 0.7, roughness: 0.3 });
      const top = f.hgt + f.r + 0.3, span = HW + 1.2;
      for (const sd of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, top, 8), postMat);
        post.position.copy(f.P).addScaledVector(f.B, sd * span).addScaledVector(f.U, top / 2);
        post.quaternion.copy(basis(f.B, f.U, new V3().crossVectors(f.B, f.U))); post.castShadow = true; g.add(post);
      }
      const bar = new THREE.Mesh(new THREE.BoxGeometry(span * 2, 0.3, 0.3), postMat);
      bar.position.copy(f.P).addScaledVector(f.U, top); bar.quaternion.copy(q); bar.castShadow = true; g.add(bar);
    }
  }

  // ---- start & finish
  const stripTex = canvasTex(256, 64, (x, w, h) => checker(x, w, h, 16, 4));
  const strip = (s) => {
    frameAtT(tr, s, F);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(HW * 2, 2.2), new THREE.MeshStandardMaterial({ map: stripTex, roughness: 0.5, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    m.position.copy(F.P).addScaledVector(F.U, 0.03); m.quaternion.copy(basis(F.B, F.T, F.U)); m.receiveShadow = true; g.add(m);
  };
  strip(12); strip(tr.finishS);
  frameAtT(tr, tr.finishS, F);
  const bannerTex = canvasTex(1024, 192, (x, w, h) => {
    checker(x, w, h, 32, 6);
    x.fillStyle = '#ffd23f'; x.fillRect(w * 0.27, h * 0.14, w * 0.46, h * 0.72);
    x.fillStyle = '#1b0f3a'; x.font = `900 ${h * 0.55}px system-ui, sans-serif`; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText('FINISH', w / 2, h / 2 + 4);
  });
  const archMat = new THREE.MeshStandardMaterial({ color: '#ffffff', metalness: 0.8, roughness: 0.2 });
  const archQ = basis(F.B, F.U, new V3().crossVectors(F.B, F.U));
  for (const sd of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.4, 9, 12), archMat);
    post.position.copy(F.P).addScaledVector(F.B, sd * (HW + 1.6)).addScaledVector(F.U, 4.5); post.quaternion.copy(archQ); post.castShadow = true; g.add(post);
  }
  const banner = new THREE.Mesh(new THREE.BoxGeometry(HW * 2 + 4, 2, 0.35), new THREE.MeshStandardMaterial({ map: bannerTex, roughness: 0.4 }));
  banner.position.copy(F.P).addScaledVector(F.U, 8.2); banner.quaternion.copy(archQ); banner.castShadow = true; g.add(banner);
  tr.archTop = banner.position.clone();

  // flags along the finish straight
  flagGeos = [];
  for (let k = 0; k < 3; k++) {
    const geo = new THREE.PlaneGeometry(2.4, 1.5, 12, 4); geo.translate(1.2, 0, 0);
    geo.userData.base = geo.attributes.position.array.slice(); geo.userData.phase = k * 2.1; flagGeos.push(geo);
  }
  const flagCols = ['#ff3b5c', '#ffd23f', '#3bceac', '#4d7cff', '#ffffff', '#b14dff'];
  const poleMat = new THREE.MeshStandardMaterial({ color: '#dddddd', metalness: 0.8, roughness: 0.25 });
  let fc = 0;
  for (let s = tr.finishS - 64; s <= tr.finishS + 24; s += 8) {
    frameAtT(tr, s, F);
    for (const sd of [-1, 1]) {
      const grp = new THREE.Group();
      const out = F.B.clone().multiplyScalar(sd); const up = new V3(0, 1, 0);
      out.addScaledVector(up, -out.dot(up)).normalize();
      grp.quaternion.copy(basis(out, up, new V3().crossVectors(out, up)));
      grp.position.copy(F.P).addScaledVector(F.B, sd * (HW + 1.5));
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 5.5, 6), poleMat);
      pole.position.y = 2.75; pole.castShadow = true; grp.add(pole);
      const flag = new THREE.Mesh(flagGeos[fc % 3], new THREE.MeshStandardMaterial({ color: flagCols[fc % flagCols.length], side: THREE.DoubleSide, roughness: 0.6 }));
      flag.position.set(0.05, 4.7, 0); flag.castShadow = true; grp.add(flag);
      g.add(grp); fc++;
    }
  }

  // ---- pillars down to the ground
  const groundY = tr.minY - 80;
  const noPil = [];
  for (const f of tr.features) if (f.type === 'loop') noPil.push([f.s0 - 70, f.s1 + 70]);
  const pil = [];
  for (let i = 20; i < tr.N; i += 60) {
    const s = i * DS;
    if (!tr.smp[i].solid || tr.U[i].y < 0.85 || noPil.some(([a, b]) => s > a && s < b)) continue;
    pil.push(i);
  }
  const pilMesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.7, 1.2, 1, 10), new THREE.MeshStandardMaterial({ color: '#5b4a91', roughness: 0.5, metalness: 0.3 }), Math.max(1, pil.length));
  const m4 = new THREE.Matrix4(), one = new THREE.Quaternion();
  pil.forEach((i, k) => {
    const top = tr.P[i].clone().addScaledVector(tr.U[i], -0.7);
    const hgt = top.y - groundY;
    m4.compose(new V3(top.x, groundY + hgt / 2, top.z), one, new V3(1, hgt, 1));
    pilMesh.setMatrixAt(k, m4);
  });
  pilMesh.count = pil.length; pilMesh.receiveShadow = true; g.add(pilMesh);

  // ---- ground
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(8000, 8000), new THREE.MeshStandardMaterial({ color: '#6d4b8f', roughness: 0.9 }));
  ground.rotation.x = -Math.PI / 2; ground.position.set(tr.P[tr.N >> 1].x, groundY, tr.P[tr.N >> 1].z);
  g.add(ground);

  // ---- clouds
  const rnd = mulberry32(tr.seed ^ 0x9e3779b9);
  const puffs = [];
  for (let c = 0; c < 70; c++) {
    const i = Math.floor(rnd() * tr.N), base = tr.P[i];
    const side = rnd() < 0.5 ? -1 : 1, dist = 45 + rnd() * 220;
    const lat = new V3(tr.T[i].z, 0, -tr.T[i].x).normalize().multiplyScalar(side * dist);
    const cen = base.clone().add(lat); cen.y += -50 + rnd() * 70;
    let ok = true;
    for (let k = 0; k < tr.N; k += 20) if (tr.P[k].distanceToSquared(cen) < 36 * 36) { ok = false; break; }
    if (!ok) continue;
    const np = 3 + Math.floor(rnd() * 4);
    for (let k = 0; k < np; k++) puffs.push([cen.x + (rnd() - 0.5) * 22, cen.y + (rnd() - 0.5) * 5, cen.z + (rnd() - 0.5) * 22, 5 + rnd() * 8]);
  }
  const cloud = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardMaterial({ color: '#fff4f0', roughness: 1, flatShading: true, emissive: '#5a3a6a', emissiveIntensity: 0.25 }), Math.max(1, puffs.length));
  puffs.forEach((pf, k) => { m4.compose(new V3(pf[0], pf[1], pf[2]), one, new V3(pf[3], pf[3] * 0.6, pf[3])); cloud.setMatrixAt(k, m4); });
  cloud.count = puffs.length; g.add(cloud);

  return g;
}

let world = null;
function setTrack(tr) {
  if (world) {
    scene.remove(world);
    world.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) { const ms = Array.isArray(o.material) ? o.material : [o.material]; ms.forEach(m => { if (m.map) m.map.dispose(); m.dispose(); }); }
    });
  }
  track = tr;
  world = buildWorld(tr);
  scene.add(world);
  fx.clear(); confetti.clear();
}

// ============================================================================
// Audio (tiny WebAudio synth)
// ============================================================================
let actx = null, master = null, rollGain = null, rollFilter = null, quakeGain = null, noiseBuf = null;
function initAudio() {
  if (actx) { actx.resume(); return; }
  try {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    master = actx.createGain(); master.gain.value = 0.55; master.connect(actx.destination);
    noiseBuf = actx.createBuffer(1, actx.sampleRate * 2, actx.sampleRate);
    const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const loopNoise = (freq, gainNode, type = 'lowpass') => {
      const src = actx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
      const f = actx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
      src.connect(f); f.connect(gainNode); gainNode.connect(master); src.start(); return f;
    };
    rollGain = actx.createGain(); rollGain.gain.value = 0; rollFilter = loopNoise(300, rollGain);
    quakeGain = actx.createGain(); quakeGain.gain.value = 0; loopNoise(90, quakeGain);
    actx.resume();
  } catch (e) { actx = null; }
}
function tone(f0, f1, dur, type = 'square', vol = 0.15, delay = 0) {
  if (!actx) return;
  const t = actx.currentTime + delay, o = actx.createOscillator(), g = actx.createGain();
  o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.05);
}
function noise(dur, freq, vol, type = 'lowpass') {
  if (!actx) return;
  const t = actx.currentTime, s = actx.createBufferSource(), f = actx.createBiquadFilter(), g = actx.createGain();
  s.buffer = noiseBuf; f.type = type; f.frequency.value = freq;
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  s.connect(f); f.connect(g); g.connect(master); s.start(t); s.stop(t + dur + 0.05);
}
const sfx = {
  jump: () => tone(320, 720, 0.18, 'square', 0.08),
  land: v => noise(0.18, 260, Math.min(0.6, v / 30)),
  ring: () => { tone(500, 1300, 0.35, 'sawtooth', 0.07); tone(750, 1600, 0.4, 'triangle', 0.09); },
  burn: () => noise(0.7, 1400, 0.45, 'bandpass'),
  boost: () => tone(200, 900, 0.3, 'sawtooth', 0.05),
  fall: () => tone(700, 70, 0.9, 'triangle', 0.18),
  loop: () => { tone(520, 1040, 0.15, 'square', 0.06); tone(780, 1560, 0.2, 'square', 0.05, 0.1); },
  finish: () => [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, f, 0.22, 'square', 0.08, i * 0.12)),
  count: hi => tone(hi ? 880 : 440, hi ? 880 : 440, 0.18, 'square', 0.08),
  quake: () => noise(1.2, 70, 0.8),
  fog: () => tone(220, 160, 1.2, 'sine', 0.12),
};

// ============================================================================
// Input: accelerometer tilt (left/right only), keyboard, tap to jump
// ============================================================================
const input = { roll: 0, steer: 0, keyL: false, keyR: false, jumpBuf: 0, jumpPow: 1, invert: false };
const SHAKE_T = 4.0;
const tilt = { lastShake: 0, gLP: null, rd: null, motion: false, beta: null, gamma: null, votes: 0, neutral: 0, needNeutral: true, listening: false };
const screenAngle = () => {
  const a = (screen.orientation && typeof screen.orientation.angle === 'number') ? screen.orientation.angle : (window.orientation || 0);
  return ((a % 360) + 360) % 360;
};
function orientRightDown() {
  // gravity "up" in device coordinates from Euler angles; returns sin(dip of the screen's right edge)
  const b = tilt.beta * DEG, g = tilt.gamma * DEG;
  const up = [-Math.cos(b) * Math.sin(g), Math.sin(b), Math.cos(b) * Math.cos(g)];
  const a = screenAngle();
  const upR = a === 90 ? -up[1] : a === 270 ? up[1] : a === 180 ? -up[0] : up[0];
  return -upR;
}
function onOrient(e) {
  if (e.beta == null || e.gamma == null) return;
  tilt.beta = e.beta; tilt.gamma = e.gamma;
  if (!tilt.motion) tilt.rd = orientRightDown();
}
function onMotion(e) {
  const ag = e.accelerationIncludingGravity;
  if (!ag || ag.x == null) return;
  const m = Math.hypot(ag.x, ag.y, ag.z) || 9.81;
  const a = screenAngle();
  const comp = a === 90 ? -ag.y : a === 270 ? ag.y : a === 180 ? -ag.x : ag.x;
  let rd = -comp / m; // W3C convention: reading = +up * g
  // platforms disagree on the sign of the accelerometer: vote against the orientation sensor
  if (tilt.beta != null && Math.abs(tilt.beta) < 65) {
    const o = orientRightDown();
    if (Math.abs(o) > 0.15 && Math.abs(rd) > 0.15) tilt.votes = clamp(tilt.votes + (Math.sign(o) === Math.sign(rd) ? 1 : -1), -30, 30);
  }
  if (tilt.votes < -4) rd = -rd;
  tilt.motion = true; tilt.rd = rd;

  // jiggle the phone: a sharp linear-acceleration spike kicks the ball into a jump
  let jolt;
  const la = e.acceleration;
  if (la && la.x != null) jolt = (a === 90 || a === 270) ? Math.hypot(la.x, la.z) : Math.hypot(la.y, la.z);
  else { tilt.gLP = tilt.gLP == null ? m : lerp(tilt.gLP, m, 0.1); jolt = Math.abs(m - tilt.gLP) * 1.4; }
  const now = performance.now();
  if (jolt > SHAKE_T && now - tilt.lastShake > 350) {
    tilt.lastShake = now;
    input.jumpBuf = 0.18;
    input.jumpPow = clamp(1 + (jolt - SHAKE_T) / 12, 1, 1.7);
  }
}
function requestSensors() {
  const reqs = [];
  try {
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') reqs.push(DeviceMotionEvent.requestPermission());
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') reqs.push(DeviceOrientationEvent.requestPermission());
  } catch (e) { /* ignore */ }
  Promise.allSettled(reqs).then(() => {
    if (tilt.listening) return;
    tilt.listening = true;
    window.addEventListener('devicemotion', onMotion);
    window.addEventListener('deviceorientation', onOrient);
  });
}
window.addEventListener('keydown', e => {
  if (e.code === 'ArrowLeft' || e.code === 'KeyA') input.keyL = true;
  if (e.code === 'ArrowRight' || e.code === 'KeyD') input.keyR = true;
  if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') { input.jumpBuf = 0.15; e.preventDefault(); }
});
window.addEventListener('keyup', e => {
  if (e.code === 'ArrowLeft' || e.code === 'KeyA') input.keyL = false;
  if (e.code === 'ArrowRight' || e.code === 'KeyD') input.keyR = false;
});
canvas.addEventListener('touchstart', e => { e.preventDefault(); input.jumpBuf = 0.15; input.jumpPow = 1; }, { passive: false });
canvas.addEventListener('mousedown', () => { input.jumpBuf = 0.15; });
document.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
document.getElementById('invert').addEventListener('change', e => { input.invert = e.target.checked; });

function readInput(dt) {
  let target = 0, rollT = 0;
  if (state.mode === 'demo') target = autopilot();
  else if (input.keyL || input.keyR) target = (input.keyR ? 1 : 0) - (input.keyL ? 1 : 0);
  else if (tilt.rd !== null) {
    const ang = Math.asin(clamp(tilt.rd, -1, 1)) / DEG;
    if (tilt.needNeutral) { tilt.neutral = clamp(ang, -10, 10); tilt.needNeutral = false; }
    const d = ang - tilt.neutral, dz = 1.5, mx = 20;
    rollT = ang * DEG; // physical roll of the phone (relative to gravity)
    target = Math.sign(d) * Math.min(1, Math.max(0, Math.abs(d) - dz) / (mx - dz));
    if (input.invert) target = -target;
  }
  input.steer += (target - input.steer) * (1 - Math.exp(-dt * 14));
  input.roll += (rollT - input.roll) * (1 - Math.exp(-dt * 25));
}

// ============================================================================
// Game state & physics
// ============================================================================
const state = { levelTime: 0, mode: 'demo', level: 1, score: 0, lives: 3, mult: 1, finished: false, finishT: 0, prevS: 0, respawnT: 0, countT: 0, lastCount: -1, time: 0, best: 0 };
try { state.best = +localStorage.getItem('tiltRollerBest') || 0; } catch (e) { /* ignore */ }
const ball = { s: 2, x: 0, v: 0, vx: 0, grounded: true, pos: new V3(), vel: new V3(), air: 0, dead: false, h: 0, invuln: 0, burnT: 0, spinAxis: new V3(1, 0, 0), spinRate: 0, lastKind: 0, fallS: 0 };
const weather = { quakeNext: 22, quakeT: -1, quakePh: 0, quakeDur: 3.6, quakeEnv: 0, quakeLat: 0, fogNext: 35, fogT: -1, fogDur: 14, fogAmt: 0 };

const D = new V3(), tv = new V3(), tq = new THREE.Quaternion();

// cruising speed: the level's base speed, growing the longer you stay in the level
function targetV() { return track.vt + Math.min(16, state.levelTime * 0.2); }
function setGroundPos(f) {
  ball.pos.copy(f.P).addScaledVector(f.B, ball.x).addScaledVector(f.U, BALL_R);
}
function detach(up) {
  const f = frameAt(ball.s, F1);
  ball.vel.copy(f.T).multiplyScalar(ball.v).addScaledVector(f.B, ball.vx).addScaledVector(f.U, up);
  setGroundPos(f);
  ball.grounded = false; ball.air = 0;
}

function groundStep(dt) {
  const f = frameAt(ball.s, F1);
  const sm = track.smp[f.i];
  const gT = -G * f.T.y, gB = -G * f.B.y, gU = -G * f.U.y;
  let aS;
  if (state.finished) aS = gT * 0.3 - 16 * Math.sign(ball.v);
  else { const tv0 = targetV(); const target = sm.boost ? Math.max(sm.boost, tv0 + 4) : tv0; aS = gT * 0.5 + (target - ball.v) * (sm.boost ? 3 : 0.9); }
  ball.v += aS * dt;
  if (!state.finished && sm.minV && ball.v < sm.minV) ball.v = sm.minV;
  ball.v = clamp(ball.v, state.finished ? 0 : 6, 95);

  const aX = gB + input.steer * STEER_ACC - ball.v * ball.v * f.kB - ball.vx * 2.2 + weather.quakeLat;
  ball.vx += aX * dt; ball.x += ball.vx * dt;
  const wall = HW - BALL_R * 0.6;
  if (sm.berm > 0.3 && ball.x > wall) { ball.x = wall; if (ball.vx > 0) ball.vx *= -0.6; }
  if (sm.berm < -0.3 && ball.x < -wall) { ball.x = -wall; if (ball.vx < 0) ball.vx *= -0.6; }

  ball.s += ball.v * dt;
  if (ball.s >= track.len - 1) { ball.s = track.len - 1; ball.v = 0; }

  if (input.jumpBuf > 0 && !sm.noDetach) { input.jumpBuf = 0; detach(JUMP_V * input.jumpPow); input.jumpPow = 1; sfx.jump(); return; }
  const Fn = ball.v * ball.v * f.kN - gU;
  const f2 = frameAt(ball.s, F2);
  const sm2 = track.smp[f2.i];
  // banked turns hold the ball like a coaster car; elsewhere a fast crest throws it into the air
  if (!sm2.solid || Math.abs(ball.x) > HW + 0.15 || (!sm.noDetach && Math.abs(sm.berm) < 0.3 && Fn < -2)) { detach(0); return; }
  setGroundPos(f2);
}

function airStep(dt) {
  ball.air += dt;
  const f = frameAt(ball.s, F1);
  ball.vel.y -= G * dt;
  ball.vel.addScaledVector(f.B, (input.steer * 14 + weather.quakeLat * 0.3) * dt);
  ball.vel.addScaledVector(f.B, -ball.vel.dot(f.B) * (1 - Math.exp(-1.2 * dt))); // sideways air drag
  ball.pos.addScaledVector(ball.vel, dt);
  if (ball.dead) return;
  // follow the nearest track sample by hill-climbing along the tangent
  let i = Math.round(ball.s / DS);
  for (let it = 0; it < 400; it++) {
    const a = D.subVectors(ball.pos, track.P[i]).dot(track.T[i]);
    if (a > DS * 0.5 && i < track.N - 1) i++; else if (a < -DS * 0.5 && i > 0) i--; else break;
  }
  const a = D.subVectors(ball.pos, track.P[i]).dot(track.T[i]);
  ball.s = clamp(i * DS + a, 0, track.len - 1);
  const g = frameAt(ball.s, F2);
  D.subVectors(ball.pos, g.P);
  const hh = D.dot(g.U), xx = D.dot(g.B);
  ball.h = hh; ball.x = xx;
  const sm = track.smp[g.i];
  // the raised berm on the outside of a curve is a wall for an airborne ball too
  if (sm.solid && Math.abs(sm.berm) > 0.3 && hh < BALL_R + 1.7 * Math.abs(sm.berm) + 1.5 && hh > -1) {
    const side = Math.sign(sm.berm), wall = HW - BALL_R * 0.6;
    if (xx * side > wall) {
      ball.pos.addScaledVector(g.B, -side * (xx * side - wall));
      const vb = ball.vel.dot(g.B);
      if (vb * side > 0) ball.vel.addScaledVector(g.B, -vb * 1.6);
      ball.x = side * wall;
    }
  }
  if (sm.solid && Math.abs(ball.x) < HW + 0.2 && hh <= BALL_R && hh > -1.4 && ball.vel.dot(g.U) <= 0.5) { land(g, sm); return; }
  if ((ball.air > 0.5 && hh < -22) || D.length() > 90) fallOff();
}

function land(g, sm) {
  const vn = -ball.vel.dot(g.U);
  // a jump pressed just before touching down fires on landing
  if (input.jumpBuf > 0 && !sm.noDetach) {
    ball.vel.addScaledVector(g.U, vn + JUMP_V * input.jumpPow);
    input.jumpBuf = 0; input.jumpPow = 1; sfx.jump();
    ball.pos.copy(g.P).addScaledVector(g.B, clamp(ball.x, -HW, HW)).addScaledVector(g.U, BALL_R + 0.02);
    ball.air = 0;
    return;
  }
  const gapAhead = track.features.some(f => (f.type === 'pit' || f.type === 'gap') && f.s0 > ball.s && f.s0 - ball.s < 45)
    || track.rings.some(f => f.fire && f.s > ball.s && f.s - ball.s < 45);
  if (vn > BOUNCE_MIN && !sm.noDetach && sm.kind !== K.KICK && sm.kind !== K.BOOST && !gapAhead) {
    // bounce: reflect the normal velocity with restitution and stay airborne
    ball.vel.addScaledVector(g.U, vn * (1 + BOUNCE_E));
    const lim = Math.abs(sm.berm) > 0.3 ? HW - BALL_R * 0.6 : HW;
    ball.x = clamp(ball.x, -lim, lim);
    ball.pos.copy(g.P).addScaledVector(g.B, ball.x).addScaledVector(g.U, BALL_R + 0.02);
    sfx.land(vn);
    for (let k = 0; k < 10; k++) fx.spawn(ball.pos, tv.set((Math.random() - 0.5) * 8, Math.random() * 4, (Math.random() - 0.5) * 8), 0.45, [1, 0.9, 0.7, 0.5], [0.6, 0.4, 0.8, 0], 0.7, 1.4, 6, 2);
    if (ball.air > 0.8 && state.mode === 'play' && !state.finished) {
      const pts = Math.round(ball.air * 120) * state.mult;
      state.score += pts; popup(`BIG AIR +${pts}`, 'good');
    }
    ball.air = 0;
    return;
  }
  ball.v = Math.max(4, ball.vel.dot(g.T)); ball.vx = ball.vel.dot(g.B) * 0.6;
  const lim = (sm.berm > 0.3 || sm.berm < -0.3) ? HW - BALL_R * 0.6 : HW;
  ball.x = clamp(ball.x, -lim, lim);
  ball.grounded = true;
  if (vn > 9) {
    sfx.land(vn);
    for (let k = 0; k < 14; k++) fx.spawn(ball.pos, tv.set((Math.random() - 0.5) * 8, Math.random() * 4, (Math.random() - 0.5) * 8), 0.5, [1, 0.9, 0.7, 0.5], [0.6, 0.4, 0.8, 0], 0.8, 1.6, 6, 2);
  }
  if (ball.air > 0.8 && state.mode === 'play' && !state.finished) {
    const pts = Math.round(ball.air * 120) * state.mult;
    state.score += pts; popup(`BIG AIR +${pts}`, 'good');
  }
  ball.air = 0;
  setGroundPos(frameAt(ball.s, F2));
}

function fallOff() {
  if (ball.dead) return;
  ball.dead = true; ball.fallS = ball.s;
  sfx.fall();
  if (state.finished) { state.respawnT = 0; levelComplete(); return; }
  if (state.mode === 'play') {
    state.lives--; state.mult = 1; popup('FELL OFF!', 'bad');
  }
  state.respawnT = 1.3;
}

function respawn() {
  let best = track.checkpoints[0];
  for (const c of track.checkpoints) if (c * DS <= ball.fallS - 2) best = c;
  ball.s = best * DS + 1; ball.x = 0; ball.vx = 0; ball.v = targetV(); ball.grounded = true; ball.dead = false; ball.air = 0;
  ball.invuln = 1.5; ball.burnT = 0;
  for (const f of track.features) {
    if (f.type === 'ring' && f.s > ball.s) f.done = false;
    if (f.type === 'loop') f.clean = false;
  }
  state.prevS = ball.s;
  setGroundPos(frameAt(ball.s, F2));
  camSnap = true;
}

function physicsStep(dt) {
  if (ball.dead) { ball.vel.y -= G * dt; ball.pos.addScaledVector(ball.vel, dt); return; }
  if (ball.grounded) groundStep(dt); else airStep(dt);
}

function autopilot() {
  const f = frameAt(ball.s, F4);
  const ff = (G * f.B.y + ball.v * ball.v * f.kB - weather.quakeLat) / STEER_ACC;
  let tx = 0;
  for (const r of track.rings) {
    const d = r.s - ball.s;
    if (d > 0 && d < 70) tx = r.xo;
    if (r.fire && d > 0 && d < ball.v * (JUMP_V / G) * 0.95 && ball.grounded) { input.jumpBuf = 0.1; break; }
  }
  for (const f of track.features) if (f.type === 'pit') { const d = f.s0 - ball.s; if (d > 0 && d < ball.v * 0.18 && ball.grounded) input.jumpBuf = 0.1; }
  return clamp(ff - (ball.x - tx) * 0.35 - ball.vx * 0.25, -1, 1);
}

// ---- events
function ringCheck(f) {
  const hc = ball.grounded ? BALL_R : ball.h;
  const dist = Math.hypot(ball.x - f.xo, hc - f.hgt);
  const scoring = state.mode === 'play';
  if (dist < f.r - BALL_R * 0.3) {
    if (scoring) { const pts = 500 * state.mult; state.score += pts; popup(`${f.fire ? 'RING OF FIRE' : 'BONUS RING'} +${pts}`, 'good'); state.mult = Math.min(5, state.mult + 1); }
    sfx.ring();
    for (let k = 0; k < 80; k++) {
      const a = Math.random() * Math.PI * 2;
      const p = f.C.clone().addScaledVector(f.B, Math.cos(a) * f.r).addScaledVector(f.U, Math.sin(a) * f.r);
      const v = f.B.clone().multiplyScalar(Math.cos(a) * 6).addScaledVector(f.U, Math.sin(a) * 6).addScaledVector(f.T, 8);
      fx.spawn(p, v, 0.7, [1, 0.95, 0.5, 1], [1, 0.2, 0, 0], 1.4, 0.2, 0, 2);
    }
    f.flare = 1;
  } else if (f.fire && (hc - BALL_R < 1.3 || Math.abs(dist - f.r) < BALL_R + 0.3) && ball.invuln <= 0) {
    if (scoring) { state.score = Math.max(0, state.score - 150); popup('BURNED! -150', 'bad'); state.mult = 1; }
    ball.v *= 0.6; ball.burnT = 1.2; sfx.burn(); flash(0.55);
  }
}

function finishReached() {
  state.finished = true; state.finishT = 0;
  sfx.finish();
  if (state.mode === 'play') {
    const pts = 1000 * state.level; state.score += pts;
    popup('FINISH!', 'big good'); popup(`+${pts}`, 'good');
  }
}

let popEl = document.getElementById('pops');
function popup(text, cls = '') {
  const d = document.createElement('div'); d.className = 'pop ' + cls; d.textContent = text;
  popEl.appendChild(d); setTimeout(() => d.remove(), 1400);
}
const flashEl = document.getElementById('flash');
function flash(a, color = '#ff6a00') { flashEl.style.background = color; flashEl.style.opacity = a; setTimeout(() => { flashEl.style.opacity = 0; }, 120); }

function logic(dt) {
  const s = ball.s, ps = state.prevS;
  if (!ball.dead) {
    for (const f of track.features) {
      if (f.type === 'ring' && !f.done && ps < f.s && s >= f.s) { f.done = true; ringCheck(f); }
      else if (f.type === 'loop') {
        if (ps < f.s0 && s >= f.s0) f.clean = true;
        if (f.clean && ps < f.s1 && s >= f.s1) {
          f.clean = false; sfx.loop();
          if (state.mode === 'play') { const pts = 300 * state.mult; state.score += pts; popup(`${f.name} +${pts}`, 'good'); state.mult = Math.min(5, state.mult + 1); }
        }
      } else if (f.type === 'pitzone' && ps < f.s0 && s >= f.s0) { if (state.mode === 'play') popup('PIT! JUMP!', 'bad'); }
      else if (f.type === 'pit' && ps < f.s1 && s >= f.s1 && state.mode === 'play') { const pts = 200 * state.mult; state.score += pts; popup(`CLEARED +${pts}`, 'good'); }
      else if (f.type === 'finish' && !state.finished && ps < f.s && s >= f.s) finishReached();
    }
  }
  state.prevS = s;
  if (!state.finished) state.levelTime += dt;
  if (state.mode === 'play' && ball.grounded && !ball.dead && !state.finished) state.score += ball.v * dt * 0.5 * state.mult;

  // boost entry
  const kind = track.smp[frameAt(ball.s, F4).i].kind;
  if (kind === K.BOOST && ball.lastKind !== K.BOOST && ball.grounded) { sfx.boost(); }
  ball.lastKind = kind;

  // earthquakes
  if (!state.finished) {
    weather.quakeNext -= dt;
    if (weather.quakeNext <= 0 && weather.quakeT < 0) {
      weather.quakeT = 0; weather.quakePh = Math.random() * 6.28; popup('EARTHQUAKE!', 'bad big'); sfx.quake();
      const sm = track.smp[frameAt(ball.s, F4).i];
      const pitAhead = track.features.some(f => f.type === 'pit' && f.s0 > ball.s - 5 && f.s0 - ball.s < 70);
      if (ball.grounded && !sm.noDetach && !pitAhead) detach(10);
    }
  }
  if (weather.quakeT >= 0) {
    weather.quakeT += dt;
    const t = weather.quakeT / weather.quakeDur;
    weather.quakeEnv = Math.sqrt(Math.max(0, Math.sin(Math.PI * Math.min(1, t))));
    const qt = weather.quakeT;
    weather.quakeLat = (Math.sin(qt * 2.2 + weather.quakePh) * 15 + Math.sin(qt * 11.3) * 9 + Math.sin(qt * 17.1 + 1) * 6) * weather.quakeEnv;
    if (Math.random() < dt * 30) fx.spawn(tv.copy(ball.pos).add(new V3((Math.random() - 0.5) * 10, -0.5, (Math.random() - 0.5) * 10)), new V3(0, 2 + Math.random() * 3, 0), 0.9, [0.9, 0.75, 0.6, 0.35], [0.5, 0.4, 0.4, 0], 1.5, 3.5, 0, 1);
    if (t >= 1) { weather.quakeT = -1; weather.quakeEnv = 0; weather.quakeLat = 0; weather.quakeNext = 18 + Math.random() * 16; }
  }
  if (quakeGain) quakeGain.gain.value = weather.quakeEnv * 0.9;

  // fog banks
  if (!state.finished) {
    weather.fogNext -= dt;
    if (weather.fogNext <= 0 && weather.fogT < 0) { weather.fogT = 0; weather.fogDur = 10 + Math.random() * 8; popup('FOG BANK!', 'info'); sfx.fog(); }
  }
  if (weather.fogT >= 0) {
    weather.fogT += dt;
    const t = weather.fogT, d = weather.fogDur;
    weather.fogAmt = smooth(Math.min(t / 2.5, (d - t) / 2.5, 1));
    if (t >= d) { weather.fogT = -1; weather.fogAmt = 0; weather.fogNext = 30 + Math.random() * 25; }
  }

  ball.invuln = Math.max(0, ball.invuln - dt);
  ball.burnT = Math.max(0, ball.burnT - dt);

  if (ball.dead && state.respawnT > 0) {
    state.respawnT -= dt;
    if (state.respawnT <= 0) {
      if (state.mode === 'play' && state.lives <= 0) gameOver(); else respawn();
    }
  }
  if (state.finished) {
    state.finishT += dt;
    if (state.finishT < 3 && Math.random() < dt * 14) burstConfetti(track.archTop, 18);
    if ((ball.v < 0.5 && state.finishT > 1.5) || state.finishT > 5) {
      if (state.mode === 'play') levelComplete(); else startDemo();
    }
  }
}

function burstConfetti(at, n) {
  const cols = [[1, 0.23, 0.36, 1], [1, 0.82, 0.25, 1], [0.23, 0.81, 0.67, 1], [0.3, 0.49, 1, 1], [1, 1, 1, 1], [0.7, 0.3, 1, 1]];
  for (let k = 0; k < n; k++) {
    const c = cols[Math.floor(Math.random() * cols.length)];
    confetti.spawn(at, tv.set((Math.random() - 0.5) * 18, 6 + Math.random() * 10, (Math.random() - 0.5) * 18), 2.5 + Math.random(), c, [c[0], c[1], c[2], 0.8], 0.35, 0.35, 9, 1.4);
  }
}

// ============================================================================
// Flow: demo / countdown / play / level complete / game over
// ============================================================================
const hud = document.getElementById('hud'), overlay = document.getElementById('overlay');
const ovTitle = document.getElementById('ovTitle'), ovBody = document.getElementById('ovBody'), ovBtn = document.getElementById('ovBtn'), ovHint = document.getElementById('ovHint');
const elScore = document.getElementById('score'), elMult = document.getElementById('mult'), elLevel = document.getElementById('level'), elLives = document.getElementById('lives');
const elSpeed = document.getElementById('speed'), elProg = document.getElementById('progFill'), elTilt = document.getElementById('tiltDot');
let camSnap = true;

function resetRun() {
  ball.s = 2; ball.x = 0; ball.vx = 0; ball.v = 0; ball.grounded = true; ball.dead = false; ball.air = 0; ball.invuln = 0; ball.burnT = 0;
  state.finished = false; state.finishT = 0; state.prevS = ball.s; state.respawnT = 0; state.levelTime = 0;
  weather.quakeT = -1; weather.quakeEnv = 0; weather.quakeLat = 0; weather.quakeNext = 18 + Math.random() * 12;
  weather.fogT = -1; weather.fogAmt = 0; weather.fogNext = 28 + Math.random() * 20;
  setGroundPos(frameAt(ball.s, F2));
  camSnap = true;
}
function newSeed() { return params.has('seed') ? (+params.get('seed') + state.level) >>> 0 : ((Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0); }

function startDemo() {
  state.mode = 'demo';
  setTrack(generateTrack(newSeed(), 3));
  resetRun(); ball.v = track.vt;
}
function startGame() {
  initAudio(); requestSensors();
  state.level = +params.get('level') || 1; state.score = 0; state.lives = 3; state.mult = 1;
  beginLevel();
}
function beginLevel() {
  setTrack(generateTrack(newSeed(), state.level));
  resetRun();
  state.mode = 'count'; state.countT = 3; state.lastCount = -1;
  overlay.classList.add('hidden'); hud.classList.remove('hidden');
}
function levelComplete() {
  if (state.mode !== 'play') return;
  state.mode = 'done';
  saveBest();
  ovTitle.innerHTML = `LEVEL ${state.level}<br>COMPLETE!`;
  ovBody.innerHTML = `Score <b>${Math.floor(state.score)}</b><br>Next track is longer and faster. +1 life!`;
  ovBtn.textContent = 'NEXT LEVEL'; ovHint.textContent = '';
  overlay.classList.remove('hidden');
}
function gameOver() {
  state.mode = 'over';
  saveBest();
  ovTitle.innerHTML = 'GAME<br>OVER';
  ovBody.innerHTML = `Score <b>${Math.floor(state.score)}</b><br>Best <b>${Math.floor(state.best)}</b><br>Level ${state.level}`;
  ovBtn.textContent = 'PLAY AGAIN'; ovHint.textContent = 'A brand new track is generated every time.';
  overlay.classList.remove('hidden'); hud.classList.add('hidden');
}
function saveBest() {
  if (state.score > state.best) { state.best = state.score; try { localStorage.setItem('tiltRollerBest', String(Math.floor(state.best))); } catch (e) { /* ignore */ } }
}
ovBtn.addEventListener('click', () => {
  initAudio(); requestSensors();
  if (state.mode === 'done') { state.level++; state.lives = Math.min(5, state.lives + 1); beginLevel(); }
  else startGame();
});
if (!('ontouchstart' in window)) ovHint.textContent = 'Desktop: ← → to steer, Space to jump.';

function updateCountdown(dt) {
  state.countT -= dt;
  const c = Math.ceil(state.countT);
  if (c !== state.lastCount) {
    state.lastCount = c;
    if (c > 0) { popup(String(c), 'big'); sfx.count(false); }
    else { popup('GO!', 'big good'); sfx.count(true); tilt.needNeutral = true; }
  }
  if (state.countT <= 0) { state.mode = 'play'; ball.v = track.vt * 0.7; }
}

// ============================================================================
// Visual update & camera
// ============================================================================
const camPos = new V3(), camUp = new V3(0, 1, 0), camLook = new V3();
let lastFov = 66, frameNo = 0;
// adaptive quality: if the frame rate drops, lower resolution and reflection rate
const quality = { level: 0, reflEvery: 2, acc: 0, frames: 0, cool: 3 };
const QUALITY = [
  { pr: 2, refl: 2 }, { pr: 1.6, refl: 3 }, { pr: 1.3, refl: 4 }, { pr: 1.0, refl: 6 },
];
function applyQuality() {
  const q = QUALITY[quality.level];
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pr));
  quality.reflEvery = q.refl;
  onResize();
}
function trackFps(rawDt) {
  quality.acc += rawDt; quality.frames++; quality.cool -= rawDt;
  if (quality.acc >= 2) {
    const fps = quality.frames / quality.acc; quality.fps = fps;
    quality.acc = 0; quality.frames = 0;
    if (!document.hidden && quality.cool <= 0 && fps < 48 && quality.level < QUALITY.length - 1) { quality.level++; applyQuality(); quality.cool = 3; }
  }
}

function updateCamera(dt) {
  const f = frameAt(Math.max(0, ball.s - 8.5), F3);
  const desired = tv.copy(f.P).addScaledVector(f.U, 4.0).addScaledVector(f.B, clamp(ball.x, -HW, HW) * 0.6);
  const bf = frameAt(ball.s, F4);
  const upD = new V3().copy(f.U);
  const look = new V3().copy(ball.pos).addScaledVector(bf.T, 5).addScaledVector(bf.U, 0.6);
  if (ball.dead) look.copy(ball.pos);
  if (camSnap) { camPos.copy(desired); camUp.copy(upD); camLook.copy(look); camSnap = false; }
  if (!ball.dead) camPos.lerp(desired, 1 - Math.exp(-dt * 16));
  camUp.lerp(upD, 1 - Math.exp(-dt * 5)).normalize();
  camLook.lerp(look, 1 - Math.exp(-dt * 22));
  camera.position.copy(camPos);
  const sh = weather.quakeEnv * 0.45;
  if (sh > 0) camera.position.add(new V3((Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh));
  camera.up.copy(camUp);
  camera.lookAt(camLook);
  // keep the picture upright in the real world: undo the phone's roll on screen
  if (input.roll) camera.rotateZ(-input.roll);
  const fov = 64 + clamp(ball.v - 28, 0, 26) * 0.55;
  if (Math.abs(fov - lastFov) > 0.05) { lastFov = lerp(lastFov, fov, 1 - Math.exp(-dt * 3)); camera.fov = lastFov; camera.updateProjectionMatrix(); updatePointScale(); }
}

function updateVisuals(dt, gdt = dt) {
  state.time += dt;
  // ball spin
  if (ball.grounded && !ball.dead) {
    const f = frameAt(ball.s, F4);
    const vel = tv.copy(f.T).multiplyScalar(ball.v).addScaledVector(f.B, ball.vx);
    const spd = vel.length();
    if (spd > 0.01) { ball.spinAxis.crossVectors(f.U, vel).normalize(); ball.spinRate = spd / BALL_R; }
  }
  if (ball.spinRate > 0) { tq.setFromAxisAngle(ball.spinAxis, ball.spinRate * gdt); ballMesh.quaternion.premultiply(tq); }
  ballMesh.position.copy(ball.pos);
  {
    const f = frameAt(ball.s, F4), sm = track.smp[f.i];
    const hgt = ball.grounded ? 0 : Math.max(0, ball.h - BALL_R);
    blob.visible = !ball.dead && sm.solid && hgt < 25 && Math.abs(ball.x) < HW + 0.3;
    if (blob.visible) {
      blob.position.copy(f.P).addScaledVector(f.B, ball.x).addScaledVector(f.U, 0.03);
      blob.quaternion.copy(basis(f.B, f.T, f.U));
      blob.scale.setScalar(1 + hgt * 0.09);
      blob.material.opacity = clamp(1 - hgt / 22, 0.15, 1);
    }
  }
  ballMesh.visible = ball.invuln <= 0 || Math.floor(state.time * 12) % 2 === 0;

  // trails / burn / boost sparkles
  if (ball.burnT > 0) for (let k = 0; k < 3; k++) fx.spawn(tv.copy(ball.pos).add(new V3((Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.8)), new V3(0, 3, 0), 0.4, [1, 0.8, 0.3, 1], [0.8, 0.1, 0, 0], 1.0, 0.2, -2, 1);
  if (!ball.dead && ball.grounded && track.smp[frameAt(ball.s, F4).i].kind === K.BOOST) {
    const f = F4;
    for (let k = 0; k < 2; k++) fx.spawn(tv.copy(ball.pos).addScaledVector(f.U, -0.4), f.T.clone().multiplyScalar(-6).add(new V3((Math.random() - 0.5) * 4, Math.random() * 3, (Math.random() - 0.5) * 4)), 0.35, [0.3, 1, 1, 1], [0.1, 0.3, 1, 0], 0.6, 0.1, 4, 1);
  }

  // rings of fire flames
  for (const f of track.rings) {
    const d = f.s - ball.s;
    if (d < -30 || d > 220) continue;
    const n = f.fire ? 5 : 1;
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2;
      const p = tv.copy(f.C).addScaledVector(f.B, Math.cos(a) * f.r).addScaledVector(f.U, Math.sin(a) * f.r);
      fx.spawn(p, f.U.clone().multiplyScalar(1.5 + Math.random() * 2), 0.5, f.fire ? [1, 0.8, 0.3, 1] : [1, 0.95, 0.6, 0.8], [0.9, 0.1, 0, 0], f.fire ? 1.3 : 0.6, 0.3, 0, 1);
    }
    if (f.fire) for (let k = 0; k < 5; k++) {
      const p = tv.copy(f.P).addScaledVector(f.B, (Math.random() * 2 - 1) * (HW + 0.3)).addScaledVector(f.T, (Math.random() - 0.5) * 2.4).addScaledVector(f.U, 0.1);
      fx.spawn(p, f.U.clone().multiplyScalar(2.5 + Math.random() * 3), 0.45, [1, 0.85, 0.35, 1], [0.8, 0.05, 0, 0], 1.5, 0.4, 0, 1);
    }
    if (f.flare > 0) { f.flare = Math.max(0, f.flare - dt * 1.5); f.glow.scale.setScalar(1 + f.flare * 0.6); f.glow.material.opacity = 0.28 + f.flare * 0.5; }
  }

  // flags waving
  for (const geo of flagGeos) {
    const p = geo.attributes.position.array, b = geo.userData.base, ph = geo.userData.phase;
    for (let i = 0; i < p.length; i += 3) p[i + 2] = Math.sin(b[i] * 2.4 - state.time * 7 + ph) * 0.22 * (b[i] / 2.4);
    geo.attributes.position.needsUpdate = true;
  }
  // pulsing boost chevrons
  if (chevMats[0]) chevMats[0].opacity = 0.65 + 0.35 * Math.sin(state.time * 10);

  fx.update(gdt); confetti.update(gdt);

  // fog
  const fa = weather.fogAmt;
  scene.fog.near = lerp(160, 4, fa); scene.fog.far = lerp(700, 75, fa);
  scene.fog.color.copy(HORIZON).lerp(FOG_COLOR, fa);
  skyMat.uniforms.fogAmt.value = fa * 0.95;
  sun.intensity = lerp(2.6, 1.2, fa);

  // light & sky follow the ball
  sun.position.copy(ball.pos).addScaledVector(SUN_DIR, 90);
  sun.target.position.copy(ball.pos);
  updateCamera(dt);
  sky.position.copy(camera.position);

  // live reflections on the ball (every quality.reflEvery frames)
  if ((frameNo++ % quality.reflEvery) === 0) {
    ballMesh.visible = false;
    cubeCam.position.copy(ball.pos);
    renderer.shadowMap.needsUpdate = false;   // shadows are rendered once per frame, not per cube face
    cubeCam.update(renderer, scene);
    ballMesh.visible = ball.invuln <= 0 || Math.floor(state.time * 12) % 2 === 0;
  }

  // rolling sound
  if (rollGain) {
    const on = (state.mode === 'play' || state.mode === 'demo') && ball.grounded && !ball.dead && !document.hidden;
    rollGain.gain.value = on ? clamp(ball.v / 40, 0, 1) * 0.25 : 0;
    rollFilter.frequency.value = 150 + ball.v * 12;
  }

  // HUD
  if (state.mode === 'play' || state.mode === 'count') {
    elScore.textContent = Math.floor(state.score).toLocaleString();
    elMult.textContent = `×${state.mult}`;
    elLevel.textContent = `LEVEL ${state.level}`;
    elLives.textContent = '❤'.repeat(Math.max(0, state.lives));
    elProg.style.width = `${clamp(ball.s / track.finishS, 0, 1) * 100}%`;
    elTilt.style.left = `${50 + input.steer * 45}%`;
    elSpeed.textContent = `${Math.round(ball.v * TIME_SCALE * 3.6)} km/h`;
  }
}

function onResize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  updatePointScale();
}
function updatePointScale() {
  const sc = renderer.domElement.height / (2 * Math.tan(camera.fov * DEG / 2));
  fx.mat.uniforms.uScale.value = sc; confetti.mat.uniforms.uScale.value = sc;
}
window.addEventListener('resize', onResize);
window.addEventListener('orientationchange', () => setTimeout(onResize, 200));

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const rawDt = (now - last) / 1000; last = now;
  const dt = Math.min(0.066, rawDt);
  if (rawDt < 0.5) trackFps(rawDt);
  readInput(dt);
  if (state.mode === 'count') updateCountdown(dt);
  const gdt = dt * TIME_SCALE;
  if (state.mode === 'play' || state.mode === 'demo') {
    const n = Math.ceil(gdt / (1 / 150)), h = gdt / n;
    for (let k = 0; k < n; k++) physicsStep(h);
    input.jumpBuf = Math.max(0, input.jumpBuf - dt);
    logic(gdt);
  }
  updateVisuals(dt, gdt);
  renderer.shadowMap.needsUpdate = true;
  renderer.render(scene, camera);
}

startDemo();
onResize();
requestAnimationFrame(frame);
window.__game = {
  state, ball, get track() { return track; }, weather, input, camera,
  // headless test hook: advance the simulation without rendering
  sim(seconds, dt = 1 / 60) {
    for (let t = 0; t < seconds; t += dt) {
      readInput(dt);
      if (state.mode === 'count') updateCountdown(dt);
      if (state.mode !== 'play' && state.mode !== 'demo') continue;
      const n = 2;
      for (let k = 0; k < n; k++) physicsStep(dt / n);
      input.jumpBuf = Math.max(0, input.jumpBuf - dt);
      logic(dt);
    }
  },
};
