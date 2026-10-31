import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    globalSetup: ["src/test/global-setup.ts"],
    // Tests share one database, so files must run sequentially.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
