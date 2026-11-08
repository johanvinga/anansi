import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    globalSetup: ["src/test/global-setup.ts"],
    // Tests share one database, so files must run sequentially.
    fileParallelism: false,
    // The default fork pool crashes a worker on Windows during the full run; threads are stable.
    pool: "threads",
    testTimeout: 20_000,
  },
});
