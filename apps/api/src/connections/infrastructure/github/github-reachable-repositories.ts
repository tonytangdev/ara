import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform"
import { Effect, Layer, Schema } from "effect"
import { GithubAppConfig } from "../../../config.ts"
import type { Installation } from "../../domain/installation.ts"
import { ForgeAuthorizationFailed } from "../../domain/ports/github-authorization.ts"
import { InstallationTokens } from "../../domain/ports/installation-tokens.ts"
import { ReachableRepositories } from "../../domain/ports/reachable-repositories.ts"
import { ReachableRepository, Repository } from "../../domain/repository.ts"

/** GitHub's maximum. Fewer pages for the same repositories. */
const PER_PAGE = 100

/**
 * A ceiling on how far Ara will page. Someone who installed the App on a
 * thousand repositories has not made a choice this product can help with, and
 * an unbounded loop against a paginated API is a way to hang a request.
 */
const MAX_PAGES = 10

const RepositoriesResponse = Schema.Struct({
  repositories: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      private: Schema.Boolean,
      owner: Schema.Struct({ login: Schema.String })
    })
  )
})

/**
 * Driven (outbound) adapter listing what a GitHub App installation can reach.
 *
 * It asks with the installation's own token, so the answer is exactly the set
 * of repositories the User picked on GitHub's installation screen — Ara never
 * asks GitHub for everything the person owns (ADR-0005). The token is minted
 * through `InstallationTokens` rather than held here: this adapter has no
 * credential of its own.
 */
export const GithubReachableRepositoriesLive = Layer.effect(
  ReachableRepositories,
  Effect.gen(function* () {
    const { apiBaseUrl } = yield* GithubAppConfig
    const client = yield* HttpClient.HttpClient
    const tokens = yield* InstallationTokens

    const listFor = (installation: Installation) =>
      Effect.gen(function* () {
        const { token } = yield* tokens.tokenFor(installation)

        const page = (number: number) =>
          HttpClientRequest.get(new URL("/installation/repositories", apiBaseUrl)).pipe(
            HttpClientRequest.acceptJson,
            HttpClientRequest.bearerToken(token),
            HttpClientRequest.setUrlParams({ per_page: String(PER_PAGE), page: String(number) }),
            client.execute,
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(RepositoriesResponse)),
            Effect.mapError(
              () =>
                new ForgeAuthorizationFailed({
                  reason:
                    `GitHub would not say what installation ${installation.externalId} can reach. ` +
                    "Ara's access may have been revoked."
                })
            ),
            Effect.scoped
          )

        const collected: Array<ReachableRepository> = []
        for (let number = 1; number <= MAX_PAGES; number++) {
          const { repositories } = yield* page(number)
          for (const repository of repositories) {
            collected.push(
              new ReachableRepository({
                repository: new Repository({
                  forge: installation.forge,
                  owner: repository.owner.login,
                  name: repository.name
                }),
                isPrivate: repository.private,
                installationExternalId: installation.externalId
              })
            )
          }
          if (repositories.length < PER_PAGE) break
        }

        return collected
      })

    return ReachableRepositories.of({ listFor })
  })
)
