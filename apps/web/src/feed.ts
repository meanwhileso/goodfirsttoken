// Throwaway demo for #39: a high-severity Semgrep finding. Never merge.
export async function loadFeed(): Promise<Response> {
  return fetch('http://example.com/feed.json');
}
