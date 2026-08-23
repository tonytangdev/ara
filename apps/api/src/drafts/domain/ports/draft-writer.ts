import { Context, type Effect, Schema } from "effect"
import type { Digest } from "../../../digests/domain/digest.ts"
import type { WrittenDraft } from "../draft.ts"

/** What to write about. A Digest, and deliberately nothing else (ADR-0004). */
export interface DraftBrief {
  readonly digest: Digest
}

/**
 * The Draft could not be written.
 *
 * `retryable` is the only classification the domain makes, and it is made here
 * because only the adapter can tell a rate limit from a revoked key. Chief
 * among the retryable cases is the one that is not an error at all on the wire:
 * the model answering with reasoning and no message content. Treating that as a
 * failure is what stops an empty Draft being persisted as if it were prose.
 */
export class DraftUnavailable extends Schema.TaggedError<DraftUnavailable>()("DraftUnavailable", {
  reason: Schema.String,
  retryable: Schema.Boolean
}) {}

/**
 * Driven (outbound) port: given a Digest, return prose.
 *
 * Named for what the domain needs rather than for who provides it (ADR-0003).
 * Nothing above this line knows which model wrote a Draft or which provider it
 * was reached through — both are configuration, and swapping either is a change
 * to the layer this port is satisfied by and to nothing else.
 *
 * The port's vocabulary has no room for source code: it takes a Digest, which
 * carries subjects, paths and line counts and never a diff hunk. ADR-0004 is
 * therefore a property of the shape rather than a rule somebody has to keep
 * following.
 */
export class DraftWriter extends Context.Tag("domain/drafts/DraftWriter")<
  DraftWriter,
  {
    readonly writeDraft: (brief: DraftBrief) => Effect.Effect<WrittenDraft, DraftUnavailable>
  }
>() {}
