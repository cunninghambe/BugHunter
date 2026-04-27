import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/.next/**',
      '**/.bughunter/**',
      'fixtures/**',
      'packages/cli/tests/e2e/fixtures/**',
      '**/*.test.ts',
    ],
  },
  js.configs.recommended,
  {
    files: ['packages/*/src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        fetch: 'readonly',
        Response: 'readonly',
        Request: 'readonly',
        Headers: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      // Disable JS rules superseded by TS or that conflict with TS syntax
      'no-unused-vars': 'off',
      'no-undef': 'off',
      'no-redeclare': 'off',
      'no-dupe-class-members': 'off',

      // ── Existing baseline ───────────────────────────────────────
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-debugger': 'error',
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',

      // ── Async / promise correctness (syntax-only) ───────────────
      'no-throw-literal': 'error',
      'no-return-await': 'error',
      'no-promise-executor-return': 'error',
      'no-async-promise-executor': 'error',

      // ── Code correctness ────────────────────────────────────────
      'no-self-compare': 'error',
      'no-unmodified-loop-condition': 'error',
      // require-atomic-updates intentionally omitted: too many sequential-orchestration false positives
      '@typescript-eslint/no-non-null-assertion': 'warn', // see Option A/B in spec
      '@typescript-eslint/consistent-type-imports': ['warn', {
        prefer: 'type-imports',
        fixStyle: 'separate-type-imports',
      }],

      // ── Security ────────────────────────────────────────────────
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',

      // ── Style / clarity ─────────────────────────────────────────
      'prefer-template': 'warn',
      'object-shorthand': 'warn',
      'no-useless-catch': 'error',
    },
  },
];
