import { Schema } from "effect"
// Imported from where they are defined rather than from the owning module's
// `index.ts`: those files wire modules up, and wiring reaches back here. Types
// are shared between modules; layers are not.
import { Repository } from "../../connections/domain/repository.ts"
import { DayWindow } from "../../runs/domain/day-window.ts"

/**
 * One file a commit touched, and how much of it moved.
 *
 * Line counts and a path, and nothing else: no diff hunk is carried here, so
 * there is no shape of Activity that could put source code into a Digest
 * (ADR-0004). The Forge sends the patch whether we want it or not; it stops at
 * the adapter's schema and is never decoded, never stored and never passed on.
 */
export class FileChange extends Schema.Class<FileChange>("FileChange")({
  path: Schema.NonEmptyString,
  additions: Schema.Int,
  deletions: Schema.Int
}) {}

/**
 * A commit, as the Forge records it.
 *
 * Everything here is a fact reported by the Forge rather than a judgement about
 * it. Whether an author counts as a bot and whether a commit counts as work are
 * decided when the Digest is built, so both are testable without a network and
 * both can be corrected without re-reading a repository.
 *
 * `authorIsBot` is the Forge's own classification (GitHub's account `type`),
 * relayed rather than trusted on its own: plenty of bots commit as ordinary
 * accounts named `something[bot]`.
 */
export class CommitActivity extends Schema.Class<CommitActivity>("CommitActivity")({
  sha: Schema.NonEmptyString,
  /** The first line of the commit message. Full messages are deliberately not carried. */
  subject: Schema.String,
  /**
   * When the work was written, not when it landed.
   *
   * The author date rather than the committer date, because a rebase, a squash
   * or a cherry-pick rewrites the second and leaves the first alone: reading a
   * day from committer dates reports a week of branch work again on the day it
   * is merged (ADR-0006). This is the date a commit's Day Window is decided by.
   */
  authoredAt: Schema.DateTimeUtc,
  authorLogin: Schema.NullOr(Schema.String),
  authorIsBot: Schema.Boolean,
  /** More than one parent means a merge: branch mechanics rather than work. */
  parentCount: Schema.Int,
  files: Schema.Array(FileChange)
}) {}

/** What happened to a pull request inside the Day Window. */
export const PullRequestKind = Schema.Literal("opened", "merged")
export type PullRequestKind = typeof PullRequestKind.Type

/** A pull request, as the Forge records it. Title only; bodies are not carried. */
export class PullRequestActivity extends Schema.Class<PullRequestActivity>("PullRequestActivity")({
  number: Schema.Int,
  title: Schema.String,
  kind: PullRequestKind,
  authorLogin: Schema.NullOr(Schema.String),
  authorIsBot: Schema.Boolean
}) {}

/**
 * Everything the Forge recorded for one repository over one Day Window: the
 * raw material a Digest is built from.
 *
 * Empty is an ordinary answer. A day with no commits and no pull requests is a
 * day, and it produces a Digest saying so rather than a failure.
 */
export class RepositoryActivity extends Schema.Class<RepositoryActivity>("RepositoryActivity")({
  repository: Repository,
  dayWindow: DayWindow,
  commits: Schema.Array(CommitActivity),
  pullRequests: Schema.Array(PullRequestActivity)
}) {}
