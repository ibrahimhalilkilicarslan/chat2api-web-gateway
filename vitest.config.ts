import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'html'],
      exclude: ['src/web/**', 'src/main/proxy/adapters/**'],
    },
  },
})
