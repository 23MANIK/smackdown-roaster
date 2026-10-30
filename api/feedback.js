/**
 * /api/feedback: emails each in-app feedback to the organiser through Resend,
 * the same way the scale-architect app does. Needs RESEND_API_KEY in the Vercel
 * project's environment. FEEDBACK_TO overrides the address. Keys never reach the browser.
 * Limits: 5 per visitor per hour (best effort, in memory), 1000 characters, bot trap field.
 */
const DEFAULT_TO = "nikssefish2@gmail.com";
const seen = new Map();

const clean = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, n);
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ ok: false, error: "POST only" }); return; }
  const key = process.env.RESEND_API_KEY;
  if (!key) { res.status(503).json({ ok: false, error: "Email not set up" }); return; }
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== "object") { res.status(400).json({ ok: false, error: "Empty feedback" }); return; }
  if (body.website) { res.status(200).json({ ok: true }); return; } // bots fill every field
  const text = clean(body.feedback, 1000), name = clean(body.name, 40) || "Anonymous";
  if (text.length < 2) { res.status(400).json({ ok: false, error: "Empty feedback" }); return; }
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "?";
  const now = Date.now(), hits = (seen.get(ip) || []).filter((t) => now - t < 3600e3);
  if (hits.length >= 5) { res.status(429).json({ ok: false, error: "Too many" }); return; }
  hits.push(now); seen.set(ip, hits);
  const group = clean(body.group, 30), screen = clean(body.screen, 20), app = clean(body.app, 10);
  const html = "<p><b>" + esc(name) + "</b> wrote:</p><p style=\"white-space:pre-wrap\">" + esc(text) + "</p><p style=\"color:#666;font-size:13px\">Group: " + esc(group || "main") + " · Screen: " + esc(screen || "home") + " · App " + esc(app) + "</p>";
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "Smackdown <onboarding@resend.dev>", to: [process.env.FEEDBACK_TO || DEFAULT_TO], subject: "Smackdown feedback from " + name, html, text: name + " wrote:\n\n" + text + "\n\nGroup: " + (group || "main") + " · Screen: " + (screen || "home") + " · App " + app })
    });
    if (!r.ok) { res.status(502).json({ ok: false, error: "Mail failed" }); return; }
    res.status(200).json({ ok: true });
  } catch (e) { res.status(502).json({ ok: false, error: "Mail failed" }); }
}
