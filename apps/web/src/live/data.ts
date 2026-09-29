import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { loadLive, type LivePage } from './load';

export type { LivePage } from './load';

// Runs on the server when /live loads, and when someone navigates to it. It
// reads no cookie and sets none.
export const getLive = createServerFn({ method: 'GET' }).handler((): Promise<LivePage> => loadLive(getRequest()));
