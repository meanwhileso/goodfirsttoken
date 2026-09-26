/** How much work a square stands for: 0 for none up to 4, or a merge. */
export type TokenSquare = 0 | 1 | 2 | 3 | 4 | 'merged';

/**
 * A grid of rounded squares, one for each unit of agent work, darker purple
 * for more and green for a merge. The square at `flash` pulses once, and
 * pulses again each time `flash.count` changes.
 */
export function TokenField({
  squares,
  cols = 14,
  flash,
}: {
  squares: readonly TokenSquare[];
  cols?: number;
  flash?: { index: number; count: number };
}) {
  return (
    <div className="token-field" style={{ gridTemplateColumns: `repeat(${String(cols)}, 1fr)` }} aria-hidden="true">
      {squares.map((level, i) => {
        const flashing = flash?.index === i;
        return (
          <i
            key={flashing ? `${String(i)}-${String(flash.count)}` : i}
            data-level={level}
            className={flashing ? 'flash' : undefined}
          />
        );
      })}
    </div>
  );
}
