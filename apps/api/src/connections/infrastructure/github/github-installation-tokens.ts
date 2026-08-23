import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform"
import { DateTime, Effect, HashMap, Layer, Option, Redacted, Ref, Schema } from "effect"
import { GithubAppConfig } from "../../../config.ts"
import type { Installation, InstallationToken } from "../../domain/installation.ts"
import { ForgeAuthorizationFailed } from "../../domain/ports/github-authorization.ts"
import { InstallationTokens } from "../../domain/ports/installation-tokens.ts"
import { GithubAppJwt } from "./github-app-jwt.ts"

/**
 * GitHub's installation tokens last an hour. Handing one out with a minute left
 * on it invites a request that expires mid-flight, so anything inside this
 * margin is treated as already gone.
 */
const REFRESH_MARGIN = "5 minutes"

const AccessTokenResponse = Schema.Struct({
  token: Schema.String,
  expires_at: Schema.DateTimeUtc
})

/**
 * Driven (outbound) adapter minting installation tokens from the App's private
 * key (ADR-0005). Nothing here is persisted: the cache is a `Ref` that dies
 * with the process, which is the point — a database leak yields no repository
 * access, because no repository access is written down.
 */
export const GithubInstallationTokensLive = Layer.effect(
  InstallationTokens,
  Effect.gen(function* () {
    const { apiBaseUrl } = yield* GithubAppConfig
    const client = yield* HttpClient.HttpClient
    const appJwt = yield* GithubAppJwt
    const cache = yield* Ref.make(HashMap.empty<string, InstallationToken>())

    const mint = (installation: Installation) =>
      Effect.gen(function* () {
        const jwt = yield* appJwt.token
        const minted = yield* HttpClientRequest.post(
          new URL(`/app/installations/${installation.externalId}/access_tokens`, apiBaseUrl)
        ).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.bearerToken(jwt),
          client.execute,
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(AccessTokenResponse)),
          Effect.mapError(
            () =>
              new ForgeAuthorizationFailed({
                reason: `GitHub would not mint a token for installation ${installation.externalId}`
              })
          ),
          Effect.scoped
        )

        const token: InstallationToken = {
          token: Redacted.make(minted.token),
          expiresAt: minted.expires_at
        }
        yield* Ref.update(cache, HashMap.set(installation.externalId, token))
        return token
      })

    const tokenFor = (installation: Installation) =>
      Effect.gen(function* () {
        // A token is only reused while it will still be valid once the margin
        // has passed; otherwise it is treated as gone and minted again.
        const cutoff = DateTime.addDuration(yield* DateTime.now, REFRESH_MARGIN)
        const usable = Ref.get(cache).pipe(
          Effect.map((tokens) =>
            Option.filter(HashMap.get(tokens, installation.externalId), (token) =>
              DateTime.greaterThan(token.expiresAt, cutoff)
            )
          )
        )

        return yield* Effect.flatMap(usable, Option.match({ onNone: () => mint(installation), onSome: Effect.succeed }))
      })

    return InstallationTokens.of({ tokenFor })
  })
)
