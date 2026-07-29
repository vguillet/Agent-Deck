import type { Agent } from "@agent-deck/domain";

export const streamDeckAgents = (agents: Agent[]): Agent[] =>
  agents.filter((agent) => !agent.archived);

export const preserveAgentSlotOrder = (
  previous: Agent[],
  next: Agent[],
): Agent[] => {
  const nextById = new Map(next.map((agent) => [agent.id, agent]));
  const previousIds = new Set(previous.map((agent) => agent.id));

  return [
    ...previous.flatMap((agent) => {
      const updated = nextById.get(agent.id);
      return updated ? [updated] : [];
    }),
    ...next.filter((agent) => !previousIds.has(agent.id)),
  ];
};
