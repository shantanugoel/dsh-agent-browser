import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    testTimeout: 15_000,
    // The driver spawns real node fixtures; keep concurrency per-file.
    pool: "forks",
  },
});