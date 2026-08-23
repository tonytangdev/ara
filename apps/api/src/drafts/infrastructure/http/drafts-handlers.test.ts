import { Cookies, HttpApi, HttpApiBuilder, HttpClient, HttpClientRequest } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { SqlClient } from "@effect/sql"
import { PgClient } from "@effect/sql-pg"
import { assert, describe, it } from "@effect/vitest"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { ConfigProvider, DateTime, Effect, Layer, Option, Redacted, Ref } from "effect"
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
import { DigestsApiGroup } from "../../../digests/api.ts"
import { DescribeDigest } from "../../../digests/application/describe-digest.ts"
import {
  CommitActivity,
  FileChange,
  PullRequestActivity,
  RepositoryActivity
} from "../../../digests/domain/activity.ts"
import { RepoActivitySource } from "../../../digests/domain/ports/repo-activity-source.ts"
import { DigestsHandlersLive } from "../../../digests/infrastructure/http/digests-handlers.ts"
import { PgDigestRepositoryLive } from "../../../digests/infrastructure/persistence/pg-digest-repository.ts"
import {
  collectDigestOver,
  emptyRepoActivitySource,
  repoActivitySourceOf
} from "../../../digests/testing/fake-repo-activity.ts"
import { RequestLogger } from "../../../http/logging.ts"
import { RunsApiGroup } from "../../../runs/api.ts"
import { DescribeRun } from "../../../runs/application/describe-run.ts"
import { ListRuns } from "../../../runs/application/list-runs.ts"
import { ProcessNextRun } from "../../../runs/application/process-next-run.ts"
import { RequestRun } from "../../../runs/application/request-run.ts"
import { RunsHandlersLive } from "../../../runs/infrastructure/http/runs-handlers.ts"
import { PgJobQueueLive } from "../../../runs/infrastructure/persistence/pg-job-queue.ts"
import { PgRunRepositoryLive } from "../../../runs/infrastructure/persistence/pg-run-repository.ts"
import { DraftsApiGroup } from "../../api.ts"
import { DescribeDraft } from "../../application/describe-draft.ts"
import { EditDraft } from "../../application/edit-draft.ts"
import { ListDrafts } from "../../application/list-drafts.ts"
import { RegenerateDraft } from "../../application/regenerate-draft.ts"
import { DraftUnavailable } from "../../domain/ports/draft-writer.ts"
import { PgDraftRepositoryLive } from "../../infrastructure/persistence/pg-draft-repository.ts"
import { draftWriterAnswering, type ScriptedAnswer, writeDraftOver } from "../../testing/fake-draft-writer.ts"
import { DraftsHandlersLive } from "./drafts-handlers.ts"

/**
 * What these tests drive: the whole feature, from asking for a Run to reading
 * the post Ara wrote — over HTTP, through real use cases, the real session
 * middleware, a real Postgres and both real stages of the pipeline. Only the
 * two driven adapters are faked: the Forge, and the model.
 *
 * No test here makes a real model call. Draft quality is not a unit test; what
 * these hold is that a Run produces a Draft its owner can read, that an empty
 * answer never becomes one, and that nobody else can see it.
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

const commit = (sha: string, subject: string, files: ReadonlyArray<FileChange>) =>
  new CommitActivity({
    sha,
    subject,
    committedAt: DateTime.unsafeMake("2026-08-22T10:00:00.000Z"),
    authorLogin: "octocat",
    authorIsBot: false,
    parentCount: 1,
    files
  })

/** A day with enough in it to carry a full Draft. */
const A_BUSY_DAY = {
  commits: [
    commit("aaa", "Add the collect stage", [file("src/digests/collect.ts", 80, 4)]),
    commit("bbb", "Test the collect stage", [file("src/digests/collect.test.ts", 120, 0)]),
    commit("ccc", "Write the Draft stage", [file("src/drafts/write-draft.ts", 90, 2)])
  ],
  pullRequests: [
    new PullRequestActivity({
      number: 6,
      title: "Build a Digest from real repository Activity",
      kind: "merged",
      authorLogin: "octocat",
      authorIsBot: false
    })
  ]
} as const

/** A day light enough for the Digest to call it a Quiet Day. */
const A_QUIET_DAY = {
  commits: [commit("ddd", "Fix a typo in the README", [file("README.md", 1, 1)])],
  pullRequests: []
} as const

/** The day the fixture reports as light, so a Quiet Day is reachable over HTTP. */
const QUIET_DAY = "2026-08-19"

const FIRST_DRAFT =
  "Spent the day finishing the collect stage and starting on the one that writes. " +
  "The split is holding up: reading a day out of GitHub and writing about it are now two " +
  "separate problems, and only one of them costs money."

const SECOND_DRAFT = "A different take on the same day."

/** What a model asked for a Quiet Draft comes back with: short, and not apologetic. */
const QUIET_DRAFT =
  "Light day. Fixed the day boundary so a Day Window means the day the User thinks it does, " +
  "and left it there. Small change, and it is the sort of thing that is annoying to find twice."

/** A day just under the threshold: one commit, eight lines. */
const A_LIGHT_DAY = {
  commits: [commit("ddd", "Fix the day boundary", [file("src/runs/day-window.ts", 6, 2)])],
  pullRequests: []
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
      ["AFTER_SIGN_IN_URL", "/v1/me"],
      // The backoff is real behaviour and is asserted on; waiting out the real
      // one would only be asserting that the clock works. Retrying is the Run's
      // job now (#12), so it is the Run's knob that is turned down.
      ["RUN_RETRY_BASE_DELAY", "1 millis"]
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
const forgeReportingDay = (day: {
  readonly commits: ReadonlyArray<CommitActivity>
  readonly pullRequests: ReadonlyArray<PullRequestActivity>
}) =>
  repoActivitySourceOf(
    ({ dayWindow, repository }) =>
      new RepositoryActivity({
        repository,
        dayWindow,
        commits: day.commits,
        pullRequests: day.pullRequests
      })
  )

/**
 * The default Forge: a busy day for every Day Window except one.
 *
 * A test that wants a light day asks for `QUIET_DAY` rather than rebuilding the
 * server, which is what lets the Draft list contain a Quiet Draft and a full one
 * side by side. A test about the Quiet Day path itself passes its own source in.
 */
const forgeReporting = repoActivitySourceOf(({ dayWindow, repository }) => {
  const day = dayWindow.day === QUIET_DAY ? A_QUIET_DAY : A_BUSY_DAY
  return new RepositoryActivity({
    repository,
    dayWindow,
    commits: day.commits,
    pullRequests: day.pullRequests
  })
})

const TestApi = HttpApi.make("ara")
  .add(ConnectionsApiGroup)
  .add(RepoConnectionsApiGroup)
  .add(RunsApiGroup)
  .add(DigestsApiGroup)
  .add(DraftsApiGroup)

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
  PgDraftRepositoryLive,
  PgForgeCredentialStoreLive.pipe(Layer.provide(SecretCipher.Default))
)

/** The whole application, with a model that answers from a script. */
const server = (answers: ReadonlyArray<ScriptedAnswer>, forge: Layer.Layer<RepoActivitySource> = forgeReporting) =>
  Layer.suspend(() => {
    const stages = Layer.mergeAll(
      collectDigestOver(forge),
      writeDraftOver(draftWriterAnswering(answers)).pipe(Layer.provide(TestConfig))
    )

    const UnderTest = Layer.mergeAll(
      ConnectionsHandlersLive,
      RepoConnectionsHandlersLive,
      RunsHandlersLive,
      DigestsHandlersLive,
      DraftsHandlersLive
    ).pipe(
      Layer.provideMerge(SessionAuthenticationLive),
      Layer.provideMerge(ProcessNextRun.Default.pipe(Layer.provide(stages))),
      Layer.provide(
        Layer.mergeAll(
          AuthenticateSession.Default,
          BeginGithubSignIn.Default,
          CompleteGithubSignIn.Default,
          ConnectRepository.Default,
          DescribeCurrentUser.Default,
          DescribeDigest.Default,
          DescribeDraft.Default,
          EditDraft.Default,
          DescribeRun.Default,
          DisconnectRepository.Default,
          ListReachableRepositories.Default,
          ListDrafts.Default,
          ListRepoConnections.Default,
          ListRuns.Default,
          RegenerateDraft.Default,
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
      Layer.provideMerge(ProcessNextRun.Default.pipe(Layer.provide(stages), Layer.provide(PgJobQueueLive))),
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

interface DraftBody {
  readonly id: string
  readonly runId: string
  readonly digestId: string
  readonly shape: string
  readonly body: string
  readonly editedBody: string | null
  readonly editedAt: string | null
  readonly model: string
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly reasoningTokens: number | null
  readonly totalTokens: number | null
  readonly costUsd: number | null
}

const post = (session: string | undefined, path: string, body: unknown) =>
  Effect.flatMap(HttpClient.HttpClient, (http) =>
    HttpClientRequest.post(path).pipe(asSignedIn(session), HttpClientRequest.bodyUnsafeJson(body), http.execute)
  )

const patch = (session: string | undefined, path: string, body: unknown) =>
  Effect.flatMap(HttpClient.HttpClient, (http) =>
    HttpClientRequest.patch(path).pipe(asSignedIn(session), HttpClientRequest.bodyUnsafeJson(body), http.execute)
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

/** Signed in, installed, one repository connected, one Run asked for. */
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

const draftsFor = (runId: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly count: string }>`select count(*)::text as count from drafts where run_id = ${runId}`
  )

describe("Reading the Draft a Run wrote", () => {
  it.live("takes a day of Activity all the way to a post the User can read", () =>
    Effect.gen(function* () {
      const { run, session } = yield* runFor("2026-08-22")
      yield* workUntilEmpty

      const finished = (yield* Effect.flatMap(get(session, `/v1/runs/${run.id}`), (r) => r.json)) as RunBody
      assert.strictEqual(finished.state, "succeeded")

      const response = yield* get(session, `/v1/runs/${run.id}/draft`)
      assert.strictEqual(response.status, 200)
      const draft = (yield* response.json) as DraftBody

      assert.strictEqual(draft.runId, run.id)
      assert.strictEqual(draft.body, FIRST_DRAFT)
      // A day over the threshold gets the full shape, and says which it got.
      assert.strictEqual(draft.shape, "full")

      // Which model wrote it and what it cost travel with the Draft, because
      // both are questions asked of it later.
      assert.strictEqual(draft.model, "fake/scripted")
      assert.strictEqual(draft.inputTokens, 1_200)
      assert.strictEqual(draft.outputTokens, 3_000)
      // Thinking, reported apart from the prose it led to: on a reasoning model
      // this is most of what was paid for.
      assert.strictEqual(draft.reasoningTokens, 2_700)
      assert.strictEqual(draft.totalTokens, 4_200)
      assert.strictEqual(draft.costUsd, 0.00822)

      // It points back at the Digest it was written from, which is what makes
      // "why did it write that?" answerable.
      const digest = (yield* Effect.flatMap(get(session, `/v1/runs/${run.id}/digest`), (r) => r.json)) as {
        readonly id: string
      }
      assert.strictEqual(draft.digestId, digest.id)
    }).pipe(Effect.provide(server([{ body: FIRST_DRAFT }])))
  )

  it.live("has nothing to show before the Run has been worked on", () =>
    Effect.gen(function* () {
      const { run, session } = yield* runFor("2026-08-22")

      assert.strictEqual((yield* get(session, `/v1/runs/${run.id}/draft`)).status, 404)
    }).pipe(Effect.provide(server([{ body: FIRST_DRAFT }])))
  )

  it.live("is invisible to everybody but its owner", () =>
    Effect.gen(function* () {
      const { run } = yield* runFor("2026-08-22")
      yield* workUntilEmpty

      const stranger = yield* arrive(HUBOT_CODE, HUBOT_INSTALLATION)

      const refused = yield* get(stranger, `/v1/runs/${run.id}/draft`)
      const unknown = yield* get(stranger, "/v1/runs/00000000-0000-4000-8000-000000000000/draft")

      assert.strictEqual(refused.status, 404)
      assert.strictEqual(unknown.status, 404)
      // The same answer either way: the 404 confirmed nothing.
      assert.deepStrictEqual(yield* refused.json, yield* unknown.json)

      assert.strictEqual((yield* get(undefined, `/v1/runs/${run.id}/draft`)).status, 401)
    }).pipe(Effect.provide(server([{ body: FIRST_DRAFT }])))
  )

  it.live("writes one Draft however many times the Run is claimed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const { run, session } = yield* runFor("2026-08-22")
      yield* workUntilEmpty

      // What a deploy interrupting a Run leaves behind, and what the next boot
      // hands back to the queue. Processing it again must not buy a second
      // model call or leave a second Draft.
      yield* sql`update runs set state = 'queued', finished_at = null where id = ${run.id}`
      yield* workUntilEmpty

      assert.strictEqual((yield* draftsFor(run.id))[0]?.count, "1")

      const draft = (yield* Effect.flatMap(get(session, `/v1/runs/${run.id}/draft`), (r) => r.json)) as DraftBody
      // The second answer in the script was never reached.
      assert.strictEqual(draft.body, FIRST_DRAFT)
    }).pipe(Effect.provide(server([{ body: FIRST_DRAFT }, { body: SECOND_DRAFT }])))
  )
})

/**
 * The rule from the prototype, at the seam a User actually walks.
 *
 * A model that answers with reasoning and no message content has not failed on
 * the wire. The whole risk is that the pipeline treats that as a Draft, and
 * these are the tests that say it does not.
 */
describe("A model that answers with nothing", () => {
  it.live("fails the Run rather than storing an empty Draft", () =>
    Effect.gen(function* () {
      const { run, session } = yield* runFor("2026-08-22")
      yield* workUntilEmpty

      const failed = (yield* Effect.flatMap(get(session, `/v1/runs/${run.id}`), (r) => r.json)) as RunBody
      assert.strictEqual(failed.state, "failed")
      assert.isNotNull(failed.failureReason)

      assert.strictEqual((yield* get(session, `/v1/runs/${run.id}/draft`)).status, 404)
      assert.strictEqual((yield* draftsFor(run.id))[0]?.count, "0")

      // The Digest survives: the expensive half of the Run was already done and
      // the Draft stage is what failed (ADR-0002).
      assert.strictEqual((yield* get(session, `/v1/runs/${run.id}/digest`)).status, 200)
    }).pipe(Effect.provide(server([{ body: "" }])))
  )

  it.live("tries again, and keeps the post it eventually gets", () =>
    Effect.gen(function* () {
      const { run, session } = yield* runFor("2026-08-22")
      yield* workUntilEmpty

      const finished = (yield* Effect.flatMap(get(session, `/v1/runs/${run.id}`), (r) => r.json)) as RunBody
      assert.strictEqual(finished.state, "succeeded")

      const draft = (yield* Effect.flatMap(get(session, `/v1/runs/${run.id}/draft`), (r) => r.json)) as DraftBody
      assert.strictEqual(draft.body, FIRST_DRAFT)
      assert.strictEqual((yield* draftsFor(run.id))[0]?.count, "1")
      // Whitespace is no more content than nothing at all.
    }).pipe(Effect.provide(server([{ body: "" }, { body: "   " }, { body: FIRST_DRAFT }])))
  )

  it.live("stops immediately when trying again cannot help", () =>
    Effect.gen(function* () {
      const { run, session } = yield* runFor("2026-08-22")
      yield* workUntilEmpty

      const failed = (yield* Effect.flatMap(get(session, `/v1/runs/${run.id}`), (r) => r.json)) as RunBody
      assert.strictEqual(failed.state, "failed")
      assert.include(failed.failureReason ?? "", "refused the key")
      assert.strictEqual((yield* draftsFor(run.id))[0]?.count, "0")
    }).pipe(
      Effect.provide(
        server([
          { fails: new DraftUnavailable({ reason: "The provider refused the key.", retryable: false }) },
          { body: FIRST_DRAFT }
        ])
      )
    )
  )
})

interface DraftSummaryBody {
  readonly id: string
  readonly runId: string
  readonly digestId: string
  readonly forge: string
  readonly owner: string
  readonly name: string
  readonly day: string
  readonly timeZone: string
  readonly isQuiet: boolean
  readonly isEdited: boolean
  readonly model: string
  readonly generatedAt: string
}

interface DraftPageBody {
  readonly items: ReadonlyArray<DraftSummaryBody>
  readonly nextCursor: string | null
}

/** Signed in, one repository connected, and a Run asked for and worked for each day given. */
const draftsAcross = (days: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const session = yield* arrive(OCTOCAT_CODE, OCTOCAT_INSTALLATION)
    const connection = (yield* Effect.flatMap(
      post(session, "/v1/repo-connections", { forge: "github", owner: "octocat", name: "ara" }),
      (response) => response.json
    )) as { readonly id: string }

    const runs: Array<RunBody> = []
    for (const day of days) {
      runs.push(
        (yield* Effect.flatMap(
          post(session, `/v1/repo-connections/${connection.id}/runs`, { day }),
          (response) => response.json
        )) as RunBody
      )
      // Worked one at a time, so the Drafts are generated in the order the days
      // were asked for and "newest first" is a claim with a known answer.
      yield* workUntilEmpty
    }

    return { session, runs }
  })

const listDrafts = (session: string | undefined, query = "") =>
  Effect.flatMap(get(session, `/v1/drafts${query}`), (response) => response.json) as Effect.Effect<
    DraftPageBody,
    never,
    HttpClient.HttpClient
  >

/**
 * The point at which Ara stops being useful only inside a single Run: everything
 * the User has accumulated, in one place, without needing to have kept a Run id.
 */
describe("Listing the Drafts a User has accumulated", () => {
  it.live("hands them back newest first, with enough to tell them apart", () =>
    Effect.gen(function* () {
      const { session } = yield* draftsAcross([QUIET_DAY, "2026-08-20", "2026-08-21"])

      const page = yield* listDrafts(session)

      assert.deepStrictEqual(
        page.items.map((draft) => draft.day),
        ["2026-08-21", "2026-08-20", QUIET_DAY]
      )
      assert.isNull(page.nextCursor)

      // Which repository, which Day Window, and whether it is a Quiet Draft:
      // the three things you choose between entries on.
      const [newest] = page.items
      assert.strictEqual(newest?.forge, "github")
      assert.strictEqual(newest?.owner, "octocat")
      assert.strictEqual(newest?.name, "ara")
      assert.strictEqual(newest?.timeZone, "UTC")
      assert.strictEqual(newest?.isQuiet, false)

      // The light day is marked as one, so a Quiet Draft is recognisable
      // without opening it.
      assert.strictEqual(page.items[2]?.isQuiet, true)
    }).pipe(Effect.provide(server([{ body: FIRST_DRAFT }, { body: SECOND_DRAFT }, { body: FIRST_DRAFT }])))
  )

  it.live("hands back one page at a time, and says where the next one starts", () =>
    Effect.gen(function* () {
      const { session } = yield* draftsAcross(["2026-08-20", "2026-08-21", "2026-08-22"])

      const first = yield* listDrafts(session, "?limit=2")
      assert.strictEqual(first.items.length, 2)
      assert.isNotNull(first.nextCursor)

      const second = yield* listDrafts(session, `?limit=2&after=${encodeURIComponent(first.nextCursor ?? "")}`)
      assert.strictEqual(second.items.length, 1)
      // The last page says so, rather than leaving a cursor that returns nothing.
      assert.isNull(second.nextCursor)

      assert.deepStrictEqual(
        [...first.items, ...second.items].map((draft) => draft.day),
        ["2026-08-22", "2026-08-21", "2026-08-20"]
      )
    }).pipe(Effect.provide(server([{ body: FIRST_DRAFT }, { body: SECOND_DRAFT }, { body: FIRST_DRAFT }])))
  )

  it.live("refuses a page size or a cursor it did not hand out", () =>
    Effect.gen(function* () {
      const { session } = yield* draftsAcross(["2026-08-20"])

      // The ceiling is the reason this endpoint is safe to call after a year of
      // daily Runs, so asking past it is a bad request rather than a big answer.
      assert.strictEqual((yield* get(session, "/v1/drafts?limit=500")).status, 400)
      assert.strictEqual((yield* get(session, "/v1/drafts?limit=0")).status, 400)
      assert.strictEqual((yield* get(session, "/v1/drafts?after=not-a-cursor")).status, 400)
    }).pipe(Effect.provide(server([{ body: FIRST_DRAFT }])))
  )

  it.live("shows a User only their own, and nothing about anybody else's", () =>
    Effect.gen(function* () {
      yield* draftsAcross(["2026-08-20"])

      const stranger = yield* arrive(HUBOT_CODE, HUBOT_INSTALLATION)
      const theirs = yield* listDrafts(stranger)

      assert.deepStrictEqual(theirs.items, [])
      assert.isNull(theirs.nextCursor)

      assert.strictEqual((yield* get(undefined, "/v1/drafts")).status, 401)
    }).pipe(Effect.provide(server([{ body: FIRST_DRAFT }])))
  )
})

describe("Opening one Draft by its own id", () => {
  it.live("reads it in full, body and all", () =>
    Effect.gen(function* () {
      const { runs, session } = yield* draftsAcross(["2026-08-20"])

      const listed = (yield* listDrafts(session)).items[0]
      assert.isDefined(listed)

      const response = yield* get(session, `/v1/drafts/${listed?.id}`)
      assert.strictEqual(response.status, 200)
      const draft = (yield* response.json) as DraftBody

      assert.strictEqual(draft.id, listed?.id)
      assert.strictEqual(draft.runId, runs[0]?.id)
      assert.strictEqual(draft.body, FIRST_DRAFT)
      assert.strictEqual(draft.model, "fake/scripted")
    }).pipe(Effect.provide(server([{ body: FIRST_DRAFT }])))
  )

  it.live("is invisible to everybody but its owner", () =>
    Effect.gen(function* () {
      const { session } = yield* draftsAcross(["2026-08-20"])
      const listed = (yield* listDrafts(session)).items[0]

      const stranger = yield* arrive(HUBOT_CODE, HUBOT_INSTALLATION)

      const refused = yield* get(stranger, `/v1/drafts/${listed?.id}`)
      const unknown = yield* get(stranger, "/v1/drafts/00000000-0000-4000-8000-000000000000")

      assert.strictEqual(refused.status, 404)
      assert.strictEqual(unknown.status, 404)
      // The same answer either way: the 404 confirmed nothing.
      assert.deepStrictEqual(yield* refused.json, yield* unknown.json)

      assert.strictEqual((yield* get(undefined, `/v1/drafts/${listed?.id}`)).status, 401)
    }).pipe(Effect.provide(server([{ body: FIRST_DRAFT }])))
  )
})

const MY_OWN_WORDS =
  "Spent the day on the boundary between collecting a day and writing about it. " +
  "Worth it: the expensive half now runs once."

/**
 * The point of the whole product is that the Draft is a starting point, not a
 * verdict. What these hold is that a User's own words stick, that they are kept
 * beside the generated prose rather than on top of it — which is what stops
 * regeneration (#11) silently destroying work a human put in — and that an
 * edited Draft can be told apart from an untouched one without opening it.
 */
describe("Editing a Draft", () => {
  it.live("keeps the User's words, and reads them back", () =>
    Effect.gen(function* () {
      const { session } = yield* draftsAcross(["2026-08-20"])
      const listed = (yield* listDrafts(session)).items[0]

      const response = yield* patch(session, `/v1/drafts/${listed?.id}`, { body: MY_OWN_WORDS })
      assert.strictEqual(response.status, 200)
      const edited = (yield* response.json) as DraftBody

      assert.strictEqual(edited.editedBody, MY_OWN_WORDS)
      assert.isNotNull(edited.editedAt)

      // And it is still there on the next read, from a fresh request.
      const reread = (yield* Effect.flatMap(get(session, `/v1/drafts/${listed?.id}`), (r) => r.json)) as DraftBody
      assert.strictEqual(reread.editedBody, MY_OWN_WORDS)
      assert.strictEqual(reread.editedAt, edited.editedAt)
    }).pipe(Effect.provide(server([{ body: FIRST_DRAFT }])))
  )

  it.live("keeps what the model wrote, separately", () =>
    Effect.gen(function* () {
      const { runs, session } = yield* draftsAcross(["2026-08-20"])
      const listed = (yield* listDrafts(session)).items[0]

      yield* patch(session, `/v1/drafts/${listed?.id}`, { body: MY_OWN_WORDS })

      const edited = (yield* Effect.flatMap(get(session, `/v1/drafts/${listed?.id}`), (r) => r.json)) as DraftBody
      // The generated prose survives the edit. #11 needs it to compare against,
      // and nothing can learn what a User always changes once it is gone.
      assert.strictEqual(edited.body, FIRST_DRAFT)
      assert.strictEqual(edited.editedBody, MY_OWN_WORDS)

      // Editing rewrites the prose and nothing else: the Draft is still the one
      // that Run wrote, from that Digest, with that model.
      assert.strictEqual(edited.runId, runs[0]?.id)
      assert.strictEqual(edited.model, "fake/scripted")
      assert.strictEqual((yield* draftsFor(runs[0]?.id ?? ""))[0]?.count, "1")

      // The Draft the Run points at is the edited one, not a second copy.
      const throughTheRun = (yield* Effect.flatMap(
        get(session, `/v1/runs/${runs[0]?.id}/draft`),
        (r) => r.json
      )) as DraftBody
      assert.strictEqual(throughTheRun.editedBody, MY_OWN_WORDS)
    }).pipe(Effect.provide(server([{ body: FIRST_DRAFT }])))
  )

  it.live("leaves the Digest it was written from exactly as it was", () =>
    Effect.gen(function* () {
      const { runs, session } = yield* draftsAcross(["2026-08-20"])
      const listed = (yield* listDrafts(session)).items[0]

      const before = yield* Effect.flatMap(get(session, `/v1/runs/${runs[0]?.id}/digest`), (r) => r.json)

      yield* patch(session, `/v1/drafts/${listed?.id}`, { body: MY_OWN_WORDS })

      // A Digest is the record of what happened that day. Rewriting the post
      // does not rewrite the day.
      const after = yield* Effect.flatMap(get(session, `/v1/runs/${runs[0]?.id}/digest`), (r) => r.json)
      assert.deepStrictEqual(after, before)
    }).pipe(Effect.provide(server([{ body: FIRST_DRAFT }])))
  )

  it.live("marks it as edited, in the list and in full", () =>
    Effect.gen(function* () {
      const { session } = yield* draftsAcross(["2026-08-20", "2026-08-21"])
      const [newest, older] = (yield* listDrafts(session)).items

      assert.strictEqual(newest?.isEdited, false)

      yield* patch(session, `/v1/drafts/${newest?.id}`, { body: MY_OWN_WORDS })

      const page = yield* listDrafts(session)
      assert.strictEqual(page.items[0]?.id, newest?.id)
      assert.strictEqual(page.items[0]?.isEdited, true)
      // The one nobody touched is unchanged, so the mark means something.
      assert.strictEqual(page.items[1]?.id, older?.id)
      assert.strictEqual(page.items[1]?.isEdited, false)

      const untouched = (yield* Effect.flatMap(get(session, `/v1/drafts/${older?.id}`), (r) => r.json)) as DraftBody
      assert.isNull(untouched.editedBody)
      assert.isNull(untouched.editedAt)
    }).pipe(Effect.provide(server([{ body: FIRST_DRAFT }, { body: SECOND_DRAFT }])))
  )

  it.live("takes the latest edit and forgets the one before it", () =>
    Effect.gen(function* () {
      const { session } = yield* draftsAcross(["2026-08-20"])
      const listed = (yield* listDrafts(session)).items[0]

      yield* patch(session, `/v1/drafts/${listed?.id}`, { body: "A first pass at rewriting it." })
      yield* patch(session, `/v1/drafts/${listed?.id}`, { body: MY_OWN_WORDS })

      const edited = (yield* Effect.flatMap(get(session, `/v1/drafts/${listed?.id}`), (r) => r.json)) as DraftBody
      assert.strictEqual(edited.editedBody, MY_OWN_WORDS)
      assert.strictEqual(edited.body, FIRST_DRAFT)
    }).pipe(Effect.provide(server([{ body: FIRST_DRAFT }])))
  )

  it.live("refuses an edit that leaves nothing to post", () =>
    Effect.gen(function* () {
      const { session } = yield* draftsAcross(["2026-08-20"])
      const listed = (yield* listDrafts(session)).items[0]

      assert.strictEqual((yield* patch(session, `/v1/drafts/${listed?.id}`, { body: "" })).status, 400)
      assert.strictEqual((yield* patch(session, `/v1/drafts/${listed?.id}`, { body: "   " })).status, 400)
      assert.strictEqual((yield* patch(session, `/v1/drafts/${listed?.id}`, {})).status, 400)

      // Nothing was written: the Draft is exactly as the model left it.
      const draft = (yield* Effect.flatMap(get(session, `/v1/drafts/${listed?.id}`), (r) => r.json)) as DraftBody
      assert.strictEqual(draft.body, FIRST_DRAFT)
      assert.isNull(draft.editedBody)
    }).pipe(Effect.provide(server([{ body: FIRST_DRAFT }])))
  )

  it.live("cannot be reached by anybody but its owner", () =>
    Effect.gen(function* () {
      const { session } = yield* draftsAcross(["2026-08-20"])
      const listed = (yield* listDrafts(session)).items[0]

      const stranger = yield* arrive(HUBOT_CODE, HUBOT_INSTALLATION)

      const refused = yield* patch(stranger, `/v1/drafts/${listed?.id}`, { body: MY_OWN_WORDS })
      const unknown = yield* patch(stranger, "/v1/drafts/00000000-0000-4000-8000-000000000000", {
        body: MY_OWN_WORDS
      })

      assert.strictEqual(refused.status, 404)
      assert.strictEqual(unknown.status, 404)
      // The same answer either way: the 404 confirmed nothing.
      assert.deepStrictEqual(yield* refused.json, yield* unknown.json)

      assert.strictEqual((yield* patch(undefined, `/v1/drafts/${listed?.id}`, { body: MY_OWN_WORDS })).status, 401)

      // And the owner's Draft was left alone.
      const mine = (yield* Effect.flatMap(get(session, `/v1/drafts/${listed?.id}`), (r) => r.json)) as DraftBody
      assert.isNull(mine.editedBody)
      assert.strictEqual(mine.body, FIRST_DRAFT)
    }).pipe(Effect.provide(server([{ body: FIRST_DRAFT }])))
  )
})

/**
 * The Quiet Day, at the seam a User actually walks.
 *
 * The threshold is decided in `BuildDigest` and tested there at the boundary.
 * What these hold is everything downstream of that decision: that a light day
 * ends as a Quiet Day rather than a failure, that the Quiet Draft it produced is
 * identifiable as one when it is read back, and that a day with nothing in it
 * never reaches the model at all.
 */
describe("A quiet day", () => {
  it.live("writes a Quiet Draft, and says that is what it is", () =>
    Effect.gen(function* () {
      const { run, session } = yield* runFor("2026-08-22")
      yield* workUntilEmpty

      // Quiet is a successful outcome and not a failure: the Run did its job.
      const finished = (yield* Effect.flatMap(get(session, `/v1/runs/${run.id}`), (r) => r.json)) as RunBody
      assert.strictEqual(finished.state, "quiet")
      assert.isNull(finished.failureReason)

      const draft = (yield* Effect.flatMap(get(session, `/v1/runs/${run.id}/draft`), (r) => r.json)) as DraftBody
      assert.strictEqual(draft.body, QUIET_DRAFT)
      // Read back, a Quiet Draft is one without anybody having to guess from
      // its length.
      assert.strictEqual(draft.shape, "quiet")

      // And the Digest beside it says why it was one.
      const digest = (yield* Effect.flatMap(get(session, `/v1/runs/${run.id}/digest`), (r) => r.json)) as {
        readonly isQuiet: boolean
        readonly commitCount: number
      }
      assert.isTrue(digest.isQuiet)
      assert.strictEqual(digest.commitCount, 1)
    }).pipe(Effect.provide(server([{ body: QUIET_DRAFT }], forgeReportingDay(A_LIGHT_DAY))))
  )

  it.live("ends a day with no Activity at all cleanly, and invents nothing", () =>
    Effect.gen(function* () {
      const { run, session } = yield* runFor("2026-08-22")
      yield* workUntilEmpty

      // A clear answer rather than an error, and rather than a post about a day
      // that did not happen.
      const finished = (yield* Effect.flatMap(get(session, `/v1/runs/${run.id}`), (r) => r.json)) as RunBody
      assert.strictEqual(finished.state, "quiet")
      assert.isNull(finished.failureReason)

      // The model had prose ready and was never asked for it: there is nothing
      // to write from, so nothing was written.
      assert.strictEqual((yield* draftsFor(run.id))[0]?.count, "0")
      assert.strictEqual((yield* get(session, `/v1/runs/${run.id}/draft`)).status, 404)

      // The Digest still exists and says, factually, that the day was empty.
      const digest = (yield* Effect.flatMap(get(session, `/v1/runs/${run.id}/digest`), (r) => r.json)) as {
        readonly isQuiet: boolean
        readonly commitCount: number
        readonly commits: ReadonlyArray<unknown>
      }
      assert.isTrue(digest.isQuiet)
      assert.strictEqual(digest.commitCount, 0)
      assert.deepStrictEqual([...digest.commits], [])
    }).pipe(Effect.provide(server([{ body: FIRST_DRAFT }], emptyRepoActivitySource)))
  )
})

/**
 * A Forge that answers one day's Activity and is a hole in the floor after that.
 *
 * This is what makes "regeneration makes no Forge calls" a test rather than a
 * claim. A second read does not return an empty day or a polite failure — it is
 * a defect, which fails the Run it happens in and, through the assertions
 * below, the test. Nothing has to remember to count calls.
 */
const forgeAnsweringOnce = Layer.effect(
  RepoActivitySource,
  Effect.map(Ref.make(0), (calls) =>
    RepoActivitySource.of({
      activityFor: ({ dayWindow, repository }) =>
        Effect.flatMap(
          Ref.updateAndGet(calls, (made) => made + 1),
          (made) =>
            made > 1
              ? Effect.dieMessage("regeneration read the Forge")
              : Effect.succeed(
                  new RepositoryActivity({
                    repository,
                    dayWindow,
                    commits: A_BUSY_DAY.commits,
                    pullRequests: A_BUSY_DAY.pullRequests
                  })
                )
        )
    })
  )
)

const regenerate = (session: string | undefined, draftId: string, body: unknown = {}) =>
  post(session, `/v1/drafts/${draftId}/regenerate`, body)

/** The Draft a Run wrote, once the queue has been drained. */
const draftOfRun = (session: string | undefined, runId: string) =>
  Effect.flatMap(get(session, `/v1/runs/${runId}/draft`), (response) => response.json) as Effect.Effect<
    DraftBody,
    never,
    HttpClient.HttpClient
  >

/**
 * The payoff of ADR-0002, at the seam a User actually walks.
 *
 * A User who does not like a Draft asks for another one and pays for one model
 * call and nothing else, because the expensive half of the Run — the read of
 * the Forge — is already sitting in a Digest. These are the tests that hold
 * that promise to the letter, and that hold the two things regeneration must
 * not cost: somebody else's Drafts, and a User's own words.
 */
describe("Regenerating a Draft from its Digest", () => {
  it.live("writes a new one from the stored Digest, and touches no Forge doing it", () =>
    Effect.gen(function* () {
      const { run, session } = yield* runFor("2026-08-22")
      yield* workUntilEmpty

      const first = yield* draftOfRun(session, run.id)
      assert.strictEqual(first.body, FIRST_DRAFT)

      const response = yield* regenerate(session, first.id)
      // 202 and a Run: the model has not been called yet.
      assert.strictEqual(response.status, 202)
      const again = (yield* response.json) as RunBody & { readonly sourceDigestId: string | null }

      // A Run of its own, pointed at the Digest the first one collected.
      assert.notStrictEqual(again.id, run.id)
      assert.strictEqual(again.sourceDigestId, first.digestId)

      yield* workUntilEmpty

      const finished = (yield* Effect.flatMap(get(session, `/v1/runs/${again.id}`), (r) => r.json)) as RunBody
      assert.strictEqual(finished.state, "succeeded")

      // The new version, readable through the Run that wrote it.
      const second = yield* draftOfRun(session, again.id)
      assert.strictEqual(second.body, SECOND_DRAFT)
      assert.notStrictEqual(second.id, first.id)
      // Written from the same Digest: the day was never read again, and the
      // second post is about the same day as the first.
      assert.strictEqual(second.digestId, first.digestId)
    }).pipe(Effect.provide(server([{ body: FIRST_DRAFT }, { body: SECOND_DRAFT }], forgeAnsweringOnce)))
  )

  it.live("keeps the Draft it was asked to replace", () =>
    Effect.gen(function* () {
      const { run, session } = yield* runFor("2026-08-22")
      yield* workUntilEmpty
      const first = yield* draftOfRun(session, run.id)

      yield* regenerate(session, first.id)
      yield* workUntilEmpty

      // Still there, in full, and still the Draft its own Run points at: a User
      // who preferred the first take can go back to it (user story 20).
      const kept = (yield* Effect.flatMap(get(session, `/v1/drafts/${first.id}`), (r) => r.json)) as DraftBody
      assert.strictEqual(kept.body, FIRST_DRAFT)
      assert.strictEqual((yield* draftOfRun(session, run.id)).body, FIRST_DRAFT)

      // And both are in the list, newest first.
      const page = yield* listDrafts(session)
      assert.strictEqual(page.items.length, 2)
      assert.isTrue(page.items.some((draft) => draft.id === first.id))
    }).pipe(Effect.provide(server([{ body: FIRST_DRAFT }, { body: SECOND_DRAFT }], forgeAnsweringOnce)))
  )

  it.live("costs one model call however many times the button is clicked", () =>
    Effect.gen(function* () {
      const { run, session } = yield* runFor("2026-08-22")
      yield* workUntilEmpty
      const first = yield* draftOfRun(session, run.id)

      const once = (yield* Effect.flatMap(regenerate(session, first.id), (r) => r.json)) as RunBody
      const twice = (yield* Effect.flatMap(regenerate(session, first.id), (r) => r.json)) as RunBody

      // The second ask is answered with the Run already in flight, exactly as
      // asking twice for the same day is (user story 11).
      assert.strictEqual(twice.id, once.id)

      yield* workUntilEmpty
      assert.strictEqual((yield* listDrafts(session)).items.length, 2)
    }).pipe(Effect.provide(server([{ body: FIRST_DRAFT }, { body: SECOND_DRAFT }], forgeAnsweringOnce)))
  )

  it.live("obeys the null-content rule, and retries on the Run's own policy", () =>
    Effect.gen(function* () {
      const { run, session } = yield* runFor("2026-08-22")
      yield* workUntilEmpty
      const first = yield* draftOfRun(session, run.id)

      const again = (yield* Effect.flatMap(regenerate(session, first.id), (r) => r.json)) as RunBody
      yield* workUntilEmpty

      // The model answered with nothing, which is not prose and never becomes a
      // Draft. The Run tried again — one policy, the Run's — and kept what it
      // got the second time.
      const finished = (yield* Effect.flatMap(get(session, `/v1/runs/${again.id}`), (r) => r.json)) as RunBody
      assert.strictEqual(finished.state, "succeeded")
      assert.strictEqual((yield* draftsFor(again.id))[0]?.count, "1")
      assert.strictEqual((yield* draftOfRun(session, again.id)).body, SECOND_DRAFT)
    }).pipe(Effect.provide(server([{ body: FIRST_DRAFT }, { body: "" }, { body: SECOND_DRAFT }], forgeAnsweringOnce)))
  )

  it.live("will not write past a User's own words unless they say so", () =>
    Effect.gen(function* () {
      const { run, session } = yield* runFor("2026-08-22")
      yield* workUntilEmpty
      const first = yield* draftOfRun(session, run.id)

      yield* patch(session, `/v1/drafts/${first.id}`, { body: MY_OWN_WORDS })

      const refused = yield* regenerate(session, first.id)
      // Not a bad request: repeating it with the confirmation is exactly what
      // the client should do next.
      assert.strictEqual(refused.status, 409)

      // Nothing was enqueued and nothing was spent: the Run list is as it was.
      const runs = (yield* Effect.flatMap(get(session, "/v1/runs"), (r) => r.json)) as ReadonlyArray<RunBody>
      assert.strictEqual(runs.length, 1)

      const confirmed = yield* regenerate(session, first.id, { discardEdit: true })
      assert.strictEqual(confirmed.status, 202)
      yield* workUntilEmpty

      const again = (yield* confirmed.json) as RunBody
      assert.strictEqual((yield* draftOfRun(session, again.id)).body, SECOND_DRAFT)

      // Even confirmed, the edit is not destroyed. What the User agreed to was
      // a new Draft taking its place, not their afternoon being deleted.
      const edited = (yield* Effect.flatMap(get(session, `/v1/drafts/${first.id}`), (r) => r.json)) as DraftBody
      assert.strictEqual(edited.editedBody, MY_OWN_WORDS)
      assert.strictEqual(edited.body, FIRST_DRAFT)
    }).pipe(Effect.provide(server([{ body: FIRST_DRAFT }, { body: SECOND_DRAFT }], forgeAnsweringOnce)))
  )

  it.live("cannot be asked for by anybody but the Draft's owner", () =>
    Effect.gen(function* () {
      const { run, session } = yield* runFor("2026-08-22")
      yield* workUntilEmpty
      const first = yield* draftOfRun(session, run.id)

      const stranger = yield* arrive(HUBOT_CODE, HUBOT_INSTALLATION)

      const refused = yield* regenerate(stranger, first.id)
      const unknown = yield* regenerate(stranger, "00000000-0000-4000-8000-000000000000")

      assert.strictEqual(refused.status, 404)
      assert.strictEqual(unknown.status, 404)
      // The same answer either way: the 404 confirmed nothing.
      assert.deepStrictEqual(yield* refused.json, yield* unknown.json)

      assert.strictEqual((yield* regenerate(undefined, first.id)).status, 401)

      // And nothing was queued on the owner's behalf, or spent in their name.
      yield* workUntilEmpty
      assert.strictEqual((yield* listDrafts(session)).items.length, 1)
      assert.strictEqual((yield* draftOfRun(session, run.id)).body, FIRST_DRAFT)
    }).pipe(Effect.provide(server([{ body: FIRST_DRAFT }, { body: SECOND_DRAFT }], forgeAnsweringOnce)))
  )
})
