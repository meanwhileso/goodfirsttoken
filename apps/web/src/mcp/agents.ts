import { createServerFn } from '@tanstack/react-start';
import { getRequest, getResponseHeaders } from '@tanstack/react-start/server';
import { readSignedIn } from '../auth/session';
import { listConnections, type Connection } from './connections';

// Runs on the server for /me: the signed-in person's connected agents, from
// their own session, never from anything the page sends. Nobody signed in
// has none.
export const getConnectedAgents = createServerFn({ method: 'GET' }).handler(async (): Promise<Connection[]> => {
  const { signedIn, setCookies } = await readSignedIn(getRequest());
  for (const cookie of setCookies) getResponseHeaders().append('set-cookie', cookie);
  return signedIn ? listConnections(signedIn.githubId) : [];
});
