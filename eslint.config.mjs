import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

// Tailwind hue scales are banned in favour of the pastel tokens declared in
// src/renderer/src/styles.css (accent / highlight / accent-soft / success /
// danger / warning). Only the neutral scale is allowed raw.
const RAW_COLOR_CLASS =
  /\b(?:bg|text|border|ring|outline|fill|stroke|from|via|to|divide|shadow|accent|caret|decoration)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|stone)-\d{2,3}\b/
    .source

const RAW_COLOR_MESSAGE =
  'Raw Tailwind color class — use the pastel tokens from styles.css (accent, highlight, accent-soft, success, danger, warning) instead.'

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'dist/**',
      'coverage/**',
      'drizzle/**',
      'build/**',
      '.tmp-*',
      'src/renderer/src/routeTree.gen.ts'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      // React-compiler-era rules (new in react-hooks v7): the existing timeline
      // engine reads refs during render by design. Revisit when adopting the
      // React Compiler; rules-of-hooks and exhaustive-deps stay active.
      'react-hooks/refs': 'off',
      'react-hooks/set-state-in-effect': 'off'
    }
  },
  {
    // Node scripts (build tooling, E2E drivers) — not part of the app bundles.
    // Browser globals too: playwright evaluate() callbacks run in the renderer.
    files: ['scripts/**/*.{mjs,cjs,js}', 'e2e/**/*.mjs', '*.{mjs,cjs}', '.*.cjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } }
  },
  {
    // Renderer only: encode the "no raw colors" rule from CLAUDE.md.
    files: ['src/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: `Literal[value=/${RAW_COLOR_CLASS}/]`,
          message: RAW_COLOR_MESSAGE
        },
        {
          selector: `TemplateElement[value.raw=/${RAW_COLOR_CLASS}/]`,
          message: RAW_COLOR_MESSAGE
        }
      ]
    }
  }
)
