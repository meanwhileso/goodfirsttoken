import { useId } from 'react';
import { LogoChip } from './LogoChip';

export const REPO_URL = 'https://github.com/meanwhileso/goodfirsttoken';

export type NavPage = 'live' | 'leaderboard' | 'projects' | 'maintainers' | 'me' | 'admin';

const LINKS: readonly { page: NavPage; href: string; label: string }[] = [
  { page: 'live', href: '/live', label: 'live' },
  { page: 'leaderboard', href: '/leaderboard', label: 'leaderboard' },
  { page: 'projects', href: '/projects', label: 'projects' },
  { page: 'maintainers', href: '/maintainers', label: 'maintainers' },
];

function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

/**
 * The site nav: the logo chip, lowercase mono links, and a round GitHub mark,
 * or the signed-in person's avatar and login. The current page gets a small
 * blue dot. When the nav is 880px wide or narrower, the links fold into a
 * menu that a checkbox opens, so it works before any script loads.
 */
export function Nav({
  current,
  user,
  admin = false,
  label = 'Primary',
}: {
  current?: NavPage;
  /** The signed-in person, if any. */
  user?: { login: string };
  /** Shows the admin link, for Good First Token's own admins. */
  admin?: boolean;
  label?: string;
}) {
  const id = useId();
  const toggle = `${id}-menu`;
  const links = `${id}-links`;
  const here = (page: NavPage) => (page === current ? 'page' : undefined);

  return (
    <header className="site-nav">
      <nav className="wrap site-nav__inner" aria-label={label}>
        <LogoChip href="/" />
        <input type="checkbox" id={toggle} className="site-nav__toggle" aria-label="Menu" aria-controls={links} />
        <label htmlFor={toggle} className="site-nav__menu">
          <span aria-hidden="true" />
        </label>
        <ul id={links} className="site-nav__links">
          {LINKS.map((link) => (
            <li key={link.page}>
              <a href={link.href} aria-current={here(link.page)}>
                {link.page === 'live' && <span className="dot dot--pulse" aria-hidden="true" />}
                {link.label}
              </a>
            </li>
          ))}
          {admin && (
            <li>
              <a href="/admin" aria-current={here('admin')}>
                admin
              </a>
            </li>
          )}
          <li>
            {user ? (
              <a className="site-nav__me" href="/me" aria-current={here('me')}>
                <span className="avatar" aria-hidden="true">
                  {user.login.charAt(0).toUpperCase()}
                </span>
                @{user.login}
              </a>
            ) : (
              <a className="site-nav__gh" href={REPO_URL} aria-label="Good First Token on GitHub">
                <GitHubMark />
              </a>
            )}
          </li>
        </ul>
      </nav>
    </header>
  );
}
