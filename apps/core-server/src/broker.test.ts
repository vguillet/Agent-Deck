import { describe, expect, it } from "vitest";
import type { CanonicalEvent } from "@agent-deck/domain";
import { topicsForEvent } from "./broker.js";

describe("subscription event topics", () => {
  it("notifies attention-only clients about provider health changes", () => {
    const event = {
      sequence: 1,
      providerId: "fake",
      providerEventId: "health-1",
      type: "provider.health.changed",
      occurredAt: "2026-08-01T20:00:00.000Z",
      payload: {},
    } as CanonicalEvent;

    expect(topicsForEvent(event)).toEqual([
      "attention",
      "providers.health",
      "system.health",
    ]);
  });
});
