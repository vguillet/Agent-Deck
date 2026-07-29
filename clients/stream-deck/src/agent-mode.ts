import type { Agent } from "@agent-deck/domain";

export type AgentMode = "ask" | "plan" | "debug";

export interface AgentModeStyle {
  colour: string;
  frameColour?: string;
  icon: AgentMode;
}

const styles: Record<AgentMode, AgentModeStyle> = {
  plan: { colour: "#f1b467", icon: "plan" },
  debug: { colour: "#e34671", icon: "debug" },
  ask: { colour: "#3fa266", frameColour: "#1c492e", icon: "ask" },
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

export const agentEdgeFrameSvg = (colour: string): string =>
  `<path d="M0 0H144V144H0Z M7 7H137V137H7Z" fill="${colour}" fill-rule="evenodd"/>`;

export const agentModeFrameSvg = (style: AgentModeStyle): string =>
  agentEdgeFrameSvg(style.frameColour ?? style.colour);
