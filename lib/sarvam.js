// Sarvam AI integration: Speech-to-Text (Saarika) and Text-to-Speech (Bulbul).
// Docs: https://docs.sarvam.ai  | Auth header: api-subscription-key
import { pcm16ToWav, wavToPcm16, resamplePcm16, muLawBufferToPcm16, pcm16ToMuLawBuffer } from "./audio.js";

// ── Telugu number/time sanitizer ─────────────────────────────────────────────
// Bulbul TTS cannot pronounce digits, "AM/PM", or "₹" in Telugu text.
// This runs on every Telugu reply before TTS and converts those patterns to
// spoken Telugu words so the audio sounds natural.

const TE_ONES = [
  "", "ఒకటి","రెండు","మూడు","నాలుగు","అయిదు","ఆరు","ఏడు","ఎనిమిది","తొమ్మిది",
  "పది","పదకొండు","పన్నెండు","పదమూడు","పదునాలుగు","పదిహేను","పదహారు","పదిహేడు","పద్దెనిమిది","పంతొమ్మిది",
];
const TE_TENS = ["","","ఇరవై","ముప్పై","నలభై","యాభై","అరవై","డెబ్బై","ఎనభై","తొంభై"];
const TE_DIG  = ["సున్న","ఒకటి","రెండు","మూడు","నాలుగు","అయిదు","ఆరు","ఏడు","ఎనిమిది","తొమ్మిది"];

function numToTe(n) {
  n = Math.round(+n);
  if (n === 0) return "సున్న";
  if (n < 20)  return TE_ONES[n];
  if (n < 100) return TE_TENS[Math.floor(n / 10)] + (n % 10 ? " " + TE_ONES[n % 10] : "");
  if (n < 1000) {
    const h = Math.floor(n / 100), r = n % 100;
    return (h === 1 ? "వంద" : TE_ONES[h] + " వందలు") + (r ? " " + numToTe(r) : "");
  }
  if (n < 100000) {
    const k = Math.floor(n / 1000), r = n % 1000;
    return numToTe(k) + " వేలు" + (r ? " " + numToTe(r) : "");
  }
  return String(n);
}

function timeToTe(h, m, period) {
  h = +h; m = +m;
  if (period) {
    const p = period.toUpperCase();
    if (p === "PM" && h !== 12) h += 12;
    if (p === "AM" && h === 12) h = 0;
  }
  const prefix = h < 5 ? "రాత్రి" : h < 12 ? "ఉదయం" : h === 12 ? "మధ్యాహ్నం" : h < 17 ? "మధ్యాహ్నం" : h < 20 ? "సాయంత్రం" : "రాత్రి";
  const h12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
  const mStr = m === 0 ? "గంటలకు" : `గంటల ${numToTe(m)} నిమిషాలకు`;
  return `${prefix} ${numToTe(h12)} ${mStr}`;
}

// Apply before sending to Bulbul — only for Telugu (te-IN).
export function sanitizeForTelugu(text) {
  if (!text) return text;
  // 1. 10-digit phone numbers → each digit in Telugu
  text = text.replace(/\b(\d{10})\b/g, (_, d) => d.split("").map(c => TE_DIG[+c]).join(" "));
  // 2. "H:MM AM/PM" times
  text = text.replace(/\b(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)\b/g, (_, h, m, p) => timeToTe(h, m, p));
  // 3. "H AM/PM" times (no minutes)
  text = text.replace(/\b(\d{1,2})\s*(AM|PM|am|pm)\b/g, (_, h, p) => timeToTe(h, 0, p));
  // 4. "H:MM" with no period (lone time — e.g. "5:00")
  text = text.replace(/\b([1-9]|1[0-2]):([0-5]\d)\b/g, (_, h, m) => timeToTe(h, m, null));
  // 5. Currency ₹NNN or Rs NNN
  text = text.replace(/[₹]\s*(\d+)/g, (_, n) => numToTe(+n) + " రూపాయలు");
  text = text.replace(/\bRs\.?\s*(\d+)\b/gi, (_, n) => numToTe(+n) + " రూపాయలు");
  // 6. Remaining standalone 1–3 digit numbers (conservative — avoids PIN codes, 4-digit+ years)
  text = text.replace(/\b(\d{1,3})\b/g, (_, n) => numToTe(+n));
  return text;
}

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
  // Convert numbers/times/prices to Telugu words — Bulbul cannot pronounce digits.
  const sanitized = languageCode.startsWith("te") ? sanitizeForTelugu(text) : text;
  const clean = sanitized.slice(0, 1500); // stay under Bulbul's per-request cap
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
