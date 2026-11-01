/**
 * WAV (PCM 16-bit) writer / reader plus a couple of signal helpers.
 * Pure Node, no dependencies, deterministic output.
 */

/**
 * Write a 16-bit PCM WAV file.
 *
 * @param {{sampleRate:number, channels:number, frames:Float32Array[]|Function}} spec
 * @returns {Buffer}
 */
export function writeWAV({ sampleRate = 44100, channels = 2, frames }) {
  const perChannel =
    typeof frames === 'function'
      ? (() => {
          const out = Array.from({ length: channels }, () => []);
          const total = Math.round(sampleRate * (frames.durationSeconds ?? 0));
          for (let i = 0; i < total; i += 1) {
            const s = frames(i / sampleRate, i);
            for (let c = 0; c < channels; c += 1) out[c].push(s[c]);
          }
          return out.map((a) => Float32Array.from(a));
        })()
      : frames;

  const numFrames = perChannel[0].length;
  const dataBytes = numFrames * channels * 2;
  const buf = Buffer.alloc(44 + dataBytes);

  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'latin1');
  buf.write('fmt ', 12, 'latin1');
  buf.writeUInt32LE(16, 16); // PCM chunk size
  buf.writeUInt16LE(1, 20); // format = PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * 2, 28); // byte rate
  buf.writeUInt16LE(channels * 2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'latin1');
  buf.writeUInt32LE(dataBytes, 40);

  let offset = 44;
  for (let i = 0; i < numFrames; i += 1) {
    for (let c = 0; c < channels; c += 1) {
      let v = perChannel[c][i];
      v = v > 1 ? 1 : v < -1 ? -1 : v;
      buf.writeInt16LE(Math.round(v * 32767), offset);
      offset += 2;
    }
  }
  return buf;
}

/**
 * Parse a 16-bit PCM WAV file.
 * @returns {{sampleRate:number, channels:number, numFrames:number, frames:Float32Array[]}}
 */
export function readWAV(buffer) {
  if (buffer.toString('latin1', 0, 4) !== 'RIFF' || buffer.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error('readWAV: not a RIFF/WAVE file');
  }
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('latin1', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = buffer.subarray(offset + 8, offset + 8 + size);
    if (id === 'fmt ') {
      channels = body.readUInt16LE(2);
      sampleRate = body.readUInt32LE(4);
      bits = body.readUInt16LE(14);
    } else if (id === 'data') {
      data = body;
    }
    offset += 8 + size + (size % 2);
  }
  if (!data) throw new Error('readWAV: no data chunk');
  if (bits !== 16) throw new Error(`readWAV: only 16-bit PCM is supported (got ${bits})`);

  const numFrames = Math.floor(data.length / (channels * 2));
  const frames = Array.from({ length: channels }, () => new Float32Array(numFrames));
  for (let i = 0; i < numFrames; i += 1) {
    for (let c = 0; c < channels; c += 1) {
      frames[c][i] = data.readInt16LE((i * channels + c) * 2) / 32768;
    }
  }
  return { sampleRate, channels, numFrames, frames };
}

/** Root-mean-square level of a sample array. */
export function rms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, samples.length));
}

/**
 * Goertzel algorithm: magnitude of one frequency bin.
 * Handy for asserting "the left channel carries 440 Hz" without any DSP
 * dependency.
 */
export function goertzel(samples, freq, sampleRate) {
  const k = Math.round((samples.length * freq) / sampleRate);
  const w = (2 * Math.PI * k) / samples.length;
  const coeff = 2 * Math.cos(w);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < samples.length; i += 1) {
    s0 = samples[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / samples.length;
}
