import { HttpClient, type HttpClientRequest, HttpClientResponse } from "@effect/platform"
import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, DateTime, Effect, Fiber, Layer, Redacted, Ref, TestClock } from "effect"
import { InstallationTokens } from "../../../connections/domain/ports/installation-tokens.ts"
import { Repository } from "../../../connections/domain/repository.ts"
import { TimeZone } from "../../../connections/domain/time-zone.ts"
import { GithubRateLimiterLive } from "../../../connections/infrastructure/github/github-rate-limiter.ts"
import { CalendarDay, DayWindow } from "../../../runs/domain/day-window.ts"
import { RepoActivitySource } from "../../domain/ports/repo-activity-source.ts"
import { GithubRepoActivitySourceLive } from "./github-repo-activity-source.ts"

/**
 * What this test drives: the adapter's half of the bargain, against a GitHub
 * reduced to scripted replies. What Ara asks for, what it makes of the answer,
 * and — the one that matters most — what it refuses to carry away from it.
 *
 * Whether GitHub still replies in this shape is not a question a fake can
 * answer; that is what the contract test beside this file is for.
 */

const repository = new Repository({ forge: "github", owner: "octocat", name: "ara" })

/** The 22nd in Paris: 22:00 on the 21st UTC, to 22:00 on the 22nd. */
const dayWindow = new DayWindow({
  day: CalendarDay.make("2026-08-22"),
  timeZone: TimeZone.make("Europe/Paris")
})

const TestConfig = Layer.setConfigProvider(
  ConfigProvider.fromMap(
    new Map([
      ["GITHUB_APP_ID", "12345"],
      ["GITHUB_APP_CLIENT_ID", "Iv1.test"],
      ["GITHUB_APP_CLIENT_SECRET", "client-secret"],
      ["GITHUB_APP_PRIVATE_KEY", "not-used-here"]
    ])
  )
)

/** A token, without minting one: how the token is got is `InstallationTokens`' business. */
const FakeTokens = Layer.succeed(
  InstallationTokens,
  InstallationTokens.of({
    tokenFor: () =>
      Effect.succeed({
        token: Redacted.make("ghs_installation"),
        expiresAt: DateTime.unsafeMake("2099-01-01T00:00:00.000Z")
      })
  })
)

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })

interface Asked {
  readonly path: string
  readonly params: ReadonlyArray<readonly [string, string]>
  readonly authorization: string
}

const githubAnswering = (reply: (path: string) => Response) =>
  Effect.gen(function* () {
    const asked = yield* Ref.make<ReadonlyArray<Asked>>([])

    const client = HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
      Effect.gen(function* () {
        const path = new URL(request.url).pathname
        yield* Ref.update(asked, (all) => [
          ...all,
          {
            path,
            params: [...request.urlParams],
            authorization: request.headers.authorization ?? ""
          }
        ])
        return HttpClientResponse.fromWeb(request, reply(path))
      })
    )

    const layer = GithubRepoActivitySourceLive.pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
      Layer.provide(FakeTokens),
      // The real limiter, on its default budget of thousands an hour: what is
      // being driven here is the adapter reading GitHub, and a limiter that
      // never bites is the honest background for that.
      Layer.provide(GithubRateLimiterLive),
      Layer.provide(TestConfig)
    )

    return { asked, layer } as const
  })

/** A day where nothing happened: two calls, both answered, nothing to page through. */
const quietDay = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, json([])))

const read = Effect.flatMap(RepoActivitySource, (source) =>
  source.activityFor({ repository, dayWindow, installationExternalId: "42" })
)

const commitListItem = (sha: string, message: string, date: string, extra: Record<string, unknown> = {}) => ({
  sha,
  commit: { message, author: { name: "The Octocat" }, committer: { date } },
  author: { login: "octocat", type: "User" },
  parents: [{ sha: "parent" }],
  ...extra
})

/**
 * GitHub sends the diff whether Ara wants it or not. The fixture carries it so
 * that the assertion below is about the adapter refusing it, rather than about
 * a fixture that never offered it.
 */
const commitDetail = (path: string, additions: number, deletions: number) => ({
  stats: { additions, deletions, total: additions + deletions },
  files: [
    {
      filename: path,
      additions,
      deletions,
      status: "modified",
      patch: "@@ -1 +1 @@\n-const secret = 1\n+const secret = 2"
    }
  ]
})

describe("Reading a day of Activity from GitHub", () => {
  it.effect("asks for the Day Window, with the installation's own token", () =>
    Effect.gen(function* () {
      const github = yield* githubAnswering((path) =>
        path.endsWith("/commits")
          ? json([commitListItem("abc", "Add the thing", "2026-08-22T09:00:00Z")])
          : path.endsWith("/pulls")
            ? json([])
            : json(commitDetail("src/main.ts", 10, 2))
      )

      yield* read.pipe(Effect.provide(github.layer))

      const [commits] = yield* Ref.get(github.asked)
      assert.strictEqual(commits?.path, "/repos/octocat/ara/commits")
      assert.strictEqual(commits?.authorization, "Bearer ghs_installation")

      const params = new Map(commits?.params ?? [])
      assert.strictEqual(params.get("since"), "2026-08-21T22:00:00.000Z")
      // GitHub's `until` includes its own boundary; the Day Window excludes it.
      assert.strictEqual(params.get("until"), "2026-08-22T21:59:59.000Z")
    })
  )

  it.effect("carries subjects, paths and line counts — and no diff", () =>
    Effect.gen(function* () {
      const github = yield* githubAnswering((path) =>
        path.endsWith("/commits")
          ? json([
              commitListItem(
                "abc",
                "Add the thing\n\nWith a long explanation nobody asked for.",
                "2026-08-22T09:00:00Z"
              )
            ])
          : path.endsWith("/pulls")
            ? json([])
            : json(commitDetail("src/main.ts", 10, 2))
      )

      const activity = yield* read.pipe(Effect.provide(github.layer))

      const [commit] = activity.commits
      assert.strictEqual(commit?.subject, "Add the thing")
      assert.strictEqual(commit?.parentCount, 1)
      assert.strictEqual(commit?.authorLogin, "octocat")
      assert.deepStrictEqual(
        commit?.files.map((file) => [file.path, file.additions, file.deletions]),
        [["src/main.ts", 10, 2]]
      )

      // ADR-0004, enforced at the edge: the patch was in the reply and is in
      // nothing Ara took away from it.
      const carried = JSON.stringify(activity)
      assert.notInclude(carried, "patch")
      assert.notInclude(carried, "const secret")
    })
  )

  it.effect("keeps GitHub's inclusive boundary out of the Day Window", () =>
    Effect.gen(function* () {
      const github = yield* githubAnswering((path) =>
        path.endsWith("/commits")
          ? json([
              commitListItem("inside", "Just inside", "2026-08-22T21:59:59Z"),
              commitListItem("outside", "Tomorrow already", "2026-08-22T22:00:00Z")
            ])
          : path.endsWith("/pulls")
            ? json([])
            : json(commitDetail("src/main.ts", 1, 0))
      )

      const activity = yield* read.pipe(Effect.provide(github.layer))

      assert.deepStrictEqual(
        activity.commits.map((commit) => commit.sha),
        ["inside"]
      )
      // And nothing was asked about the commit that fell outside it.
      const paths = (yield* Ref.get(github.asked)).map((asked) => asked.path)
      assert.notInclude(paths, "/repos/octocat/ara/commits/outside")
    })
  )

  it.effect("says what happened to each pull request inside the window", () =>
    Effect.gen(function* () {
      const github = yield* githubAnswering((path) =>
        path.endsWith("/commits")
          ? json([])
          : path.endsWith("/pulls")
            ? json([
                {
                  number: 12,
                  title: "Ship the Digest",
                  created_at: "2026-08-20T09:00:00Z",
                  updated_at: "2026-08-22T10:00:00Z",
                  merged_at: "2026-08-22T10:00:00Z",
                  user: { login: "octocat", type: "User" }
                },
                {
                  number: 13,
                  title: "Try a thing",
                  created_at: "2026-08-22T11:00:00Z",
                  updated_at: "2026-08-22T11:00:00Z",
                  merged_at: null,
                  user: { login: "octocat", type: "User" }
                },
                {
                  number: 4,
                  title: "Last week's work",
                  created_at: "2026-08-15T11:00:00Z",
                  updated_at: "2026-08-15T11:00:00Z",
                  merged_at: "2026-08-15T12:00:00Z",
                  user: { login: "octocat", type: "User" }
                }
              ])
            : json(commitDetail("src/main.ts", 1, 0))
      )

      const activity = yield* read.pipe(Effect.provide(github.layer))

      assert.deepStrictEqual(
        activity.pullRequests.map((pull) => [pull.number, pull.kind]),
        [
          [12, "merged"],
          [13, "opened"]
        ]
      )
    })
  )

  it.effect("reports a day with no Activity as a day with no Activity", () =>
    Effect.gen(function* () {
      const github = yield* githubAnswering(() => json([]))

      const activity = yield* read.pipe(Effect.provide(github.layer))

      assert.deepStrictEqual([...activity.commits], [])
      assert.deepStrictEqual([...activity.pullRequests], [])
      assert.deepStrictEqual(activity.repository, repository)
    })
  )

  it.effect("reports a refusal as Activity being unavailable, naming the repository", () =>
    Effect.gen(function* () {
      const github = yield* githubAnswering(() => new Response("gone", { status: 404 }))

      const failure = yield* Effect.flip(read).pipe(Effect.provide(github.layer))

      assert.strictEqual(failure._tag, "ActivityUnavailable")
      assert.include(failure.reason, "octocat/ara")
      // A repository that is gone stays gone. Asking again would burn quota to
      // learn nothing, which is why the classification is made here.
      assert.isFalse(failure.retryable)
    })
  )

  it.effect("reports GitHub's own rate limit as worth trying again", () =>
    Effect.gen(function* () {
      const github = yield* githubAnswering(() => new Response("", { status: 429 }))

      const failure = yield* Effect.flip(read).pipe(Effect.provide(github.layer))

      assert.strictEqual(failure._tag, "ActivityUnavailable")
      assert.include(failure.reason, "rate limiting")
      assert.isTrue(failure.retryable)
    })
  )

  it.effect("reads a secondary rate limit's Forbidden as a rate limit and not as a revocation", () =>
    Effect.gen(function* () {
      // GitHub answers a spent primary quota, and a secondary limit, with 403.
      // Read as a revocation it would fail a Run permanently for being busy.
      const github = yield* githubAnswering(() => new Response("", { status: 403 }))

      const failure = yield* Effect.flip(read).pipe(Effect.provide(github.layer))

      assert.include(failure.reason, "rate limiting")
      assert.isTrue(failure.retryable)
    })
  )
})

/**
 * What these drive: the budget the adapter composes in, from the outside. A Run
 * asks for a day of Activity; whose quota paid for it and how long it was
 * allowed to take are not in the question, which is exactly the property the
 * ticket is about.
 *
 * The budget here is two calls a minute, which is one whole read of a quiet
 * day: the commits page and the pull requests page.
 */
describe("Spending a GitHub App installation's budget", () => {
  const METERED = new Map([
    ["GITHUB_APP_ID", "12345"],
    ["GITHUB_APP_CLIENT_ID", "Iv1.test"],
    ["GITHUB_APP_CLIENT_SECRET", "client-secret"],
    ["GITHUB_APP_PRIVATE_KEY", "not-used-here"],
    ["GITHUB_RATE_LIMIT", "2"],
    ["GITHUB_RATE_LIMIT_INTERVAL", "1 minutes"],
    ["GITHUB_REQUEST_TIMEOUT", "5 seconds"]
  ])

  const metered = GithubRepoActivitySourceLive.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, HttpClient.make(quietDay))),
    Layer.provide(FakeTokens),
    Layer.provide(GithubRateLimiterLive),
    Layer.provide(Layer.setConfigProvider(ConfigProvider.fromMap(METERED)))
  )

  const readFor = (installationExternalId: string) =>
    Effect.flatMap(RepoActivitySource, (source) =>
      Effect.either(source.activityFor({ repository, dayWindow, installationExternalId }))
    )

  it.effect("does not let one installation spend another's", () =>
    Effect.gen(function* () {
      // The busy installation's whole minute, spent.
      assert.strictEqual((yield* readFor("42"))._tag, "Right")

      const overBudget = yield* Effect.fork(readFor("42"))

      // A different installation, unaffected: this is what ADR-0005 bought.
      assert.strictEqual((yield* readFor("99"))._tag, "Right")

      yield* TestClock.adjust("5 seconds")
      const refused = yield* Fiber.join(overBudget)

      assert.isTrue(refused._tag === "Left")
      if (refused._tag !== "Left") return

      // Waiting past the bound is a Run to be tried again, not a Run to fail.
      assert.isTrue(refused.left.retryable)
      assert.include(refused.left.reason, "within")
    }).pipe(Effect.provide(metered))
  )
})
