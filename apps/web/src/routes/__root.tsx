import { productName } from '@goodfirsttoken/core';
import { createRootRoute, HeadContent, Outlet, Scripts } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import markUrl from '../assets/mark.svg?url';
import geistMonoUrl from '../fonts/GeistMono-Variable.woff2?url';
import geistUrl from '../fonts/Geist-Variable.woff2?url';
import appCss from '../styles/app.css?url';

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: productName },
    ],
    links: [
      // The fonts are preloaded so text first paints in Geist.
      { rel: 'preload', href: geistUrl, as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' },
      { rel: 'preload', href: geistMonoUrl, as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' },
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', href: markUrl, type: 'image/svg+xml' },
    ],
  }),
  component: () => (
    <RootDocument>
      <Outlet />
    </RootDocument>
  ),
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
