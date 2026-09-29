// The notice a page with forms shows, as it rides in the page's address,
// with no imports, so pages can use it. src/auth/notice.ts signs it and
// checks the signature.

/** A notice and its signature, from the address a form sent the person back to. */
export interface NoticeParams {
  notice?: string;
  sig?: string;
}

/** The notice and its signature from a page's address, leaving out anything else. */
export function noticeParams(search: unknown): NoticeParams {
  if (typeof search !== 'object' || search === null) return {};
  const { notice, sig } = search as Record<string, unknown>;
  return {
    ...(typeof notice === 'string' ? { notice } : {}),
    ...(typeof sig === 'string' ? { sig } : {}),
  };
}
