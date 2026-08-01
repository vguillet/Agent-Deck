import {
  DARK_KEY_VISUAL_PALETTE,
  type KeyVisualPalette,
} from "./agent-palette.js";

export const subagentBackgroundSvg = (
  palette: KeyVisualPalette = DARK_KEY_VISUAL_PALETTE,
): string => `
  <defs>
    <pattern id="subagent-stripes" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="6" height="14" fill="${palette.stripe}" opacity="${palette.stripeOpacity}"/>
    </pattern>
  </defs>
  <rect width="144" height="144" fill="url(#subagent-stripes)" pointer-events="none"/>`;
