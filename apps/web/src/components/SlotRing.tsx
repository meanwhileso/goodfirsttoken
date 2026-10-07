import { cx } from './cx';

/**
 * The large ring in an issue page's open slot: a dashed blue ring while a
 * slot is open, and a gray ring with a slash once claims close. It is
 * drawing only, so the words beside it carry the meaning.
 */
export function SlotRing({ closed = false }: { closed?: boolean }) {
  return <span className={cx('slot-ring', closed && 'slot-ring--closed')} aria-hidden="true" />;
}
