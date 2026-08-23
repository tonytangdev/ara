import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Redacted } from "effect"
import { SecretCipher } from "./secret-cipher.ts"

const withKey = (key: Buffer) =>
  SecretCipher.Default.pipe(
    Layer.provide(
      Layer.setConfigProvider(ConfigProvider.fromMap(new Map([["CREDENTIAL_ENCRYPTION_KEY", key.toString("base64")]])))
    )
  )

const cipher = withKey(Buffer.alloc(32, 1))
const otherCipher = withKey(Buffer.alloc(32, 2))

describe("SecretCipher", () => {
  it.effect("gives back exactly what it was given", () =>
    Effect.gen(function* () {
      const secret = yield* SecretCipher
      const opened = yield* secret.decrypt(yield* secret.encrypt(Redacted.make("ghu_a-token")))

      assert.strictEqual(Redacted.value(opened), "ghu_a-token")
    }).pipe(Effect.provide(cipher))
  )

  it.effect("leaves nothing of the plaintext in the ciphertext", () =>
    Effect.gen(function* () {
      const secret = yield* SecretCipher
      const sealed = yield* secret.encrypt(Redacted.make("ghu_a-token"))

      assert.notInclude(sealed, "ghu_a-token")
      assert.match(sealed, /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/)
    }).pipe(Effect.provide(cipher))
  )

  it.effect("encrypts the same secret differently every time", () =>
    Effect.gen(function* () {
      const secret = yield* SecretCipher
      const once = yield* secret.encrypt(Redacted.make("ghu_a-token"))
      const twice = yield* secret.encrypt(Redacted.make("ghu_a-token"))

      assert.notStrictEqual(once, twice)
    }).pipe(Effect.provide(cipher))
  )

  it.effect("refuses a ciphertext that was edited", () =>
    Effect.gen(function* () {
      const secret = yield* SecretCipher
      const sealed = yield* secret.encrypt(Redacted.make("ghu_a-token"))
      const tampered = `${sealed.slice(0, -4)}AAAA`

      const failure = yield* Effect.flip(secret.decrypt(tampered))
      assert.strictEqual(failure._tag, "DecryptionFailed")
    }).pipe(Effect.provide(cipher))
  )

  it.effect("refuses a ciphertext sealed with another key", () =>
    Effect.gen(function* () {
      const sealed = yield* Effect.flatMap(SecretCipher, (secret) => secret.encrypt(Redacted.make("ghu_a-token"))).pipe(
        Effect.provide(cipher)
      )

      const failure = yield* Effect.flatMap(SecretCipher, (secret) => Effect.flip(secret.decrypt(sealed))).pipe(
        Effect.provide(otherCipher)
      )
      assert.strictEqual(failure._tag, "DecryptionFailed")
    })
  )
})
