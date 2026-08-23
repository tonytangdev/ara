import { FetchHttpClient } from "@effect/platform"
import { Layer } from "effect"
import { PgDigestRepositoryLive } from "../digests/infrastructure/persistence/pg-digest-repository.ts"
import { PgJobQueueLive } from "../runs/infrastructure/persistence/pg-job-queue.ts"
import { DescribeDraft } from "./application/describe-draft.ts"
import { EditDraft } from "./application/edit-draft.ts"
import { ListDrafts } from "./application/list-drafts.ts"
import { RegenerateDraft } from "./application/regenerate-draft.ts"
import { WriteDraft } from "./application/write-draft.ts"
import { LanguageModelDraftWriterLive } from "./infrastructure/ai/language-model-draft-writer.ts"
import { OpenRouterLanguageModelLive } from "./infrastructure/ai/openrouter.ts"
import { DraftsHandlersLive } from "./infrastructure/http/drafts-handlers.ts"
import { PgDraftRepositoryLive } from "./infrastructure/persistence/pg-draft-repository.ts"

/**
 * The model, behind the provider-agnostic port. The adapter knows `@effect/ai`
 * and the provider layer knows OpenRouter; nothing above either knows both,
 * which is what makes the provider swappable without touching a use case.
 */
const DraftWriterLive = LanguageModelDraftWriterLive.pipe(
  Layer.provide(OpenRouterLanguageModelLive),
  Layer.provide(FetchHttpClient.layer)
)

/**
 * The drafts module's public face. Nothing outside this folder should import
 * anything deeper than these exports:
 *
 * - `./api.ts` — the HTTP contract this module contributes to the API surface.
 * - `DraftsLive` — reading a Draft over HTTP, fully wired.
 * - `WriteDraftLive` — the Draft stage of a Run, for the worker to call.
 *
 * They are two layers because they are two callers: a User reading yesterday's
 * Draft needs a database and nothing else, while writing one needs a model.
 * `SqlClient` is left as a requirement, so the composition root decides which
 * Postgres the module reads and writes.
 *
 * Regenerating is on the HTTP side rather than the writing side, and it needs
 * no model here for the same reason it needs no Forge: it puts a Run on the
 * queue and answers, and the worker is what writes. Sharing the queue adapter
 * with the runs module is what layer memoization is for — one Postgres, one
 * pool, one set of Runs.
 */
export const DraftsLive = DraftsHandlersLive.pipe(
  Layer.provide(Layer.mergeAll(DescribeDraft.Default, EditDraft.Default, ListDrafts.Default, RegenerateDraft.Default)),
  Layer.provide(Layer.mergeAll(PgDraftRepositoryLive, PgJobQueueLive))
)

/** The Draft stage: read the persisted Digest, write prose from it, persist that. */
export const WriteDraftLive = WriteDraft.Default.pipe(
  Layer.provide(Layer.mergeAll(DraftWriterLive, PgDraftRepositoryLive, PgDigestRepositoryLive))
)

export {
  DraftPageResponse,
  DraftResponse,
  DraftSummaryResponse,
  DraftsApiGroup,
  EditDraftRequest,
  NoSuchDraft,
  RegenerateDraftRequest,
  UnconfirmedEdit
} from "./api.ts"
export { WriteDraft } from "./application/write-draft.ts"
export { DraftShape, DraftSummary, QUIET_DRAFT_WORDS, StoredDraft, WrittenDraft } from "./domain/draft.ts"
export { DraftWriter } from "./domain/ports/draft-writer.ts"
