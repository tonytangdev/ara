// PROTOTYPE - throwaway. Inlines drafts.json into a single double-clickable HTML file.
import { readFileSync, writeFileSync } from "node:fs"
const drafts = JSON.parse(readFileSync("/tmp/ara-proto/data/drafts.json", "utf8")).filter((d) => !d.error)

const days = []
const key = (d) => `${d.repo}|${d.day}`
for (const d of drafts) {
  let g = days.find((x) => x.key === key(d))
  if (!g) { g = { key: key(d), repo: d.repo, day: d.day, arms: [] }; days.push(g) }
  g.arms.push({ arm: d.arm, text: d.text, inputChars: d.inputChars, tokens: d.usage?.prompt_tokens ?? null })
}
// deterministic shuffle so the order is stable across reloads but not arm-ordered
let seed = 1337
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
for (const g of days) g.arms.sort(() => rnd() - 0.5)

const html = `<!doctype html>
<meta charset="utf-8"><title>Ara prototype — is the Digest lossy?</title>
<style>
 body{font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:1200px;margin:0 auto;padding:24px;background:#0f1115;color:#e6e6e6}
 h1{font-size:19px;margin:0 0 4px} .sub{color:#8b93a7;font-size:13px;margin-bottom:20px}
 .bar{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:18px}
 .bar button{background:#1b1f2a;color:#aab;border:1px solid #2a3040;border-radius:6px;padding:6px 11px;cursor:pointer;font-size:13px}
 .bar button.on{background:#2d6cdf;color:#fff;border-color:#2d6cdf} .bar button.did{border-color:#3a7d4a;color:#8fd6a3}
 .ctx{background:#161a22;border:1px solid #232838;border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:13px;color:#9aa3b8}
 .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
 .card{background:#161a22;border:1px solid #232838;border-radius:10px;padding:16px;display:flex;flex-direction:column}
 .card h3{margin:0 0 10px;font-size:13px;color:#7b849b;letter-spacing:.06em;text-transform:uppercase}
 .card .body{white-space:pre-wrap;flex:1;font-size:14px}
 .card .pick{margin-top:14px;display:flex;gap:8px}
 .pick button{flex:1;background:#1b1f2a;border:1px solid #2a3040;color:#aab;border-radius:6px;padding:8px;cursor:pointer;font-size:12px}
 .pick .best.on{background:#2f8f4e;border-color:#2f8f4e;color:#fff}
 .pick .worst.on{background:#8f3030;border-color:#8f3030;color:#fff}
 .reveal{border-color:#3a4considerable}
 .tag{display:inline-block;padding:2px 8px;border-radius:5px;font-size:11px;font-weight:700;margin-left:8px}
 .A{background:#5b3fa8;color:#fff}.B{background:#1f6f8b;color:#fff}.C{background:#8b5a1f;color:#fff}
 .foot{margin-top:22px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
 .foot button{background:#2d6cdf;color:#fff;border:0;border-radius:6px;padding:9px 15px;cursor:pointer}
 pre{background:#11141b;border:1px solid #232838;border-radius:8px;padding:14px;overflow:auto;font-size:12px;color:#9aa3b8}
 table{border-collapse:collapse;margin-top:12px;font-size:13px}td,th{border:1px solid #2a3040;padding:6px 12px;text-align:left}
 .mediocre{margin-left:auto;color:#8b93a7;font-size:13px}
</style>
<h1>Is the Digest lossy? — blind comparison</h1>
<div class="sub">Same model (kimi-k3), same instruction, three input shapes. Pick the best post per day. Arms stay hidden until you reveal.</div>
<div class="bar" id="tabs"></div>
<div class="ctx" id="ctx"></div>
<div class="grid" id="grid"></div>
<div class="foot">
  <button id="revealBtn">Reveal arms &amp; tally</button>
  <label class="mediocre"><input type="checkbox" id="med"> all three are mediocre today</label>
</div>
<div id="out"></div>
<script>
const DAYS = ${JSON.stringify(days)};
const state = { day: 0, picks: {}, revealed: false };
const el = (id) => document.getElementById(id);

function render() {
  const g = DAYS[state.day];
  el("tabs").innerHTML = DAYS.map((d, i) =>
    \`<button class="\${i === state.day ? "on" : ""} \${state.picks[d.key]?.best != null ? "did" : ""}" onclick="go(\${i})">\${d.repo.split("/")[1]} · \${d.day}</button>\`).join("");
  el("ctx").textContent = \`\${g.repo} — \${g.day}. Which of these would you actually post?\`;
  const p = state.picks[g.key] ?? {};
  el("med").checked = !!p.mediocre;
  el("grid").innerHTML = g.arms.map((a, i) => \`
    <div class="card">
      <h3>Post \${i + 1}\${state.revealed ? \`<span class="tag \${a.arm}">arm \${a.arm}\${a.tokens ? " · " + a.tokens + " tok" : ""}</span>\` : ""}</h3>
      <div class="body">\${a.text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]))}</div>
      <div class="pick">
        <button class="best \${p.best === i ? "on" : ""}" onclick="pick(\${i},'best')">best</button>
        <button class="worst \${p.worst === i ? "on" : ""}" onclick="pick(\${i},'worst')">worst</button>
      </div>
    </div>\`).join("");
  if (state.revealed) tally();
}
window.go = (i) => { state.day = i; render(); };
window.pick = (i, which) => {
  const k = DAYS[state.day].key;
  const p = state.picks[k] ??= {};
  p[which] = p[which] === i ? null : i;
  render();
};
el("med").onchange = (e) => { (state.picks[DAYS[state.day].key] ??= {}).mediocre = e.target.checked; render(); };
el("revealBtn").onclick = () => { state.revealed = true; render(); };

function tally() {
  const score = { A: { best: 0, worst: 0 }, B: { best: 0, worst: 0 }, C: { best: 0, worst: 0 } };
  let med = 0, judged = 0;
  for (const g of DAYS) {
    const p = state.picks[g.key]; if (!p) continue;
    if (p.mediocre) med++;
    if (p.best != null) { score[g.arms[p.best].arm].best++; judged++; }
    if (p.worst != null) score[g.arms[p.worst].arm].worst++;
  }
  const rows = Object.entries(score).map(([a, s]) =>
    \`<tr><td>arm \${a} — \${({A:"raw payload",B:"Digest",C:"Digest + diffs"})[a]}</td><td>\${s.best}</td><td>\${s.worst}</td></tr>\`).join("");
  let verdict = "Judge more days for a verdict.";
  if (judged >= 5) {
    const { A, B, C } = score;
    if (med >= judged * 0.6) verdict = "ALL MEDIOCRE → the bottleneck is the prompt and voice, not the pipeline. Rethink drafting before building.";
    else if (C.best > A.best + B.best) verdict = "C DOMINATES → diff summarization belongs in v1, not behind a flag.";
    else if (B.best >= A.best) verdict = "B ≥ A → the Digest is not lossy. The split is free. Build as designed.";
    else verdict = "B < A → the Digest is missing signal (likely full commit bodies / PR bodies). Widen the Digest schema and retest.";
  }
  el("out").innerHTML = \`<table><tr><th>arm</th><th>best</th><th>worst</th></tr>\${rows}</table>
    <p><b>\${judged}</b> days judged, <b>\${med}</b> flagged all-mediocre.</p>
    <p style="font-size:15px;color:#8fd6a3"><b>\${verdict}</b></p>
    <pre>\${JSON.stringify(state.picks, null, 2)}</pre>\`;
}
render();
</script>`
writeFileSync("/tmp/ara-proto/judge.html", html)
console.log(`built judge.html — ${days.length} days, ${drafts.length} drafts`)
