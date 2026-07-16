// Sample-for-sample port of the firmware's audio.c to an AudioWorkletProcessor.
//
// Mapping from the C code:
//   generate_chunk() / i2s double-buffering  ->  process() — the browser calls
//     this repeatedly for small blocks (128 samples), which is exactly the
//     "generate small chunks in a loop" streaming design from the firmware.
//   audio_pluck()                            ->  'pluck' message from the main thread
//
// The tables, fixed-point formats (sine Q1.15, phase Q6.10), harmonic mix,
// per-chunk decay stepping, and int16 clipping are identical to audio.c, so
// this sounds the same as the hardware. The only new step is the final
// /32768 — Web Audio wants floats in [-1, 1] instead of int16.

const NUM_STRINGS = 6;

// In audio.c the decay advances once per 1500-sample chunk (96000/64), giving
// a 2-second note at 48 kHz. Scale by the actual context rate so the decay
// stays 2 s even if the browser refuses 48 kHz.
const DECAY_STEP_SAMPLES = Math.round(1500 * sampleRate / 48000);

// A pre-generated sine wave with 64 points, 1.15 fixed point.
const sine_wave_table = new Int16Array([
       0,  3211,  6392,  9511, 12539, 15446, 18204, 20787,
   23169, 25329, 27244, 28897, 30272, 31356, 32137, 32609,
   32767, 32609, 32137, 31356, 30272, 28897, 27244, 25329,
   23169, 20787, 18204, 15446, 12539,  9511,  6392,  3211,
       0, -3211, -6392, -9511,-12539,-15446,-18204,-20787,
  -23169,-25329,-27244,-28897,-30272,-31356,-32137,-32609,
  -32767,-32609,-32137,-31356,-30272,-28897,-27244,-25329,
  -23169,-20787,-18204,-15446,-12539, -9511, -6392, -3211,
]);

// e^(-k*t) is the natural decay of a plucked string.
const exp_decay_table = new Int16Array([
  32767, 30634, 28649, 26791, 25054, 23431, 21907, 20482,
  19144, 17896, 16727, 15631, 14605, 13641, 12735, 11885,
  11085, 10335,  9629,  8968,  8347,  7763,  7214,  6698,
   6212,  5756,  5328,  4924,  4544,  4187,  3851,  3535,
   3238,  2959,  2697,  2451,  2220,  2004,  1802,  1614,
   1440,  1279,  1130,   994,   869,   755,   652,   560,
    479,   408,   345,   291,   244,   204,   170,   141,
    117,    97,    80,    66,    55,    45,    37,    31,
]);

class LaserGuitarProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cur_volume = 10000; // firmware's default volume, fixed (loudness = OS volume)
    // active_notes_t, one per string. cur_sine (the Q6.10 phase) was uint16_t
    // in C so it wrapped mod 65536 for free; here `& 0xFFFF` does that job.
    this.notes = Array.from({ length: NUM_STRINGS }, () => ({
      active: false,
      sine_step: 0,
      cur_sine: 0,
      cur_decay: 0,
      chunk_pos: 0, // samples rendered since cur_decay last advanced
    }));

    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'pluck') {
        const note = this.notes[msg.string];
        note.sine_step = Math.floor(65536 * msg.frequency / sampleRate) & 0xFFFF;
        note.active = true;
        note.cur_sine = 0;
        note.cur_decay = 0;
        note.chunk_pos = 0;
      }
    };
  }

  process(inputs, outputs) {
    const out = outputs[0][0];

    for (let i = 0; i < out.length; i++) {
      let mixed = 0; // the int32 all_samples[] accumulator

      for (const note of this.notes) {
        if (!note.active) continue;

        // get_string_sample(), verbatim.
        const amplitude = exp_decay_table[note.cur_decay];
        note.cur_sine = (note.cur_sine + note.sine_step) & 0xFFFF;
        const p = note.cur_sine;
        const sample = sine_wave_table[p >> 10]                        // fundamental
                     + (sine_wave_table[(p >> 9) & 63] >> 1)           // 2nd harmonic
                     + (sine_wave_table[((p * 3) >> 10) & 63] >> 2)    // 3rd harmonic
                     + (sine_wave_table[(p >> 8) & 63] >> 3);          // 4th harmonic
        mixed += (((sample * amplitude) >> 15) * this.cur_volume) >> 15;

        // audio.c advances cur_decay once per generate_chunk() call.
        if (++note.chunk_pos >= DECAY_STEP_SAMPLES) {
          note.chunk_pos = 0;
          if (++note.cur_decay >= 64) note.active = false;
        }
      }

      // Same int16 clip as generate_chunk(), then to Web Audio's float range.
      if (mixed > 32767) mixed = 32767;
      if (mixed < -32768) mixed = -32768;
      out[i] = mixed / 32768;
    }

    return true; // keep the processor alive between notes
  }
}

registerProcessor('laser-guitar-audio', LaserGuitarProcessor);
