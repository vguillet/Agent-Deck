import {
  DARK_KEY_VISUAL_PALETTE,
  type KeyVisualPalette,
} from "./agent-palette.js";

export const BRING_UP_ANIMATION_MS = 560;
export const BRING_UP_KEY_STAGGER_MS = 120;

export interface BringUpPosition {
  index: number;
  total: number;
  delayMs?: number;
}

const clamp = (value: number, minimum = 0, maximum = 1): number =>
  Math.max(minimum, Math.min(maximum, value));

const number = (value: number): string => value.toFixed(3);

const easeOutBack = (progress: number): number => {
  const overshoot = 1.70158;
  const shifted = progress - 1;
  return 1 + (overshoot + 1) * shifted ** 3 + overshoot * shifted ** 2;
};

const escapeAttribute = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

export const bringUpDelayMs = (position: BringUpPosition): number => {
  if (position.delayMs !== undefined) return Math.max(0, position.delayMs);
  const { index, total } = position;
  if (total <= 1) return 0;
  return Math.round(clamp(index, 0, total - 1) * BRING_UP_KEY_STAGGER_MS);
};

export const bringUpSequenceDurationMs = (total: number): number =>
  BRING_UP_ANIMATION_MS + Math.max(0, total - 1) * BRING_UP_KEY_STAGGER_MS;

export const bringUpProgress = (
  elapsedMs: number,
  position: BringUpPosition,
): number => {
  const delayMs = bringUpDelayMs(position);
  return clamp((elapsedMs - delayMs) / BRING_UP_ANIMATION_MS);
};

export const bringUpImage = (
  image: string,
  elapsedMs: number,
  position: BringUpPosition,
  previousImage?: string,
  palette: KeyVisualPalette = DARK_KEY_VISUAL_PALETTE,
): string => {
  const progress = bringUpProgress(elapsedMs, position);
  const eased = easeOutBack(progress);
  const scale = 0.7 + eased * 0.3;
  const opacity = clamp(progress * 2.5);
  const previousOpacity = 1 - clamp(progress * 2);
  const lift = (1 - progress) ** 2 * 18;
  const size = 144 * scale;
  const x = (144 - size) / 2;
  const y = (144 - size) / 2 + lift;
  const burst = Math.sin(progress * Math.PI);
  const haloRadius = 34 + progress * 54;

  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
      <rect width="144" height="144" fill="${palette.bringUpSurface}"/>
      ${previousImage ? `<image href="${escapeAttribute(previousImage)}" width="144" height="144" opacity="${number(previousOpacity)}"/>` : ""}
      <circle cx="72" cy="${number(72 + lift * 0.35)}" r="${number(haloRadius)}" fill="none" stroke="${palette.bringUpHalo}" stroke-width="${number(1.5 + (1 - progress) * 3)}" opacity="${number(burst * 0.72)}"/>
      <image href="${escapeAttribute(image)}" x="${number(x)}" y="${number(y)}" width="${number(size)}" height="${number(size)}" opacity="${number(opacity)}"/>
    </svg>`,
  )}`;
};
