import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";

export const AGENT_STATES = [
  "idle",
  "running",
  "waiting_for_input",
  "waiting_for_approval",
  "ready_for_review",
  "failed",
  "cancelled",
  "unknown",
] as const;

export type AgentState = (typeof AGENT_STATES)[number];
export type AgentKind = "top_level" | "subagent";

export const RUN_STATES = [
  "queued",
  "running",
  "waiting_for_input",
  "waiting_for_approval",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
] as const;

export type RunState = (typeof RUN_STATES)[number];
export const AGENT_PROGRESS_ACTIVITIES = [
  "planning",
  "exploring",
  "researching",
  "editing",
  "executing",
  "delegating",
  "waiting",
  "working",
] as const;

export type AgentProgressActivity = (typeof AGENT_PROGRESS_ACTIVITIES)[number];

export interface AgentProgress {
  activity: AgentProgressActivity;
  plan?: {
    completed: number;
    total: number;
  };
  observedAt: string;
}

export type ProviderHealthStatus =
  "starting" | "healthy" | "degraded" | "unhealthy" | "stopped";
export type AttentionType =
  "input" | "approval" | "review" | "failure" | "provider_health";
export type AttentionSeverity = "info" | "warning" | "critical";

export interface ProviderCapabilities {
  discovery: boolean;
  discoveryMode?: "poll" | "startup";
  liveEvents: boolean;
  commands: string[];
}

export interface Provider {
  id: string;
  displayName: string;
  version: string;
  health: ProviderHealthStatus;
  healthMessage?: string;
  lastCheckedAt?: string;
  consecutiveFailures: number;
  capabilities: ProviderCapabilities;
}

export interface Workspace {
  id: string;
  providerId: string;
  externalId: string;
  name: string;
  metadata: Record<string, unknown>;
}

export interface Project {
  id: string;
  providerId: string;
  externalId: string;
  workspaceId?: string;
  name: string;
  metadata: Record<string, unknown>;
}

export interface AgentCapabilities {
  messages: boolean;
  approvals: boolean;
  cancellation: boolean;
  creation: boolean;
}

export interface AgentLink {
  rel: "focus" | "view";
  label: string;
  href: string;
}

export interface Agent {
  id: string;
  providerId: string;
  externalId: string;
  title: string;
  kind?: AgentKind;
  parentAgentId?: string;
  projectId?: string;
  workspaceId?: string;
  state: AgentState;
  activityEpoch: string;
  activeRunId?: string;
  requiresAttention: boolean;
  lastActivityAt: string;
  revision: number;
  sourceRevision?: number;
  progress?: AgentProgress;
  capabilities: AgentCapabilities;
  links: AgentLink[];
  metadata: Record<string, unknown>;
}

export interface AgentRun {
  id: string;
  agentId: string;
  providerId: string;
  externalId: string;
  state: RunState;
  promptSummary?: string;
  startedAt?: string;
  finishedAt?: string;
  revision: number;
  sourceRevision?: number;
  metadata: Record<string, unknown>;
}

export interface Attention {
  id: string;
  providerId: string;
  agentId?: string;
  runId?: string;
  type: AttentionType;
  severity: AttentionSeverity;
  summary: string;
  actions: string[];
  openedAt: string;
  resolvedAt?: string;
}

export const CANONICAL_EVENT_TYPES = [
  "provider.health.changed",
  "workspace.upserted",
  "project.upserted",
  "agent.upserted",
  "agent.state.changed",
  "agent.progress.changed",
  "agent.removed",
  "run.upserted",
  "run.state.changed",
  "run.removed",
  "attention.opened",
  "attention.resolved",
] as const;

export type CanonicalEventType = (typeof CANONICAL_EVENT_TYPES)[number];

export interface ProviderEvent {
  providerId: string;
  providerEventId?: string;
  type: CanonicalEventType;
  occurredAt: string;
  agentId?: string;
  runId?: string;
  payload: Record<string, unknown>;
}

export interface CanonicalEvent extends ProviderEvent {
  sequence: number;
  eventId: string;
  observedAt: string;
  agentRevision?: number;
}

export interface ProviderSnapshot {
  reconciliation: "authoritative" | "incremental";
  observedAt: string;
  workspaces: Workspace[];
  projects: Project[];
  agents: Agent[];
  runs: AgentRun[];
  attention: Attention[];
}

export interface ProviderHealth {
  status: Exclude<ProviderHealthStatus, "starting" | "stopped">;
  message?: string;
  checkedAt: string;
}

export interface ProviderCommand {
  commandId: string;
  action: string;
  agentId: string;
  expectedRevision?: number;
  arguments?: Record<string, unknown>;
}

export interface CommandResult {
  commandId: string;
  status: "succeeded" | "failed" | "unsupported";
  message?: string;
}

export interface ClientDescriptor {
  id: string;
  type:
    | "stream-deck"
    | "desktop"
    | "web"
    | "mobile"
    | "cli"
    | "automation"
    | "custom";
  name: string;
  version: string;
  capabilities: {
    notifications: boolean;
    images: boolean;
    animations: boolean;
    textInput: boolean;
    approvalActions: boolean;
  };
  metadata?: Record<string, unknown>;
}

export interface ClientPresence {
  descriptor: ClientDescriptor;
  connectionId: string;
  connectedAt: string;
  lastSeenAt: string;
}

export interface ClientConfigurationDocument {
  clientId: string;
  schema: string;
  revision: number;
  data: Record<string, unknown>;
  updatedAt: string;
}

export const canonicalId = (providerId: string, externalId: string): string =>
  `${providerId}:${externalId}`;

const WORKSPACE_PROVIDER_ID = "agent-deck";

const stableResourceHash = (values: readonly string[]): string =>
  createHash("sha256")
    .update(values.join("\0"))
    .digest("base64url")
    .slice(0, 22);

export interface WorkspaceProjectSource {
  key: string;
  externalId: string;
  name: string;
  metadata: Record<string, unknown>;
}

export interface WorkspaceResources {
  workspace?: Workspace;
  projects: Project[];
}

export const workspaceResourcesForProjects = (
  providerId: string,
  identityKind: string,
  sources: readonly WorkspaceProjectSource[],
  workspaceMetadata: Record<string, unknown> = {},
): WorkspaceResources => {
  const uniqueSources = [
    ...new Map(
      sources
        .filter((source) => source.key.length > 0)
        .map((source) => [source.key, source]),
    ).values(),
  ].sort((left, right) => left.key.localeCompare(right.key));
  if (!uniqueSources.length) return { projects: [] };

  const keys = uniqueSources.map((source) => source.key);
  const externalId = stableResourceHash([identityKind, ...keys]);
  const firstName = uniqueSources[0]?.name || "Workspace";
  const workspace: Workspace = {
    id: canonicalId(WORKSPACE_PROVIDER_ID, `workspace:${externalId}`),
    providerId: WORKSPACE_PROVIDER_ID,
    externalId,
    name:
      uniqueSources.length === 1
        ? firstName
        : `${firstName} +${uniqueSources.length - 1}`,
    metadata: workspaceMetadata,
  };
  const projects = uniqueSources.map((source): Project => ({
    id: canonicalId(providerId, `project:${source.externalId}`),
    providerId,
    externalId: source.externalId,
    workspaceId: workspace.id,
    name: source.name,
    metadata: source.metadata,
  }));
  return { workspace, projects };
};

export const normalizedWorkspaceRoots = (roots: readonly string[]): string[] =>
  [...new Set(roots.map((root) => resolve(root)))].sort();

export const workspaceResourcesForRoots = (
  providerId: string,
  roots: readonly string[],
): WorkspaceResources => {
  const normalized = normalizedWorkspaceRoots(roots);
  return workspaceResourcesForProjects(
    providerId,
    "local-root",
    normalized.map((root) => ({
      key: root,
      externalId: stableResourceHash([root]),
      name: basename(root) || "Workspace",
      metadata: { root },
    })),
    { roots: normalized },
  );
};

export const isActiveAgentState = (state: AgentState): boolean =>
  state === "running" ||
  state === "waiting_for_input" ||
  state === "waiting_for_approval";

export const isActiveRunState = (state: AgentRun["state"]): boolean =>
  state === "queued" ||
  state === "running" ||
  state === "waiting_for_input" ||
  state === "waiting_for_approval";

export const isTerminalVisibleAgentState = (state: AgentState): boolean =>
  state === "ready_for_review" ||
  state === "failed" ||
  state === "cancelled";

export const attentionForAgentState = (
  agent: Agent,
  occurredAt: string,
): Attention | undefined => {
  const base = {
    id: `${agent.id}:state-attention`,
    providerId: agent.providerId,
    agentId: agent.id,
    ...(agent.activeRunId ? { runId: agent.activeRunId } : {}),
    openedAt: occurredAt,
    actions: [] as string[],
  };
  switch (agent.state) {
    case "waiting_for_input":
      return {
        ...base,
        type: "input",
        severity: "warning",
        summary: `${agent.title} is waiting for input`,
      };
    case "waiting_for_approval":
      return {
        ...base,
        type: "approval",
        severity: "warning",
        summary: `${agent.title} is waiting for approval`,
      };
    case "ready_for_review":
      return {
        ...base,
        type: "review",
        severity: "info",
        summary: `${agent.title} is ready for review`,
      };
    case "failed":
      return {
        ...base,
        type: "failure",
        severity: "critical",
        summary: `${agent.title} failed`,
      };
    default:
      return undefined;
  }
};
