import { createFileRoute } from '@tanstack/react-router';
import { handleDevWork } from '../dev/work';

// Local development only: works an issue as a sample person, through the
// issue's room. Anywhere else it answers 404 (src/dev/work.ts).
export const Route = createFileRoute('/dev/work')({
  server: {
    handlers: {
      ANY: ({ request }) => handleDevWork(request),
    },
  },
});
