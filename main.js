import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const Q = new URLSearchParams(location.search);
const TEST = Q.has('test');                       // deterministic mode for screenshots
const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ renderer / scene
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.AgXToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
renderer.xr.setFramebufferScaleFactor(1.25);
renderer.xr.setFoveation(0.2);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d0907);
const camera = new THREE.PerspectiveCamera(+(Q.get('fov') || 70), innerWidth / innerHeight, 0.05, 60);
const rig = new THREE.Group();
rig.add(camera);
scene.add(rig);

const manager = new THREE.LoadingManager();
manager.onProgress = (_u, done, total) => { $('prog').style.width = (100 * done / total).toFixed(0) + '%'; };
const gltf = new GLTFLoader(manager);
const texLoader = new THREE.TextureLoader(manager);

const L = await (await fetch('assets/layout.json')).json();
const CAP = new THREE.Vector3(...L.capture);

// ------------------------------------------------------------------ room: 360 render projected onto proxy geometry
const PANO = Q.get('pano') || 'assets/pano.jpg';
const pano = await texLoader.loadAsync(PANO);
pano.colorSpace = THREE.NoColorSpace;          // already display-referred, pass through untouched
pano.generateMipmaps = false;
pano.minFilter = THREE.LinearFilter;
pano.magFilter = THREE.LinearFilter;
pano.wrapS = THREE.RepeatWrapping;
pano.anisotropy = 1;

const roomMat = new THREE.ShaderMaterial({
  uniforms: { pano: { value: pano }, cap: { value: CAP } },
  vertexShader: /* glsl */`
    varying vec3 vW;
    void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
  fragmentShader: /* glsl */`
    uniform sampler2D pano; uniform vec3 cap; varying vec3 vW;
    const float PI = 3.14159265359;
    void main(){
      vec3 d = normalize(vW - cap);
      float u = 0.5 + atan(d.x, -d.z) / (2.0 * PI);
      float v = 0.5 + asin(clamp(d.y, -1.0, 1.0)) / PI;
      gl_FragColor = vec4(texture2D(pano, vec2(u, v)).rgb, 1.0);
    }`,
  toneMapped: false,
});
{
  const g = await gltf.loadAsync('assets/proxy.glb');
  const geos = [];
  g.scene.updateMatrixWorld(true);
  g.scene.traverse((o) => {
    if (o.isMesh) {
      const geo = o.geometry.clone();
      for (const k of Object.keys(geo.attributes)) if (k !== 'position') geo.deleteAttribute(k);
      geo.applyMatrix4(o.matrixWorld);
      geos.push(geo.index ? geo.toNonIndexed() : geo);
    }
  });
  const room = new THREE.Mesh(mergeGeometries(geos), roomMat);
  room.frustumCulled = false;
  scene.add(room);
}
// far sphere as safety net (covers any gap in the proxy)
{
  const sph = new THREE.Mesh(new THREE.SphereGeometry(40, 64, 32), roomMat);
  sph.material = roomMat.clone(); sph.material.side = THREE.BackSide; sph.material.depthWrite = false;
  sph.position.copy(CAP); sph.renderOrder = -1;
  scene.add(sph);
}

// ------------------------------------------------------------------ lighting for people (matches the render)
const pmrem = new THREE.PMREMGenerator(renderer);
const envTex = pano.clone();
envTex.mapping = THREE.EquirectangularReflectionMapping;
envTex.colorSpace = THREE.SRGBColorSpace;
envTex.needsUpdate = true;
scene.environment = pmrem.fromEquirectangular(envTex).texture;
scene.environmentIntensity = +(Q.get('env') || 0.9);
for (const l of L.lights) {
  const pl = new THREE.PointLight(new THREE.Color(...l.c), l.i * +(Q.get('lights') || 1), l.d, 1.6);
  pl.position.set(...l.p);
  scene.add(pl);
}

// ------------------------------------------------------------------ people
const animCache = new Map();
async function clip(name) {
  if (!animCache.has(name)) animCache.set(name, gltf.loadAsync(`assets/anims/${name}.glb`).then((g) => g.animations[0]));
  return animCache.get(name);
}
async function avatar(name) {
  const g = await gltf.loadAsync(`assets/people/${name}.glb`);
  const root = g.scene;
  root.traverse((o) => {
    if (o.isMesh || o.isSkinnedMesh) {
      o.frustumCulled = false;
      const m = o.material;
      if (m.transparent || (m.map && /opacity/i.test(m.name))) {
        m.transparent = false; m.alphaTest = 0.45; m.side = THREE.DoubleSide; m.depthWrite = true;
        m.alphaToCoverage = true;
      }
      m.envMapIntensity = 1.0;
    }
  });
  return root;
}

const rnd = (() => { let s = 1234567; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
const people = [];
const target = new THREE.Vector3();       // where people look (singer's head)
const tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3(), tmpQ = new THREE.Quaternion(), tmpQ2 = new THREE.Quaternion();
const FWD = new THREE.Vector3(0, 0, 1);

function setupLook(p) {
  p.group.updateMatrixWorld(true);
  p.head = p.root.getObjectByName('Bip01_Head');
  p.neck = p.root.getObjectByName('Bip01_Neck');
  p.root.updateMatrixWorld(true);
  const qh = p.head.getWorldQuaternion(new THREE.Quaternion());
  const qr = p.root.getWorldQuaternion(new THREE.Quaternion());
  // face-forward axis expressed in head-local space, from the bind pose (avatar faces +Z of its root)
  p.fwdLocal = FWD.clone().applyQuaternion(qr).applyQuaternion(qh.invert()).normalize();
  p.lookW = 0; p.lookGoal = 0; p.lookTimer = 1 + rnd() * 5;
}

function turnBone(bone, fwdLocal, goal, amount) {
  bone.getWorldQuaternion(tmpQ);
  const cur = tmpV.copy(fwdLocal).applyQuaternion(tmpQ);
  bone.getWorldPosition(tmpV2);
  const want = tmpV2.subVectors(goal, tmpV2).normalize();
  const ang = cur.angleTo(want);
  const fade = THREE.MathUtils.smoothstep(ang, 1.75, 1.0);      // never twist backwards
  if (amount * fade < 0.001) return;
  const delta = tmpQ2.setFromUnitVectors(cur, want);
  delta.slerp(new THREE.Quaternion(), 1 - amount * fade);
  // world -> local
  const parentQ = bone.parent.getWorldQuaternion(new THREE.Quaternion());
  const newWorld = delta.multiply(tmpQ);
  bone.quaternion.copy(parentQ.invert().multiply(newWorld));
  bone.updateMatrixWorld(true);
}

function updateLook(p, dt) {
  p.lookTimer -= dt;
  if (p.lookTimer <= 0) {
    const looking = p.lookGoal > 0.5;
    p.lookGoal = looking ? 0 : (rnd() < p.look * 1.6 ? 1 : 0);
    p.lookTimer = p.lookGoal ? 2.5 + rnd() * 4 : 3 + rnd() * 9;
  }
  p.lookW += (p.lookGoal - p.lookW) * Math.min(1, dt * 2.2);
  if (p.lookW < 0.01) return;
  p.neck.parent.updateMatrixWorld(true);
  turnBone(p.neck, p.neckFwd || p.fwdLocal, target, 0.4 * p.lookW);
  turnBone(p.head, p.fwdLocal, target, 0.85 * p.lookW);
}

class Person {
  constructor(spec, root, clips) {
    this.spec = spec; this.root = root; this.look = spec.look ?? 0.3;
    this.group = new THREE.Group();
    this.group.position.set(...spec.pos);
    this.group.rotation.y = spec.yaw;
    this.group.add(root);
    scene.add(this.group);
    // look axes from the bind pose (avatar faces +Z of its root)
    setupLook(this);
    this.neckFwd = (() => {
      const qn = this.neck.getWorldQuaternion(new THREE.Quaternion());
      const qr = root.getWorldQuaternion(new THREE.Quaternion());
      return FWD.clone().applyQuaternion(qr).applyQuaternion(qn.invert()).normalize();
    })();
    this.mixer = new THREE.AnimationMixer(root);
    this.actions = clips.map((c) => this.mixer.clipAction(c));
    this.main = this.actions[0];
    this.main.play();
    if (/drink/.test(clips[0].name + spec.anims[0])) this.attachGlass(spec.avatar.startsWith('Female') ? 'wine' : 'pint');
    this.main.time = rnd() * clips[0].duration;
    this.main.timeScale = 0.92 + rnd() * 0.16;
    this.alt = this.actions[1];
    this.altTimer = 6 + rnd() * 14;
    this.mixer.update(0);
  }
  attachGlass(kind) {
    const root = this.root, clipD = this.main.getClip().duration;
    const B = (n) => root.getObjectByName(n);
    const pos = (o) => o.getWorldPosition(new THREE.Vector3());
    // the glass hand is the one that comes closest to the head during the clip
    let best = null;
    for (const side of ['R', 'L']) {
      let minD = 1e9, lowT = 0, lowY = 1e9;
      for (let i = 0; i < 40; i++) {
        const t = clipD * i / 40; this.mixer.setTime(t); root.updateMatrixWorld(true);
        const h = pos(B(`Bip01_${side}_Hand`)); const d = h.distanceTo(pos(this.head));
        if (d < minD) minD = d;
        if (h.y < lowY) { lowY = h.y; lowT = t; }
      }
      if (!best || minD < best.minD) best = { side, minD, lowT };
    }
    const s = best.side;
    this.mixer.setTime(best.lowT); root.updateMatrixWorld(true);
    const hand = B(`Bip01_${s}_Hand`);
    const h = pos(hand), f1 = pos(B(`Bip01_${s}_Finger1`)), f3 = pos(B(`Bip01_${s}_Finger3`)), th = pos(B(`Bip01_${s}_Finger01`));
    const palm = h.clone().add(f1).add(f3).multiplyScalar(1 / 3);
    const n = new THREE.Vector3().crossVectors(f1.clone().sub(h), f3.clone().sub(h)).normalize();
    if (n.dot(th.clone().sub(palm)) < 0) n.negate();
    const center = palm.addScaledVector(n, kind === 'pint' ? 0.045 : 0.03);
    const g = new THREE.Group();
    const glassM = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.05, metalness: 0, transmission: 0, transparent: true, opacity: 0.28, envMapIntensity: 2.0, depthWrite: false });
    if (kind === 'pint') {
      const prof = [[0.03, 0], [0.041, 0.15]].map(([r, y]) => new THREE.Vector2(r, y));
      g.add(new THREE.Mesh(new THREE.LatheGeometry(prof, 20), glassM));
      const liq = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.031, 0.11, 20), new THREE.MeshStandardMaterial({ color: 0xc8730f, roughness: 0.15, emissive: 0x2a1200 }));
      liq.position.y = 0.06; g.add(liq);
      const foam = new THREE.Mesh(new THREE.CylinderGeometry(0.039, 0.038, 0.014, 20), new THREE.MeshStandardMaterial({ color: 0xf0e6d0, roughness: 0.8 }));
      foam.position.y = 0.122; g.add(foam);
      g.position.y = -0.075;
    } else {
      const prof = [[0.033, 0], [0.033, 0.003], [0.004, 0.006], [0.004, 0.09], [0.03, 0.12], [0.04, 0.16], [0.034, 0.2]].map(([r, y]) => new THREE.Vector2(r, y));
      g.add(new THREE.Mesh(new THREE.LatheGeometry(prof, 20), glassM));
      const liq = new THREE.Mesh(new THREE.SphereGeometry(0.034, 16, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x6a0a14, roughness: 0.1 }));
      liq.position.y = 0.14; liq.scale.y = 1.0; g.add(liq);
      g.position.y = -0.09;                       // hold by the stem
    }
    const holder = new THREE.Group();
    holder.add(g);
    hand.add(holder);
    const ws = hand.getWorldScale(new THREE.Vector3());
    holder.scale.set(1 / ws.x, 1 / ws.y, 1 / ws.z);
    holder.position.copy(hand.worldToLocal(center.clone()));
    const qh = hand.getWorldQuaternion(new THREE.Quaternion());
    holder.quaternion.copy(qh.invert());             // upright while holding
    holder.traverse((o) => { o.frustumCulled = false; });
  }
  update(dt) {
    if (this.alt) {
      this.altTimer -= dt;
      if (this.altTimer <= 0) {
        const cur = this.playingAlt ? this.alt : this.main, next = this.playingAlt ? this.main : this.alt;
        next.reset(); next.play(); cur.crossFadeTo(next, 1.2, false);
        if (!this.playingAlt && next.getClip().duration < 10) {
          next.setLoop(THREE.LoopOnce, 1); next.clampWhenFinished = true;
          this.altTimer = next.getClip().duration - 1.3;
        } else {
          next.setLoop(THREE.LoopRepeat, Infinity);
          this.altTimer = this.playingAlt ? 10 + rnd() * 18 : 8 + rnd() * 10;
        }
        this.playingAlt = !this.playingAlt;
      }
    }
    this.mixer.update(dt);
    this.root.updateMatrixWorld(true);
    updateLook(this, dt);
  }
}

// waiter walking between tables
function inPlace(c) {
  const t = c.tracks.find((t) => t.name === 'Bip01_Pelvis.position');
  if (!t) return;
  const v = t.values, n = v.length / 3;
  // travel axis = component with the largest drift between first and last key
  let ax = 0, best = -1;
  for (let k = 0; k < 3; k++) { const d = Math.abs(v[(n - 1) * 3 + k] - v[k]); if (d > best) { best = d; ax = k; } }
  const v0 = v[ax], v1 = v[(n - 1) * 3 + ax];
  for (let i = 0; i < n; i++) v[i * 3 + ax] -= v0 + (v1 - v0) * (i / (n - 1));
}
class Waiter {
  constructor(spec, root, walk, idle) {
    this.root = root; this.look = 0.25;
    this.group = new THREE.Group(); this.group.add(root); scene.add(this.group);
    this.mixer = new THREE.AnimationMixer(root);
    // measure speed before making the walk cycle in-place
    const probe = this.mixer.clipAction(walk); probe.play();
    const pel = root.getObjectByName('Bip01_Pelvis');
    this.mixer.setTime(0); root.updateMatrixWorld(true); const a = pel.getWorldPosition(new THREE.Vector3());
    this.mixer.setTime(walk.duration - 1e-3); root.updateMatrixWorld(true); const b = pel.getWorldPosition(new THREE.Vector3());
    a.y = b.y = 0; this.speed = a.distanceTo(b) / walk.duration || 0.75;
    probe.stop(); this.mixer.uncacheAction(walk);
    inPlace(walk);
    this.walk = this.mixer.clipAction(walk); this.idle = this.mixer.clipAction(idle);
    this.walk.play();
    this.path = spec.path.map((p) => ({ p: new THREE.Vector3(...p.p), wait: p.wait, face: p.face }));
    this.i = 0; this.group.position.copy(this.path[0].p); this.state = 'walk'; this.waitT = 0;
    this.group.rotation.y = Math.atan2(this.path[1].p.x - this.path[0].p.x, this.path[1].p.z - this.path[0].p.z);
    this.mixer.update(0);
    setupLook(this);
    this.neckFwd = this.fwdLocal;
    // soft contact shadow
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d'); const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(0,0,0,0.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    const sh = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, toneMapped: false }));
    sh.rotation.x = -Math.PI / 2; sh.position.y = 0.005; this.group.add(sh);
  }
  update(dt) {
    const tgt = this.path[(this.i + 1) % this.path.length];
    if (this.state === 'walk') {
      const pos = this.group.position;
      const to = tmpV.subVectors(tgt.p, pos); to.y = 0;
      const dist = to.length();
      const yaw = Math.atan2(to.x, to.z);
      let dy = yaw - this.group.rotation.y; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      this.group.rotation.y += dy * Math.min(1, dt * 4);
      const step = this.speed * dt;
      if (dist <= step + 0.02) {
        pos.copy(tgt.p); this.i = (this.i + 1) % this.path.length;
        if (tgt.wait > 0) { this.state = 'wait'; this.waitT = tgt.wait; this.faceYaw = tgt.face; this.idle.reset().play(); this.walk.crossFadeTo(this.idle, 0.5, false); }
      } else {
        pos.addScaledVector(to.normalize(), step);
      }
    } else {
      this.waitT -= dt;
      if (this.faceYaw != null) {
        let dy = this.faceYaw - this.group.rotation.y; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
        this.group.rotation.y += dy * Math.min(1, dt * 3);
      }
      if (this.waitT <= 0) { this.state = 'walk'; this.walk.reset().play(); this.idle.crossFadeTo(this.walk, 0.5, false); }
    }
    this.mixer.update(dt);
    this.root.updateMatrixWorld(true);
    updateLook(this, dt);
  }
}

const actors = [];
await Promise.all(L.people.map(async (spec) => {
  const [root, ...clips] = await Promise.all([avatar(spec.avatar), ...spec.anims.map(clip)]);
  actors.push(new Person(spec, root, clips));
}));
{
  const w = L.waiter;
  const [root, walk, idle] = await Promise.all([avatar(w.avatar), clip(w.walk), clip(w.idle)]);
  // waiter needs its own clip copies (walk gets modified)
  actors.push(new Waiter(w, root, walk.clone(), idle));
}

// ------------------------------------------------------------------ view / input
let yaw = +(Q.get('yaw') || 0), pitch = +(Q.get('pitch') || -0.08);
function placeDesktopCamera() {
  camera.position.copy(CAP);
  camera.rotation.set(pitch, yaw, 0, 'YXZ');
}
placeDesktopCamera();
let drag = null;
renderer.domElement.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, yaw, pitch }; renderer.domElement.setPointerCapture(e.pointerId); });
renderer.domElement.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const k = 2.2 / Math.max(innerWidth, innerHeight) * (camera.fov / 70);
  yaw = drag.yaw + (e.clientX - drag.x) * k * Math.PI / 2;
  pitch = THREE.MathUtils.clamp(drag.pitch + (e.clientY - drag.y) * k * Math.PI / 2, -1.3, 1.3);
});
addEventListener('pointerup', () => { drag = null; });
renderer.domElement.addEventListener('wheel', (e) => {
  camera.fov = THREE.MathUtils.clamp(camera.fov + e.deltaY * 0.03, 35, 95); camera.updateProjectionMatrix();
}, { passive: true });
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight);
});

// ------------------------------------------------------------------ XR session
// Recenter: wherever the singer stands/looks becomes "on stage, facing the audience".
let recenterIn = -1;
function recenter() {
  const p = camera.position;                                   // head pose in rig space (set by WebXR)
  const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
  const psi = e.y;
  rig.rotation.set(0, -psi, 0);
  const off = new THREE.Vector3(p.x, 0, p.z).applyAxisAngle(new THREE.Vector3(0, 1, 0), -psi);
  rig.position.set(CAP.x - off.x, L.stageFloor, CAP.z - off.z);
}
renderer.xr.addEventListener('sessionstart', () => {
  rig.position.set(CAP.x, L.stageFloor, CAP.z);       // user's real floor = stage floor
  rig.rotation.set(0, 0, 0);
  camera.position.set(0, 0, 0); camera.rotation.set(0, 0, 0);
  recenterIn = performance.now() + 700;               // once the first head pose arrives
  for (let i = 0; i < 2; i++) {
    const c = renderer.xr.getController(i);
    c.addEventListener('selectstart', recenter);       // trigger / pinch = recenter
    rig.add(c);
  }
});
renderer.xr.addEventListener('sessionend', () => {
  rig.position.set(0, 0, 0); rig.rotation.set(0, 0, 0);
  placeDesktopCamera();
  $('enterSmall').style.display = 'block';
});

async function enterVR() {
  try {
    const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor', 'bounded-floor'] });
    await renderer.xr.setSession(session);
    $('ui').classList.add('hidden'); $('enterSmall').style.display = 'none';
  } catch (err) {
    $('msg').textContent = 'Не удалось запустить VR: ' + err.message;
  }
}
const xrOK = !!navigator.xr && await navigator.xr.isSessionSupported('immersive-vr').catch(() => false);
$('prog').style.width = '100%';
$('enterView').disabled = false;
if (xrOK) { $('enterVR').disabled = false; $('msg').textContent = 'Готово. Нажмите «Войти в VR». В шлеме нажмите курок, чтобы встать лицом к залу.'; }
else { $('enterVR').textContent = 'VR недоступен в этом браузере'; $('msg').textContent = 'Откройте эту ссылку в браузере шлема Meta Quest для режима VR.'; }
$('enterVR').onclick = enterVR;
$('enterSmall').onclick = enterVR;
$('enterView').onclick = () => {
  $('ui').classList.add('hidden'); if (xrOK) $('enterSmall').style.display = 'block';
  $('hint').style.opacity = 1; setTimeout(() => ($('hint').style.opacity = 0), 4000);
};

// ------------------------------------------------------------------ loop
const clock = new THREE.Clock();
function frame(dt) {
  if (!renderer.xr.isPresenting) camera.rotation.set(pitch, yaw, 0, 'YXZ');
  else if (recenterIn > 0 && performance.now() > recenterIn) { recenterIn = -1; recenter(); }
  camera.getWorldPosition(target);
  for (const a of actors) a.update(dt);
  renderer.render(scene, camera);
}
if (TEST) {
  // deterministic stepping for automated previews
  window.renderAt = (t, y, p) => {
    if (y !== undefined) { yaw = y; pitch = p; }
    const steps = Math.max(1, Math.round(t * 30));
    for (let i = 0; i < steps; i++) { camera.getWorldPosition(target); for (const a of actors) a.update(1 / 30); }
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
    renderer.render(scene, camera);
  };
  $('ui').style.display = 'none';
  window.renderAt(+(Q.get('t') || 2));
  window.done = true;
} else {
  renderer.setAnimationLoop(() => frame(Math.min(clock.getDelta(), 0.05)));
}
window.__bar = { rig, camera, renderer, recenter, actors };
