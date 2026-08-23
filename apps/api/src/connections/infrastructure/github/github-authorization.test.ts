import { generateKeyPairSync } from "node:crypto"
import { HttpClient, HttpClientResponse } from "@effect/platform"
import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Option, Redacted } from "effect"
import { GithubAuthorization } from "../../domain/ports/github-authorization.ts"
import { GithubAppJwt } from "./github-app-jwt.ts"
import { GithubAuthorizationLive } from "./github-authorization.ts"

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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

/** GitHub, answering by path. */
const github = (routes: Record<string, Response>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const path = new URL(request.url).pathname
      const reply = routes[path]
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, reply?.clone() ?? new Response("not found", { status: 404 }))
      )
    })
  )

const authorizationOver = (client: Layer.Layer<HttpClient.HttpClient>) =>
  GithubAuthorizationLive.pipe(Layer.provide(GithubAppJwt.Default), Layer.provide(client), Layer.provide(TestConfig))

describe("Authorizing against GitHub", () => {
  it.effect("sends a person to GitHub with a state of its own choosing", () =>
    Effect.gen(function* () {
      const authorization = yield* GithubAuthorization
      const first = yield* authorization.beginSignIn
      const second = yield* authorization.beginSignIn

      const url = new URL(first.url)
      assert.strictEqual(url.host, "github.com")
      assert.strictEqual(url.pathname, "/login/oauth/authorize")
      assert.strictEqual(url.searchParams.get("client_id"), "Iv1.test")
      assert.strictEqual(url.searchParams.get("state"), first.state)
      assert.notStrictEqual(first.state, second.state)
    }).pipe(Effect.provide(authorizationOver(github({}))))
  )

  it.effect("trades a code for who signed in and what we may hold", () =>
    Effect.gen(function* () {
      const authorization = yield* GithubAuthorization
      const { credential, identity } = yield* authorization.completeSignIn("a-good-code")

      assert.strictEqual(identity.forge, "github")
      assert.strictEqual(identity.forgeUserId, "583231")
      assert.strictEqual(identity.login, "octocat")
      assert.strictEqual(identity.displayName, "The Octocat")
      assert.strictEqual(Redacted.value(credential.accessToken), "ghu_token")
      assert.isTrue(Option.isSome(credential.refreshToken))
      assert.isTrue(Option.isSome(credential.accessTokenExpiresAt))
    }).pipe(
      Effect.provide(
        authorizationOver(
          github({
            "/login/oauth/access_token": json({
              access_token: "ghu_token",
              refresh_token: "ghr_token",
              expires_in: 28800
            }),
            "/user": json({
              id: 583231,
              login: "octocat",
              name: "The Octocat",
              avatar_url: "https://github.com/images/octocat.png"
            })
          })
        )
      )
    )
  )

  it.effect("treats GitHub's 200-with-an-error as the refusal it is", () =>
    Effect.gen(function* () {
      const authorization = yield* GithubAuthorization
      const failure = yield* Effect.flip(authorization.completeSignIn("a-spent-code"))

      assert.strictEqual(failure._tag, "ForgeAuthorizationFailed")
      assert.strictEqual(failure.reason, "The code passed is incorrect or expired.")
    }).pipe(
      Effect.provide(
        authorizationOver(
          github({
            "/login/oauth/access_token": json({
              error: "bad_verification_code",
              error_description: "The code passed is incorrect or expired."
            })
          })
        )
      )
    )
  )

  it.effect("asks GitHub what was installed rather than trusting the caller", () =>
    Effect.gen(function* () {
      const authorization = yield* GithubAuthorization
      const installation = yield* authorization.describeInstallation("42")

      assert.strictEqual(installation.forge, "github")
      assert.strictEqual(installation.externalId, "42")
      assert.strictEqual(installation.accountLogin, "octocat")
    }).pipe(
      Effect.provide(
        authorizationOver(github({ "/app/installations/42": json({ id: 42, account: { login: "octocat" } }) }))
      )
    )
  )

  it.effect("fails an installation GitHub does not recognise", () =>
    Effect.gen(function* () {
      const authorization = yield* GithubAuthorization
      const failure = yield* Effect.flip(authorization.describeInstallation("99"))

      assert.include(failure.reason, "installation 99")
    }).pipe(Effect.provide(authorizationOver(github({}))))
  )
})
