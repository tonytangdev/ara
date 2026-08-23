// PROTOTYPE - throwaway. Does a "thin day" instruction beat inflating 2 commits?
import { readFileSync } from "node:fs"
const KEY = readFileSync("/tmp/ara-proto/.env", "utf8").trim().split("=").slice(1).join("=").trim()
const data = JSON.parse(readFileSync("/tmp/ara-proto/data/activity.json", "utf8"))
const drafts = JSON.parse(readFileSync("/tmp/ara-proto/data/drafts.json", "utf8"))
const t = data.find((x) => x.day === "2026-06-08")
const digestInput = drafts.find((d) => d.day === "2026-06-08" && d.arm === "B")

const QUIET = `You write short "build in public" posts for a solo developer.

Today was a LIGHT day: the developer only made a couple of small commits.

Write ONE post that is honest about that. Rules:
- 40-90 words. Short is the point. Do not pad.
- Say plainly what little was done. Do not dress it up as a milestone.
- Never invent facts, features, metrics or motivations.
- No hashtags, no emoji spam, no "excited to announce".
- A quiet day is fine and normal. Sound relaxed about it, not apologetic.

Output only the post.`

const commits = t.commits.map((c) => `- ${c.subject}\n  files: ${c.files.map((f) => f.path).join(", ")}`).join("\n")
const input = `Repository: ${t.repo}\nDate: ${t.day}\nCommits (${t.commits.length}):\n${commits}`

const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ model: "moonshotai/kimi-k3", temperature: 0.7,
    messages: [{ role: "system", content: QUIET }, { role: "user", content: input }] })
})
const j = await r.json()
console.log("=== INPUT ===\n" + input)
console.log("\n=== QUIET DRAFT (new instruction) ===\n" + (j.choices?.[0]?.message?.content?.trim() ?? "NULL CONTENT"))
console.log("\n=== what the standard instruction produced (arm B, judged mediocre) ===\n" + digestInput.text)
