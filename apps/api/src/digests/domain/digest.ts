import { Schema } from "effect"
import type { RepoConnectionId } from "../../connections/domain/repo-connection.ts"
import { Repository } from "../../connections/domain/repository.ts"
import type { UserId } from "../../connections/domain/user.ts"
import { CalendarDay, type DayWindow } from "../../runs/domain/day-window.ts"
import type { RunId } from "../../runs/domain/run.ts"
import { PullRequestKind } from "./activity.ts"

/** One commit as a Digest records it: what it said, and what it touched. */
export class CommitSummary extends Schema.Class<CommitSummary>("CommitSummary")({
  /** The subject line alone. A commit body is prose, and prose is the Draft's job. */
  subject: Schema.String,
  files: Schema.Array(Schema.String)
}) {}

/** One pull request as a Digest records it. */
export class PullRequestSummary extends Schema.Class<PullRequestSummary>("PullRequestSummary")({
  number: Schema.Int,
  title: Schema.String,
  kind: PullRequestKind
}) {}

/** The day's size in three numbers. `filesTouched` counts distinct paths, not per-commit touches. */
export class DigestTotals extends Schema.Class<DigestTotals>("DigestTotals")({
  filesTouched: Schema.Int,
  additions: Schema.Int,
  deletions: Schema.Int
}) {}

/** A directory and how much moved inside it. Churn is additions plus deletions. */
export class AreaChurn extends Schema.Class<AreaChurn>("AreaChurn")({
  dir: Schema.String,
  churn: Schema.Int
}) {}

/** One file and how much of it moved, summed across every commit that touched it. */
export class FileChurn extends Schema.Class<FileChurn>("FileChurn")({
  path: Schema.String,
  additions: Schema.Int,
  deletions: Schema.Int
}) {}

/**
 * The factual, prose-free record of what happened in a repository during one
 * Day Window.
 *
 * This shape is the load-bearing decision of the feature and was settled by
 * prototype rather than argued: over eight real repository-days, blind-judged,
 * this input produced the better post on seven of seven days, beating both the
 * raw Forge payload and this same Digest with diff hunks attached (ADR-0004).
 * Change it with evidence, not with taste.
 *
 * What is *not* here is as decided as what is: no diff hunks, no full commit
 * messages, no pull request bodies, no bot Activity, no merge commits and no
 * lockfile churn. Filtering happens as the Digest is built, so a stored Digest
 * needs no filtering to be read safely.
 *
 * `isQuiet` is the one judgement in an otherwise factual record, and it is made
 * here — deterministically, before any model is involved — because the shape of
 * the Draft follows from it.
 */
export class Digest extends Schema.Class<Digest>("Digest")({
  repo: Repository,
  day: CalendarDay,
  commitCount: Schema.Int,
  commits: Schema.Array(CommitSummary),
  pullRequests: Schema.Array(PullRequestSummary),
  totals: DigestTotals,
  topAreas: Schema.Array(AreaChurn),
  topFiles: Schema.Array(FileChurn),
  isQuiet: Schema.Boolean
}) {
  /** A Day Window with nothing in it at all. A normal day, and not a failure. */
  get isEmpty(): boolean {
    return this.commitCount === 0 && this.pullRequests.length === 0
  }
}

/**
 * A Digest as it was persisted for one Run: the record, plus who it belongs to
 * and what produced it.
 *
 * The Digest is stored at the boundary between the two stages of a Run
 * (ADR-0002), which is what lets a Draft be regenerated for one model call and
 * no Forge calls, and what makes re-processing an interrupted Run affordable.
 */
export class StoredDigest extends Schema.Class<StoredDigest>("StoredDigest")({
  id: Schema.UUID,
  runId: Schema.UUID,
  digest: Digest,
  collectedAt: Schema.DateTimeUtc
}) {}

/**
 * Everything the collect stage needs to know, without needing a Run.
 *
 * Deliberately not the `Run` itself: the digests module answers "what happened
 * in this repository, that day, for this User", and owes the runs module
 * nothing beyond that.
 */
export interface DigestRequest {
  readonly runId: RunId
  readonly userId: UserId
  /** The entitlement that authorizes reading the repository; null once it has been removed. */
  readonly repoConnectionId: RepoConnectionId | null
  readonly repository: Repository
  readonly dayWindow: DayWindow
}

/**
 * There is no Digest for this Run *for this User*. One failure for three
 * situations — no such Run, somebody else's Run, or a Run that has not
 * collected anything yet — so asking cannot confirm another User's Run exists.
 */
export class DigestNotFound extends Schema.TaggedError<DigestNotFound>()("DigestNotFound", {}) {}
