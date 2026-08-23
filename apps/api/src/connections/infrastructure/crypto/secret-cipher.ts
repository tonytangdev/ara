import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { Data, Effect, Redacted } from "effect"
import { EncryptionConfig } from "../../../config.ts"

/** A stored ciphertext could not be opened: wrong key, or someone edited the row. */
export class DecryptionFailed extends Data.TaggedError("DecryptionFailed")<{ readonly reason: string }> {}

const ALGORITHM = "aes-256-gcm"
const VERSION = "v1"
const KEY_BYTES = 32
const IV_BYTES = 12

/**
 * AES-256-GCM over anything Ara must keep but must not leak. Used by the
 * persistence adapters, so encrypting at rest is something the storage does
 * rather than something a use case has to remember.
 *
 * Ciphertexts are versioned (`v1.iv.tag.body`) so the key or the algorithm can
 * be rotated later without guessing at what a column already holds.
 */
export class SecretCipher extends Effect.Service<SecretCipher>()("infrastructure/connections/SecretCipher", {
  effect: Effect.gen(function* () {
    const { key } = yield* EncryptionConfig
    const secret = Buffer.from(Redacted.value(key), "base64")

    if (secret.length !== KEY_BYTES) {
      // A short key is a misconfiguration, not a runtime condition: fail the boot.
      return yield* Effect.dieMessage(
        `CREDENTIAL_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${secret.length}`
      )
    }

    const encrypt = (plaintext: Redacted.Redacted<string>): Effect.Effect<string> =>
      Effect.sync(() => {
        const iv = randomBytes(IV_BYTES)
        const cipher = createCipheriv(ALGORITHM, secret, iv)
        const body = Buffer.concat([cipher.update(Redacted.value(plaintext), "utf8"), cipher.final()])
        return [VERSION, iv, cipher.getAuthTag(), body]
          .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
          .join(".")
      })

    const decrypt = (ciphertext: string): Effect.Effect<Redacted.Redacted<string>, DecryptionFailed> =>
      Effect.try({
        try: () => {
          const [version, iv, tag, body] = ciphertext.split(".")
          if (version !== VERSION || iv === undefined || tag === undefined || body === undefined) {
            throw new Error(`unsupported ciphertext format`)
          }
          const decipher = createDecipheriv(ALGORITHM, secret, Buffer.from(iv, "base64url"))
          decipher.setAuthTag(Buffer.from(tag, "base64url"))
          const plaintext = Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()])
          return Redacted.make(plaintext.toString("utf8"))
        },
        // The message is ours, never the exception's: node's includes nothing
        // useful and we would rather not find out what it might include.
        catch: () => new DecryptionFailed({ reason: "ciphertext could not be authenticated" })
      })

    return { encrypt, decrypt } as const
  })
}) {}
