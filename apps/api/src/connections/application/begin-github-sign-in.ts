import { Effect } from "effect"
import { GithubAuthorization } from "../domain/ports/github-authorization.ts"

/**
 * Driving (inbound) port: start sign-in. Returns where to send the person and
 * the state that must come back with them; keeping that state safe in the
 * meantime is the caller's job, because it is a transport concern.
 */
export class BeginGithubSignIn extends Effect.Service<BeginGithubSignIn>()(
  "application/connections/BeginGithubSignIn",
  {
    effect: Effect.gen(function* () {
      const github = yield* GithubAuthorization
      return { execute: github.beginSignIn } as const
    })
  }
) {}
