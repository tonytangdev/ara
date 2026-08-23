import { HttpApiBuilder } from "@effect/platform"
import { Effect, Option, Schema } from "effect"
import { CurrentUser } from "../../../connections/domain/current-user.ts"
import { AraApi } from "../../../http/api.ts"
import type { RunId } from "../../../runs/domain/run.ts"
import { DraftPageResponse, DraftResponse, DraftSummaryResponse, NoSuchDraft } from "../../api.ts"
import { DescribeDraft } from "../../application/describe-draft.ts"
import { ListDrafts } from "../../application/list-drafts.ts"
import {
  type DraftCursor,
  DraftCursorFromString,
  type DraftId,
  type DraftSummary,
  type StoredDraft
} from "../../domain/draft.ts"

const toResponse = (draft: StoredDraft) =>
  new DraftResponse({
    id: draft.id,
    runId: draft.runId,
    digestId: draft.digestId,
    body: draft.body,
    model: draft.model,
    inputTokens: draft.inputTokens,
    outputTokens: draft.outputTokens,
    totalTokens: draft.totalTokens,
    generatedAt: draft.generatedAt
  })

const toSummary = (summary: DraftSummary) =>
  new DraftSummaryResponse({
    id: summary.id,
    runId: summary.runId,
    digestId: summary.digestId,
    forge: summary.repository.forge,
    owner: summary.repository.owner,
    name: summary.repository.name,
    day: summary.dayWindow.day,
    timeZone: summary.dayWindow.timeZone,
    isQuiet: summary.isQuiet,
    model: summary.model,
    generatedAt: summary.generatedAt
  })

/**
 * The cursor leaves as the opaque string it arrived as. Encoding cannot fail —
 * it is a date and a uuid — so a failure here would be a defect and is treated
 * as one.
 */
const encodeCursor = Schema.encodeSync(DraftCursorFromString)

/**
 * Driving (inbound) adapter for Drafts.
 *
 * The User is taken from `CurrentUser` and never from anything the caller sent,
 * so a Draft cannot be read by guessing a Run id. "Not yours", "no such Run"
 * and "nothing written yet" arrive here as one domain failure and leave as one
 * 404.
 */
export const DraftsHandlersLive = HttpApiBuilder.group(AraApi, "drafts", (handlers) =>
  handlers
    .handle("read", ({ path }) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser
        const describe = yield* DescribeDraft

        const draft = yield* describe
          .execute(user, path.id as RunId)
          .pipe(Effect.mapError(() => new NoSuchDraft({ message: "No such Draft" })))

        return toResponse(draft)
      })
    )
    .handle("list", ({ urlParams }) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser
        const list = yield* ListDrafts

        const page = yield* list.execute(user, {
          limit: Option.fromNullable(urlParams.limit),
          after: Option.fromNullable(urlParams.after as DraftCursor | undefined)
        })

        return new DraftPageResponse({
          items: page.items.map(toSummary),
          nextCursor: page.nextCursor === null ? null : encodeCursor(page.nextCursor)
        })
      })
    )
    .handle("open", ({ path }) =>
      Effect.gen(function* () {
        const user = yield* CurrentUser
        const describe = yield* DescribeDraft

        const draft = yield* describe
          .byId(user, path.id as DraftId)
          .pipe(Effect.mapError(() => new NoSuchDraft({ message: "No such Draft" })))

        return toResponse(draft)
      })
    )
)
