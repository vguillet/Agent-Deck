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
export type Freshness = "fresh" | "stale";
export type ProviderHealthStatus =
  "starting" | "healthy" | "degraded" | "unhealthy" | "stopped";
export type AttentionType =
  "input" | "approval" | "review" | "failure" | "stale" | "provider_health";
export type AttentionSeverity = "info" | "warning" | "critical";

export interface ProviderCapabilities {
  discovery: boolean;
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
  projectId?: string;
  workspaceId?: string;
  state: AgentState;
  freshness: Freshness;
  activeRunId?: string;
  requiresAttention: boolean;
  lastActivityAt: string;
  revision: number;
  archived: boolean;
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
  "agent.freshness.changed",
  "run.upserted",
  "run.state.changed",
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
  complete: boolean;
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

export const isActiveAgentState = (state: AgentState): boolean =>
  state === "running" ||
  state === "waiting_for_input" ||
  state === "waiting_for_approval";

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
