import { REPO_URL } from './Nav';

const LINKS = [
  { href: '/start.md', label: 'start.md' },
  { href: '/llms.txt', label: 'llms.txt' },
  { href: '/projects.json', label: 'projects.json' },
  { href: '/design', label: 'design system' },
  { href: `${REPO_URL}/blob/main/LICENSE`, label: 'MIT' },
] as const;

/** The site footer, in mono. */
export function Footer() {
  return (
    <footer className="site-footer">
      <div className="wrap site-footer__inner">
        <span>good first token · a Meanwhile project</span>
        <nav aria-label="Footer">
          {LINKS.map((link) => (
            <a key={link.href} href={link.href}>
              {link.label}
            </a>
          ))}
        </nav>
      </div>
    </footer>
  );
}
