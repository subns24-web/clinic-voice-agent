import "dotenv/config";
import express from "express";
import { WebSocketServer } from "ws";
import http from "http";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import twilio from "twilio";

import { channels, getChannel } from "./config/channels.js";
import { TurnDetector, muLawBufferToPcm16, frameRms } from "./lib/audio.js";
import { transcribe, synthesize } from "./lib/sarvam.js";
import { Conversation } from "./lib/brain.js";
import { saveLead, readLeads } from "./lib/leads.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const tw = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const STARTED_AT = Date.now();

// ---- Live tracking (in-memory) for the dashboard ----
const activeCalls = new Map(); // callSid -> { callSid, direction, startedAt, lastText, turns }
const events = []; // ring buffer of recent call events, newest pushed to end
function logEvent(type, callSid, data = {}) {
  events.push({ ts: new Date().toISOString(), type, callSid, ...data });
  if (events.length > 300) events.shift();
}

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ---- Admin login (HTTP Basic Auth) ----
// Protects the dashboard + its APIs. Twilio's webhooks (/voice/*) and the media
// stream (/stream WS) must stay open, and the health check (/api/status) too,
// so Render can probe it. Credentials come from env, never hardcoded.
const ADMIN_USER = process.env.ADMIN_USER || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const AUTH_EXEMPT = [/^\/voice\b/, /^\/stream\b/, /^\/api\/status\b/];

function timingSafeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ab, bb); } catch { return false; }
}

app.use((req, res, next) => {
  // No credentials configured -> auth disabled (e.g. local dev before .env set).
  if (!ADMIN_USER || !ADMIN_PASSWORD) return next();
  if (AUTH_EXEMPT.some((re) => re.test(req.path))) return next();

  const header = req.headers.authorization || "";
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const i = decoded.indexOf(":");
    const user = decoded.slice(0, i);
    const pass = decoded.slice(i + 1);
    if (timingSafeEqual(user, ADMIN_USER) && timingSafeEqual(pass, ADMIN_PASSWORD)) {
      return next();
    }
  }
  res.set("WWW-Authenticate", 'Basic realm="SN Trinetra Admin", charset="UTF-8"');
  return res.status(401).send("Authentication required.");
});

app.use(express.static(path.join(__dirname, "public")));

const DEFAULT_CHANNEL = process.env.CHANNEL || "clinic";
const wsUrl = () => PUBLIC_BASE_URL.replace(/^http/, "ws") + "/stream";

// TwiML that connects the call's audio to our WebSocket (bidirectional).
// `channel` selects which business persona the agent runs (clinic / tailor).
function streamTwiml(direction, channelId) {
  const ch = channels[channelId] ? channelId : DEFAULT_CHANNEL;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl()}">
      <Parameter name="direction" value="${direction}" />
      <Parameter name="channel" value="${ch}" />
    </Stream>
  </Connect>
</Response>`;
}

app.get("/", (_req, res) => res.redirect("/dashboard"));
app.get("/dashboard", (_req, res) => {
  res.set("Cache-Control", "no-store, must-revalidate");
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

// ---- Dashboard API ----
app.get("/api/status", (_req, res) => {
  const dch = getChannel(DEFAULT_CHANNEL);
  res.json({
    clinic: { name: dch.name, city: dch.city }, // back-compat key
    defaultChannel: DEFAULT_CHANNEL,
    channels: Object.values(channels).map((c) => ({ id: c.id, name: c.name, type: c.type })),
    publicUrl: PUBLIC_BASE_URL || null,
    twilioNumber: process.env.TWILIO_PHONE_NUMBER || null,
    escalation: process.env.CLINIC_ESCALATION_NUMBER || null,
    providers: {
      openai: Boolean(process.env.OPENAI_API_KEY),
      sarvam: Boolean(process.env.SARVAM_API_KEY),
      twilio: Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
      brain: process.env.BRAIN_PROVIDER || "openai",
    },
    uptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000),
    activeCalls: [...activeCalls.values()],
    usdInr: USD_INR,
  });
});

// List available channels (businesses) the agent can run.
app.get("/api/channels", (_req, res) => {
  res.json(Object.values(channels).map((c) => ({ id: c.id, name: c.name, type: c.type })));
});

app.get("/api/leads", (_req, res) => {
  try { res.json(readLeads()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Download the raw leads/bookings CSV.
app.get("/leads.csv", (_req, res) => {
  const file = path.join(__dirname, "data", "leads.csv");
  res.download(file, "leads.csv", (err) => { if (err) res.status(404).send("no leads yet"); });
});

app.get("/api/events", (_req, res) => {
  res.json(events.slice(-80).reverse());
});

// Recent calls straight from Twilio.
app.get("/api/calls", async (_req, res) => {
  try {
    const calls = await tw.calls.list({ limit: 20 });
    res.json(calls.map((c) => ({
      sid: c.sid, to: c.to, from: c.from, direction: c.direction,
      status: c.status, duration: c.duration, startTime: c.startTime, price: c.price,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Billing / usage across the stack ----
// Twilio numbers are LIVE (balance + this-month spend). OpenAI & Sarvam expose no
// public balance API, so their spend is ESTIMATED from this month's call minutes
// using rates you can override via env. Hosting rows are plan facts. Everything
// estimated is clearly flagged so you never mistake a guess for a real balance.
const BILL = {
  openaiCreditUsd: process.env.OPENAI_CREDIT_USD ? +process.env.OPENAI_CREDIT_USD : 5,
  sarvamCreditUsd: process.env.SARVAM_CREDIT_USD ? +process.env.SARVAM_CREDIT_USD : null,
  openaiInPer1k: +(process.env.RATE_OPENAI_IN || 0.0004),   // gpt-4.1-mini $0.40 / 1M in
  openaiOutPer1k: +(process.env.RATE_OPENAI_OUT || 0.0016), // gpt-4.1-mini $1.60 / 1M out
  tokensPerMin: +(process.env.RATE_TOKENS_PER_MIN || 1800), // ~tokens of chat per call minute
  sarvamPerMin: +(process.env.RATE_SARVAM_PER_MIN || 0.018),// est. STT+TTS $/min
  renderUsd: +(process.env.RENDER_PLAN_USD || 7),           // starter plan, always-on
};
// Providers bill in USD; the dashboard shows ₹. Override the FX rate via env.
const USD_INR = +(process.env.USD_INR || 83.5);

function startOfMonth() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); }

app.get("/api/billing", async (_req, res) => {
  const out = { currency: "USD", generatedAt: new Date().toISOString(), tools: [] };

  // --- Twilio (LIVE) ---
  let twBalance = null, twUsed = null, twErr = null;
  try {
    const bal = await tw.balance.fetch();
    twBalance = +bal.balance;
    out.currency = bal.currency || "USD";
  } catch (e) { twErr = e.message; }
  try {
    const recs = await tw.usage.records.thisMonth.list({ limit: 80 });
    const tot = recs.find((r) => r.category === "totalprice");
    twUsed = tot ? +tot.price : recs.reduce((s, r) => s + (+r.price || 0), 0);
  } catch (e) { if (!twErr) twErr = e.message; }

  // --- This month's call minutes (drives OpenAI + Sarvam estimates) ---
  let minutes = 0, callCount = 0;
  try {
    const since = startOfMonth();
    const calls = await tw.calls.list({ startTimeAfter: since, limit: 200 });
    for (const c of calls) { minutes += (+c.duration || 0) / 60; callCount++; }
  } catch { /* estimate stays 0 */ }
  minutes = Math.round(minutes * 10) / 10;

  const openaiPerMin = (BILL.tokensPerMin / 1000) * (0.6 * BILL.openaiInPer1k + 0.4 * BILL.openaiOutPer1k);
  const openaiUsed = +(minutes * openaiPerMin).toFixed(3);
  const sarvamUsed = +(minutes * BILL.sarvamPerMin).toFixed(3);

  out.summary = { callsThisMonth: callCount, minutesThisMonth: minutes };

  out.tools.push({
    key: "twilio", name: "Twilio", role: "telephony", live: !twErr,
    status: twErr ? "error" : "live", error: twErr,
    balanceUsd: twBalance, usedThisMonthUsd: twUsed,
    note: twErr ? null : "prepaid balance",
    link: "https://console.twilio.com/us1/billing/manage-billing/billing-overview",
    tips: ["tipTwilio1", "tipTwilio2"],
  });
  out.tools.push({
    key: "openai", name: "OpenAI", role: "brain (gpt-4.1-mini)", live: false,
    status: "estimate", balanceUsd: BILL.openaiCreditUsd,
    usedThisMonthUsd: openaiUsed,
    remainingUsd: BILL.openaiCreditUsd != null ? +(BILL.openaiCreditUsd - openaiUsed).toFixed(2) : null,
    note: "est. from " + minutes + " min this month",
    link: "https://platform.openai.com/usage",
    tips: ["tipOpenai1", "tipOpenai2", "tipOpenai3"],
  });
  out.tools.push({
    key: "sarvam", name: "Sarvam AI", role: "speech (STT + TTS)", live: false,
    status: "estimate", balanceUsd: BILL.sarvamCreditUsd,
    usedThisMonthUsd: sarvamUsed,
    remainingUsd: BILL.sarvamCreditUsd != null ? +(BILL.sarvamCreditUsd - sarvamUsed).toFixed(2) : null,
    note: "est. from " + minutes + " min this month",
    link: "https://dashboard.sarvam.ai",
    tips: ["tipSarvam1", "tipSarvam2"],
  });
  out.tools.push({
    key: "hosting", name: PUBLIC_BASE_URL.includes("ngrok") ? "ngrok (tunnel)" : "Render", role: "always-on host", live: false,
    status: "plan", monthlyUsd: PUBLIC_BASE_URL.includes("ngrok") ? 0 : BILL.renderUsd,
    note: PUBLIC_BASE_URL.includes("ngrok") ? "free tunnel — laptop must stay on" : "starter plan, always-on",
    link: "https://render.com/pricing",
    tips: ["tipHost1", "tipHost2"],
  });

  out.totalEstThisMonthUsd = +((twUsed || 0) + openaiUsed + sarvamUsed).toFixed(2);

  // Convert every monetary field from USD -> INR; the dashboard renders ₹.
  const toInr = (v) => (v == null ? null : Math.round(v * USD_INR * 100) / 100);
  for (const tl of out.tools) {
    for (const k of ["balanceUsd", "usedThisMonthUsd", "remainingUsd", "monthlyUsd"]) {
      if (tl[k] != null) tl[k] = toInr(tl[k]);
    }
  }
  out.totalEstThisMonthUsd = toInr(out.totalEstThisMonthUsd);
  out.currency = "INR";
  out.usdInr = USD_INR;
  res.json(out);
});

// Inbound: Twilio hits this when someone calls a business number.
// Pick the channel via ?channel=tailor (else the default).
app.post("/voice/inbound", (req, res) => {
  res.type("text/xml").send(streamTwiml("inbound", req.query.channel));
});

// Outbound: TwiML served to a call we placed via the API.
app.post("/voice/outbound", (req, res) => {
  res.type("text/xml").send(streamTwiml("outbound", req.query.channel));
});

// Trigger an outbound call: POST { to: "+91XXXXXXXXXX", channel?: "clinic"|"tailor" }
app.post("/call", async (req, res) => {
  const to = req.body.to;
  if (!to) return res.status(400).json({ error: "missing 'to'" });
  const channel = channels[req.body.channel] ? req.body.channel : DEFAULT_CHANNEL;
  try {
    const call = await tw.calls.create({
      to,
      from: process.env.TWILIO_PHONE_NUMBER,
      url: `${PUBLIC_BASE_URL}/voice/outbound?channel=${encodeURIComponent(channel)}`,
    });
    logEvent("dial", call.sid, { direction: "outbound", to, status: call.status, channel });
    res.json({ sid: call.sid, status: call.status, channel });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/stream" });

wss.on("connection", (ws) => {
  const session = {
    streamSid: null,
    callSid: null,
    direction: "inbound",
    channel: DEFAULT_CHANNEL,
    convo: null, // created on `start`, once we know the channel
    turn: new TurnDetector(),
    processing: false,
    speaking: false,
    playback: null, // { cancel: bool }
    booked: false,
  };

  const sendClear = () => {
    if (session.streamSid) ws.send(JSON.stringify({ event: "clear", streamSid: session.streamSid }));
  };

  // Stream a mu-law buffer back to Twilio in 20ms frames; cancellable for barge-in.
  async function play(muLaw) {
    const token = { cancel: false };
    session.playback = token;
    session.speaking = true;
    const FRAME = 160; // 20ms @ 8kHz mu-law
    for (let i = 0; i < muLaw.length; i += FRAME) {
      if (token.cancel) break;
      const frame = muLaw.subarray(i, i + FRAME);
      ws.send(JSON.stringify({
        event: "media",
        streamSid: session.streamSid,
        media: { payload: frame.toString("base64") },
      }));
      await new Promise((r) => setTimeout(r, 18)); // ~realtime pacing
    }
    session.speaking = false;
    session.playback = null;
  }

  async function say(text, lang = "te-IN") {
    if (!text) return;
    try {
      const audio = await synthesize(text, lang);
      await play(audio);
    } catch (e) {
      console.error("TTS error:", e.message);
    }
  }

  async function handleTurn(utterance) {
    session.processing = true;
    try {
      const { text, languageCode } = await transcribe(utterance);
      if (!text) { session.processing = false; return; }
      console.log(`[${session.callSid}] caller: ${text}`);
      logEvent("caller", session.callSid, { text });
      const ac = activeCalls.get(session.callSid);
      if (ac) { ac.lastText = text; ac.turns = (ac.turns || 0) + 1; }
      const { reply, action } = await session.convo.respond(text);
      console.log(`[${session.callSid}] agent: ${reply} | action=${action.type}`);
      logEvent("agent", session.callSid, { text: reply, action: action.type });

      await say(reply, languageCode || "te-IN");
      await applyAction(action);
    } catch (e) {
      console.error("turn error:", e.message);
      await say("క్షమించండి, మళ్ళీ చెప్పగలరా?", "te-IN"); // "Sorry, could you say that again?"
    } finally {
      session.processing = false;
    }
  }

  async function applyAction(action) {
    if (action.type === "book") {
      session.booked = true;
      saveLead({ callSid: session.callSid, direction: session.direction, type: "booking",
        patientName: action.patientName, phone: action.phone, reason: action.reason, slot: action.slot });
      logEvent("booking", session.callSid, { patientName: action.patientName, phone: action.phone, slot: action.slot });
    } else if (action.type === "pickup") {
      session.booked = true; // a captured pickup counts as a finalized outcome
      saveLead({ callSid: session.callSid, direction: session.direction, type: "pickup",
        patientName: action.patientName, phone: action.phone, reason: action.reason, slot: action.slot });
      logEvent("pickup", session.callSid, { patientName: action.patientName, phone: action.phone, slot: action.slot });
    } else if (action.type === "review") {
      saveLead({ callSid: session.callSid, direction: session.direction, type: "review",
        patientName: action.patientName, phone: action.phone, reason: "agreed to leave a Google review", slot: "" });
      logEvent("review", session.callSid, { patientName: action.patientName, phone: action.phone });
    } else if (action.type === "enroll") {
      // Business coaching workshop enrollment — save and log immediately.
      saveLead({ callSid: session.callSid, direction: session.direction, type: "enroll",
        patientName: action.patientName, phone: action.phone, reason: action.reason, slot: action.slot || "Workshop" });
      logEvent("enroll", session.callSid, { patientName: action.patientName, phone: action.phone, slot: action.slot });
    } else if (action.type === "lead") {
      saveLead({ callSid: session.callSid, direction: session.direction, type: "lead",
        patientName: action.patientName, phone: action.phone, reason: action.reason, slot: "" });
      logEvent("lead", session.callSid, { patientName: action.patientName, phone: action.phone });
    } else if (action.type === "transfer") {
      const dest = process.env.CLINIC_ESCALATION_NUMBER;
      if (dest && session.callSid) {
        try {
          await tw.calls(session.callSid).update({
            twiml: `<Response><Say language="te-IN">దయచేసి వేచి ఉండండి, సిబ్బందికి కలుపుతున్నాను.</Say><Dial>${dest}</Dial></Response>`,
          });
        } catch (e) { console.error("transfer failed:", e.message); }
      }
    } else if (action.type === "hangup") {
      if (session.callSid) {
        try { await tw.calls(session.callSid).update({ status: "completed" }); } catch {}
      }
    }
  }

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      session.streamSid = msg.start.streamSid;
      session.callSid = msg.start.callSid;
      session.direction = msg.start.customParameters?.direction || "inbound";
      session.channel = msg.start.customParameters?.channel || DEFAULT_CHANNEL;
      const ch = getChannel(session.channel);
      session.convo = new Conversation(session.channel);
      console.log(`call start ${session.callSid} (${session.direction}, ${ch.id})`);
      activeCalls.set(session.callSid, { callSid: session.callSid, direction: session.direction, channel: ch.id, startedAt: new Date().toISOString(), turns: 0, lastText: "" });
      logEvent("start", session.callSid, { direction: session.direction, channel: ch.id });
      // Greet first (Telugu). For outbound you may want a different opener.
      await say(ch.greetingTe, "te-IN");
      return;
    }

    if (msg.event === "media") {
      if (!session.convo) return; // not started yet
      const muFrame = Buffer.from(msg.media.payload, "base64");

      // Barge-in: caller talks while agent is speaking -> stop playback.
      if (session.speaking) {
        const rms = frameRms(muLawBufferToPcm16(muFrame));
        if (rms > 1200) {
          if (session.playback) session.playback.cancel = true;
          sendClear();
        }
        return; // don't run turn detection over our own playback period
      }

      if (session.processing) return; // ignore audio while we're thinking
      const { utterance } = session.turn.push(muFrame);
      if (utterance) await handleTurn(utterance);
      return;
    }

    if (msg.event === "stop") {
      console.log(`call stop ${session.callSid}`);
      // If we captured details but never finalized a booking, log them as a lead.
      const l = session.convo.lead;
      if (!session.booked && (l.phone || l.patientName)) {
        saveLead({ callSid: session.callSid, direction: session.direction, type: "lead",
          patientName: l.patientName, phone: l.phone, reason: l.reason, slot: "" });
        logEvent("lead", session.callSid, { patientName: l.patientName, phone: l.phone });
      }
      logEvent("stop", session.callSid, {});
      activeCalls.delete(session.callSid);
    }
  });

  ws.on("close", () => {
    console.log(`ws closed ${session.callSid || ""}`);
    if (session.callSid) activeCalls.delete(session.callSid);
  });
});

server.listen(PORT, () => {
  console.log(`clinic-voice-agent listening on :${PORT}`);
  if (!PUBLIC_BASE_URL) console.warn("WARN: PUBLIC_BASE_URL not set — Twilio cannot reach the stream.");
});
