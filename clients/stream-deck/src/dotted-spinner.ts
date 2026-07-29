export const DOTTED_SPINNER_DOT_COUNT = 12;
export const DOTTED_SPINNER_CYCLE_MS = 1_200;
export const DOTTED_SPINNER_COUNTER_CYCLE_MS = 2_400;
export const DOTTED_SPINNER_BREATH_MS = 3_600;

const number = (value: number): string => value.toFixed(2);

/**
 * Two counter-rotating circular loading waves rendered as a static SVG frame.
 *
 * Stream Deck animations are produced by repeatedly replacing the key image,
 * so the current time is used to vary each dot's size and opacity.
 */
export const dottedSpinnerSvg = (elapsedMs: number): string => {
  const clockwiseProgress =
    ((elapsedMs % DOTTED_SPINNER_CYCLE_MS) / DOTTED_SPINNER_CYCLE_MS) *
    DOTTED_SPINNER_DOT_COUNT;
  const counterClockwiseProgress =
    -(
      (elapsedMs % DOTTED_SPINNER_COUNTER_CYCLE_MS) /
      DOTTED_SPINNER_COUNTER_CYCLE_MS
    ) * DOTTED_SPINNER_DOT_COUNT;
  const breathPhase =
    ((elapsedMs % DOTTED_SPINNER_BREATH_MS) / DOTTED_SPINNER_BREATH_MS) *
      Math.PI *
      2 -
    Math.PI / 2;
  const scale = 0.68 + ((Math.sin(breathPhase) + 1) / 2) * 0.32;

  const dots = Array.from({ length: DOTTED_SPINNER_DOT_COUNT }, (_, index) => {
    const angle =
      (index / DOTTED_SPINNER_DOT_COUNT) * Math.PI * 2 - Math.PI / 2;
    const emphasisFor = (progress: number): number => {
      const distanceAroundRing =
        Math.abs(progress - index) % DOTTED_SPINNER_DOT_COUNT;
      const distance = Math.min(
        distanceAroundRing,
        DOTTED_SPINNER_DOT_COUNT - distanceAroundRing,
      );
      return Math.max(0, 1 - distance / 2.5) ** 1.6;
    };
    const clockwiseEmphasis = emphasisFor(clockwiseProgress);
    const counterClockwiseEmphasis = emphasisFor(counterClockwiseProgress);
    const emphasis = clockwiseEmphasis + counterClockwiseEmphasis;
    // Keep the slower wave's outside edge fixed so it grows toward the centre.
    const ringRadius = 28 - counterClockwiseEmphasis * 4.5;
    const radius = 3 + emphasis * 4.5;
    const opacity = Math.min(1, 0.25 + emphasis * 0.75);

    return `<circle cx="${number(72 + Math.cos(angle) * ringRadius)}" cy="${number(72 + Math.sin(angle) * ringRadius)}" r="${number(radius)}" fill="white" opacity="${number(opacity)}"/>`;
  }).join("");

  return `<g data-motion="dotted-spinner" data-scale="${number(scale)}" transform="translate(72 72) scale(${number(scale)}) translate(-72 -72)">${dots}</g>`;
};
