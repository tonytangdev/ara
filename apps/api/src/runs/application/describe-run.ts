import { Effect, Option } from "effect"
import type { User } from "../../connections/domain/user.ts"
import { RunRepository } from "../domain/ports/run-repository.ts"
import { type Run, type RunId, RunNotFound } from "../domain/run.ts"

/**
 * Driving (inbound) port: what stage is my Run at?
 *
 * A Run that is not the caller's own fails exactly as one that never existed,
 * so polling an id at random tells nobody whether it is somebody else's.
 */
export class DescribeRun extends Effect.Service<DescribeRun>()("application/runs/DescribeRun", {
  effect: Effect.gen(function* () {
    const runs = yield* RunRepository

    const execute = (user: User, id: RunId): Effect.Effect<Run, RunNotFound> =>
      Effect.flatMap(
        runs.findOwnedBy(id, user.id),
        Option.match({
          onNone: () => Effect.fail(new RunNotFound()),
          onSome: Effect.succeed
        })
      )

    return { execute } as const
  })
}) {}
