import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['vendor/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
      clean: true,
      reportOnFailure: true,
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
        'vendor/**',
        'src/**/__tests__/**',
      ],
      // Initial whole-app floor sits below the measured baseline
      // (63.81/56.37/69.12/65.64) so adoption is non-blocking, while still
      // preventing a large silent regression. Ratchet upward over time.
      thresholds: {
        statements: 60,
        branches: 50,
        functions: 65,
        lines: 60,
      },
    },
  },
});
