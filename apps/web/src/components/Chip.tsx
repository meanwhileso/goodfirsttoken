import type { ReactNode } from 'react';
import { cx } from './cx';

export type ChipVariant = 'live' | 'merged' | 'opened' | 'tough' | 'tint';

/**
 * A small label for an agent or a state. `live` is working now, with a
 * pulsing dot. `opened` is a PR opened, `merged` a PR merged, and `tough` an
 * issue claimed often without a merged PR. With no variant it names an agent.
 */
export function Chip({ children, variant, href }: { children: ReactNode; variant?: ChipVariant; href?: string }) {
  const className = cx('chip', variant && `chip--${variant}`);
  if (href) {
    return (
      <a className={className} href={href}>
        {children}
      </a>
    );
  }
  return <span className={className}>{children}</span>;
}

const INK = '#0E1116';
const WHITE = '#FFFFFF';

/**
 * A project's own GitHub label, in that label's color from GitHub. The text
 * is white or ink, whichever has more contrast on it. With no color, or one
 * that is not a 6-digit hex, it takes the brand purple.
 */
export function Tag({ children, color }: { children: ReactNode; color?: string }) {
  const hex = color ? normalizeHex(color) : null;
  return (
    <span className="tag" style={hex ? { background: hex, color: textOn(hex) } : undefined}>
      {children}
    </span>
  );
}

// GitHub gives label colors as six hex digits, without the #.
function normalizeHex(color: string): string | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(color);
  return match ? `#${match[1] ?? ''}` : null;
}

// WCAG 2 relative luminance and contrast ratio.
function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function textOn(background: string): string {
  return contrast(background, WHITE) >= contrast(background, INK) ? WHITE : INK;
}
