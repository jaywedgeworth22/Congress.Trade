export default {
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
        'src/**/__tests__/**',
      ],
      // No coverage threshold set yet — establish a baseline first, then
      // ratchet up across the codebase module by module.
    },
  },
};
