import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Contract tests talk to a real Forge and are run by hand, never in CI.
    // `pnpm test:contract` is what runs them.
    exclude: ["src/**/*.contract.test.ts"],
    // Pulling and booting a Postgres container the first time is slow.
    testTimeout: 60_000,
    hookTimeout: 180_000
  }
})
