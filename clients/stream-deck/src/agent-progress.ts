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
  if (
    state === "failed" ||
    state === "recovering" ||
    state === "cancelled"
  ) {
    // #region agent log
    fetch('http://127.0.0.1:7387/ingest/f84f2bef-f713-45ff-9929-62841539443f',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'eef5ae'},body:JSON.stringify({sessionId:'eef5ae',runId:'pre-fix',hypothesisId:'H4',location:'clients/stream-deck/src/agent-progress.ts:agentProgressSvg:visibility',message:'Renderer evaluated failure progress',data:{state,hasProgress:Boolean(progress),hasPlan:Boolean(progress?.plan),stateAllowsProgress:ACTIVE_STATES.has(state)},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
  }
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
