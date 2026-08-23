import { HttpMiddleware, HttpServerRequest } from "@effect/platform"
import { Effect, Exit } from "effect"

/**
 * Query parameters that are credentials in flight. GitHub sends the sign-in
 * code and state on the URL, and `HttpMiddleware.logger` would write the whole
 * URL out — a single-use code in a log file is still a code in a log file.
 */
const REDACTED_PARAMS = ["code", "state"]

const scrub = (url: string) => {
  const parsed = new URL(url, "http://request.invalid")
  let redacted = false

  for (const name of REDACTED_PARAMS) {
    if (parsed.searchParams.has(name)) {
      parsed.searchParams.set(name, "<redacted>")
      redacted = true
    }
  }

  return redacted ? `${parsed.pathname}${parsed.search}` : url
}

/**
 * What `HttpMiddleware.logger` does, minus the secrets. Every request is still
 * logged with its method, path and status; only the parameters that are
 * credentials are replaced.
 */
export const RequestLogger = HttpMiddleware.make((app) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const exit = yield* Effect.exit(app)
    const annotations = { "http.method": request.method, "http.url": scrub(request.url) }

    yield* Exit.match(exit, {
      onFailure: (cause) => Effect.logError("HTTP request failed", cause).pipe(Effect.annotateLogs(annotations)),
      onSuccess: (response) =>
        Effect.logInfo("Sent HTTP response").pipe(
          Effect.annotateLogs({ ...annotations, "http.status": response.status })
        )
    })

    return yield* exit
  })
)
