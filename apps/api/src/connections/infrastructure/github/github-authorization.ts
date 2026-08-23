import { randomBytes } from "node:crypto"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform"
import { DateTime, Effect, Layer, Option, Redacted, Schema } from "effect"
import { GithubAppConfig } from "../../../config.ts"
import type { ForgeCredential } from "../../domain/forge-credential.ts"
import { Installation } from "../../domain/installation.ts"
import { ForgeAuthorizationFailed, GithubAuthorization } from "../../domain/ports/github-authorization.ts"
import { ForgeIdentity } from "../../domain/user.ts"
import { GithubAppJwt } from "./github-app-jwt.ts"

const STATE_BYTES = 32

/**
 * GitHub answers a bad code with `200 OK` and an `error` field, so the shape
 * has to be parsed before it can be trusted.
 */
const AccessTokenResponse = Schema.Struct({
  access_token: Schema.optional(Schema.String),
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String)
})

const GithubUser = Schema.Struct({
  id: Schema.Number,
  login: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  avatar_url: Schema.optional(Schema.NullOr(Schema.String))
})

const GithubInstallation = Schema.Struct({
  id: Schema.Number,
  account: Schema.optional(Schema.NullOr(Schema.Struct({ login: Schema.String })))
})

/**
 * Driven (outbound) adapter authorizing against GitHub as a GitHub App
 * (ADR-0005). Deliberately not behind `RepoActivitySource`: this is the
 * Forge-specific half that GitLab will not share (ADR-0003).
 *
 * The user access token it returns is scoped to what the App is installed on,
 * not to everything the person can see, and nothing it logs contains one.
 */
export const GithubAuthorizationLive = Layer.effect(
  GithubAuthorization,
  Effect.gen(function* () {
    const { apiBaseUrl, clientId, clientSecret, webBaseUrl } = yield* GithubAppConfig
    const client = yield* HttpClient.HttpClient
    const appJwt = yield* GithubAppJwt

    /** Anything unexpected from GitHub becomes one shaped, credential-free failure. */
    const failed = (reason: string) => new ForgeAuthorizationFailed({ reason })

    const beginSignIn = Effect.sync(() => {
      const state = randomBytes(STATE_BYTES).toString("base64url")
      const url = new URL("/login/oauth/authorize", webBaseUrl)
      url.searchParams.set("client_id", clientId)
      url.searchParams.set("state", state)
      return { url: url.toString(), state }
    })

    const exchangeCode = (code: string) =>
      HttpClientRequest.post(new URL("/login/oauth/access_token", webBaseUrl)).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bodyUrlParams({
          client_id: clientId,
          client_secret: Redacted.value(clientSecret),
          code
        }),
        client.execute,
        Effect.flatMap(HttpClientResponse.schemaBodyJson(AccessTokenResponse)),
        Effect.mapError(() => failed("GitHub did not answer the token exchange")),
        Effect.flatMap((body) => {
          const accessToken = body.access_token
          return accessToken === undefined
            ? Effect.fail(failed(body.error_description ?? body.error ?? "GitHub refused the sign-in code"))
            : Effect.succeed({
                accessToken: Redacted.make(accessToken),
                refreshToken: Option.map(Option.fromNullable(body.refresh_token), Redacted.make),
                expiresIn: Option.fromNullable(body.expires_in)
              })
        }),
        Effect.scoped
      )

    const readIdentity = (accessToken: Redacted.Redacted<string>) =>
      HttpClientRequest.get(new URL("/user", apiBaseUrl)).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.bearerToken(accessToken),
        client.execute,
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(GithubUser)),
        Effect.mapError(() => failed("GitHub would not say who signed in")),
        Effect.map(
          (user) =>
            new ForgeIdentity({
              forge: "github",
              forgeUserId: String(user.id),
              login: user.login,
              displayName: user.name ?? null,
              avatarUrl: user.avatar_url ?? null
            })
        ),
        Effect.scoped
      )

    const completeSignIn = (code: string) =>
      Effect.gen(function* () {
        const granted = yield* exchangeCode(code)
        const identity = yield* readIdentity(granted.accessToken)
        const now = yield* DateTime.now

        const credential: ForgeCredential = {
          forge: "github",
          accessToken: granted.accessToken,
          refreshToken: granted.refreshToken,
          accessTokenExpiresAt: Option.map(granted.expiresIn, (seconds) =>
            DateTime.addDuration(now, `${seconds} seconds`)
          )
        }

        return { identity, credential }
      })

    const describeInstallation = (externalId: string) =>
      Effect.gen(function* () {
        const jwt = yield* appJwt.token
        return yield* HttpClientRequest.get(new URL(`/app/installations/${externalId}`, apiBaseUrl)).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.bearerToken(jwt),
          client.execute,
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(GithubInstallation)),
          Effect.mapError(() => failed(`GitHub does not recognise installation ${externalId}`)),
          Effect.map(
            (installation) =>
              new Installation({
                forge: "github",
                externalId: String(installation.id),
                accountLogin: installation.account?.login ?? "unknown"
              })
          ),
          Effect.scoped
        )
      })

    return GithubAuthorization.of({ beginSignIn, completeSignIn, describeInstallation })
  })
)
