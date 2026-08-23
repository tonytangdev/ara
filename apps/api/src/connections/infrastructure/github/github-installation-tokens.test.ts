import { generateKeyPairSync } from "node:crypto"
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "@effect/platform"
import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Redacted, Ref } from "effect"
import { Installation } from "../../domain/installation.ts"
import { InstallationTokens } from "../../domain/ports/installation-tokens.ts"
import { GithubAppJwt } from "./github-app-jwt.ts"
import { GithubInstallationTokensLive } from "./github-installation-tokens.ts"

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
})

const TestConfig = Layer.setConfigProvider(
  ConfigProvider.fromMap(
    new Map([
      ["GITHUB_APP_ID", "12345"],
      ["GITHUB_APP_CLIENT_ID", "Iv1.test"],
      ["GITHUB_APP_CLIENT_SECRET", "client-secret"],
      ["GITHUB_APP_PRIVATE_KEY", privateKey]
    ])
  )
)

const installation = new Installation({ forge: "github", externalId: "42", accountLogin: "octocat" })

interface Minted {
  readonly token: string
  readonly expiresAt: string
}

/**
 * GitHub, reduced to the one endpoint that mints installation tokens, plus a
 * record of what it was asked. Every reply is scripted, so what is being tested
 * is when Ara goes back to GitHub — not what GitHub says.
 */
const githubMinting = (replies: ReadonlyArray<Minted>) =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<ReadonlyArray<HttpClientRequest.HttpClientRequest>>([])

    const client = HttpClient.make((request) =>
      Effect.gen(function* () {
        const sent = yield* Ref.updateAndGet(requests, (all) => [...all, request])
        const reply = replies[sent.length - 1]

        return HttpClientResponse.fromWeb(
          request,
          reply === undefined
            ? new Response("no", { status: 401 })
            : new Response(JSON.stringify({ token: reply.token, expires_at: reply.expiresAt }), {
                status: 201,
                headers: { "content-type": "application/json" }
              })
        )
      })
    )

    return { requests, layer: Layer.succeed(HttpClient.HttpClient, client) } as const
  })

const tokensOver = (client: Layer.Layer<HttpClient.HttpClient>) =>
  GithubInstallationTokensLive.pipe(
    Layer.provide(GithubAppJwt.Default),
    Layer.provide(client),
    Layer.provide(TestConfig)
  )

/** The test clock sits at the epoch, so expiries are written relative to it. */
const AN_HOUR_IN = "1970-01-01T01:00:00.000Z"
const A_MINUTE_IN = "1970-01-01T00:01:00.000Z"

describe("Installation tokens", () => {
  it.effect("mints one from the App's own credential", () =>
    Effect.gen(function* () {
      const github = yield* githubMinting([{ token: "ghs_first", expiresAt: AN_HOUR_IN }])

      const minted = yield* Effect.flatMap(InstallationTokens, (tokens) => tokens.tokenFor(installation)).pipe(
        Effect.provide(tokensOver(github.layer))
      )

      assert.strictEqual(Redacted.value(minted.token), "ghs_first")

      const [request] = yield* Ref.get(github.requests)
      assert.strictEqual(request?.method, "POST")
      assert.include(request?.url ?? "", "/app/installations/42/access_tokens")

      // A JWT signed with the App key, not a stored credential.
      const authorization = request?.headers.authorization ?? ""
      assert.match(authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/)
    })
  )

  it.effect("reuses a token that is still good rather than asking again", () =>
    Effect.gen(function* () {
      const github = yield* githubMinting([{ token: "ghs_first", expiresAt: AN_HOUR_IN }])

      // One layer, built once: the cache belongs to the adapter instance.
      const [first, second] = yield* Effect.gen(function* () {
        const source = yield* InstallationTokens
        return [yield* source.tokenFor(installation), yield* source.tokenFor(installation)] as const
      }).pipe(Effect.provide(tokensOver(github.layer)))

      assert.strictEqual(Redacted.value(second.token), Redacted.value(first.token))
      assert.lengthOf(yield* Ref.get(github.requests), 1)
    })
  )

  it.effect("mints a fresh one when the cached token is about to expire", () =>
    Effect.gen(function* () {
      const github = yield* githubMinting([
        { token: "ghs_nearly_done", expiresAt: A_MINUTE_IN },
        { token: "ghs_fresh", expiresAt: AN_HOUR_IN }
      ])

      const second = yield* Effect.gen(function* () {
        const source = yield* InstallationTokens
        yield* source.tokenFor(installation)
        return yield* source.tokenFor(installation)
      }).pipe(Effect.provide(tokensOver(github.layer)))

      assert.strictEqual(Redacted.value(second.token), "ghs_fresh")
      assert.lengthOf(yield* Ref.get(github.requests), 2)
    })
  )

  it.effect("reports a refusal as a Forge authorization failure", () =>
    Effect.gen(function* () {
      const github = yield* githubMinting([])

      const failure = yield* Effect.flatMap(InstallationTokens, (tokens) =>
        Effect.flip(tokens.tokenFor(installation))
      ).pipe(Effect.provide(tokensOver(github.layer)))

      assert.strictEqual(failure._tag, "ForgeAuthorizationFailed")
      assert.include(failure.reason, "installation 42")
    })
  )
})
