// Multi-channel knowledge base. Each "channel" is a business the agent can run.
// Sell the same engine to different owners by adding a channel here.
//
// Channel.type drives the playbook the brain uses:
//   "clinic" -> book/reschedule appointments, FAQs, leads, urgent transfer
//   "tailor" -> confirm stitching order, schedule garment pickup, FAQs, leads
// Both types close the call with a thank-you + a Google review ask + prep/action points.

export const channels = {
  // ---------------------------------------------------------------------------
  clinic: {
    id: "clinic",
    type: "clinic",
    name: "Charakk Dental Clinic",
    city: "Vijayawada, Andhra Pradesh",
    greetingTe: "నమస్కారం, చరక్ డెంటల్ క్లినిక్‌కి స్వాగతం. నేను మీకు ఎలా సహాయం చేయగలను?",
    greetingEn: "Namaskaram! Welcome to Charakk Dental Clinic. How can I help you today?",

    hours: "Monday to Saturday, 9:30 AM to 8:30 PM. Closed on Sundays.",
    address: "Beside Benz Circle, MG Road, Vijayawada 520010.",
    location: "Beside Benz Circle on MG Road. Landmark: opposite Apollo Pharmacy.",

    services: [
      { name: "Consultation", fee: "₹300" },
      { name: "Scaling / Cleaning", fee: "₹800 onwards" },
      { name: "Tooth Filling", fee: "₹1000 onwards" },
      { name: "Root Canal (RCT)", fee: "₹4000 onwards" },
      { name: "Tooth Extraction", fee: "₹1500 onwards" },
      { name: "Dental Implant", fee: "₹25000 onwards" },
      { name: "Braces / Aligners", fee: "₹30000 onwards" },
    ],

    doctors: [
      { name: "Dr. Sandeep", specialty: "Implantologist & Oral Surgeon" },
      { name: "Dr. Priya", specialty: "Orthodontist (braces/aligners)" },
    ],

    appointmentSlots: [
      "Today 5:00 PM", "Today 6:30 PM",
      "Tomorrow 10:00 AM", "Tomorrow 11:30 AM", "Tomorrow 4:00 PM",
    ],

    urgentKeywords: [
      "severe pain", "bleeding", "swelling", "accident", "broken tooth",
      "can't breathe", "face swelling", "emergency",
      "తీవ్రమైన నొప్పి", "రక్తం", "వాపు", "అత్యవసరం",
    ],

    // Spoken name patients should search for on Google to leave a review.
    googleReviewName: "Charakk Dental Clinic",
    // Things to remind the patient before their appointment (the brain may pick relevant ones).
    prepPoints: [
      "Please arrive 10 minutes early.",
      "Bring any previous dental reports or X-rays you have.",
      "If you take blood thinners or have diabetes, mention it at the desk.",
    ],
  },

  // ---------------------------------------------------------------------------
  tailor: {
    id: "tailor",
    type: "tailor",
    name: "Charakk Tailors",
    city: "Vijayawada, Andhra Pradesh",
    greetingTe: "నమస్కారం, చరక్ టైలర్స్‌కి స్వాగతం. నేను మీకు ఎలా సహాయం చేయగలను?",
    greetingEn: "Namaskaram! This is Charakk Tailors. How can I help you?",

    hours: "Monday to Saturday, 10:00 AM to 9:00 PM. Closed on Sundays.",
    address: "Near Governorpet Market, Eluru Road, Vijayawada 520002.",
    location: "Near Governorpet Market on Eluru Road. Landmark: above Sri Krishna Sweets.",

    // Stitching services + indicative charges (agent quotes as 'starting from').
    services: [
      { name: "Blouse stitching", fee: "₹350 onwards" },
      { name: "Saree falls & pico", fee: "₹120 onwards" },
      { name: "Salwar / Churidar set", fee: "₹500 onwards" },
      { name: "Lehenga stitching", fee: "₹1500 onwards" },
      { name: "Shirt stitching", fee: "₹400 onwards" },
      { name: "Trouser / Pant", fee: "₹450 onwards" },
      { name: "Alterations", fee: "₹100 onwards" },
    ],

    // Days/times the shop is open for garment pickup (agent offers from these).
    pickupSlots: [
      "Today before 9:00 PM",
      "Tomorrow 11:00 AM", "Tomorrow 6:00 PM",
      "Day after tomorrow, any time after 11:00 AM",
    ],

    // Typical turnaround so the agent can answer "when will it be ready".
    turnaround: "Regular stitching takes 4–5 days; express (extra ₹150) is ready in 2 days.",

    googleReviewName: "Charakk Tailors Vijayawada",
    prepPoints: [
      "Please bring your bill/token when you come to collect.",
      "Check the fitting at the shop before you leave so we can adjust on the spot.",
    ],
  },
};

export function getChannel(id) {
  return channels[id] || channels[process.env.CHANNEL || "clinic"] || channels.clinic;
}

// Backward-compatible default export used by older imports.
export const clinic = channels.clinic;
