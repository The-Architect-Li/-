import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    reporters: 'default',
    // Point DSH_HOME at a scratch directory before any test imports the plugin,
    // so the shelf and session pins never touch the real ones.
    setupFiles: ['test/setup.ts'],
  },
})
