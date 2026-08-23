import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Pulling and booting a Postgres container the first time is slow.
    testTimeout: 60_000,
    hookTimeout: 180_000
  }
})
