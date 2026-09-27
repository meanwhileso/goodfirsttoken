import { createFileRoute } from '@tanstack/react-router';
import { handleDevSeed } from '../dev/seed';

// Local development only: `pnpm seed` posts here to give the local site its
// sample projects and work. Anywhere else it answers 404 (src/dev/seed.ts).
export const Route = createFileRoute('/dev/seed')({
  server: {
    handlers: {
      ANY: ({ request }) => handleDevSeed(request),
    },
  },
});
