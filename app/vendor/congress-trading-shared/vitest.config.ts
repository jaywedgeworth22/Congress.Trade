import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      thresholds: {
        statements: 85,
        branches: 70,
        functions: 80,
        lines: 85,
      },
    },
  },
});
