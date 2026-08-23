import { Context, type Effect, type Option } from "effect"
import type { UserId } from "../../../connections/domain/user.ts"
import type { RunId } from "../../../runs/domain/run.ts"
import type { DraftCursor, DraftId, DraftSummary, StoredDraft, WrittenDraft } from "../draft.ts"

/**
 * Driven (outbound) port for Drafts.
 *
 * `save` inserts rather than upserts, because a Run is not the only thing that
 * can produce a Draft for a Digest: regenerating one keeps the earlier Drafts
 * (#11), and a table that overwrites on `run_id` could not hold them. What
 * keeps re-processing an interrupted Run from writing a second Draft is the
 * Draft stage asking `latestForRun` first, not the schema refusing it — and
 * that check is safe because a Run is claimed by at most one worker (ADR-0001).
 *
 * Reading takes the owning `UserId`, as everywhere else: ownership is part of
 * asking the question, so there is no shape of call that reads another User's
 * Draft.
 */
export class DraftRepository extends Context.Tag("domain/drafts/DraftRepository")<
  DraftRepository,
  {
    readonly save: (runId: RunId, userId: UserId, digestId: string, written: WrittenDraft) => Effect.Effect<StoredDraft>
    readonly latestForRun: (runId: RunId, userId: UserId) => Effect.Effect<Option.Option<StoredDraft>>
    readonly findOwnedBy: (id: DraftId, userId: UserId) => Effect.Effect<Option.Option<StoredDraft>>
    /**
     * Save the User's edit beside the generated prose, and hand back the Draft
     * as it now stands. `None` when the Draft is not theirs or does not exist —
     * the same answer for both, so the caller has nothing to tell apart.
     *
     * It writes `edited_body` and never `body`: the generated text is what
     * regeneration compares against and what a later "what do they always
     * change?" reads from, and an upsert over one column would lose both.
     */
    readonly saveEdit: (id: DraftId, userId: UserId, body: string) => Effect.Effect<Option.Option<StoredDraft>>
    /**
     * One page of the User's Drafts, newest first. `limit` is the caller's, and
     * bounded above it: this port will happily return whatever it is asked for,
     * so the ceiling belongs to the use case rather than here.
     */
    readonly listFor: (
      userId: UserId,
      page: { readonly limit: number; readonly after: Option.Option<DraftCursor> }
    ) => Effect.Effect<ReadonlyArray<DraftSummary>>
  }
>() {}
