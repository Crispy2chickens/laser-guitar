// Main-thread half of the audio port — the equivalent of audio.h's public API
// (audio_init / audio_pluck). The synthesis itself lives in audio-worklet.js
// and runs on the audio thread. Output level is fixed at the firmware's
// default volume; loudness is left to the OS/system volume.

// notes.h equivalent: string index -> frequency in integer Hz (E2 A2 D3 G3 B3 E4),
// matching the firmware's int note frequencies. If string 1 in the model turns
// out to be the *high* E, just reverse this array.
export const STRING_FREQUENCIES = [82, 110, 147, 196, 247, 330];

let ctx = null;
let node = null;
let initPromise = null;

// Safe to call often. Called once at page load to preload + compile the
// worklet (the context comes up "suspended" per browser autoplay policy),
// then again from the pointerdown handler, where the user gesture lets the
// suspended context resume — that part is instant.
export function audioInit() {
  if (!initPromise) {
    initPromise = (async () => {
      // Ask for 48 kHz to match the firmware's I2S rate; the worklet rescales
      // its decay timing if the hardware forces a different rate.
      ctx = new AudioContext({ sampleRate: 48000 });
      await ctx.audioWorklet.addModule('./audio-worklet.js');
      node = new AudioWorkletNode(ctx, 'laser-guitar-audio', {
        numberOfInputs: 0,
        outputChannelCount: [1], // I2S_MONO
      });
      node.connect(ctx.destination);
    })();
  }
  if (ctx && ctx.state === 'suspended') ctx.resume();
  return initPromise;
}

export function audioPluck(stringIndex) {
  const frequency = STRING_FREQUENCIES[stringIndex];
  if (frequency === undefined) return;
  audioInit().then(() => {
    node.port.postMessage({ type: 'pluck', string: stringIndex, frequency });
  });
}
