import type { AgentState } from "@agent-deck/domain";
import { CLASSIC_AGENT_STATE_COLOUR } from "./agent-palette.js";
import { dottedSpinnerSvg } from "./dotted-spinner.js";

export const AGENT_STATE_TRANSITION_MS = 650;

export interface AgentStateTransitionFrame {
  elapsedMs: number;
  from: AgentState;
}

interface AgentStateSnapshot {
  agentId: string;
  state: AgentState;
}

interface ActiveAgentStateTransition extends AgentStateSnapshot {
  from: AgentState;
  startedAt: number;
}

export class AgentStateTransitionTracker {
  private readonly snapshots = new Map<string, AgentStateSnapshot>();
  private readonly transitions = new Map<string, ActiveAgentStateTransition>();

  observe(
    targetId: string,
    agent: AgentStateSnapshot | undefined,
    now = Date.now(),
  ): AgentStateTransitionFrame | undefined {
    if (!agent) {
      this.clear(targetId);
      return undefined;
    }

    const previous = this.snapshots.get(targetId);
    this.snapshots.set(targetId, agent);
    if (!previous || previous.agentId !== agent.agentId)
      this.transitions.delete(targetId);
    else if (previous.state !== agent.state)
      this.transitions.set(targetId, {
        ...agent,
        from: previous.state,
        startedAt: now,
      });

    return this.frame(targetId, agent, now);
  }

  frame(
    targetId: string,
    agent: AgentStateSnapshot,
    now = Date.now(),
  ): AgentStateTransitionFrame | undefined {
    const transition = this.transitions.get(targetId);
    if (
      !transition ||
      transition.agentId !== agent.agentId ||
      transition.state !== agent.state
    ) {
      this.transitions.delete(targetId);
      return undefined;
    }

    const elapsedMs = Math.max(0, now - transition.startedAt);
    if (elapsedMs >= AGENT_STATE_TRANSITION_MS) {
      this.transitions.delete(targetId);
      return undefined;
    }
    return { elapsedMs, from: transition.from };
  }

  has(targetId: string): boolean {
    return this.transitions.has(targetId);
  }

  clear(targetId: string): void {
    this.snapshots.delete(targetId);
    this.transitions.delete(targetId);
  }
}

const stateSymbol: Record<Exclude<AgentState, "running">, string> = {
  idle: "-",
  waiting_for_input: "?",
  waiting_for_approval: "↻",
  ready_for_review: "✓",
  failed: "×",
  cancelled: "×",
  unknown: "?",
};

const number = (value: number): string => value.toFixed(2);

const stateIconSvg = (
  state: AgentState,
  animationElapsedMs: number,
  forceVisible = false,
): string => {
  if (state === "running") return dottedSpinnerSvg(animationElapsedMs);
  const opacity =
    !forceVisible &&
    (state === "failed" || state === "waiting_for_input") &&
    animationElapsedMs % 1_000 >= 600
      ? 0.12
      : 1;
  return `<text x="72" y="91" text-anchor="middle" font-family="system-ui" font-size="64" font-weight="700" fill="white" opacity="${opacity}">${stateSymbol[state]}</text>`;
};

const easeInCubic = (progress: number): number => progress ** 3;

const easeOutBack = (progress: number): number => {
  const overshoot = 1.70158;
  const shifted = progress - 1;
  return 1 + (overshoot + 1) * shifted ** 3 + overshoot * shifted ** 2;
};

export const agentStateIndicatorSvg = (
  state: AgentState,
  animationElapsedMs: number,
  transition?: AgentStateTransitionFrame,
): string => {
  if (
    !transition ||
    transition.from === state ||
    transition.elapsedMs >= AGENT_STATE_TRANSITION_MS
  )
    return stateIconSvg(state, animationElapsedMs);

  const progress = Math.max(
    0,
    Math.min(1, transition.elapsedMs / AGENT_STATE_TRANSITION_MS),
  );
  const outgoingEase = easeInCubic(progress);
  const outgoingScale = 1 - outgoingEase * 0.42;
  const outgoingOpacity = Math.max(0, 1 - progress * 1.5);
  const incomingProgress = Math.max(0, (progress - 0.08) / 0.92);
  const incomingScale = 0.48 + easeOutBack(incomingProgress) * 0.52;
  const incomingOpacity = Math.min(1, incomingProgress * 2.4);
  const burst = Math.sin(progress * Math.PI);
  const haloRadius = 18 + (1 - (1 - progress) ** 3) * 31;
  const accent = CLASSIC_AGENT_STATE_COLOUR[state];

  return `<g data-motion="agent-state-transition" data-progress="${number(progress)}">
    <circle cx="72" cy="72" r="${number(haloRadius)}" fill="none" stroke="${accent}" stroke-width="${number(1.5 + (1 - progress) * 2.5)}" opacity="${number(burst * 0.72)}"/>
    <g transform="translate(72 72) rotate(${number(-10 * outgoingEase)}) scale(${number(outgoingScale)}) translate(-72 -72)" opacity="${number(outgoingOpacity)}">
      ${stateIconSvg(transition.from, animationElapsedMs, true)}
    </g>
    <g transform="translate(72 72) scale(${number(incomingScale)}) translate(-72 -72)" opacity="${number(incomingOpacity)}">
      ${stateIconSvg(state, animationElapsedMs, true)}
    </g>
  </g>`;
};
