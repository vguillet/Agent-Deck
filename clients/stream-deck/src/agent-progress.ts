import type { Agent } from "@agent-deck/domain";
import {
  DARK_KEY_VISUAL_PALETTE,
  type KeyVisualPalette,
} from "./agent-palette.js";

const ACTIVE_STATES = new Set<Agent["state"]>([
  "running",
  "recovering",
  "waiting_for_input",
  "waiting_for_approval",
  "failed",
]);

export const agentProgressSvg = (
  progress: Agent["progress"],
  state: Agent["state"],
  palette: KeyVisualPalette = DARK_KEY_VISUAL_PALETTE,
): string => {
  if (!progress?.plan || !ACTIVE_STATES.has(state)) return "";
  const current = Math.min(
    progress.plan.total,
    progress.plan.completed +
      Number(progress.plan.completed < progress.plan.total),
  );
  const steps = `${current}/${progress.plan.total}`;
  return `<g>
    <rect x="47" y="103" width="49" height="30" rx="10" fill="${palette.progressSurface}" opacity="${palette.progressOpacity}"/>
    <text x="71.5" y="125" text-anchor="middle" font-family="system-ui" font-size="18" font-weight="650" fill="${palette.foreground}">${steps}</text>
  </g>`;
};
