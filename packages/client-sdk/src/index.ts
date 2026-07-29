import {
  AgentSchema,
  CommandResultSchema,
  AttentionSchema,
  EventSchema,
  ProviderSchema,
  RunSchema,
  WorkspaceSchema,
  type Page,
} from "@agent-deck/api-contract";
import type {
  Agent,
  AgentRun,
  Attention,
  CanonicalEvent,
  ClientConfigurationDocument,
  ClientDescriptor,
  CommandResult,
  Provider,
  Workspace,
} from "@agent-deck/domain";

export interface AgentListOptions {
  providerId?: string;
  projectId?: string;
  state?: Agent["state"];
  requiresAttention?: boolean;
  limit?: number;
  cursor?: string;
}

export interface WatchOptions {
  topics: Array<
    "agents.summary" | "attention" | "providers.health" | "system.health"
  >;
  filter?: {
    providers?: string[];
    projects?: string[];
    agents?: string[];
    states?: Agent["state"][];
  };
  afterSequence?: number;
  onEvent(event: CanonicalEvent): void;
  onResyncRequired?(): void;
  onStatus?(status: "connecting" | "connected" | "disconnected"): void;
}

export interface WatchHandle {
  close(): void;
}

export class AgentDeckClient {
  readonly baseUrl: string;

  constructor(
    baseUrl = process.env.AGENT_DECK_URL ?? "http://127.0.0.1:47831",
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async listAgents(options: AgentListOptions = {}): Promise<Page<Agent>> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) {
      if (value !== undefined) query.set(key, String(value));
    }
    const page = await this.get<Page<unknown>>(
      `/api/v1/agents${query.size ? `?${query}` : ""}`,
    );
    return {
      ...page,
      items: page.items.map((item) => AgentSchema.parse(item) as Agent),
    };
  }

  async getAgent(id: string): Promise<Agent> {
    return AgentSchema.parse(
      await this.get(`/api/v1/agents/${encodeURIComponent(id)}`),
    ) as Agent;
  }

  async listRuns(agentId: string): Promise<Page<AgentRun>> {
    const page = await this.get<Page<unknown>>(
      `/api/v1/agents/${encodeURIComponent(agentId)}/runs`,
    );
    return {
      ...page,
      items: page.items.map((item) => RunSchema.parse(item) as AgentRun),
    };
  }

  async listEvents(agentId: string): Promise<Page<CanonicalEvent>> {
    const page = await this.get<Page<unknown>>(
      `/api/v1/agents/${encodeURIComponent(agentId)}/events`,
    );
    return {
      ...page,
      items: page.items.map(
        (item) => EventSchema.parse(item) as CanonicalEvent,
      ),
    };
  }

  async listAttention(): Promise<Page<Attention>> {
    const page = await this.get<Page<unknown>>("/api/v1/attention");
    return {
      ...page,
      items: page.items.map((item) => AttentionSchema.parse(item) as Attention),
    };
  }

  async listProviders(): Promise<Page<Provider>> {
    const page = await this.get<Page<unknown>>("/api/v1/providers");
    return {
      ...page,
      items: page.items.map((item) => ProviderSchema.parse(item) as Provider),
    };
  }

  async listWorkspaces(limit = 200): Promise<Page<Workspace>> {
    const page = await this.get<Page<unknown>>(
      `/api/v1/workspaces?limit=${limit}`,
    );
    return {
      ...page,
      items: page.items.map((item) => WorkspaceSchema.parse(item)),
    };
  }

  async health(): Promise<Record<string, unknown>> {
    return this.get("/api/v1/system/health");
  }

  async cancelAgent(
    id: string,
    expectedRevision?: number,
  ): Promise<CommandResult> {
    return this.commandAgent(id, "cancel", expectedRevision);
  }

  async archiveAgent(
    id: string,
    expectedRevision?: number,
  ): Promise<CommandResult> {
    return this.commandAgent(id, "archive", expectedRevision);
  }

  private async commandAgent(
    id: string,
    action: "cancel" | "archive",
    expectedRevision?: number,
  ): Promise<CommandResult> {
    const response = await fetch(
      `${this.baseUrl}/api/v1/agents/${encodeURIComponent(id)}/commands`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action,
          ...(expectedRevision === undefined ? {} : { expectedRevision }),
        }),
      },
    );
    if (!response.ok) throw await responseError(response);
    return CommandResultSchema.parse(await response.json()) as CommandResult;
  }

  async deleteAgent(id: string): Promise<boolean> {
    const response = await fetch(
      `${this.baseUrl}/api/v1/agents/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    if (response.status === 404) return false;
    if (!response.ok) throw await responseError(response);
    return true;
  }

  async getClientConfiguration(
    clientId: string,
  ): Promise<ClientConfigurationDocument | undefined> {
    const response = await fetch(
      `${this.baseUrl}/api/v1/clients/${encodeURIComponent(clientId)}/configuration`,
    );
    if (response.status === 404) return undefined;
    if (!response.ok) throw await responseError(response);
    return (await response.json()) as ClientConfigurationDocument;
  }

  async putClientConfiguration(
    clientId: string,
    schema: string,
    data: Record<string, unknown>,
    revision?: number,
  ): Promise<ClientConfigurationDocument> {
    const response = await fetch(
      `${this.baseUrl}/api/v1/clients/${encodeURIComponent(clientId)}/configuration`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          ...(revision === undefined ? {} : { "if-match": `"${revision}"` }),
        },
        body: JSON.stringify({ schema, data }),
      },
    );
    if (!response.ok) throw await responseError(response);
    return (await response.json()) as ClientConfigurationDocument;
  }

  watch(descriptor: ClientDescriptor, options: WatchOptions): WatchHandle {
    let closed = false;
    let socket: WebSocket | undefined;
    let sequence = options.afterSequence ?? 0;
    let retry = 250;
    const connect = (): void => {
      if (closed) return;
      options.onStatus?.("connecting");
      const url = new URL(this.baseUrl);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.pathname = "/api/v1/stream";
      socket = new WebSocket(url);
      socket.addEventListener("open", () => {
        socket?.send(JSON.stringify({ type: "register", client: descriptor }));
      });
      socket.addEventListener("message", (message) => {
        const frame = JSON.parse(String(message.data)) as {
          type?: string;
          event?: unknown;
          currentSequence?: number;
        };
        if (frame.type === "registered") {
          socket?.send(
            JSON.stringify({
              type: "subscribe",
              topics: options.topics,
              afterSequence: sequence,
              ...(options.filter ? { filter: options.filter } : {}),
            }),
          );
        } else if (frame.type === "subscribed") {
          retry = 250;
          options.onStatus?.("connected");
        } else if (frame.type === "event" && frame.event) {
          const event = EventSchema.parse(frame.event) as CanonicalEvent;
          sequence = Math.max(sequence, event.sequence);
          options.onEvent(event);
        } else if (frame.type === "stream.resync_required") {
          if (typeof frame.currentSequence === "number")
            sequence = Math.max(sequence, frame.currentSequence);
          retry = 250;
          options.onStatus?.("connected");
          options.onResyncRequired?.();
        }
      });
      socket.addEventListener("close", () => {
        options.onStatus?.("disconnected");
        if (!closed) {
          const delay = retry + Math.floor(Math.random() * retry * 0.2);
          retry = Math.min(retry * 2, 10_000);
          setTimeout(connect, delay);
        }
      });
    };
    connect();
    return {
      close: () => {
        closed = true;
        socket?.close(1000, "Client closed");
      },
    };
  }

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`);
    if (!response.ok) throw await responseError(response);
    return (await response.json()) as T;
  }
}

const responseError = async (response: Response): Promise<Error> => {
  let message = `${response.status} ${response.statusText}`;
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    message = body.error?.message ?? message;
  } catch {
    // Keep the HTTP status when the body is not JSON.
  }
  return new Error(message);
};
