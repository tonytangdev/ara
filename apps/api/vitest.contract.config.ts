import { defineConfig } from "vitest/config"

/**
 * The contract tests: the handful that talk to a real Forge.
 *
 * They live in their own config because they are excluded from `pnpm test`, and
 * therefore from CI — they need credentials, a real repository, and a network
 * that is somebody else's. Run them by hand with `pnpm test:contract`.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.contract.test.ts"],
    setupFiles: ["./vitest.contract.setup.ts"],
    testTimeout: 60_000
  }
})
