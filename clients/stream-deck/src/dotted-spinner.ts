export const DOTTED_SPINNER_DOT_COUNT = 12;
export const DOTTED_SPINNER_CYCLE_MS = 1_200;

const number = (value: number): string => value.toFixed(2);

/**
 * A circular loading wave rendered as a static SVG frame.
 *
 * Stream Deck animations are produced by repeatedly replacing the key image,
 * so the current time is used to vary each dot's size and opacity.
 */
export const dottedSpinnerSvg = (elapsedMs: number): string => {
  const progress =
    ((elapsedMs % DOTTED_SPINNER_CYCLE_MS) / DOTTED_SPINNER_CYCLE_MS) *
    DOTTED_SPINNER_DOT_COUNT;

  const dots = Array.from({ length: DOTTED_SPINNER_DOT_COUNT }, (_, index) => {
    const angle =
      (index / DOTTED_SPINNER_DOT_COUNT) * Math.PI * 2 - Math.PI / 2;
    const distanceAroundRing = Math.abs(progress - index);
    const distance = Math.min(
      distanceAroundRing,
      DOTTED_SPINNER_DOT_COUNT - distanceAroundRing,
    );
    const emphasis = Math.max(0, 1 - distance / 2.5) ** 1.6;
    const radius = 3 + emphasis * 4.5;
    const opacity = 0.25 + emphasis * 0.75;

    return `<circle cx="${number(72 + Math.cos(angle) * 28)}" cy="${number(72 + Math.sin(angle) * 28)}" r="${number(radius)}" fill="white" opacity="${number(opacity)}"/>`;
  }).join("");

  return `<g data-motion="dotted-spinner">${dots}</g>`;
};
