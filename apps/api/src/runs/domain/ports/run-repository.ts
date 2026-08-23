import { Context, type Effect, type Option } from "effect"
import type { UserId } from "../../../connections/domain/user.ts"
import type { Run, RunId } from "../run.ts"

/**
 * Driven (outbound) port for reading Runs.
 *
 * As with Repo Connections, every operation takes the owning `UserId` rather
 * than offering a bare `findById`. Ownership is part of asking the question, so
 * there is no shape of call through this port that reads another User's Run.
 * The worker does not read through here at all — it claims through `JobQueue`,
 * which is the only thing entitled to see every User's Runs.
 */
export class RunRepository extends Context.Tag("domain/runs/RunRepository")<
  RunRepository,
  {
    readonly findOwnedBy: (id: RunId, userId: UserId) => Effect.Effect<Option.Option<Run>>
    /** Most recently requested first, so "the Draft I generated earlier" is at the top. */
    readonly listFor: (userId: UserId, limit: number) => Effect.Effect<ReadonlyArray<Run>>
  }
>() {}
