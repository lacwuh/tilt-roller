import * as THREE from 'three';
import { Vehicle, SPECS, makeTyreTexture } from './vehicles.js?v=21';

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
let HW = 4;              // half width of the road (wider in race mode)
const BALL_HW = 4, RACE_HW = 5;
const DEG = Math.PI / 180;
const JUMP_V = 17;
const BOUNCE_E = 0.42, BOUNCE_MIN = 9;
const KICK = { max: 2, recharge: 2.0, fwd: 10 };   // rechargeable jump kick: charges, seconds per charge, forward burst
const TIME_SCALE = 1.45; // game time runs faster than real time: snappier rolling, falling and jumping
const STEER_ACC = 26;
const K = { NORMAL: 0, BOOST: 1, KICK: 2, LOOP: 3, HELIX: 4, FINISH: 5, START: 6, RING: 7, WATER: 8 };

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = t => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const params = new URLSearchParams(location.search);

// half-pipe edges: past the flat road (|x| > HW) the surface curves up along a circle of radius
// PIPE.R to a lip; the outside of banked curves gets a taller, nearly vertical wall
const PIPE = { R: 3.5, ang: 76 * DEG, angOuter: 88 * DEG };
function pipeMaxAng(sm, side) { const b = sm.berm * side; return b > 0.3 ? lerp(PIPE.ang, PIPE.angOuter, clamp(b, 0, 1)) : PIPE.ang; }
function lipX(sm, side) { return HW + PIPE.R * Math.sin(pipeMaxAng(sm, side)); }
const SURF = { h: 0, th: 0 };
// surface height and slope angle at lateral position x (null beyond the lip: nothing to stand on)
function surfAt(x, sm) {
  const side = x < 0 ? -1 : 1, u = Math.abs(x) - HW;
  if (u <= 0) { SURF.h = 0; SURF.th = 0; return SURF; }
  const amax = pipeMaxAng(sm, side);
  if (u > PIPE.R * Math.sin(amax) + 1e-6) return null;
  const phi = Math.asin(Math.min(1, u / PIPE.R));
  SURF.h = PIPE.R * (1 - Math.cos(phi)); SURF.th = side * phi;
  return SURF;
}

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
function generateTrack(seed, level, race = false) {
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
    wet: o.wet || 0, water: 0,   // wet: slippery rain-soaked surface; water: depth of standing water
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
  function curve(ang, rad, pA = 0, wet = false) {
    const h0 = h, p0 = p, L = Math.abs(ang) * rad, sW = len();
    const b0 = Math.sign(ang) * Math.min(35 * DEG, Math.atan(vt * vt * 1.5 / (rad * G)) * 0.8);
    run(L, t => {
      const e = 4 * t * (1 - t);
      return { h: h0 + ang * smooth(t), p: p0 + pA * Math.sin(2 * Math.PI * t), bank: b0 * e, berm: Math.sign(ang) * Math.min(1, e * 3), wet: wet ? 1 : 0 };
    });
    p = p0;
    if (wet) features.push({ type: 'wet', s0: sW, s1: len() });
  }
  const chooseDir = () => (h > 25 * DEG ? -1 : h < -25 * DEG ? 1 : rnd() < 0.5 ? -1 : 1);
  function turn() {
    const d = chooseDir();
    let a = R(35, 75) * DEG;
    a = Math.max(15 * DEG, Math.min(a, 65 * DEG - d * h));
    curve(d * a, R(75, 115), 0, rnd() < 0.35);
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
  function rollers() { const n = 3 + Math.floor(rnd() * 3); for (let i = 0; i < n; i++) hill(R(12, 24) * DEG, R(36, 60)); }
  // long climb to a crest, over the top and down a steep descent
  function mountain() {
    const A = R(14, 22) * DEG, D2 = R(18, 30) * DEG, p0 = p;
    run(R(20, 30), t => ({ p: p0 + A * smooth(t) }));
    straight(R(30, 70));
    run(R(30, 45), t => ({ p: p0 + A - (A + D2) * smooth(t) }));
    straight(R(25, 55));
    run(R(25, 35), t => ({ p: p0 - D2 + D2 * smooth(t) }));
    p = p0;
  }
  // dive into a valley and climb out the other side
  // long downhill run: gravity builds speed all the way down
  function descent() {
    const A = R(11, 17) * DEG, p0 = p;
    run(30, t => ({ p: p0 - A * smooth(t) }));
    straight(R(70, 130));
    if (rnd() < 0.6) turn();
    straight(R(70, 130));
    run(45, t => ({ p: p0 - A + A * smooth(t) }));
    p = p0;
  }
  // stream crossing: the road dips into a shallow ford with a flat bed
  function ford() {
    cp(); straight(30);
    const A = 5 * DEG, p0 = p, i0 = smp.length - 1;
    run(28, t => ({ p: p0 - A * Math.sin(Math.PI * t), kind: K.WATER }));
    const iA = smp.length - 1;
    run(R(95, 150), () => ({ kind: K.WATER }));
    const iB = smp.length - 1;
    run(28, t => ({ p: p0 + A * Math.sin(Math.PI * t), kind: K.WATER }));
    p = p0;
    features.push({ type: 'ford', i0, i1: smp.length - 1, iMid: (iA + iB) >> 1, s0: iA * DS, s1: iB * DS, side: rnd() < 0.5 ? -1 : 1 });
    straight(30); cp();
  }
  // 0 -> 1 with a constant gradient and short eased ends
  const rampEase = t => { const a = 0.08; return t < a ? t * t / (2 * a * (1 - a)) : t > 1 - a ? 1 - (1 - t) * (1 - t) / (2 * a * (1 - a)) : (t - a / 2) / (1 - a); };
  // long sweeping spiral, one or two full turns, climbing or descending: made for holding a drift
  function sweeper() {
    cp();
    const Rs = R(50, 64), turns = rnd() < 0.4 ? 2 : 1, d = h > 15 * DEG ? -1 : h < -15 * DEG ? 1 : rnd() < 0.5 ? -1 : 1;
    const rise = (rnd() < 0.5 ? -1 : 1) * R(30, 38) * turns;   // 30-38 up or down per full turn
    const L = 2 * Math.PI * Rs * turns, h0 = h, b0 = d * 14 * DEG;
    const s0 = len(), wet = rnd() < 0.3; let prev = 0;
    run(L, t => {
      const sm = rampEase(t); const off = new V3(0, rise * (sm - prev), 0); prev = sm;
      const e = smooth(Math.min(1, t / 0.05, (1 - t) / 0.05));
      return { h: h0 + d * 2 * Math.PI * turns * t, off, bank: b0 * e, berm: d, kind: K.HELIX, wet: wet ? 1 : 0 };
    });
    h = h0;
    features.push({ type: 'loop', s0, s1: len(), name: 'SWEEPER!' });
    if (wet) features.push({ type: 'wet', s0, s1: len() });
    straight(40); cp();
  }
  function valley() {
    const A = R(16, 26) * DEG, p0 = p;
    run(R(20, 30), t => ({ p: p0 - A * smooth(t) }));
    straight(R(20, 45));
    run(R(30, 45), t => ({ p: p0 - A + 2 * A * smooth(t) }));
    straight(R(20, 45));
    run(R(20, 30), t => ({ p: p0 + A - A * smooth(t) }));
    p = p0;
  }
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
    curve(d * a, R(80, 115), R(10, 18) * DEG * (rnd() < 0.5 ? 1 : -1), rnd() < 0.3);
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
    const s0 = len() + 30, Lg = R(8, 11) + vt * 0.3 + Math.min(level, 6) * 0.6;
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
    const D = side * (2 * (HW + PIPE.R + 0.6) + 1.5);
    const s0 = len(); let prev = 0;
    run(L, t => {
      const sm = smooth(t); const off = Bv.clone().multiplyScalar(D * (sm - prev)); prev = sm;
      return { p: p0 + 2 * Math.PI * t, off, noDetach: true, minV: 24, kind: K.LOOP };
    });
    p = p0;
    features.push({ type: 'loop', s0, s1: len(), name: 'LOOP!' });
    straight(30); cp();
  }

  // horizontal 360: a tight banked spiral that dives under (or climbs over) its own entry
  function helix() {
    cp(); booster(24, vt + 4, vt - 2);
    const Rh = R(36, 42), d = h > 15 * DEG ? -1 : h < -15 * DEG ? 1 : rnd() < 0.5 ? -1 : 1;
    const L = 2 * Math.PI * Rh, h0 = h, rise = (rnd() < 0.5 ? -1 : 1) * R(22, 28);
    const b0 = d * Math.min(36 * DEG, Math.atan(vt * vt / (Rh * G)));
    const s0 = len(); let prev = 0;
    run(L, t => {
      const sm = rampEase(t); const off = new V3(0, rise * (sm - prev), 0); prev = sm;
      const e = smooth(Math.min(1, t / 0.08, (1 - t) / 0.08));
      return { h: h0 + d * 2 * Math.PI * t, off, bank: b0 * e, berm: d, minV: 20, kind: K.HELIX };
    });
    h = h0;
    features.push({ type: 'loop', s0, s1: len(), name: 'SPIRAL!' });
    straight(45); cp();
  }

  straight(race ? 75 : 30, { kind: K.START }); cp();
  const kicker = () => { straight(35); jump(true); };
  const conns = [turn, scurve, bumps, camber, rollers, rollers, bigDrop, bigDrop, mountain, mountain, valley, valley, kicker, kicker, climb, twistHill, twistHill, descent, descent, ford, () => downhill(R(12, 22) * DEG, R(50, 80))];
  const specials = race ? ['vloop', 'helix', 'jump', 'jump', 'jump', 'pit', 'pit', 'sweeper', 'ford'] : ['vloop', 'helix', 'ring', 'ring', 'jump', 'jump', 'jump', 'pit', 'pit', 'sweeper', 'ford'];
  for (let i = 0; i < Math.min(level - 1, 8); i++) specials.push(pick(race ? ['jump', 'vloop', 'helix', 'jump', 'pit'] : ['ring', 'jump', 'vloop', 'helix', 'ring', 'jump', 'pit', 'pit']));
  for (let i = specials.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [specials[i], specials[j]] = [specials[j], specials[i]]; }
  const fns = { vloop, helix, ring: ringFire, jump: () => jump(false), pit, sweeper, ford };
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
  // fords: the water surface is level, 0.32 above the flat bed; store the depth per sample
  for (const f of features) if (f.type === 'ford') {
    f.level = P[f.iMid].y + 0.32;
    let a = f.i1, b2 = f.i0;
    for (let i = f.i0; i <= f.i1; i++) { const d = f.level - P[i].y; if (d > 0.02) { smp[i].water = d; a = Math.min(a, i); b2 = Math.max(b2, i); } }
    f.s0 = a * DS; f.s1 = b2 * DS;
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
  ford: new THREE.Color('#2b7f8f'),
  road: new THREE.Color('#3346a8'), boost: new THREE.Color('#14a7bd'), kick: new THREE.Color('#e07a2e'),
  loop: new THREE.Color('#8a3fd1'), finish: new THREE.Color('#2a9d5c'), red: new THREE.Color('#ff3355'),
  white: new THREE.Color('#f2f2f2'), side: new THREE.Color('#2a1f5c'), bottom: new THREE.Color('#1a1238'),
};
const tmpC = new THREE.Color();
function roadColor(sm, i) {
  const base = sm.kind === K.BOOST ? COL.boost : sm.kind === K.KICK ? COL.kick
    : (sm.kind === K.LOOP || sm.kind === K.HELIX) ? COL.loop : sm.kind === K.FINISH ? COL.finish : sm.kind === K.WATER ? COL.ford : COL.road;
  return tmpC.copy(base).multiplyScalar((Math.floor(i * DS / 3) % 2 ? 0.86 : 1) * (sm.wet ? 0.72 : 1));
}
// ---- half-pipe cross-section: flat road of half width HW, then circular walls of radius PIPE.R
// rising to a lip; the outside of banked curves gets a taller, nearly vertical wall.
const PIPE_SEGS = 6;
function crossSection(sm) {
  const R = PIPE.R, top = [];
  const aL = pipeMaxAng(sm, -1), aR = pipeMaxAng(sm, 1);
  const xl = HW + R * Math.sin(aL), hl = R * (1 - Math.cos(aL));
  const xr = HW + R * Math.sin(aR), hr = R * (1 - Math.cos(aR));
  top.push([-(xl + 0.5), hl]);
  for (let k = PIPE_SEGS; k >= 0; k--) { const a = aL * k / PIPE_SEGS; top.push([-(HW + R * Math.sin(a)), R * (1 - Math.cos(a))]); }
  top.push([0, 0]);
  for (let k = 0; k <= PIPE_SEGS; k++) { const a = aR * k / PIPE_SEGS; top.push([HW + R * Math.sin(a), R * (1 - Math.cos(a))]); }
  top.push([xr + 0.5, hr]);
  return top;
}
const PIPE_TOP = new THREE.Color('#8fa0ff');
function topColor(j, n, sm, i) {
  const mid = (n - 1) / 2;                       // index of the road centre point
  const k = Math.abs(j - mid);                   // 0 centre, 1 road edge, 2.. pipe, last two lip
  if (k >= mid - 1) return (Math.floor(i * DS / 1.5) % 2 ? COL.red : COL.white);
  const c = roadColor(sm, i).clone();
  if (k <= 1) return c;
  return c.lerp(PIPE_TOP, 0.12 + 0.5 * (k - 1) / (mid - 2));
}

function buildTrackMesh(tr) {
  const rows = []; for (let i = 0; i < tr.N; i += 2) rows.push(i);
  if (rows[rows.length - 1] !== tr.N - 1) rows.push(tr.N - 1);
  const segSolid = [];
  for (let r = 0; r < rows.length - 1; r++) {
    let ok = true; for (let k = rows[r]; k <= rows[r + 1]; k++) if (!tr.smp[k].solid) { ok = false; break; }
    segSolid.push(ok);
  }
  const NT = 2 * PIPE_SEGS + 5, NV = NT + 6, BOT = -0.8;
  const pos = [], col = [], idx = [];
  const put = (i, x, y, c) => {
    const P = tr.P[i], B = tr.B[i], U = tr.U[i];
    pos.push(P.x + B.x * x + U.x * y, P.y + B.y * x + U.y * y, P.z + B.z * x + U.z * y);
    col.push(c.r, c.g, c.b);
  };
  const tops = [];
  for (let r = 0; r < rows.length; r++) {
    const i = rows[r], sm = tr.smp[i], top = crossSection(sm);
    tops.push(top);
    top.forEach((p, j) => put(i, p[0], p[1], topColor(j, NT, sm, i)));
    const L = top[0], Rr = top[NT - 1];
    put(i, Rr[0], Rr[1], COL.side); put(i, Rr[0], BOT, COL.side);
    put(i, Rr[0], BOT, COL.bottom); put(i, L[0], BOT, COL.bottom);
    put(i, L[0], BOT, COL.side); put(i, L[0], L[1], COL.side);
  }
  const quad = (a, b, c, d) => idx.push(a, c, b, b, c, d);
  for (let r = 0; r < rows.length - 1; r++) {
    if (!segSolid[r]) continue;
    const o0 = r * NV, o1 = (r + 1) * NV;
    for (let j = 0; j < NT - 1; j++) quad(o0 + j, o0 + j + 1, o1 + j, o1 + j + 1);
    for (let j = NT; j < NV; j += 2) quad(o0 + j, o0 + j + 1, o1 + j, o1 + j + 1);
  }
  // end caps where the road stops (gaps, start, end): vertical slices under the top profile
  const cap = (r) => {
    const i = rows[r], top = tops[r];
    for (let j = 0; j < NT - 1; j++) {
      const base = pos.length / 3;
      put(i, top[j][0], top[j][1], COL.side); put(i, top[j + 1][0], top[j + 1][1], COL.side);
      put(i, top[j][0], BOT, COL.side); put(i, top[j + 1][0], BOT, COL.side);
      quad(base, base + 1, base + 2, base + 3);
    }
  };
  for (let r = 0; r < rows.length - 1; r++) {
    if (!segSolid[r]) continue;
    if (r === 0 || !segSolid[r - 1]) cap(r);
    if (r === rows.length - 2 || !segSolid[r + 1]) cap(r + 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
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

// ============================================================================
// Clouds: clusters of soft camera-facing puffs. Each puff is one quad whose edge is eroded
// by tiling fractal noise and which is shaded lighter towards the world's "up"; overlapping
// puffs blend into a billowy, volumetric-looking cloud for the cost of a few sprites.
// ============================================================================
function makeNoiseTexture(N = 128) {
  const rnd = mulberry32(90210), data = new Uint8Array(N * N * 4);
  const octs = [4, 8, 16, 32].map(gr => { const a = new Float32Array(gr * gr); for (let i = 0; i < a.length; i++) a[i] = rnd(); return { gr, a }; });
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let v = 0, amp = 0.5, tot = 0;
    for (const { gr, a } of octs) {
      const fx = x / N * gr, fy = y / N * gr, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = smooth(fx - x0), ty = smooth(fy - y0);
      const x1 = (x0 + 1) % gr, y1 = (y0 + 1) % gr;   // wraps, so the texture tiles
      v += lerp(lerp(a[y0 * gr + x0], a[y0 * gr + x1], tx), lerp(a[y1 * gr + x0], a[y1 * gr + x1], tx), ty) * amp;
      tot += amp; amp *= 0.5;
    }
    const k = (y * N + x) * 4;
    data[k] = data[k + 1] = data[k + 2] = Math.round(v / tot * 255); data[k + 3] = 255;
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = t.minFilter = THREE.LinearFilter; t.needsUpdate = true;
  return t;
}
const cloudUniforms = {
  uNoise: { value: makeNoiseTexture() }, uTime: { value: 0 },
  uLight: { value: new THREE.Color('#fff6ee') }, uShade: { value: new THREE.Color('#a886c4') },
  uRainLight: { value: new THREE.Color('#8f96b8') }, uRainShade: { value: new THREE.Color('#2e3158') },
  uFogColor: { value: new THREE.Color() }, uFogNear: { value: 160 }, uFogFar: { value: 700 },
  uFlash: { value: 0 }, uFlashPos: { value: new V3() },   // lightning inside the storm clouds
};
const CLOUD_VS = `attribute vec3 aCenter; attribute vec4 aParams;   // params: size, seed, tone, rain
  varying vec2 vUv; varying vec4 vP; varying float vDepth; varying vec2 vUp; varying vec3 vCenter;
  void main(){
    vUv = uv; vP = aParams; vCenter = aCenter;
    vec4 mv = modelViewMatrix * vec4(aCenter, 1.0);
    mv.xy += position.xy * aParams.x;
    vDepth = -mv.z;
    vUp = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xy + vec2(0.0, 1e-4));   // world up on screen
    gl_Position = projectionMatrix * mv;
  }`;
const CLOUD_FS = `uniform sampler2D uNoise; uniform float uTime, uFogNear, uFogFar;
  uniform vec3 uLight, uShade, uRainLight, uRainShade, uFogColor, uFlashPos; uniform float uFlash;
  varying vec2 vUv; varying vec4 vP; varying float vDepth; varying vec2 vUp; varying vec3 vCenter;
  void main(){
    vec2 p = vUv - 0.5;
    float d = 1.0 - length(p) * 2.0;
    if (d <= 0.0) discard;
    vec2 q = vUv * 0.55 + vP.y * vec2(0.37, 0.61);
    float n = texture2D(uNoise, q + vec2(uTime * 0.005, 0.0)).r * 0.6 + texture2D(uNoise, q * 2.7 - vec2(0.0, uTime * 0.01)).r * 0.4;
    float a = smoothstep(0.05, 0.5, d * 1.1 + (n - 0.5) * 1.9) * smoothstep(0.0, 0.18, d);   // noise carves lumps into the outline
    a *= smoothstep(2.0, 16.0, vDepth);                                                  // fade when the camera flies through
    if (a < 0.01) discard;
    float lit = clamp(0.5 + dot(p, vUp) * 1.1 + (n - 0.5) * 0.7, 0.0, 1.0);             // lighter on top, darker in the folds
    vec3 c = mix(mix(uShade, uLight, lit), mix(uRainShade, uRainLight, lit), vP.w) * vP.z;
    float fl = uFlash * vP.w * (1.0 - smoothstep(8.0, 80.0, distance(vCenter, uFlashPos)));   // lit from inside by lightning
    c += vec3(0.75, 0.85, 1.4) * fl * (0.35 + n * 1.3);
    c = mix(c, uFogColor, smoothstep(uFogNear, uFogFar, vDepth) * 0.85);
    gl_FragColor = vec4(c, a * 0.92);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;
let cloudFx = null;
function buildClouds(list) {
  const n = list.length, geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const centers = new Float32Array(n * 3), params = new Float32Array(n * 4);
  const aC = new THREE.InstancedBufferAttribute(centers, 3).setUsage(THREE.DynamicDrawUsage);
  const aP = new THREE.InstancedBufferAttribute(params, 4).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aCenter', aC); geo.setAttribute('aParams', aP);
  geo.instanceCount = n;
  const mat = new THREE.ShaderMaterial({ uniforms: cloudUniforms, vertexShader: CLOUD_VS, fragmentShader: CLOUD_FS, transparent: true, depthWrite: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false; mesh.renderOrder = -0.5;
  cloudFx = { mesh, list, centers, params, aC, aP, tick: 0, order: list.map((_, i) => i), dist: new Float32Array(n) };
  sortClouds(true);
  return mesh;
}
// transparent puffs must be drawn far-to-near; re-sorting every few frames is plenty
function sortClouds(force) {
  const c = cloudFx; if (!c) return;
  if (!force && (c.tick++ % 20) !== 0) return;
  const cp = camera.position, L = c.list;
  for (let i = 0; i < L.length; i++) { const p = L[i]; c.dist[i] = (p[0] - cp.x) ** 2 + (p[1] - cp.y) ** 2 + (p[2] - cp.z) ** 2; }
  c.order.sort((a, b) => c.dist[b] - c.dist[a]);
  for (let k = 0; k < L.length; k++) {
    const p = L[c.order[k]];
    c.centers[k * 3] = p[0]; c.centers[k * 3 + 1] = p[1]; c.centers[k * 3 + 2] = p[2];
    c.params[k * 4] = p[3]; c.params[k * 4 + 1] = p[4]; c.params[k * 4 + 2] = p[5]; c.params[k * 4 + 3] = p[6];
  }
  c.aC.needsUpdate = true; c.aP.needsUpdate = true;
}
function updateClouds(dt) {
  cloudUniforms.uTime.value += dt;
  cloudUniforms.uFogColor.value.copy(scene.fog.color);
  cloudUniforms.uFogNear.value = scene.fog.near; cloudUniforms.uFogFar.value = scene.fog.far;
  sortClouds(false);
}

let flagGeos = [];
let waterTex = [];   // animated water textures of the current world
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
      const top = f.hgt + f.r + 0.3, span = HW + PIPE.R + 0.9;
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
    post.position.copy(F.P).addScaledVector(F.B, sd * (HW + PIPE.R + 1.2)).addScaledVector(F.U, 4.5); post.quaternion.copy(archQ); post.castShadow = true; g.add(post);
  }
  const banner = new THREE.Mesh(new THREE.BoxGeometry((HW + PIPE.R) * 2 + 3.4, 2, 0.35), new THREE.MeshStandardMaterial({ map: bannerTex, roughness: 0.4 }));
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
      grp.position.copy(F.P).addScaledVector(F.B, sd * (HW + PIPE.R + 1.4));
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 5.5, 6), poleMat);
      pole.position.y = 2.75; pole.castShadow = true; grp.add(pole);
      const flag = new THREE.Mesh(flagGeos[fc % 3], new THREE.MeshStandardMaterial({ color: flagCols[fc % flagCols.length], side: THREE.DoubleSide, roughness: 0.6 }));
      flag.position.set(0.05, 4.7, 0); flag.castShadow = true; grp.add(flag);
      g.add(grp); fc++;
    }
  }

  // ---- water: fords with a waterfall, wet turns with a glossy film, rain clouds above both
  waterTex = [];
  const mkWaterTex = () => {
    const t = canvasTex(256, 256, (x, w, h) => {
      x.fillStyle = '#2f9fe8'; x.fillRect(0, 0, w, h);
      x.lineCap = 'round';
      for (let k = 0; k < 46; k++) {
        const y = Math.random() * h, x0 = Math.random() * w, L2 = 30 + Math.random() * 90;
        x.strokeStyle = `rgba(255,255,255,${0.15 + Math.random() * 0.45})`; x.lineWidth = 1 + Math.random() * 3;
        for (const o of [0, -w]) { x.beginPath(); x.moveTo(x0 + o, y); x.bezierCurveTo(x0 + o + L2 * 0.3, y - 6, x0 + o + L2 * 0.6, y + 6, x0 + o + L2, y); x.stroke(); }
      }
    });
    t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
  };
  const rainPuffs = [];
  const puffCluster = (c, n, size) => { for (let k = 0; k < n; k++) rainPuffs.push([c.x + (Math.random() - 0.5) * size * 3.6, c.y + (Math.random() - 0.5) * size * 0.6, c.z + (Math.random() - 0.5) * size * 3.6, size * (0.6 + Math.random() * 0.8)]); };
  const UP = new V3(0, 1, 0);
  for (const f of tr.features) if (f.type === 'ford') {
    // the pool: a level sheet whose edge follows the shoreline on the half-pipe walls
    const pos = [], uv = [], idx = []; let n = 0;
    for (let i = f.i0; i <= f.i1; i++) {
      const d = tr.smp[i].water; if (!(d > 0)) continue;
      const w = HW + Math.sqrt(Math.max(0, 2 * PIPE.R * d - d * d));
      const P = tr.P[i], B = tr.B[i];
      for (const sd of [-1, 1]) { pos.push(P.x + B.x * sd * w, f.level, P.z + B.z * sd * w); uv.push(sd * w / 9, i * DS / 9); }
      if (n > 0) { const a = (n - 1) * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
      n++;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx); geo.computeVertexNormals();
    const tex = mkWaterTex(); waterTex.push({ tex, vx: 0.22 * f.side, vy: 0.03 });
    const pool = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, transparent: true, opacity: 0.82, roughness: 0.08, metalness: 0.05, envMapIntensity: 0.7, emissive: '#1668b0', emissiveIntensity: 0.55, side: THREE.DoubleSide, depthWrite: false }));
    pool.renderOrder = 1; g.add(pool);
    // the waterfall feeding it, pouring from a rain cloud above one side
    frameAtT(tr, f.iMid * DS, F);
    const H = 13, lat = f.side * (HW + 0.8);
    f.Pm = F.P.clone(); f.T = F.T.clone(); f.B = F.B.clone();
    f.fallBase = F.P.clone().addScaledVector(F.B, lat); f.fallBase.y = f.level;
    const tex2 = mkWaterTex(); waterTex.push({ tex: tex2, vx: 1.6, vy: 0 });
    const fallMat = new THREE.MeshStandardMaterial({ map: tex2, transparent: true, opacity: 0.75, roughness: 0.1, metalness: 0.2, envMapIntensity: 1.4, side: THREE.DoubleSide, depthWrite: false, emissive: '#3a86c8', emissiveIntensity: 0.25 });
    for (const [wd, ax] of [[6, F.T], [2.6, F.B]]) {
      const pg = new THREE.PlaneGeometry(wd, H);
      const a = pg.attributes.uv; for (let k = 0; k < a.count; k++) a.setXY(k, a.getY(k) * 2.2, a.getX(k) * wd / 6);   // streaks run vertically
      const fall = new THREE.Mesh(pg, fallMat);
      fall.position.copy(f.fallBase).addScaledVector(UP, H / 2);
      fall.quaternion.copy(basis(ax, UP, new V3().crossVectors(ax, UP)));
      fall.renderOrder = 1; g.add(fall);
    }
    puffCluster(f.fallBase.clone().addScaledVector(UP, H + 0.6), 10, 5);
  }
  const curtains = [];   // sample indices where a rain curtain hangs across the road
  const sheenMat = new THREE.MeshStandardMaterial({ color: '#0a1838', transparent: true, opacity: 0.5, roughness: 0.03, metalness: 0.95, envMapIntensity: 2.2, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  for (const f of tr.features) if (f.type === 'wet') {
    // a mirror-like film of water over the road and the foot of the walls
    const i0 = Math.round(f.s0 / DS), i1 = Math.round(f.s1 / DS), u1 = 1.6;
    const hw = PIPE.R * (1 - Math.cos(Math.asin(u1 / PIPE.R)));
    const xs = [[-(HW + u1), hw], [-HW, 0], [0, 0], [HW, 0], [HW + u1, hw]];
    const pos = [], idx = []; let n = 0;
    for (let i = i0; i <= i1; i += 2) {
      const P = tr.P[i], B = tr.B[i], U = tr.U[i];
      for (const [x, h] of xs) pos.push(P.x + B.x * x + U.x * (h + 0.04), P.y + B.y * x + U.y * (h + 0.04), P.z + B.z * x + U.z * (h + 0.04));
      if (n > 0) for (let j = 0; j < 4; j++) { const a = (n - 1) * 5 + j, b = n * 5 + j; idx.push(a, b, a + 1, a + 1, b, b + 1); }
      n++;
      if ((i - i0) % 44 === 0) puffCluster(new V3(P.x, P.y + 19 + Math.random() * 4, P.z).addScaledVector(B, (Math.random() - 0.5) * 14), 7, 6);
      if ((i - i0) % 36 === 0) curtains.push(i);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx); geo.computeVertexNormals();
    const film = new THREE.Mesh(geo, sheenMat); film.renderOrder = 1; g.add(film);
  }
  if (curtains.length) {
    // rain curtains: tall translucent sheets hanging from the storm clouds across the road
    const cm = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({ uniforms: stormUniforms, vertexShader: CURTAIN_VS, fragmentShader: CURTAIN_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide }), curtains.length);
    const mm = new THREE.Matrix4(), W = (HW + PIPE.R) * 2 + 12, H = 21, ax = new V3(), az = new V3(), pp = new V3();
    curtains.forEach((i, k) => {
      const yaw = (Math.random() - 0.5) * 0.7;
      ax.copy(tr.B[i]); ax.y = 0; ax.normalize().applyAxisAngle(UP, yaw);
      az.crossVectors(ax, UP);
      pp.copy(tr.P[i]).addScaledVector(UP, H / 2 - 1).addScaledVector(ax, (Math.random() - 0.5) * 6);
      mm.makeBasis(ax, UP, az).scale(new V3(W, H, 1)).setPosition(pp);
      cm.setMatrixAt(k, mm);
    });
    cm.frustumCulled = false; cm.renderOrder = 0.5; g.add(cm);
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

  // ---- clouds: each is a cluster of soft puffs [x, y, z, size, seed, tone, rain]
  const rnd = mulberry32(tr.seed ^ 0x9e3779b9);
  const puffs = [];
  for (let c = 0; c < 70; c++) {
    const i = Math.floor(rnd() * tr.N), base = tr.P[i];
    const side = rnd() < 0.5 ? -1 : 1, dist = 55 + rnd() * 230;
    const lat = new V3(tr.T[i].z, 0, -tr.T[i].x).normalize().multiplyScalar(side * dist);
    const cen = base.clone().add(lat); cen.y += -55 + rnd() * 80;
    let ok = true;
    for (let k = 0; k < tr.N; k += 20) if (tr.P[k].distanceToSquared(cen) < 46 * 46) { ok = false; break; }
    if (!ok) continue;
    const sc = 0.8 + rnd() * 0.9, tone = 0.94 + rnd() * 0.1;
    const nb = 4 + Math.floor(rnd() * 3), nt = 2 + Math.floor(rnd() * 3);
    // a wide flat base of big puffs with smaller ones heaped on top
    for (let k = 0; k < nb; k++) puffs.push([cen.x + (rnd() - 0.5) * 34 * sc, cen.y + (rnd() - 0.5) * 3 * sc, cen.z + (rnd() - 0.5) * 34 * sc, (17 + rnd() * 11) * sc, rnd() * 10, tone, 0]);
    for (let k = 0; k < nt; k++) puffs.push([cen.x + (rnd() - 0.5) * 13 * sc, cen.y + (4 + rnd() * 5) * sc, cen.z + (rnd() - 0.5) * 13 * sc, (11 + rnd() * 6) * sc, rnd() * 10, tone * 1.04, 0]);
  }
  for (const pf of rainPuffs) puffs.push([pf[0], pf[1], pf[2], pf[3] * 3.4, Math.random() * 10, 1, 1]);
  g.add(buildClouds(puffs));

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
  fx.clear(); confetti.clear(); smoke.clear();
}

// ============================================================================
// Audio (tiny WebAudio synth)
// ============================================================================
let engine = null;
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
    {
      const osc = actx.createOscillator(), f = actx.createBiquadFilter(), gain = actx.createGain();
      osc.type = 'sawtooth'; osc.frequency.value = 50; f.type = 'lowpass'; f.frequency.value = 500; gain.gain.value = 0;
      osc.connect(f); f.connect(gain); gain.connect(master); osc.start();
      engine = { osc, gain };
    }
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
  splash: () => { noise(0.55, 1500, 0.5, 'bandpass'); noise(0.4, 350, 0.45); },
  kick: () => { tone(320, 720, 0.18, 'square', 0.08); noise(0.35, 500, 0.35, 'lowpass'); tone(90, 220, 0.3, 'sawtooth', 0.08); },
  empty: () => tone(180, 140, 0.08, 'square', 0.05),
  turbo: () => { tone(300, 1200, 0.45, 'sawtooth', 0.06); noise(0.4, 1800, 0.25, 'bandpass'); },
  takedown: () => [392, 523, 659].forEach((f, i) => tone(f, f * 1.5, 0.18, 'square', 0.08, i * 0.07)),
  land: v => noise(0.18, 260, Math.min(0.6, v / 30)),
  ring: () => { tone(500, 1300, 0.35, 'sawtooth', 0.07); tone(750, 1600, 0.4, 'triangle', 0.09); },
  burn: () => noise(0.7, 1400, 0.45, 'bandpass'),
  boost: () => tone(200, 900, 0.3, 'sawtooth', 0.05),
  fall: () => tone(700, 70, 0.9, 'triangle', 0.18),
  loop: () => { tone(520, 1040, 0.15, 'square', 0.06); tone(780, 1560, 0.2, 'square', 0.05, 0.1); },
  finish: () => [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(f, f, 0.22, 'square', 0.08, i * 0.12)),
  count: hi => tone(hi ? 880 : 440, hi ? 880 : 440, 0.18, 'square', 0.08),
  quake: () => noise(1.2, 70, 0.8),
  thunder: v => { noise(1.9, 80, 0.9 * v); noise(0.7, 260, 0.5 * v); if (v > 0.7) noise(0.16, 2200, 0.35 * v, 'highpass'); },
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
    input.jumpPow = clamp(0.8 + (jolt - SHAKE_T) / 30, 0.8, 1.1);
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
// keyboard (desktop testing): left/right arrows or A/D steer, Space / up / W jumps;
// on the start and result screens Enter or Space presses the main button
window.addEventListener('keydown', e => {
  const k = e.code;
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'].includes(k)) e.preventDefault();
  if (e.repeat) return;
  if (!overlay.classList.contains('hidden') && (k === 'Enter' || k === 'Space')) { ovBtn.click(); return; }
  if (k === 'ArrowLeft' || k === 'KeyA') { input.keyL = true; input.keyLt = performance.now(); }
  if (k === 'ArrowRight' || k === 'KeyD') { input.keyR = true; input.keyRt = performance.now(); }
  if (k === 'Space' || k === 'ArrowUp' || k === 'KeyW') { input.jumpBuf = 0.15; input.jumpPow = 1; }
});
window.addEventListener('keyup', e => {
  if (e.code === 'ArrowLeft' || e.code === 'KeyA') input.keyL = false;
  if (e.code === 'ArrowRight' || e.code === 'KeyD') input.keyR = false;
});
// like touch: a tap nudges, holding ramps up to full lock (and a drift) over ~half a second
function keySteer() {
  const now = performance.now(), ramp = t => Math.min(1, 0.3 + (now - t) / 500);
  return (input.keyR ? ramp(input.keyRt) : 0) - (input.keyL ? ramp(input.keyLt) : 0);
}
const touches = new Map(); // id -> {x0, y0, zone, swiped}
function touchZone(x) { const w = innerWidth; return x < w * 0.36 ? -1 : x > w * 0.64 ? 1 : 0; }
canvas.addEventListener('touchstart', e => {
  e.preventDefault();
  for (const t of e.changedTouches) {
    const zone = touchZone(t.clientX);
    touches.set(t.identifier, { x0: t.clientX, y0: t.clientY, zone, swiped: false, t0: performance.now() });
    if (zone === 0) { input.jumpBuf = 0.15; input.jumpPow = 1; }
  }
}, { passive: false });
canvas.addEventListener('touchmove', e => {
  for (const t of e.changedTouches) {
    const d = touches.get(t.identifier);
    if (d && !d.swiped && d.y0 - t.clientY > 40) { d.swiped = true; input.jumpBuf = 0.15; input.jumpPow = 1.2; }
  }
}, { passive: false });
const endTouch = e => { for (const t of e.changedTouches) touches.delete(t.identifier); };
canvas.addEventListener('touchend', endTouch); canvas.addEventListener('touchcancel', endTouch);
// a quick tap nudges, holding ramps up to full lock over ~half a second
// on-screen buttons (phones): steer left/right in the bottom corners, a JUMP button beside each
const pad = { L: 0, R: 0 };   // press time of each steering button, 0 = released
const padEl = document.getElementById('pad');
const IS_TOUCH = 'ontouchstart' in window || params.has('pad');
if (IS_TOUCH) { padEl.classList.remove('hidden'); document.body.classList.add('touch'); }
for (const b of padEl.querySelectorAll('.pb')) {
  const k = b.dataset.k;
  const down = e => { e.preventDefault(); b.classList.add('on'); if (k === 'J') { input.jumpBuf = 0.15; input.jumpPow = 1; } else pad[k] = performance.now(); };
  const up = e => { e.preventDefault(); b.classList.remove('on'); if (k !== 'J') pad[k] = 0; };
  b.addEventListener('touchstart', down, { passive: false });
  b.addEventListener('touchend', up, { passive: false }); b.addEventListener('touchcancel', up, { passive: false });
  b.addEventListener('mousedown', down); b.addEventListener('mouseup', up); b.addEventListener('mouseleave', up);
}
// like the keys: a tap nudges, holding ramps up to full lock over ~half a second
function padSteer() { const now = performance.now(), ramp = t => Math.min(1, 0.3 + (now - t) / 500); return (pad.R ? ramp(pad.R) : 0) - (pad.L ? ramp(pad.L) : 0); }
function touchSteer() { const now = performance.now(); let v = 0; for (const d of touches.values()) if (!d.swiped) v += d.zone * Math.min(1, 0.3 + (now - d.t0) / 500); return clamp(v, -1, 1); }
canvas.addEventListener('mousedown', () => { input.jumpBuf = 0.15; });
document.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
document.getElementById('invert').addEventListener('change', e => { input.invert = e.target.checked; });

function readInput(dt) {
  let target = 0, rollT = 0;
  if (state.mode === 'demo') target = autopilot();
  else if (input.keyL || input.keyR) target = keySteer();
  else if (touchSteer() !== 0 || padSteer() !== 0) target = clamp(touchSteer() + padSteer(), -1, 1);
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
const isRace = () => state.gameMode === 'race' && vehicles.length > 0;
const kick = { charge: 2 };   // fractional: 1.6 means one ready jump and the next 60% recharged
function useKick() {
  if (kick.charge >= 1) { kick.charge -= 1; return true; }
  input.jumpBuf = 0;
  const now = performance.now();
  if (state.mode === 'play' && !state.autoplay && now - (kick.emptyT || 0) > 400) { kick.emptyT = now; sfx.empty(); }
  return false;
}
const state = { gameMode: 'ball', autoplay: false, levelTime: 0, mode: 'demo', level: 1, score: 0, lives: 3, mult: 1, finished: false, finishT: 0, prevS: 0, respawnT: 0, countT: 0, lastCount: -1, time: 0, best: 0 };
try { state.best = +localStorage.getItem('tiltRollerBest') || 0; } catch (e) { /* ignore */ }
const ball = { s: 2, x: 0, v: 0, vx: 0, grounded: true, pos: new V3(), vel: new V3(), air: 0, dead: false, h: 0, invuln: 0, burnT: 0, spinAxis: new V3(1, 0, 0), spinRate: 0, lastKind: 0, fallS: 0 };
const weather = { quakeNext: 22, quakeT: -1, quakePh: 0, quakeDur: 3.6, quakeEnv: 0, quakeLat: 0, fogNext: 35, fogT: -1, fogDur: 14, fogAmt: 0 };

const D = new V3(), tv = new V3(), tq = new THREE.Quaternion();

// cruising speed: the level's base speed, growing the longer you stay in the level
function targetV() { return track.vt + Math.min(16, state.levelTime * 0.2); }
// The ball rides the half-pipe cross-section: ball.x is its lateral position, ball.vx its
// speed along the cross-section surface; on the walls gravity pulls it back down.
function surfOrFlat(x, sm) { return surfAt(x, sm) || { h: 0, th: ball.surfTh || 0 }; }
function setGroundPos(f) {
  const sm = track.smp[f.i], sf = surfOrFlat(ball.x, sm);
  const st = Math.sin(sf.th), ct = Math.cos(sf.th);
  ball.pos.copy(f.P).addScaledVector(f.B, ball.x - st * BALL_R).addScaledVector(f.U, sf.h + ct * BALL_R);
  ball.surfTh = sf.th; ball.h = sf.h + ct * BALL_R;
}
function detach(up) {
  const f = frameAt(ball.s, F1), sm = track.smp[f.i], sf = surfOrFlat(ball.x, sm);
  const st = Math.sin(sf.th), ct = Math.cos(sf.th);
  // along the surface: B*ct + U*st ; surface normal: -B*st + U*ct
  ball.vel.copy(f.T).multiplyScalar(ball.v)
    .addScaledVector(f.B, ball.vx * ct - up * st).addScaledVector(f.U, ball.vx * st + up * ct);
  setGroundPos(f);
  ball.grounded = false; ball.air = 0;
}

function groundStep(dt) {
  const f = frameAt(ball.s, F1);
  const sm = track.smp[f.i];
  const gT = -G * f.T.y, gB = -G * f.B.y, gU = -G * f.U.y;
  let aS;
  if (state.finished) aS = gT * 0.3 - 16 * Math.sign(ball.v);
  else {
    const tv0 = targetV(), target = sm.boost ? Math.max(sm.boost, tv0 + 4) : tv0, down = gT > 0, over = ball.v > target;
    // downhill gravity builds speed; above cruise speed the ball only coasts down slowly
    const pull = over ? (down ? 0.04 : 0.3) : (sm.boost ? 3 : 0.9);
    aS = gT * (down ? 0.95 : 0.5) + (target - ball.v) * pull - (over ? 0.003 * (ball.v * ball.v - target * target) : 0);
  }
  ball.v += aS * dt;
  if (sm.water > 0) ball.v -= Math.min(sm.water, 0.4) * 0.6 * ball.v * dt;   // wading through the ford
  if (!state.finished && sm.minV && ball.v < sm.minV) ball.v = sm.minV;
  ball.v = clamp(ball.v, state.finished ? 0 : 6, 95);

  ball.aquaN = (ball.aquaN || 0) * (1 - 1.6 * dt) + (Math.random() - 0.5) * 4.5 * Math.sqrt(dt);   // wandering push while aquaplaning
  const sf = surfOrFlat(ball.x, sm), th = sf.th, ct = Math.cos(th), st = Math.sin(th);
  const onWall = Math.abs(th) > 0.05;
  // wet road: half the steering bite and almost no sideways friction, so the ball skates wide
  const aT = (gB + input.steer * STEER_ACC * (sm.wet ? 0.3 : sm.water > 0 ? 0.45 : 1) + (sm.water > 0 ? ball.aquaN * 9 : 0) - ball.v * ball.v * f.kB + weather.quakeLat) * ct + gU * st - ball.vx * (onWall ? 0.5 : sm.wet ? 0.3 : sm.water > 0 ? 0.4 : 2.2);
  ball.vx += aT * dt; ball.x += ball.vx * ct * dt;
  // the outside of a banked curve is a full wall up to the lip
  const side = ball.x < 0 ? -1 : 1;
  if (sm.berm * side > 0.3) {
    const wall = lipX(sm, side) - BALL_R;
    if (Math.abs(ball.x) > wall) { ball.x = side * wall; if (ball.vx * side > 0) ball.vx *= -0.5; }
  }

  ball.s += ball.v * dt;
  if (ball.s >= track.len - 1) { ball.s = track.len - 1; ball.v = 0; }

  if (input.jumpBuf > 0 && !sm.noDetach && useKick()) { input.jumpBuf = 0; ball.v += KICK.fwd; detach(JUMP_V * input.jumpPow); input.jumpPow = 1; sfx.kick(); return; }
  const Fn = ball.v * ball.v * f.kN - gU;
  const f2 = frameAt(ball.s, F2);
  const sm2 = track.smp[f2.i];
  // flying out over the lip of the half-pipe, off the end of the road, or off a fast crest
  if (!sm2.solid || !surfAt(ball.x, sm2) || (!sm.noDetach && Math.abs(sm.berm) < 0.3 && Fn < -2)) { detach(0); return; }
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
  // the tall outer wall of a banked curve also stops an airborne ball
  const side = xx < 0 ? -1 : 1;
  if (sm.solid && sm.berm * side > 0.3) {
    const wall = lipX(sm, side) - BALL_R;
    if (Math.abs(xx) > wall && hh < PIPE.R + 1.5 && hh > -1) {
      ball.pos.addScaledVector(g.B, -side * (Math.abs(xx) - wall));
      const vb = ball.vel.dot(g.B);
      if (vb * side > 0) ball.vel.addScaledVector(g.B, -vb * 1.5);
      ball.x = side * wall;
    }
  }
  const sf = sm.solid ? surfAt(ball.x, sm) : null;
  if (sf) {
    const st = Math.sin(sf.th), ct = Math.cos(sf.th);
    // height above the surface measured along the surface normal
    const dn = (hh - sf.h) * ct;
    const nx = -st, nu = ct;
    const vn = ball.vel.dot(g.B) * nx + ball.vel.dot(g.U) * nu;
    if (dn <= BALL_R && dn > -1.4 && vn <= 0.5) { land(g, sm, sf); return; }
  }
  if ((ball.air > 0.5 && hh < -22) || D.length() > 90) fallOff();
}

function land(g, sm, sf) {
  const st = Math.sin(sf.th), ct = Math.cos(sf.th);
  const n = new V3().copy(g.B).multiplyScalar(-st).addScaledVector(g.U, ct);
  const tl = new V3().copy(g.B).multiplyScalar(ct).addScaledVector(g.U, st);
  const vn = -ball.vel.dot(n);
  const snap = () => { ball.pos.copy(g.P).addScaledVector(g.B, ball.x - st * (BALL_R + 0.02)).addScaledVector(g.U, sf.h + ct * (BALL_R + 0.02)); };
  // a jump pressed just before touching down fires on landing
  if (input.jumpBuf > 0 && !sm.noDetach && useKick()) {
    ball.vel.addScaledVector(n, vn + JUMP_V * input.jumpPow).addScaledVector(g.T, KICK.fwd);
    input.jumpBuf = 0; input.jumpPow = 1; sfx.kick();
    snap(); ball.air = 0;
    return;
  }
  const gapAhead = track.features.some(f => (f.type === 'pit' || f.type === 'gap') && f.s0 > ball.s && f.s0 - ball.s < 45)
    || track.rings.some(f => f.fire && f.s > ball.s && f.s - ball.s < 45);
  if (vn > BOUNCE_MIN && !sm.noDetach && sm.kind !== K.KICK && sm.kind !== K.BOOST && !gapAhead) {
    // bounce: reflect the normal velocity with restitution and stay airborne
    ball.vel.addScaledVector(n, vn * (1 + BOUNCE_E));
    snap();
    sfx.land(vn);
    for (let k = 0; k < 10; k++) fx.spawn(ball.pos, tv.set((Math.random() - 0.5) * 8, Math.random() * 4, (Math.random() - 0.5) * 8), 0.45, [1, 0.9, 0.7, 0.5], [0.6, 0.4, 0.8, 0], 0.7, 1.4, 6, 2);
    if (ball.air > 0.8 && state.mode === 'play' && !state.finished) {
      const pts = Math.round(ball.air * 120) * state.mult;
      state.score += pts; popup(`BIG AIR +${pts}`, 'good');
    }
    ball.air = 0;
    return;
  }
  ball.v = Math.max(4, ball.vel.dot(g.T)); ball.vx = ball.vel.dot(tl) * 0.7;
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
    if (r.fire && d > 0 && d < (ball.v + KICK.fwd) * (JUMP_V / G) * 0.95 && ball.grounded) { input.jumpBuf = 0.1; break; }
  }
  for (const f of track.features) if (f.type === 'pit') { const d = f.s0 - ball.s; if (d > 0 && d < ball.v * 0.18 && ball.grounded) input.jumpBuf = 0.1; }
  return clamp(ff - (ball.x - tx) * 0.35 - ball.vx * 0.25, -1, 1);
}

// ---- events
function ringCheck(f) {
  const hc = ball.h;
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

  // water and wet road
  {
    const smw = track.smp[frameAt(ball.s, F4).i];
    const inW = ball.grounded && !ball.dead && smw.water > 0;
    if (inW && !ball.inWater) { splashBurst(ball.pos.clone(), F4.U, 46, 9); sfx.splash(); if (state.mode === 'play') popup('SPLASH!', 'info'); }
    ball.inWater = inW;
    const onWet = !!smw.wet && !ball.dead;
    if (onWet && !ball.onWet && state.mode === 'play') popup('STORM! SLIPPERY!', 'info');
    ball.onWet = onWet;
  }
  // boost entry
  const kind = track.smp[frameAt(ball.s, F4).i].kind;
  if (kind === K.BOOST && ball.lastKind !== K.BOOST && ball.grounded) { sfx.boost(); }
  ball.lastKind = kind;

  weatherLogic(dt, ball.pos, () => {
    const sm = track.smp[frameAt(ball.s, F4).i];
    const pitAhead = track.features.some(f => f.type === 'pit' && f.s0 > ball.s - 5 && f.s0 - ball.s < 70);
    if (ball.grounded && !sm.noDetach && !pitAhead) detach(10);
  });

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

function weatherLogic(dt, focus, onQuake) {
  // earthquakes
  if (!state.finished) {
    weather.quakeNext -= dt;
    if (weather.quakeNext <= 0 && weather.quakeT < 0) {
      weather.quakeT = 0; weather.quakePh = Math.random() * 6.28; if (state.mode === 'play') { popup('EARTHQUAKE!', 'bad big'); sfx.quake(); }
      onQuake();
    }
  }
  if (weather.quakeT >= 0) {
    weather.quakeT += dt;
    const t = weather.quakeT / weather.quakeDur;
    weather.quakeEnv = Math.sqrt(Math.max(0, Math.sin(Math.PI * Math.min(1, t))));
    const qt = weather.quakeT;
    weather.quakeLat = (Math.sin(qt * 2.2 + weather.quakePh) * 15 + Math.sin(qt * 11.3) * 9 + Math.sin(qt * 17.1 + 1) * 6) * weather.quakeEnv;
    if (Math.random() < dt * 30) fx.spawn(tv.copy(focus).add(new V3((Math.random() - 0.5) * 10, -0.5, (Math.random() - 0.5) * 10)), new V3(0, 2 + Math.random() * 3, 0), 0.9, [0.9, 0.75, 0.6, 0.35], [0.5, 0.4, 0.4, 0], 1.5, 3.5, 0, 1);
    if (t >= 1) { weather.quakeT = -1; weather.quakeEnv = 0; weather.quakeLat = 0; weather.quakeNext = 18 + Math.random() * 16; }
  }
  if (quakeGain) quakeGain.gain.value = weather.quakeEnv * 0.9;
  // fog banks
  if (!state.finished) {
    weather.fogNext -= dt;
    if (weather.fogNext <= 0 && weather.fogT < 0) { weather.fogT = 0; weather.fogDur = 10 + Math.random() * 8; if (state.mode === 'play') { popup('FOG BANK!', 'info'); sfx.fog(); } }
  }
  if (weather.fogT >= 0) {
    weather.fogT += dt;
    const t = weather.fogT, d = weather.fogDur;
    weather.fogAmt = smooth(Math.min(t / 2.5, (d - t) / 2.5, 1));
    if (t >= d) { weather.fogT = -1; weather.fogAmt = 0; weather.fogNext = 30 + Math.random() * 25; }
  }
}

// ============================================================================
// Race mode: the player's monster truck vs AI monster trucks and cars
// ============================================================================
const smoke = new Particles(3000, false, true);
scene.add(smoke.points);

// ---- water effects shared by both modes: splashes, spray, rain, waterfall foam
const SPL0 = [0.93, 0.97, 1, 0.9], SPL1 = [0.75, 0.9, 1, 0];
const sv = new V3(), sp2 = new V3(), WORLD_UP = new V3(0, 1, 0);
// a burst of droplets thrown up and outward (entering the water)
function splashBurst(at, up, n, power) {
  for (let k = 0; k < n; k++) {
    sv.set(Math.random() - 0.5, 0, Math.random() - 0.5).multiplyScalar(power * 1.4).addScaledVector(up, power * (0.5 + Math.random()));
    smoke.spawn(at, sv, 0.6 + Math.random() * 0.5, SPL0, SPL1, 0.22 + Math.random() * 0.35, 0.1, 22, 0.6);
  }
}
// continuous spray thrown backwards and sideways from a wheel or the ball (fr = track frame)
function spray(at, fr, speed, n, big) {
  for (let k = 0; k < n; k++) {
    sv.copy(fr.T).multiplyScalar(-speed * (0.1 + Math.random() * 0.25)).addScaledVector(fr.B, (Math.random() - 0.5) * (big ? 9 : 4)).addScaledVector(fr.U, (big ? 3.5 : 1.2) + Math.random() * (big ? 6 : 2));
    smoke.spawn(at, sv, big ? 0.55 + Math.random() * 0.4 : 0.35, big ? SPL0 : [0.9, 0.95, 1, 0.4], SPL1, big ? 0.2 + Math.random() * 0.3 : 0.5, big ? 0.1 : 1.4, big ? 20 : 2, 0.8);
  }
}
// ---- storms over the wet turns: rain curtains, lightning inside the clouds, thunder
function makeStreakTexture() {
  const t = canvasTex(256, 256, (x, w, h) => {
    x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
    x.lineCap = 'round';
    for (let k = 0; k < 150; k++) {
      const px = Math.random() * w, py = Math.random() * h, L = 18 + Math.random() * 70;
      x.strokeStyle = `rgba(255,255,255,${0.25 + Math.random() * 0.75})`; x.lineWidth = 0.8 + Math.random() * 1.6;
      for (const o of [0, -h]) { x.beginPath(); x.moveTo(px, py + o); x.lineTo(px, py + o + L); x.stroke(); }   // wraps vertically
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
}
const stormUniforms = {
  uStreak: { value: makeStreakTexture() }, uNoise: cloudUniforms.uNoise, uTime: cloudUniforms.uTime,
  uFlash: { value: 0 }, uColor: { value: new THREE.Color('#c9d8f5') },
};
const CURTAIN_VS = `varying vec2 vUv; varying float vDepth; varying float vSeed;
  void main(){
    vUv = uv;
    vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vSeed = instanceMatrix[3][0] * 0.13 + instanceMatrix[3][2] * 0.07;
    vec4 mv = viewMatrix * wp; vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }`;
const CURTAIN_FS = `uniform sampler2D uStreak, uNoise; uniform float uTime, uFlash; uniform vec3 uColor;
  varying vec2 vUv; varying float vDepth; varying float vSeed;
  void main(){
    float sway = texture2D(uNoise, vec2(vUv.y * 0.15 + vSeed, uTime * 0.05)).r - 0.5;            // the sheet billows sideways
    vec2 su = vec2(vUv.x * 7.0 + vUv.y * 0.5 + sway * 0.45 + vSeed, vUv.y * 2.2 + uTime * 2.6);  // slanted, falling
    float streak = texture2D(uStreak, su).r * 0.6 + texture2D(uStreak, su * vec2(1.7, 0.8) + 0.37).r * 0.4;
    float band = texture2D(uNoise, vec2(vUv.x * 0.6 + vSeed + uTime * 0.03, vUv.y * 0.25 - uTime * 0.22)).r;   // drifting folds of denser rain
    float a = (0.16 + streak * 1.0) * smoothstep(0.22, 0.68, band);
    a *= smoothstep(0.0, 0.12, vUv.x) * smoothstep(1.0, 0.88, vUv.x) * smoothstep(0.0, 0.05, vUv.y) * smoothstep(1.0, 0.7, vUv.y);
    a *= smoothstep(1.5, 9.0, vDepth) * (1.0 - smoothstep(70.0, 150.0, vDepth));
    if (a < 0.01) discard;
    gl_FragColor = vec4(uColor * (1.0 + uFlash * 2.5), min(1.0, a * 0.72));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;
const storm = { next: 1.5, t: 9, pos: new V3() };
const boltGeo = new THREE.BufferGeometry();
boltGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(14 * 3), 3));
const bolt = new THREE.Line(boltGeo, new THREE.LineBasicMaterial({ color: '#e6eeff', transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: false }));
bolt.frustumCulled = false; bolt.visible = false; scene.add(bolt);
// two offset copies make the one-pixel line read as a thick bolt
for (const o of [[0.22, 0.18], [-0.2, 0.24]]) { const b2 = new THREE.Line(boltGeo, bolt.material); b2.position.set(o[0], 0, o[1]); b2.frustumCulled = false; bolt.add(b2); }
function strike(zone, focusS) {
  const s = clamp(focusS + 15 + Math.random() * 150, zone.s0, zone.s1), i = clamp(Math.round(s / DS), 0, track.N - 1);
  storm.pos.copy(track.P[i]).addScaledVector(track.B[i], (Math.random() - 0.5) * 24); storm.pos.y += 19;
  storm.t = 0;
  // a jagged bolt from the cloud down past the road
  const a = boltGeo.attributes.position; let x = storm.pos.x, z = storm.pos.z;
  for (let k = 0; k < 14; k++) { a.setXYZ(k, x, storm.pos.y - k * 3.2, z); x += (Math.random() - 0.5) * 5; z += (Math.random() - 0.5) * 5; }
  a.needsUpdate = true;
  const dist = storm.pos.distanceTo(camera.position);
  if (state.mode === 'play') setTimeout(() => sfx.thunder(clamp(1.2 - dist / 260, 0.25, 1)), Math.min(1500, dist * 4));
}
function updateStorm(dt, focusS) {
  let zone = null;
  for (const f of track.features) if (f.type === 'wet' && focusS > f.s0 - 260 && focusS < f.s1 + 40) { zone = f; break; }
  if (zone) { storm.next -= dt; if (storm.next <= 0) { strike(zone, focusS); storm.next = 1.2 + Math.random() * 3.2; } }
  storm.t += dt;
  const t = storm.t;
  // three quick pulses, like real lightning
  const fl = Math.min(1.2, Math.exp(-t * 9) + (t > 0.13 ? 0.7 * Math.exp(-(t - 0.13) * 12) : 0) + (t > 0.32 ? 0.5 * Math.exp(-(t - 0.32) * 7) : 0));
  const near = 1 - smooth((storm.pos.distanceTo(camera.position) - 60) / 280);
  cloudUniforms.uFlash.value = fl; cloudUniforms.uFlashPos.value.copy(storm.pos);
  stormUniforms.uFlash.value = fl * near;
  hemi.intensity = 0.7 + fl * near * 1.8;     // the whole scene flickers
  bolt.visible = t < 0.2 && (t < 0.07 || t > 0.12);
}

function updateWaterFx(dt, focus, focusS) {
  updateClouds(dt);
  updateStorm(dt, focusS);
  for (const w of waterTex) { w.tex.offset.x -= w.vx * dt; w.tex.offset.y += w.vy * dt; }
  const i = clamp(Math.round(focusS / DS), 0, track.N - 1);
  // rain hammering the road in a storm: little splashes on the surface around you
  if (track.smp[i].wet) {
    const T = track.T[i], B = track.B[i], U = track.U[i];
    for (let k = 0; k < 7; k++) {
      sp2.copy(track.P[clamp(i + Math.round(-10 + Math.random() * 90), 0, track.N - 1)]).addScaledVector(B, (Math.random() - 0.5) * 2 * HW).addScaledVector(U, 0.1);
      sv.copy(U).multiplyScalar(2 + Math.random() * 3);
      smoke.spawn(sp2, sv, 0.22, [0.9, 0.95, 1, 0.7], [0.9, 0.95, 1, 0], 0.12, 0.3, 18, 0);
    }
  }
  // foam where the waterfall hits the pool
  for (const f of track.features) if (f.type === 'ford' && f.fallBase && Math.abs(f.s0 - focusS) < 170) {
    for (let k = 0; k < 4; k++) {
      sp2.copy(f.fallBase).addScaledVector(f.T, (Math.random() - 0.5) * 5).addScaledVector(f.B, (Math.random() - 0.5) * 2);
      sv.set((Math.random() - 0.5) * 5, 2 + Math.random() * 4, (Math.random() - 0.5) * 5);
      smoke.spawn(sp2, sv, 0.6, SPL0, SPL1, 0.5, 1.3, 14, 1);
    }
  }
}

const vctx = { mkF, G, frameAt: (s2, o) => frameAt(s2, o), track: () => track, HW: () => HW, tyreTex: makeTyreTexture(), blobTex, surfAt, lipX };
const RIVALS = [
  { name: 'YOU', spec: 'monster', color: '#ff3b5c', isPlayer: true },
  { name: 'Crusher', spec: 'monster', color: '#2fd6b0' },
  { name: 'Mud Hog', spec: 'monster', color: '#ffc928' },
  { name: 'Viper', spec: 'car', color: '#4d7cff' },
  { name: 'Blaze', spec: 'car', color: '#ff8a3a' },
  { name: 'Ghost', spec: 'car', color: '#e8e8f0' },
];
let vehicles = [], player = null;
const race = { events: {}, t: 0, order: [], driftAcc: 0, driftT: 0, driftHold: 0, turboT: 0, lastAir: 0, rank: 1 };

function setupRace() {
  for (const v of vehicles) scene.remove(v.mesh.root, v.mesh.blob);
  vehicles = RIVALS.map((r, i) => new Vehicle(vctx, SPECS[r.spec], { ...r, number: i + 1, ai: { lane: 0, laneT: 0, steer: 0, skill: 0.95 + Math.random() * 0.09 + (r.spec === 'car' ? 0.05 : 0) } }));
  player = vehicles[0];
  const slots = [0, 1, 2, 3, 5]; // the player starts in the middle of the grid (slot 4)
  vehicles.forEach((v, i) => {
    const slot = v.isPlayer ? 4 : slots[i - 1];
    const row = Math.floor(slot / 2), col = slot % 2;
    v.reset(62 - row * 6, col ? 2.2 : -2.2, 0);
    v.ai.lane = v.x;
    scene.add(v.mesh.root, v.mesh.blob);
  });
  race.events = {};
  race.t = 0; race.order = []; race.driftAcc = 0; race.driftT = 0; race.lastAir = 0; race.rank = 5;
  renderProgMarkers();
}
function clearRace() {
  for (const v of vehicles) scene.remove(v.mesh.root, v.mesh.blob);
  vehicles = []; player = null;
  renderProgMarkers();
}

// the player gets a small tow when dropped by the pack (up to +10%)
function playerCatchUp() {
  const ss = vehicles.filter(o => !o.isPlayer && !o.dead).map(o => o.s).sort((a, b) => a - b);
  const med = ss.length ? ss[ss.length >> 1] : player.s;
  return 1 + clamp((med - player.s - 20) * 0.002, 0, 0.1);
}
function aiControl(v, dt, tv0) {
  const ai = v.ai, lim = HW - v.spec.halfW - 1.3;
  ai.kick = Math.min(2, (ai.kick ?? 2) + dt / 2.8);                 // AI kick charges recharge like the player's
  ai.hopT = (ai.hopT || 0) - dt;
  if (v.stun > 0) { ai.lane = clamp(v.x, -lim, lim); ai.drifting = false; return { steer: 0, jump: 0, target: tv0 * 0.9 }; }  // dazed after a hit
  const i = clamp(Math.round(v.s / DS), 0, track.N - 1), sm = track.smp[i];
  ai.laneT -= dt;
  if (ai.laneT <= 0) { ai.lane = (Math.random() * 2 - 1) * lim; ai.laneT = 2 + Math.random() * 4; }
  for (const o of vehicles) {
    if (o === v || o.dead) continue;
    const ds = o.s - v.s;
    // pass on the side we are already on (no flip-flopping), with just enough room
    if (ds > 0 && ds < 16 && Math.abs(o.x - ai.lane) < 2.3) { const side = v.x >= o.x ? 1 : -1; ai.lane = clamp(o.x + side * 2.8, -lim, lim); ai.laneT = 1.5; }
  }
  const { sd, xd } = v.trackVel();
  let want = clamp(0.2 * (ai.lane - v.x) - 0.09 * xd, -0.8, 0.8);
  const ahead = (types, dist) => track.features.some(f => types.includes(f.type) && (f.s0 ?? f.s) > v.s - 5 && (f.s0 ?? f.s) - v.s < dist);
  const hazard = ahead(['pit', 'gap'], 75);

  // ---- deliberate drift through dry bends: steer hard into the turn and balance the slide
  const kB = track.kB[i], kAhead = track.kB[Math.min(track.N - 1, i + 40)];
  const bend = Math.abs(kB) > 0.008 && kB * kAhead > 0 && Math.abs(kAhead) > 0.006;
  if (bend && !ai.inBend) ai.driftOK = Math.random() < 0.7;        // each driver decides bend by bend
  ai.inBend = bend;
  ai.drifting = bend && ai.driftOK && !sm.wet && !sm.noDetach && !hazard && sd > 22 && v.contacts >= 3 && !v.finished;
  if (ai.drifting) {
    const ins = Math.sign(kB), out = clamp(-sd * sd * kB * 0.25, -6, 6);
    const hold = -out / 7 + 0.1 * (clamp(ai.lane, -lim * 0.6, lim * 0.6) - v.x);   // the slide's balance point, nudged toward the lane
    want = ins * clamp(ins * hold, 0.62, 1);
  }
  // ---- in the air next to someone: steer into them
  if (v.contacts === 0 && v.z > v.z0 + 0.3) {
    let best = null, bd = 7;
    for (const o of vehicles) {
      if (o === v || o.dead || o.contacts) continue;
      const d = Math.abs(o.x - v.x);
      if (Math.abs(o.s - v.s) < 2.4 && d < bd) { bd = d; best = o; }
    }
    if (best) want = Math.sign(best.x - v.x);
  }
  if (sm.water > 0) want *= 0.3;                                    // experienced drivers keep the wheel still in water
  ai.steer += (want - ai.steer) * (1 - Math.exp(-8 * dt));
  const steer = ai.steer;

  // ---- jumps: always over pits; hop-kicks for fun on clear straights, mostly next to a rival
  let jump = 0;
  for (const f of track.features) if (f.type === 'pit') { const d = f.s0 - v.s; if (d > 0 && d < Math.max(v.vx, 10) * 0.1) { jump = 1; ai.kick = Math.max(0, ai.kick - 1); ai.hopT = 1.2; } }
  const flat = Math.abs(kB) < 0.004 && sm.kind === K.NORMAL && sm.solid && !sm.wet && !sm.water && v.contacts >= 3;
  if (!jump && flat && ai.kick >= 1 && ai.hopT <= 0 && !v.finished && !hazard && !ahead(['loop', 'ford'], 45)) {
    const rival = vehicles.some(o => o !== v && !o.dead && Math.abs(o.s - v.s) < 3.5 && Math.abs(o.x - v.x) < 4.5);
    if (Math.random() < dt * (rival ? 1.3 : 0.1)) { jump = 1; ai.kick -= 1; ai.hopT = 1.6; v.vx += KICK.fwd * 0.6; }
  }

  // ---- speed: strong catch-up around the player so the pack stays together
  let target;
  if (v.finished) target = 10;
  else if (v.isPlayer) target = tv0 * playerCatchUp();
  else target = tv0 * ai.skill * clamp(1 + (player.s - v.s) * 0.007, 0.74, 1.38);   // behind the player: faster; ahead: easing off
  if (sm.water > 0) target *= 0.86;
  if (sm.wet) target *= 0.82;                                                        // drivers lift in the storm
  return { steer, jump, target };
}

function raceStep(dt) {
  const tv0 = targetV();
  for (const v of vehicles) {
    if (v.dead) { v.step(dt, 0, 0, 0); continue; }
    let steer, jump = 0, target;
    if (v.isPlayer && !state.autoplay) {
      steer = input.steer; target = v.finished ? 10 : tv0 * playerCatchUp();
      if (input.jumpBuf > 0 && v.contacts >= 2 && useKick()) { jump = input.jumpPow; input.jumpBuf = 0; input.jumpPow = 1; v.vx += KICK.fwd; sfx.kick(); }
    } else ({ steer, jump, target } = aiControl(v, dt, tv0));
    v.vy += weather.quakeLat * 0.4 * dt;
    v.step(dt, steer, jump, target, (v.isPlayer && !state.autoplay) || !!v.ai.drifting);
  }
  collideVehicles();
}

function collideVehicles() {
  for (let i = 0; i < vehicles.length; i++) for (let j = i + 1; j < vehicles.length; j++) {
    const a = vehicles[i], b = vehicles[j];
    if (a.dead || b.dead || Math.abs(a.z - b.z) > 1.4) continue;
    const ds = b.s - a.s, dx = b.x - a.x;
    const lx = a.spec.halfL + b.spec.halfL, wx = a.spec.halfW + b.spec.halfW;
    if (Math.abs(ds) >= lx || Math.abs(dx) >= wx) continue;
    const ox = wx - Math.abs(dx), os = lx - Math.abs(ds);
    const ta = a.trackVel(), tb = b.trackVel();
    const mass = v => v.isPlayer ? 3 : v.spec.kind === 'monster' ? 1.6 : 1;
    const ma = mass(a), mb = mass(b);
    const wa = mb / (ma + mb), wb = ma / (ma + mb);   // the lighter vehicle gets pushed more
    let hard = 0;
    if (ox < os) {
      // side by side: shove apart sideways
      const sg = dx >= 0 ? 1 : -1;
      a.x -= sg * ox * wa; b.x += sg * ox * wb;
      const rel = tb.xd - ta.xd;
      if (rel * sg < 0) { a.setTrackVel(ta.sd, ta.xd + rel * wa * 1.3 - sg * 2); b.setTrackVel(tb.sd, tb.xd - rel * wb * 1.3 + sg * 2); hard = Math.abs(rel); }
      const yawKick = Math.min(1, hard / 5) * 0.25; a.r += sg * yawKick * wa; b.r -= sg * yawKick * wb;
      // mid-air hit: an airborne vehicle has no grip, so whoever drives into it sends it flying sideways
      const aA = ta.xd * sg, aB = -tb.xd * sg;                 // each one's speed toward the other
      const agg = aA >= aB ? a : b, vic = agg === a ? b : a, closingAll = aA + aB;
      let airHit = false;
      if (vic.contacts === 0 && closingAll > 2 && race.t - (vic.airHitT ?? -9) > 0.6) {
        airHit = true; vic.airHitT = race.t;
        const away = vic === b ? sg : -sg, tvc = vic.trackVel(), tag = agg.trackVel();
        vic.setTrackVel(tvc.sd * 0.97, away * Math.max(Math.abs(tvc.xd), Math.min(30, 9 + closingAll * 2.2)));
        vic.zd += 2.5; vic.r += away * -1.5; vic.stun = 1.3; vic.hitBy = agg; vic.hitT = race.t;
        if (!vic.flipT) vic.tumble(away, 0.8);
        agg.setTrackVel(tag.sd, tag.xd * 0.4);
        hard = Math.max(hard, closingAll * 2.5);
        race.airHits = (race.airHits || 0) + 1;
        if (agg.isPlayer) popup('AIR STRIKE!', 'good'); else if (vic.isPlayer) { popup('KNOCKED!', 'bad'); flash(0.3, '#ff4040'); }
      }
      // the player's shove on the ground: throw the rival sideways (up the half-pipe wall, maybe over it)
      const pl = a.isPlayer ? a : b.isPlayer ? b : null;
      if (pl && !airHit) {
        const op = pl === a ? b : a, away = pl === a ? sg : -sg;
        const tp = pl.trackVel(), to = op.trackVel();
        const tp0 = pl === a ? ta : tb, to0 = pl === a ? tb : ta;   // speeds before this contact
        const closing = (tp0.xd - to0.xd) * away;             // how hard the player drove into it
        if (closing > 1.5) {
          const push = clamp(7 + closing * 1.8, 0, 24);
          op.setTrackVel(to.sd * 0.96, away * Math.max(Math.abs(to.xd), push));
          op.r += away * -1.2; op.stun = 1.0; op.hitBy = pl; op.hitT = race.t;
          pl.setTrackVel(tp.sd, tp.xd * 0.5);
          hard = Math.max(hard, closing * 2);
          if (closing > 5) popup('SLAM!', 'good');
        }
      }
    } else {
      // nose to tail: the one behind is slowed, the one in front gets a shove
      const [rr, ff] = ds > 0 ? [a, b] : [b, a];
      const tr2 = rr.trackVel(), tf = ff.trackVel();
      rr.s -= os * 0.5; ff.s += os * 0.5;
      if (tr2.sd > tf.sd) {
        const m = (tr2.sd + tf.sd) / 2; hard = tr2.sd - tf.sd;
        rr.setTrackVel(m - 1.5, tr2.xd + (Math.random() - 0.5) * 3);
        ff.setTrackVel(m + 1.5, tf.xd); ff.r += (Math.random() - 0.5) * 0.4;
        if (rr.isPlayer && hard > 3) {
          // rear-ended by the player: spin the rival out and keep the player's momentum
          const sgn = Math.random() < 0.5 ? -1 : 1;
          ff.r += sgn * (1.5 + hard * 0.15); ff.stun = 1.2; ff.hitBy = rr; ff.hitT = race.t;
          ff.setTrackVel(tr2.sd * 0.9, tf.xd + sgn * (4 + hard * 0.5));
          rr.setTrackVel(tr2.sd - hard * 0.25, tr2.xd);
          if (hard > 6) popup('BUMP!', 'good');
        }
      }
    }
    if (hard > 4 && (a.isPlayer || b.isPlayer)) { sfx.land(hard * 2); flash(0.12, '#ffffff'); }
  }
}

function respawnVehicle(v) {
  let best = track.checkpoints[0];
  const sDead = v.deathS ?? v.s;
  for (const c of track.checkpoints) if (c * DS <= sDead - 4) best = c;
  const lim = HW - v.spec.halfW - 0.6;
  const wasFinished = v.finished, place = v.finishPlace, ft = v.finishTime;
  v.reset(best * DS + 1, clamp(v.ai.lane, -lim, lim), targetV() * 0.6);
  v.finished = wasFinished; v.finishPlace = place; v.finishTime = ft;
  v.respawns = (v.respawns || 0) + 1;
  if (v.isPlayer) { popup('RESPAWN', 'bad'); camSnap = true; }
}

const ORD = n => n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');
function raceLogic(dt) {
  race.t += dt;
  if (!player.finished) state.levelTime += dt;
  for (const v of vehicles) {
    if (!v.finished && v.s >= track.finishS) {
      v.finished = true; race.order.push(v); v.finishPlace = race.order.length; v.finishTime = race.t;
      if (v.isPlayer) {
        state.finished = true; state.finishT = 0; sfx.finish();
        const pts = [3000, 2000, 1200, 800, 500, 300][v.finishPlace - 1] * state.level;
        state.score += pts;
        popup(`${ORD(v.finishPlace)} PLACE!`, 'big good'); popup(`+${pts}`, 'good');
      }
    }
    if (v.dead && !v.takedownDone && v.hitBy === player && race.t - v.hitT < 3) {
      v.takedownDone = true;
      const pts = 500 * state.level; state.score += pts; popup(`TAKEDOWN! +${pts}`, 'big good'); sfx.takedown(); flash(0.25, '#ffd23f');
    }
    if (v.dead && v.fallT > 1.3) { respawnVehicle(v); v.takedownDone = false; v.hitBy = null; }
  }
  for (const v of vehicles) {
    if (v.event) {
      const ev = v.event; v.event = null;
      race.events[ev] = (race.events[ev] || 0) + 1;
      if (v.isPlayer) { popup(ev === 'spin' ? 'SPIN OUT!' : ev === 'flip' ? 'ROLLED!' : 'OVER THE TOP!', 'bad'); if (ev === 'spin') noise(0.7, 1800, 0.3, 'bandpass'); else sfx.land(22); }
      else if (ev === 'flip' && v.hitBy === player && race.t - v.hitT < 3) { const pts = 200 * state.level; state.score += pts; popup(`ROLLED HIM! +${pts}`, 'good'); }
    }
    const wNow = v.inWater > 0 && !v.dead;
    if (wNow && !v.wasInWater && Math.abs(v.s - player.s) < 160) {
      splashBurst(v.mesh.root.position.clone(), v.F.U, 40, 8);
      if (v.isPlayer) { sfx.splash(); popup('SPLASH!', 'info'); }
    }
    v.wasInWater = wNow;
  }
  if (player.onWet && !race.wasWet && !player.dead) popup('STORM! SLIPPERY!', 'info');
  race.wasWet = player.onWet;
  if (player.dead && !player.fallAnnounced) { popup('CRASHED!', 'bad'); sfx.fall(); player.fallAnnounced = true; }
  if (!player.dead) player.fallAnnounced = false;
  // rank: finished vehicles first (by finishing order), then by distance
  race.rank = 1 + vehicles.filter(o => o !== player && (o.finished ? (!player.finished || o.finishPlace < player.finishPlace) : (!player.finished && o.s > player.s))).length;
  // drift and air scoring for the player
  if (player.driftI > 0.5 && Math.abs(input.steer) > 0.45 && !player.finished) race.driftHold += dt;
  else if (race.driftHold > 0) {
    if (race.driftHold > 0.7 && !player.dead) { const b = Math.min(14, 5 + race.driftHold * 5); player.vx += b; popup('TURBO!', 'info'); sfx.turbo(); race.turboT = 0.8; }
    race.driftHold = 0;
  }
  race.turboT = Math.max(0, (race.turboT || 0) - dt);
  if (player.drift > 0.02 && !player.finished) { race.driftAcc += player.drift * player.vx * dt * 6; race.driftT = 0.4; }
  else if (race.driftT > 0) {
    race.driftT -= dt;
    if (race.driftT <= 0) { if (race.driftAcc > 40) { const pts = Math.round(race.driftAcc); state.score += pts; popup(`DRIFT +${pts}`, 'info'); } race.driftAcc = 0; }
  }
  if (player.air > 0.8) race.lastAir = player.air;
  else if (race.lastAir > 0.8 && player.contacts) { const pts = Math.round(race.lastAir * 120); state.score += pts; popup(`BIG AIR +${pts}`, 'good'); race.lastAir = 0; }
  if (!player.finished && !player.dead) state.score += Math.max(0, player.vx) * dt * 0.3;

  weatherLogic(dt, player.mesh.root.position, () => {
    for (const v of vehicles) { const sm = track.smp[frameAt(v.s, F4).i]; if (v.contacts >= 2 && !sm.noDetach) v.zd += 6; }
  });

  if (state.finished) {
    state.finishT += dt;
    if (state.finishT < 3 && Math.random() < dt * 14) burstConfetti(track.archTop, 18);
    if (state.finishT > 4.5 || (race.order.length === vehicles.length && state.finishT > 1.5)) raceComplete();
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
  state.finished = false; state.finishT = 0; state.prevS = ball.s; state.respawnT = 0; state.levelTime = 0; kick.charge = KICK.max;
  weather.quakeT = -1; weather.quakeEnv = 0; weather.quakeLat = 0; weather.quakeNext = 18 + Math.random() * 12;
  weather.fogT = -1; weather.fogAmt = 0; weather.fogNext = 28 + Math.random() * 20;
  setGroundPos(frameAt(ball.s, F2));
  camSnap = true;
}
function newSeed() { return params.has('seed') ? (+params.get('seed') + state.level) >>> 0 : ((Date.now() ^ Math.floor(Math.random() * 1e9)) >>> 0); }

function startDemo() {
  state.mode = 'demo'; state.gameMode = 'ball'; HW = BALL_HW; PIPE.R = 3.5; clearRace(); document.body.classList.remove('race');
  setTrack(generateTrack(newSeed(), 3));
  resetRun(); ball.v = track.vt;
}
function startGame(mode = 'ball') {
  initAudio(); requestSensors();
  state.gameMode = mode;
  try { localStorage.setItem('tiltRollerMode', mode); } catch (e) { /* ignore */ }
  state.level = +params.get('level') || 1; state.score = 0; state.lives = 3; state.mult = 1;
  beginLevel();
}
function beginLevel() {
  const raceMode = state.gameMode === 'race';
  HW = raceMode ? RACE_HW : BALL_HW; PIPE.R = raceMode ? 4 : 3.5;
  setTrack(generateTrack(newSeed(), state.level, raceMode));
  resetRun();
  if (raceMode) setupRace(); else clearRace();
  ballMesh.visible = !raceMode; blob.visible = !raceMode;
  document.body.classList.toggle('race', raceMode);
  document.getElementById('zones').classList.add('hidden');   // replaced by the on-screen buttons
  state.mode = 'count'; state.countT = 3; state.lastCount = -1;
  overlay.classList.add('hidden'); hud.classList.remove('hidden');
}
function levelComplete() {
  if (state.mode !== 'play') return;
  state.mode = 'done';
  saveBest();
  ovTitle.innerHTML = `LEVEL ${state.level}<br>COMPLETE!`;
  ovBody.innerHTML = `Score <b>${Math.floor(state.score)}</b><br>Next track is longer and faster. +1 life!`;
  setButtons(['NEXT LEVEL', () => { state.level++; state.lives = Math.min(5, state.lives + 1); beginLevel(); }], ['TRUCK RACE', () => startGame('race')]);
  ovHint.textContent = ('ontouchstart' in window) ? '' : DESKTOP_HINT;
  overlay.classList.remove('hidden');
}
function raceComplete() {
  if (state.mode !== 'play') return;
  state.mode = 'done';
  saveBest();
  const rows = [...vehicles].sort((a, b) => (a.finished && b.finished) ? a.finishPlace - b.finishPlace : a.finished ? -1 : b.finished ? 1 : b.s - a.s)
    .map((v, i) => `<div class="row${v.isPlayer ? ' me' : ''}"><span>${ORD(i + 1)}</span> <span style="color:${v.color}">&#9632;</span> ${v.name}${v.finished ? ` <i>${v.finishTime.toFixed(1)}s</i>` : ''}</div>`).join('');
  ovTitle.innerHTML = player.finishPlace === 1 ? 'YOU<br>WIN!' : `${ORD(player.finishPlace || race.rank)}<br>PLACE`;
  ovBody.innerHTML = `<div class="results">${rows}</div>Score <b>${Math.floor(state.score)}</b>`;
  setButtons(['NEXT RACE', () => { state.level++; beginLevel(); }], ['BALL RUN', () => startGame('ball')]);
  ovHint.textContent = ('ontouchstart' in window) ? '' : DESKTOP_HINT;
  overlay.classList.remove('hidden');
}
function gameOver() {
  state.mode = 'over';
  saveBest();
  ovTitle.innerHTML = 'GAME<br>OVER';
  ovBody.innerHTML = `Score <b>${Math.floor(state.score)}</b><br>Best <b>${Math.floor(state.best)}</b><br>Level ${state.level}`;
  setButtons(['PLAY AGAIN', () => startGame('ball')], ['TRUCK RACE', () => startGame('race')]);
  ovHint.textContent = 'A brand new track is generated every time.';
  overlay.classList.remove('hidden'); hud.classList.add('hidden');
}
function saveBest() {
  if (state.score > state.best) { state.best = state.score; try { localStorage.setItem('tiltRollerBest', String(Math.floor(state.best))); } catch (e) { /* ignore */ } }
}
const ovBtn2 = document.getElementById('ovBtn2');
let ovAct1 = () => startGame('ball'), ovAct2 = () => startGame('race');
function setButtons(b1, b2) {
  ovBtn.textContent = b1[0]; ovAct1 = b1[1];
  ovBtn2.classList.toggle('hidden', !b2);
  if (b2) { ovBtn2.textContent = b2[0]; ovAct2 = b2[1]; }
}
ovBtn.addEventListener('click', () => { ovBtn.blur(); initAudio(); requestSensors(); ovAct1(); });
ovBtn2.addEventListener('click', () => { ovBtn2.blur(); initAudio(); requestSensors(); ovAct2(); });
const DESKTOP_HINT = 'Keyboard: ← → steer (hold to drift), Space jump, Enter start.';
if (!('ontouchstart' in window)) ovHint.textContent = DESKTOP_HINT;

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
  if (isRace()) return updateRaceVisuals(dt, gdt);
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
    const hgt = ball.grounded ? 0 : Math.max(0, ball.h - BALL_R - (surfAt(ball.x, sm)?.h || 0));
    const sfb = sm.solid ? surfAt(ball.x, sm) : null;
    blob.visible = !ball.dead && !!sfb && hgt < 25;
    if (blob.visible) {
      blob.position.copy(f.P).addScaledVector(f.B, ball.x).addScaledVector(f.U, sfb.h + 0.03);
      blob.quaternion.copy(basis(f.B, f.T, f.U));
      blob.scale.setScalar(1 + hgt * 0.09);
      blob.material.opacity = clamp(1 - hgt / 22, 0.15, 1);
    }
  }
  ballMesh.visible = ball.invuln <= 0 || Math.floor(state.time * 12) % 2 === 0;

  // spray: big rooster tail in the ford, fine mist on wet road
  {
    const f = frameAt(ball.s, F4), sm = track.smp[f.i];
    if (!ball.dead && ball.grounded && sm.water > 0) spray(wv.copy(ball.pos).addScaledVector(f.U, -0.3), f, ball.v, 6, true);
    else if (!ball.dead && ball.grounded && sm.wet && Math.random() < 0.7) spray(wv.copy(ball.pos).addScaledVector(f.U, -0.5), f, ball.v, 1, false);
    updateWaterFx(dt, ball.pos, ball.s);
    smoke.update(gdt);
  }
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
  if (engine) engine.gain.gain.value = 0;
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
    drawKick();
    elSpeed.textContent = `${Math.round(ball.v * TIME_SCALE * 3.6)} km/h`;
  }
}

const elProgWrap = document.getElementById('prog');
const kickPips = [...document.querySelectorAll('#kick .pip i')], jumpBtns = [...document.querySelectorAll('#pad .jump')];
function drawKick() {
  kickPips.forEach((el, i) => {
    const f = clamp(kick.charge - i, 0, 1);
    el.style.height = `${f * 100}%`;
    el.parentElement.classList.toggle('ready', f >= 1);
  });
  for (const b of jumpBtns) b.classList.toggle('empty', kick.charge < 1);
}
function renderProgMarkers() {
  elProgWrap.querySelectorAll('.mk').forEach(e => e.remove());
  for (const v of vehicles) {
    const d = document.createElement('div'); d.className = 'mk' + (v.isPlayer ? ' me' : ''); d.style.background = v.color;
    elProgWrap.appendChild(d); v.mk = d;
  }
}
const wv = new V3();
function updateRaceVisuals(dt, gdt) {
  for (const v of vehicles) {
    v.updateMesh(gdt);
    // drift smoke from the rear tyres
    if (!v.dead && v.drift > 0.03) for (const i of [2, 3]) if (Math.random() < 0.8) {
      v.wheelWorld(i, wv);
      smoke.spawn(wv, tv.set((Math.random() - 0.5) * 3, 1.5 + Math.random() * 2, (Math.random() - 0.5) * 3), 1.1, [0.85, 0.85, 0.9, 0.55], [0.7, 0.7, 0.75, 0], 1.2, 4.5, -0.5, 1.5);
    }
    // spray: rooster tails from every wheel in the ford, mist from the rear wheels on wet road
    if (!v.dead && Math.abs(v.s - player.s) < 150) {
      if (v.inWater > 0) for (let i = 0; i < 4; i++) { v.wheelWorld(i, wv); spray(wv, v.F, Math.abs(v.vx), 2, true); }
      else if (v.onWet && v.vx > 12 && v.contacts) for (const i of [2, 3]) if (Math.random() < 0.6) { v.wheelWorld(i, wv); spray(wv, v.F, v.vx, 1, false); }
    }
    if (v.mk) v.mk.style.left = `${clamp(v.s / track.finishS, 0, 1) * 100}%`;
  }
  updateWaterFx(dt, player.mesh.root.position, player.s);
  // flags, chevrons, particles, fog (shared with ball mode)
  for (const geo of flagGeos) {
    const p = geo.attributes.position.array, b = geo.userData.base, ph = geo.userData.phase;
    for (let i = 0; i < p.length; i += 3) p[i + 2] = Math.sin(b[i] * 2.4 - state.time * 7 + ph) * 0.22 * (b[i] / 2.4);
    geo.attributes.position.needsUpdate = true;
  }
  if (chevMats[0]) chevMats[0].opacity = 0.65 + 0.35 * Math.sin(state.time * 10);
  fx.update(gdt); confetti.update(gdt); smoke.update(gdt);
  const fa = weather.fogAmt;
  scene.fog.near = lerp(160, 4, fa); scene.fog.far = lerp(700, 75, fa);
  scene.fog.color.copy(HORIZON).lerp(FOG_COLOR, fa);
  skyMat.uniforms.fogAmt.value = fa * 0.95;
  sun.intensity = lerp(2.6, 1.2, fa);
  const pp = player.mesh.root.position;
  sun.position.copy(pp).addScaledVector(SUN_DIR, 90); sun.target.position.copy(pp);
  updateRaceCamera(dt);
  sky.position.copy(camera.position);
  // engine & tyre screech
  if (rollGain) {
    const on = state.mode === 'play' && !document.hidden;
    rollGain.gain.value = on ? clamp(player.drift * 3, 0, 0.5) : 0;
    rollFilter.frequency.value = 900 + player.drift * 3000;
    if (engine) {
      engine.gain.gain.value = on ? 0.05 + clamp(player.vx / 60, 0, 1) * 0.06 : 0;
      engine.osc.frequency.value = 40 + Math.abs(player.vx) * 2.2 + (player.contacts ? 0 : 30);
    }
  }
  if (state.mode === 'play' || state.mode === 'count') {
    elScore.textContent = player.finished ? ORD(player.place) : ORD(race.rank);
    elMult.textContent = race.driftAcc > 5 ? `DRIFT ${Math.round(race.driftAcc)}` : `of ${vehicles.length} · ${Math.floor(state.score).toLocaleString()} pts`;
    elLevel.textContent = `RACE ${state.level}`;
    elLives.textContent = '';
    elProg.style.width = `${clamp(player.s / track.finishS, 0, 1) * 100}%`;
    elTilt.style.left = `${50 + input.steer * 45}%`;
    drawKick();
    elSpeed.textContent = `${Math.round(Math.hypot(player.vx, player.vy) * TIME_SCALE * 3.6)} km/h`;
  }
}
function updateRaceCamera(dt) {
  if (state.freeCam) return;   // test hook: camera placed by hand
  const v = player;
  const f = frameAt(Math.max(0, v.s - 8), F3);
  const desired = tv.copy(f.P).addScaledVector(f.U, 3.6).addScaledVector(f.B, clamp(v.x, -HW - 2, HW + 2) * 0.75);
  const bf = frameAt(v.s, F4);
  const vp = v.mesh.root.position;
  const look = new V3().copy(vp).addScaledVector(bf.T, 6).addScaledVector(bf.U, 1.2);
  if (camSnap) { camPos.copy(desired); camUp.copy(f.U); camLook.copy(look); camSnap = false; }
  if (!v.dead) camPos.lerp(desired, 1 - Math.exp(-dt * 12));
  camUp.lerp(f.U, 1 - Math.exp(-dt * 5)).normalize();
  camLook.lerp(v.dead ? vp : look, 1 - Math.exp(-dt * 16));
  camera.position.copy(camPos);
  const sh = weather.quakeEnv * 0.45;
  if (sh > 0) camera.position.add(new V3((Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh));
  camera.up.copy(camUp);
  camera.lookAt(camLook);
  if (input.roll) camera.rotateZ(-input.roll);
  const fov = 66 + clamp(v.vx - 28, 0, 30) * 0.45;
  if (Math.abs(fov - lastFov) > 0.05) { lastFov = lerp(lastFov, fov, 1 - Math.exp(-dt * 3)); camera.fov = lastFov; camera.updateProjectionMatrix(); updatePointScale(); }
}

function onResize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  updatePointScale();
}
function updatePointScale() {
  const sc = renderer.domElement.height / (2 * Math.tan(camera.fov * DEG / 2));
  fx.mat.uniforms.uScale.value = sc; confetti.mat.uniforms.uScale.value = sc; if (smoke) smoke.mat.uniforms.uScale.value = sc;
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
    kick.charge = Math.min(KICK.max, kick.charge + gdt / KICK.recharge);
    const n = Math.ceil(gdt / (1 / 150)), h = gdt / n;
    for (let k = 0; k < n; k++) (isRace() ? raceStep : physicsStep)(h);
    input.jumpBuf = Math.max(0, input.jumpBuf - dt);
    (isRace() ? raceLogic : logic)(gdt);
  }
  updateVisuals(dt, gdt);
  renderer.shadowMap.needsUpdate = true;
  renderer.render(scene, camera);
}

startDemo();
onResize();
requestAnimationFrame(frame);
window.__game = {
  state, ball, get track() { return track; }, weather, input, camera, race, get vehicles() { return vehicles; }, get clouds() { return cloudFx; }, storm, strike, startGame,
  // headless test hook: advance the simulation without rendering
  sim(seconds, dt = 1 / 60) {
    for (let t = 0; t < seconds; t += dt) {
      readInput(dt);
      if (state.mode === 'count') updateCountdown(dt);
      if (state.mode !== 'play' && state.mode !== 'demo') continue;
      kick.charge = Math.min(KICK.max, kick.charge + dt / KICK.recharge);
      const n = 3;
      for (let k = 0; k < n; k++) (isRace() ? raceStep : physicsStep)(dt / n);
      input.jumpBuf = Math.max(0, input.jumpBuf - dt);
      (isRace() ? raceLogic : logic)(dt);
    }
  },
};
