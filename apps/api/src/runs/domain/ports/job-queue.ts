import { Context, type Effect, type Option } from "effect"
import type { RepoConnection } from "../../../connections/domain/repo-connection.ts"
import type { UserId } from "../../../connections/domain/user.ts"
import type { DayWindow } from "../day-window.ts"
import type { Run, RunId, RunOutcome, RunState, Trigger } from "../run.ts"

/** Everything needed to put a Run on the queue. */
export interface RunRequest {
  readonly userId: UserId
  readonly connection: RepoConnection
  readonly dayWindow: DayWindow
  readonly trigger: Trigger
}

/**
 * Driven (outbound) port: enqueue and claim Runs. Backed by Postgres per
 * ADR-0001, which is why the vocabulary here is deliberately queue-shaped and
 * says nothing about tables.
 *
 * `claim` is the load-bearing operation. It must hand the same Run to at most
 * one caller however many workers are asking at once, and must not make a
 * worker wait behind another worker's Run — the Postgres adapter does this with
 * `select ... for update skip locked`, and the Testcontainers test is what
 * holds it to that.
 */
export class JobQueue extends Context.Tag("domain/runs/JobQueue")<
  JobQueue,
  {
    /**
     * Enqueue a Run, or answer with the one already in flight for the same User,
     * repository and Day Window. Asking twice costs one Run: a double-clicked
     * button should not buy two model calls.
     */
    readonly enqueue: (request: RunRequest) => Effect.Effect<Run>
    /** The next queued Run, now marked as being worked on, or none if the queue is empty. */
    readonly claim: Effect.Effect<Option.Option<Run>>
    /** Move a claimed Run between the pipeline's stages. */
    readonly advance: (id: RunId, state: RunState) => Effect.Effect<void>
    /**
     * Count another attempt at a Run this worker is still holding, and put it
     * back at the stage it will resume from. Answers with the attempt number
     * that has just begun.
     *
     * Deliberately not the same as returning the Run to `queued`: the worker
     * has not let go of it, and a Run visible as queued while somebody is still
     * backing off from it would be claimed twice over.
     */
    readonly recordAttempt: (id: RunId, resumeAt: RunState) => Effect.Effect<number>
    /** Finish a Run, one way or the other. */
    readonly complete: (id: RunId, outcome: RunOutcome) => Effect.Effect<void>
    /**
     * Return Runs abandoned mid-flight to `queued`, and answer with how many.
     * Run at boot: a Run that a deploy interrupted is otherwise stuck in a state
     * no worker will ever look at again.
     */
    readonly requeueInterrupted: Effect.Effect<number>
  }
>() {}
