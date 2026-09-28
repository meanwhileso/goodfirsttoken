import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { PermissionRefused, requirePermission } from './permissions';
import { readSignedIn } from './session';

/**
 * Who is looking at a page: the signed-in person's GitHub ID and login, and
 * whether they are one of Good First Token's admins, for the nav's admin
 * link. Never their token.
 */
export interface Viewer {
  githubId: number;
  login: string;
  admin: boolean;
}

// Runs on the server for every page load and navigation, from the root
// route. Any cookie Better Auth set while it checked the session goes back
// with the response.
export const getViewer = createServerFn({ method: 'GET' }).handler(async (): Promise<Viewer | null> => {
  const { signedIn, setCookies } = await readSignedIn(getRequest());
  if (setCookies.length > 0) setResponseHeader('set-cookie', setCookies);
  if (!signedIn) return null;
  const caller = { githubId: signedIn.githubId, login: signedIn.login, gitHubToken: () => Promise.resolve(null) };
  let admin = true;
  try {
    await requirePermission(caller, 'review_projects');
  } catch (error) {
    if (!(error instanceof PermissionRefused)) throw error;
    admin = false;
  }
  return { githubId: signedIn.githubId, login: signedIn.login, admin };
});
