import { Context, type Effect, type Option } from "effect"
import type { UserId } from "../../../connections/domain/user.ts"
import type { RunId } from "../../../runs/domain/run.ts"
import type { Digest, StoredDigest } from "../digest.ts"

/**
 * Driven (outbound) port for Digests.
 *
 * `save` is an upsert on the Run rather than an insert, because a Run can be
 * processed more than once: an interrupted deploy hands its Runs back to the
 * queue, and collecting the same day twice must leave one Digest rather than
 * two (ADR-0002).
 *
 * Reading takes the owning `UserId`, as everywhere else: ownership is part of
 * asking the question, so there is no shape of call that reads another User's
 * Digest.
 */
export class DigestRepository extends Context.Tag("domain/digests/DigestRepository")<
  DigestRepository,
  {
    readonly save: (runId: RunId, userId: UserId, digest: Digest) => Effect.Effect<StoredDigest>
    readonly findForRun: (runId: RunId, userId: UserId) => Effect.Effect<Option.Option<StoredDigest>>
    /**
     * One Digest by its own id. What regenerating a Draft writes from: the Run
     * doing the writing is not the Run that collected it, so "the Digest for
     * this Run" is the wrong question to ask (ADR-0002).
     */
    readonly findOwnedBy: (id: string, userId: UserId) => Effect.Effect<Option.Option<StoredDigest>>
  }
>() {}
