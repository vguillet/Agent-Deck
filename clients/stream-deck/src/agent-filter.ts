import type { Agent, Workspace } from "@agent-deck/domain";

export const streamDeckAgents = (agents: Agent[]): Agent[] =>
  agents.filter((agent) => agent.freshness === "fresh" && !agent.archived);

export const sortAgentsByWorkspace = (
  agents: Agent[],
  workspaces: Workspace[],
): Agent[] => {
  const workspaceNames = new Map(
    workspaces.map((workspace) => [workspace.id, workspace.name]),
  );
  const collator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  });

  return agents
    .map((agent, index) => ({ agent, index }))
    .sort((left, right) => {
      const leftWorkspace = left.agent.workspaceId;
      const rightWorkspace = right.agent.workspaceId;
      if (!leftWorkspace || !rightWorkspace) {
        if (leftWorkspace) return -1;
        if (rightWorkspace) return 1;
        return left.index - right.index;
      }

      return (
        collator.compare(
          workspaceNames.get(leftWorkspace) ?? leftWorkspace,
          workspaceNames.get(rightWorkspace) ?? rightWorkspace,
        ) ||
        leftWorkspace.localeCompare(rightWorkspace) ||
        left.index - right.index
      );
    })
    .map(({ agent }) => agent);
};

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
