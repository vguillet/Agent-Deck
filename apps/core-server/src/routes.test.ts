import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, Workspace } from "@agent-deck/domain";
import type { EventStore } from "@agent-deck/event-store";
import type { AgentFocusCoordinator } from "./agent-focus-coordinator.js";
import type { SubscriptionBroker } from "./broker.js";
import type { ProviderManager } from "./provider-manager.js";
import type { CursorWindowBroker } from "./cursor-window-broker.js";
import { registerApiRoutes } from "./routes.js";
import { WorkspaceColourAllocator } from "./workspace-colour-allocator.js";

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const agent = (
  providerId: string,
  externalId: string,
  metadata: Record<string, unknown>,
): Agent => ({
  id: `${providerId}:${externalId}`,
  providerId,
  externalId,
  title: externalId,
  state: "running",
  activityEpoch: "run-1",
  requiresAttention: false,
  lastActivityAt: "2026-07-29T09:00:00.000Z",
  revision: 1,
  capabilities: {
    messages: false,
    approvals: false,
    cancellation: false,
    creation: false,
  },
  links: [],
  metadata,
});

const setup = async (agents: Agent[], workspaces: Workspace[] = []) => {
  const app = Fastify();
  apps.push(app);
  const byId = new Map(agents.map((candidate) => [candidate.id, candidate]));
  const dismissAgent = vi.fn((id: string) => {
    const candidate = byId.get(id);
    if (!candidate) return [];
    byId.delete(id);
    return [
      {
        type: "agent.removed",
        providerId: candidate.providerId,
        agentId: candidate.id,
        payload: { agent: candidate },
      },
    ];
  });
  const store = {
    getAgent: (id: string) => byId.get(id),
    currentSequence: () => 0,
    dismissAgent,
    dismissTerminalAgents: () => [],
    listWorkspaces: () => ({ items: workspaces, hasMore: false }),
  } as unknown as EventStore;
  const focusAgent = vi.fn(async () => ({
    requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    status: "opened" as const,
  }));
  const agentFocus = {
    focusAgent,
    registeredCursorWindowCount: () => 0,
  } as unknown as AgentFocusCoordinator;
  const publish = vi.fn();
  const rediscover = vi.fn(async () => {});
  const usage = vi.fn(async (providerId: string) => ({
    providerId,
    status: "available" as const,
    windows: [
      { id: "primary", label: "5h", usedPercent: 42 },
      { id: "secondary", label: "Week", usedPercent: 18 },
    ],
    observedAt: "2026-08-01T18:00:00.000Z",
  }));
  const create = vi.fn(async () => ({
    requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    status: "opened" as const,
  }));
  const creationContext = vi.fn(() => ({
    status: "available" as const,
    workspaceRoots: ["/workspace/alpha"],
  }));
  const workspaceColours = new WorkspaceColourAllocator(() => 0);
  registerApiRoutes(
    app,
    store,
    { publish, listPresence: () => [] } as unknown as SubscriptionBroker,
    agentFocus,
    { create, creationContext } as unknown as CursorWindowBroker,
    { rediscover, usage } as unknown as ProviderManager,
    workspaceColours,
  );
  await app.ready();
  return {
    app,
    create,
    creationContext,
    dismissAgent,
    focusAgent,
    usage,
    publish,
    workspaceColours,
  };
};

describe("provider usage route", () => {
  it("returns usage and forwards forced refreshes", async () => {
    const { app, usage } = await setup([]);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/providers/codex/usage?refresh=true",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      providerId: "codex",
      status: "available",
    });
    expect(usage).toHaveBeenCalledWith("codex", true);
  });
});

describe("agent collection route", () => {
  it("dismisses one visible activity epoch", async () => {
    const test = await setup([
      agent("fake", "one", {}),
      agent("fake", "two", {}),
    ]);

    const response = await test.app.inject({
      method: "POST",
      url: "/api/v1/agents/fake%3Aone/dismiss",
    });

    expect(response.statusCode).toBe(204);
    expect(test.dismissAgent).toHaveBeenCalledWith("fake:one");
    expect(test.publish).toHaveBeenCalledOnce();
  });
});

describe("workspace collection route", () => {
  it("adds a runtime colour without mutating the stored workspace", async () => {
    const workspace: Workspace = {
      id: "agent-deck:workspace:alpha",
      providerId: "agent-deck",
      externalId: "alpha",
      name: "alpha",
      metadata: {},
    };
    const test = await setup([], [workspace]);

    const response = await test.app.inject({
      method: "GET",
      url: "/api/v1/workspaces",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items[0]).toMatchObject({
      id: workspace.id,
      colour: test.workspaceColours.colour(workspace.id),
    });
    expect(workspace).not.toHaveProperty("colour");
  });
});

describe("agent focus route", () => {
  it("delegates visible providers and rejects missing IDs", async () => {
    const cursor = agent("cursor-local", "conversation-1", {
      workspaceRoots: ["/workspace/beta", "/workspace/alpha"],
    });
    const codex = agent("codex", "thread-1", {
      cwd: "/workspace/alpha/project",
    });
    const test = await setup([cursor, codex]);

    const cursorResponse = await test.app.inject({
      method: "POST",
      url: `/api/v1/agents/${encodeURIComponent(cursor.id)}/focus`,
    });
    expect(cursorResponse.statusCode).toBe(200);
    expect(test.focusAgent).toHaveBeenLastCalledWith(cursor.id);

    const codexResponse = await test.app.inject({
      method: "POST",
      url: `/api/v1/agents/${encodeURIComponent(codex.id)}/focus`,
    });
    expect(codexResponse.statusCode).toBe(200);
    expect(test.focusAgent).toHaveBeenLastCalledWith(codex.id);

    const missing = await test.app.inject({
      method: "POST",
      url: "/api/v1/agents/missing%3Aagent/focus",
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("agent creation route", () => {
  it("validates the provider and delegates creation", async () => {
    const test = await setup([]);
    const response = await test.app.inject({
      method: "POST",
      url: "/api/v1/agents/create",
      payload: { providerId: "codex" },
    });
    expect(response.statusCode).toBe(200);
    expect(test.create).toHaveBeenCalledWith("codex");

    const invalid = await test.app.inject({
      method: "POST",
      url: "/api/v1/agents/create",
      payload: { providerId: "unknown" },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("returns the focused workspace creation context", async () => {
    const test = await setup([]);
    const response = await test.app.inject({
      method: "GET",
      url: "/api/v1/agents/create/context",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "available",
      workspaceRoots: ["/workspace/alpha"],
    });
    expect(test.creationContext).toHaveBeenCalledOnce();
  });
});
