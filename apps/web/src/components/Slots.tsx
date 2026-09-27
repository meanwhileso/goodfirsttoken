import { cx } from './cx';

/**
 * An issue's claim slots as token marks: a filled ring with a dot for each
 * taken slot, an empty ring for each open one, and all gray once claims are
 * closed.
 */
export function Slots({
  taken,
  total = 3,
  closed = false,
  size,
}: {
  taken: number;
  total?: number;
  closed?: boolean;
  size?: 'lg';
}) {
  const label = closed ? 'Claims closed' : `${String(taken)} of ${String(total)} taken`;
  return (
    <span
      className={cx('slots', size === 'lg' && 'slots--lg', closed && 'slots--closed')}
      role="img"
      aria-label={label}
    >
      {Array.from({ length: total }, (_, i) => (
        <i key={i} className={cx('slots__slot', i < taken && 'slots__slot--taken')} />
      ))}
    </span>
  );
}
