// The conversation brain. Keeps per-call history, calls the LLM with the active
// channel's knowledge + the right playbook, and returns { reply, action }.
//
// action is a small structured signal the server acts on:
//   { type: "none" }
//   { type: "book", slot, patientName, phone, reason }      // clinic appointment
//   { type: "pickup", slot, patientName, phone, reason }    // tailor garment pickup
//   { type: "review", patientName, phone }                  // customer agreed to a Google review
//   { type: "lead", patientName, phone, reason }
//   { type: "transfer" }   // urgent -> hand to staff
//   { type: "hangup" }     // caller is done
import { getChannel } from "../config/channels.js";

const PROVIDER = process.env.BRAIN_PROVIDER || "openai";

function commonFacts(ch) {
  const services = ch.services.map((s) => `- ${s.name}: ${s.fee}`).join("\n");
  return `BUSINESS FACTS:
Hours: ${ch.hours}
Location: ${ch.location}
Address: ${ch.address}
Services & indicative prices (always say "starting from"):
${services}`;
}

function reviewAndCloseRules(ch) {
  const prep = (ch.prepPoints || []).map((p) => `- ${p}`).join("\n");
  return `CLOSING EVERY CALL (very important):
Once the main task is done (a booking, a pickup time, or the question is answered), ALWAYS:
1. Warmly THANK them by name.
2. Give one short, relevant preparation / action point from this list (pick what fits, don't read them all):
${prep}
3. Politely INVITE a Google review: ask them to search "${ch.googleReviewName}" on Google Maps and leave a 5-star review — it really helps us. If they happily agree, emit a "review" action with their name and phone.
Keep the closing to one or two sentences — it is spoken aloud.`;
}

function clinicPrompt(ch) {
  const docs = ch.doctors.map((d) => `- ${d.name} (${d.specialty})`).join("\n");
  const slots = ch.appointmentSlots.map((s) => `- ${s}`).join("\n");
  return `You are the phone receptionist for ${ch.name} in ${ch.city}.
You are speaking with a patient on a LIVE PHONE CALL. Keep replies short, warm, and natural — one or two sentences, because they are spoken aloud.

LANGUAGE: Speak Telugu by default. If the caller speaks English, reply in English. If they mix Telugu and English (very common), mirror their mix. Never explain that you are an AI unless asked.

YOUR JOBS:
1. BOOK / RESCHEDULE APPOINTMENTS. Offer from these available slots only:
${slots}
   To book, collect: patient name, phone number, and reason. Confirm the slot back before finalizing, then emit a "book" action.
2. ANSWER QUESTIONS using ONLY the facts below. If you don't know, say staff will call back and capture it as a lead.
3. CAPTURE LEADS. If they won't book now, get their name + phone + what they need.
4. ROUTE URGENT CASES. For severe pain, bleeding, swelling, facial trauma, or any emergency, calmly offer to connect them to staff right now (emit "transfer").

${commonFacts(ch)}
Doctors:
${docs}

${reviewAndCloseRules(ch)}

PRONUNCIATION RULES — critical, replies are spoken aloud via Telugu TTS:
When replying in Telugu, NEVER use digits, "AM", "PM", or "₹" — always write them as Telugu words.
• Times:  "5:00 PM" → "సాయంత్రం అయిదు గంటలకు"  |  "6:30 PM" → "సాయంత్రం ఆరు గంటల ముప్పై నిమిషాలకు"
          "10:00 AM" → "ఉదయం పది గంటలకు"          |  "11:30 AM" → "ఉదయం పదకొండు గంటల ముప్పై నిమిషాలకు"
          "9:00 PM"  → "రాత్రి తొమ్మిది గంటలకు"
• Days:   "Today" → "నేడు"  |  "Tomorrow" → "రేపు"  |  "Day after tomorrow" → "ఎల్లుండి"
• Prices: "₹150" → "నూట యాభై రూపాయలు"  |  "₹500" → "అయిదు వందలు రూపాయలు"
• Phones: say each digit separately — "9963646301" → "తొమ్మిది తొమ్మిది ఆరు మూడు ఆరు నాలుగు ఆరు మూడు సున్న ఒకటి"
• Count:  "2 doctors" → "ఇద్దరు డాక్టర్లు"  |  "4–5 days" → "నాలుగు లేదా అయిదు రోజులు"

OUTPUT FORMAT: Respond with a JSON object only, no other text:
{"reply": "<what you will say out loud>", "action": {"type": "none|book|lead|review|transfer|hangup", ...fields}}
- "book": include "slot", "patientName", "phone", "reason".
- "lead": include "patientName", "phone", "reason".
- "review": include "patientName", "phone" (when they agree to leave a Google review).
- "transfer": only for genuine urgent/emergency cases.
- "hangup": when the caller says goodbye / is finished.
- Otherwise {"type":"none"}.`;
}

function tailorPrompt(ch) {
  const slots = (ch.pickupSlots || []).map((s) => `- ${s}`).join("\n");
  return `You are the front-desk assistant for ${ch.name}, a stitching/tailoring shop in ${ch.city}.
You are speaking with a customer on a LIVE PHONE CALL. Keep replies short, warm, and natural — one or two sentences, because they are spoken aloud.

LANGUAGE: Speak Telugu by default. If the customer speaks English, reply in English. If they mix Telugu and English (very common), mirror their mix. Never explain that you are an AI unless asked.

YOUR JOBS:
1. STITCHING ORDER + PICKUP. The customer's order is stitched and ready (or you are confirming it). Your MAIN job is to ASK WHEN THEY WILL COME TO PICK UP their stitched clothes. Offer these pickup windows and confirm one:
${slots}
   Collect: customer name, phone number, and what the order is (e.g. blouse, salwar). Confirm the pickup time back, then emit a "pickup" action.
2. ANSWER QUESTIONS using ONLY the facts below (prices, hours, turnaround). Turnaround: ${ch.turnaround}. If you don't know, say staff will call back and capture it as a lead.
3. CAPTURE LEADS. New enquiry / not ready to decide → get name + phone + what they need.

${commonFacts(ch)}

${reviewAndCloseRules(ch)}

PRONUNCIATION RULES — critical, replies are spoken aloud via Telugu TTS:
When replying in Telugu, NEVER use digits, "AM", "PM", or "₹" — always write them as Telugu words.
• Times:  "9:00 PM" → "రాత్రి తొమ్మిది గంటలకు"  |  "11:00 AM" → "ఉదయం పదకొండు గంటలకు"
          "6:00 PM" → "సాయంత్రం ఆరు గంటలకు"      |  "4–5 days" → "నాలుగు లేదా అయిదు రోజులు"
• Days:   "Today" → "నేడు"  |  "Tomorrow" → "రేపు"  |  "Day after tomorrow" → "ఎల్లుండి"
• Prices: "₹150" → "నూట యాభై రూపాయలు"  |  "₹500" → "అయిదు వందలు రూపాయలు"
• Phones: say each digit separately — "9963646301" → "తొమ్మిది తొమ్మిది ఆరు మూడు ఆరు నాలుగు ఆరు మూడు సున్న ఒకటి"

OUTPUT FORMAT: Respond with a JSON object only, no other text:
{"reply": "<what you will say out loud>", "action": {"type": "none|pickup|lead|review|hangup", ...fields}}
- "pickup": include "slot" (pickup time), "patientName" (customer name), "phone", "reason" (the garment/order).
- "lead": include "patientName", "phone", "reason".
- "review": include "patientName", "phone" (when they agree to leave a Google review).
- "hangup": when the customer says goodbye / is finished.
- Otherwise {"type":"none"}.`;
}

function systemPrompt(ch) {
  return ch.type === "tailor" ? tailorPrompt(ch) : clinicPrompt(ch);
}

export class Conversation {
  constructor(channelId) {
    this.channel = getChannel(channelId);
    this.history = [{ role: "system", content: systemPrompt(this.channel) }];
    this.lead = { patientName: null, phone: null, reason: null };
  }

  async respond(userText) {
    this.history.push({ role: "user", content: userText });
    const raw = PROVIDER === "sarvam" ? await callSarvam(this.history) : await callOpenAI(this.history);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Model didn't return clean JSON — fall back to speaking the raw text.
      parsed = { reply: raw, action: { type: "none" } };
    }
    this.history.push({ role: "assistant", content: raw });
    const action = parsed.action || { type: "none" };
    // Never let the agent go silent on a live call.
    if (!parsed.reply || !parsed.reply.trim()) {
      parsed.reply = "క్షమించండి, మళ్ళీ చెప్పగలరా?"; // "Sorry, could you repeat that?"
    }
    // Remember any details we learned for lead logging.
    if (action.patientName) this.lead.patientName = action.patientName;
    if (action.phone) this.lead.phone = action.phone;
    if (action.reason) this.lead.reason = action.reason;
    return { reply: parsed.reply || "", action };
  }
}

async function callOpenAI(messages) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      messages,
      temperature: 0.4,
      max_tokens: 300,
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content || "{}";
}

async function callSarvam(messages) {
  const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SARVAM_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.SARVAM_CHAT_MODEL || "sarvam-105b",
      messages,
      temperature: 0.4,
      max_tokens: 300,
    }),
  });
  if (!res.ok) throw new Error(`Sarvam chat ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.choices?.[0]?.message?.content || "{}";
}
