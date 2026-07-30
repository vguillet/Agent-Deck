import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@agent-deck/domain";
import type { EventStore } from "@agent-deck/event-store";
import type { AgentFocusCoordinator } from "./agent-focus-coordinator.js";
import type { SubscriptionBroker } from "./broker.js";
import type { ProviderManager } from "./provider-manager.js";
import { registerApiRoutes } from "./routes.js";

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

const setup = async (agents: Agent[]) => {
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
  registerApiRoutes(
    app,
    store,
    { publish, listPresence: () => [] } as unknown as SubscriptionBroker,
    agentFocus,
    { rediscover } as unknown as ProviderManager,
  );
  await app.ready();
  return { app, dismissAgent, focusAgent, publish };
};

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
