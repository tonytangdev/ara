import { Effect } from "effect"
import type { User } from "../../connections/domain/user.ts"
import { RunRepository } from "../domain/ports/run-repository.ts"
import type { Run } from "../domain/run.ts"

/** How many Runs "recent Runs" means. Enough to find yesterday's; not a page of history. */
const RECENT_RUNS = 50

/** Driving (inbound) port: the caller's recent Runs, most recently requested first. */
export class ListRuns extends Effect.Service<ListRuns>()("application/runs/ListRuns", {
  effect: Effect.gen(function* () {
    const runs = yield* RunRepository

    const execute = (user: User): Effect.Effect<ReadonlyArray<Run>> => runs.listFor(user.id, RECENT_RUNS)

    return { execute } as const
  })
}) {}
