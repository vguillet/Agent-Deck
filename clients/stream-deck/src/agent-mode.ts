import type { Agent } from "@agent-deck/domain";

export type AgentMode = "ask" | "plan" | "debug";

export interface AgentModeStyle {
  colour: string;
  icon: AgentMode;
}

const styles: Record<AgentMode, AgentModeStyle> = {
  plan: { colour: "#f1b467", icon: "plan" },
  debug: { colour: "#e34671", icon: "debug" },
  ask: { colour: "#3fa266", icon: "ask" },
};

export const agentModeStyle = (
  agent: Pick<Agent, "providerId" | "metadata">,
): AgentModeStyle | undefined => {
  const legacyCursorMode = agent.providerId.toLowerCase().includes("cursor")
    ? agent.metadata.cursorMode
    : undefined;
  const mode = agent.metadata.agentMode ?? legacyCursorMode;
  return typeof mode === "string" && mode in styles
    ? styles[mode as AgentMode]
    : undefined;
};
