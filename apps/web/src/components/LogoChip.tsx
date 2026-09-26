import { cx } from './cx';

/** The ring-and-dot token, the only drawn shape in the brand. */
export function TokenMark() {
  return (
    <svg viewBox="0 0 36 36" aria-hidden="true" focusable="false">
      <circle cx="18" cy="18" r="14" fill="none" stroke="currentColor" strokeWidth="4" />
      <circle cx="18" cy="18" r="6" fill="currentColor" />
    </svg>
  );
}

/**
 * The logo: a GitHub label chip reading `good first token`, with the token
 * at its left. With `href` it is a link, as in the nav.
 */
export function LogoChip({ size, href }: { size?: 'lg'; href?: string }) {
  const className = cx('logo-chip', size === 'lg' && 'logo-chip--lg');
  const content = (
    <>
      <TokenMark />
      good first token
    </>
  );
  if (href) {
    return (
      <a className={className} href={href} aria-label="Good First Token home">
        {content}
      </a>
    );
  }
  return <span className={className}>{content}</span>;
}
