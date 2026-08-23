import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, DateTime, Effect, Layer } from "effect"
import { Repository } from "../../connections/domain/repository.ts"
import { TimeZone } from "../../connections/domain/time-zone.ts"
import { CalendarDay, DayWindow } from "../../runs/domain/day-window.ts"
import { CommitActivity, FileChange, PullRequestActivity, RepositoryActivity } from "../domain/activity.ts"
import type { Digest } from "../domain/digest.ts"
import { BuildDigest } from "./build-digest.ts"

/**
 * What these tests drive: Activity in, Digest out, and nothing else.
 *
 * This is the most important test surface in the feature. Everything the
 * product promises about honesty — no bots, no merge commits, no lockfile
 * churn, no invented numbers — is a property of this one pure function, and
 * ADR-0004 makes the Digest's exact contents a decision validated by
 * experiment. These tests are what stop it drifting.
 *
 * There is no network here, no database, no model and no clock. A test that
 * needed any of them would be testing something else.
 */

const repository = new Repository({ forge: "github", owner: "octocat", name: "ara" })

const dayWindow = new DayWindow({
  day: CalendarDay.make("2026-08-22"),
  timeZone: TimeZone.make("Europe/Paris")
})

/** `[path, additions, deletions]`, because a file in a test is three facts. */
type FileInput = readonly [string, number, number]

interface CommitInput {
  readonly subject?: string
  readonly at?: string
  readonly author?: string | null
  /** What the Forge itself says the account is. */
  readonly forgeSaysBot?: boolean
  readonly parents?: number
  readonly files?: ReadonlyArray<FileInput>
}

let sequence = 0

const commit = (input: CommitInput = {}) =>
  new CommitActivity({
    sha: `sha-${++sequence}`,
    subject: input.subject ?? "Do the work",
    authoredAt: DateTime.unsafeMake(input.at ?? "2026-08-22T10:00:00.000Z"),
    authorLogin: input.author === undefined ? "octocat" : input.author,
    authorIsBot: input.forgeSaysBot ?? false,
    parentCount: input.parents ?? 1,
    files: (input.files ?? [["src/main.ts", 5, 2]]).map(
      ([path, additions, deletions]) => new FileChange({ path, additions, deletions })
    )
  })

const pullRequest = (
  number: number,
  kind: "opened" | "merged",
  input: { readonly title?: string; readonly author?: string | null; readonly forgeSaysBot?: boolean } = {}
) =>
  new PullRequestActivity({
    number,
    title: input.title ?? `Pull request ${number}`,
    kind,
    authorLogin: input.author === undefined ? "octocat" : input.author,
    authorIsBot: input.forgeSaysBot ?? false
  })

const activityOf = (commits: ReadonlyArray<CommitActivity>, pullRequests: ReadonlyArray<PullRequestActivity> = []) =>
  new RepositoryActivity({ repository, dayWindow, commits, pullRequests })

/** Build a Digest the way the collect stage does, with the shipped thresholds. */
const digestOf = (activity: RepositoryActivity): Effect.Effect<Digest, never, BuildDigest> =>
  Effect.map(BuildDigest, (build) => build.execute(activity))

const buildingWith = (settings: Record<string, string> = {}) =>
  BuildDigest.Default.pipe(
    Layer.provide(Layer.setConfigProvider(ConfigProvider.fromMap(new Map(Object.entries(settings)))))
  )

const Building = buildingWith()

describe("The shape of a Digest", () => {
  it.effect("is the repository, the day, and what was done to it", () =>
    Effect.gen(function* () {
      const digest = yield* digestOf(
        activityOf([
          commit({ subject: "Add the collect stage", files: [["src/digests/collect.ts", 40, 3]] }),
          commit({ subject: "Test it", files: [["src/digests/collect.test.ts", 60, 0]] })
        ])
      )

      assert.deepStrictEqual(digest.repo, repository)
      assert.strictEqual(digest.day, "2026-08-22")
      assert.strictEqual(digest.commitCount, 2)
      assert.deepStrictEqual(
        digest.commits.map((entry) => entry.subject),
        ["Add the collect stage", "Test it"]
      )
      assert.deepStrictEqual([...(digest.commits[0]?.files ?? [])], ["src/digests/collect.ts"])
    }).pipe(Effect.provide(Building))
  )

  it.effect("carries exactly the settled fields and nothing else", () =>
    Effect.gen(function* () {
      const digest = yield* digestOf(activityOf([commit()]))

      // The shape was settled by prototype and is the input a Draft is written
      // from. A field appearing here that nobody decided on is a regression,
      // and `patch` appearing here would be a breach of ADR-0004.
      assert.deepStrictEqual(Object.keys(digest).sort(), [
        "commitCount",
        "commits",
        "day",
        "isQuiet",
        "pullRequests",
        "repo",
        "topAreas",
        "topFiles",
        "totals"
      ])
    }).pipe(Effect.provide(Building))
  )

  it.effect("reads a day forwards, whatever order the Forge listed it in", () =>
    Effect.gen(function* () {
      const digest = yield* digestOf(
        activityOf([
          commit({ subject: "Last", at: "2026-08-22T18:00:00.000Z" }),
          commit({ subject: "First", at: "2026-08-22T07:00:00.000Z" }),
          commit({ subject: "Middle", at: "2026-08-22T12:00:00.000Z" })
        ])
      )

      assert.deepStrictEqual(
        digest.commits.map((entry) => entry.subject),
        ["First", "Middle", "Last"]
      )
    }).pipe(Effect.provide(Building))
  )

  it.effect("gives the same Digest for the same Activity, twice", () =>
    Effect.gen(function* () {
      const activity = activityOf(
        [
          commit({
            files: [
              ["b.ts", 1, 1],
              ["a.ts", 1, 1]
            ]
          }),
          commit({
            files: [
              ["src/x.ts", 2, 2],
              ["src/y.ts", 2, 2]
            ]
          })
        ],
        [pullRequest(2, "opened"), pullRequest(1, "merged")]
      )

      const [first, second] = [yield* digestOf(activity), yield* digestOf(activity)]

      // Regenerating a Draft is only a comparison of prose if the Digest under
      // it is identical, so ordering is never left to whatever the Forge sent.
      assert.deepStrictEqual(first, second)
      assert.deepStrictEqual([...(first.commits[0]?.files ?? [])], ["a.ts", "b.ts"])
    }).pipe(Effect.provide(Building))
  )
})

describe("Totals, areas and top files", () => {
  it.effect("counts distinct files rather than touches", () =>
    Effect.gen(function* () {
      const digest = yield* digestOf(
        activityOf([
          commit({ files: [["src/main.ts", 10, 1]] }),
          commit({
            files: [
              ["src/main.ts", 5, 4],
              ["README.md", 2, 0]
            ]
          })
        ])
      )

      assert.strictEqual(digest.totals.filesTouched, 2)
      assert.strictEqual(digest.totals.additions, 17)
      assert.strictEqual(digest.totals.deletions, 5)
    }).pipe(Effect.provide(Building))
  )

  it.effect("aggregates areas from the Activity, not from a second question to the Forge", () =>
    Effect.gen(function* () {
      const digest = yield* digestOf(
        activityOf([
          commit({
            files: [
              ["src/digests/build.ts", 30, 10],
              ["src/digests/collect.ts", 20, 0]
            ]
          }),
          commit({
            files: [
              ["docs/adr/0006.md", 5, 0],
              ["README.md", 1, 1]
            ]
          })
        ])
      )

      assert.deepStrictEqual(
        digest.topAreas.map((area) => [area.dir, area.churn]),
        [
          ["src/digests", 60],
          ["docs/adr", 5],
          ["(root)", 2]
        ]
      )
    }).pipe(Effect.provide(Building))
  )

  it.effect("names the busiest files, summed across every commit that touched them", () =>
    Effect.gen(function* () {
      const digest = yield* digestOf(
        activityOf([
          commit({ files: [["src/quiet.ts", 1, 0]] }),
          commit({
            files: [
              ["src/busy.ts", 40, 10],
              ["src/quiet.ts", 1, 0]
            ]
          }),
          commit({ files: [["src/busy.ts", 5, 5]] })
        ])
      )

      assert.deepStrictEqual(
        digest.topFiles.map((file) => [file.path, file.additions, file.deletions]),
        [
          ["src/busy.ts", 45, 15],
          ["src/quiet.ts", 2, 0]
        ]
      )
    }).pipe(Effect.provide(Building))
  )

  it.effect("keeps the lists readable on a day that touched everything", () =>
    Effect.gen(function* () {
      const files: ReadonlyArray<FileInput> = Array.from(
        { length: 30 },
        (_, index) => [`area${index}/file${index}.ts`, 30 - index, 0] as const
      )

      const digest = yield* digestOf(activityOf([commit({ files })]))

      assert.lengthOf(digest.topFiles, 10)
      assert.lengthOf(digest.topAreas, 5)
      assert.strictEqual(digest.totals.filesTouched, 30)
      assert.strictEqual(digest.topFiles[0]?.path, "area0/file0.ts")
    }).pipe(Effect.provide(Building))
  )
})

describe("What a Digest leaves out", () => {
  it.effect("excludes commits the Forge calls a bot", () =>
    Effect.gen(function* () {
      const digest = yield* digestOf(
        activityOf([
          commit({ subject: "Real work" }),
          commit({ subject: "Bump lodash", author: "dependabot", forgeSaysBot: true, files: [["package.json", 1, 1]] })
        ])
      )

      assert.strictEqual(digest.commitCount, 1)
      assert.deepStrictEqual(
        digest.commits.map((entry) => entry.subject),
        ["Real work"]
      )
    }).pipe(Effect.provide(Building))
  )

  it.effect("excludes bots the Forge does not label, by how they sign", () =>
    Effect.gen(function* () {
      const digest = yield* digestOf(
        activityOf([
          commit({ subject: "Real work" }),
          commit({ subject: "Bump", author: "dependabot[bot]" }),
          commit({ subject: "Bump", author: "Renovate[Bot]" }),
          commit({ subject: "Bump", author: "renovate" }),
          commit({ subject: "Regenerate", author: "github-actions" })
        ])
      )

      assert.strictEqual(digest.commitCount, 1)
    }).pipe(Effect.provide(Building))
  )

  it.effect("keeps a person whose name merely mentions a robot", () =>
    Effect.gen(function* () {
      const digest = yield* digestOf(activityOf([commit({ author: "robotnik" }), commit({ author: null })]))

      assert.strictEqual(digest.commitCount, 2)
    }).pipe(Effect.provide(Building))
  )

  it.effect("excludes merge commits, which are branch mechanics rather than work", () =>
    Effect.gen(function* () {
      const digest = yield* digestOf(
        activityOf([
          commit({ subject: "Real work" }),
          commit({ subject: "Merge branch 'main' into feature", parents: 2, files: [["src/main.ts", 200, 200]] })
        ])
      )

      assert.strictEqual(digest.commitCount, 1)
      // And the merge's line counts are gone with it, rather than inflating the day.
      assert.strictEqual(digest.totals.additions, 5)
    }).pipe(Effect.provide(Building))
  )

  it.effect("tells branch work once when the branch is merged the same day", () =>
    Effect.gen(function* () {
      // A Digest reads every branch (ADR-0006), so the day's commits are already
      // in it by the time the merge lands. The merge commit is the second
      // telling of the same work, and the two-parent rule is what drops it.
      const digest = yield* digestOf(
        activityOf([
          commit({ subject: "Add the collect stage", at: "2026-08-22T09:00:00.000Z" }),
          commit({ subject: "Test the collect stage", at: "2026-08-22T10:00:00.000Z" }),
          commit({
            subject: "Merge pull request #14 from tonytangdev/feat/mvp-day-to-draft",
            at: "2026-08-22T11:00:00.000Z",
            parents: 2,
            files: [
              ["src/digests/collect.ts", 5, 2],
              ["src/digests/collect.test.ts", 5, 2]
            ]
          })
        ])
      )

      assert.strictEqual(digest.commitCount, 2)
      assert.deepStrictEqual(
        digest.commits.map((entry) => entry.subject),
        ["Add the collect stage", "Test the collect stage"]
      )
      // Two commits' worth of churn, not four.
      assert.strictEqual(digest.totals.additions + digest.totals.deletions, 14)
    }).pipe(Effect.provide(Building))
  )

  it.effect("excludes lockfile churn from a commit that also did real work", () =>
    Effect.gen(function* () {
      const digest = yield* digestOf(
        activityOf([
          commit({
            subject: "Add a dependency and use it",
            files: [
              ["pnpm-lock.yaml", 4000, 3000],
              ["src/main.ts", 10, 0]
            ]
          })
        ])
      )

      assert.strictEqual(digest.commitCount, 1)
      assert.deepStrictEqual([...(digest.commits[0]?.files ?? [])], ["src/main.ts"])
      assert.strictEqual(digest.totals.filesTouched, 1)
      assert.strictEqual(digest.totals.additions, 10)
      assert.deepStrictEqual(
        digest.topAreas.map((area) => area.dir),
        ["src"]
      )
    }).pipe(Effect.provide(Building))
  )

  it.effect("drops a commit that was nothing but a lockfile", () =>
    Effect.gen(function* () {
      const digest = yield* digestOf(
        activityOf([
          commit({ subject: "Real work" }),
          commit({ subject: "pnpm install", files: [["pnpm-lock.yaml", 900, 800]] }),
          commit({ subject: "cargo update", files: [["crates/api/Cargo.lock", 40, 40]] }),
          commit({ subject: "go mod tidy", files: [["go.sum", 12, 3]] })
        ])
      )

      assert.strictEqual(digest.commitCount, 1)
      assert.strictEqual(digest.totals.additions, 5)
    }).pipe(Effect.provide(Building))
  )

  it.effect("keeps files whose names only resemble a lockfile", () =>
    Effect.gen(function* () {
      const digest = yield* digestOf(
        activityOf([
          commit({
            files: [
              ["src/yarn.lock.ts", 3, 0],
              ["docs/lockfiles.md", 2, 0]
            ]
          })
        ])
      )

      assert.strictEqual(digest.totals.filesTouched, 2)
    }).pipe(Effect.provide(Building))
  )
})

describe("Pull requests", () => {
  it.effect("says what happened to each one, lowest number first", () =>
    Effect.gen(function* () {
      const digest = yield* digestOf(
        activityOf(
          [commit()],
          [pullRequest(12, "merged", { title: "Ship the Digest" }), pullRequest(7, "opened", { title: "Try a thing" })]
        )
      )

      assert.deepStrictEqual(
        digest.pullRequests.map((pull) => [pull.number, pull.title, pull.kind]),
        [
          [7, "Try a thing", "opened"],
          [12, "Ship the Digest", "merged"]
        ]
      )
    }).pipe(Effect.provide(Building))
  )

  it.effect("counts one opened and merged inside the same day once, as merged", () =>
    Effect.gen(function* () {
      const digest = yield* digestOf(activityOf([commit()], [pullRequest(9, "opened"), pullRequest(9, "merged")]))

      assert.deepStrictEqual(
        digest.pullRequests.map((pull) => pull.kind),
        ["merged"]
      )
    }).pipe(Effect.provide(Building))
  )

  it.effect("excludes a bot's pull requests, so Ara does not write about Dependabot's day", () =>
    Effect.gen(function* () {
      const digest = yield* digestOf(
        activityOf(
          [commit()],
          [
            pullRequest(1, "merged", { author: "octocat" }),
            pullRequest(2, "opened", { author: "dependabot[bot]" }),
            pullRequest(3, "opened", { author: "someone", forgeSaysBot: true })
          ]
        )
      )

      assert.deepStrictEqual(
        digest.pullRequests.map((pull) => pull.number),
        [1]
      )
    }).pipe(Effect.provide(Building))
  )
})

describe("A day with nothing in it", () => {
  it.effect("is a Digest, not a failure", () =>
    Effect.gen(function* () {
      const digest = yield* digestOf(activityOf([]))

      assert.strictEqual(digest.commitCount, 0)
      assert.deepStrictEqual([...digest.commits], [])
      assert.deepStrictEqual([...digest.pullRequests], [])
      assert.deepStrictEqual([...digest.topAreas], [])
      assert.deepStrictEqual([...digest.topFiles], [])
      assert.deepStrictEqual({ ...digest.totals }, { filesTouched: 0, additions: 0, deletions: 0 })
      assert.isTrue(digest.isEmpty)
      assert.strictEqual(digest.day, "2026-08-22")
    }).pipe(Effect.provide(Building))
  )

  it.effect("is still empty when the only Activity was excluded", () =>
    Effect.gen(function* () {
      const digest = yield* digestOf(
        activityOf([
          commit({ author: "dependabot[bot]" }),
          commit({ parents: 2 }),
          commit({ files: [["pnpm-lock.yaml", 500, 500]] })
        ])
      )

      assert.isTrue(digest.isEmpty)
      assert.isTrue(digest.isQuiet)
    }).pipe(Effect.provide(Building))
  )
})

describe("Deciding a Quiet Day", () => {
  it.effect("calls a light day quiet: under three commits and under fifty lines", () =>
    Effect.gen(function* () {
      const digest = yield* digestOf(
        activityOf([commit({ files: [["src/main.ts", 8, 2]] }), commit({ files: [["src/other.ts", 3, 0]] })])
      )

      assert.isTrue(digest.isQuiet)
    }).pipe(Effect.provide(Building))
  )

  it.effect("does not call a day quiet on commit count alone", () =>
    Effect.gen(function* () {
      const digest = yield* digestOf(activityOf([commit({ files: [["src/main.ts", 60, 40]] })]))

      assert.strictEqual(digest.commitCount, 1)
      assert.isFalse(digest.isQuiet)
    }).pipe(Effect.provide(Building))
  )

  it.effect("does not call a day quiet on line count alone", () =>
    Effect.gen(function* () {
      const digest = yield* digestOf(
        activityOf([
          commit({ files: [["a.ts", 1, 0]] }),
          commit({ files: [["b.ts", 1, 0]] }),
          commit({ files: [["c.ts", 1, 0]] })
        ])
      )

      assert.strictEqual(digest.commitCount, 3)
      assert.isFalse(digest.isQuiet)
    }).pipe(Effect.provide(Building))
  )

  it.effect("counts only what survived the filtering", () =>
    Effect.gen(function* () {
      const digest = yield* digestOf(
        activityOf([
          commit({ files: [["src/main.ts", 4, 0]] }),
          commit({ author: "dependabot[bot]", files: [["package.json", 2, 2]] }),
          commit({ parents: 2, files: [["src/main.ts", 300, 300]] }),
          commit({ files: [["pnpm-lock.yaml", 900, 900]] })
        ])
      )

      // One commit and four lines: a light day dressed up as a busy one.
      assert.strictEqual(digest.commitCount, 1)
      assert.isTrue(digest.isQuiet)
    }).pipe(Effect.provide(Building))
  )

  it.effect("moves when the threshold is corrected", () =>
    Effect.gen(function* () {
      const activity = activityOf([
        commit({ files: [["a.ts", 10, 0]] }),
        commit({ files: [["b.ts", 10, 0]] }),
        commit({ files: [["c.ts", 10, 0]] }),
        commit({ files: [["d.ts", 10, 0]] })
      ])

      const strict = yield* digestOf(activity).pipe(Effect.provide(Building))
      const generous = yield* digestOf(activity).pipe(
        Effect.provide(buildingWith({ DIGEST_QUIET_BELOW_COMMITS: "10", DIGEST_QUIET_BELOW_CHANGED_LINES: "500" }))
      )

      assert.isFalse(strict.isQuiet)
      assert.isTrue(generous.isQuiet)
    })
  )
})

/**
 * The threshold, one line either side of where it fires.
 *
 * Both numbers are exclusive — *fewer than* three commits and *under* fifty
 * changed lines — and "under fifty" is exactly the kind of boundary that drifts
 * into "fifty or fewer" during a refactor. These are the tests that would notice.
 * They are here, on the pure function, and not in a prompt: the Quiet Day is
 * decided before any model is called and is a fact about the Digest by the time
 * a Draft is asked for.
 */
describe("The Quiet Day threshold, at the boundary", () => {
  /** Two commits, and exactly `lines` changed lines between them. */
  const twoCommitsOf = (lines: number) =>
    activityOf([commit({ files: [["src/main.ts", lines - 1, 0]] }), commit({ files: [["src/other.ts", 1, 0]] })])

  it.effect("is quiet one line under the line threshold", () =>
    Effect.gen(function* () {
      const digest = yield* digestOf(twoCommitsOf(49))

      assert.strictEqual(digest.commitCount, 2)
      assert.strictEqual(digest.totals.additions + digest.totals.deletions, 49)
      assert.isTrue(digest.isQuiet)
    }).pipe(Effect.provide(Building))
  )

  it.effect("is not quiet exactly at the line threshold", () =>
    Effect.gen(function* () {
      const digest = yield* digestOf(twoCommitsOf(50))

      assert.strictEqual(digest.totals.additions + digest.totals.deletions, 50)
      assert.isFalse(digest.isQuiet)
    }).pipe(Effect.provide(Building))
  )

  it.effect("is quiet one commit under the commit threshold", () =>
    Effect.gen(function* () {
      const digest = yield* digestOf(
        activityOf([commit({ files: [["a.ts", 1, 0]] }), commit({ files: [["b.ts", 1, 0]] })])
      )

      assert.strictEqual(digest.commitCount, 2)
      assert.isTrue(digest.isQuiet)
    }).pipe(Effect.provide(Building))
  )

  it.effect("is not quiet exactly at the commit threshold, however little moved", () =>
    Effect.gen(function* () {
      const digest = yield* digestOf(
        activityOf([
          commit({ files: [["a.ts", 1, 0]] }),
          commit({ files: [["b.ts", 1, 0]] }),
          commit({ files: [["c.ts", 1, 0]] })
        ])
      )

      assert.strictEqual(digest.commitCount, 3)
      assert.strictEqual(digest.totals.additions + digest.totals.deletions, 3)
      assert.isFalse(digest.isQuiet)
    }).pipe(Effect.provide(Building))
  )

  it.effect("counts deletions as changed lines too: a day spent removing code was still a day", () =>
    Effect.gen(function* () {
      const digest = yield* digestOf(
        activityOf([commit({ files: [["src/dead.ts", 0, 60]] }), commit({ files: [["src/main.ts", 0, 1]] })])
      )

      assert.strictEqual(digest.totals.deletions, 61)
      assert.isFalse(digest.isQuiet)
    }).pipe(Effect.provide(Building))
  )

  it.effect("moves both halves of the threshold when they are corrected", () =>
    Effect.gen(function* () {
      const activity = twoCommitsOf(49)

      const strict = yield* digestOf(activity).pipe(
        Effect.provide(buildingWith({ DIGEST_QUIET_BELOW_COMMITS: "2", DIGEST_QUIET_BELOW_CHANGED_LINES: "50" }))
      )
      const stricter = yield* digestOf(activity).pipe(
        Effect.provide(buildingWith({ DIGEST_QUIET_BELOW_COMMITS: "3", DIGEST_QUIET_BELOW_CHANGED_LINES: "49" }))
      )

      // Two commits is not *fewer than* two; forty-nine lines is not *under*
      // forty-nine. Either half moving is enough to stop a day being quiet.
      assert.isFalse(strict.isQuiet)
      assert.isFalse(stricter.isQuiet)
    })
  )
})
