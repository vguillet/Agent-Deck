import type { CanonicalEventType } from "@agent-deck/domain";

export const REFRESH_RESOURCES = [
  "agents",
  "attention",
  "providers",
  "workspaces",
  "health",
] as const;

export type RefreshResource = (typeof REFRESH_RESOURCES)[number];

export const allRefreshResources = (): Set<RefreshResource> =>
  new Set(REFRESH_RESOURCES);

export const addRefreshResources = (
  target: Set<RefreshResource>,
  resources: Iterable<RefreshResource>,
): void => {
  for (const resource of resources) target.add(resource);
};

export const refreshResourcesForEvent = (
  type: CanonicalEventType,
): Set<RefreshResource> => {
  if (type === "provider.health.changed")
    return new Set(["providers", "attention", "health"]);
  if (type === "workspace.upserted") return new Set(["workspaces"]);
  if (type === "attention.opened" || type === "attention.resolved")
    return new Set(["attention"]);
  if (
    type === "agent.upserted" ||
    type === "agent.state.changed" ||
    type === "agent.freshness.changed" ||
    type === "run.upserted" ||
    type === "run.state.changed"
  )
    return new Set(["agents", "attention"]);
  return new Set();
};

export const actionManifestIdsForResources = (
  resources: ReadonlySet<RefreshResource>,
): Set<string> => {
  const actionIds = new Set<string>();
  if (resources.has("agents")) {
    actionIds.add("com.agentdeck.monitor.agent-slot");
    actionIds.add("com.agentdeck.monitor.agent-summary");
    actionIds.add("com.agentdeck.monitor.system-health");
  }
  if (resources.has("attention"))
    actionIds.add("com.agentdeck.monitor.attention");
  if (resources.has("providers")) {
    actionIds.add("com.agentdeck.monitor.provider-health");
    actionIds.add("com.agentdeck.monitor.system-health");
  }
  if (resources.has("workspaces"))
    actionIds.add("com.agentdeck.monitor.agent-slot");
  if (resources.has("health"))
    actionIds.add("com.agentdeck.monitor.system-health");
  return actionIds;
};
