import { Context, type Effect, type Option } from "effect"
import type { UserId } from "../../../connections/domain/user.ts"
import type { RunId } from "../../../runs/domain/run.ts"
import type { StoredDraft, WrittenDraft } from "../draft.ts"

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
  }
>() {}
