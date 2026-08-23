import { createSign } from "node:crypto"
import { DateTime, Effect, Redacted } from "effect"
import { GithubAppConfig } from "../../../config.ts"

/** GitHub rejects anything longer; a minute of backdating absorbs clock skew. */
const LIFETIME_SECONDS = 540
const BACKDATE_SECONDS = 60

const base64url = (value: string | Buffer) =>
  (typeof value === "string" ? Buffer.from(value, "utf8") : value).toString("base64url")

/**
 * Env vars cannot hold real newlines comfortably, so a PEM arrives either with
 * `\n` written out or base64-encoded whole. Both are accepted; anything else is
 * left alone and will fail loudly at the first signature.
 */
const readPem = (raw: string) => {
  const unescaped = raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw
  if (unescaped.includes("-----BEGIN")) return unescaped
  return Buffer.from(unescaped, "base64").toString("utf8")
}

/**
 * The App's own credential: a short-lived RS256 JWT signed with the private
 * key, which is the only thing that can mint installation tokens. Generated per
 * call rather than cached — it is cheap, and one fewer secret sitting around.
 */
export class GithubAppJwt extends Effect.Service<GithubAppJwt>()("infrastructure/connections/GithubAppJwt", {
  effect: Effect.gen(function* () {
    const { appId, privateKey } = yield* GithubAppConfig
    const pem = readPem(Redacted.value(privateKey))

    const token = Effect.gen(function* () {
      const now = Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000)
      const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
      const payload = base64url(
        JSON.stringify({ iat: now - BACKDATE_SECONDS, exp: now + LIFETIME_SECONDS, iss: appId })
      )
      const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(pem)
      return Redacted.make(`${header}.${payload}.${base64url(signature)}`)
    })

    return { token } as const
  })
}) {}
