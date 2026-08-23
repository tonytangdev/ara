import { DateTime, Effect } from "effect"
import { DigestConfig } from "../../config.ts"
import type { CommitActivity, FileChange, PullRequestActivity, RepositoryActivity } from "../domain/activity.ts"
import { AreaChurn, CommitSummary, Digest, DigestTotals, FileChurn, PullRequestSummary } from "../domain/digest.ts"
import { isHumanPullRequest, isLockfile, isWork } from "../domain/noise.ts"

/** How many areas and files a Digest names. Enough to say where the day went; not a listing. */
const TOP_AREAS = 5
const TOP_FILES = 10

/** What a file at the root of the repository counts as. */
const ROOT = "(root)"

const areaOf = (path: string): string => {
  const cut = path.lastIndexOf("/")
  return cut === -1 ? ROOT : path.slice(0, cut)
}

const churnOf = (file: { readonly additions: number; readonly deletions: number }) => file.additions + file.deletions

/**
 * Ties are broken by name so that the same Activity always produces the same
 * Digest. Two runs of the same day must not differ, or regenerating a Draft
 * stops being a comparison of prose.
 */
const byChurnThen =
  <A>(churn: (a: A) => number, name: (a: A) => string) =>
  (left: A, right: A) =>
    churn(right) - churn(left) || name(left).localeCompare(name(right))

/**
 * Driving (inbound) port: Activity in, Digest out.
 *
 * Pure. No network, no database, no model, no clock — the same Activity gives
 * the same Digest on any machine at any time. That is deliberate and it is
 * where the feature's real behaviour lives: bot Activity, merge commits and
 * lockfile churn are excluded *here*, while the Digest is being built, so a
 * stored Digest is already the honest account of a day and nothing downstream
 * has to filter it again (ADR-0004).
 *
 * Areas and top files are aggregated from the same file changes the commits
 * carry, never fetched separately: a Digest is one read of the Forge, and the
 * arithmetic is ours.
 */
export class BuildDigest extends Effect.Service<BuildDigest>()("application/digests/BuildDigest", {
  effect: Effect.gen(function* () {
    const { quietBelowCommits, quietBelowChangedLines } = yield* DigestConfig

    /** Lockfiles are dropped; a commit left with nothing to show is dropped with them. */
    const workOf = (commits: ReadonlyArray<CommitActivity>) =>
      commits
        .filter(isWork)
        .map((commit) => ({ commit, files: commit.files.filter((file) => !isLockfile(file.path)) }))
        .filter(({ files }) => files.length > 0)
        // Oldest first: a day reads forwards, whatever order the Forge listed it in.
        .sort(
          (left, right) =>
            DateTime.toEpochMillis(left.commit.committedAt) - DateTime.toEpochMillis(right.commit.committedAt)
        )

    /**
     * One entry per pull request, even when a Day Window saw it opened and then
     * merged. Merging is the more interesting of the two things that happened.
     */
    const pullRequestsOf = (pullRequests: ReadonlyArray<PullRequestActivity>) => {
      const kept = new Map<number, PullRequestActivity>()
      for (const pullRequest of pullRequests.filter(isHumanPullRequest)) {
        const seen = kept.get(pullRequest.number)
        if (seen === undefined || pullRequest.kind === "merged") kept.set(pullRequest.number, pullRequest)
      }
      return [...kept.values()]
        .sort((left, right) => left.number - right.number)
        .map(
          (pullRequest) =>
            new PullRequestSummary({ number: pullRequest.number, title: pullRequest.title, kind: pullRequest.kind })
        )
    }

    const filesOf = (changes: ReadonlyArray<FileChange>) => {
      const perPath = new Map<string, { additions: number; deletions: number }>()
      for (const change of changes) {
        const running = perPath.get(change.path) ?? { additions: 0, deletions: 0 }
        running.additions += change.additions
        running.deletions += change.deletions
        perPath.set(change.path, running)
      }
      return [...perPath].map(([path, churn]) => new FileChurn({ path, ...churn }))
    }

    const areasOf = (files: ReadonlyArray<FileChurn>) => {
      const perArea = new Map<string, number>()
      for (const file of files) {
        const dir = areaOf(file.path)
        perArea.set(dir, (perArea.get(dir) ?? 0) + churnOf(file))
      }
      return [...perArea]
        .map(([dir, churn]) => new AreaChurn({ dir, churn }))
        .sort(
          byChurnThen<AreaChurn>(
            (area) => area.churn,
            (area) => area.dir
          )
        )
        .slice(0, TOP_AREAS)
    }

    const execute = (activity: RepositoryActivity): Digest => {
      const work = workOf(activity.commits)
      const files = filesOf(work.flatMap(({ files }) => files))

      const totals = new DigestTotals({
        filesTouched: files.length,
        additions: files.reduce((sum, file) => sum + file.additions, 0),
        deletions: files.reduce((sum, file) => sum + file.deletions, 0)
      })

      const changedLines = totals.additions + totals.deletions

      return new Digest({
        repo: activity.repository,
        day: activity.dayWindow.day,
        commitCount: work.length,
        commits: work.map(
          ({ commit, files }) =>
            new CommitSummary({
              subject: commit.subject,
              // Ordered so that two runs of the same day list a commit's files
              // identically, whatever order the Forge happened to send them in.
              files: files.map((file) => file.path).sort()
            })
        ),
        pullRequests: pullRequestsOf(activity.pullRequests),
        totals,
        topAreas: areasOf(files),
        topFiles: [...files].sort(byChurnThen<FileChurn>(churnOf, (file) => file.path)).slice(0, TOP_FILES),
        // Decided here, before any model call, so that a light day is a fact
        // about the Digest rather than something a model is asked to notice.
        isQuiet: work.length < quietBelowCommits && changedLines < quietBelowChangedLines
      })
    }

    return { execute } as const
  })
}) {}
