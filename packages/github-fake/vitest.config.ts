import { defineConfig } from 'vitest/config';

// The fake's own tests run in Node. apps/web runs it inside the Workers
// runtime too, in its own tests.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
