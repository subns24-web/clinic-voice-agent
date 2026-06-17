// Lead + booking persistence. v1 = local CSV (data/leads.csv).
// Swap the body of saveLead() to push to Google Sheets / the clinic CRM later.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, "..", "data", "leads.csv");
const HEADER = "timestamp,callSid,direction,type,patientName,phone,reason,slot\n";

function ensureFile() {
  const dir = path.dirname(FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, HEADER);
}

function csvCell(v) {
  const s = (v ?? "").toString().replace(/"/g, '""');
  return /[",\n]/.test(s) ? `"${s}"` : s;
}

export function saveLead({ callSid, direction, type, patientName, phone, reason, slot }) {
  ensureFile();
  const row = [
    new Date().toISOString(),
    callSid, direction, type,
    patientName, phone, reason, slot,
  ].map(csvCell).join(",") + "\n";
  fs.appendFileSync(FILE, row);
}

// Parse a single CSV line into cells, honoring quoted fields ("" -> ").
function parseCsvLine(line) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

// Read all saved leads/bookings, newest first.
export function readLeads() {
  if (!fs.existsSync(FILE)) return [];
  const lines = fs.readFileSync(FILE, "utf8").split("\n").filter((l) => l.trim());
  if (lines.length <= 1) return [];
  const cols = parseCsvLine(lines[0]);
  return lines
    .slice(1)
    .map((l) => {
      const cells = parseCsvLine(l);
      const o = {};
      cols.forEach((c, i) => (o[c] = cells[i] ?? ""));
      return o;
    })
    .reverse();
}
