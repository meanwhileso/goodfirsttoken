import { createServerFn } from '@tanstack/react-start';
import { getRequest, getResponseHeaders } from '@tanstack/react-start/server';
import { failureReason } from '../auth/auth';
import { readSignedIn } from '../auth/session';
import { siteOrigin } from '../auth/settings';
import { endLapsedConnections, listConnections, type Connection } from './connections';

// Runs on the server for /me: the connected agents of the person the
// session names. The page sends no input. Nobody signed in has none. It
// first ends any of their connections whose grant ran out, so the list shows
// only agents that can still connect.
export const getConnectedAgents = createServerFn({ method: 'GET' }).handler(async (): Promise<Connection[]> => {
  const request = getRequest();
  const { signedIn, setCookies } = await readSignedIn(request);
  for (const cookie of setCookies) getResponseHeaders().append('set-cookie', cookie);
  if (!signedIn) return [];
  try {
    await endLapsedConnections(siteOrigin(request), signedIn.githubId, Date.now());
  } catch (error) {
    console.error(`Connections whose grants ran out weren't ended: ${failureReason(error)}`);
  }
  return listConnections(signedIn.githubId);
});
