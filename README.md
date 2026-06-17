# Clinic Voice Agent (Telugu + English)

A real-time phone agent for clinics. Patients call in (or the agent calls out), and it
**books appointments, answers FAQs, captures leads, and routes urgent cases** — speaking
Telugu by default and switching to English when the caller does.

**Stack:** Twilio (telephony, Media Streams) ⇄ this Node.js server ⇄ Sarvam AI (Telugu STT + TTS) ⇄ an LLM brain (OpenAI or Sarvam-M).

```
Caller ⇄ Twilio ⇄ WebSocket ⇄ [ VAD → Sarvam STT → LLM → Sarvam TTS ] ⇄ Caller
```

---

## What you need (accounts + keys)

| Service | Why | Where |
|---|---|---|
| **Twilio** (you have it) | The phone line | console.twilio.com |
| **Sarvam AI** | Telugu speech-to-text + text-to-speech (speech only) | dashboard.sarvam.ai |
| **OpenAI** | The conversation brain (fast, ~1s). Required — Sarvam's chat models are reasoning-based and too slow for live calls. | platform.openai.com |
| **ngrok** (for local testing) | Gives Twilio a public URL to reach your laptop | ngrok.com |

Cost is usage-based — roughly **₹7–13 per call-minute** all-in (telephony + STT + LLM + TTS).

---

## Setup (one time)

```bash
cd clinic-voice-agent
npm install
cp .env.example .env
# then edit .env and paste in your keys
```

Fill in `.env`:
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` — Twilio Console home page.
- `TWILIO_PHONE_NUMBER` — a **voice-capable** Twilio number in `+E.164` form.
- `SARVAM_API_KEY` — from the Sarvam dashboard.
- `OPENAI_API_KEY` — from OpenAI (the brain). Keep `BRAIN_PROVIDER=openai`.
- `CLINIC_ESCALATION_NUMBER` — clinic staff number for urgent transfers (optional).

Then **edit `config/clinic.js`** with the real clinic's name, hours, address, services/fees,
doctors, and the appointment slots the agent is allowed to offer.

---

## Run it locally + connect Twilio

1. **Start the server**
   ```bash
   npm start
   ```
2. **Expose it** (new terminal) so Twilio can reach it:
   ```bash
   ngrok http 3000
   ```
   Copy the `https://....ngrok-free.app` URL into `.env` as `PUBLIC_BASE_URL`, then
   restart `npm start`.
3. **Point your Twilio number at it.** In Twilio Console →
   *Phone Numbers → Manage → Active numbers → (your number) → Voice Configuration*:
   - **A call comes in** → Webhook → `https://YOUR-NGROK-URL/voice/inbound` → HTTP POST → Save.

### Test inbound
Call your Twilio number from one of your **verified** numbers
(`+91 99636 46301` / `+91 63045 09465`). The agent should greet you in Telugu and respond.

### Test outbound
```bash
node scripts/outbound.js +919963646301
```
> ⚠️ On a **trial** Twilio account you can only call your verified numbers, and Twilio
> plays a trial notice first. Upgrade to call real patients.

---

## Where leads/bookings go
Captured bookings and leads are appended to `data/leads.csv`
(`timestamp, callSid, direction, type, patientName, phone, reason, slot`).
To push them to **Google Sheets or the clinic's CRM**, edit `saveLead()` in `lib/leads.js`.

---

## Going to production (important for India)
- **Telephony:** Twilio is great for building/demo. For selling to AP clinics, evaluate an
  Indian provider (**Exotel / Plivo / Ozonetel**) — cheaper local rates, local numbers, and
  **TRAI/DLT** compliance for automated calling. Swap the telephony layer; the audio bridge stays.
- **Compliance:** Automated outbound telemarketing in India needs **DLT registration** and must
  respect **DND**. Patient data falls under the **DPDP Act 2023** — get consent and secure `data/`.
- **Real calendar:** wire `config/clinic.js` appointment slots to the clinic's actual calendar
  so the agent only offers free times.

---

## Tuning
- **Barge-in / interruptions:** thresholds in `server.js` (`rms > 1200`) and
  `TurnDetector` options in `lib/audio.js` (`rmsThreshold`, `silenceMs`).
- **Voice:** `SARVAM_TTS_SPEAKER` in `.env` (Telugu speakers: Anushka, Manisha, Vidya, Arya, ...).
- **Brain:** `OPENAI_MODEL` (default `gpt-4.1-mini`). `BRAIN_PROVIDER=sarvam` exists but is **not** recommended — Sarvam chat models reason for several seconds, causing dead air on calls.

## Project layout
```
server.js            HTTP webhooks + WebSocket media bridge + call control
lib/audio.js         mu-law <-> PCM, resampling, WAV, VAD/turn detection
lib/sarvam.js        Sarvam STT + TTS
lib/brain.js         LLM conversation + clinic playbook (book/FAQ/lead/urgent)
lib/leads.js         lead/booking persistence (CSV; swap for Sheets/CRM)
config/clinic.js     >>> EDIT per clinic <<<  facts, fees, slots
scripts/outbound.js  CLI to place an outbound call
```
