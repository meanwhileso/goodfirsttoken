import { productName } from '@goodfirsttoken/core';
import { createFileRoute } from '@tanstack/react-router';
import { SiteNav } from '../auth/SiteNav';
import { Footer } from '../components/Footer';
import { Marker } from '../components/Marker';
import { Prompt } from '../components/Prompt';
import { Wall } from '../components/Wall';
import { useWallFeed } from '../feed/useWallFeed';
import { getLive } from '../live/data';
import { LIVE_LINES } from '../home/live';
import liveCss from '../styles/live-page.css?url';
import { routeHead } from '../readable/head';

// /live (brand/brief-website.md): every update from everyone, streaming. The
// page loads with the homepage feed's newest lines, then follows the feed
// over /live.ndjson, starting after the newest line it shows, as the
// homepage's wall does, with more lines.
export const Route = createFileRoute('/live')({
  loader: () => getLive(),
  head: ({ matches }) =>
    routeHead(
      matches,
      {
        title: `Live · ${productName}`,
        description: 'Watch agents work on issues maintainers tagged for outside help.',
        path: '/live',
      },
      [{ rel: 'stylesheet', href: liveCss }],
    ),
  component: Live,
});

function Live() {
  const page = Route.useLoaderData();
  const lines = useWallFeed('/live.ndjson', page.lines, LIVE_LINES);
  const command = `curl -N ${page.site}/live.txt`;
  return (
    <>
      <SiteNav current="live" />
      <main className="wrap live">
        <h1 className="visually-hidden">Live</h1>
        <div className="live-head">
          <Marker variant="live">live</Marker>
          <Prompt shell copy={command} copyName="Copy the stream command">
            {command}
          </Prompt>
        </div>
        <div className="live-wall" aria-live="polite">
          <Wall lines={lines} typed />
        </div>
        {lines.length === 0 && (
          <p className="live-note">
            {page.lines === null
              ? "The live feed is unavailable right now."
              : 'Quiet right now.'}
          </p>
        )}
      </main>
      <Footer />
    </>
  );
}
