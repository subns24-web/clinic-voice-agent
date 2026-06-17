// Trigger an outbound call from the terminal:
//   node scripts/outbound.js +919963646301
import "dotenv/config";

const to = process.argv[2];
if (!to) {
  console.error("Usage: node scripts/outbound.js +91XXXXXXXXXX");
  process.exit(1);
}
const base = (process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, "");

const res = await fetch(`${base}/call`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ to }),
});
console.log(res.status, await res.text());
