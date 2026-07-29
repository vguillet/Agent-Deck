import type { AgentState } from "@agent-deck/domain";

export const CLASSIC_AGENT_STATE_COLOUR: Readonly<Record<AgentState, string>> =
  {
    idle: "#64748b",
    running: "#2563eb",
    waiting_for_input: "#f59e0b",
    waiting_for_approval: "#f97316",
    ready_for_review: "#10b981",
    failed: "#dc2626",
    cancelled: "#64748b",
    unknown: "#475569",
  };

export const CLASSIC_EMPTY_AGENT_COLOUR = "#000000";
