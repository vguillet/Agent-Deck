import type { Agent, Workspace } from "@agent-deck/domain";

export const isSubagent = (agent: Agent): boolean => agent.kind === "subagent";

export const streamDeckAgents = (
  agents: Agent[],
  showSubagents = false,
): Agent[] =>
  agents.filter(
    (agent) =>
      (!isSubagent(agent) ||
        (showSubagents &&
          (agent.state === "running" || agent.state === "recovering"))),
  );

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

export const orderAgentStack = (
  previous: Agent[],
  next: Agent[],
  workspaces: Workspace[],
): Agent[] => {
  const previousTopLevel = previous.filter((agent) => !isSubagent(agent));
  const previousSubagents = previous.filter(isSubagent);
  const nextTopLevel = next.filter((agent) => !isSubagent(agent));
  const nextSubagents = next.filter(isSubagent);

  return [
    ...sortAgentsByWorkspace(
      preserveAgentSlotOrder(previousTopLevel, nextTopLevel),
      workspaces,
    ),
    ...sortAgentsByWorkspace(
      preserveAgentSlotOrder(previousSubagents, nextSubagents),
      workspaces,
    ),
  ];
};
