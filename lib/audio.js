// G.711 mu-law <-> PCM16, resampling, WAV container, and a simple energy VAD.
// Twilio Media Streams send/expect 8 kHz mono mu-law (PCMU), base64, in 20ms frames (160 bytes).

const BIAS = 0x84;
const CLIP = 32635;

export function muLawDecodeSample(uVal) {
  uVal = ~uVal & 0xff;
  let t = ((uVal & 0x0f) << 3) + BIAS;
  t <<= (uVal & 0x70) >> 4;
  return (uVal & 0x80) ? (BIAS - t) : (t - BIAS);
}

export function muLawEncodeSample(sample) {
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

// Buffer of mu-law bytes -> Int16Array PCM (8 kHz)
export function muLawBufferToPcm16(muBuf) {
  const out = new Int16Array(muBuf.length);
  for (let i = 0; i < muBuf.length; i++) out[i] = muLawDecodeSample(muBuf[i]);
  return out;
}

// Int16Array PCM -> Buffer of mu-law bytes
export function pcm16ToMuLawBuffer(pcm) {
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = muLawEncodeSample(pcm[i]);
  return out;
}

// Linear resampler for Int16 PCM. Good enough for telephony-band speech.
export function resamplePcm16(pcm, fromRate, toRate) {
  if (fromRate === toRate) return pcm;
  const ratio = toRate / fromRate;
  const outLen = Math.round(pcm.length * ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i / ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, pcm.length - 1);
    const frac = srcPos - i0;
    out[i] = (pcm[i0] * (1 - frac) + pcm[i1] * frac) | 0;
  }
  return out;
}

// Wrap Int16 PCM into a WAV (RIFF) file buffer.
export function pcm16ToWav(pcm, sampleRate) {
  const dataLen = pcm.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);          // PCM chunk size
  buf.writeUInt16LE(1, 20);           // audio format = PCM
  buf.writeUInt16LE(1, 22);           // channels = mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32);           // block align
  buf.writeUInt16LE(16, 34);          // bits per sample
  buf.write("data", 36);
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i], 44 + i * 2);
  return buf;
}

// Extract Int16 PCM + sampleRate from a WAV buffer (parses fmt/data chunks).
export function wavToPcm16(wavBuf) {
  let sampleRate = 8000;
  let offset = 12; // skip RIFF....WAVE
  let dataStart = -1;
  let dataLen = 0;
  while (offset + 8 <= wavBuf.length) {
    const id = wavBuf.toString("ascii", offset, offset + 4);
    const size = wavBuf.readUInt32LE(offset + 4);
    if (id === "fmt ") sampleRate = wavBuf.readUInt32LE(offset + 12);
    if (id === "data") { dataStart = offset + 8; dataLen = size; break; }
    offset += 8 + size + (size % 2);
  }
  if (dataStart < 0) return { pcm: new Int16Array(0), sampleRate };
  const n = Math.floor(dataLen / 2);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = wavBuf.readInt16LE(dataStart + i * 2);
  return { pcm, sampleRate };
}

// RMS energy of a PCM frame (0..~32768). Used for voice-activity detection.
export function frameRms(pcm) {
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  return Math.sqrt(sum / Math.max(1, pcm.length));
}

// Simple turn-taking VAD state machine fed one 20ms frame (mu-law) at a time.
// Emits a finalized utterance (mu-law Buffer) after trailing silence.
export class TurnDetector {
  constructor({ rmsThreshold = 700, silenceMs = 700, minSpeechMs = 250 } = {}) {
    this.rmsThreshold = rmsThreshold;
    this.silenceFrames = Math.round(silenceMs / 20);
    this.minSpeechFrames = Math.round(minSpeechMs / 20);
    this.reset();
  }
  reset() {
    this.buffer = [];
    this.speechFrames = 0;
    this.trailingSilence = 0;
    this.inSpeech = false;
  }
  // returns { speaking, utterance } — utterance is a mu-law Buffer when a turn ends
  push(muFrame) {
    const pcm = muLawBufferToPcm16(muFrame);
    const rms = frameRms(pcm);
    const voiced = rms > this.rmsThreshold;

    if (voiced) {
      this.inSpeech = true;
      this.speechFrames++;
      this.trailingSilence = 0;
      this.buffer.push(muFrame);
      return { speaking: true, utterance: null };
    }

    if (this.inSpeech) {
      this.buffer.push(muFrame);
      this.trailingSilence++;
      if (this.trailingSilence >= this.silenceFrames) {
        const enough = this.speechFrames >= this.minSpeechFrames;
        const utterance = enough ? Buffer.concat(this.buffer) : null;
        this.reset();
        return { speaking: false, utterance };
      }
      return { speaking: true, utterance: null };
    }
    return { speaking: false, utterance: null };
  }
}
