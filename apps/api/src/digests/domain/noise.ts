import type { CommitActivity, PullRequestActivity } from "./activity.ts"

/**
 * What a Digest leaves out, and why.
 *
 * All three rules are applied while the Digest is built, not when it is read
 * (ADR-0004). A stored Digest is therefore already the honest account of a day:
 * nothing downstream — the model, the API, a later feature — has to remember to
 * filter, and nothing can forget to.
 */

/**
 * Accounts that commit as bots without GitHub calling them one. The `[bot]`
 * suffix catches App accounts; this list catches the rest, and is meant to be
 * extended as new ones turn up rather than replaced by cleverness.
 */
const BOT_LOGINS: ReadonlySet<string> = new Set([
  "dependabot",
  "dependabot-preview",
  "renovate",
  "renovate-bot",
  "github-actions",
  "greenkeeper",
  "imgbot",
  "snyk-bot",
  "mergify",
  "codecov",
  "semantic-release-bot",
  "allcontributors"
])

/**
 * Whether the Forge's account is a bot. The Forge's own classification is
 * believed when it is given, and a login is still checked when it is not:
 * plenty of automation commits as an ordinary account called `x[bot]`.
 */
export const isBotAuthor = (author: {
  readonly authorLogin: string | null
  readonly authorIsBot: boolean
}): boolean => {
  if (author.authorIsBot) return true
  if (author.authorLogin === null) return false

  const login = author.authorLogin.trim().toLowerCase()
  return login.endsWith("[bot]") || BOT_LOGINS.has(login)
}

/** A commit with more than one parent is branch mechanics, not a day's work. */
export const isMergeCommit = (commit: CommitActivity): boolean => commit.parentCount > 1

/**
 * Lockfiles, by name. A dependency bump rewrites thousands of lines nobody
 * wrote, and left in it dominates every total, every area and every top file —
 * which is exactly the material a Draft would then be written about.
 */
const LOCKFILES: ReadonlySet<string> = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "poetry.lock",
  "pipfile.lock",
  "uv.lock",
  "composer.lock",
  "gemfile.lock",
  "go.sum",
  "mix.lock",
  "pubspec.lock",
  "flake.lock",
  "podfile.lock",
  "packages.lock.json",
  "gradle.lockfile"
])

export const isLockfile = (path: string): boolean => {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase()
  return LOCKFILES.has(name)
}

/** Whether this commit belongs in a Digest at all, before its files are looked at. */
export const isWork = (commit: CommitActivity): boolean => !isMergeCommit(commit) && !isBotAuthor(commit)

/** Whether this pull request belongs in a Digest. Dependabot's pull requests are Dependabot's day. */
export const isHumanPullRequest = (pullRequest: PullRequestActivity): boolean => !isBotAuthor(pullRequest)
