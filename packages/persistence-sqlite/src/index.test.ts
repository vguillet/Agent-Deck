import { describe, expect, it } from "vitest";
import type { Agent } from "@agent-deck/domain";
import { RevisionConflictError } from "@agent-deck/event-store";
import { createMemoryStore } from "./index.js";

const makeAgent = (
  state: Agent["state"],
  lastActivityAt = "2026-07-28T09:00:00.000Z",
): Agent => ({
  id: "fake:one",
  providerId: "fake",
  externalId: "one",
  title: "One",
  state,
  freshness: "fresh",
  requiresAttention:
    state === "waiting_for_approval" || state === "ready_for_review",
  lastActivityAt,
  revision: 0,
  archived: false,
  capabilities: {
    messages: false,
    approvals: false,
    cancellation: false,
    creation: false,
  },
  links: [],
  metadata: {},
});

describe("SqliteEventStore", () => {
  it("deduplicates events and assigns semantic revisions and sequences", () => {
    const store = createMemoryStore();
    const first = store.applyProviderEvent({
      providerId: "fake",
      providerEventId: "native-1",
      type: "agent.upserted",
      occurredAt: "2026-07-28T09:00:00.000Z",
      agentId: "fake:one",
      payload: { agent: makeAgent("running") },
    });
    expect(first?.sequence).toBe(1);
    expect(first?.agentRevision).toBe(1);
    expect(
      store.applyProviderEvent({
        providerId: "fake",
        providerEventId: "native-1",
        type: "agent.upserted",
        occurredAt: "2026-07-28T09:00:00.000Z",
        agentId: "fake:one",
        payload: { agent: makeAgent("running") },
      }),
    ).toBeUndefined();

    const second = store.applyProviderEvent({
      providerId: "fake",
      providerEventId: "native-2",
      type: "agent.state.changed",
      occurredAt: "2026-07-28T09:01:00.000Z",
      agentId: "fake:one",
      payload: { agent: makeAgent("waiting_for_approval") },
    });
    expect(second?.sequence).toBe(2);
    expect(second?.agentRevision).toBe(2);
    expect(store.getAgent("fake:one")?.revision).toBe(2);
    expect(store.listAttention({ offset: 0, limit: 10 }).items).toHaveLength(1);
    store.close();
  });

  it("reduces progress changes through the agent revision stream", () => {
    const store = createMemoryStore();
    const agent = makeAgent("running");
    store.applyProviderEvent({
      providerId: "fake",
      type: "agent.upserted",
      occurredAt: agent.lastActivityAt,
      agentId: agent.id,
      payload: { agent },
    });
    const progressEvent = store.applyProviderEvent({
      providerId: "fake",
      type: "agent.progress.changed",
      occurredAt: "2026-07-28T09:01:00.000Z",
      agentId: agent.id,
      payload: {
        agent: {
          ...agent,
          progress: {
            activity: "planning",
            plan: { completed: 1, total: 3 },
            observedAt: "2026-07-28T09:01:00.000Z",
          },
        },
      },
    });

    expect(progressEvent?.agentRevision).toBe(2);
    expect(store.getAgent(agent.id)?.progress).toMatchObject({
      activity: "planning",
      plan: { completed: 1, total: 3 },
    });
    expect(
      store.listEvents({ agentId: agent.id }, { offset: 0, limit: 10 }).items,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "agent.progress.changed" }),
      ]),
    );
    store.close();
  });

  it("marks active agents stale without replacing lifecycle state", () => {
    const store = createMemoryStore();
    const runningAgent: Agent = {
      ...makeAgent("running"),
      progress: {
        activity: "editing",
        observedAt: "2026-07-28T09:00:00.000Z",
      },
    };
    store.applyProviderEvent({
      providerId: "fake",
      type: "agent.upserted",
      occurredAt: "2026-07-28T09:00:00.000Z",
      agentId: "fake:one",
      payload: { agent: runningAgent },
    });
    const events = store.markStale(
      "2026-07-28T09:05:00.000Z",
      "2026-07-28T09:10:00.000Z",
    );
    expect(events).toHaveLength(1);
    expect(store.getAgent("fake:one")).toMatchObject({
      state: "running",
      freshness: "stale",
      requiresAttention: true,
    });
    expect(store.getAgent("fake:one")?.progress).toBeUndefined();
    expect(store.listAttention({ offset: 0, limit: 10 }).items[0]?.type).toBe(
      "stale",
    );
    store.close();
  });

  it("does not open stale attention for restored inactive agents", () => {
    const store = createMemoryStore();
    store.applyProviderEvent({
      providerId: "cursor-local",
      type: "agent.upserted",
      occurredAt: "2026-07-28T09:00:00.000Z",
      agentId: "fake:one",
      payload: {
        agent: {
          ...makeAgent("ready_for_review"),
          freshness: "stale",
          requiresAttention: false,
        },
      },
    });

    expect(store.getAgent("fake:one")).toMatchObject({
      freshness: "stale",
      requiresAttention: false,
    });
    expect(store.listAttention({ offset: 0, limit: 10 }).items).toEqual([]);
    store.close();
  });

  it("restores freshness when provider telemetry resumes", () => {
    const store = createMemoryStore();
    store.applyProviderEvent({
      providerId: "cursor-local",
      type: "agent.upserted",
      occurredAt: "2026-07-28T09:00:00.000Z",
      agentId: "fake:one",
      payload: { agent: makeAgent("running") },
    });
    store.markStale("2026-07-28T09:05:00.000Z", "2026-07-28T09:10:00.000Z");
    store.applySnapshot("cursor-local", {
      complete: false,
      observedAt: "2026-07-28T09:10:30.000Z",
      workspaces: [],
      projects: [],
      agents: [makeAgent("running")],
      runs: [],
      attention: [],
    });
    expect(store.getAgent("fake:one")).toMatchObject({
      freshness: "stale",
      requiresAttention: true,
    });
    store.applyProviderEvent({
      providerId: "cursor-local",
      providerEventId: "hook:resumed",
      type: "agent.state.changed",
      occurredAt: "2026-07-28T09:11:00.000Z",
      agentId: "fake:one",
      payload: {
        agent: makeAgent("running", "2026-07-28T09:11:00.000Z"),
      },
    });
    expect(store.getAgent("fake:one")).toMatchObject({
      state: "running",
      freshness: "fresh",
      requiresAttention: false,
    });
    expect(store.listAttention({ offset: 0, limit: 10 }).items).toHaveLength(0);
    store.close();
  });

  it("deletes agent history and suppresses rediscovery until newer activity", () => {
    const store = createMemoryStore();
    const agent = makeAgent("waiting_for_approval", "2026-07-28T09:00:00.000Z");
    const run = {
      id: "fake:run:one",
      agentId: agent.id,
      providerId: agent.providerId,
      externalId: "run:one",
      state: "waiting_for_approval" as const,
      startedAt: "2026-07-28T08:59:00.000Z",
      revision: 0,
      metadata: {},
    };
    store.applySnapshot("fake", {
      complete: true,
      observedAt: "2026-07-28T09:00:00.000Z",
      workspaces: [],
      projects: [],
      agents: [agent],
      runs: [run],
      attention: [],
    });
    expect(store.getAgent(agent.id)).toBeDefined();
    expect(store.getRun(run.id)).toBeDefined();
    expect(store.listAttention({ offset: 0, limit: 10 }).items).toHaveLength(1);

    expect(store.deleteAgent(agent.id)).toBe(true);
    expect(store.deleteAgent(agent.id)).toBe(false);
    expect(store.getAgent(agent.id)).toBeUndefined();
    expect(store.getRun(run.id)).toBeUndefined();
    expect(
      store.listEvents({ agentId: agent.id }, { offset: 0, limit: 10 }).items,
    ).toHaveLength(0);
    expect(store.listAttention({ offset: 0, limit: 10 }).items).toHaveLength(0);

    expect(
      store.applySnapshot("fake", {
        complete: true,
        observedAt: "2026-07-28T09:00:30.000Z",
        workspaces: [],
        projects: [],
        agents: [agent],
        runs: [run],
        attention: [],
      }),
    ).toHaveLength(0);
    expect(store.getAgent(agent.id)).toBeUndefined();
    expect(store.getRun(run.id)).toBeUndefined();

    const resumed = makeAgent("running", "2026-07-28T09:01:00.000Z");
    expect(
      store.applySnapshot("fake", {
        complete: true,
        observedAt: "2026-07-28T09:01:00.000Z",
        workspaces: [],
        projects: [],
        agents: [resumed],
        runs: [{ ...run, state: "running" }],
        attention: [],
      }),
    ).toHaveLength(2);
    expect(store.getAgent(agent.id)).toMatchObject({
      state: "running",
      lastActivityAt: "2026-07-28T09:01:00.000Z",
    });
    expect(store.getRun(run.id)).toBeDefined();
    store.close();
  });

  it("preserves tombstones while clearing transient agent state", () => {
    const store = createMemoryStore();
    const agent = makeAgent("running", "2026-07-28T09:00:00.000Z");
    store.applySnapshot("fake", {
      complete: true,
      observedAt: agent.lastActivityAt,
      workspaces: [],
      projects: [],
      agents: [agent],
      runs: [],
      attention: [],
    });
    expect(store.deleteAgent(agent.id)).toBe(true);

    store.clearAgents({ preserveTombstones: true });
    expect(
      store.applySnapshot("fake", {
        complete: true,
        observedAt: "2026-07-28T09:00:30.000Z",
        workspaces: [],
        projects: [],
        agents: [agent],
        runs: [],
        attention: [],
      }),
    ).toEqual([]);
    expect(store.getAgent(agent.id)).toBeUndefined();
    store.close();
  });

  it("only removes redundant tombstones after complete discovery", () => {
    const store = createMemoryStore();
    const agent = makeAgent("running", "2026-07-28T09:00:00.000Z");
    store.applySnapshot("fake", {
      complete: true,
      observedAt: agent.lastActivityAt,
      workspaces: [],
      projects: [],
      agents: [agent],
      runs: [],
      attention: [],
    });
    expect(store.deleteAgent(agent.id)).toBe(true);

    store.applySnapshot("fake", {
      complete: false,
      observedAt: "2026-07-28T09:00:30.000Z",
      workspaces: [],
      projects: [],
      agents: [],
      runs: [],
      attention: [],
    });
    expect(
      store.applySnapshot("fake", {
        complete: false,
        observedAt: "2026-07-28T09:00:45.000Z",
        workspaces: [],
        projects: [],
        agents: [agent],
        runs: [],
        attention: [],
      }),
    ).toEqual([]);

    store.applySnapshot("fake", {
      complete: true,
      observedAt: "2026-07-28T09:01:00.000Z",
      workspaces: [],
      projects: [],
      agents: [],
      runs: [],
      attention: [],
    });
    expect(
      store.applySnapshot("fake", {
        complete: false,
        observedAt: "2026-07-28T09:01:30.000Z",
        workspaces: [],
        projects: [],
        agents: [agent],
        runs: [],
        attention: [],
      }),
    ).toHaveLength(1);
    expect(store.getAgent(agent.id)).toBeDefined();
    store.close();
  });

  it("clears all agents and allows the same snapshot to repopulate them", () => {
    const store = createMemoryStore();
    const agent = makeAgent("running", "2026-07-28T09:00:00.000Z");
    store.applySnapshot("fake", {
      complete: true,
      observedAt: "2026-07-28T09:00:00.000Z",
      workspaces: [],
      projects: [],
      agents: [agent],
      runs: [],
      attention: [],
    });

    expect(store.clearAgents()).toBe(1);
    expect(store.listAgents({}, { offset: 0, limit: 10 }).items).toEqual([]);
    expect(store.listAttention({ offset: 0, limit: 10 }).items).toEqual([]);

    expect(
      store.applySnapshot("fake", {
        complete: true,
        observedAt: "2026-07-28T09:00:30.000Z",
        workspaces: [],
        projects: [],
        agents: [agent],
        runs: [],
        attention: [],
      }),
    ).toHaveLength(1);
    expect(store.getAgent(agent.id)).toBeDefined();
    store.close();
  });

  it("rejects regressive provider source revisions", () => {
    const store = createMemoryStore();
    const newer = {
      ...makeAgent("running", "2026-07-28T09:02:00.000Z"),
      sourceRevision: 2,
    };
    const older = {
      ...makeAgent("idle", "2026-07-28T09:01:00.000Z"),
      sourceRevision: 1,
    };
    expect(
      store.applyProviderEvent({
        providerId: "fake",
        type: "agent.upserted",
        occurredAt: newer.lastActivityAt,
        agentId: newer.id,
        payload: { agent: newer },
      }),
    ).toBeDefined();
    expect(
      store.applyProviderEvent({
        providerId: "fake",
        type: "agent.state.changed",
        occurredAt: older.lastActivityAt,
        agentId: older.id,
        payload: { agent: older },
      }),
    ).toBeUndefined();
    expect(store.getAgent(newer.id)).toMatchObject({
      state: "running",
      sourceRevision: 2,
    });
    store.close();
  });

  it("uses optimistic revisions for opaque client configuration", () => {
    const store = createMemoryStore();
    const first = store.putClientConfiguration("cli:test", "test/v1", {
      page: 1,
    });
    expect(first.revision).toBe(1);
    expect(() =>
      store.putClientConfiguration("cli:test", "test/v1", { page: 2 }, 0),
    ).toThrow(RevisionConflictError);
    expect(
      store.putClientConfiguration("cli:test", "test/v1", { page: 2 }, 1)
        .revision,
    ).toBe(2);
    store.close();
  });
});
