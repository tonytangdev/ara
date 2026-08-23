import { Cookies, HttpApi, HttpApiBuilder, HttpClient, HttpClientRequest } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { SqlClient } from "@effect/sql"
import { PgClient } from "@effect/sql-pg"
import { assert, describe, it } from "@effect/vitest"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { ConfigProvider, Effect, Layer, Option, Redacted } from "effect"
import { afterAll, beforeAll, beforeEach } from "vitest"
import { MigrationsLive } from "../../../database/index.ts"
import { RequestLogger } from "../../../http/logging.ts"
import { ConnectionsApiGroup, RepoConnectionsApiGroup, SESSION_COOKIE, SIGN_IN_STATE_COOKIE } from "../../api.ts"
import { AuthenticateSession } from "../../application/authenticate-session.ts"
import { BeginGithubSignIn } from "../../application/begin-github-sign-in.ts"
import { CompleteGithubSignIn } from "../../application/complete-github-sign-in.ts"
import { ConnectRepository } from "../../application/connect-repository.ts"
import { DescribeCurrentUser } from "../../application/describe-current-user.ts"
import { DisconnectRepository } from "../../application/disconnect-repository.ts"
import { ListReachableRepositories } from "../../application/list-reachable-repositories.ts"
import { ListRepoConnections } from "../../application/list-repo-connections.ts"
import { RecordGithubInstallation } from "../../application/record-github-installation.ts"
import { Installation } from "../../domain/installation.ts"
import { ForgeAuthorizationFailed, GithubAuthorization } from "../../domain/ports/github-authorization.ts"
import { ReachableRepositories } from "../../domain/ports/reachable-repositories.ts"
import { ReachableRepository, Repository } from "../../domain/repository.ts"
import { ForgeIdentity } from "../../domain/user.ts"
import { SecretCipher } from "../crypto/secret-cipher.ts"
import { PgForgeCredentialStoreLive } from "../persistence/pg-forge-credential-store.ts"
import { PgInstallationRepositoryLive } from "../persistence/pg-installation-repository.ts"
import { PgRepoConnectionRepositoryLive } from "../persistence/pg-repo-connection-repository.ts"
import { PgSessionStoreLive } from "../persistence/pg-session-store.ts"
import { PgUserRepositoryLive } from "../persistence/pg-user-repository.ts"
import { ConnectionsHandlersLive } from "./connections-handlers.ts"
import { RepoConnectionsHandlersLive } from "./repo-connections-handlers.ts"
import { SessionAuthenticationLive } from "./session-authentication.ts"

/**
 * These tests drive the feature the way a browser does — sign in, install,
 * connect, list, delete — over real use cases, real Postgres and the real
 * session middleware. Only GitHub is faked, at the two ports the ADRs put it
 * behind, so nothing here knows how a Repo Connection is stored.
 *
 * They run on the live clock (`it.live`) because session expiry is compared
 * against Postgres's `now()`.
 */

const OCTOCAT_CODE = "octocat-code"
const HUBOT_CODE = "hubot-code"

/** Whose installation reaches what. Chosen so no repository is reachable by both. */
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

const reachable = (installationExternalId: string, owner: string, name: string, isPrivate: boolean) =>
  new ReachableRepository({
    repository: new Repository({ forge: "github", owner, name }),
    isPrivate,
    installationExternalId
  })

const reachableByInstallation: Record<string, ReadonlyArray<ReachableRepository>> = {
  [OCTOCAT_INSTALLATION]: [
    reachable(OCTOCAT_INSTALLATION, "octocat", "Hello-World", false),
    reachable(OCTOCAT_INSTALLATION, "octocat", "secret-lab", true)
  ],
  [HUBOT_INSTALLATION]: [reachable(HUBOT_INSTALLATION, "hubot", "scripts", false)]
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

/**
 * GitHub's installation screen, faked: an installation reaches exactly what the
 * person picked there, and nothing else (ADR-0005).
 */
const fakeReachableRepositories = Layer.succeed(
  ReachableRepositories,
  ReachableRepositories.of({
    listFor: (installation) => Effect.succeed(reachableByInstallation[installation.externalId] ?? [])
  })
)

const ConnectionsOnlyApi = HttpApi.make("ara").add(ConnectionsApiGroup).add(RepoConnectionsApiGroup)

const ConnectionsUnderTest = Layer.mergeAll(ConnectionsHandlersLive, RepoConnectionsHandlersLive).pipe(
  Layer.provideMerge(SessionAuthenticationLive),
  Layer.provide(
    Layer.mergeAll(
      AuthenticateSession.Default,
      BeginGithubSignIn.Default,
      CompleteGithubSignIn.Default,
      ConnectRepository.Default,
      DescribeCurrentUser.Default,
      DisconnectRepository.Default,
      ListReachableRepositories.Default,
      ListRepoConnections.Default,
      RecordGithubInstallation.Default
    )
  ),
  Layer.provide(
    Layer.mergeAll(
      fakeGithub,
      fakeReachableRepositories,
      PgUserRepositoryLive,
      PgSessionStoreLive,
      PgInstallationRepositoryLive,
      PgRepoConnectionRepositoryLive,
      PgForgeCredentialStoreLive.pipe(Layer.provide(SecretCipher.Default))
    )
  )
)

const server = Layer.suspend(() =>
  HttpApiBuilder.serve(RequestLogger).pipe(
    Layer.provide(HttpApiBuilder.api(ConnectionsOnlyApi).pipe(Layer.provide(ConnectionsUnderTest))),
    Layer.provideMerge(database()),
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provide(TestConfig)
  )
)

/**
 * One container, many tests: each one starts from an empty schema so that a
 * User signing in as the same person twice is not carrying the previous test's
 * connections. Truncating `users` cascades to everything the module writes,
 * which is itself worth knowing.
 */
beforeEach(async () => {
  await Effect.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql`truncate users cascade`).pipe(Effect.provide(database()))
  )
})

const asSignedIn = (session: string | undefined) =>
  HttpClientRequest.setHeader("cookie", `${SESSION_COOKIE}=${session ?? ""}`)

/** Signs someone in and, unless told otherwise, installs the App for them. */
const arrive = (code: string, installationId: string | undefined) =>
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

    if (installationId !== undefined) {
      yield* HttpClientRequest.get("/v1/auth/github/installation").pipe(
        HttpClientRequest.setUrlParams({ installation_id: installationId }),
        asSignedIn(session),
        http.execute
      )
    }

    return session
  })

const asOctocat = () => arrive(OCTOCAT_CODE, OCTOCAT_INSTALLATION)
const asHubot = () => arrive(HUBOT_CODE, HUBOT_INSTALLATION)

const connect = (session: string | undefined, owner: string, name: string) =>
  Effect.flatMap(HttpClient.HttpClient, (http) =>
    HttpClientRequest.post("/v1/repo-connections").pipe(
      asSignedIn(session),
      HttpClientRequest.bodyUnsafeJson({ forge: "github", owner, name }),
      http.execute
    )
  )

const listConnections = (session: string | undefined) =>
  Effect.flatMap(HttpClient.HttpClient, (http) =>
    HttpClientRequest.get("/v1/repo-connections").pipe(asSignedIn(session), http.execute)
  )

const disconnect = (session: string | undefined, id: string) =>
  Effect.flatMap(HttpClient.HttpClient, (http) =>
    HttpClientRequest.del(`/v1/repo-connections/${id}`).pipe(asSignedIn(session), http.execute)
  )

interface ConnectionBody {
  readonly id: string
  readonly forge: string
  readonly owner: string
  readonly name: string
  readonly installationId: string
  readonly connectedAt: string
}

describe("GET /v1/repositories", () => {
  it.live("lists what the installation can reach, private repositories included", () =>
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const session = yield* asOctocat()

      const response = yield* HttpClientRequest.get("/v1/repositories").pipe(asSignedIn(session), http.execute)

      assert.strictEqual(response.status, 200)
      assert.deepStrictEqual(yield* response.json, [
        {
          forge: "github",
          owner: "octocat",
          name: "Hello-World",
          isPrivate: false,
          installationId: OCTOCAT_INSTALLATION
        },
        {
          forge: "github",
          owner: "octocat",
          name: "secret-lab",
          isPrivate: true,
          installationId: OCTOCAT_INSTALLATION
        }
      ])
    }).pipe(Effect.provide(server))
  )

  it.live("answers with an empty list for someone who has installed the App nowhere", () =>
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const session = yield* arrive(OCTOCAT_CODE, undefined)

      const response = yield* HttpClientRequest.get("/v1/repositories").pipe(asSignedIn(session), http.execute)

      assert.strictEqual(response.status, 200)
      assert.deepStrictEqual(yield* response.json, [])
    }).pipe(Effect.provide(server))
  )

  it.live("401s without a session", () =>
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      assert.strictEqual((yield* http.get("/v1/repositories")).status, 401)
    }).pipe(Effect.provide(server))
  )
})

describe("Connecting a repository", () => {
  it.live("connects a reachable repository and lists it back", () =>
    Effect.gen(function* () {
      const session = yield* asOctocat()

      const created = yield* connect(session, "octocat", "Hello-World")
      assert.strictEqual(created.status, 201)

      const connection = (yield* created.json) as ConnectionBody
      assert.deepInclude(connection, {
        forge: "github",
        owner: "octocat",
        name: "Hello-World",
        installationId: OCTOCAT_INSTALLATION
      })
      assert.isString(connection.id)
      assert.isString(connection.connectedAt)

      const listed = yield* listConnections(session)
      assert.strictEqual(listed.status, 200)
      assert.deepStrictEqual(yield* listed.json, [connection])
    }).pipe(Effect.provide(server))
  )

  it.live("connecting the same repository again is the same connection, whatever the casing", () =>
    Effect.gen(function* () {
      const session = yield* asOctocat()

      const first = (yield* Effect.flatMap(connect(session, "octocat", "Hello-World"), (r) => r.json)) as ConnectionBody
      const again = (yield* Effect.flatMap(connect(session, "OctoCat", "hello-world"), (r) => r.json)) as ConnectionBody

      assert.strictEqual(again.id, first.id)
      // The Forge's own spelling wins, not whatever the caller typed.
      assert.strictEqual(again.name, "Hello-World")

      const connections = (yield* Effect.flatMap(listConnections(session), (r) => r.json)) as ReadonlyArray<unknown>
      assert.lengthOf(connections, 1)
    }).pipe(Effect.provide(server))
  )

  it.live("refuses a repository the installation cannot reach, and says what to do", () =>
    Effect.gen(function* () {
      const session = yield* asOctocat()

      const response = yield* connect(session, "octocat", "not-installed-on-this-one")

      assert.strictEqual(response.status, 422)
      const body = (yield* response.json) as { readonly reason: string }
      assert.include(body.reason, "octocat/not-installed-on-this-one")
      assert.include(body.reason, "installation")

      assert.deepStrictEqual(yield* Effect.flatMap(listConnections(session), (r) => r.json), [])
    }).pipe(Effect.provide(server))
  )

  it.live("refuses a repository only somebody else's installation can reach", () =>
    Effect.gen(function* () {
      yield* asOctocat()
      const session = yield* asHubot()

      const response = yield* connect(session, "octocat", "Hello-World")

      assert.strictEqual(response.status, 422)
    }).pipe(Effect.provide(server))
  )

  it.live("refuses when the person has installed the App nowhere", () =>
    Effect.gen(function* () {
      const session = yield* arrive(OCTOCAT_CODE, undefined)

      const response = yield* connect(session, "octocat", "Hello-World")

      assert.strictEqual(response.status, 422)
      const body = (yield* response.json) as { readonly reason: string }
      assert.include(body.reason, "not installed")
    }).pipe(Effect.provide(server))
  )

  it.live("401s without a session", () =>
    Effect.gen(function* () {
      assert.strictEqual((yield* connect(undefined, "octocat", "Hello-World")).status, 401)
      assert.strictEqual((yield* listConnections(undefined)).status, 401)
    }).pipe(Effect.provide(server))
  )
})

describe("A Repo Connection belongs to one User", () => {
  it.live("is invisible to everybody else, and cannot be deleted by them", () =>
    Effect.gen(function* () {
      const owner = yield* asOctocat()
      const stranger = yield* asHubot()

      const connection = (yield* Effect.flatMap(
        connect(owner, "octocat", "secret-lab"),
        (r) => r.json
      )) as ConnectionBody

      assert.deepStrictEqual(yield* Effect.flatMap(listConnections(stranger), (r) => r.json), [])

      const refused = yield* disconnect(stranger, connection.id)
      assert.strictEqual(refused.status, 404)

      // The same answer as an id nobody owns: the 404 confirmed nothing.
      const unknown = yield* disconnect(stranger, "00000000-0000-4000-8000-000000000000")
      assert.strictEqual(unknown.status, 404)
      assert.deepStrictEqual(yield* refused.json, yield* unknown.json)

      // And the refusal really was a refusal.
      const stillThere = (yield* Effect.flatMap(listConnections(owner), (r) => r.json)) as ReadonlyArray<ConnectionBody>
      assert.deepStrictEqual(
        stillThere.map((found) => found.id),
        [connection.id]
      )
    }).pipe(Effect.provide(server))
  )
})

describe("Disconnecting a repository", () => {
  it.live("removes it, and removing it twice is a 404 the second time", () =>
    Effect.gen(function* () {
      const session = yield* asOctocat()
      const connection = (yield* Effect.flatMap(
        connect(session, "octocat", "Hello-World"),
        (r) => r.json
      )) as ConnectionBody

      const deleted = yield* disconnect(session, connection.id)
      assert.strictEqual(deleted.status, 204)

      assert.deepStrictEqual(yield* Effect.flatMap(listConnections(session), (r) => r.json), [])
      assert.strictEqual((yield* disconnect(session, connection.id)).status, 404)
    }).pipe(Effect.provide(server))
  )

  it.live("lets the repository be connected again afterwards", () =>
    Effect.gen(function* () {
      const session = yield* asOctocat()
      const connection = (yield* Effect.flatMap(
        connect(session, "octocat", "Hello-World"),
        (r) => r.json
      )) as ConnectionBody

      yield* disconnect(session, connection.id)

      const reconnected = yield* connect(session, "octocat", "Hello-World")
      assert.strictEqual(reconnected.status, 201)
      assert.notStrictEqual(((yield* reconnected.json) as ConnectionBody).id, connection.id)
    }).pipe(Effect.provide(server))
  )

  it.live("401s without a session", () =>
    Effect.gen(function* () {
      const response = yield* disconnect(undefined, "00000000-0000-4000-8000-000000000000")
      assert.strictEqual(response.status, 401)
    }).pipe(Effect.provide(server))
  )
})
