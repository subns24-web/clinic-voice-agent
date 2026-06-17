// Sarvam AI integration: Speech-to-Text (Saarika) and Text-to-Speech (Bulbul).
// Docs: https://docs.sarvam.ai  | Auth header: api-subscription-key
import { pcm16ToWav, wavToPcm16, resamplePcm16, muLawBufferToPcm16, pcm16ToMuLawBuffer } from "./audio.js";

const SARVAM_BASE = "https://api.sarvam.ai";
const API_KEY = process.env.SARVAM_API_KEY;
const STT_MODEL = process.env.SARVAM_STT_MODEL || "saarika:v2.5";
const TTS_MODEL = process.env.SARVAM_TTS_MODEL || "bulbul:v2";
const TTS_SPEAKER = process.env.SARVAM_TTS_SPEAKER || "anushka";

// Transcribe a caller utterance (mu-law 8kHz Buffer) -> { text, languageCode }.
// Saarika PCM/WAV input is best at 16 kHz, so we upsample 8k -> 16k before sending.
export async function transcribe(muLawBuffer) {
  const pcm8k = muLawBufferToPcm16(muLawBuffer);
  const pcm16k = resamplePcm16(pcm8k, 8000, 16000);
  const wav = pcm16ToWav(pcm16k, 16000);

  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
  form.append("model", STT_MODEL);
  form.append("language_code", "unknown"); // auto-detect te-IN / en-IN code-mixing

  const res = await fetch(`${SARVAM_BASE}/speech-to-text`, {
    method: "POST",
    headers: { "api-subscription-key": API_KEY },
    body: form,
  });
  if (!res.ok) throw new Error(`Sarvam STT ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return { text: (json.transcript || "").trim(), languageCode: json.language_code || "te-IN" };
}

// Synthesize speech -> mu-law 8kHz Buffer ready to stream to Twilio.
// We ask Sarvam for 8 kHz PCM directly so no resample is needed on the way out.
export async function synthesize(text, languageCode = "te-IN") {
  const clean = text.slice(0, 1500); // stay under Bulbul's per-request cap
  const res = await fetch(`${SARVAM_BASE}/text-to-speech`, {
    method: "POST",
    headers: { "api-subscription-key": API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      inputs: [clean],
      target_language_code: languageCode,
      speaker: TTS_SPEAKER,
      model: TTS_MODEL,
      speech_sample_rate: 8000,
      enable_preprocessing: true,
    }),
  });
  if (!res.ok) throw new Error(`Sarvam TTS ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const b64 = json.audios?.[0];
  if (!b64) throw new Error("Sarvam TTS returned no audio");

  const wav = Buffer.from(b64, "base64");
  let { pcm, sampleRate } = wavToPcm16(wav);
  if (sampleRate !== 8000) pcm = resamplePcm16(pcm, sampleRate, 8000);
  return pcm16ToMuLawBuffer(pcm); // mu-law 8kHz
}
