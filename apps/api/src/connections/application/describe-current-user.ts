import { Effect } from "effect"
import type { Installation } from "../domain/installation.ts"
import { InstallationRepository } from "../domain/ports/installation-repository.ts"
import type { User } from "../domain/user.ts"

/**
 * Who the caller is, and what Ara can currently reach on their behalf. The two
 * are separate facts: `installations` is empty for a perfectly valid User who
 * has not installed the App (ADR-0005), and that is an answer, not an error.
 */
export interface Identity {
  readonly user: User
  readonly installations: ReadonlyArray<Installation>
}

/** Driving (inbound) port behind `GET /v1/me`. */
export class DescribeCurrentUser extends Effect.Service<DescribeCurrentUser>()(
  "application/connections/DescribeCurrentUser",
  {
    effect: Effect.gen(function* () {
      const installations = yield* InstallationRepository

      const execute = (user: User): Effect.Effect<Identity> =>
        Effect.map(installations.listFor(user.id), (found) => ({ user, installations: found }))

      return { execute } as const
    })
  }
) {}
