import { readFileSync } from "node:fs"

/**
 * The repository's `.env`, loaded the way `node --env-file` would.
 *
 * The application gets its configuration from the process environment and the
 * contract tests need the same App credentials the running API uses. Anything
 * already exported wins, so a one-off `CONTRACT_GITHUB_DAY=... pnpm
 * test:contract` does what it looks like.
 */
const ENV_FILE = new URL("../../.env", import.meta.url)

try {
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (match === null) continue

    const [, name, raw] = match
    const value = (raw ?? "").trim().replace(/^["']|["']$/g, "")
    if (name !== undefined && process.env[name] === undefined) process.env[name] = value
  }
} catch {
  // No `.env` is fine: the tests skip themselves when what they need is absent.
}
