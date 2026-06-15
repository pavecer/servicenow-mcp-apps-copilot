import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globals: false,
    setupFiles: ["test/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/functions/**",      // Azure Functions HTTP wrappers (integration territory)
        "src/server.ts",         // Standalone bootstrap
        "src/types/**"
      ]
    }
  }
});
