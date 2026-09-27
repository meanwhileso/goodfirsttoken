import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// A spec that loads `test` from Playwright itself skips the cookie check in
// apps/web/e2e/fixtures.ts.
const PLAYWRIGHT_TEST = {
  selector:
    ':matches(CallExpression[callee.name="require"], ImportExpression) > Literal[value=/^(@playwright\\u002Ftest|playwright\\u002Ftest)$/]',
  message: 'Import test from ./fixtures, which checks every cookie the tests see.',
};

// Two options tell the cookie check which cookies to accept and which
// origins are the site's. Only cookies.spec.ts may set them, to show the
// check reports bad cookies. Anywhere else they would let a bad cookie pass.
const COOKIE_OPTIONS = /^(expectedCookieProblems|cookieHosts)$/;
const COOKIE_OPTION_NAMES = ['Identifier[name=', 'Literal[value=', 'TemplateElement[value.raw='].map((node) => ({
  selector: `${node}${String(COOKIE_OPTIONS)}]`,
  message: 'Only cookies.spec.ts may set the cookie check\'s options. Anywhere else they would let a bad cookie pass.',
}));

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
      'no-restricted-syntax': ['error', PLAYWRIGHT_TEST, ...COOKIE_OPTION_NAMES],
    },
  },
  {
    // The spec that shows the cookie check reports bad cookies, the one
    // place its options may be set.
    files: ['apps/web/e2e/cookies.spec.ts'],
    rules: {
      'no-restricted-syntax': ['error', PLAYWRIGHT_TEST],
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    rules: {
      // A route sends someone elsewhere by throwing TanStack Router's
      // redirect(), which is a Response, and answers 404 by throwing its
      // notFound().
      '@typescript-eslint/only-throw-error': [
        'error',
        {
          allow: [
            { from: 'package', package: '@tanstack/router-core', name: 'Redirect' },
            { from: 'package', package: '@tanstack/router-core', name: 'NotFoundError' },
          ],
        },
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
