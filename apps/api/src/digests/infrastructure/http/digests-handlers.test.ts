import { Cookies, HttpApi, HttpApiBuilder, HttpClient, HttpClientRequest } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { SqlClient } from "@effect/sql"
import { PgClient } from "@effect/sql-pg"
import { assert, describe, it } from "@effect/vitest"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { ConfigProvider, DateTime, Effect, Layer, Option, Redacted } from "effect"
import { afterAll, beforeAll, beforeEach } from "vitest"
import {
  ConnectionsApiGroup,
  RepoConnectionsApiGroup,
  SESSION_COOKIE,
  SIGN_IN_STATE_COOKIE
} from "../../../connections/api.ts"
import { AuthenticateSession } from "../../../connections/application/authenticate-session.ts"
import { BeginGithubSignIn } from "../../../connections/application/begin-github-sign-in.ts"
import { CompleteGithubSignIn } from "../../../connections/application/complete-github-sign-in.ts"
import { ConnectRepository } from "../../../connections/application/connect-repository.ts"
import { DescribeCurrentUser } from "../../../connections/application/describe-current-user.ts"
import { DisconnectRepository } from "../../../connections/application/disconnect-repository.ts"
import { ListReachableRepositories } from "../../../connections/application/list-reachable-repositories.ts"
import { ListRepoConnections } from "../../../connections/application/list-repo-connections.ts"
import { RecordGithubInstallation } from "../../../connections/application/record-github-installation.ts"
import { SetTimeZone } from "../../../connections/application/set-time-zone.ts"
import { Installation } from "../../../connections/domain/installation.ts"
import {
  ForgeAuthorizationFailed,
  GithubAuthorization
} from "../../../connections/domain/ports/github-authorization.ts"
import { ReachableRepositories } from "../../../connections/domain/ports/reachable-repositories.ts"
import { ReachableRepository, Repository } from "../../../connections/domain/repository.ts"
import { ForgeIdentity } from "../../../connections/domain/user.ts"
import { SecretCipher } from "../../../connections/infrastructure/crypto/secret-cipher.ts"
import { ConnectionsHandlersLive } from "../../../connections/infrastructure/http/connections-handlers.ts"
import { RepoConnectionsHandlersLive } from "../../../connections/infrastructure/http/repo-connections-handlers.ts"
import { SessionAuthenticationLive } from "../../../connections/infrastructure/http/session-authentication.ts"
import { PgForgeCredentialStoreLive } from "../../../connections/infrastructure/persistence/pg-forge-credential-store.ts"
import { PgInstallationRepositoryLive } from "../../../connections/infrastructure/persistence/pg-installation-repository.ts"
import { PgRepoConnectionRepositoryLive } from "../../../connections/infrastructure/persistence/pg-repo-connection-repository.ts"
import { PgSessionStoreLive } from "../../../connections/infrastructure/persistence/pg-session-store.ts"
import { PgUserRepositoryLive } from "../../../connections/infrastructure/persistence/pg-user-repository.ts"
import { MigrationsLive } from "../../../database/index.ts"
import { RequestLogger } from "../../../http/logging.ts"
import { RunsApiGroup } from "../../../runs/api.ts"
import { DescribeRun } from "../../../runs/application/describe-run.ts"
import { ListRuns } from "../../../runs/application/list-runs.ts"
import { ProcessNextRun } from "../../../runs/application/process-next-run.ts"
import { RequestRun } from "../../../runs/application/request-run.ts"
import { RunsHandlersLive } from "../../../runs/infrastructure/http/runs-handlers.ts"
import { PgJobQueueLive } from "../../../runs/infrastructure/persistence/pg-job-queue.ts"
import { PgRunRepositoryLive } from "../../../runs/infrastructure/persistence/pg-run-repository.ts"
import { DigestsApiGroup } from "../../api.ts"
import { DescribeDigest } from "../../application/describe-digest.ts"
import { CommitActivity, FileChange, PullRequestActivity, RepositoryActivity } from "../../domain/activity.ts"
import { PgDigestRepositoryLive } from "../../infrastructure/persistence/pg-digest-repository.ts"
import { collectDigestOver, repoActivitySourceOf } from "../../testing/fake-repo-activity.ts"
import { DigestsHandlersLive } from "./digests-handlers.ts"

/**
 * What these tests drive: the whole feature, from asking for a Run to reading
 * what Ara decided happened that day — over HTTP, through real use cases, the
 * real session middleware, a real Postgres and the real collect stage. Only the
 * Forge is faked, at the port ADR-0003 puts it behind.
 *
 * The filtering is asserted again here, on purpose. It is covered exhaustively
 * where it lives, in `build-digest.test.ts`; what this proves is that the path
 * a User actually walks is the path that applies it.
 */

const OCTOCAT_CODE = "octocat-code"
const HUBOT_CODE = "hubot-code"
const OCTOCAT_INSTALLATION = "42"
const HUBOT_INSTALLATION = "99"

const identities: Record<string, ForgeIdentity> = {
  [OCTOCAT_CODE]: new ForgeIdentity({
    forge: "github",
    forgeUserId: "583231",
    login: "octocat",
    displayName: "The Octocat",
    avatarUrl: null
  }),
  [HUBOT_CODE]: new ForgeIdentity({
    forge: "github",
    forgeUserId: "704000",
    login: "hubot",
    displayName: "Hubot",
    avatarUrl: null
  })
}

const reachable = (installationExternalId: string, owner: string, name: string) =>
  new ReachableRepository({
    repository: new Repository({ forge: "github", owner, name }),
    isPrivate: true,
    installationExternalId
  })

const reachableByInstallation: Record<string, ReadonlyArray<ReachableRepository>> = {
  [OCTOCAT_INSTALLATION]: [reachable(OCTOCAT_INSTALLATION, "octocat", "ara")],
  [HUBOT_INSTALLATION]: [reachable(HUBOT_INSTALLATION, "hubot", "scripts")]
}

const file = (path: string, additions: number, deletions: number) => new FileChange({ path, additions, deletions })

const commit = (
  sha: string,
  subject: string,
  files: ReadonlyArray<FileChange>,
  extra: { readonly author?: string; readonly parents?: number } = {}
) =>
  new CommitActivity({
    sha,
    subject,
    committedAt: DateTime.unsafeMake("2026-08-22T10:00:00.000Z"),
    authorLogin: extra.author ?? "octocat",
    authorIsBot: false,
    parentCount: extra.parents ?? 1,
    files
  })

/** A day with real work in it, and every kind of noise a Digest is meant to drop. */
const A_BUSY_DAY = {
  commits: [
    commit("aaa", "Add the collect stage", [file("src/digests/collect.ts", 80, 4), file("README.md", 3, 1)]),
    commit("bbb", "Test the collect stage", [file("src/digests/collect.test.ts", 120, 0)]),
    commit("ccc", "Bump lodash", [file("pnpm-lock.yaml", 900, 800)], { author: "dependabot[bot]" }),
    commit("ddd", "Merge branch 'main'", [file("src/digests/collect.ts", 400, 400)], { parents: 2 }),
    commit("eee", "pnpm install", [file("pnpm-lock.yaml", 40, 20)])
  ],
  pullRequests: [
    new PullRequestActivity({
      number: 6,
      title: "Build a Digest from real repository Activity",
      kind: "merged",
      authorLogin: "octocat",
      authorIsBot: false
    }),
    new PullRequestActivity({
      number: 7,
      title: "Bump lodash from 4.17.20 to 4.17.21",
      kind: "opened",
      authorLogin: "dependabot[bot]",
      authorIsBot: true
    })
  ]
} as const

let container: StartedPostgreSqlContainer

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start()
}, 180_000)

afterAll(async () => {
  await container?.stop()
})

const TestConfig = Layer.setConfigProvider(
  ConfigProvider.fromMap(
    new Map([
      ["CREDENTIAL_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64")],
      ["SESSION_SECURE_COOKIES", "false"],
      ["AFTER_SIGN_IN_URL", "/v1/me"]
    ])
  )
)

const database = () =>
  MigrationsLive.pipe(
    Layer.provideMerge(
      PgClient.layer({
        host: container.getHost(),
        port: container.getPort(),
        database: container.getDatabase(),
        username: container.getUsername(),
        password: Redacted.make(container.getPassword())
      })
    )
  )

const fakeGithub = Layer.succeed(
  GithubAuthorization,
  GithubAuthorization.of({
    beginSignIn: Effect.succeed({ url: "https://github.com/login/oauth/authorize", state: "state-from-github" }),
    completeSignIn: (code) => {
      const identity = identities[code]
      return identity === undefined
        ? Effect.fail(new ForgeAuthorizationFailed({ reason: "GitHub refused the sign-in code" }))
        : Effect.succeed({
            identity,
            credential: {
              forge: "github" as const,
              accessToken: Redacted.make(`ghu_${identity.login}`),
              refreshToken: Option.none(),
              accessTokenExpiresAt: Option.none()
            }
          })
    },
    describeInstallation: (externalId) =>
      Effect.succeed(new Installation({ forge: "github", externalId, accountLogin: "someone" }))
  })
)

const fakeReachableRepositories = Layer.succeed(
  ReachableRepositories,
  ReachableRepositories.of({
    listFor: (installation) => Effect.succeed(reachableByInstallation[installation.externalId] ?? [])
  })
)

/** The Forge, answering from a fixture: the same Activity for whatever is asked. */
const forgeReporting = (activity: {
  readonly commits: ReadonlyArray<CommitActivity>
  readonly pullRequests: ReadonlyArray<PullRequestActivity>
}) =>
  repoActivitySourceOf(
    ({ dayWindow, repository }) =>
      new RepositoryActivity({ repository, dayWindow, commits: activity.commits, pullRequests: activity.pullRequests })
  )

const TestApi = HttpApi.make("ara")
  .add(ConnectionsApiGroup)
  .add(RepoConnectionsApiGroup)
  .add(RunsApiGroup)
  .add(DigestsApiGroup)

const DrivenLive = Layer.mergeAll(
  fakeGithub,
  fakeReachableRepositories,
  PgUserRepositoryLive,
  PgSessionStoreLive,
  PgInstallationRepositoryLive,
  PgRepoConnectionRepositoryLive,
  PgJobQueueLive,
  PgRunRepositoryLive,
  PgDigestRepositoryLive,
  PgForgeCredentialStoreLive.pipe(Layer.provide(SecretCipher.Default))
)

const server = (forge: ReturnType<typeof forgeReporting>) =>
  Layer.suspend(() => {
    const collect = collectDigestOver(forge)

    const UnderTest = Layer.mergeAll(
      ConnectionsHandlersLive,
      RepoConnectionsHandlersLive,
      RunsHandlersLive,
      DigestsHandlersLive
    ).pipe(
      Layer.provideMerge(SessionAuthenticationLive),
      Layer.provideMerge(ProcessNextRun.Default.pipe(Layer.provide(collect))),
      Layer.provide(
        Layer.mergeAll(
          AuthenticateSession.Default,
          BeginGithubSignIn.Default,
          CompleteGithubSignIn.Default,
          ConnectRepository.Default,
          DescribeCurrentUser.Default,
          DescribeDigest.Default,
          DescribeRun.Default,
          DisconnectRepository.Default,
          ListReachableRepositories.Default,
          ListRepoConnections.Default,
          ListRuns.Default,
          RecordGithubInstallation.Default,
          RequestRun.Default,
          SetTimeZone.Default
        )
      ),
      Layer.provide(DrivenLive)
    )

    return HttpApiBuilder.serve(RequestLogger).pipe(
      Layer.provide(HttpApiBuilder.api(TestApi).pipe(Layer.provide(UnderTest))),
      // The worker's unit of work, callable in-line: a test that forked the
      // background loop would be waiting on a poll interval instead.
      Layer.provideMerge(ProcessNextRun.Default.pipe(Layer.provide(collect), Layer.provide(PgJobQueueLive))),
      Layer.provideMerge(database()),
      Layer.provideMerge(NodeHttpServer.layerTest),
      Layer.provide(TestConfig)
    )
  })

beforeEach(async () => {
  await Effect.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql`truncate users cascade`).pipe(Effect.provide(database()))
  )
})

const asSignedIn = (session: string | undefined) =>
  HttpClientRequest.setHeader("cookie", `${SESSION_COOKIE}=${session ?? ""}`)

const arrive = (code: string, installationId: string) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient

    const started = yield* http.get("/v1/auth/github")
    const state = Cookies.toRecord(started.cookies)[SIGN_IN_STATE_COOKIE]

    const returned = yield* HttpClientRequest.get("/v1/auth/github/callback").pipe(
      HttpClientRequest.setUrlParams({ code, state: state ?? "" }),
      HttpClientRequest.setHeader("cookie", Cookies.toCookieHeader(started.cookies)),
      http.execute
    )

    const session = Cookies.toRecord(returned.cookies)[SESSION_COOKIE]

    yield* HttpClientRequest.get("/v1/auth/github/installation").pipe(
      HttpClientRequest.setUrlParams({ installation_id: installationId }),
      asSignedIn(session),
      http.execute
    )

    return session
  })

interface RunBody {
  readonly id: string
  readonly state: string
  readonly failureReason: string | null
}

interface DigestBody {
  readonly id: string
  readonly runId: string
  readonly owner: string
  readonly name: string
  readonly day: string
  readonly commitCount: number
  readonly commits: ReadonlyArray<{ readonly subject: string; readonly files: ReadonlyArray<string> }>
  readonly pullRequests: ReadonlyArray<{ readonly number: number; readonly kind: string }>
  readonly totals: { readonly filesTouched: number; readonly additions: number; readonly deletions: number }
  readonly topAreas: ReadonlyArray<{ readonly dir: string; readonly churn: number }>
  readonly topFiles: ReadonlyArray<{ readonly path: string }>
  readonly isQuiet: boolean
}

const post = (session: string | undefined, path: string, body: unknown) =>
  Effect.flatMap(HttpClient.HttpClient, (http) =>
    HttpClientRequest.post(path).pipe(asSignedIn(session), HttpClientRequest.bodyUnsafeJson(body), http.execute)
  )

const get = (session: string | undefined, path: string) =>
  Effect.flatMap(HttpClient.HttpClient, (http) => HttpClientRequest.get(path).pipe(asSignedIn(session), http.execute))

/** Drain the queue the way the background fiber would, without being the background fiber. */
const workUntilEmpty = Effect.gen(function* () {
  const processNextRun = yield* ProcessNextRun

  let working = true
  while (working) {
    working = Option.isSome(yield* processNextRun.execute)
  }
})

/** Signed in, installed, one repository connected, one Run asked for and finished. */
const runFor = (day: string) =>
  Effect.gen(function* () {
    const session = yield* arrive(OCTOCAT_CODE, OCTOCAT_INSTALLATION)
    const connection = (yield* Effect.flatMap(
      post(session, "/v1/repo-connections", { forge: "github", owner: "octocat", name: "ara" }),
      (response) => response.json
    )) as { readonly id: string }

    const run = (yield* Effect.flatMap(
      post(session, `/v1/repo-connections/${connection.id}/runs`, { day }),
      (response) => response.json
    )) as RunBody

    return { session, connectionId: connection.id, run }
  })

describe("Reading the Digest a Run collected", () => {
  it.live("turns a day of Activity into the record Ara will write from", () =>
    Effect.gen(function* () {
      const { run, session } = yield* runFor("2026-08-22")
      yield* workUntilEmpty

      const finished = (yield* Effect.flatMap(get(session, `/v1/runs/${run.id}`), (r) => r.json)) as RunBody
      assert.strictEqual(finished.state, "succeeded")

      const response = yield* get(session, `/v1/runs/${run.id}/digest`)
      assert.strictEqual(response.status, 200)
      const digest = (yield* response.json) as DigestBody

      assert.strictEqual(digest.runId, run.id)
      assert.strictEqual(digest.owner, "octocat")
      assert.strictEqual(digest.name, "ara")
      assert.strictEqual(digest.day, "2026-08-22")

      // The bot commit, the merge and the lockfile-only commit are gone, and so
      // are the 2,560 lines they would have brought with them.
      assert.strictEqual(digest.commitCount, 2)
      assert.deepStrictEqual(
        digest.commits.map((entry) => entry.subject),
        ["Add the collect stage", "Test the collect stage"]
      )
      assert.deepStrictEqual({ ...digest.totals }, { filesTouched: 3, additions: 203, deletions: 5 })
      assert.deepStrictEqual(
        digest.topAreas.map((area) => area.dir),
        ["src/digests", "(root)"]
      )
      assert.strictEqual(digest.topFiles[0]?.path, "src/digests/collect.test.ts")
      assert.deepStrictEqual(
        digest.pullRequests.map((pull) => [pull.number, pull.kind]),
        [[6, "merged"]]
      )
      assert.isFalse(digest.isQuiet)
    }).pipe(Effect.provide(server(forgeReporting(A_BUSY_DAY))))
  )

  it.live("has nothing to show before the Run has been worked on", () =>
    Effect.gen(function* () {
      const { run, session } = yield* runFor("2026-08-22")

      assert.strictEqual((yield* get(session, `/v1/runs/${run.id}/digest`)).status, 404)
    }).pipe(Effect.provide(server(forgeReporting(A_BUSY_DAY))))
  )

  it.live("is invisible to everybody but its owner", () =>
    Effect.gen(function* () {
      const { run } = yield* runFor("2026-08-22")
      yield* workUntilEmpty

      const stranger = yield* arrive(HUBOT_CODE, HUBOT_INSTALLATION)

      const refused = yield* get(stranger, `/v1/runs/${run.id}/digest`)
      const unknown = yield* get(stranger, "/v1/runs/00000000-0000-4000-8000-000000000000/digest")

      assert.strictEqual(refused.status, 404)
      assert.strictEqual(unknown.status, 404)
      // The same answer either way: the 404 confirmed nothing.
      assert.deepStrictEqual(yield* refused.json, yield* unknown.json)

      assert.strictEqual((yield* get(undefined, `/v1/runs/${run.id}/digest`)).status, 401)
    }).pipe(Effect.provide(server(forgeReporting(A_BUSY_DAY))))
  )

  it.live("collects the same Run twice into one Digest", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const { run, session } = yield* runFor("2026-08-22")
      yield* workUntilEmpty

      // What a deploy interrupting a Run leaves behind, and what the next boot
      // hands back to the queue. Processing it again must not leave two.
      yield* sql`update runs set state = 'queued', finished_at = null where id = ${run.id}`
      yield* workUntilEmpty

      const rows = yield* sql<{ readonly count: string }>`
        select count(*)::text as count from digests where run_id = ${run.id}
      `
      assert.strictEqual(rows[0]?.count, "1")

      const digest = (yield* Effect.flatMap(get(session, `/v1/runs/${run.id}/digest`), (r) => r.json)) as DigestBody
      assert.strictEqual(digest.commitCount, 2)
    }).pipe(Effect.provide(server(forgeReporting(A_BUSY_DAY))))
  )
})

describe("A Day Window with no Activity at all", () => {
  it.live("produces a Digest, not a failure", () =>
    Effect.gen(function* () {
      const { run, session } = yield* runFor("2026-08-22")
      yield* workUntilEmpty

      const finished = (yield* Effect.flatMap(get(session, `/v1/runs/${run.id}`), (r) => r.json)) as RunBody
      assert.strictEqual(finished.state, "succeeded")
      assert.isNull(finished.failureReason)

      const digest = (yield* Effect.flatMap(get(session, `/v1/runs/${run.id}/digest`), (r) => r.json)) as DigestBody
      assert.strictEqual(digest.commitCount, 0)
      assert.deepStrictEqual({ ...digest.totals }, { filesTouched: 0, additions: 0, deletions: 0 })
      assert.deepStrictEqual([...digest.commits], [])
      assert.deepStrictEqual([...digest.topAreas], [])
      assert.isTrue(digest.isQuiet)
    }).pipe(Effect.provide(server(forgeReporting({ commits: [], pullRequests: [] }))))
  )
})

describe("A repository Ara can no longer read", () => {
  it.live("fails the Run with something the User can act on", () =>
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const { connectionId, run, session } = yield* runFor("2026-08-22")

      yield* HttpClientRequest.del(`/v1/repo-connections/${connectionId}`).pipe(asSignedIn(session), http.execute)
      yield* workUntilEmpty

      const failed = (yield* Effect.flatMap(get(session, `/v1/runs/${run.id}`), (r) => r.json)) as RunBody
      assert.strictEqual(failed.state, "failed")
      assert.include(failed.failureReason ?? "", "octocat/ara")

      assert.strictEqual((yield* get(session, `/v1/runs/${run.id}/digest`)).status, 404)
    }).pipe(Effect.provide(server(forgeReporting(A_BUSY_DAY))))
  )
})
