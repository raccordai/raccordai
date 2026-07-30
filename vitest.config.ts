import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@main': resolve('src/main'),
      '@shared': resolve('src/shared'),
      '@renderer': resolve('src/renderer/src'),
      // Unit tests run outside an Electron app; main-process modules get a stub.
      electron: resolve('tests/mocks/electron.ts')
    }
  },
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      // Coverage is measured (and gated) on the logic that unit tests own.
      // UI components, IPC wiring and the kie.ai/Anthropic engines are covered
      // by the E2E mock harness (see docs/testing.md), not counted here.
      include: [
        'src/shared/**/*.ts',
        'src/main/services/projects.ts',
        'src/main/services/videos.ts',
        'src/main/services/graph.ts',
        'src/main/services/recipes.ts',
        'src/main/services/casting.ts',
        'src/main/services/scenarioGraph.ts',
        'src/main/services/graphHistory.ts',
        'src/main/services/genQueue.ts',
        'src/main/services/renderPlan.ts',
        'src/main/services/runPlanner.ts',
        'src/main/services/qcPlan.ts',
        'src/main/services/chatStore.ts',
        'src/main/services/chatCompaction.ts',
        'src/main/services/chatContext.ts',
        'src/main/services/chatToolAdapter.ts',
        'src/main/services/chatOpenAIFormat.ts',
        'src/main/services/chatStream.ts',
        'src/main/services/chatCache.ts',
        'src/main/services/logger.ts',
        'src/main/services/continuity.ts',
        'src/main/services/assets.ts',
        'src/main/services/backup.ts',
        'src/main/mcp/registry.ts',
        'src/main/mcp/docs.ts',
        'src/main/media/files.ts',
        'src/renderer/src/lib/errorReporter.ts',
        'src/renderer/src/lib/relativeTime.ts',
        'src/renderer/src/lib/shortcuts.ts',
        'src/renderer/src/lib/formatSeconds.ts',
        'src/renderer/src/lib/mentionToken.ts'
      ],
      // config.ts is a bare constant — nothing to test.
      exclude: ['**/*.test.ts', 'src/shared/config.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80
      }
    }
  }
})
