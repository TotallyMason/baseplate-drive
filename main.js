/* ============================================================
   Baseplate Drive
   Real-time raycast-vehicle simulator on a flat baseplate.
   Physics: Rapier3D vehicle controller @ fixed 60 Hz
   Render:  Three.js, locked to a 30 fps target with adaptive
            resolution so slow GPUs keep the frame rate.
   ============================================================ */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import RAPIER from 'https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.12.0/rapier.es.js';

const TARGET_FPS = 30;
const FIXED_DT = 1 / 60;
const MAX_SUBSTEPS = 4;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const damp = (current, target, lambda, dt) => current + (target - current) * (1 - Math.exp(-lambda * dt));
const lerp = (a, b, t) => a + (b - a) * t;

await RAPIER.init();

/* ------------------------------------------------------------------ *
 * Renderer, scene, camera
 * ------------------------------------------------------------------ */
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.70;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const BASE_PR = Math.min(window.devicePixelRatio || 1, 1.75);
let renderScale = 1;
let renderWidth = 1, renderHeight = 1;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, 1, 0.05, 2200);

/* Outdoor sky + image-based lighting.
   A small procedural equirectangular sky is baked into a PMREM env map so the
   car paint picks up a real sun highlight, horizon bounce and ground fill. */
const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();

const SUN_DIR = new THREE.Vector3(70, 110, 55).normalize();

(function buildSky() {
  const w = 1024, h = 512;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');

  // sky dome
  const sky = ctx.createLinearGradient(0, 0, 0, h * 0.52);
  sky.addColorStop(0.00, '#0d2135');
  sky.addColorStop(0.30, '#244864');
  sky.addColorStop(0.62, '#5f8199');
  sky.addColorStop(0.86, '#a9b3af');
  sky.addColorStop(1.00, '#d9caaa');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h * 0.52);

  // ground hemisphere
  const ground = ctx.createLinearGradient(0, h * 0.52, 0, h);
  ground.addColorStop(0.00, '#a49d8c');
  ground.addColorStop(0.35, '#6f6b61');
  ground.addColorStop(1.00, '#37352f');
  ctx.fillStyle = ground;
  ctx.fillRect(0, h * 0.52, w, h * 0.48);

  // sun position on the equirect map
  const su = (0.5 + Math.atan2(SUN_DIR.z, SUN_DIR.x) / (Math.PI * 2)) * w;
  const sv = (0.5 - Math.asin(SUN_DIR.y) / Math.PI) * h;

  // broad atmospheric glow
  const haze = ctx.createRadialGradient(su, sv, 2, su, sv, w * 0.26);
  haze.addColorStop(0.00, 'rgba(255,246,224,0.95)');
  haze.addColorStop(0.12, 'rgba(255,238,198,0.55)');
  haze.addColorStop(0.45, 'rgba(255,226,178,0.16)');
  haze.addColorStop(1.00, 'rgba(255,226,178,0)');
  ctx.fillStyle = haze;
  ctx.fillRect(0, 0, w, h);

  // sun disc with a hot core
  const sunGrad = ctx.createRadialGradient(su, sv, 0, su, sv, 16);
  sunGrad.addColorStop(0.00, 'rgba(255,255,250,1)');
  sunGrad.addColorStop(0.35, 'rgba(255,248,224,1)');
  sunGrad.addColorStop(0.70, 'rgba(255,232,178,0.55)');
  sunGrad.addColorStop(1.00, 'rgba(255,232,178,0)');
  ctx.fillStyle = sunGrad;
  ctx.beginPath();
  ctx.arc(su, sv, 20, 0, Math.PI * 2);
  ctx.fill();

  // faint horizon band
  const band = ctx.createLinearGradient(0, h * 0.47, 0, h * 0.56);
  band.addColorStop(0.0, 'rgba(244,236,218,0)');
  band.addColorStop(0.5, 'rgba(244,236,218,0.30)');
  band.addColorStop(1.0, 'rgba(244,236,218,0)');
  ctx.fillStyle = band;
  ctx.fillRect(0, h * 0.47, w, h * 0.09);

  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;

  scene.background = tex;
  scene.backgroundBlurriness = 0.0;
  scene.backgroundIntensity = 0.85;
  scene.fog = new THREE.Fog(0xaab3ae, 380, 1050);

  const env = pmrem.fromEquirectangular(tex).texture;
  scene.environment = env;
})();

/* Camera post stack: ACES tone mapping in OutputPass + a restrained bloom
   for sun glints, tail lights and the hot horizon. */
const composer = new EffectComposer(renderer);
composer.setPixelRatio(renderer.getPixelRatio());
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.30, 0.48, 0.86);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

const hemi = new THREE.HemisphereLight(0xcfe4fa, 0x6d6352, 0.55);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xfff2da, 2.5);
sun.position.set(70, 110, 55);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 260;
sun.shadow.camera.left = -34;
sun.shadow.camera.right = 34;
sun.shadow.camera.top = 34;
sun.shadow.camera.bottom = -34;
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.02;
scene.add(sun);
scene.add(sun.target);

const fill = new THREE.DirectionalLight(0xbfe0ff, 0.9);
fill.position.set(-50, 60, -80);
scene.add(fill);

/* ------------------------------------------------------------------ *
 * Baseplate
 * ------------------------------------------------------------------ */
const PLATE = 1200;

function baseplateTexture() {
  const size = 1024;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#8b8981';
  ctx.fillRect(0, 0, size, size);

  // subtle concrete mottling
  for (let i = 0; i < 2600; i++) {
    const v = 120 + Math.random() * 34;
    ctx.fillStyle = `rgba(${v},${v - 2},${v - 7},${0.03 + Math.random() * 0.06})`;
    const s = 2 + Math.random() * 26;
    ctx.fillRect(Math.random() * size, Math.random() * size, s, s);
  }

  // 10 m tile with 1 m subgrid
  ctx.strokeStyle = 'rgba(92,96,98,0.34)';
  ctx.lineWidth = 3;
  ctx.strokeRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(105,108,108,0.18)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 10; i++) {
    const p = (i / 10) * size;
    ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, p); ctx.lineTo(size, p); ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(PLATE / 10, PLATE / 10);
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function baseplateRoughness() {
  const size = 512;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#e6e6e6';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 900; i++) {
    const v = Math.round(190 + Math.random() * 65);
    ctx.fillStyle = `rgba(${v},${v},${v},0.35)`;
    const s = 6 + Math.random() * 46;
    ctx.beginPath();
    ctx.ellipse(Math.random() * size, Math.random() * size, s, s * (0.4 + Math.random()), Math.random() * 3.14, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(PLATE / 26, PLATE / 26);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

const plateMat = new THREE.MeshStandardMaterial({
  map: baseplateTexture(),
  roughnessMap: baseplateRoughness(),
  color: 0xffffff,
  roughness: 0.96,
  metalness: 0.04,
  envMapIntensity: 0.55
});

const plate = new THREE.Mesh(new THREE.PlaneGeometry(PLATE, PLATE), plateMat);
plate.rotation.x = -Math.PI / 2;
plate.receiveShadow = true;
scene.add(plate);

/* Painted markings */
function paintRing(radius, width, color, opacity) {
  const m = new THREE.Mesh(
    new THREE.RingGeometry(radius - width / 2, radius + width / 2, 128),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false })
  );
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.012;
  m.renderOrder = 2;
  scene.add(m);
  return m;
}
paintRing(24, 0.26, 0xf4f4ef, 0.72);
paintRing(25.4, 0.12, 0xff5a3c, 0.55);
paintRing(11, 0.16, 0xf4f4ef, 0.42);

/* Start line + timing strips */
(function addMarkings() {
  const lineMat = new THREE.MeshBasicMaterial({ color: 0xf6f4ea, transparent: true, opacity: 0.82, depthWrite: false });
  const line = new THREE.Mesh(new THREE.PlaneGeometry(26, 0.7), lineMat);
  line.rotation.x = -Math.PI / 2;
  line.position.set(0, 0.014, 0);
  line.renderOrder = 2;
  scene.add(line);

  const stripGeo = new THREE.PlaneGeometry(26, 0.24);
  for (let z = 50; z <= 500; z += 50) {
    const s = new THREE.Mesh(stripGeo, lineMat);
    s.rotation.x = -Math.PI / 2;
    s.position.set(0, 0.013, z);
    s.renderOrder = 2;
    scene.add(s);
  }

  // centre dashes down the main straight
  const dashMat = new THREE.MeshBasicMaterial({ color: 0xd9d4c4, transparent: true, opacity: 0.4, depthWrite: false });
  const dashGeo = new THREE.PlaneGeometry(0.22, 3.2);
  for (let z = 18; z < 500; z += 12) {
    const d = new THREE.Mesh(dashGeo, dashMat);
    d.rotation.x = -Math.PI / 2;
    d.position.set(-13, 0.013, z);
    d.renderOrder = 2;
    scene.add(d);
  }
})();

/* Plate lettering */
(function plateSign() {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 256;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, 1024, 256);
  ctx.fillStyle = 'rgba(52,58,62,0.42)';
  ctx.font = '900 118px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.letterSpacing = '22px';
  ctx.fillText('BASEPLATE', 512, 118);
  ctx.font = '700 44px -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
  ctx.fillStyle = 'rgba(52,58,62,0.3)';
  ctx.fillText('DRIVE  ·  30 FPS', 512, 206);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(30, 7.5),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
  );
  m.rotation.x = -Math.PI / 2;
  m.position.set(0, 0.011, -26);
  m.renderOrder = 2;
  scene.add(m);
})();

/* Low tactile curb around the plate */
(function addCurbs() {
  const mat = new THREE.MeshStandardMaterial({ color: 0x87857f, roughness: 0.9 });
  const geo = new THREE.BoxGeometry(PLATE + 8, 0.9, 1.2);
  [[0, -PLATE / 2], [0, PLATE / 2]].forEach(([x, z]) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, 0.45, z);
    m.receiveShadow = true;
    scene.add(m);
  });
  const geo2 = new THREE.BoxGeometry(1.2, 0.9, PLATE + 8);
  [[-PLATE / 2, 0], [PLATE / 2, 0]].forEach(([x, z]) => {
    const m = new THREE.Mesh(geo2, mat);
    m.position.set(x, 0.45, z);
    m.receiveShadow = true;
    scene.add(m);
  });
})();

/* ------------------------------------------------------------------ *
 * Physics world
 * ------------------------------------------------------------------ */
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.timestep = FIXED_DT;

// ground
const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.6, 0));
world.createCollider(RAPIER.ColliderDesc.cuboid(PLATE / 2, 0.6, PLATE / 2).setFriction(1.0), groundBody);

// boundary curbs
function addWall(x, z, hx, hz) {
  const b = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, 0.45, z));
  world.createCollider(RAPIER.ColliderDesc.cuboid(hx, 0.45, hz).setFriction(0.6), b);
}
addWall(0, -PLATE / 2, PLATE / 2 + 4, 0.6);
addWall(0, PLATE / 2, PLATE / 2 + 4, 0.6);
addWall(-PLATE / 2, 0, 0.6, PLATE / 2 + 4);
addWall(PLATE / 2, 0, 0.6, PLATE / 2 + 4);

/* ------------------------------------------------------------------ *
 * Cones (dynamic bodies, just to give the plate life)
 * ------------------------------------------------------------------ */
const cones = [];
const coneBodyGeo = new THREE.ConeGeometry(0.24, 0.62, 18);
coneBodyGeo.translate(0, 0.31, 0);
const coneMat = new THREE.MeshStandardMaterial({ color: 0xff6a2b, roughness: 0.6 });
const bandGeo = new THREE.CylinderGeometry(0.17, 0.20, 0.10, 18);
const bandMat = new THREE.MeshStandardMaterial({ color: 0xf4f2e8, roughness: 0.55, emissive: 0x222222 });

function addCone(x, z) {
  const root = new THREE.Group();
  const body = new THREE.Mesh(coneBodyGeo, coneMat);
  body.castShadow = true;
  root.add(body);
  const band = new THREE.Mesh(bandGeo, bandMat);
  band.position.y = 0.30;
  band.castShadow = true;
  root.add(band);
  scene.add(root);

  const rb = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic().setTranslation(x, 0.32, z).setLinearDamping(0.2).setAngularDamping(0.4)
  );
  world.createCollider(
    RAPIER.ColliderDesc.cylinder(0.31, 0.24).setMass(1.4).setFriction(0.9).setRestitution(0.1),
    rb
  );
  cones.push({ root, body: rb, home: { x, z } });
  return rb;
}

for (let i = 0; i < 8; i++) {
  addCone(i % 2 === 0 ? -3.2 : 3.2, 34 + i * 9);
}
[[-19, -6], [19, -6], [-19, 12], [19, 12]].forEach(([x, z]) => addCone(x, z));

/* ------------------------------------------------------------------ *
 * Car model
 * ------------------------------------------------------------------ */
const carRoot = new THREE.Group();
scene.add(carRoot);

const paint = new THREE.MeshPhysicalMaterial({
  color: 0xc01424,
  metalness: 0.72,
  roughness: 0.26,
  clearcoat: 1.0,
  clearcoatRoughness: 0.07,
  envMapIntensity: 1.55
});
const darkTrim = new THREE.MeshStandardMaterial({ color: 0x14181c, metalness: 0.5, roughness: 0.45 });
const glassMat = new THREE.MeshPhysicalMaterial({
  color: 0x0b1218, metalness: 0.9, roughness: 0.05, transparent: true, opacity: 0.88,
  envMapIntensity: 1.6
});
const lightMat = new THREE.MeshStandardMaterial({ color: 0xf7f2df, emissive: 0xfff0cc, emissiveIntensity: 1.6, roughness: 0.25 });
const tailMat = new THREE.MeshStandardMaterial({ color: 0x360707, emissive: 0xff2018, emissiveIntensity: 1.1, roughness: 0.35 });
const rimMat = new THREE.MeshStandardMaterial({ color: 0xcfd6dc, metalness: 0.95, roughness: 0.22 });
const tyreMat = new THREE.MeshStandardMaterial({ color: 0x121316, roughness: 0.9, metalness: 0.02 });

/* Body: extruded side profile (length in +Z) */
(function buildBody() {
  const s = new THREE.Shape();
  s.moveTo(-2.16, -0.36);
  s.lineTo(-2.13, -0.02);
  s.lineTo(-1.88, 0.03);
  s.lineTo(-1.50, 0.30);
  s.lineTo(-1.12, 0.72);
  s.lineTo(-0.40, 0.78);
  s.lineTo(0.28, 0.67);
  s.lineTo(0.72, 0.31);
  s.lineTo(1.56, 0.26);
  s.lineTo(2.10, 0.12);
  s.lineTo(2.16, -0.36);
  s.lineTo(-2.16, -0.36);

  const width = 1.88;
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: width,
    bevelEnabled: true,
    bevelThickness: 0.045,
    bevelSize: 0.045,
    bevelSegments: 3,
    steps: 1,
    curveSegments: 8
  });
  geo.translate(0, 0, -width / 2);
  geo.rotateY(-Math.PI / 2);
  geo.computeVertexNormals();

  const body = new THREE.Mesh(geo, paint);
  body.castShadow = true;
  body.receiveShadow = true;
  carRoot.add(body);

  // glass band
  const glass = new THREE.Mesh(new THREE.BoxGeometry(1.56, 0.30, 1.62), glassMat);
  glass.position.set(0, 0.55, -0.34);
  glass.castShadow = true;
  carRoot.add(glass);

  // roof panel
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.46, 0.06, 1.18), paint);
  roof.position.set(0, 0.73, -0.30);
  carRoot.add(roof);

  // nose / splitter / diffuser
  const splitter = new THREE.Mesh(new THREE.BoxGeometry(1.78, 0.06, 0.38), darkTrim);
  splitter.position.set(0, -0.31, 2.02);
  carRoot.add(splitter);

  const diffuser = new THREE.Mesh(new THREE.BoxGeometry(1.66, 0.12, 0.34), darkTrim);
  diffuser.position.set(0, -0.28, -2.02);
  carRoot.add(diffuser);

  // side skirts
  [-1, 1].forEach((side) => {
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.10, 2.5), darkTrim);
    skirt.position.set(side * 0.95, -0.29, 0);
    carRoot.add(skirt);
  });

  // headlights
  [-0.62, 0.62].forEach((x) => {
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.09, 0.06), lightMat);
    lamp.position.set(x, 0.145, 2.14);
    carRoot.add(lamp);
  });

  // tail strip + rear valance + exhausts
  const tail = new THREE.Mesh(new THREE.BoxGeometry(1.52, 0.075, 0.05), tailMat);
  tail.position.set(0, 0.12, -2.15);
  carRoot.add(tail);

  const valance = new THREE.Mesh(new THREE.BoxGeometry(1.58, 0.20, 0.16), darkTrim);
  valance.position.set(0, -0.20, -2.12);
  carRoot.add(valance);

  [-0.46, 0.46].forEach((x) => {
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.12, 12), rimMat);
    pipe.rotation.x = Math.PI / 2;
    pipe.position.set(x, -0.26, -2.18);
    carRoot.add(pipe);
  });

  // mirrors
  [-1, 1].forEach((side) => {
    const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.09, 0.12), darkTrim);
    mirror.position.set(side * 1.0, 0.48, 0.45);
    carRoot.add(mirror);
  });

  // subtle rear wing
  const wing = new THREE.Mesh(new THREE.BoxGeometry(1.62, 0.045, 0.30), darkTrim);
  wing.position.set(0, 0.55, -1.92);
  wing.rotation.x = -0.10;
  carRoot.add(wing);
  [-0.66, 0.66].forEach((x) => {
    const stalk = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.16, 0.10), darkTrim);
    stalk.position.set(x, 0.46, -1.92);
    carRoot.add(stalk);
  });
})();

/* Wheels */
const WHEEL_RADIUS = 0.34;
const wheelGroups = [];
const wheelSpins = [];

function buildWheel() {
  const g = new THREE.Group();

  const tyreGeo = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.25, 26);
  tyreGeo.rotateZ(Math.PI / 2);
  const tyre = new THREE.Mesh(tyreGeo, tyreMat);
  tyre.castShadow = true;
  g.add(tyre);

  const rimGeo = new THREE.CylinderGeometry(0.215, 0.215, 0.262, 20);
  rimGeo.rotateZ(Math.PI / 2);
  const rim = new THREE.Mesh(rimGeo, rimMat);
  g.add(rim);

  // five spokes
  for (let i = 0; i < 5; i++) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.34, 0.055), rimMat);
    spoke.position.x = 0.133;
    spoke.rotation.x = (i / 5) * Math.PI * 2;
    g.add(spoke);
  }

  const cap = new THREE.Mesh(new THREE.CircleGeometry(0.07, 14), darkTrim);
  cap.rotation.y = Math.PI / 2;
  cap.position.x = 0.134;
  g.add(cap);

  scene.add(g);
  wheelGroups.push(g);
  return g;
}
for (let i = 0; i < 4; i++) wheelSpins.push(buildWheel());

/* Cockpit interior (visible in cockpit camera) */
const cockpit = new THREE.Group();
carRoot.add(cockpit);
(function buildInterior() {
  const dash = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.22, 0.62), new THREE.MeshStandardMaterial({ color: 0x171c21, roughness: 0.7 }));
  dash.position.set(0, 0.19, 0.52);
  cockpit.add(dash);

  const screen = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.22, 0.03), new THREE.MeshStandardMaterial({ color: 0x071018, emissive: 0x1a3a4a, emissiveIntensity: 0.7 }));
  screen.position.set(0, 0.36, 0.30);
  screen.rotation.x = -0.22;
  cockpit.add(screen);

  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.165, 0.030, 10, 26), new THREE.MeshStandardMaterial({ color: 0x0d1013, roughness: 0.65 }));
  wheel.position.set(-0.34, 0.47, 0.02);
  wheel.rotation.x = Math.PI / 2;
  cockpit.add(wheel);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.06, 12), rimMat);
  hub.rotation.x = Math.PI / 2;
  hub.position.set(-0.34, 0.47, 0.02);
  cockpit.add(hub);
  cockpit.userData.wheel = wheel;

  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.10, 0.56), new THREE.MeshStandardMaterial({ color: 0x1b2026, roughness: 0.85 }));
  seat.position.set(-0.34, 0.20, -0.62);
  cockpit.add(seat);
})();

/* Soft contact shadow under the car (cheap ambient-occlusion substitute) */
const contactShadow = (() => {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.08, size / 2, size / 2, size * 0.5);
  g.addColorStop(0.00, 'rgba(0,0,0,0.62)');
  g.addColorStop(0.42, 'rgba(0,0,0,0.36)');
  g.addColorStop(0.78, 'rgba(0,0,0,0.10)');
  g.addColorStop(1.00, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(4.7, 6.6),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.9 })
  );
  mesh.renderOrder = 2;
  scene.add(mesh);
  return mesh;
})();
const shadowQuad = new THREE.Quaternion();
const qFlat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);

/* ------------------------------------------------------------------ *
 * Rapier vehicle
 * ------------------------------------------------------------------ */
const SPAWN = { x: 0, y: 0.62, z: -6 };
const chassisBody = world.createRigidBody(
  RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(SPAWN.x, SPAWN.y, SPAWN.z)
    .setLinearDamping(0.06)
    .setAngularDamping(0.22)
    .setCcdEnabled(true)
);
world.createCollider(
  RAPIER.ColliderDesc.cuboid(0.94, 0.30, 2.16)
    .setMass(1380)
    .setFriction(0.45)
    .setRestitution(0.05),
  chassisBody
);

const vehicle = world.createVehicleController(chassisBody);

const wheelDefs = [
  { x: -0.86, y: 0.02, z: 1.38, front: true },   // front left
  { x: 0.86, y: 0.02, z: 1.38, front: true },    // front right
  { x: -0.86, y: 0.02, z: -1.38, front: false }, // rear left
  { x: 0.86, y: 0.02, z: -1.38, front: false }   // rear right
];

const WHEEL_REST = 0.26;
wheelDefs.forEach((w, i) => {
  vehicle.addWheel(
    { x: w.x, y: w.y, z: w.z },
    { x: 0, y: -1, z: 0 },
    { x: -1, y: 0, z: 0 },
    WHEEL_REST,
    WHEEL_RADIUS
  );
  vehicle.setWheelSuspensionStiffness(i, w.front ? 34 : 30);
  vehicle.setWheelSuspensionCompression(i, w.front ? 0.58 : 0.54);
  vehicle.setWheelSuspensionRelaxation(i, w.front ? 0.86 : 0.82);
  vehicle.setWheelMaxSuspensionTravel(i, 0.30);
  vehicle.setWheelSuspensionRestLength(i, WHEEL_REST);
  vehicle.setWheelFrictionSlip(i, w.front ? 1.72 : 1.56);
  vehicle.setWheelSideFrictionStiffness(i, 1.0);
  vehicle.setWheelRadius(i, WHEEL_RADIUS);
});

/* ------------------------------------------------------------------ *
 * Drivetrain
 * ------------------------------------------------------------------ */
const GEARS = [3.60, 2.19, 1.55, 1.18, 0.95, 0.78];
const REVERSE_RATIO = 3.40;
const FINAL_DRIVE = 3.55;
const DRIVETRAIN_EFF = 0.90;

let gear = 1;
let manualMode = false;
let shiftCooldown = 0;
let reverseHold = 0;
let engineRpm = 900;
let wheelAngularSpeed = 0;
let engineForce = 0;

function torqueAt(rpm) {
  const x = rpm / 1000;
  const curve = 0.55 + 0.80 * Math.exp(-Math.pow((x - 4.3) / 2.35, 2));
  return 385 * curve; // Nm
}

function ratioFor(g) {
  if (g === -1) return REVERSE_RATIO;
  return GEARS[clamp(g - 1, 0, GEARS.length - 1)];
}

/* ------------------------------------------------------------------ *
 * Input
 * ------------------------------------------------------------------ */
const input = {
  throttle: false,
  brake: false,
  left: false,
  right: false,
  handbrake: false
};
let steerInput = 0;
let steerAngle = 0;
let paused = false;
let started = false;
let cameraMode = 0;
let muted = false;

const keys = new Set();
window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) e.preventDefault();
  if (keys.has(k)) return;
  keys.add(k);

  if (k === 'w' || k === 'arrowup') input.throttle = true;
  if (k === 's' || k === 'arrowdown') input.brake = true;
  if (k === 'a' || k === 'arrowleft') input.left = true;
  if (k === 'd' || k === 'arrowright') input.right = true;
  if (k === ' ') input.handbrake = true;

  if (k === 'r') resetCar();
  if (k === 'c') cameraMode = (cameraMode + 1) % 2;
  if (k === 'm') { muted = !muted; audio.setMuted(muted); }
  if (k === 't') { manualMode = !manualMode; document.getElementById('transMode').textContent = manualMode ? 'MANUAL' : 'AUTO'; }
  if (k === 'e' && manualMode) shift(1);
  if (k === 'q' && manualMode) shift(-1);
  if (k === 'escape') togglePause();
});

window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  keys.delete(k);
  if (k === 'w' || k === 'arrowup') input.throttle = false;
  if (k === 's' || k === 'arrowdown') input.brake = false;
  if (k === 'a' || k === 'arrowleft') input.left = false;
  if (k === 'd' || k === 'arrowright') input.right = false;
  if (k === ' ') input.handbrake = false;
});

window.addEventListener('blur', () => {
  input.throttle = input.brake = input.left = input.right = input.handbrake = false;
  keys.clear();
});

function shift(direction) {
  if (shiftCooldown > 0) return;
  const next = clamp(gear + direction, -1, GEARS.length);
  if (next === gear) return;
  gear = next;
  shiftCooldown = 0.24;
}

/* ------------------------------------------------------------------ *
 * Skid marks
 * ------------------------------------------------------------------ */
class SkidMarks {
  constructor(max = 1100) {
    this.max = max;
    this.cursor = 0;
    this.count = 0;
    this.positions = new Float32Array(max * 4 * 3);
    const indices = new Uint32Array(max * 6);
    for (let i = 0; i < max; i++) {
      const v = i * 4;
      const o = i * 6;
      indices[o] = v;
      indices[o + 1] = v + 1;
      indices[o + 2] = v + 2;
      indices[o + 3] = v;
      indices[o + 4] = v + 2;
      indices[o + 5] = v + 3;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), PLATE);
    this.geo = geo;
    this.mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        color: 0x0c0d0e,
        transparent: true,
        opacity: 0.34,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2
      })
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    scene.add(this.mesh);
  }

  add(x, z, fx, fz, width, length) {
    const rx = fz, rz = -fx;
    const hw = width / 2, hl = length / 2;
    const i = this.cursor * 12;
    const p = this.positions;
    p[i] = x - rx * hw - fx * hl; p[i + 1] = 0.017; p[i + 2] = z - rz * hw - fz * hl;
    p[i + 3] = x + rx * hw - fx * hl; p[i + 4] = 0.017; p[i + 5] = z + rz * hw - fz * hl;
    p[i + 6] = x + rx * hw + fx * hl; p[i + 7] = 0.017; p[i + 8] = z + rz * hw + fz * hl;
    p[i + 9] = x - rx * hw + fx * hl; p[i + 10] = 0.017; p[i + 11] = z - rz * hw + fz * hl;
    this.geo.attributes.position.needsUpdate = true;
    this.cursor = (this.cursor + 1) % this.max;
    this.count = Math.min(this.max, this.count + 1);
  }
}
const skidMarks = new SkidMarks();

/* ------------------------------------------------------------------ *
 * Tyre smoke
 * ------------------------------------------------------------------ */
class Smoke {
  constructor(max = 220) {
    this.max = max;
    this.cursor = 0;
    this.pos = new Float32Array(max * 3);
    this.alpha = new Float32Array(max);
    this.size = new Float32Array(max);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('psize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo = geo;

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {},
      vertexShader: `
        attribute float alpha;
        attribute float psize;
        varying float vAlpha;
        void main() {
          vAlpha = alpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = psize * (260.0 / max(1.0, -mv.z));
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        varying float vAlpha;
        void main() {
          vec2 d = gl_PointCoord - vec2(0.5);
          float r = length(d);
          float a = smoothstep(0.5, 0.08, r) * vAlpha;
          if (a < 0.01) discard;
          gl_FragColor = vec4(0.82, 0.82, 0.80, a * 0.55);
        }
      `
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.renderOrder = 4;
    scene.add(points);
    this.points = points;
  }

  emit(x, y, z, power) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = (Math.random() - 0.5) * 1.6;
    this.vel[i * 3 + 1] = 0.6 + Math.random() * 0.8;
    this.vel[i * 3 + 2] = (Math.random() - 0.5) * 1.6;
    this.alpha[i] = 0.5 * power;
    this.size[i] = 24 + Math.random() * 26;
    this.life[i] = 1.4 + Math.random() * 0.8;
  }

  update(dt) {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
      this.life[i] -= dt;
      this.alpha[i] = Math.max(0, this.alpha[i] - dt * 0.36);
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.vel[i * 3] *= 1 - dt * 0.9;
      this.vel[i * 3 + 2] *= 1 - dt * 0.9;
      this.size[i] += dt * 34;
      if (this.pos[i * 3 + 1] < 0.05) this.pos[i * 3 + 1] = 0.05;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.alpha.needsUpdate = true;
    this.geo.attributes.psize.needsUpdate = true;
  }
}
const smoke = new Smoke();

/* ------------------------------------------------------------------ *
 * Audio
 * ------------------------------------------------------------------ */
class EngineAudio {
  constructor() {
    this.ctx = null;
    this.muted = false;
  }

  start() {
    if (this.ctx) { this.ctx.resume(); return; }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.42;
    this.master.connect(ctx.destination);

    // engine tone
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0.0001;
    this.engFilter = ctx.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.frequency.value = 620;
    this.engFilter.Q.value = 1.4;
    this.engGain.connect(this.engFilter);
    this.engFilter.connect(this.master);

    this.osc1 = ctx.createOscillator();
    this.osc1.type = 'sawtooth';
    this.osc1.frequency.value = 50;
    this.osc2 = ctx.createOscillator();
    this.osc2.type = 'square';
    this.osc2.frequency.value = 25;
    const g2 = ctx.createGain();
    g2.gain.value = 0.38;
    this.osc1.connect(this.engGain);
    this.osc2.connect(g2);
    g2.connect(this.engGain);
    this.osc1.start();
    this.osc2.start();

    // noise buffer for wind + tyres
    const len = Math.floor(ctx.sampleRate * 2);
    const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0.0001;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 700;
    this.windFilter.Q.value = 0.55;
    const wind = ctx.createBufferSource();
    wind.buffer = buffer;
    wind.loop = true;
    wind.connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.master);
    wind.start();

    this.tyreGain = ctx.createGain();
    this.tyreGain.gain.value = 0.0001;
    this.tyreFilter = ctx.createBiquadFilter();
    this.tyreFilter.type = 'bandpass';
    this.tyreFilter.frequency.value = 1250;
    this.tyreFilter.Q.value = 2.2;
    const tyre = ctx.createBufferSource();
    tyre.buffer = buffer;
    tyre.loop = true;
    tyre.connect(this.tyreFilter);
    this.tyreFilter.connect(this.tyreGain);
    this.tyreGain.connect(this.master);
    tyre.start();
  }

  update(rpm, throttle, speed, slip, running) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const rpmNow = clamp(rpm, 700, 7800);
    const f = clamp(rpmNow / 30, 24, 270);
    this.osc1.frequency.setTargetAtTime(f, t, 0.035);
    this.osc2.frequency.setTargetAtTime(f * 0.5, t, 0.035);
    const load = (throttle ? 1 : 0) * 0.55 + clamp(rpmNow / 7000, 0, 1) * 0.45;
    this.engGain.gain.setTargetAtTime(running ? 0.035 + load * 0.085 : 0.0001, t, 0.06);
    this.engFilter.frequency.setTargetAtTime(420 + rpmNow * 0.20 + (throttle ? 700 : 0), t, 0.08);

    const s = clamp(speed / 60, 0, 1);
    this.windGain.gain.setTargetAtTime(0.012 + s * s * 0.10, t, 0.15);
    this.windFilter.frequency.setTargetAtTime(500 + s * 900, t, 0.15);

    this.tyreGain.gain.setTargetAtTime(clamp(slip, 0, 1) * 0.11, t, 0.06);
    this.tyreFilter.frequency.setTargetAtTime(900 + clamp(slip, 0, 1) * 800, t, 0.08);
  }

  setMuted(m) {
    this.muted = m;
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(m ? 0 : 0.42, this.ctx.currentTime, 0.05);
  }
}
const audio = new EngineAudio();

/* ------------------------------------------------------------------ *
 * Physics state helpers
 * ------------------------------------------------------------------ */
const forward = new THREE.Vector3();
const rightVec = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
const chassisPos = new THREE.Vector3();
const prevSpeed = { value: 0 };
let latG = 0, lonG = 0;
let slipAmount = 0;
let lastSkid = 0;

function getForward() {
  const r = chassisBody.rotation();
  tmpQ.set(r.x, r.y, r.z, r.w);
  forward.set(0, 0, 1).applyQuaternion(tmpQ);
  rightVec.set(1, 0, 0).applyQuaternion(tmpQ);
  return forward;
}

function resetCar() {
  chassisBody.setTranslation({ x: SPAWN.x, y: SPAWN.y, z: SPAWN.z }, true);
  chassisBody.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
  chassisBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
  chassisBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
  gear = 1;
  engineRpm = 900;
  shiftCooldown = 0;
  reverseHold = 0;
  steerAngle = 0;
  steerInput = 0;
}

/* ------------------------------------------------------------------ *
 * Fixed-step vehicle update
 * ------------------------------------------------------------------ */
function stepVehicle(dt) {
  shiftCooldown = Math.max(0, shiftCooldown - dt);

  const lin = chassisBody.linvel();
  const ang = chassisBody.angvel();
  const fwd = getForward();
  const speed = lin.x * fwd.x + lin.z * fwd.z;
  const speedAbs = Math.abs(speed);

  // steering input with speed-sensitive lock and Ackermann-ish split
  const steerTarget = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  steerInput = damp(steerInput, steerTarget, steerTarget === 0 ? 9 : 6, dt);
  const maxLock = lerp(0.60, 0.15, clamp(speedAbs / 58, 0, 1));
  const targetAngle = steerInput * maxLock;
  steerAngle = damp(steerAngle, targetAngle, 11, dt);

  // automatic gearbox
  if (!manualMode) {
    if (gear === -1) {
      if (input.throttle && !input.brake) gear = 1;
    } else if (speedAbs < 0.45 && input.brake && !input.throttle) {
      reverseHold += dt;
      if (reverseHold > 0.45) { gear = -1; reverseHold = 0; }
    } else {
      reverseHold = 0;
      if (gear < 1) gear = 1;
      if (gear > 1 && engineRpm < 2050 && shiftCooldown <= 0) { gear--; shiftCooldown = 0.28; }
      if (gear < GEARS.length && engineRpm > 6750 && input.throttle && shiftCooldown <= 0) { gear++; shiftCooldown = 0.30; }
    }
  } else if (gear < 1) {
    if (speedAbs < 0.45 && input.brake && !input.throttle) {
      reverseHold += dt;
      if (reverseHold > 0.45) { gear = -1; reverseHold = 0; }
    } else {
      reverseHold = 0;
      if (gear === -1 && input.throttle) gear = 1;
    }
  }

  // engine rpm from wheel speed (with a little clutch slip off the line)
  const ratio = ratioFor(gear);
  const wheelRps = speedAbs / (Math.PI * 2 * WHEEL_RADIUS);
  let rpm = wheelRps * ratio * FINAL_DRIVE * 60;
  if (gear > 0 && input.throttle && speedAbs < 6) {
    rpm = Math.max(rpm, 900 + input.throttle * (1800 + speedAbs * 180));
  }
  rpm = clamp(rpm, 850, 7600);
  engineRpm = damp(engineRpm, rpm, 12, dt);

  // throttle direction differs in reverse
  const throttlePedal = gear === -1 ? (input.brake ? 1 : 0) : (input.throttle ? 1 : 0);
  const brakePedal = gear === -1 ? (input.throttle ? 1 : 0) : (input.brake ? 1 : 0);

  const torque = torqueAt(engineRpm) * throttlePedal * DRIVETRAIN_EFF;
  let force = torque * ratio * FINAL_DRIVE / WHEEL_RADIUS;
  if (gear === -1) force = -force;
  // traction control / mechanical sympathy
  force = clamp(force, -10500, 10500);

  // engine braking when off throttle
  const engineBrake = throttlePedal < 0.05 ? 95 : 0;

  // brakes
  const baseBrake = 3200 * brakePedal + engineBrake;
  const rearBrake = 2100 * brakePedal + engineBrake + (input.handbrake ? 4200 : 0);

  for (let i = 0; i < 4; i++) {
    const front = wheelDefs[i].front;
    vehicle.setWheelBrake(i, front ? baseBrake : rearBrake);
    vehicle.setWheelFrictionSlip(i, input.handbrake && !front ? 0.72 : (front ? 1.72 : 1.56));
    if (front) {
      const inner = steerAngle;
      const outer = steerAngle * 0.84;
      vehicle.setWheelSteering(i, steerAngle >= 0 ? (i === 0 ? inner : outer) : (i === 0 ? outer : inner));
    }
  }

  // rear-wheel drive
  vehicle.setWheelEngineForce(0, 0);
  vehicle.setWheelEngineForce(1, 0);
  vehicle.setWheelEngineForce(2, force / 2);
  vehicle.setWheelEngineForce(3, force / 2);

  vehicle.updateVehicle(dt);

  // aerodynamic drag + downforce + rolling resistance
  const v = chassisBody.linvel();
  const vLen = Math.sqrt(v.x * v.x + v.z * v.z);
  if (vLen > 0.1) {
    const drag = 0.415 * vLen * vLen;
    const roll = 190;
    chassisBody.addForce({
      x: (-v.x / vLen) * (drag + roll),
      y: 0,
      z: (-v.z / vLen) * (drag + roll)
    }, true);
  }
  chassisBody.addForce({ x: 0, y: -0.30 * vLen * vLen, z: 0 }, true);

  world.step();

  // measurement for HUD / effects
  const after = chassisBody.linvel();
  const speedAfter = after.x * fwd.x + after.z * fwd.z;
  const yawRate = ang.y;
  const latAccel = yawRate * speedAfter;
  const lonAccel = (speedAfter - prevSpeed.value) / dt;
  prevSpeed.value = speedAfter;
  latG = damp(latG, latAccel / 9.81, 6, dt);
  lonG = damp(lonG, lonAccel / 9.81, 6, dt);
  wheelAngularSpeed = speedAfter;

  const latVel = after.x * rightVec.x + after.z * rightVec.z;
  const slipTarget = clamp((Math.abs(latVel) - 1.2) / 7, 0, 1) +
    (input.handbrake && speedAbs > 3 ? 0.35 : 0) +
    (throttlePedal > 0.8 && speedAbs < 9 ? 0.22 : 0);
  slipAmount = damp(slipAmount, clamp(slipTarget, 0, 1), 5, dt);

  // skid marks + smoke from rear contact points
  if (slipAmount > 0.18 && speedAbs > 2.5) {
    const fade = 1;
    for (let i = 2; i < 4; i++) {
      const cp = vehicle.wheelContactPoint(i);
      if (!cp) continue;
      if (performance.now() - lastSkid > 24) {
        skidMarks.add(cp.x, cp.z, fwd.x, fwd.z, 0.24, clamp(speedAbs * dt * 1.8, 0.35, 1.6) * fade);
      }
      if (Math.random() < 0.55) {
        smoke.emit(cp.x, 0.10, cp.z, clamp(slipAmount * 1.4, 0.25, 1));
      }
    }
    if (performance.now() - lastSkid > 24) lastSkid = performance.now();
  }

  // safety net
  const t = chassisBody.translation();
  if (t.y < -4 || Math.abs(t.x) > PLATE / 2 - 4 || Math.abs(t.z) > PLATE / 2 - 4) resetCar();
}

/* ------------------------------------------------------------------ *
 * Wheel / car visuals
 * ------------------------------------------------------------------ */
const qSteer = new THREE.Quaternion();
const qSpin = new THREE.Quaternion();
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_X = new THREE.Vector3(1, 0, 0);
const chassisQuat = new THREE.Quaternion();

function syncVisuals(dt) {
  const t = chassisBody.translation();
  const r = chassisBody.rotation();
  chassisQuat.set(r.x, r.y, r.z, r.w);
  carRoot.position.set(t.x, t.y, t.z);
  carRoot.quaternion.copy(chassisQuat);

  for (let i = 0; i < 4; i++) {
    const def = wheelDefs[i];
    const suspension = vehicle.wheelSuspensionLength(i);
    tmpV.set(def.x, def.y - suspension, def.z).applyQuaternion(chassisQuat);
    const g = wheelGroups[i];
    g.position.set(t.x + tmpV.x, t.y + tmpV.y, t.z + tmpV.z);

    qSteer.setFromAxisAngle(AXIS_Y, vehicle.wheelSteering(i));
    qSpin.setFromAxisAngle(AXIS_X, vehicle.wheelRotation(i));
    g.quaternion.copy(chassisQuat).multiply(qSteer).multiply(qSpin);
  }

  // brake / reverse lights
  const braking = input.brake || input.handbrake;
  tailMat.emissiveIntensity = braking ? 2.6 : 1.1;

  // steering wheel in cockpit
  if (cockpit.userData.wheel) {
    cockpit.userData.wheel.rotation.z = -steerAngle * 2.6;
  }

  // contact shadow follows and rotates with the car
  const yaw = Math.atan2(forward.x, forward.z);
  shadowQuad.setFromAxisAngle(AXIS_Y, yaw).multiply(qFlat);
  contactShadow.position.set(t.x, 0.019, t.z);
  contactShadow.quaternion.copy(shadowQuad);

  // sun shadow follows the car
  sun.position.set(t.x + 70, 110, t.z + 55);
  sun.target.position.set(t.x, 0, t.z);

  // interior hidden unless cockpit
  cockpit.visible = cameraMode === 1;
}

/* ------------------------------------------------------------------ *
 * Camera
 * ------------------------------------------------------------------ */
let camPos = new THREE.Vector3(0, 3, -14);
let camLook = new THREE.Vector3(0, 0.6, 4);
let cameraFov = 62;
const eye = new THREE.Vector3();
const lookAt = new THREE.Vector3();

function updateCamera(dt) {
  const t = chassisBody.translation();
  const r = chassisBody.rotation();
  chassisQuat.set(r.x, r.y, r.z, r.w);
  const speed = Math.abs(wheelAngularSpeed);

  if (cameraMode === 1) {
    eye.set(-0.34, 0.44, -0.44).applyQuaternion(chassisQuat);
    camera.position.set(t.x + eye.x, t.y + eye.y, t.z + eye.z);
    camera.quaternion.copy(chassisQuat);
    // slight pitch with acceleration, small steer lean
    const pitch = clamp(lonG * 0.012, -0.03, 0.03);
    camera.rotateX(pitch - 0.015);
    camera.rotateY(-steerAngle * 0.06);
    cameraFov = damp(cameraFov, 70 + clamp(speed / 60, 0, 1) * 6, 4, dt);
  } else {
    const dist = 6.5 + clamp(speed / 55, 0, 1) * 2.3;
    const height = 1.62 + clamp(speed / 55, 0, 1) * 0.3;
    tmpV.set(0, height, -dist).applyQuaternion(chassisQuat);
    const desiredX = t.x + tmpV.x;
    const desiredY = Math.max(0.55, t.y + tmpV.y);
    const desiredZ = t.z + tmpV.z;

    camPos.x = damp(camPos.x, desiredX, 6.5, dt);
    camPos.y = damp(camPos.y, desiredY, 6.5, dt);
    camPos.z = damp(camPos.z, desiredZ, 6.5, dt);
    camera.position.copy(camPos);

    tmpV.set(0, 0.80, 5.2).applyQuaternion(chassisQuat);
    lookAt.set(t.x + tmpV.x, t.y + tmpV.y, t.z + tmpV.z);
    camLook.x = damp(camLook.x, lookAt.x, 8, dt);
    camLook.y = damp(camLook.y, lookAt.y, 8, dt);
    camLook.z = damp(camLook.z, lookAt.z, 8, dt);
    camera.lookAt(camLook);

    cameraFov = damp(cameraFov, 60 + clamp(speed / 55, 0, 1) * 10, 4, dt);
  }

  if (Math.abs(camera.fov - cameraFov) > 0.05) {
    camera.fov = cameraFov;
    camera.updateProjectionMatrix();
  }
}

/* ------------------------------------------------------------------ *
 * HUD
 * ------------------------------------------------------------------ */
const $ = (id) => document.getElementById(id);
const hud = {
  fps: $('fps'),
  quality: $('quality'),
  speed: $('speed'),
  gear: $('gear'),
  rpm: $('rpm'),
  rpmFill: $('rpmFill'),
  glat: $('glat'),
  glon: $('glon'),
  steer: $('steer'),
  needle: $('needle'),
  throttle: $('throttleFill'),
  brake: $('brakeFill'),
  tyre: $('tyreState')
};

(function buildDial() {
  const svg = $('dial');
  const ns = 'http://www.w3.org/2000/svg';
  const cx = 110, cy = 110;

  const bg = document.createElementNS(ns, 'circle');
  bg.setAttribute('cx', cx); bg.setAttribute('cy', cy); bg.setAttribute('r', 96);
  bg.setAttribute('fill', 'rgba(7,12,18,0.72)');
  bg.setAttribute('stroke', 'rgba(190,225,245,0.20)');
  bg.setAttribute('stroke-width', '1.5');
  svg.appendChild(bg);

  const inner = document.createElementNS(ns, 'circle');
  inner.setAttribute('cx', cx); inner.setAttribute('cy', cy); inner.setAttribute('r', 78);
  inner.setAttribute('fill', 'none');
  inner.setAttribute('stroke', 'rgba(190,225,245,0.09)');
  inner.setAttribute('stroke-width', '1');
  svg.appendChild(inner);

  const start = -132, sweep = 264, max = 260;
  for (let i = 0; i <= 26; i++) {
    const a = (start + (i / 26) * sweep) * Math.PI / 180;
    const major = i % 4 === 0;
    const r1 = major ? 69 : 74;
    const r2 = 84;
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', cx + Math.sin(a) * r1);
    line.setAttribute('y1', cy - Math.cos(a) * r1);
    line.setAttribute('x2', cx + Math.sin(a) * r2);
    line.setAttribute('y2', cy - Math.cos(a) * r2);
    line.setAttribute('stroke', i >= 22 ? 'rgba(255,77,61,0.85)' : major ? 'rgba(225,244,255,0.85)' : 'rgba(225,244,255,0.35)');
    line.setAttribute('stroke-width', major ? 2.2 : 1.1);
    svg.appendChild(line);

    if (major) {
      const text = document.createElementNS(ns, 'text');
      const tx = cx + Math.sin(a) * 59;
      const ty = cy - Math.cos(a) * 59;
      text.setAttribute('x', tx);
      text.setAttribute('y', ty + 3.6);
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('fill', 'rgba(220,240,252,0.55)');
      text.setAttribute('font-size', '8');
      text.setAttribute('font-family', 'ui-monospace, monospace');
      text.setAttribute('font-weight', '700');
      text.textContent = String(Math.round((i / 26) * max));
      svg.appendChild(text);
    }
  }
})();

let fpsFrames = 0, fpsWindow = performance.now(), fpsValue = 30;
let hudAccum = 0;

function updateHud(dt) {
  const speedKmh = Math.abs(wheelAngularSpeed) * 3.6;
  hud.speed.textContent = String(Math.round(speedKmh));
  const angle = -132 + clamp(speedKmh / 260, 0, 1) * 264;
  hud.needle.style.transform = `rotate(${angle.toFixed(1)}deg)`;

  const gearLabel = gear === -1 ? 'R' : (gear === 0 ? 'N' : String(gear));
  hud.gear.textContent = gearLabel;
  hud.rpm.textContent = Math.round(engineRpm / 10) * 10;
  hud.rpmFill.style.width = `${clamp((engineRpm - 700) / 6900, 0, 1) * 100}%`;

  hud.glat.textContent = (Math.abs(latG)).toFixed(2);
  hud.glon.textContent = lonG.toFixed(2);
  hud.steer.textContent = `${Math.round(steerAngle * 180 / Math.PI)}°`;

  hud.throttle.style.height = `${(input.throttle ? (gear === -1 ? 0 : 100) : 0)}%`;
  hud.brake.style.height = `${(input.brake ? 100 : 0)}%`;

  const slipping = slipAmount > 0.22;
  hud.tyre.textContent = slipping ? 'SLIP' : 'GRIP';
  hud.tyre.classList.toggle('is-slip', slipping);
}

/* ------------------------------------------------------------------ *
 * Adaptive resolution
 * ------------------------------------------------------------------ */
let renderTimes = [];
let lastQualityCheck = performance.now();
let quality = 'HIGH';

function resize() {
  renderWidth = window.innerWidth;
  renderHeight = window.innerHeight;
  renderer.setPixelRatio(BASE_PR * renderScale);
  renderer.setSize(renderWidth, renderHeight, false);
  composer.setPixelRatio(BASE_PR * renderScale);
  composer.setSize(renderWidth, renderHeight);
  camera.aspect = renderWidth / renderHeight;
  camera.updateProjectionMatrix();
}

function adaptiveQuality(renderMs) {
  renderTimes.push(renderMs);
  if (renderTimes.length > 40) renderTimes.shift();

  const now = performance.now();
  if (now - lastQualityCheck < 2200 || renderTimes.length < 20) return;
  lastQualityCheck = now;

  const avg = renderTimes.reduce((a, b) => a + b, 0) / renderTimes.length;
  const before = renderScale;

  if (avg > 24 && renderScale > 0.62) renderScale = Math.max(0.62, renderScale - 0.09);
  else if (avg < 11 && renderScale < 1) renderScale = Math.min(1, renderScale + 0.04);

  if (Math.abs(before - renderScale) > 0.001) {
    resize();
    if (renderScale >= 0.9) quality = 'HIGH';
    else if (renderScale >= 0.75) quality = 'MEDIUM';
    else quality = 'LOW';
    hud.quality.textContent = quality;
    bloomPass.enabled = quality !== 'LOW';
  }
}

/* ------------------------------------------------------------------ *
 * Main loop — fixed physics, 30 fps render lock
 * ------------------------------------------------------------------ */
let lastFrame = performance.now();
let accumulator = 0;
let lastRender = 0;
let running = false;

function loop(now) {
  requestAnimationFrame(loop);
  const frameDt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;

  if (running && !paused) {
    accumulator += frameDt;
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < MAX_SUBSTEPS) {
      stepVehicle(FIXED_DT);
      accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === MAX_SUBSTEPS) accumulator = 0;
    smoke.update(frameDt);
  }

  // 30 fps render lock
  const interval = 1000 / TARGET_FPS;
  if (now - lastRender < interval - 2.2) return;
  const renderDt = Math.max(0.001, (now - lastRender) / 1000);
  lastRender = now;

  const t0 = performance.now();
  syncVisuals(renderDt);
  updateCamera(paused ? 0.0001 : renderDt);
  composer.render(renderDt);
  adaptiveQuality(performance.now() - t0);

  if (!paused) {
    updateHud(renderDt);
    audio.update(engineRpm, input.throttle || (gear === -1 && input.brake), Math.abs(wheelAngularSpeed), slipAmount, running);

    // fps counter
    fpsFrames++;
    if (now - fpsWindow >= 1000) {
      fpsValue = Math.round(fpsFrames * 1000 / (now - fpsWindow));
      hud.fps.textContent = `${fpsValue} FPS`;
      hud.fps.classList.toggle('is-low', fpsValue < 26);
      fpsFrames = 0;
      fpsWindow = now;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Start / pause / boot
 * ------------------------------------------------------------------ */
function startGame() {
  if (started) return;
  started = true;
  running = true;
  document.getElementById('start').classList.add('is-hidden');
  document.getElementById('hud').classList.remove('is-hidden');
  audio.start();
  resetCar();
  canvas.focus();
}

function togglePause() {
  if (!started) return;
  paused = !paused;
  document.getElementById('pause').classList.toggle('is-hidden', !paused);
  if (paused) {
    input.throttle = input.brake = input.left = input.right = input.handbrake = false;
  } else {
    lastFrame = performance.now();
    accumulator = 0;
  }
}

$('startBtn').addEventListener('click', startGame);
$('resumeBtn').addEventListener('click', togglePause);
document.getElementById('pause').addEventListener('click', (e) => {
  if (e.target.id === 'pause') togglePause();
});
canvas.addEventListener('pointerdown', () => {
  canvas.focus();
});

window.addEventListener('resize', resize);
document.addEventListener('visibilitychange', () => {
  if (document.hidden && started && !paused) togglePause();
});

// dial + initial view
resize();
syncVisuals(0.016);
updateCamera(0.016);
composer.render(0.016);

document.getElementById('loadingText').textContent = 'Ready';
setTimeout(() => {
  document.getElementById('loading').classList.add('is-hidden');
}, 260);

running = true;
requestAnimationFrame(loop);
