import { HttpApiBuilder } from "@effect/platform"
import { Effect } from "effect"
import { CurrentUser } from "../../../connections/domain/current-user.ts"
import { AraApi } from "../../../http/api.ts"
import type { RunId } from "../../../runs/domain/run.ts"
import { DraftResponse, NoSuchDraft } from "../../api.ts"
import { DescribeDraft } from "../../application/describe-draft.ts"
import type { StoredDraft } from "../../domain/draft.ts"

const toResponse = (draft: StoredDraft) =>
  new DraftResponse({
    id: draft.id,
    runId: draft.runId,
    digestId: draft.digestId,
    shape: draft.shape,
    body: draft.body,
    model: draft.model,
    inputTokens: draft.inputTokens,
    outputTokens: draft.outputTokens,
    totalTokens: draft.totalTokens,
    generatedAt: draft.generatedAt
  })

/**
 * Driving (inbound) adapter for Drafts.
 *
 * The User is taken from `CurrentUser` and never from anything the caller sent,
 * so a Draft cannot be read by guessing a Run id. "Not yours", "no such Run"
 * and "nothing written yet" arrive here as one domain failure and leave as one
 * 404.
 */
export const DraftsHandlersLive = HttpApiBuilder.group(AraApi, "drafts", (handlers) =>
  handlers.handle("read", ({ path }) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      const describe = yield* DescribeDraft

      const draft = yield* describe
        .execute(user, path.id as RunId)
        .pipe(Effect.mapError(() => new NoSuchDraft({ message: "No such Draft" })))

      return toResponse(draft)
    })
  )
)
