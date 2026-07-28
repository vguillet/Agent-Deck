import { describe, expect, it } from "vitest";
import { attentionForAgentState, type Agent } from "./index.js";

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
