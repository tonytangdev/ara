import { HttpApiBuilder, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { DateTime, Effect, Layer, Redacted } from "effect"
import { SessionConfig } from "../../../config.ts"
import { AraApi } from "../../../http/api.ts"
import { InstallationResponse, MeResponse, SESSION_COOKIE, SIGN_IN_STATE_COOKIE, SignInFailed } from "../../api.ts"
import { BeginGithubSignIn } from "../../application/begin-github-sign-in.ts"
import { CompleteGithubSignIn } from "../../application/complete-github-sign-in.ts"
import { DescribeCurrentUser, type Identity } from "../../application/describe-current-user.ts"
import { RecordGithubInstallation } from "../../application/record-github-installation.ts"
import { SetTimeZone } from "../../application/set-time-zone.ts"
import { CurrentUser } from "../../domain/current-user.ts"

const toMeResponse = (identity: Identity) =>
  new MeResponse({
    id: identity.user.id,
    forge: identity.user.forge,
    login: identity.user.login,
    displayName: identity.user.displayName,
    avatarUrl: identity.user.avatarUrl,
    timeZone: identity.user.timeZone,
    installations: identity.installations.map(
      (installation) =>
        new InstallationResponse({
          forge: installation.forge,
          id: installation.externalId,
          accountLogin: installation.accountLogin
        })
    )
  })

/** The state cookie only has to survive a trip to GitHub and back. */
const SIGN_IN_STATE_LIFETIME = "10 minutes"

/**
 * Driving (inbound) adapter for signing in.
 *
 * Cookies are this layer's business and nothing else's: the use cases hand back
 * a token and a state string, and how a browser is made to carry them is a
 * transport decision that stops here.
 */
export const ConnectionsHandlersLive = Layer.unwrapEffect(
  Effect.map(SessionConfig, ({ afterSignInUrl, secureCookies }) => {
    const cookieOptions = {
      httpOnly: true,
      secure: secureCookies,
      sameSite: "lax",
      path: "/"
    } as const

    return HttpApiBuilder.group(AraApi, "connections", (handlers) =>
      handlers
        .handleRaw("startGithubSignIn", () =>
          Effect.gen(function* () {
            const beginSignIn = yield* BeginGithubSignIn
            const { state, url } = yield* beginSignIn.execute

            return HttpServerResponse.unsafeSetCookie(
              HttpServerResponse.redirect(url, { status: 302 }),
              SIGN_IN_STATE_COOKIE,
              state,
              {
                ...cookieOptions,
                maxAge: SIGN_IN_STATE_LIFETIME
              }
            )
          })
        )
        .handleRaw("completeGithubSignIn", ({ urlParams }) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest
            const expected = request.cookies[SIGN_IN_STATE_COOKIE]

            // The state came from us, went to GitHub, and came back. If the
            // round trip did not preserve it, this is not our sign-in.
            if (expected === undefined || expected !== urlParams.state) {
              return yield* new SignInFailed({ reason: "This sign-in did not start here. Try again." })
            }

            const completeSignIn = yield* CompleteGithubSignIn
            const { session } = yield* completeSignIn
              .execute(urlParams.code)
              .pipe(Effect.mapError((failure) => new SignInFailed({ reason: failure.reason })))

            const signedIn = HttpServerResponse.unsafeSetCookie(
              HttpServerResponse.redirect(afterSignInUrl, { status: 302 }),
              SESSION_COOKIE,
              // The one place the raw token is read: it has to reach the browser.
              Redacted.value(session.token),
              { ...cookieOptions, expires: DateTime.toDate(session.session.expiresAt) }
            )

            return HttpServerResponse.unsafeSetCookie(signedIn, SIGN_IN_STATE_COOKIE, "", {
              ...cookieOptions,
              maxAge: 0
            })
          })
        )
        .handleRaw("recordGithubInstallation", ({ urlParams }) =>
          Effect.gen(function* () {
            const user = yield* CurrentUser
            const record = yield* RecordGithubInstallation
            yield* record
              .execute(user, urlParams.installation_id)
              .pipe(Effect.mapError((failure) => new SignInFailed({ reason: failure.reason })))

            return HttpServerResponse.redirect(afterSignInUrl, { status: 302 })
          })
        )
        .handle("me", () =>
          Effect.gen(function* () {
            const user = yield* CurrentUser
            const describe = yield* DescribeCurrentUser
            const identity = yield* describe.execute(user)

            return toMeResponse(identity)
          })
        )
        .handle("updateMe", ({ payload }) =>
          Effect.gen(function* () {
            const user = yield* CurrentUser
            const setTimeZone = yield* SetTimeZone
            const describe = yield* DescribeCurrentUser

            const updated = yield* setTimeZone.execute(user, payload.timeZone)
            return toMeResponse(yield* describe.execute(updated))
          })
        )
    )
  })
)
