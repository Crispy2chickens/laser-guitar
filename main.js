// Laser guitar viewer — loads guitar-for-export.glb, builds 6 laser beams between
// the diode/LDR pairs, and drives a traveling LED wave down the neck when a beam
// is "plucked" (pointer intersects it). Audio is stubbed in playStringSound().

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { audioInit, audioPluck } from './audio.js';

// ---------------------------------------------------------------------------
// Config — everything you said you'd tune later lives here.
// ---------------------------------------------------------------------------
const CONFIG = {
  MODEL_URL: './guitar-for-export.glb',
  HDRI_URL: './assets/studio_small_08_1k.hdr',

  // Laser beams. Color is red for all 6 (per spec; per-string colors not
  // finalized — swap BEAM_COLOR for an array of 6 if you go that way).
  // The color is scaled >1 (HDR) so the beams cross the bloom threshold.
  BEAM_COLOR: new THREE.Color(1.0, 0.02, 0.02).multiplyScalar(8),
  BEAM_OPACITY: 0.8,
  BEAM_RADIUS_FRAC: 0.0012,   // beam radius as a fraction of model size
  HITBOX_RADIUS_MULT: 5,      // invisible hitbox is this × thicker than the beam
  HITBOX_HYSTERESIS: 1.3,     // held beam's hitbox grows by this factor, so tiny
                              // cursor jitter at the edge can't release + re-break it

  // LED wave.
  WAVE_DIRECTION: 1,          // 1 = ascending along detected neck axis, -1 = reversed.
                              // Flip this once you see which end is the headstock.
  LED_STEP_MS: 25,            // delay between adjacent LEDs (travel speed)
  LED_PULSE_MS: 200,          // how long each individual LED's pulse lasts
  LED_IDLE_INTENSITY: 0.2,
  LED_ACTIVE_INTENSITY: 3.0,
  LED_EMISSIVE_COLOR: new THREE.Color(1.0, 0.9, 0.7), // warm white, all strings

  // Re-trigger guard so dragging across a beam doesn't machine-gun it.
  RETRIGGER_COOLDOWN_MS: 250,

  // Bloom — threshold 1.0 so only genuinely HDR pixels bloom (beams at ~×8,
  // LED pulses at ×3). At 0.8 the idle LED strip and the acrylic's specular
  // highlights from the HDRI crossed it and hazed out the whole neck.
  BLOOM_THRESHOLD: 1.0,
  BLOOM_STRENGTH: 0.6,
  BLOOM_RADIUS: 0.4,

  // Viewer-side patch for the acrylic, because this export is missing
  // KHR_materials_volume (see fixMaterials).
  //
  // THICKNESS_MULT scales the screen-space refraction offset. Three.js fakes
  // refraction by re-sampling the rendered frame shifted by thickness × IOR,
  // which at full physical thickness paints ghost "duplicates" of the LED
  // strip onto the slab's edge faces. Keep this low (0 = no ghosting at all,
  // perfectly straight see-through; 1 = full measured 1.8" slab depth).
  ACRYLIC_THICKNESS_MULT: 0.1,
  ACRYLIC_ATTENUATION_COLOR: new THREE.Color(0.93, 0.97, 1.0),
  ACRYLIC_ATTENUATION_DISTANCE_MULT: 3, // × measured slab depth (tint, not refraction)
};

// Start the audio pipeline (worklet fetch + compile, context + graph setup)
// immediately, in parallel with the model/HDRI downloads awaited below —
// this file is a top-level-await module, so anything after those awaits
// doesn't run until the visuals are ready. The context comes up "suspended"
// per browser autoplay policy; the first user gesture resumes it (instant).
audioInit();
// Re-resume the context on later gestures in case the browser ever suspends it.
for (const evt of ['pointerdown', 'keydown']) {
  window.addEventListener(evt, () => audioInit(), { capture: true });
}

const NUM_STRINGS = 6;
// Load-time anomalies go to the console only (open devtools to see them).
function flag(msg) {
  console.warn('[laser-guitar]', msg);
}

// ---------------------------------------------------------------------------
// Renderer / scene / camera / post
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
document.querySelector('#app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x08090c); // dark, so beams + bloom pop

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.01, 100);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

// EffectComposer defaults to a HalfFloat render target (r152+), which we rely
// on: beam colors and active LED emissives are >1 so bloom can pick them out.
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  CONFIG.BLOOM_STRENGTH, CONFIG.BLOOM_RADIUS, CONFIG.BLOOM_THRESHOLD,
);
composer.addPass(bloomPass);
composer.addPass(new OutputPass()); // tone mapping + sRGB happen here

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------------
// Asset loading
// ---------------------------------------------------------------------------
const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();

const [hdri, gltf] = await Promise.all([
  new RGBELoader().loadAsync(CONFIG.HDRI_URL),
  new GLTFLoader().loadAsync(CONFIG.MODEL_URL),
]);

// Environment map — essential for the transmissive acrylic and metallic parts.
scene.environment = pmrem.fromEquirectangular(hdri).texture;
hdri.dispose();
pmrem.dispose();

const model = gltf.scene;
scene.add(model);
model.updateMatrixWorld(true);

const modelBox = new THREE.Box3().setFromObject(model);
const modelSize = modelBox.getSize(new THREE.Vector3()).length();
const modelCenter = modelBox.getCenter(new THREE.Vector3());

camera.position.copy(modelCenter).add(new THREE.Vector3(0.5, 0.6, 1).normalize().multiplyScalar(modelSize * 1.1));
controls.target.copy(modelCenter);
controls.update();

// World-space bounding-box center of a mesh. NOTE: this model's loose-part
// meshes (LEDs, diodes, LDRs) all share one object origin from Blender's
// "Separate by Loose Parts", so node positions are meaningless — geometry
// bounds are the only reliable position source.
const _box = new THREE.Box3();
function worldCenter(mesh) {
  return _box.setFromObject(mesh).getCenter(new THREE.Vector3());
}

// ---------------------------------------------------------------------------
// Material fixes (Section 5)
// ---------------------------------------------------------------------------
function fixMaterials() {
  const expected = [
    'KHR_materials_transmission', 'KHR_materials_volume', 'KHR_materials_ior',
    'KHR_materials_emissive_strength', 'KHR_materials_clearcoat', 'KHR_materials_sheen',
  ];
  const used = gltf.parser.json.extensionsUsed ?? [];
  console.table(expected.map((e) => ({ extension: e, present: used.includes(e) })));
  for (const e of ['KHR_materials_volume', 'KHR_materials_emissive_strength']) {
    if (!used.includes(e)) flag(`${e} missing from export — re-export from Blender with it if you want it authored rather than patched here.`);
  }

  const seen = new Set();
  model.traverse((obj) => {
    if (!obj.isMesh || seen.has(obj.material)) return;
    const mat = obj.material;
    seen.add(mat);

    if (mat.transmission > 0) {
      // Blender exports the acrylic double-sided; Three.js then runs the
      // refraction pass on both the front and back faces of the slab, which
      // shows up as an offset ghost "duplicate" at glancing angles. Render
      // front faces only — one refraction through the volume.
      mat.side = THREE.FrontSide;

      if (mat.thickness === 0) {
        // Export dropped KHR_materials_volume, so the acrylic would render as a
        // thin glass shell. Recover a plausible thickness from the body mesh's
        // own bounding box (its smallest dimension ≈ the 1.8" slab thickness).
        const dims = _box.setFromObject(obj).getSize(new THREE.Vector3());
        const slabDepth = Math.min(dims.x, dims.y, dims.z);
        mat.thickness = slabDepth * CONFIG.ACRYLIC_THICKNESS_MULT;
        mat.attenuationColor = CONFIG.ACRYLIC_ATTENUATION_COLOR;
        mat.attenuationDistance = slabDepth * CONFIG.ACRYLIC_ATTENUATION_DISTANCE_MULT;
        flag(`"${mat.name}" had transmission=${mat.transmission} but thickness=0; patched thickness=${mat.thickness.toFixed(3)} (slab ${slabDepth.toFixed(3)} × ${CONFIG.ACRYLIC_THICKNESS_MULT}) + approximate attenuation tint (CONFIG.ACRYLIC_*).`);
      }
      console.log(`[laser-guitar] transmissive "${mat.name}": thickness=${mat.thickness.toFixed(3)} ior=${mat.ior} attenuationDistance=${mat.attenuationDistance}`);
    }

    // Clamp any emissive that loaded hot, so there's no flash on first frame.
    if (mat.emissiveIntensity > 1) {
      flag(`"${mat.name}" loaded with emissiveIntensity=${mat.emissiveIntensity}; clamped to idle.`);
      mat.emissiveIntensity = CONFIG.LED_IDLE_INTENSITY;
    }
  });
}
fixMaterials();

// ---------------------------------------------------------------------------
// Collect the interactive parts
// ---------------------------------------------------------------------------
const diodes = [];       // [stringIdx] -> mesh
const ldrs = [];         // [stringIdx] -> mesh
const ledsByString = Array.from({ length: NUM_STRINGS }, () => []); // -> [{mesh, center}]

model.traverse((obj) => {
  if (!obj.isMesh) return;
  let m;
  if ((m = obj.name.match(/^laser_diode_string(\d+)$/))) diodes[+m[1] - 1] = obj;
  else if ((m = obj.name.match(/^LDR_string(\d+)$/))) ldrs[+m[1] - 1] = obj;
  else if ((m = obj.name.match(/^LED_string(\d+)_pos/))) {
    ledsByString[+m[1] - 1].push({ mesh: obj, center: worldCenter(obj) });
  }
});

// Sanity checks — the diodes/LDRs came from "Separate by Loose Parts", so
// verify we really got 6 distinct meshes of each.
if (diodes.filter(Boolean).length !== NUM_STRINGS) flag(`Expected 6 laser_diode_stringN meshes, found ${diodes.filter(Boolean).length}.`);
if (ldrs.filter(Boolean).length !== NUM_STRINGS) flag(`Expected 6 LDR_stringN meshes, found ${ldrs.filter(Boolean).length}.`);
ledsByString.forEach((leds, i) => {
  if (leds.length !== 19) flag(`String ${i + 1}: expected 19 LEDs, found ${leds.length}.`);
});

// --- LED sorting (Section 3) ---
// The .001/.002 name suffixes don't reflect physical order, and every LED node
// shares the same origin, so: detect which world axis the neck runs along
// (the axis with the largest spread of LED centers), then sort by it.
const allCenters = ledsByString.flat().map((l) => l.center);
const spread = ['x', 'y', 'z'].map((ax) => {
  const vals = allCenters.map((c) => c[ax]);
  return Math.max(...vals) - Math.min(...vals);
});
const neckAxis = ['x', 'y', 'z'][spread.indexOf(Math.max(...spread))];
console.log(`[laser-guitar] neck axis detected: ${neckAxis} (spread x/y/z = ${spread.map((s) => s.toFixed(3)).join(' / ')})`);

for (const leds of ledsByString) {
  leds.sort((a, b) => a.center[neckAxis] - b.center[neckAxis]);
  if (CONFIG.WAVE_DIRECTION === -1) leds.reverse();
  // Each LED gets its own material clone so it can pulse independently
  // (they all share one "LED-LIGHTS" material in the file). Emissive color is
  // normalized to full warm-white so emissiveIntensity is the single knob:
  // idle 0.2 reproduces the authored look, active goes to 3.0.
  for (const led of leds) {
    const mat = led.mesh.material.clone();
    mat.emissive.copy(CONFIG.LED_EMISSIVE_COLOR);
    mat.emissiveIntensity = CONFIG.LED_IDLE_INTENSITY;
    led.mesh.material = mat;
  }
}

// ---------------------------------------------------------------------------
// Laser beams (Section 2) — built here, not in Blender
// ---------------------------------------------------------------------------
const beamRadius = modelSize * CONFIG.BEAM_RADIUS_FRAC;
const beamMaterial = new THREE.MeshBasicMaterial({
  color: CONFIG.BEAM_COLOR,     // HDR red (>1) so it crosses the bloom threshold
  transparent: true,
  opacity: CONFIG.BEAM_OPACITY,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  // No depth test: the transmissive acrylic writes depth but doesn't include
  // transparent objects in its refraction pass, so depth-tested beams vanish
  // when viewed through the body from behind. Always-on-top is the right look
  // for an additive glow anyway (mild "x-ray" through opaque parts is the cost).
  depthTest: false,
  toneMapped: false,            // keep the HDR value; OutputPass tone-maps the rest
});
// Bright scatter dot where a blocked beam terminates on the "hand".
const sparkMaterial = new THREE.MeshBasicMaterial({
  color: CONFIG.BEAM_COLOR,
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  depthTest: false,
  toneMapped: false,
});
const hitboxMaterial = new THREE.MeshBasicMaterial({ visible: false });

const beams = []; // [{beam, hitbox, spark, start, dir, length, blocked, lastTrigger, userVisible}]
const UP = new THREE.Vector3(0, 1, 0);

// Fat hitboxes are forgiving, but they must not overlap the neighboring
// string's — cap the radius at just under half the closest beam-to-beam gap.
const beamMids = [];
for (let i = 0; i < NUM_STRINGS; i++) {
  if (diodes[i] && ldrs[i]) {
    beamMids.push(worldCenter(diodes[i]).add(worldCenter(ldrs[i])).multiplyScalar(0.5));
  }
}
let minGap = Infinity;
for (let a = 0; a < beamMids.length; a++) {
  for (let b = a + 1; b < beamMids.length; b++) {
    minGap = Math.min(minGap, beamMids[a].distanceTo(beamMids[b]));
  }
}
const hitboxRadius = Math.min(beamRadius * CONFIG.HITBOX_RADIUS_MULT, minGap * 0.45);
console.log(`[laser-guitar] hitbox radius ${hitboxRadius.toFixed(4)} (beam ${beamRadius.toFixed(4)}, min string gap ${minGap.toFixed(4)})`);

// Start the camera facing the guitar's FRONT. The beams sit just off the
// front face, so the average beam position vs the body center reveals which
// side that is along the slab's depth axis (the model's thinnest dimension).
if (beamMids.length) {
  const dims = modelBox.getSize(new THREE.Vector3());
  const depthAxis = ['x', 'y', 'z'][[dims.x, dims.y, dims.z].indexOf(Math.min(dims.x, dims.y, dims.z))];
  const avgMid = beamMids.reduce((acc, m) => acc.add(m), new THREE.Vector3()).multiplyScalar(1 / beamMids.length);
  const frontSign = Math.sign(avgMid[depthAxis] - modelCenter[depthAxis]) || 1;
  const viewDir = new THREE.Vector3(0.3, 0.4, 0.3); // mild 3/4 offset for depth
  viewDir[depthAxis] = frontSign * 1.5;              // dominant: out of the front face
  camera.position.copy(modelCenter).add(viewDir.normalize().multiplyScalar(modelSize * 1.1));
  controls.update();
  console.log(`[laser-guitar] front detected: ${frontSign > 0 ? '+' : '-'}${depthAxis}`);
}

for (let i = 0; i < NUM_STRINGS; i++) {
  if (!diodes[i] || !ldrs[i]) continue;
  // Endpoints from geometry bounds (see worldCenter note) — never hardcoded.
  const start = worldCenter(diodes[i]);
  const end = worldCenter(ldrs[i]);
  const dir = end.clone().sub(start).normalize();

  // worldCenter() is the middle of each housing, so the raw span would bury
  // both beam ends inside the components. Cast from the beam's midpoint
  // outward along its own line to find each part's facing surface and trim
  // the beam to run surface-to-surface. Falls back to centers on a miss.
  const trimRay = new THREE.Raycaster();
  const mid = start.clone().add(end).multiplyScalar(0.5);
  trimRay.set(mid, dir.clone().negate());
  const diodeHit = trimRay.intersectObject(diodes[i], false)[0];
  if (diodeHit) start.copy(diodeHit.point);
  trimRay.set(mid, dir);
  const ldrHit = trimRay.intersectObject(ldrs[i], false)[0];
  if (ldrHit) end.copy(ldrHit.point);
  const length = end.distanceTo(start);
  const quat = new THREE.Quaternion().setFromUnitVectors(UP, dir);

  // Geometry is anchored at the diode end (spans 0..length along local +Y),
  // so a *partially* broken beam is just scale.y < 1: lit from the diode to
  // the break point, dark from there to the LDR — like a real blocked laser.
  const make = (radius, material) => {
    const geo = new THREE.CylinderGeometry(radius, radius, length, 12, 1, true);
    geo.translate(0, length / 2, 0);
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.copy(start);
    mesh.quaternion.copy(quat);
    scene.add(mesh);
    return mesh;
  };
  const beam = make(beamRadius, beamMaterial);
  beam.renderOrder = 10; // draw after the transmissive/transparent body
  // Fatter invisible cylinder so the thin beam is easy to hit with a pointer.
  const hitbox = make(hitboxRadius, hitboxMaterial);
  hitbox.userData.stringIndex = i;

  const spark = new THREE.Mesh(new THREE.SphereGeometry(beamRadius * 1.6, 12, 8), sparkMaterial);
  spark.visible = false;
  spark.renderOrder = 11;
  scene.add(spark);

  beams[i] = {
    beam, hitbox, spark, start, end, dir, length,
    blocked: false, lastTrigger: -Infinity, userVisible: true,
  };
}

// Per-beam show/hide is still supported programmatically (entry.userVisible +
// entry.beam.visible); the UI toggle panel was removed as unneeded.

// ---------------------------------------------------------------------------
// Interaction (Section 4) — raycast the hitboxes, pluck on enter or click
// ---------------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let hoveredString = -1;

// Everything in the model can shadow the pointer ray: if any part of the
// guitar (including the acrylic body) sits between the camera and a beam,
// that beam can't be plucked from this viewpoint. This is what stops you
// from breaking beams "through" the guitar when orbiting behind it — the
// beams stay visible back there (depthTest: false) but out of reach.
const occluders = [];
model.traverse((obj) => { if (obj.isMesh) occluders.push(obj); });

function pickString(event) {
  pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  // Toggled-off beams don't exist as far as the pointer is concerned.
  const hits = raycaster.intersectObjects(
    beams.filter((b) => b && b.userVisible).map((b) => b.hitbox), false);
  if (!hits.length) return null;
  // The fat hitboxes overlap between strings, and the first hit (nearest
  // surface to the camera) can belong to a *neighbor* whose cylinder bulges
  // in front of the string actually under the cursor. Pick the beam whose
  // axis passes closest to the pointer ray instead.
  let hit = null;
  let bestScore = Infinity;
  for (const h of hits) {
    const idx = h.object.userData.stringIndex;
    const entry = beams[idx];
    let score = raycaster.ray.distanceSqToSegment(entry.start, entry.end);
    // Same hysteresis idea as the hitbox scaling: the currently-held string
    // gets a handicap so boundary jitter can't flip the pick to a neighbor.
    if (idx === hoveredString) score /= CONFIG.HITBOX_HYSTERESIS ** 2;
    if (score < bestScore) { bestScore = score; hit = h; }
  }
  const blockers = raycaster.intersectObjects(occluders, false);
  if (blockers.length && blockers[0].distance < hit.distance) return null;
  return hit;
}

// Cut the beam at the pointer: lit diode→break point, dark beyond, spark dot
// at the break. `point` (on the hitbox surface) is projected onto the beam axis.
function setBreakPoint(entry, point) {
  const t = THREE.MathUtils.clamp(point.clone().sub(entry.start).dot(entry.dir), 0, entry.length);
  entry.beam.scale.y = Math.max(t / entry.length, 0.02);
  entry.spark.position.copy(entry.start).addScaledVector(entry.dir, t);
  entry.spark.visible = true;
}

// Break/release model, mirroring the hardware: while the cursor sits in a
// beam the beam stays broken (the LDR is shadowed); the LED wave fires the
// moment the beam is first broken, and the *sound* fires on release — when
// the cursor leaves the beam and the LDR sees light again.
function updateHover(hit) {
  const newString = hit ? hit.object.userData.stringIndex : -1;
  if (newString !== hoveredString) {
    if (hoveredString !== -1) onStringReleased(hoveredString);
    if (newString !== -1) onStringBroken(newString, hit);
    hoveredString = newString;
    renderer.domElement.style.cursor = newString === -1 ? '' : 'pointer';
  } else if (hit && beams[newString]?.blocked) {
    setBreakPoint(beams[newString], hit.point); // slide the break along the beam
  }
}

renderer.domElement.addEventListener('pointermove', (event) => {
  updateHover(pickString(event));
});
renderer.domElement.addEventListener('pointerdown', (event) => {
  audioInit(); // AudioContext must start inside a user gesture
  updateHover(pickString(event)); // touch: finger down breaks the beam
});
renderer.domElement.addEventListener('pointerup', (event) => {
  // Touch has no hover: lifting the finger is leaving the beam. A mouse
  // button release doesn't unblock anything — the cursor is still in the beam.
  if (event.pointerType !== 'mouse') updateHover(null);
});
renderer.domElement.addEventListener('pointerleave', () => {
  updateHover(null); // cursor left the canvas entirely
});

const activeWaves = []; // [{stringIndex, startTime}]

// Beam first broken: cut it at the pointer + start the LED wave. No sound yet.
function onStringBroken(stringIndex, hit) {
  const now = performance.now();
  const entry = beams[stringIndex];
  if (!entry || !entry.userVisible) return;
  entry.blocked = true;
  setBreakPoint(entry, hit.point);
  // Hysteresis: widen the hitbox radially (local X/Z; Y is the beam axis)
  // while held, so leaving requires a deliberate move, not a 1px jitter.
  entry.hitbox.scale.set(CONFIG.HITBOX_HYSTERESIS, 1, CONFIG.HITBOX_HYSTERESIS);
  if (now - entry.lastTrigger < CONFIG.RETRIGGER_COOLDOWN_MS) return; // jitter guard for the wave only
  entry.lastTrigger = now;
  activeWaves.push({ stringIndex, startTime: now });
}

// Beam released: restore the full beam and sound the note.
function onStringReleased(stringIndex) {
  const entry = beams[stringIndex];
  if (!entry || !entry.blocked) return;
  entry.blocked = false;
  entry.beam.scale.y = 1;
  entry.spark.visible = false;
  entry.hitbox.scale.set(1, 1, 1);
  playStringSound(stringIndex);
}

// Synthesized in audio-worklet.js — a direct port of the firmware's audio.c
// (same sine/decay tables and fixed-point math). Called once per release.
function playStringSound(stringIndex) {
  audioPluck(stringIndex);
}

// ---------------------------------------------------------------------------
// Animation loop — beam flicker + traveling LED wave
// ---------------------------------------------------------------------------
function animate() {
  const now = performance.now();

  // (Beam break/restore is handled event-side: a blocked beam is scaled down
  // to its break point in setBreakPoint, restored in onStringReleased.)

  // Traveling LED wave: each wave sweeps the string's *sorted* LED array.
  // LED k starts its pulse k×LED_STEP_MS after the pluck and follows a
  // half-sine envelope from idle up to active and back — so the bright spot
  // moves along the neck instead of the whole strip flashing at once.
  //
  // Intensities are recomputed from scratch each frame: reset affected strings
  // to idle, then let every active wave raise LEDs via max (so overlapping
  // waves on one string combine instead of stomping each other).
  for (const wave of activeWaves) {
    for (const led of ledsByString[wave.stringIndex]) {
      led.mesh.material.emissiveIntensity = CONFIG.LED_IDLE_INTENSITY;
    }
  }
  for (let w = activeWaves.length - 1; w >= 0; w--) {
    const wave = activeWaves[w];
    const leds = ledsByString[wave.stringIndex];
    const elapsed = now - wave.startTime;

    for (let k = 0; k < leds.length; k++) {
      const t = elapsed - k * CONFIG.LED_STEP_MS; // this LED's local pulse time
      if (t <= 0 || t >= CONFIG.LED_PULSE_MS) continue;
      const env = Math.sin(Math.PI * (t / CONFIG.LED_PULSE_MS)); // 0→1→0
      const mat = leds[k].mesh.material;
      mat.emissiveIntensity = Math.max(
        mat.emissiveIntensity,
        CONFIG.LED_IDLE_INTENSITY + (CONFIG.LED_ACTIVE_INTENSITY - CONFIG.LED_IDLE_INTENSITY) * env,
      );
    }
    // Wave is done once the last LED's pulse has finished.
    if (elapsed > (leds.length - 1) * CONFIG.LED_STEP_MS + CONFIG.LED_PULSE_MS) {
      activeWaves.splice(w, 1);
    }
  }

  controls.update();
  composer.render();
}
renderer.setAnimationLoop(animate);

// Assets are in: turn the loading screen into a dimmed entry gate. Hover-
// plucking can't unlock audio (pointermove isn't a "user gesture" under
// autoplay policy), so route everyone through one natural click — it starts
// the sound and drops the gate before any beam can be reached.
const gate = document.querySelector('#loading');
gate.textContent = 'Click anywhere to begin';
gate.classList.add('ready');
gate.addEventListener('pointerdown', () => {
  audioInit(); // this trusted click resumes the suspended AudioContext
  gate.classList.add('done');
}, { once: true });
console.log('[laser-guitar] ready —', NUM_STRINGS, 'beams,', ledsByString.flat().length, 'LEDs');
