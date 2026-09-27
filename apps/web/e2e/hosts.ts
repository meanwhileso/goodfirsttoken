// The two origins the end-to-end tests run against. The site is the
// production build in `vite preview`. The static host is the stand-in in
// scripts/static-host.mjs, which serves the build's files the way the static
// host does. Its host differs from the site's, as it does in a deployment,
// since a browser sends a host's cookies to every port on it.
export const SITE = 'http://localhost:4173';
export const STATIC_HOST = 'http://127.0.0.1:4174';
