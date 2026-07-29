import type { Agent } from "@agent-deck/domain";
import { describe, expect, it } from "vitest";
import {
  preserveAgentSlotOrder,
  streamDeckAgents,
} from "./agent-filter.js";

const agent = (overrides: Partial<Agent> = {}): Agent => ({
  id: "cursor-cloud:agent-1",
  providerId: "cursor-cloud",
  externalId: "agent-1",
  title: "Cloud agent",
  state: "idle",
  freshness: "fresh",
  requiresAttention: false,
  lastActivityAt: "2026-07-28T09:00:00.000Z",
  revision: 1,
  archived: false,
  capabilities: {
    messages: false,
    approvals: false,
    cancellation: true,
    creation: false,
  },
  links: [],
  metadata: {},
  ...overrides,
});

describe("Stream Deck agent filtering", () => {
  it("keeps stale agents visible and excludes archived agents", () => {
    expect(
      streamDeckAgents([
        agent(),
        agent({ id: "cursor-cloud:archived", archived: true }),
        agent({ id: "cursor-cloud:stale", freshness: "stale" }),
      ]).map(({ id }) => id),
    ).toEqual(["cursor-cloud:agent-1", "cursor-cloud:stale"]);
  });

  it("keeps existing agents in their slots when their priority changes", () => {
    const first = agent({ id: "first", title: "First" });
    const second = agent({ id: "second", title: "Second" });

    expect(
      preserveAgentSlotOrder(
        [first, second],
        [
          { ...second, requiresAttention: true },
          { ...first, lastActivityAt: "2026-07-28T10:00:00.000Z" },
        ],
      ).map(({ id }) => id),
    ).toEqual(["first", "second"]);
  });

  it("only shifts an agent when an earlier agent is removed", () => {
    const first = agent({ id: "first" });
    const second = agent({ id: "second" });
    const third = agent({ id: "third" });

    expect(
      preserveAgentSlotOrder(
        [first, second, third],
        [{ ...third }, { ...second }],
      ).map(({ id }) => id),
    ).toEqual(["second", "third"]);
  });

  it("adds new agents after the agents already assigned to slots", () => {
    const first = agent({ id: "first" });
    const second = agent({ id: "second" });
    const newcomer = agent({ id: "new" });

    expect(
      preserveAgentSlotOrder(
        [first, second],
        [newcomer, { ...second }, { ...first }],
      ).map(({ id }) => id),
    ).toEqual(["first", "second", "new"]);
  });
});
