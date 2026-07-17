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
  LED_BASE_COLOR: new THREE.Color(0x0a0a0a), // strip PCB base, overrides the exported cream color

  // Re-trigger guard so dragging across a beam doesn't machine-gun it.
  RETRIGGER_COOLDOWN_MS: 250,

  // Exploded view.
  EXPLODE_STAGGER_MS: 80,      // delay between each component group's animation start
  EXPLODE_DURATION_MS: 1000,   // per-component explode/reassemble duration
  WIRE_HIDE_MS: 180,           // wire/beam fade-out on explode — quick, snappy
  WIRE_REVEAL_MS: 900,         // wire fade-in on reassembly — slow, so the
                               // "everything is back" moment doesn't snap in abruptly
  BEAM_REVEAL_MS: 600,         // beam fade-in on reassembly — beam opacity eases
                               // out (fast) while bloom strength eases in (slow),
                               // so the glow builds gradually instead of popping

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
  // Three.js blurs transmission by sampling mips of a downscaled frame copy,
  // so the authored roughness 0.05 reads as frosted/matte anywhere the view is
  // dominated by transmission (i.e. the big front face, where Fresnel
  // reflection is only ~4%). Force the slab optically clear.
  ACRYLIC_ROUGHNESS: 0,

  // Camera limits — pan is clamped to the model box expanded by this fraction
  // of the model size, and dolly is capped so you can't zoom into oblivion.
  PAN_MARGIN_FRAC: 0.35,
  MIN_DISTANCE_FRAC: 0.2,
  MAX_DISTANCE_FRAC: 4,

  // Ambient background: the loaded HDRI, heavily blurred and dimmed, instead
  // of flat black. Intensity stays far below BLOOM_THRESHOLD so it never hazes.
  // BG_TINT is multiplied into the background copy only (not the lighting env)
  // — cool it toward dark blue.
  BG_BLURRINESS: 0.6,
  BG_INTENSITY: 0.03,
  BG_TINT: new THREE.Color(0.4, 0.55, 1.0),
};

// Exploded view — per-component offsets, tunable independently. Values are
// added to each component's original position (not absolute), so orientation
// depends on the model's local axes; nudge these once you see the first pass.
// z is negative here because the console-logged "front detected" axis for
// this model is -z (see the beam camera-facing code below) — components
// should pop out toward the front face, not recede behind the body.
const EXPLODE_OFFSETS = {
  led_strip: new THREE.Vector3(0, 0.5, -0.4),
  perfboard: new THREE.Vector3(0, 0, -0.8),
  mangopi_board: new THREE.Vector3(0.5, 0, -1),
  dac_board: new THREE.Vector3(0.3, 0, -1.2),
  rotary_encoder: new THREE.Vector3(0, 0.5, -1),
  speaker: new THREE.Vector3(0, 0.5, -0.6),
  laser_diodes: new THREE.Vector3(0, -0.3, -1),
  ldrs: new THREE.Vector3(0, 0.2, -1),
};

// Exploded-view hover card content. `media` is an ordered list of 0..N items;
// the first is shown large/primary, the rest as clickable thumbnails. Left as
// placeholders — real copy + asset paths (see assets/, assets/process/) come
// in once confirmed.
const COMPONENT_INFO = {
  led_strip: { title: 'APA102 LED Strip', description: 'We chose the APA102 because it has separate clock and data pins, and because it was the strip we were most familiar with. We started with six separate strips — one per string — but my teammate wanted to drive them all from that single clock/data pair, so we soldered the strips together end-to-end so the controller sees them as one long continuous strip.', media: [
    { type : 'img', src: 'assets/references/APA102.jpg', label: 'LEDs'},
    { type : 'img', src: 'assets/process/soldering-leds.png', label: 'Soldering the LEDs'},
  ] },
  perfboard: { title: 'Perfboards', description: 'We used two boards to split the wiring. The Electrocookie board controls the laser diodes, the LEDs, the rotary encoder, and the DAC, while the green perfboard handles the six LDRs. My teammate mapped out every connection before we touched a soldering iron. Along the way I learned why each design decision was made, and eventually tried my hand at soldering and desoldering.', media: [
    { type : 'img', src: 'assets/references/electrocookie.jpg', label: 'Electrocookie'},
    { type : 'img', src: 'assets/references/perfboard.png', label: 'Perfboard'},
    { type : 'img', src: 'assets/process/designing-board.png', label: 'Designing how the wires would be connected'},
  ] },
  mangopi_board: { title: 'MangoPi MQ-Pro', description: 'I had never heard of the MangoPi before CS107E, but the whole course is about programming this little RISC-V board bare-metal, no operating system, just our own code talking directly to the hardware, built up from the GPIO drivers. It\'s the powerhouse of the project, watching the six LDRs for broken beams, driving the LED strip, reading the rotary encoder, and streaming the guitar sound out through the DAC, all at once.', media: [
    { type : 'img', src: 'assets/references/mango-pi.png', label: 'MangoPi MQ-Pro'},
  ] },
  dac_board: { title: 'MAX98357A DAC I2S Converter', description: 'We first tried PWM audio straight from a pin, but it sounded very "buzzy". After hearing a classmate\'s project that used I2S, we switched over. This chip is here since we chose to work with I2S. The MangoPi outputs sound as a digital I2S stream, and the MAX98357A turns that stream into an analog signal and amplifies it enough to drive the speaker directly. CS107E provided the I2S driver, so our code just had to keep feeding it samples.', media: [
    { type : 'img', src: 'assets/references/dac.png', label: 'MAX98357A DAC'},
  ] },
  rotary_encoder: { title: 'EC11 Rotary Encoder', description: 'We wanted the audio to be customizable, so this rotary encoder lets players change the volume, and its built-in push switch resets it — my teammate worked out the logic for that. You can\'t adjust the volume through it in this demo, since the demo recreates the strings rather than the controls, but on the physical guitar a twist of the knob is all it takes.', media: [
    { type : 'img', src: 'assets/references/rotary-encoder.png', label: 'Rotary Encoder'},
  ] },
  speaker: { title: '3W 8Ω Mini Speaker', description: 'We wanted our laser guitar to be somewhat realistic. The biggest challenge was learning how to represent a guitar wave and the harmonics that give it its character, and getting chords to work meant applying the double buffering we learned in the course plus some DSP I picked up outside of it. Play the video to hear the chords.', media: [
    { type : 'img', src: 'assets/references/speaker.png', label: 'Speaker'},
    { type: 'video', src: 'assets/process/audio.mp4', label: 'Chords' },
  ] },
  laser_diodes: { title: '5V Red Laser Diode Module', description: 'The diodes had to be 5V: we tried 3V ones first, but they weren\'t powerful enough to trigger the LDRs through the black-box holes at the ~40cm range we needed. Aiming six beams into six small holes was as fiddly as it sounds. We aligned them by slipping bits of paper under the black boxes, shimming each one up or down until its laser landed square on the sensor.', media: [
    { type : 'img', src: 'assets/references/laser-diodes.png', label: 'Laser Diode Module'},
  ] },
  ldrs: { title: 'LDR Light Sensor Module', description: 'We chose this specific module because it has a comparator and a potentiometer on board. This allowed each sensor to output a clean digital on/off signal, with the potentiometer setting the light threshold, which is much easier to work with. Before we started, our professor warned us about a similar past project whose biggest challenge was getting the LDRs to respond to the lasers — and only the lasers — since they react to ambient room light too. The solution was to use little 3D-printed "black boxes" that enclose each module, with a single hole that lets the laser beam through to the sensor and blocks everything else. I designed and printed them, and it took 11 iterations of tuning the hole size and snout length, but the final boxes solved the ambient-light problem completely. (Click the last image to see the designs we went through!)', media: [
    { type : 'img', src: 'assets/references/ldrs.png', label: 'LDR Sensor Module'},
    { type : 'img', src: 'assets/process/ldrs-test.png', label: 'First time connecting all 6 LDRs to the speaker'},
    { type : 'img', src: 'assets/process/black-boxes.png', label: 'Designs for black boxes we went through'},
  ] },
  // Body is hoverable in the exploded view (it's the one thing that never
  // moves) but isn't part of EXPLODE_GROUP_KEYS below, since it has no offset.
  body: { title: 'Clear Acrylic Guitar Body', description: 'We wanted a guitar shaped board that could fit all our components, so I designed the body from scratch in Adobe Illustrator and cut it from a single 1.8"-thick sheet, and everything fit on the first cut. The components are mounted with double-sided tape, and we chose clear acrylic because it suited the magical feel of a laser guitar — an instrument you can see straight through, played on beams of light.', media: [
    { type : 'img', src: 'assets/process/lasercutted-board.png', label: 'Board was lasercutted'},
    { type : 'img', src: 'assets/process/assembled-guitar.png', label: 'Assembled Guitar'},
    { type: 'video', src: 'assets/process/final.mp4', label: 'Final working guitar' },
  ] },
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
// On desktop, plucking is a hover — it never competes with drag-to-orbit.
// On touch there's no hover, so plucking IS a one-finger drag, which by
// default OrbitControls also uses for rotation: every attempt to play a
// string also spins the camera. Free up one finger for playing and require
// two fingers to look around/zoom (mouse behavior is a separate config and
// is untouched).
controls.touches.ONE = THREE.TOUCH.NONE;
controls.touches.TWO = THREE.TOUCH.DOLLY_ROTATE;

// EffectComposer defaults to a HalfFloat render target (r152+), which we rely
// on: beam colors and active LED emissives are >1 so bloom can pick them out.
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  CONFIG.BLOOM_STRENGTH, CONFIG.BLOOM_RADIUS, CONFIG.BLOOM_THRESHOLD,
);
// Default smoothWidth (0.01) makes the luminosity highpass nearly a hard
// cutoff. Widen the knee so pixels near the threshold contribute partially
// instead of flickering in and out at the gate. (The reassembly glow fade-in
// is handled separately, by animating bloomPass.strength.)
bloomPass.highPassUniforms['smoothWidth'].value = 0.5;
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

// Reuse the HDRI as a blurred, dimmed backdrop — a faint studio ambience that
// matches what the acrylic reflects. The background wants a cool blue cast
// that the lighting must NOT get, and three.js has no background tint knob,
// so: after the lighting env is generated above, multiply BG_TINT into the
// equirect pixels in place and PMREM it a second time for the background.
{
  const { data } = hdri.image;
  const tint = [CONFIG.BG_TINT.r, CONFIG.BG_TINT.g, CONFIG.BG_TINT.b, 1];
  const half = hdri.type === THREE.HalfFloatType;
  for (let i = 0; i < data.length; i++) {
    const t = tint[i & 3];
    if (t === 1) continue;
    data[i] = half
      ? THREE.DataUtils.toHalfFloat(THREE.DataUtils.fromHalfFloat(data[i]) * t)
      : data[i] * t;
  }
  hdri.needsUpdate = true;
}
scene.background = pmrem.fromEquirectangular(hdri).texture;
scene.backgroundBlurriness = CONFIG.BG_BLURRINESS;
scene.backgroundIntensity = CONFIG.BG_INTENSITY;
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

// Shift/right-drag pan moves the orbit target, which unbounded lets you sail
// off into empty space. Clamp the target to a margin around the guitar: the
// pan simply runs out at the edge (a soft wall under damping), and orbiting
// is untouched. Dolly limits stop zooming through the model or to infinity.
const panBounds = modelBox.clone().expandByScalar(modelSize * CONFIG.PAN_MARGIN_FRAC);
controls.addEventListener('change', () => panBounds.clampPoint(controls.target, controls.target));
controls.minDistance = modelSize * CONFIG.MIN_DISTANCE_FRAC;
controls.maxDistance = modelSize * CONFIG.MAX_DISTANCE_FRAC;

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
      mat.roughness = CONFIG.ACRYLIC_ROUGHNESS; // see CONFIG — kills the frosted look

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

    if (mat.name === 'LED-BASE') {
      mat.color.copy(CONFIG.LED_BASE_COLOR);
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
// Exploded view — component grouping
// ---------------------------------------------------------------------------
// Node names in this export are mostly anonymous Blender leftovers (Cube.041,
// Plane.012, ...) — only the diode/LDR/LED nodes above kept descriptive names.
// Materials, however, kept full names (MANGO-PI-BASE, ROTARY-ENCODER-BASE,
// ...), so components are resolved primarily by material, with a few explicit
// node-name overrides where a material is shared across two different
// physical parts (confirmed against the Blender file by hand).
// NOTE: three.js's GLTFLoader sanitizes node names for animation-binding
// safety, which strips dots — "Cube.007" in the .glb loads as "Cube007" here.
// These sets use the *runtime* (dot-stripped) names, not the Blender/.glb ones.
const DAC_NODE_OVERRIDE = new Set(['Cylinder007', 'Cube006', 'Cube007', 'Cube008', 'Cube009']);
const MANGOPI_NODE_OVERRIDE = new Set(['Cube', 'Cube001', 'Cube002']); // GPIO header pins + stray parts

// Blender authored one wire color inconsistently as "WIRE_INSULATION-GREEN"
// (underscore) instead of "WIRE-INSULATION-*" (hyphen) like every other color.
const isWireMaterial = (name) => name === 'JUMPER-WIRE-BLACK' || /^WIRE[-_]INSULATION/.test(name);

const MATERIAL_TO_GROUP = {
  'LASER-GOLD': 'laser_diodes', 'SOLDER-JOINTS': 'laser_diodes',
  'LASER-HOLES': 'laser_diodes', 'LASER-PCB': 'laser_diodes',
  'LED-BASE': 'led_strip', 'LED-LIGHTS': 'led_strip', 'COPPER': 'led_strip',
  'MAX-AMP-BASE': 'dac_board', 'TERMINAL-BASE-CONNECTOR': 'dac_board',
  'MANGO-PI-BASE': 'mangopi_board', 'DISSIPATORS': 'mangopi_board', 'CPU': 'mangopi_board',
  'WIFI/BT': 'mangopi_board', 'microSD': 'mangopi_board', 'USB-C': 'mangopi_board',
  'HDMI': 'mangopi_board', 'FPC': 'mangopi_board',
};
const MATERIAL_PREFIX_TO_GROUP = [
  ['ROTARY-ENCODER', 'rotary_encoder'],
  ['ELECTROCOOKIE', 'perfboard'],
  ['PERFBOARD', 'perfboard'],
  ['SPEAKER', 'speaker'],
];

// Fixed list, not derived from COMPONENT_INFO — 'body' lives in COMPONENT_INFO
// too (hoverable while exploded) but never explodes, so it's excluded here.
const EXPLODE_GROUP_KEYS = [
  'led_strip', 'perfboard', 'mangopi_board', 'dac_board',
  'rotary_encoder', 'speaker', 'laser_diodes', 'ldrs',
];
const componentGroups = Object.fromEntries(EXPLODE_GROUP_KEYS.map((k) => [k, []]));
const wireMeshes = [];
const meshToGroup = new Map();
let bodyMesh = null;

model.traverse((obj) => {
  if (!obj.isMesh) return;
  if (obj.name === 'GUITAR-BASE') { bodyMesh = obj; return; }

  let group = null;
  if (DAC_NODE_OVERRIDE.has(obj.name)) group = 'dac_board';
  else if (MANGOPI_NODE_OVERRIDE.has(obj.name)) group = 'mangopi_board';
  else if (/^LDR_string\d+$/.test(obj.name)) group = 'ldrs';
  else if (/^laser_diode_string\d+$/.test(obj.name)) group = 'laser_diodes';
  else {
    const matName = obj.material?.name ?? '';
    if (isWireMaterial(matName)) { wireMeshes.push(obj); return; }
    group = MATERIAL_TO_GROUP[matName]
      ?? MATERIAL_PREFIX_TO_GROUP.find(([prefix]) => matName.startsWith(prefix))?.[1]
      ?? null;
  }

  if (!group) {
    flag(`"${obj.name}" (material "${obj.material?.name}") didn't match any explode group or wire material — leaving it untouched.`);
    return;
  }
  // A node-name override can win a mesh whose *material* is a wire material
  // (e.g. Cube007/DAC, Cube/mangopi_board both authored with JUMPER-WIRE-BLACK).
  // That material is shared with real wire meshes, so cloning it here stops
  // the wire fade-out from also blanking this component to invisible.
  if (obj.material && isWireMaterial(obj.material.name)) obj.material = obj.material.clone();
  componentGroups[group].push(obj);
  meshToGroup.set(obj, group);
});

if (!bodyMesh) flag('GUITAR-BASE mesh not found — body hover card will be skipped.');
else meshToGroup.set(bodyMesh, 'body'); // hoverable while exploded, but never in componentGroups/explodeMeshes
for (const key of EXPLODE_GROUP_KEYS) {
  if (componentGroups[key].length === 0) flag(`Explode group "${key}" has no meshes.`);
}

// Snapshot taken once here, before any animation runs — this (not a reversed
// tween) is the source of truth reassembly always returns to.
const explodeMeshes = EXPLODE_GROUP_KEYS.flatMap((k) => componentGroups[k]);
const originalTransforms = new Map(
  explodeMeshes.map((mesh) => [mesh, { position: mesh.position.clone(), quaternion: mesh.quaternion.clone() }]),
);
// Body is hoverable but not in explodeMeshes (it doesn't move) — a separate
// raycast target list covers both.
const hoverMeshes = bodyMesh ? [...explodeMeshes, bodyMesh] : explodeMeshes;

const wireMaterials = new Set(wireMeshes.map((m) => m.material).filter(Boolean));
for (const mat of wireMaterials) mat.transparent = true;

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
// Exploded view — animation + toggle
// ---------------------------------------------------------------------------
function easeOutCubic(t) { return 1 - (1 - t) ** 3; }
function easeInCubic(t) { return t ** 3; }

let isExploded = false;
const meshAnimState = new Map(); // Object3D -> {fromPos, toPos, startTime, duration}
let wireFade = null;             // {visible, startTime, duration} | null
let beamFade = null;             // {startTime, duration} | null — fade-IN only; hide stays instant
// UnrealBloomPass's luminosity highpass is a threshold *gate*, not a dimmer:
// the moment a pixel's luma clears threshold + smoothWidth, the full HDR pixel
// feeds the blur, so the glow jumps from nothing to full beam brightness at
// the crossing instant no matter how the threshold moves. bloomPass.strength,
// by contrast, scales the bloom output linearly — so the reveal animates
// strength from 0 up to CONFIG.BLOOM_STRENGTH on the same eased timeline as
// the beam's opacity, and the glow rises smoothly in step with the beam.
let bloomStrengthFade = null;    // {startTime, duration} | null — fade-IN only
let beamRestoreAt = -Infinity;   // timestamp beams become visible again after reassembly
// Gates pluck interaction separately from beam.visible: visible flips true at
// the start of the reveal fade (still opacity 0), but the beam shouldn't be
// grabbable until it's actually visible on screen, i.e. the fade has finished.
let beamsInteractive = true;

// Toggle entry point. Always reads each mesh's *current* live position as the
// tween start, so re-toggling mid-animation is smooth rather than snapping —
// the only fixed reference point is originalTransforms, used as the tween end
// on reassembly and as the base offset is added to on explode.
function setExploded(target) {
  if (target === isExploded) return;
  isExploded = target;
  const now = performance.now();

  EXPLODE_GROUP_KEYS.forEach((key, i) => {
    const offset = EXPLODE_OFFSETS[key] ?? new THREE.Vector3();
    const startTime = now + i * CONFIG.EXPLODE_STAGGER_MS;
    for (const mesh of componentGroups[key]) {
      const original = originalTransforms.get(mesh);
      const toPos = target ? original.position.clone().add(offset) : original.position.clone();
      meshAnimState.set(mesh, { fromPos: mesh.position.clone(), toPos, startTime, duration: CONFIG.EXPLODE_DURATION_MS });
    }
  });

  const reassembleTotalMs = (EXPLODE_GROUP_KEYS.length - 1) * CONFIG.EXPLODE_STAGGER_MS + CONFIG.EXPLODE_DURATION_MS;

  if (target) {
    // Laser beams no longer make physical sense once diode/LDR pairs
    // separate; hide immediately, alongside the wires fading out.
    wireFade = { visible: false, startTime: now, duration: CONFIG.WIRE_HIDE_MS };
    beamFade = null;
    bloomStrengthFade = null;
    beamsInteractive = false;
    // Kill bloom outright so no residual glow lingers over the abrupt hide;
    // it fades back in with the beams on reassembly.
    bloomPass.strength = 0;
    for (const entry of beams) {
      if (!entry) continue;
      entry.beam.visible = false;
      entry.spark.visible = false;
    }
  } else {
    // Prime wires/beams invisible-but-primed now; their fade-in only starts
    // once every component has finished flying back, so nothing reappears
    // while parts are still mid-flight — the "it's all back together" moment
    // reads as one deliberate reveal instead of a snap.
    for (const mesh of wireMeshes) mesh.visible = true;
    for (const mat of wireMaterials) mat.opacity = 0;
    beamMaterial.opacity = 0;
    wireFade = { visible: true, startTime: now + reassembleTotalMs, duration: CONFIG.WIRE_REVEAL_MS };
    beamFade = { startTime: now + reassembleTotalMs, duration: CONFIG.BEAM_REVEAL_MS };
    bloomStrengthFade = { startTime: now + reassembleTotalMs, duration: CONFIG.BEAM_REVEAL_MS };
    beamRestoreAt = now + reassembleTotalMs;
  }

  updateExplodeToggleUI(target);
  if (!target) hideHoverCard(); // nothing left to hover once reassembling
}

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

function setPointerFromEvent(event) {
  pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
}

function pickString(event) {
  setPointerFromEvent(event);
  raycaster.setFromCamera(pointer, camera);
  // Toggled-off beams don't exist as far as the pointer is concerned.
  if (!beamsInteractive) return null;
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

// Component raycast — only live while exploded, reusing the same
// raycaster/pointer as the beam pluck path above for consistency.
function pickExplodedComponent(event) {
  setPointerFromEvent(event);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(hoverMeshes, false)[0];
  return hit ? meshToGroup.get(hit.object) : null;
}

renderer.domElement.addEventListener('pointermove', (event) => {
  if (isExploded) {
    // The info card is click-to-open (so it stays put while browsing its
    // images); hover only signals clickability via the cursor.
    renderer.domElement.style.cursor = pickExplodedComponent(event) ? 'pointer' : '';
    return;
  }
  updateHover(pickString(event));
});
renderer.domElement.addEventListener('pointerdown', (event) => {
  audioInit(); // AudioContext must start inside a user gesture
  if (isExploded) {
    // Click a component to pin its card; press on empty space to dismiss it.
    const group = pickExplodedComponent(event);
    if (group) showHoverCard(group);
    else hideHoverCard();
    return;
  }
  updateHover(pickString(event)); // touch: finger down breaks the beam
});
renderer.domElement.addEventListener('pointerup', (event) => {
  if (isExploded) return;
  // Touch has no hover: lifting the finger is leaving the beam. A mouse
  // button release doesn't unblock anything — the cursor is still in the beam.
  if (event.pointerType !== 'mouse') updateHover(null);
});
renderer.domElement.addEventListener('pointerleave', () => {
  // While exploded the card is click-pinned, so leaving the canvas (e.g. to
  // click the card's own thumbnails) must not dismiss it.
  if (isExploded) { renderer.domElement.style.cursor = ''; return; }
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

  // Exploded view: staggered position tween per component (holds at its
  // "from" position until its own start time, via the clamp below), plus the
  // wire/body opacity fades and the delayed beam restore on reassembly.
  for (const [mesh, anim] of meshAnimState) {
    const t = THREE.MathUtils.clamp((now - anim.startTime) / anim.duration, 0, 1);
    mesh.position.lerpVectors(anim.fromPos, anim.toPos, easeOutCubic(t));
    if (t >= 1) meshAnimState.delete(mesh);
  }
  if (wireFade && now >= wireFade.startTime) {
    const t = THREE.MathUtils.clamp((now - wireFade.startTime) / wireFade.duration, 0, 1);
    const opacity = wireFade.visible ? t : 1 - t;
    for (const mat of wireMaterials) mat.opacity = opacity;
    if (t >= 1) {
      if (!wireFade.visible) for (const mesh of wireMeshes) mesh.visible = false;
      wireFade = null;
    }
  }
  if (beamFade && now >= beamFade.startTime) {
    const t = THREE.MathUtils.clamp((now - beamFade.startTime) / beamFade.duration, 0, 1);
    // easeOut, not easeIn: the beam must clear the bloom threshold gate early
    // in the reveal (while bloom strength is still ~0), so the glow's ramp is
    // authored entirely by the strength fade below instead of popping on when
    // a slow opacity crawl finally crosses the gate near the end.
    beamMaterial.opacity = easeOutCubic(t) * CONFIG.BEAM_OPACITY;
    if (t >= 1) { beamFade = null; beamsInteractive = true; }
  }
  if (bloomStrengthFade && now >= bloomStrengthFade.startTime) {
    const t = THREE.MathUtils.clamp((now - bloomStrengthFade.startTime) / bloomStrengthFade.duration, 0, 1);
    // Same easeInCubic curve as beamFade, so the glow's amplitude rises in
    // lockstep with the beam's own brightness ramp.
    bloomPass.strength = easeInCubic(t) * CONFIG.BLOOM_STRENGTH;
    if (t >= 1) bloomStrengthFade = null;
  }
  if (!isExploded && beamRestoreAt <= now && beamRestoreAt !== -Infinity) {
    for (const entry of beams) if (entry) entry.beam.visible = true;
    beamRestoreAt = -Infinity;
  }

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

// ---------------------------------------------------------------------------
// Exploded-view UI — toggle button, hover card, lightbox, reference section
// ---------------------------------------------------------------------------
const explodeToggleBtn = document.querySelector('#explode-toggle');
const explodeHint = document.querySelector('#explode-hint');
const hoverCard = document.querySelector('#hover-card');
const hoverCardTitle = document.querySelector('#hover-card-title');
const hoverCardDescription = document.querySelector('#hover-card-description');
const hoverCardMedia = document.querySelector('#hover-card-media');
const lightbox = document.querySelector('#lightbox');

function updateExplodeToggleUI(target) {
  explodeToggleBtn.textContent = target ? 'Reassemble' : 'Exploded View';
  explodeToggleBtn.classList.toggle('active', target);
  explodeHint.classList.toggle('visible', target);
}
explodeToggleBtn.addEventListener('click', () => setExploded(!isExploded));

function makeMediaEl(item) {
  const el = document.createElement(item.type === 'video' ? 'video' : 'img');
  el.src = item.src;
  if (item.type === 'video') { el.muted = true; el.loop = true; el.playsInline = true; el.autoplay = true; }
  else el.alt = item.label ?? '';
  return el;
}

function openLightbox(item) {
  lightbox.innerHTML = '';
  const el = makeMediaEl(item);
  // Inline previews stay muted (autoplay policy), but the lightbox is opened
  // by a click — a real user gesture — so its videos can play with sound.
  if (el.tagName === 'VIDEO') { el.controls = true; el.muted = false; }
  lightbox.appendChild(el);
  lightbox.classList.add('visible');
}
lightbox.addEventListener('click', () => {
  lightbox.classList.remove('visible');
  stopMedia(lightbox);
});

// Renders a media[] array into `container`: first item large/primary, the
// rest as small clickable thumbnails that swap into the primary slot. Shared
// by the hover card and the reference-section cards below.
// Detached <video> elements can keep their audio running in some browsers,
// so anything that discards media must pause it explicitly first.
function stopMedia(container) {
  container.querySelectorAll('video').forEach((v) => v.pause());
  container.innerHTML = '';
}

function renderMedia(container, media) {
  stopMedia(container);
  if (!media.length) return;

  const primaryWrap = document.createElement('div');
  primaryWrap.className = 'media-primary';
  container.appendChild(primaryWrap);

  let thumbsWrap = null;
  if (media.length > 1) {
    thumbsWrap = document.createElement('div');
    thumbsWrap.className = 'media-thumbs';
    media.forEach((item, i) => {
      const thumb = makeMediaEl(item);
      thumb.className = 'thumb';
      thumb.addEventListener('click', () => setPrimary(i));
      thumbsWrap.appendChild(thumb);
    });
    container.appendChild(thumbsWrap);
  }

  function setPrimary(index) {
    stopMedia(primaryWrap);
    const el = makeMediaEl(media[index]);
    if (el.tagName === 'VIDEO') {
      // The card only ever renders from a click (pinning it or tapping a
      // thumbnail), so that gesture lets the primary video play once through
      // WITH sound. If the browser still refuses (strict autoplay settings),
      // fall back to the standard muted loop rather than a frozen frame.
      el.autoplay = false;
      el.loop = false;
      el.muted = false;
      el.play().catch(() => { el.muted = true; el.loop = true; el.play(); });
    }
    el.addEventListener('click', () => openLightbox(media[index]));
    primaryWrap.appendChild(el);
    thumbsWrap?.querySelectorAll('.thumb').forEach((t, i) => t.classList.toggle('active', i === index));
  }
  setPrimary(0);
}

let hoverCardGroup = null;
function showHoverCard(group) {
  if (group === hoverCardGroup) return;
  hoverCardGroup = group;
  const info = COMPONENT_INFO[group];
  hoverCardTitle.textContent = info.title;
  hoverCardDescription.textContent = info.description;
  renderMedia(hoverCardMedia, info.media);
  hoverCard.classList.add('visible');
}
function hideHoverCard() {
  hoverCardGroup = null;
  hoverCard.classList.remove('visible');
  // The card only fades to opacity 0 — it stays in the DOM, so any unmuted
  // video would keep sounding after dismissal unless stopped here.
  stopMedia(hoverCardMedia);
}

// Static reference section (Part 2) — one card per component, mirroring
// COMPONENT_INFO so it never drifts out of sync with the hover cards above.
const referenceGrid = document.querySelector('#reference-grid');
for (const key of EXPLODE_GROUP_KEYS) {
  const info = COMPONENT_INFO[key];
  const card = document.createElement('div');
  card.className = 'panel ref-card';

  const first = info.media[0];
  if (first) {
    const media = makeMediaEl(first);
    media.className = 'ref-media';
    media.addEventListener('click', () => openLightbox(first));
    card.appendChild(media);
  } else {
    const placeholder = document.createElement('div');
    placeholder.className = 'ref-media-placeholder';
    placeholder.textContent = 'Photo coming soon';
    card.appendChild(placeholder);
  }

  const body = document.createElement('div');
  body.className = 'ref-body';
  const h3 = document.createElement('h3');
  h3.textContent = info.title;
  const p = document.createElement('p');
  p.textContent = info.description;
  body.append(h3, p);
  card.appendChild(body);

  referenceGrid.appendChild(card);
}

// Assets are in: turn the loading screen into a dimmed entry gate. Hover-
// plucking can't unlock audio (pointermove isn't a "user gesture" under
// autoplay policy), so route everyone through one natural click — it starts
// the sound and drops the gate before any beam can be reached.
const gate = document.querySelector('#loading');
gate.textContent = 'Click anywhere to begin - then move your cursor across the lasers to play the guitar';
gate.classList.add('ready');
gate.addEventListener('pointerdown', () => {
  audioInit(); // this trusted click resumes the suspended AudioContext
  gate.classList.add('done');
}, { once: true });
console.log('[laser-guitar] ready —', NUM_STRINGS, 'beams,', ledsByString.flat().length, 'LEDs');
