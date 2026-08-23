import { Cookies, HttpApi, HttpApiBuilder, HttpClient, HttpClientRequest } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { SqlClient } from "@effect/sql"
import { PgClient } from "@effect/sql-pg"
import { assert, describe, it } from "@effect/vitest"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { ConfigProvider, Effect, Layer, Option, Redacted } from "effect"
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
import {
  busyRepoActivitySource,
  collectDigestOver,
  unreachableRepoActivitySource
} from "../../../digests/testing/fake-repo-activity.ts"
import { passableDraftStage } from "../../../drafts/testing/fake-draft-writer.ts"
import { RequestLogger } from "../../../http/logging.ts"
import { RunsApiGroup } from "../../api.ts"
import { DescribeRun } from "../../application/describe-run.ts"
import { ListRuns } from "../../application/list-runs.ts"
import { ProcessNextRun } from "../../application/process-next-run.ts"
import { RequestRun } from "../../application/request-run.ts"
import { PgJobQueueLive } from "../persistence/pg-job-queue.ts"
import { PgRunRepositoryLive } from "../persistence/pg-run-repository.ts"
import { RunsHandlersLive } from "./runs-handlers.ts"

/**
 * What these tests drive: asking for a Run and watching it move, over HTTP,
 * through real use cases, the real session middleware and a real Postgres. Only
 * GitHub is faked, at the ports the ADRs put it behind.
 *
 * The worker is present as a use case and never as a fiber: where a test needs
 * the queue drained it calls `ProcessNextRun` itself. That is the whole reason
 * the unit of work is callable — a test that instead forked the background loop
 * would be waiting on a poll interval and would go flaky on a slow machine.
 */

const OCTOCAT_CODE = "octocat-code"
const HUBOT_CODE = "hubot-code"
const OCTOCAT_INSTALLATION = "42"
const HUBOT_INSTALLATION = "99"

const octocat = new ForgeIdentity({
  forge: "github",
  forgeUserId: "583231",
  login: "octocat",
  displayName: "The Octocat",
  avatarUrl: null
})

const hubot = new ForgeIdentity({
  forge: "github",
  forgeUserId: "704000",
  login: "hubot",
  displayName: "Hubot",
  avatarUrl: null
})

const identities: Record<string, ForgeIdentity> = { [OCTOCAT_CODE]: octocat, [HUBOT_CODE]: hubot }

const reachable = (installationExternalId: string, owner: string, name: string) =>
  new ReachableRepository({
    repository: new Repository({ forge: "github", owner, name }),
    isPrivate: false,
    installationExternalId
  })

const reachableByInstallation: Record<string, ReadonlyArray<ReachableRepository>> = {
  [OCTOCAT_INSTALLATION]: [reachable(OCTOCAT_INSTALLATION, "octocat", "ara")],
  [HUBOT_INSTALLATION]: [reachable(HUBOT_INSTALLATION, "hubot", "scripts")]
}

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

const RunsAndConnectionsApi = HttpApi.make("ara")
  .add(ConnectionsApiGroup)
  .add(RepoConnectionsApiGroup)
  .add(RunsApiGroup)

const DrivenLive = Layer.mergeAll(
  fakeGithub,
  fakeReachableRepositories,
  PgUserRepositoryLive,
  PgSessionStoreLive,
  PgInstallationRepositoryLive,
  PgRepoConnectionRepositoryLive,
  PgJobQueueLive,
  PgRunRepositoryLive,
  PgForgeCredentialStoreLive.pipe(Layer.provide(SecretCipher.Default))
)

/**
 * The worker's use case, merged into the layer the tests run over, so a test can
 * process the queue in-line. In the deployed process this same use case is what
 * the background fiber calls.
 */
const UnderTest = Layer.mergeAll(ConnectionsHandlersLive, RepoConnectionsHandlersLive, RunsHandlersLive).pipe(
  Layer.provideMerge(SessionAuthenticationLive),
  Layer.provideMerge(
    ProcessNextRun.Default.pipe(
      Layer.provide(Layer.mergeAll(collectDigestOver(busyRepoActivitySource), passableDraftStage))
    )
  ),
  Layer.provide(
    Layer.mergeAll(
      AuthenticateSession.Default,
      BeginGithubSignIn.Default,
      CompleteGithubSignIn.Default,
      ConnectRepository.Default,
      DescribeCurrentUser.Default,
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

const server = Layer.suspend(() =>
  HttpApiBuilder.serve(RequestLogger).pipe(
    Layer.provide(HttpApiBuilder.api(RunsAndConnectionsApi).pipe(Layer.provide(UnderTest))),
    Layer.provideMerge(
      ProcessNextRun.Default.pipe(
        Layer.provide(Layer.mergeAll(collectDigestOver(busyRepoActivitySource), passableDraftStage)),
        Layer.provide(PgJobQueueLive)
      )
    ),
    Layer.provideMerge(database()),
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provide(TestConfig)
  )
)

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

interface ConnectionBody {
  readonly id: string
}

interface RunBody {
  readonly id: string
  readonly state: string
  readonly owner: string
  readonly name: string
  readonly day: string
  readonly timeZone: string
  readonly windowStartsAt: string
  readonly windowEndsAt: string
  readonly attempts: number
  readonly failureReason: string | null
  readonly finishedAt: string | null
  readonly repoConnectionId: string | null
  readonly cost: {
    readonly inputTokens: number | null
    readonly outputTokens: number | null
    readonly reasoningTokens: number | null
    readonly totalTokens: number | null
    readonly costUsd: number | null
  } | null
}

const connect = (session: string | undefined, owner: string, name: string) =>
  Effect.flatMap(HttpClient.HttpClient, (http) =>
    HttpClientRequest.post("/v1/repo-connections").pipe(
      asSignedIn(session),
      HttpClientRequest.bodyUnsafeJson({ forge: "github", owner, name }),
      http.execute
    )
  ).pipe(Effect.flatMap((response) => response.json)) as Effect.Effect<ConnectionBody, never, HttpClient.HttpClient>

const requestRun = (session: string | undefined, connectionId: string, day: string) =>
  Effect.flatMap(HttpClient.HttpClient, (http) =>
    HttpClientRequest.post(`/v1/repo-connections/${connectionId}/runs`).pipe(
      asSignedIn(session),
      HttpClientRequest.bodyUnsafeJson({ day }),
      http.execute
    )
  )

const readRun = (session: string | undefined, id: string) =>
  Effect.flatMap(HttpClient.HttpClient, (http) =>
    HttpClientRequest.get(`/v1/runs/${id}`).pipe(asSignedIn(session), http.execute)
  )

const listRuns = (session: string | undefined) =>
  Effect.flatMap(HttpClient.HttpClient, (http) =>
    HttpClientRequest.get("/v1/runs").pipe(asSignedIn(session), http.execute)
  )

const setTimeZone = (session: string | undefined, timeZone: string) =>
  Effect.flatMap(HttpClient.HttpClient, (http) =>
    HttpClientRequest.patch("/v1/me").pipe(
      asSignedIn(session),
      HttpClientRequest.bodyUnsafeJson({ timeZone }),
      http.execute
    )
  )

/** Drain the queue the way the background fiber would, without being the background fiber. */
const workUntilEmpty = Effect.gen(function* () {
  const processNextRun = yield* ProcessNextRun

  let working = true
  while (working) {
    working = Option.isSome(yield* processNextRun.execute)
  }
})

/** Signed in, installed, with one repository connected. */
const readyToRun = Effect.gen(function* () {
  const session = yield* arrive(OCTOCAT_CODE, OCTOCAT_INSTALLATION)
  const connection = yield* connect(session, "octocat", "ara")
  return { session, connectionId: connection.id }
})

describe("Requesting a Run", () => {
  it.live("answers 202 with a queued Run, before any work has happened", () =>
    Effect.gen(function* () {
      const { connectionId, session } = yield* readyToRun

      const response = yield* requestRun(session, connectionId, "2026-08-22")

      assert.strictEqual(response.status, 202)
      const run = (yield* response.json) as RunBody
      assert.strictEqual(run.state, "queued")
      assert.strictEqual(run.owner, "octocat")
      assert.strictEqual(run.name, "ara")
      assert.strictEqual(run.day, "2026-08-22")
      assert.strictEqual(run.repoConnectionId, connectionId)
      assert.strictEqual(run.attempts, 0)
      assert.isNull(run.finishedAt)
    }).pipe(Effect.provide(server))
  )

  it.live("walks queued -> succeeded as the worker gets to it", () =>
    Effect.gen(function* () {
      const { connectionId, session } = yield* readyToRun

      const requested = (yield* Effect.flatMap(
        requestRun(session, connectionId, "2026-08-22"),
        (response) => response.json
      )) as RunBody

      const queued = (yield* Effect.flatMap(readRun(session, requested.id), (r) => r.json)) as RunBody
      assert.strictEqual(queued.state, "queued")

      yield* workUntilEmpty

      const finished = (yield* Effect.flatMap(readRun(session, requested.id), (r) => r.json)) as RunBody
      assert.strictEqual(finished.state, "succeeded")
      assert.strictEqual(finished.attempts, 1)
      assert.isNotNull(finished.finishedAt)
    }).pipe(Effect.provide(server))
  )

  it.live("tells the User what the Run cost, thinking included", () =>
    Effect.gen(function* () {
      const { connectionId, session } = yield* readyToRun

      const requested = (yield* Effect.flatMap(
        requestRun(session, connectionId, "2026-08-22"),
        (response) => response.json
      )) as RunBody

      // Nothing has been spent yet, and saying "zero" would be a claim rather
      // than an absence.
      assert.isNull(requested.cost)

      yield* workUntilEmpty

      const finished = (yield* Effect.flatMap(readRun(session, requested.id), (r) => r.json)) as RunBody

      // The scripted model's usage, all the way through: the port, the Draft,
      // the Run, and out over HTTP without anybody having to ask for a Draft id.
      assert.deepStrictEqual(finished.cost, {
        inputTokens: 1_200,
        outputTokens: 3_000,
        reasoningTokens: 2_700,
        totalTokens: 4_200,
        costUsd: 0.00822
      })
    }).pipe(Effect.provide(server))
  )

  it.live("returns the Run already in flight rather than paying for a second one", () =>
    Effect.gen(function* () {
      const { connectionId, session } = yield* readyToRun

      const first = (yield* Effect.flatMap(requestRun(session, connectionId, "2026-08-22"), (r) => r.json)) as RunBody
      const again = yield* requestRun(session, connectionId, "2026-08-22")

      assert.strictEqual(again.status, 202)
      assert.strictEqual(((yield* again.json) as RunBody).id, first.id)

      const runs = (yield* Effect.flatMap(listRuns(session), (r) => r.json)) as ReadonlyArray<RunBody>
      assert.lengthOf(runs, 1)
    }).pipe(Effect.provide(server))
  )

  it.live("lets the same day be asked for again once the first Run has finished", () =>
    Effect.gen(function* () {
      const { connectionId, session } = yield* readyToRun

      const first = (yield* Effect.flatMap(requestRun(session, connectionId, "2026-08-22"), (r) => r.json)) as RunBody
      yield* workUntilEmpty

      const second = (yield* Effect.flatMap(requestRun(session, connectionId, "2026-08-22"), (r) => r.json)) as RunBody
      assert.notStrictEqual(second.id, first.id)
    }).pipe(Effect.provide(server))
  )

  it.live("refuses a repository the caller has not connected", () =>
    Effect.gen(function* () {
      const { session } = yield* readyToRun

      const response = yield* requestRun(session, "00000000-0000-4000-8000-000000000000", "2026-08-22")
      assert.strictEqual(response.status, 404)
    }).pipe(Effect.provide(server))
  )

  it.live("refuses something that is not a calendar day", () =>
    Effect.gen(function* () {
      const { connectionId, session } = yield* readyToRun

      assert.strictEqual((yield* requestRun(session, connectionId, "2026-02-30")).status, 400)
      assert.strictEqual((yield* requestRun(session, connectionId, "yesterday")).status, 400)
    }).pipe(Effect.provide(server))
  )

  it.live("401s without a session", () =>
    Effect.gen(function* () {
      const { connectionId } = yield* readyToRun

      assert.strictEqual((yield* requestRun(undefined, connectionId, "2026-08-22")).status, 401)
      assert.strictEqual((yield* listRuns(undefined)).status, 401)
      assert.strictEqual((yield* readRun(undefined, "00000000-0000-4000-8000-000000000000")).status, 401)
    }).pipe(Effect.provide(server))
  )
})

describe("A Day Window is a calendar day where the User is", () => {
  it.live("spans the User's own day, not the UTC one", () =>
    Effect.gen(function* () {
      const { connectionId, session } = yield* readyToRun

      assert.strictEqual((yield* setTimeZone(session, "Pacific/Auckland")).status, 200)

      const run = (yield* Effect.flatMap(requestRun(session, connectionId, "2026-08-22"), (r) => r.json)) as RunBody

      assert.strictEqual(run.timeZone, "Pacific/Auckland")
      // The 22nd in Auckland begins while UTC is still on the 21st, and it is a
      // day rather than a rolling 24 hours from the moment of asking.
      assert.strictEqual(run.windowStartsAt, "2026-08-21T12:00:00.000Z")
      assert.strictEqual(run.windowEndsAt, "2026-08-22T12:00:00.000Z")
    }).pipe(Effect.provide(server))
  )

  it.live("is the same day for two Users in different places, and a different span", () =>
    Effect.gen(function* () {
      const { connectionId, session } = yield* readyToRun
      yield* setTimeZone(session, "Europe/Paris")

      const paris = (yield* Effect.flatMap(requestRun(session, connectionId, "2026-08-22"), (r) => r.json)) as RunBody

      assert.strictEqual(paris.day, "2026-08-22")
      assert.strictEqual(paris.windowStartsAt, "2026-08-21T22:00:00.000Z")
    }).pipe(Effect.provide(server))
  )

  it.live("refuses a timezone nobody lives in", () =>
    Effect.gen(function* () {
      const { session } = yield* readyToRun

      assert.strictEqual((yield* setTimeZone(session, "Mars/Olympus")).status, 400)
    }).pipe(Effect.provide(server))
  )
})

describe("A Run belongs to one User", () => {
  it.live("is invisible to everybody else", () =>
    Effect.gen(function* () {
      const { connectionId, session } = yield* readyToRun
      const run = (yield* Effect.flatMap(requestRun(session, connectionId, "2026-08-22"), (r) => r.json)) as RunBody

      const stranger = yield* arrive(HUBOT_CODE, HUBOT_INSTALLATION)

      const refused = yield* readRun(stranger, run.id)
      assert.strictEqual(refused.status, 404)

      // The same answer as an id nobody owns: the 404 confirmed nothing.
      const unknown = yield* readRun(stranger, "00000000-0000-4000-8000-000000000000")
      assert.strictEqual(unknown.status, 404)
      assert.deepStrictEqual(yield* refused.json, yield* unknown.json)

      assert.deepStrictEqual(yield* Effect.flatMap(listRuns(stranger), (r) => r.json), [])
    }).pipe(Effect.provide(server))
  )

  it.live("still names its repository after the Repo Connection is removed", () =>
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const { connectionId, session } = yield* readyToRun
      const run = (yield* Effect.flatMap(requestRun(session, connectionId, "2026-08-22"), (r) => r.json)) as RunBody
      yield* workUntilEmpty

      yield* HttpClientRequest.del(`/v1/repo-connections/${connectionId}`).pipe(asSignedIn(session), http.execute)

      const orphaned = (yield* Effect.flatMap(readRun(session, run.id), (r) => r.json)) as RunBody
      assert.strictEqual(orphaned.state, "succeeded")
      assert.strictEqual(orphaned.owner, "octocat")
      assert.strictEqual(orphaned.name, "ara")
      assert.isNull(orphaned.repoConnectionId)
    }).pipe(Effect.provide(server))
  )
})

describe("Listing Runs", () => {
  it.live("shows the caller's own, most recently requested first", () =>
    Effect.gen(function* () {
      const { connectionId, session } = yield* readyToRun

      const first = (yield* Effect.flatMap(requestRun(session, connectionId, "2026-08-21"), (r) => r.json)) as RunBody
      const second = (yield* Effect.flatMap(requestRun(session, connectionId, "2026-08-22"), (r) => r.json)) as RunBody

      const runs = (yield* Effect.flatMap(listRuns(session), (r) => r.json)) as ReadonlyArray<RunBody>
      assert.deepStrictEqual(
        runs.map((run) => run.id),
        [second.id, first.id]
      )
    }).pipe(Effect.provide(server))
  )
})

/**
 * The same API, over a Forge that will not let Ara in. Everything else is the
 * server above: real handlers, real use cases, one faked driven port.
 */
const serverThatCannotRead = Layer.suspend(() =>
  HttpApiBuilder.serve(RequestLogger).pipe(
    Layer.provide(HttpApiBuilder.api(RunsAndConnectionsApi).pipe(Layer.provide(UnderTest))),
    Layer.provideMerge(
      ProcessNextRun.Default.pipe(
        Layer.provide(Layer.mergeAll(collectDigestOver(unreachableRepoActivitySource), passableDraftStage)),
        Layer.provide(PgJobQueueLive)
      )
    ),
    Layer.provideMerge(database()),
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provide(TestConfig)
  )
)

describe("A Run that failed", () => {
  it.live("says what went wrong where the User can read it, rather than only in the logs", () =>
    Effect.gen(function* () {
      const { connectionId, session } = yield* readyToRun

      const requested = (yield* Effect.flatMap(
        requestRun(session, connectionId, "2026-08-22"),
        (response) => response.json
      )) as RunBody

      yield* workUntilEmpty

      const failed = (yield* Effect.flatMap(readRun(session, requested.id), (r) => r.json)) as RunBody

      assert.strictEqual(failed.state, "failed")
      assert.isNotNull(failed.finishedAt)
      // Something the User can act on — reconnect the repository — and not a stack trace.
      assert.include(failed.failureReason ?? "", "Ara can no longer reach octocat/ara")
      // Terminal, so it stopped at once rather than spending five attempts
      // discovering that revoked access is still revoked.
      assert.strictEqual(failed.attempts, 1)
    }).pipe(Effect.provide(serverThatCannotRead))
  )
})
