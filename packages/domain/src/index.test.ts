import { describe, expect, it } from "vitest";
import {
  attentionForAgentState,
  isAgentActiveOrRecent,
  isRunActiveOrRecent,
  normalizedWorkspaceRoots,
  workspaceResourcesForRoots,
  type Agent,
} from "./index.js";

const agent = (state: Agent["state"]): Agent => ({
  id: "fake:one",
  providerId: "fake",
  externalId: "one",
  title: "One",
  state,
  freshness: "fresh",
  requiresAttention: state === "waiting_for_approval",
  lastActivityAt: "2026-07-28T09:00:00.000Z",
  revision: 1,
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

describe("isAgentActiveOrRecent", () => {
  const now = "2026-07-29T09:00:00.000Z";

  it("retains active agents regardless of activity age", () => {
    for (const state of [
      "running",
      "waiting_for_input",
      "waiting_for_approval",
    ] as const) {
      expect(
        isAgentActiveOrRecent(
          {
            ...agent(state),
            lastActivityAt: "2025-01-01T00:00:00.000Z",
          },
          now,
        ),
      ).toBe(true);
    }
  });

  it("retains non-active agents for 24 hours", () => {
    expect(
      isAgentActiveOrRecent(
        {
          ...agent("idle"),
          lastActivityAt: "2026-07-28T09:00:00.000Z",
        },
        now,
      ),
    ).toBe(true);
    expect(
      isAgentActiveOrRecent(
        {
          ...agent("idle"),
          lastActivityAt: "2026-07-28T08:59:59.999Z",
        },
        now,
      ),
    ).toBe(false);
  });

  it("rejects invalid non-active timestamps", () => {
    expect(
      isAgentActiveOrRecent(
        { ...agent("ready_for_review"), lastActivityAt: "invalid" },
        now,
      ),
    ).toBe(false);
  });
});

describe("isRunActiveOrRecent", () => {
  const now = "2026-07-29T09:00:00.000Z";

  it("retains active runs regardless of age", () => {
    expect(
      isRunActiveOrRecent(
        {
          state: "running",
          startedAt: "2025-01-01T00:00:00.000Z",
        },
        now,
      ),
    ).toBe(true);
  });

  it("expires completed runs after 24 hours", () => {
    expect(
      isRunActiveOrRecent(
        {
          state: "succeeded",
          finishedAt: "2026-07-28T09:00:00.000Z",
        },
        now,
      ),
    ).toBe(true);
    expect(
      isRunActiveOrRecent(
        {
          state: "succeeded",
          finishedAt: "2026-07-28T08:59:59.999Z",
        },
        now,
      ),
    ).toBe(false);
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
