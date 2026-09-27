import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { loadHome, type HomeData } from './load';

export type { HelpProject, HomeData } from './load';

// Runs on the server when the homepage loads, and when someone navigates to
// it. It reads no cookie and sets none.
export const getHome = createServerFn({ method: 'GET' }).handler((): Promise<HomeData> => loadHome(getRequest()));
