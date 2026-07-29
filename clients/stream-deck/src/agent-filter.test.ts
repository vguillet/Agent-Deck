import type { Agent } from "@agent-deck/domain";
import { describe, expect, it } from "vitest";
import {
  preserveAgentSlotOrder,
  sortAgentsByWorkspace,
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
  it("only keeps fresh, unarchived agents visible", () => {
    expect(
      streamDeckAgents([
        agent(),
        agent({ id: "cursor-cloud:archived", archived: true }),
        agent({ id: "cursor-cloud:stale", freshness: "stale" }),
      ]).map(({ id }) => id),
    ).toEqual(["cursor-cloud:agent-1"]);
  });

  it("groups agents by workspace name while keeping group slots stable", () => {
    const betaFirst = agent({
      id: "beta-first",
      workspaceId: "workspace:beta",
    });
    const alphaFirst = agent({
      id: "alpha-first",
      workspaceId: "workspace:alpha",
    });
    const alphaSecond = agent({
      id: "alpha-second",
      workspaceId: "workspace:alpha",
    });

    expect(
      sortAgentsByWorkspace(
        [betaFirst, alphaFirst, alphaSecond],
        [
          {
            id: "workspace:alpha",
            providerId: "cursor-local",
            externalId: "alpha",
            name: "Alpha",
            metadata: {},
          },
          {
            id: "workspace:beta",
            providerId: "cursor-local",
            externalId: "beta",
            name: "Beta",
            metadata: {},
          },
        ],
      ).map(({ id }) => id),
    ).toEqual(["alpha-first", "alpha-second", "beta-first"]);
  });

  it("puts agents without a workspace after workspace groups", () => {
    expect(
      sortAgentsByWorkspace(
        [
          agent({ id: "unassigned" }),
          agent({ id: "assigned", workspaceId: "workspace:alpha" }),
        ],
        [],
      ).map(({ id }) => id),
    ).toEqual(["assigned", "unassigned"]);
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
