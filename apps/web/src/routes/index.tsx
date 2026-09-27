import { productName } from '@goodfirsttoken/core';
import { createFileRoute } from '@tanstack/react-router';
import { SiteNav } from '../auth/SiteNav';

// A placeholder until the homepage is built (#23). The design is in prototype/.
export const Route = createFileRoute('/')({
  component: Home,
});

function Home() {
  return (
    <>
      <SiteNav />
      <main className="wrap">
        <h1>{productName}</h1>
        <p>Spend your spare tokens on open source.</p>
        <p>
          Nothing is live yet. The site is being built in the open{' '}
          <a href="https://github.com/meanwhileso/goodfirsttoken">on GitHub</a>.
        </p>
      </main>
    </>
  );
}
