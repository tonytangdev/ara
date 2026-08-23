import { Cookies, HttpApi, HttpApiBuilder, HttpClient, HttpClientRequest } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { SqlClient } from "@effect/sql"
import { PgClient } from "@effect/sql-pg"
import { assert, describe, it } from "@effect/vitest"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { ConfigProvider, Effect, Layer, Logger, Option, Redacted } from "effect"
import { afterAll, beforeAll } from "vitest"
import { MigrationsLive } from "../../../database/index.ts"
import { RequestLogger } from "../../../http/logging.ts"
import { ConnectionsApiGroup, SESSION_COOKIE, SIGN_IN_STATE_COOKIE } from "../../api.ts"
import { AuthenticateSession } from "../../application/authenticate-session.ts"
import { BeginGithubSignIn } from "../../application/begin-github-sign-in.ts"
import { CompleteGithubSignIn } from "../../application/complete-github-sign-in.ts"
import { DescribeCurrentUser } from "../../application/describe-current-user.ts"
import { RecordGithubInstallation } from "../../application/record-github-installation.ts"
import { Installation } from "../../domain/installation.ts"
import { ForgeAuthorizationFailed, GithubAuthorization } from "../../domain/ports/github-authorization.ts"
import { ForgeIdentity } from "../../domain/user.ts"
import { SecretCipher } from "../crypto/secret-cipher.ts"
import { PgForgeCredentialStoreLive } from "../persistence/pg-forge-credential-store.ts"
import { PgInstallationRepositoryLive } from "../persistence/pg-installation-repository.ts"
import { PgSessionStoreLive } from "../persistence/pg-session-store.ts"
import { PgUserRepositoryLive } from "../persistence/pg-user-repository.ts"
import { ConnectionsHandlersLive } from "./connections-handlers.ts"
import { SessionAuthenticationLive } from "./session-authentication.ts"

/**
 * These tests run on the live clock (`it.live`) rather than the test one: a
 * session's expiry is compared against Postgres's `now()`, and a `TestClock`
 * sitting at the epoch would issue sessions that expired in 1970.
 */

/** The secrets this test watches: neither may ever appear in a log line. */
const GITHUB_ACCESS_TOKEN = "ghu_the-user-access-token"
const SIGN_IN_CODE = "a-good-code"
const SIGN_IN_STATE = "state-from-github"

const octocat = new ForgeIdentity({
  forge: "github",
  forgeUserId: "583231",
  login: "octocat",
  displayName: "The Octocat",
  avatarUrl: "https://github.com/images/octocat.png"
})

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

/**
 * GitHub, faked at the port the ADRs put it behind. Everything below it is the
 * real thing: real use cases, real Postgres, real encryption, real cookies.
 */
const fakeGithub = Layer.succeed(
  GithubAuthorization,
  GithubAuthorization.of({
    beginSignIn: Effect.succeed({
      url: `https://github.com/login/oauth/authorize?client_id=test&state=${SIGN_IN_STATE}`,
      state: SIGN_IN_STATE
    }),
    completeSignIn: (code) =>
      code === SIGN_IN_CODE
        ? Effect.succeed({
            identity: octocat,
            credential: {
              forge: "github" as const,
              accessToken: Redacted.make(GITHUB_ACCESS_TOKEN),
              refreshToken: Option.none(),
              accessTokenExpiresAt: Option.none()
            }
          })
        : Effect.fail(new ForgeAuthorizationFailed({ reason: "GitHub refused the sign-in code" })),
    describeInstallation: (externalId) =>
      Effect.succeed(new Installation({ forge: "github", externalId, accountLogin: "octocat" }))
  })
)

/** Only this module's group, so the test needs nothing from the other modules. */
const ConnectionsOnlyApi = HttpApi.make("ara").add(ConnectionsApiGroup)

const ConnectionsUnderTest = ConnectionsHandlersLive.pipe(
  Layer.provideMerge(SessionAuthenticationLive),
  Layer.provide(
    Layer.mergeAll(
      AuthenticateSession.Default,
      BeginGithubSignIn.Default,
      CompleteGithubSignIn.Default,
      DescribeCurrentUser.Default,
      RecordGithubInstallation.Default
    )
  ),
  Layer.provide(
    Layer.mergeAll(
      fakeGithub,
      PgUserRepositoryLive,
      PgSessionStoreLive,
      PgInstallationRepositoryLive,
      PgForgeCredentialStoreLive.pipe(Layer.provide(SecretCipher.Default))
    )
  )
)

const logLines: Array<string> = []

const CapturingLogger = Logger.replace(
  Logger.defaultLogger,
  Logger.map(Logger.logfmtLogger, (line) => {
    logLines.push(line)
  })
)

const server = Layer.suspend(() =>
  HttpApiBuilder.serve(RequestLogger).pipe(
    Layer.provide(HttpApiBuilder.api(ConnectionsOnlyApi).pipe(Layer.provide(ConnectionsUnderTest))),
    Layer.provideMerge(database()),
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provide(CapturingLogger),
    Layer.provide(TestConfig)
  )
)

/** Walks the sign-in the way a browser does: out to GitHub, back with a state. */
const signIn = (code = SIGN_IN_CODE) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient

    const started = yield* http.get("/v1/auth/github")
    const state = Cookies.toRecord(started.cookies)[SIGN_IN_STATE_COOKIE]

    const returned = yield* HttpClientRequest.get("/v1/auth/github/callback").pipe(
      HttpClientRequest.setUrlParams({ code, state: state ?? "" }),
      HttpClientRequest.setHeader("cookie", Cookies.toCookieHeader(started.cookies)),
      http.execute
    )

    return { started, returned, session: Cookies.toRecord(returned.cookies)[SESSION_COOKIE] }
  })

const asSignedIn = (session: string | undefined) =>
  HttpClientRequest.setHeader("cookie", `${SESSION_COOKIE}=${session ?? ""}`)

describe("Signing in with GitHub", () => {
  it.live("sends the person to GitHub, holding the state to check on their return", () =>
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const response = yield* http.get("/v1/auth/github")

      assert.strictEqual(response.status, 302)
      assert.include(response.headers.location ?? "", "github.com/login/oauth/authorize")
      assert.strictEqual(Cookies.toRecord(response.cookies)[SIGN_IN_STATE_COOKIE], SIGN_IN_STATE)
    }).pipe(Effect.provide(server))
  )

  it.live("ends with a session, and GET /v1/me says who that is", () =>
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const { returned, session } = yield* signIn()

      assert.strictEqual(returned.status, 302)
      assert.strictEqual(returned.headers.location, "/v1/me")
      assert.isDefined(session)

      const me = yield* HttpClientRequest.get("/v1/me").pipe(asSignedIn(session), http.execute)
      assert.strictEqual(me.status, 200)

      const body = yield* me.json
      assert.deepInclude(body, { forge: "github", login: "octocat", displayName: "The Octocat" })
    }).pipe(Effect.provide(server))
  )

  it.live("creates a User on the first sign-in and resolves to the same one after that", () =>
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient

      const first = yield* signIn()
      const second = yield* signIn()

      assert.notStrictEqual(first.session, second.session, "each sign-in gets its own session")

      const identities = yield* Effect.all(
        [first, second].map((signedIn) =>
          HttpClientRequest.get("/v1/me").pipe(
            asSignedIn(signedIn.session),
            http.execute,
            Effect.flatMap((response) => response.json)
          )
        )
      )

      const [me, meAgain] = identities as ReadonlyArray<{ readonly id: string }>
      assert.isString(me?.id)
      assert.strictEqual(me?.id, meAgain?.id)
    }).pipe(Effect.provide(server))
  )

  it.live("refuses a callback whose state did not come from us", () =>
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient

      const response = yield* HttpClientRequest.get("/v1/auth/github/callback").pipe(
        HttpClientRequest.setUrlParams({ code: SIGN_IN_CODE, state: "state-someone-else-chose" }),
        HttpClientRequest.setHeader("cookie", `${SIGN_IN_STATE_COOKIE}=${SIGN_IN_STATE}`),
        http.execute
      )

      assert.strictEqual(response.status, 400)
      assert.isUndefined(Cookies.toRecord(response.cookies)[SESSION_COOKIE])
    }).pipe(Effect.provide(server))
  )

  it.live("refuses a code GitHub will not honour", () =>
    Effect.gen(function* () {
      const { returned } = yield* signIn("a-spent-code")

      assert.strictEqual(returned.status, 400)
      assert.deepInclude(yield* returned.json, { reason: "GitHub refused the sign-in code" })
    }).pipe(Effect.provide(server))
  )
})

describe("GET /v1/me", () => {
  it.live("401s without a session", () =>
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const response = yield* http.get("/v1/me")

      assert.strictEqual(response.status, 401)
    }).pipe(Effect.provide(server))
  )

  it.live("401s on a token that is not a session", () =>
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const response = yield* HttpClientRequest.get("/v1/me").pipe(asSignedIn("not-a-real-token"), http.execute)

      assert.strictEqual(response.status, 401)
    }).pipe(Effect.provide(server))
  )

  it.live("treats a signed-in person with no App installation as a complete answer", () =>
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const { session } = yield* signIn()

      const me = yield* HttpClientRequest.get("/v1/me").pipe(asSignedIn(session), http.execute)

      assert.strictEqual(me.status, 200)
      assert.deepInclude(yield* me.json, { installations: [] })
    }).pipe(Effect.provide(server))
  )

  it.live("lists an installation once the person has completed one", () =>
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const { session } = yield* signIn()

      const installed = yield* HttpClientRequest.get("/v1/auth/github/installation").pipe(
        HttpClientRequest.setUrlParams({ installation_id: "42" }),
        asSignedIn(session),
        http.execute
      )
      assert.strictEqual(installed.status, 302)

      const me = yield* HttpClientRequest.get("/v1/me").pipe(asSignedIn(session), http.execute)
      assert.deepInclude(yield* me.json, {
        installations: [{ forge: "github", id: "42", accountLogin: "octocat" }]
      })
    }).pipe(Effect.provide(server))
  )

  it.live("401s on the installation callback when nobody is signed in", () =>
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      const response = yield* HttpClientRequest.get("/v1/auth/github/installation").pipe(
        HttpClientRequest.setUrlParams({ installation_id: "42" }),
        http.execute
      )

      assert.strictEqual(response.status, 401)
    }).pipe(Effect.provide(server))
  )
})

describe("What sign-in leaves behind", () => {
  it.live("stores the Forge credential encrypted, and the session only as a digest", () =>
    Effect.gen(function* () {
      const { session } = yield* signIn()
      const sql = yield* SqlClient.SqlClient

      const credentials = yield* sql<{ readonly encrypted_access_token: string }>`
        select encrypted_access_token from forge_credentials
      `
      const stored = credentials[0]?.encrypted_access_token ?? ""
      assert.notInclude(stored, GITHUB_ACCESS_TOKEN)
      assert.match(stored, /^v1\./)

      const cipher = yield* SecretCipher
      assert.strictEqual(Redacted.value(yield* cipher.decrypt(stored)), GITHUB_ACCESS_TOKEN)

      const sessions = yield* sql<{ readonly token_digest: string }>`select token_digest from sessions`
      for (const row of sessions) {
        assert.notStrictEqual(row.token_digest, session)
      }
    }).pipe(Effect.provide(Layer.mergeAll(server, SecretCipher.Default.pipe(Layer.provide(TestConfig)))))
  )

  it.live("writes no secret to a log line", () =>
    Effect.gen(function* () {
      logLines.length = 0

      const http = yield* HttpClient.HttpClient
      const { session } = yield* signIn()
      yield* HttpClientRequest.get("/v1/me").pipe(asSignedIn(session), http.execute)

      assert.isDefined(session)
      assert.isNotEmpty(logLines, "the flow should log something, or this proves nothing")
      for (const line of logLines) {
        assert.notInclude(line, GITHUB_ACCESS_TOKEN)
        assert.notInclude(line, session ?? "")
        // The URL GitHub sends someone back on carries a single-use code.
        assert.notInclude(line, SIGN_IN_CODE)
        assert.notInclude(line, SIGN_IN_STATE)
      }
    }).pipe(Effect.provide(server))
  )
})
