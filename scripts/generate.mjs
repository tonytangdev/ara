// PROTOTYPE - throwaway. Same model + same instruction, three input shapes.
import { readFileSync, writeFileSync } from "node:fs"

const KEY = readFileSync("/tmp/ara-proto/.env", "utf8").trim().split("=").slice(1).join("=").trim()
const MODEL = "moonshotai/kimi-k3"
const data = JSON.parse(readFileSync("/tmp/ara-proto/data/activity.json", "utf8"))

const LOCK = (f) => f.lock
const C_BUDGET = 55000 // chars of patch per day

// ---- Arm A: raw-ish payload, everything GitHub gave us, unnormalized
const armA = (t) => {
  const commits = t.commits.map((c) =>
    `commit ${c.sha}\n${c.message}\nfiles: ${c.files.map((f) => f.path).join(", ")}`).join("\n\n")
  const prs = t.prs.map((p) => `PR #${p.number} [${p.kind}] ${p.title}\n${p.body}`).join("\n\n")
  return `Repository: ${t.repo}\nDate: ${t.day}\n\n=== COMMITS ===\n${commits}\n\n=== PULL REQUESTS ===\n${prs || "(none)"}`
}

// ---- Arm B: the proposed Digest. Subject only, paths + line counts, locks stripped.
const digest = (t) => {
  const files = new Map()
  let add = 0, del = 0
  for (const c of t.commits) for (const f of c.files) {
    if (LOCK(f)) continue
    add += f.additions; del += f.deletions
    const e = files.get(f.path) ?? { additions: 0, deletions: 0 }
    files.set(f.path, { additions: e.additions + f.additions, deletions: e.deletions + f.deletions })
  }
  const areas = new Map()
  for (const [p, s] of files) {
    const dir = p.split("/").slice(0, 2).join("/") || "."
    areas.set(dir, (areas.get(dir) ?? 0) + s.additions + s.deletions)
  }
  return {
    repo: t.repo, day: t.day,
    commitCount: t.commits.length,
    commits: t.commits.map((c) => ({ subject: c.subject, files: c.files.filter((f) => !LOCK(f)).map((f) => f.path) })),
    pullRequests: t.prs.map((p) => ({ number: p.number, title: p.title, kind: p.kind })),
    totals: { filesTouched: files.size, additions: add, deletions: del },
    topAreas: [...areas.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([dir, churn]) => ({ dir, churn })),
    topFiles: [...files.entries()].sort((a, b) => (b[1].additions + b[1].deletions) - (a[1].additions + a[1].deletions))
      .slice(0, 12).map(([path, s]) => ({ path, ...s }))
  }
}
const armB = (t) => `Repository activity digest:\n\n${JSON.stringify(digest(t), null, 2)}`

// ---- Arm C: digest + diff hunks, budgeted
const armC = (t) => {
  let used = 0
  const hunks = []
  for (const c of t.commits) for (const f of c.files) {
    if (LOCK(f) || !f.patch) continue
    if (used + f.patch.length > C_BUDGET) { hunks.push("... (diffs truncated)"); used = Infinity; break }
    used += f.patch.length
    hunks.push(`--- ${f.path} (${c.sha}: ${c.subject})\n${f.patch}`)
  }
  return `${armB(t)}\n\n=== DIFFS ===\n${hunks.join("\n\n")}`
}

const INSTRUCTION = `You write short "build in public" posts for a solo developer.

Write ONE post about the day's work described below, in the developer's first-person voice.

Rules:
- 150-250 words, markdown, no title heading.
- Concrete and specific about what actually changed and why it matters.
- Never invent facts, features, metrics or motivations that are not supported by the input.
- No hashtags, no emoji spam, no "excited to announce", no LinkedIn cliches.
- Sound like a developer talking to other developers, not a marketing team.

Output only the post.`

const call = async (input) => {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(480000),
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL, temperature: 0.7,
      messages: [{ role: "system", content: INSTRUCTION }, { role: "user", content: input }]
    })
  })
  const j = await r.json()
  if (!j.choices) throw new Error(JSON.stringify(j).slice(0, 400))
  return { text: j.choices[0].message.content.trim(), usage: j.usage }
}

import { appendFileSync, existsSync } from "node:fs"
const OUT = "/tmp/ara-proto/data/drafts.jsonl"
const done = new Set(
  existsSync(OUT) ? readFileSync(OUT, "utf8").trim().split("\n").filter(Boolean)
    .map((l) => { const r = JSON.parse(l); return r.error ? null : `${r.repo}|${r.day}|${r.arm}` }).filter(Boolean) : []
)

const tasks = []
for (const t of data)
  for (const [arm, build] of [["A", armA], ["B", armB], ["C", armC]])
    if (!done.has(`${t.repo}|${t.day}|${arm}`)) tasks.push({ t, arm, build })

console.log(`${tasks.length} calls to make (${done.size} already done)`)

let i = 0
const worker = async () => {
  while (i < tasks.length) {
    const { t, arm, build } = tasks[i++]
    const input = build(t)
    const label = `${t.repo.split("/")[1]} ${t.day} arm ${arm}`
    try {
      const { text, usage } = await call(input)
      appendFileSync(OUT, JSON.stringify({ repo: t.repo, day: t.day, arm, inputChars: input.length, usage, text }) + "\n")
      console.log(`ok   ${label} ${usage?.prompt_tokens ?? "?"}->${usage?.completion_tokens ?? "?"} tok`)
    } catch (e) {
      appendFileSync(OUT, JSON.stringify({ repo: t.repo, day: t.day, arm, inputChars: input.length, error: String(e.message).slice(0, 300) }) + "\n")
      console.log(`FAIL ${label} ${String(e.message).slice(0, 200)}`)
    }
  }
}
await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()])

const all = readFileSync(OUT, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
writeFileSync("/tmp/ara-proto/data/drafts.json", JSON.stringify(all, null, 2))
const cost = all.reduce((n, r) => n + ((r.usage?.prompt_tokens ?? 0) * 2.6 + (r.usage?.completion_tokens ?? 0) * 13) / 1e6, 0)
console.log(`\nDONE ${all.filter((r) => !r.error).length}/${all.length} ok — approx $${cost.toFixed(3)}`)
