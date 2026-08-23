import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform"
import { DateTime, Effect, Layer, Schema } from "effect"
import { GithubAppConfig } from "../../../config.ts"
import { Installation } from "../../../connections/domain/installation.ts"
import { InstallationTokens } from "../../../connections/domain/ports/installation-tokens.ts"
import type { Repository } from "../../../connections/domain/repository.ts"
import type { DayWindow } from "../../../runs/domain/day-window.ts"
import { CommitActivity, FileChange, PullRequestActivity, RepositoryActivity } from "../../domain/activity.ts"
import { ActivityUnavailable, RepoActivitySource } from "../../domain/ports/repo-activity-source.ts"

/** GitHub's maximum. Fewer pages for the same Activity. */
const PER_PAGE = 100

/**
 * Ceilings, so that one enormous day cannot become an unbounded walk of a
 * paginated API. A day past these is not a day a build-in-public post gets more
 * honest by describing in full.
 */
const MAX_PAGES = 5
const MAX_COMMITS = 200

/** How many commits are asked about at once. Polite rather than fast; a Run is not in a hurry. */
const DETAIL_CONCURRENCY = 5

/**
 * What Ara decodes out of GitHub's replies — and, just as deliberately, what it
 * does not.
 *
 * A commit detail carries a `patch` for every file: the actual diff. It is not
 * in this schema, so it is never decoded, never held and never stored
 * (ADR-0004). Excluding diffs is a validated decision, not an oversight; if the
 * temptation arises to add `patch` here, read the ADR first.
 */
const CommitListItem = Schema.Struct({
  sha: Schema.String,
  commit: Schema.Struct({
    message: Schema.String,
    author: Schema.NullOr(Schema.Struct({ name: Schema.optional(Schema.String) })),
    committer: Schema.NullOr(Schema.Struct({ date: Schema.DateTimeUtc }))
  }),
  /** Null when the commit's email is not linked to a GitHub account. */
  author: Schema.NullOr(Schema.Struct({ login: Schema.String, type: Schema.optional(Schema.String) })),
  parents: Schema.Array(Schema.Struct({ sha: Schema.String }))
})

const CommitDetail = Schema.Struct({
  files: Schema.optionalWith(
    Schema.Array(
      Schema.Struct({
        filename: Schema.String,
        additions: Schema.Int,
        deletions: Schema.Int
      })
    ),
    { default: (): ReadonlyArray<never> => [] }
  )
})

const PullRequestItem = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  created_at: Schema.DateTimeUtc,
  updated_at: Schema.DateTimeUtc,
  merged_at: Schema.NullOr(Schema.DateTimeUtc),
  user: Schema.NullOr(Schema.Struct({ login: Schema.String, type: Schema.optional(Schema.String) }))
})

const PullRequestList = Schema.Array(PullRequestItem)
const CommitList = Schema.Array(CommitListItem)

/** The subject line: everything a commit said before it started explaining itself. */
const subjectOf = (message: string): string => (message.split("\n")[0] ?? "").trim()

const within = (window: DayWindow, at: DateTime.Utc): boolean =>
  DateTime.greaterThanOrEqualTo(at, window.startsAt) && DateTime.lessThan(at, window.endsAt)

/**
 * Driven (outbound) adapter reading Activity from GitHub.
 *
 * The only Forge with an adapter, and nothing above the `RepoActivitySource`
 * port knows that (ADR-0003). It holds no credential of its own: the token is
 * minted through `InstallationTokens` from the App's private key, for the one
 * installation the repository is reachable through (ADR-0005).
 *
 * Two reads, and the arithmetic is ours: commits for the Day Window, then each
 * commit's file list. Areas and top files are aggregated from those file lists
 * when the Digest is built, never fetched as a third question — GitHub's own
 * statistics endpoints answer for the whole repository, not for a day.
 *
 * `since`/`until` are GitHub's filter on the committer date, which is inclusive
 * at both ends; the Day Window is half-open. Every commit is checked against
 * the window again here, so the boundary is Ara's definition rather than
 * GitHub's.
 */
export const GithubRepoActivitySourceLive = Layer.effect(
  RepoActivitySource,
  Effect.gen(function* () {
    const { apiBaseUrl } = yield* GithubAppConfig
    const client = yield* HttpClient.HttpClient
    const tokens = yield* InstallationTokens

    const activityFor = ({
      dayWindow,
      installationExternalId,
      repository
    }: {
      readonly repository: Repository
      readonly dayWindow: DayWindow
      readonly installationExternalId: string
    }) =>
      Effect.gen(function* () {
        const unreadable = (what: string) =>
          new ActivityUnavailable({
            reason:
              `GitHub would not say ${what} for ${repository.owner}/${repository.name}. ` +
              "The repository may have been removed, or Ara's access to it revoked."
          })

        // `tokenFor` keys on the installation's own id; the account login is
        // carried for logs, and the repository's owner is the truest thing
        // known about it from here.
        const { token } = yield* tokens
          .tokenFor(
            new Installation({
              forge: repository.forge,
              externalId: installationExternalId,
              accountLogin: repository.owner
            })
          )
          .pipe(Effect.mapError((failure) => new ActivityUnavailable({ reason: failure.reason })))

        const read = <A, I>(path: string, params: Record<string, string>, schema: Schema.Schema<A, I>, what: string) =>
          HttpClientRequest.get(new URL(path, apiBaseUrl)).pipe(
            HttpClientRequest.acceptJson,
            HttpClientRequest.bearerToken(token),
            HttpClientRequest.setUrlParams(params),
            client.execute,
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
            Effect.mapError(() => unreadable(what)),
            Effect.scoped
          )

        const repoPath = `/repos/${repository.owner}/${repository.name}`

        const listed: Array<typeof CommitListItem.Type> = []
        for (let page = 1; page <= MAX_PAGES && listed.length < MAX_COMMITS; page++) {
          const commits = yield* read(
            `${repoPath}/commits`,
            {
              since: DateTime.formatIso(dayWindow.startsAt),
              // Inclusive on GitHub's side; a second short of the window's
              // exclusive end is the closest it can be asked for.
              until: DateTime.formatIso(DateTime.subtract(dayWindow.endsAt, { seconds: 1 })),
              per_page: String(PER_PAGE),
              page: String(page)
            },
            CommitList,
            "what was committed"
          )

          listed.push(...commits)
          if (commits.length < PER_PAGE) break
        }

        const inWindow = listed
          .filter((item) => item.commit.committer !== null && within(dayWindow, item.commit.committer.date))
          .slice(0, MAX_COMMITS)

        const commits = yield* Effect.forEach(
          inWindow,
          (item) =>
            Effect.map(
              read(`${repoPath}/commits/${item.sha}`, {}, CommitDetail, `what commit ${item.sha} touched`),
              (detail) =>
                new CommitActivity({
                  sha: item.sha,
                  subject: subjectOf(item.commit.message),
                  // Filtered above: every item reaching here has a committer date.
                  committedAt: item.commit.committer?.date ?? dayWindow.startsAt,
                  authorLogin: item.author?.login ?? item.commit.author?.name ?? null,
                  authorIsBot: item.author?.type === "Bot",
                  parentCount: item.parents.length,
                  files: detail.files.map(
                    (file) =>
                      new FileChange({
                        path: file.filename,
                        additions: file.additions,
                        deletions: file.deletions
                      })
                  )
                })
            ),
          { concurrency: DETAIL_CONCURRENCY }
        )

        const pullRequests: Array<PullRequestActivity> = []
        for (let page = 1; page <= MAX_PAGES; page++) {
          const listedPulls = yield* read(
            `${repoPath}/pulls`,
            {
              state: "all",
              sort: "updated",
              direction: "desc",
              per_page: String(PER_PAGE),
              page: String(page)
            },
            PullRequestList,
            "which pull requests moved"
          )

          for (const pull of listedPulls) {
            // Merged beats opened: a pull request that was opened and merged
            // inside one Day Window is one thing that happened, and merging is
            // the more interesting half of it.
            const kind =
              pull.merged_at !== null && within(dayWindow, pull.merged_at)
                ? "merged"
                : within(dayWindow, pull.created_at)
                  ? "opened"
                  : null

            if (kind !== null) {
              pullRequests.push(
                new PullRequestActivity({
                  number: pull.number,
                  title: pull.title,
                  kind,
                  authorLogin: pull.user?.login ?? null,
                  authorIsBot: pull.user?.type === "Bot"
                })
              )
            }
          }

          // Sorted by last update, newest first: once a page ends before the
          // window opens, nothing further down it can have moved inside it.
          const oldest = listedPulls[listedPulls.length - 1]
          if (
            listedPulls.length < PER_PAGE ||
            (oldest !== undefined && DateTime.lessThan(oldest.updated_at, dayWindow.startsAt))
          ) {
            break
          }
        }

        return new RepositoryActivity({ repository, dayWindow, commits, pullRequests })
      })

    return RepoActivitySource.of({ activityFor })
  })
)
