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

  it("marks active agents stale without replacing lifecycle state", () => {
    const store = createMemoryStore();
    store.applyProviderEvent({
      providerId: "fake",
      type: "agent.upserted",
      occurredAt: "2026-07-28T09:00:00.000Z",
      agentId: "fake:one",
      payload: { agent: makeAgent("running") },
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
    expect(store.listAttention({ offset: 0, limit: 10 }).items[0]?.type).toBe(
      "stale",
    );
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
