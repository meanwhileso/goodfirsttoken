import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { readSignedIn } from './session';

/** Who is looking at a page: the signed-in person's GitHub ID and login. Never their token. */
export interface Viewer {
  githubId: number;
  login: string;
}

// Runs on the server for every page load and navigation, from the root
// route. Any cookie Better Auth set while it checked the session goes back
// with the response.
export const getViewer = createServerFn({ method: 'GET' }).handler(async (): Promise<Viewer | null> => {
  const { signedIn, setCookies } = await readSignedIn(getRequest());
  if (setCookies.length > 0) setResponseHeader('set-cookie', setCookies);
  return signedIn && { githubId: signedIn.githubId, login: signedIn.login };
});
