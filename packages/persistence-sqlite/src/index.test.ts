import { describe, expect, it } from "vitest";
import type {
  Agent,
  AgentRun,
  Provider,
  ProviderSnapshot,
} from "@agent-deck/domain";
import { createMemoryStore } from "./index.js";

const makeAgent = (
  state: Agent["state"] = "running",
  activityEpoch = "run-1",
  lastActivityAt = "2026-07-28T09:00:00.000Z",
): Agent => ({
  id: "fake:one",
  providerId: "fake",
  externalId: "one",
  title: "One",
  state,
  activityEpoch,
  activeRunId: `fake:${activityEpoch}`,
  requiresAttention:
    state === "waiting_for_input" ||
    state === "waiting_for_approval" ||
    state === "ready_for_review" ||
    state === "failed",
  lastActivityAt,
  revision: 0,
  capabilities: {
    messages: false,
    approvals: false,
    cancellation: true,
    creation: false,
  },
  links: [],
  metadata: {},
});

const makeRun = (agent: Agent): AgentRun => ({
  id: agent.activeRunId!,
  agentId: agent.id,
  providerId: agent.providerId,
  externalId: agent.activityEpoch,
  state: "running",
  startedAt: agent.lastActivityAt,
  revision: 0,
  metadata: {},
});

const snapshot = (
  agents: Agent[],
  reconciliation: ProviderSnapshot["reconciliation"] = "authoritative",
  observedAt = "2026-07-28T09:00:00.000Z",
): ProviderSnapshot => ({
  reconciliation,
  observedAt,
  workspaces: [],
  projects: [],
  agents,
  runs: agents.map(makeRun),
  attention: [],
});

const provider = (
  health: Provider["health"],
  checkedAt: string,
  healthMessage?: string,
): Provider => ({
  id: "fake",
  displayName: "Fake",
  version: "0.1.0",
  health,
  ...(healthMessage ? { healthMessage } : {}),
  lastCheckedAt: checkedAt,
  consecutiveFailures: health === "healthy" ? 0 : 1,
  capabilities: { discovery: true, liveEvents: true, commands: [] },
});

describe("SqliteEventStore live projection", () => {
  it("atomically removes active agents and runs absent from an authoritative snapshot", () => {
    const store = createMemoryStore();
    const agent = makeAgent();
    store.applySnapshot("fake", snapshot([agent]));

    const events = store.applySnapshot(
      "fake",
      snapshot([], "authoritative", "2026-07-28T09:01:00.000Z"),
    );

    expect(events.map(({ type }) => type)).toEqual([
      "run.removed",
      "agent.removed",
    ]);
    expect(store.getAgent(agent.id)).toBeUndefined();
    expect(store.getRun(agent.activeRunId!)).toBeUndefined();
    store.close();
  });

  it("retains a terminal transition until it is dismissed", () => {
    const store = createMemoryStore();
    const active = makeAgent();
    store.applySnapshot("fake", snapshot([active]));
    const terminal = { ...active, state: "ready_for_review" as const };
    store.applyProviderEvent({
      providerId: "fake",
      type: "agent.state.changed",
      occurredAt: "2026-07-28T09:01:00.000Z",
      agentId: active.id,
      payload: { agent: terminal },
    });

    store.applySnapshot(
      "fake",
      snapshot([], "authoritative", "2026-07-28T09:02:00.000Z"),
    );
    expect(store.getAgent(active.id)?.state).toBe("ready_for_review");

    expect(
      store
        .dismissAgent(active.id)
        .map(({ type }) => type)
        .includes("agent.removed"),
    ).toBe(true);
    expect(store.getAgent(active.id)).toBeUndefined();
    store.close();
  });

  it("expires active incremental agents after their observation lease", () => {
    const store = createMemoryStore();
    const agent = makeAgent();
    store.applySnapshot("fake", snapshot([agent], "incremental"));

    const events = store.expireLeases(
      "2026-07-28T09:05:00.000Z",
      "2026-07-28T09:06:00.000Z",
    );

    expect(events.at(-1)?.type).toBe("agent.removed");
    expect(store.getAgent(agent.id)).toBeUndefined();
    store.close();
  });

  it("admits provisional idle agents and expires their incremental lease", () => {
    const store = createMemoryStore();
    store.applySnapshot("fake", snapshot([], "incremental"));
    const provisional = {
      ...makeAgent("idle", "session"),
      activeRunId: undefined,
      metadata: { lifecycle: "provisional" },
    };
    store.applyProviderEvent({
      providerId: "fake",
      type: "agent.upserted",
      occurredAt: "2026-07-28T09:00:00.000Z",
      agentId: provisional.id,
      payload: { agent: provisional },
    });

    expect(store.getAgent(provisional.id)).toMatchObject({
      state: "idle",
      metadata: { lifecycle: "provisional" },
    });
    const events = store.expireLeases(
      "2026-07-28T09:05:00.000Z",
      "2026-07-28T09:06:00.000Z",
    );
    expect(events.at(-1)?.type).toBe("agent.removed");
    expect(store.getAgent(provisional.id)).toBeUndefined();
    store.close();
  });

  it("suppresses a dismissed epoch and accepts a genuinely new epoch", () => {
    const store = createMemoryStore();
    const first = makeAgent();
    store.applySnapshot("fake", snapshot([first], "incremental"));
    store.dismissAgent(first.id);

    expect(
      store.applySnapshot("fake", snapshot([first], "incremental")),
    ).toHaveLength(0);
    expect(store.getAgent(first.id)).toBeUndefined();

    const next = makeAgent("running", "run-2");
    expect(
      store.applySnapshot("fake", snapshot([next], "incremental")).length,
    ).toBeGreaterThan(0);
    expect(store.getAgent(first.id)?.activityEpoch).toBe("run-2");
    store.close();
  });

  it("never imports idle or unobserved terminal agents", () => {
    const store = createMemoryStore();
    store.applySnapshot(
      "fake",
      snapshot([
        makeAgent("idle", "idle"),
        makeAgent("ready_for_review", "old-run"),
      ]),
    );
    expect(store.listAgents({}, { offset: 0, limit: 10 }).items).toEqual([]);
    store.close();
  });

  it("keeps one provider-health incident timestamp until resolution", () => {
    const store = createMemoryStore();
    store.updateProvider(
      provider("unhealthy", "2026-07-28T09:00:00.000Z", "Offline"),
    );
    store.updateProvider(
      provider("degraded", "2026-07-28T09:01:00.000Z", "Retrying"),
    );
    expect(
      store.listAttention({ offset: 0, limit: 10 }).items[0]?.openedAt,
    ).toBe("2026-07-28T09:00:00.000Z");

    store.updateProvider(provider("healthy", "2026-07-28T09:02:00.000Z"));
    expect(store.listAttention({ offset: 0, limit: 10 }).items).toEqual([]);

    store.updateProvider(
      provider("unhealthy", "2026-07-28T09:03:00.000Z", "Offline again"),
    );
    expect(
      store.listAttention({ offset: 0, limit: 10 }).items[0]?.openedAt,
    ).toBe("2026-07-28T09:03:00.000Z");
    store.close();
  });

  it("clears agent state while retaining provider-health attention", () => {
    const store = createMemoryStore();
    store.updateProvider(
      provider("unhealthy", "2026-07-28T09:00:00.000Z", "Offline"),
    );
    store.applySnapshot("fake", snapshot([makeAgent("waiting_for_input")]));
    expect(store.listAttention({ offset: 0, limit: 10 }).items).toHaveLength(2);

    expect(store.clearAgents()).toBe(1);
    expect(store.listAgents({}, { offset: 0, limit: 10 }).items).toEqual([]);
    expect(store.listAttention({ offset: 0, limit: 10 }).items).toMatchObject([
      { type: "provider_health", providerId: "fake" },
    ]);
    store.close();
  });
});
