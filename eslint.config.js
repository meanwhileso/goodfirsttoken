import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  {
    ignores: [
      '**/node_modules/',
      '**/dist/',
      '**/.wrangler/',
      '**/routeTree.gen.ts',
      '**/worker-configuration.d.ts',
      '**/test-results/',
      '**/playwright-report/',
      // Static reference pages, deleted route by route as the real ones are built.
      'prototype/',
    ],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: [
          './apps/web/tsconfig.json',
          './apps/web/tsconfig.node.json',
          './packages/core/tsconfig.json',
          './packages/github-fake/tsconfig.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.{js,mjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },
  {
    // Callbacks passed to page.evaluate run in the browser.
    files: ['video/capture.mjs'],
    languageOptions: { globals: globals.browser },
  },
  {
    // e2e/fixtures.ts checks every cookie the tests see, but only for tests
    // that use its `test`. Playwright runs specs with any of these
    // extensions, and both packages export the same `test`, as a named
    // export and as the default.
    files: ['apps/web/e2e/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
    ignores: ['apps/web/e2e/fixtures.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['@playwright/test', 'playwright/test'].map((name) => ({
            name,
            importNames: ['test', 'default'],
            message: 'Import test from ./fixtures, which checks every cookie the tests see.',
          })),
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            ':matches(CallExpression[callee.name="require"], ImportExpression) > Literal[value=/^(@playwright\\u002Ftest|playwright\\u002Ftest)$/]',
          message: 'Import test from ./fixtures, which checks every cookie the tests see.',
        },
      ],
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@goodfirsttoken/github-fake', '@goodfirsttoken/github-fake/*', '**/packages/github-fake/**'],
              message: 'The GitHub fake is for tests and local development, and never ships in the Worker.',
            },
          ],
        },
      ],
    },
  },
]);
