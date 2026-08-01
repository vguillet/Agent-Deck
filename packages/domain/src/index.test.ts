import { describe, expect, it } from "vitest";
import {
  CANONICAL_EVENT_TYPES,
  attentionForAgentState,
  isActiveAgentState,
  isActiveRunState,
  isTerminalVisibleAgentState,
  normalizedWorkspaceRoots,
  workspaceResourcesForRoots,
  type Agent,
  type ProviderSnapshot,
} from "./index.js";

const agent = (state: Agent["state"]): Agent => ({
  id: "fake:one",
  providerId: "fake",
  externalId: "one",
  title: "One",
  state,
  activityEpoch: "run-1",
  requiresAttention: state === "waiting_for_approval",
  lastActivityAt: "2026-07-28T09:00:00.000Z",
  revision: 1,
  capabilities: {
    messages: false,
    approvals: false,
    cancellation: false,
    creation: false,
  },
  links: [],
  metadata: {},
});

describe("attentionForAgentState", () => {
  it("creates semantic approval attention without actions", () => {
    const attention = attentionForAgentState(
      agent("waiting_for_approval"),
      "2026-07-28T09:01:00.000Z",
    );
    expect(attention).toMatchObject({
      type: "approval",
      severity: "warning",
      actions: [],
    });
  });

  it("does not create attention for idle agents", () => {
    expect(
      attentionForAgentState(agent("idle"), "2026-07-28T09:01:00.000Z"),
    ).toBeUndefined();
  });
});

describe("lifecycle state predicates", () => {
  it("classifies only live agent states as active", () => {
    expect(
      [
        "idle",
        "running",
        "recovering",
        "waiting_for_input",
        "waiting_for_approval",
        "ready_for_review",
        "failed",
        "cancelled",
        "unknown",
      ].filter((state) => isActiveAgentState(state as Agent["state"])),
    ).toEqual([
      "running",
      "recovering",
      "waiting_for_input",
      "waiting_for_approval",
    ]);
  });

  it("classifies retained terminal agent states separately", () => {
    expect(
      [
        "idle",
        "running",
        "recovering",
        "waiting_for_input",
        "waiting_for_approval",
        "ready_for_review",
        "failed",
        "cancelled",
        "unknown",
      ].filter((state) =>
        isTerminalVisibleAgentState(state as Agent["state"]),
      ),
    ).toEqual(["ready_for_review", "failed", "cancelled"]);
  });

  it("keeps queued and waiting runs active", () => {
    expect(isActiveRunState("queued")).toBe(true);
    expect(isActiveRunState("waiting_for_input")).toBe(true);
    expect(isActiveRunState("succeeded")).toBe(false);
  });
});

describe("provider lifecycle contract", () => {
  it("uses explicit snapshot reconciliation and removal events", () => {
    const snapshot = {
      reconciliation: "authoritative",
      observedAt: "2026-07-28T09:00:00.000Z",
      workspaces: [],
      projects: [],
      agents: [agent("running")],
      runs: [],
      attention: [],
    } satisfies ProviderSnapshot;

    expect(snapshot.reconciliation).toBe("authoritative");
    expect(CANONICAL_EVENT_TYPES).toContain("agent.removed");
    expect(CANONICAL_EVENT_TYPES).toContain("run.removed");
    expect(CANONICAL_EVENT_TYPES).not.toContain("agent.freshness.changed");
  });
});

describe("workspace resource grouping", () => {
  it("uses one provider-independent identity for equal normalized roots", () => {
    const cursor = workspaceResourcesForRoots("cursor-local", [
      "/workspace/beta",
      "/workspace/alpha/../alpha",
    ]);
    const codex = workspaceResourcesForRoots("codex", [
      "/workspace/alpha",
      "/workspace/beta",
    ]);

    expect(cursor.workspace).toEqual(codex.workspace);
    expect(cursor.workspace?.providerId).toBe("agent-deck");
    expect(cursor.projects.map((project) => project.providerId)).toEqual([
      "cursor-local",
      "cursor-local",
    ]);
    expect(codex.projects.map((project) => project.providerId)).toEqual([
      "codex",
      "codex",
    ]);
  });

  it("normalizes, deduplicates, and sorts local roots", () => {
    expect(
      normalizedWorkspaceRoots([
        "/workspace/beta",
        "/workspace/alpha/../alpha",
        "/workspace/beta",
      ]),
    ).toEqual(["/workspace/alpha", "/workspace/beta"]);
  });
});
