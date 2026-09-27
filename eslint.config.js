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
    files: ['apps/web/src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    rules: {
      // A route sends someone elsewhere by throwing TanStack Router's
      // redirect(), which is a Response.
      '@typescript-eslint/only-throw-error': [
        'error',
        { allow: [{ from: 'package', package: '@tanstack/router-core', name: 'Redirect' }] },
      ],
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
