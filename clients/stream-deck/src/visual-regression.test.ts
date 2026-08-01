import { createHash } from "node:crypto";
import { AGENT_STATES } from "@agent-deck/domain";
import { describe, expect, it } from "vitest";
import {
  agentLookScene,
  emptyAgentLookScene,
  removedAgentLookScene,
} from "./agent-look.js";
import { agentLabelSvg } from "./agent-label.js";
import { agentProgressSvg } from "./agent-progress.js";
import { agentStateIndicatorSvg } from "./agent-state-indicator.js";
import { bringUpImage } from "./bring-up-animation.js";
import { connectorBubblesSvg } from "./connector-bubbles.js";
import { workspaceBadgeSvg } from "./workspace-badge.js";

const digest = (values: readonly string[]): string =>
  createHash("sha256").update(values.join("\n---frame---\n")).digest("hex");

describe("Stream Deck visual regression", () => {
  it("keeps fixed-time agent scenes byte-for-byte stable", () => {
    const frames = AGENT_STATES.flatMap((state) =>
      [0, 337, 700, 1_200].map((elapsedMs) =>
        agentLookScene(state, `visual:${state}`, elapsedMs),
      ),
    );

    expect(digest(frames)).toBe(
      "26559c16c8e5ebec8854da93d8a1ec57b8e27ce2db5820bf7786ec2059044277",
    );
  });

  it("keeps labels, indicators, removal, bubbles, and badges stable", () => {
    const frames = [
      emptyAgentLookScene("visual:empty", 337),
      removedAgentLookScene("visual:removed", 400),
      agentLabelSvg("Implement continuous Stream Deck label scrolling", 777),
      agentStateIndicatorSvg("running", 337),
      agentStateIndicatorSvg("ready_for_review", 0, {
        elapsedMs: 325,
        from: "running",
      }),
      connectorBubblesSvg(
        [
          { id: "cursor-local", mark: "CU", healthy: true },
          { id: "codex", mark: "AI", healthy: false },
          { id: "provider<&", mark: "P", healthy: true },
          { id: "provider-4", mark: "P4", healthy: true },
          { id: "provider-5", mark: "P5", healthy: false },
        ],
        777,
      ),
      workspaceBadgeSvg({ id: "workspace:visual", name: 'R&D "Tools"' }),
    ];

    expect(digest(frames)).toBe(
      "7123ebcad855be3e187a37757e50d6956be9bebb2c0bfccab86c731aac62b1de",
    );
    expect(
      digest([
        agentProgressSvg(
          {
            activity: "planning",
            plan: { completed: 2, total: 5 },
            observedAt: "2026-07-28T09:00:00.000Z",
          },
          "running",
        ),
      ]),
    ).toBe("181115196430c368615f11e47020b2f3da9633b4f1c5151111d688c672ea3e44");
  });

  it("keeps fixed-time deck bring-up frames stable", () => {
    const position = { index: 2, total: 5 };
    const frames = [0, 300, 520, 1_040].map((elapsedMs) =>
      bringUpImage(
        "data:image/svg+xml,visual-frame",
        elapsedMs,
        position,
        "data:image/svg+xml,disconnected-frame",
      ),
    );

    expect(digest(frames)).toBe(
      "cd1295782fef6f39f95674e35dd0aabfcccc60971f2ea2e7b1fb4138dd25663c",
    );
  });
});
