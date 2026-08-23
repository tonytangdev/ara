import { Effect, Option } from "effect"
import type { User } from "../../connections/domain/user.ts"
import { cursorAfter, DRAFT_PAGE_SIZE, type DraftCursor, type DraftPage } from "../domain/draft.ts"
import { DraftRepository } from "../domain/ports/draft-repository.ts"

/** What the caller asked for: how many, and where the last page stopped. */
export interface ListDraftsRequest {
  readonly limit: Option.Option<number>
  readonly after: Option.Option<DraftCursor>
}

/**
 * Driving (inbound) port: the Drafts a User has accumulated, newest first.
 *
 * This is the first question Ara answers across more than one Run, which is
 * what makes the bound matter: Drafts arrive one per Run and are never cleaned
 * up, so an unbounded "all of them" would grow into a page nobody can load. The
 * ceiling lives here rather than in the adapter, so no caller can ask past it.
 *
 * One row beyond the page is read to answer "is there more?" without a second
 * query, and thrown away. The extra row is the whole reason `nextCursor` can be
 * null on the last page rather than dangling and returning nothing.
 */
export class ListDrafts extends Effect.Service<ListDrafts>()("application/drafts/ListDrafts", {
  effect: Effect.gen(function* () {
    const drafts = yield* DraftRepository

    const execute = (user: User, request: ListDraftsRequest): Effect.Effect<DraftPage> =>
      Effect.gen(function* () {
        const limit = Math.min(
          Option.getOrElse(request.limit, () => DRAFT_PAGE_SIZE.default),
          DRAFT_PAGE_SIZE.max
        )

        const found = yield* drafts.listFor(user.id, { limit: limit + 1, after: request.after })
        const items = found.slice(0, limit)
        const last = items[items.length - 1]

        return {
          items,
          nextCursor: found.length > limit && last !== undefined ? cursorAfter(last) : null
        }
      })

    return { execute } as const
  })
}) {}
