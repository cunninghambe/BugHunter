import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import importPlugin from 'eslint-plugin-import';

const TYPE_AWARE = process.env.ESLINT_FAST !== '1';

const typeAwareRules = TYPE_AWARE ? {
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/no-misused-promises': 'error',
  '@typescript-eslint/await-thenable': 'error',
  '@typescript-eslint/require-await': 'warn',
  '@typescript-eslint/no-unsafe-assignment': 'warn',
  '@typescript-eslint/no-unsafe-call': 'warn',
  '@typescript-eslint/no-unsafe-return': 'warn',
  '@typescript-eslint/no-unsafe-member-access': 'warn',
  '@typescript-eslint/no-unsafe-argument': 'warn',
  '@typescript-eslint/no-unnecessary-condition': 'warn',
  '@typescript-eslint/prefer-nullish-coalescing': 'warn',
  '@typescript-eslint/prefer-optional-chain': 'warn',
  '@typescript-eslint/strict-boolean-expressions': ['error', {
    allowString: false,
    allowNumber: false,
    allowNullableObject: false,
    allowNullableBoolean: false,
    allowNullableString: false,
    allowNullableNumber: false,
    allowAny: false,
  }],
} : {};

export default [
  // In fast mode, disable reporting of unused-disable-directives (some disables target type-aware rules that are off in fast mode)
  ...(TYPE_AWARE ? [] : [{ linterOptions: { reportUnusedDisableDirectives: false } }]),
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
      '**/web-vitals-vendored/**',
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
        ...(TYPE_AWARE ? {
          project: ['./packages/cli/tsconfig.json', './packages/mcp/tsconfig.json'],
          tsconfigRootDir: import.meta.dirname,
        } : {}),
      },
      globals: {
        console: 'readonly', process: 'readonly', Buffer: 'readonly',
        __dirname: 'readonly', __filename: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly',
        setImmediate: 'readonly',
        URL: 'readonly', URLSearchParams: 'readonly',
        AbortController: 'readonly', AbortSignal: 'readonly',
        fetch: 'readonly', Response: 'readonly', Request: 'readonly',
        Headers: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly',
      },
    },
    settings: {
      'import/resolver': {
        typescript: {
          project: ['./packages/cli/tsconfig.json', './packages/mcp/tsconfig.json'],
          noWarnOnMultipleProjects: true,
        },
        node: true,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      import: importPlugin,
    },
    rules: {
      // Disable JS rules superseded by TS
      'no-unused-vars': 'off',
      'no-undef': 'off',
      'no-redeclare': 'off',
      'no-dupe-class-members': 'off',

      // ── Phase 1 baseline (unchanged from Phase 1 PR) ────────────
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

      // Phase 1 added rules (carry forward)
      'no-throw-literal': 'error',
      'no-return-await': 'error',
      'no-promise-executor-return': 'error',
      'no-async-promise-executor': 'error',
      'no-self-compare': 'error',
      'no-unmodified-loop-condition': 'error',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/consistent-type-imports': ['warn', {
        prefer: 'type-imports',
        fixStyle: 'separate-type-imports',
      }],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',
      'prefer-template': 'warn',
      'object-shorthand': 'warn',
      'no-useless-catch': 'error',

      // ── Phase 2 type-aware rules (gated by ESLINT_FAST) ─────────
      ...typeAwareRules,

      // ── Imports plugin (always on; not type-aware) ──────────────
      'import/no-cycle': ['error', { maxDepth: 10 }],
      'import/no-self-import': 'error',
      // import/order intentionally deferred
    },
  },
];
