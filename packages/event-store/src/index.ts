import type {
  Agent,
  AgentRun,
  Attention,
  CanonicalEvent,
  ClientConfigurationDocument,
  Project,
  Provider,
  ProviderEvent,
  ProviderSnapshot,
  Workspace,
} from "@agent-deck/domain";

export interface AgentFilters {
  providerId?: string;
  projectId?: string;
  state?: Agent["state"];
  requiresAttention?: boolean;
}

export interface PageRequest {
  offset: number;
  limit: number;
}

export interface StorePage<T> {
  items: T[];
  hasMore: boolean;
}

export interface EventStore {
  migrate(): void;
  close(): void;
  currentSequence(): number;
  earliestSequence(): number | undefined;
  applyProviderEvent(event: ProviderEvent): CanonicalEvent | undefined;
  applySnapshot(
    providerId: string,
    snapshot: ProviderSnapshot,
  ): CanonicalEvent[];
  updateProvider(provider: Provider): CanonicalEvent | undefined;
  listAgents(filters: AgentFilters, page: PageRequest): StorePage<Agent>;
  getAgent(id: string): Agent | undefined;
  deleteAgent(id: string): boolean;
  listRuns(agentId: string, page: PageRequest): StorePage<AgentRun>;
  getRun(id: string): AgentRun | undefined;
  listEvents(
    options: {
      agentId?: string;
      afterSequence?: number;
    },
    page: PageRequest,
  ): StorePage<CanonicalEvent>;
  listEventsAfter(sequence: number, limit: number): CanonicalEvent[];
  listProviders(page: PageRequest): StorePage<Provider>;
  listWorkspaces(page: PageRequest): StorePage<Workspace>;
  listProjects(page: PageRequest): StorePage<Project>;
  listAttention(page: PageRequest): StorePage<Attention>;
  getClientConfiguration(
    clientId: string,
  ): ClientConfigurationDocument | undefined;
  putClientConfiguration(
    clientId: string,
    schema: string,
    data: Record<string, unknown>,
    expectedRevision?: number,
  ): ClientConfigurationDocument;
  getCheckpoint(providerId: string, key: string): string | undefined;
  setCheckpoint(providerId: string, key: string, value: string): void;
  markStale(beforeTimestamp: string, now: string): CanonicalEvent[];
  pruneEvents(beforeTimestamp: string): number;
}

export class RevisionConflictError extends Error {
  constructor() {
    super("Client configuration revision does not match");
    this.name = "RevisionConflictError";
  }
}
