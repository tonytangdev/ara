// PROTOTYPE - throwaway. Fetches real repo-day activity into arm inputs.
import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"

const TRIALS = [
  { repo: "tonytangdev/tonytangdev-v2", day: "2026-06-06" },
  { repo: "tonytangdev/tonytangdev-v2", day: "2026-06-07" },
  { repo: "tonytangdev/tonytangdev-v2", day: "2026-06-08" },
  { repo: "tonytangdev/tonytangdev-v2", day: "2026-06-09" },
  { repo: "tonytangdev/tonytangdev-v2", day: "2026-07-04" },
  { repo: "tonytangdev/easy-chores",    day: "2026-07-05" },
  { repo: "tonytangdev/easy-chores",    day: "2026-07-12" },
  { repo: "tonytangdev/rising-stars",   day: "2026-07-19" }
]
const AUTHOR = "tonytangdev"

const gh = (path) => JSON.parse(execFileSync("gh", ["api", path, "--paginate"], { maxBuffer: 1 << 28 }))

const BOT = /\[bot\]|dependabot|renovate/i
const LOCK = /(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb|Cargo\.lock|poetry\.lock)$/
const MERGE = /^Merge (pull request|branch|remote-tracking)/

const out = []
for (const { repo, day } of TRIALS) {
  const since = `${day}T00:00:00Z`, until = `${day}T23:59:59Z`
  const list = gh(`repos/${repo}/commits?author=${AUTHOR}&since=${since}&until=${until}&per_page=100`)
  const commits = []
  for (const c of list) {
    if (BOT.test(c.commit.author.name) || MERGE.test(c.commit.message)) continue
    const full = gh(`repos/${repo}/commits/${c.sha}`)
    commits.push({
      sha: c.sha.slice(0, 7),
      message: full.commit.message,
      subject: full.commit.message.split("\n")[0],
      files: (full.files ?? []).map((f) => ({
        path: f.filename, additions: f.additions, deletions: f.deletions,
        patch: f.patch ?? null, lock: LOCK.test(f.filename)
      }))
    })
  }
  // PRs the author opened or merged that day
  const q = (extra) => gh(`search/issues?q=${encodeURIComponent(`repo:${repo} is:pr author:${AUTHOR} ${extra}`)}&per_page=50`)
  const prs = new Map()
  for (const kind of [`created:${day}`, `merged:${day}`]) {
    try { for (const p of (q(kind).items ?? [])) prs.set(p.number, { number: p.number, title: p.title, body: p.body ?? "", state: p.state, kind }) }
    catch { /* search can 422 on empty */ }
  }
  out.push({ repo, day, commits, prs: [...prs.values()] })
  console.log(`${repo} ${day}: ${commits.length} commits, ${prs.size} PRs, ${commits.reduce((n,c)=>n+c.files.length,0)} files`)
}
writeFileSync("/tmp/ara-proto/data/activity.json", JSON.stringify(out, null, 2))
console.log("\nwrote data/activity.json")
