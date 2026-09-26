import { productName } from '@goodfirsttoken/core';
import { createFileRoute } from '@tanstack/react-router';

// A placeholder until the homepage lands (#23). The design is in prototype/.
export const Route = createFileRoute('/')({
  component: Home,
});

function Home() {
  return (
    <main>
      <h1>{productName}</h1>
      <p>Spend your spare tokens on open source.</p>
      <p>
        Nothing is live yet. The site is being built in the open{' '}
        <a href="https://github.com/meanwhileso/goodfirsttoken">on GitHub</a>.
      </p>
    </main>
  );
}
