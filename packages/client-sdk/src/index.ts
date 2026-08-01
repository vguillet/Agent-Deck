import {
  AgentSchema,
  AgentCreationContextSchema,
  AgentCreationResponseSchema,
  CommandResultSchema,
  CursorFocusResponseSchema,
  AttentionSchema,
  EventSchema,
  ProviderSchema,
  ProviderUsageSchema,
  RunSchema,
  WorkspaceSchema,
  type Page,
  type AgentCreationContext,
  type AgentCreationProviderId,
  type AgentCreationResult,
  type CursorFocusResult,
} from "@agent-deck/api-contract";
import { fallbackWorkspaceColour } from "@agent-deck/domain";
import type {
  Agent,
  AgentRun,
  Attention,
  CanonicalEvent,
  ClientConfigurationDocument,
  ClientDescriptor,
  CommandResult,
  Provider,
  ProviderUsage,
  Workspace,
} from "@agent-deck/domain";

export const workspaceColour = (
  workspace: string | Pick<Workspace, "id" | "colour">,
): string =>
  typeof workspace === "string"
    ? fallbackWorkspaceColour(workspace)
    : (workspace.colour ?? fallbackWorkspaceColour(workspace.id));

export const workspaceAcronym = (name: string): string => {
  const words = name.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length > 1)
    return words
      .slice(0, 2)
      .map((word) => Array.from(word)[0])
      .join("")
      .toLocaleUpperCase();

  return Array.from(words[0] ?? "?")
    .slice(0, 2)
    .join("")
    .toLocaleUpperCase();
};

export interface AgentListOptions {
  providerId?: string;
  projectId?: string;
  state?: Agent["state"];
  requiresAttention?: boolean;
  limit?: number;
  cursor?: string;
}

export interface PageListOptions {
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

  async listRuns(
    agentId: string,
    options: PageListOptions = {},
  ): Promise<Page<AgentRun>> {
    const query = this.pageQuery(options);
    const page = await this.get<Page<unknown>>(
      `/api/v1/agents/${encodeURIComponent(agentId)}/runs${query}`,
    );
    return {
      ...page,
      items: page.items.map((item) => RunSchema.parse(item) as AgentRun),
    };
  }

  async listAttention(options: PageListOptions = {}): Promise<Page<Attention>> {
    const page = await this.get<Page<unknown>>(
      `/api/v1/attention${this.pageQuery(options)}`,
    );
    return {
      ...page,
      items: page.items.map((item) => AttentionSchema.parse(item) as Attention),
    };
  }

  async listProviders(options: PageListOptions = {}): Promise<Page<Provider>> {
    const page = await this.get<Page<unknown>>(
      `/api/v1/providers${this.pageQuery(options)}`,
    );
    return {
      ...page,
      items: page.items.map((item) => ProviderSchema.parse(item) as Provider),
    };
  }

  async getProviderUsage(
    providerId: string,
    refresh = false,
  ): Promise<ProviderUsage> {
    return ProviderUsageSchema.parse(
      await this.get(
        `/api/v1/providers/${encodeURIComponent(providerId)}/usage${
          refresh ? "?refresh=true" : ""
        }`,
      ),
    ) as ProviderUsage;
  }

  async listWorkspaces(
    options: PageListOptions | number = { limit: 200 },
  ): Promise<Page<Workspace>> {
    const normalized =
      typeof options === "number" ? { limit: options } : options;
    const page = await this.get<Page<unknown>>(
      `/api/v1/workspaces${this.pageQuery(normalized)}`,
    );
    return {
      ...page,
      items: page.items.map((item) => WorkspaceSchema.parse(item) as Workspace),
    };
  }

  async listAllAgents(
    options: Omit<AgentListOptions, "cursor" | "limit"> = {},
  ): Promise<Page<Agent>> {
    return this.collectAll((cursor) =>
      this.listAgents({
        ...options,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      }),
    );
  }

  async listAllRuns(agentId: string): Promise<Page<AgentRun>> {
    return this.collectAll((cursor) =>
      this.listRuns(agentId, { limit: 200, ...(cursor ? { cursor } : {}) }),
    );
  }

  async listAllAttention(): Promise<Page<Attention>> {
    return this.collectAll((cursor) =>
      this.listAttention({ limit: 200, ...(cursor ? { cursor } : {}) }),
    );
  }

  async listAllProviders(): Promise<Page<Provider>> {
    return this.collectAll((cursor) =>
      this.listProviders({ limit: 200, ...(cursor ? { cursor } : {}) }),
    );
  }

  async listAllWorkspaces(): Promise<Page<Workspace>> {
    return this.collectAll((cursor) =>
      this.listWorkspaces({ limit: 200, ...(cursor ? { cursor } : {}) }),
    );
  }

  async health(): Promise<Record<string, unknown>> {
    return this.get("/api/v1/system/health");
  }

  async focusAgent(id: string): Promise<CursorFocusResult> {
    const response = await fetch(
      `${this.baseUrl}/api/v1/agents/${encodeURIComponent(id)}/focus`,
      { method: "POST" },
    );
    if (!response.ok) throw await responseError(response);
    return CursorFocusResponseSchema.parse(await response.json());
  }

  async createAgent(
    providerId: AgentCreationProviderId,
  ): Promise<AgentCreationResult> {
    const response = await fetch(`${this.baseUrl}/api/v1/agents/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId }),
    });
    if (!response.ok) throw await responseError(response);
    return AgentCreationResponseSchema.parse(await response.json());
  }

  async getAgentCreationContext(): Promise<AgentCreationContext> {
    return AgentCreationContextSchema.parse(
      await this.get("/api/v1/agents/create/context"),
    );
  }

  async cancelAgent(
    id: string,
    expectedRevision?: number,
  ): Promise<CommandResult> {
    return this.commandAgent(id, "cancel", expectedRevision);
  }

  private async commandAgent(
    id: string,
    action: "cancel",
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

  async dismissAgent(id: string): Promise<boolean> {
    const response = await fetch(
      `${this.baseUrl}/api/v1/agents/${encodeURIComponent(id)}/dismiss`,
      { method: "POST" },
    );
    if (response.status === 404) return false;
    if (!response.ok) throw await responseError(response);
    return true;
  }

  async dismissTerminalAgents(): Promise<number> {
    const response = await fetch(
      `${this.baseUrl}/api/v1/agents/dismiss-terminal`,
      {
        method: "POST",
      },
    );
    if (!response.ok) throw await responseError(response);
    const result = (await response.json()) as { dismissed?: unknown };
    if (typeof result.dismissed !== "number")
      throw new Error("Agent dismiss response did not include a count");
    return result.dismissed;
  }

  async clearAgents(): Promise<number> {
    const response = await fetch(`${this.baseUrl}/api/v1/agents/clear`, {
      method: "POST",
    });
    if (!response.ok) throw await responseError(response);
    const result = (await response.json()) as { cleared?: unknown };
    if (typeof result.cleared !== "number")
      throw new Error("Agent clear response did not include a count");
    return result.cleared;
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
        let frame: {
          type?: string;
          event?: unknown;
          currentSequence?: number;
        };
        try {
          frame = JSON.parse(String(message.data)) as typeof frame;
        } catch {
          socket?.close(1008, "Invalid server frame");
          return;
        }
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
          const parsed = EventSchema.safeParse(frame.event);
          if (!parsed.success) {
            socket?.close(1008, "Invalid server event");
            return;
          }
          const event = parsed.data as CanonicalEvent;
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

  private pageQuery(options: PageListOptions): string {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.cursor) query.set("cursor", options.cursor);
    return query.size ? `?${query}` : "";
  }

  private async collectAll<T extends { id: string }>(
    load: (cursor?: string) => Promise<Page<T>>,
  ): Promise<Page<T>> {
    const items = new Map<string, T>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let asOfSequence: number | undefined;
    do {
      const page = await load(cursor);
      asOfSequence = Math.min(
        asOfSequence ?? page.asOfSequence,
        page.asOfSequence,
      );
      for (const item of page.items) items.set(item.id, item);
      cursor = page.nextCursor;
      if (cursor) {
        if (seenCursors.has(cursor))
          throw new Error(`Pagination cursor repeated: ${cursor}`);
        seenCursors.add(cursor);
      }
    } while (cursor);
    return { items: [...items.values()], asOfSequence: asOfSequence ?? 0 };
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
