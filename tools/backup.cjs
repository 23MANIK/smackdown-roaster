// Back up all Smackdown data (games, players, profiles, activity, feedback, history) to one JSON file.
// Usage: node tools/backup.cjs [outfile]   (reads with the public web key; needs Node 18+)
// Run it daily with a GitHub Action / cron, and keep the files. Restore = write the docs back from the JSON.
const fs = require("fs"), path = require("path");
const cfgSrc = fs.readFileSync(path.join(__dirname, "..", "config.js"), "utf8");
const cfg = {}; new Function("window", cfgSrc)({ set SMACKDOWN_FIREBASE(v) { Object.assign(cfg, v); } });
const base = `https://firestore.googleapis.com/v1/projects/${cfg.projectId}/databases/(default)/documents`;
async function list(p) {
  let out = [], tok = "";
  do {
    const r = await fetch(`${base}/${p}?pageSize=300&key=${cfg.apiKey}${tok ? "&pageToken=" + encodeURIComponent(tok) : ""}`);
    if (!r.ok) throw new Error(p + " -> " + r.status);
    const j = await r.json(); out = out.concat(j.documents || []); tok = j.nextPageToken || "";
  } while (tok);
  return out;
}
(async () => {
  const dump = { at: new Date().toISOString(), project: cfg.projectId, docs: {} };
  const keep = (docs) => docs.forEach((d) => { dump.docs[d.name.split("/documents/")[1]] = d.fields || {}; });
  const games = await list("games"); keep(games);
  for (const g of games) { const id = g.name.split("/").pop(); try { keep(await list(`games/${id}/players`)); } catch (e) { console.error("skip", id, e.message); } }
  try { keep(await list("history")); } catch (e) { console.error("history:", e.message); }
  const out = process.argv[2] || `smackdown-backup-${new Date().toISOString().slice(0, 10)}.json`;
  fs.writeFileSync(out, JSON.stringify(dump));
  console.log("Saved", Object.keys(dump.docs).length, "documents to", out);
})().catch((e) => { console.error(e); process.exit(1); });
