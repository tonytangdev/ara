import { FetchHttpClient } from "@effect/platform"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { Repository } from "../../../connections/domain/repository.ts"
import { TimeZone } from "../../../connections/domain/time-zone.ts"
import { InstallationTokensLive } from "../../../connections/index.ts"
import { CalendarDay, DayWindow } from "../../../runs/domain/day-window.ts"
import { RepositoryActivity } from "../../domain/activity.ts"
import { RepoActivitySource } from "../../domain/ports/repo-activity-source.ts"
import { GithubRepoActivitySourceLive } from "./github-repo-activity-source.ts"

/**
 * The one test that talks to GitHub.
 *
 * Every other test in this module fakes the Forge, which means none of them can
 * notice GitHub changing the shape of a reply — the failure mode where Ara
 * keeps passing its own tests and stops working. This is the test for that, and
 * it is the only reason to accept a test that needs the network.
 *
 * It is excluded from `pnpm test` and therefore from CI: it needs credentials,
 * a real repository and a day that actually had commits in it, and it fails for
 * reasons that are nobody's fault. Run it by hand when the adapter changes or
 * when GitHub announces something:
 *
 * ```sh
 * pnpm --filter @ara/api test:contract
 * ```
 *
 * It needs the App credentials from `.env`, plus a scratch repository the App
 * is installed on and a day it has Activity for:
 *
 * ```sh
 * CONTRACT_GITHUB_INSTALLATION_ID=12345678
 * CONTRACT_GITHUB_OWNER=octocat
 * CONTRACT_GITHUB_NAME=scratch
 * CONTRACT_GITHUB_DAY=2026-08-22
 * ```
 */

const required = [
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "CONTRACT_GITHUB_INSTALLATION_ID",
  "CONTRACT_GITHUB_OWNER",
  "CONTRACT_GITHUB_NAME",
  "CONTRACT_GITHUB_DAY"
] as const

const missing = required.filter((name) => (process.env[name] ?? "") === "")

const repository = new Repository({
  forge: "github",
  owner: process.env.CONTRACT_GITHUB_OWNER ?? "octocat",
  name: process.env.CONTRACT_GITHUB_NAME ?? "hello-world"
})

const dayWindow = new DayWindow({
  day: CalendarDay.make(process.env.CONTRACT_GITHUB_DAY ?? "2026-08-22"),
  timeZone: TimeZone.make(process.env.CONTRACT_GITHUB_TIME_ZONE ?? "UTC")
})

const Live = GithubRepoActivitySourceLive.pipe(
  Layer.provide(InstallationTokensLive),
  Layer.provide(FetchHttpClient.layer)
)

const decodesAsActivity = Schema.is(Schema.typeSchema(RepositoryActivity))

describe.skipIf(missing.length > 0)("GitHub, as it actually replies", () => {
  it.live("still answers in the shape the adapter reads", () =>
    Effect.gen(function* () {
      const source = yield* RepoActivitySource

      const activity = yield* source.activityFor({
        repository,
        dayWindow,
        installationExternalId: process.env.CONTRACT_GITHUB_INSTALLATION_ID ?? ""
      })

      // Decoding at all is most of the point: a field GitHub renamed or a type
      // it changed fails the adapter's schema before it reaches this line.
      assert.isTrue(decodesAsActivity(activity))
      assert.deepStrictEqual(activity.repository, repository)

      for (const commit of activity.commits) {
        assert.isNotEmpty(commit.sha)
        assert.isNotEmpty(commit.subject, `commit ${commit.sha} came back with no subject`)
        // A commit is not empty of files in any repository worth writing about;
        // if this fails, the detail endpoint has changed where it puts them.
        assert.isNotEmpty(commit.files, `commit ${commit.sha} came back with no files`)
      }

      // ADR-0004, against the real payload: GitHub sends the patch, and none of
      // it survives the adapter.
      assert.notInclude(JSON.stringify(activity), "patch")
    }).pipe(Effect.provide(Live))
  )

  it.live("says a day with nothing in it had nothing in it", () =>
    Effect.gen(function* () {
      const source = yield* RepoActivitySource

      // The day before Git existed. Empty is an answer, not a failure.
      const activity = yield* source.activityFor({
        repository,
        dayWindow: new DayWindow({ day: CalendarDay.make("2004-01-01"), timeZone: TimeZone.make("UTC") }),
        installationExternalId: process.env.CONTRACT_GITHUB_INSTALLATION_ID ?? ""
      })

      assert.deepStrictEqual([...activity.commits], [])
    }).pipe(Effect.provide(Live))
  )
})
