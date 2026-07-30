import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'build/**',
      'skills/**',
      'tests/**',
      'src/main/**',
      'src/renderer/**',
      'src/preload/**',
      'scripts/add-icon-padding.js',
      'scripts/check-source-artifacts.js',
      'scripts/prebuild-check.js',
      'scripts/release.js',
      'electron.vite.config.ts',
      'vite.renderer.config.ts',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: [
      'src/core/**/*.ts',
      'src/server/**/*.ts',
      'src/web/**/*.{ts,tsx}',
      'scripts/**/*.mjs',
      'examples/**/*.mjs',
      '*.config.{js,ts}',
    ],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        URL: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        AbortSignal: 'readonly',
        process: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'error',
    },
  },
  {
    files: ['tools/deepseek-session-connector/*.js'],
    languageOptions: {
      globals: {
        URL: 'readonly',
        TextDecoder: 'readonly',
        atob: 'readonly',
        chrome: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        navigator: 'readonly',
        window: 'readonly',
      },
    },
    rules: {
      'no-console': 'error',
    },
  },
)
