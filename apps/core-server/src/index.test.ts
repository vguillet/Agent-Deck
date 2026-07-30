import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import type { Agent } from "@agent-deck/domain";
import { SqliteEventStore } from "@agent-deck/persistence-sqlite";
import type { AgentDeckConfiguration } from "./config.js";
import { buildServer, type RunningAgentDeckServer } from "./index.js";

const servers: RunningAgentDeckServer[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const configuration = async (): Promise<AgentDeckConfiguration> => {
  const directory = await mkdtemp(resolve(tmpdir(), "agent-deck-"));
  directories.push(directory);
  return {
    server: { host: "127.0.0.1", port: 47_831 },
    databasePath: resolve(directory, "test.sqlite"),
    retentionDays: 30,
    staleAfterMs: 300_000,
    healthIntervalMs: 30_000,
    providers: [
      {
        id: "fake",
        module: "@agent-deck/testing",
        enabled: true,
        config: { count: 3, intervalMs: 60_000 },
        discoveryIntervalMs: 60_000,
      },
    ],
  };
};

const seedFutureTombstone = (
  config: AgentDeckConfiguration,
  externalId: string,
): void => {
  const store = new SqliteEventStore(config.databasePath);
  store.migrate();
  const agent: Agent = {
    id: `fake:${externalId}`,
    providerId: "fake",
    externalId,
    title: externalId,
    state: "idle",
    freshness: "fresh",
    requiresAttention: false,
    lastActivityAt: "2099-01-01T00:00:00.000Z",
    revision: 0,
    archived: false,
    capabilities: {
      messages: false,
      approvals: false,
      cancellation: true,
      creation: false,
    },
    links: [],
    metadata: {},
  };
  store.applySnapshot("fake", {
    complete: true,
    observedAt: agent.lastActivityAt,
    workspaces: [],
    projects: [],
    agents: [agent],
    runs: [],
    attention: [],
  });
  store.deleteAgent(agent.id);
  store.close();
};

const nextFrame = (
  socket: WebSocket,
  type: string,
  timeoutMs = 2_000,
): Promise<Record<string, unknown>> =>
  new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for ${type}`)),
      timeoutMs,
    );
    const listener = (raw: WebSocket.RawData): void => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (frame.type !== type) return;
      clearTimeout(timeout);
      socket.off("message", listener);
      resolvePromise(frame);
    };
    socket.on("message", listener);
  });

const registerAndSubscribe = async (
  socket: WebSocket,
  id: string,
  topic: "agents.summary" | "attention",
  afterSequence: number,
): Promise<void> => {
  socket.send(
    JSON.stringify({
      type: "register",
      client: {
        id,
        type: "automation",
        name: id,
        version: "0.1.0",
        capabilities: {
          notifications: false,
          images: false,
          animations: false,
          textInput: false,
          approvalActions: false,
        },
      },
    }),
  );
  await nextFrame(socket, "registered");
  socket.send(
    JSON.stringify({
      type: "subscribe",
      topics: [topic],
      afterSequence,
    }),
  );
  await nextFrame(socket, "subscribed");
};

describe("Agent Deck HTTP API", () => {
  it("serves canonical provider and agent snapshots", async () => {
    const server = await buildServer(await configuration());
    servers.push(server);
    const agents = await server.app.inject({
      method: "GET",
      url: "/api/v1/agents?limit=2",
    });
    expect(agents.statusCode).toBe(200);
    expect(agents.json()).toMatchObject({
      items: [{ providerId: "fake" }, { providerId: "fake" }],
    });
    expect(agents.json().nextCursor).toBeTypeOf("string");

    const health = await server.app.inject({
      method: "GET",
      url: "/api/v1/system/health",
    });
    expect(health.statusCode).toBe(200);
    expect(health.json().status).toBe("healthy");

    const openapi = await server.app.inject({
      method: "GET",
      url: "/api/v1/openapi.json",
    });
    expect(openapi.json().components.schemas.Agent).toMatchObject({
      properties: {
        links: {
          items: {
            properties: {
              rel: { enum: ["focus", "view"] },
            },
          },
        },
      },
    });
  });

  it("starts with only agents found by the current discovery", async () => {
    const config = await configuration();
    const first = await buildServer(config);
    servers.push(first);
    const initial = await first.app.inject({
      method: "GET",
      url: "/api/v1/agents",
    });
    expect(initial.json().items).toHaveLength(3);
    await first.close();

    const provider = config.providers[0];
    if (!provider) throw new Error("Fake provider configuration missing");
    provider.config = { count: 1, intervalMs: 60_000 };
    const restarted = await buildServer(config);
    servers.push(restarted);

    const fresh = await restarted.app.inject({
      method: "GET",
      url: "/api/v1/agents",
    });
    expect(fresh.json().items).toHaveLength(1);
  });

  it("keeps a tombstone for an agent still reported after restart", async () => {
    const config = await configuration();
    seedFutureTombstone(config, "demo-1");

    const first = await buildServer(config);
    servers.push(first);
    const initial = await first.app.inject({
      method: "GET",
      url: "/api/v1/agents/fake%3Ademo-1",
    });
    expect(initial.statusCode).toBe(404);
    await first.close();

    const restarted = await buildServer(config);
    servers.push(restarted);
    const stillDeleted = await restarted.app.inject({
      method: "GET",
      url: "/api/v1/agents/fake%3Ademo-1",
    });
    expect(stillDeleted.statusCode).toBe(404);
  });

  it("removes a tombstone absent from complete startup discovery", async () => {
    const config = await configuration();
    seedFutureTombstone(config, "demo-3");
    const provider = config.providers[0];
    if (!provider) throw new Error("Fake provider configuration missing");
    provider.config = { count: 1, intervalMs: 60_000 };

    const withoutDeletedAgent = await buildServer(config);
    servers.push(withoutDeletedAgent);
    await withoutDeletedAgent.close();

    provider.config = { count: 3, intervalMs: 60_000 };
    const restored = await buildServer(config);
    servers.push(restored);
    const agent = await restored.app.inject({
      method: "GET",
      url: "/api/v1/agents/fake%3Ademo-3",
    });
    expect(agent.statusCode).toBe(200);
  });

  it("enforces optimistic client configuration updates", async () => {
    const server = await buildServer(await configuration());
    servers.push(server);
    const first = await server.app.inject({
      method: "PUT",
      url: "/api/v1/clients/test/configuration",
      payload: { schema: "test/v1", data: { page: 1 } },
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers.etag).toBe('"1"');
    const conflict = await server.app.inject({
      method: "PUT",
      url: "/api/v1/clients/test/configuration",
      headers: { "if-match": '"0"' },
      payload: { schema: "test/v1", data: { page: 2 } },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("revision_conflict");
  });

  it("dispatches cancellation commands to the owning provider", async () => {
    const server = await buildServer(await configuration());
    servers.push(server);
    const snapshot = await server.app.inject({
      method: "GET",
      url: "/api/v1/agents?providerId=fake",
    });
    const agent = snapshot.json().items[0] as {
      id: string;
      revision: number;
    };
    const command = await server.app.inject({
      method: "POST",
      url: `/api/v1/agents/${encodeURIComponent(agent.id)}/commands`,
      payload: {
        action: "cancel",
        expectedRevision: agent.revision,
      },
    });
    expect(command.statusCode).toBe(200);
    expect(command.json()).toMatchObject({ status: "succeeded" });

    const cancelled = await server.app.inject({
      method: "GET",
      url: `/api/v1/agents/${encodeURIComponent(agent.id)}`,
    });
    expect(cancelled.json()).toMatchObject({
      state: "cancelled",
      requiresAttention: false,
    });
  });

  it("deletes an agent and returns not found after tombstoning it", async () => {
    const server = await buildServer(await configuration());
    servers.push(server);
    const snapshot = await server.app.inject({
      method: "GET",
      url: "/api/v1/agents?providerId=fake",
    });
    const agent = snapshot.json().items[0] as { id: string };

    const deleted = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/agents/${encodeURIComponent(agent.id)}`,
    });
    expect(deleted.statusCode).toBe(204);

    const missing = await server.app.inject({
      method: "GET",
      url: `/api/v1/agents/${encodeURIComponent(agent.id)}`,
    });
    expect(missing.statusCode).toBe(404);

    const repeated = await server.app.inject({
      method: "DELETE",
      url: `/api/v1/agents/${encodeURIComponent(agent.id)}`,
    });
    expect(repeated.statusCode).toBe(404);
  });

  it("broadcasts one canonical update to simultaneous selective clients", async () => {
    const config = await configuration();
    const provider = config.providers[0];
    if (!provider) throw new Error("Fake provider configuration missing");
    provider.config = { count: 3, intervalMs: 250 };
    const server = await buildServer(config);
    servers.push(server);
    const snapshot = await server.app.inject({
      method: "GET",
      url: "/api/v1/agents",
    });
    const sequence = Number(snapshot.json().asOfSequence);
    const agentsSocket = await server.app.injectWS("/api/v1/stream");
    const attentionSocket = await server.app.injectWS("/api/v1/stream");
    await Promise.all([
      registerAndSubscribe(
        agentsSocket,
        "automation:agents",
        "agents.summary",
        sequence,
      ),
      registerAndSubscribe(
        attentionSocket,
        "automation:attention",
        "attention",
        sequence,
      ),
    ]);
    const [agentFrame, attentionFrame] = await Promise.all([
      nextFrame(agentsSocket, "event"),
      nextFrame(attentionSocket, "event"),
    ]);
    expect(agentFrame.event).toMatchObject({
      type: "agent.state.changed",
    });
    expect(attentionFrame.event).toMatchObject({
      sequence: (agentFrame.event as { sequence: number }).sequence,
    });
    agentsSocket.close();
    attentionSocket.close();
  });

  it("ingests Cursor local hooks and publishes canonical agents", async () => {
    const config = await configuration();
    config.providers = [
      {
        id: "cursor-local",
        module: "@agent-deck/provider-cursor-local",
        enabled: true,
        config: {},
        discoveryIntervalMs: 60_000,
      },
    ];
    const server = await buildServer(config);
    servers.push(server);
    const before = await server.app.inject({
      method: "GET",
      url: "/api/v1/agents",
    });
    const socket = await server.app.injectWS("/api/v1/stream");
    await registerAndSubscribe(
      socket,
      "automation:cursor-local",
      "agents.summary",
      Number(before.json().asOfSequence),
    );
    const framePromise = nextFrame(socket, "event");
    const hook = await server.app.inject({
      method: "POST",
      url: "/internal/providers/cursor-local/hooks",
      payload: {
        hook_event_name: "beforeSubmitPrompt",
        conversation_id: "conversation-integration",
        generation_id: "generation-integration",
        workspace_roots: ["/workspace/integration"],
        prompt: "SECRET PROMPT",
      },
    });
    expect(hook.statusCode).toBe(202);
    const frame = await framePromise;
    expect(frame.event).toMatchObject({
      type: "agent.upserted",
      payload: {
        agent: {
          providerId: "cursor-local",
          externalId: "conversation-integration",
          state: "running",
        },
      },
    });
    expect(JSON.stringify(frame)).not.toContain("SECRET");

    const agents = await server.app.inject({
      method: "GET",
      url: "/api/v1/agents?providerId=cursor-local",
    });
    expect(agents.json().items).toEqual([
      expect.objectContaining({
        links: [
          {
            rel: "focus",
            label: "Open in Cursor",
            href: "cursor://agent-deck.focus/open?conversationId=conversation-integration&workspace=%2Fworkspace%2Fintegration",
          },
        ],
        metadata: {
          workspaceRoots: ["/workspace/integration"],
        },
      }),
    ]);
    socket.close();
  });
});
