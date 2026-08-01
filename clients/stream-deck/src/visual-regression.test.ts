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
import {
  DARK_KEY_VISUAL_PALETTE,
  LIGHT_KEY_VISUAL_PALETTE,
} from "./agent-palette.js";

const digest = (values: readonly string[]): string =>
  createHash("sha256").update(values.join("\n---frame---\n")).digest("hex");

describe("Stream Deck visual regression", () => {
  it.each([
    [
      "dark",
      DARK_KEY_VISUAL_PALETTE,
      "3cba93b259e16526896753d13fb941214cdf690ca011bee6710a2ffc665529e6",
    ],
    [
      "light",
      LIGHT_KEY_VISUAL_PALETTE,
      "3cba93b259e16526896753d13fb941214cdf690ca011bee6710a2ffc665529e6",
    ],
  ] as const)(
    "keeps fixed-time %s agent scenes byte-for-byte stable",
    (_theme, palette, expected) => {
      const frames = AGENT_STATES.flatMap((state) =>
        [0, 337, 700, 1_200].map((elapsedMs) =>
          agentLookScene(state, `visual:${state}`, elapsedMs, palette),
        ),
      );

      expect(digest(frames)).toBe(expected);
    },
  );

  it.each([
    [
      "dark",
      DARK_KEY_VISUAL_PALETTE,
      "88a20dfece1a84afe00ed18ff6ddbcbf2a3948bb8819bfe1ec08e51dc1a14358",
      "3a78332856eca15eea97ec72bc4938db47ee0e2ee482c89f9a45103e083ae0e2",
    ],
    [
      "light",
      LIGHT_KEY_VISUAL_PALETTE,
      "04519b677e1f123a7db142e9204f35e87dc8c912967b2459a690b56868b0dfba",
      "3a78332856eca15eea97ec72bc4938db47ee0e2ee482c89f9a45103e083ae0e2",
    ],
  ] as const)(
    "keeps %s labels, indicators, removal, bubbles, and badges stable",
    (_theme, palette, expected, progressExpected) => {
      const frames = [
        emptyAgentLookScene("visual:empty", 337, palette),
        removedAgentLookScene("visual:removed", 400, palette),
        agentLabelSvg(
          "Implement continuous Stream Deck label scrolling",
          777,
          palette,
        ),
        agentStateIndicatorSvg("running", 337, undefined, palette),
        agentStateIndicatorSvg(
          "ready_for_review",
          0,
          {
            elapsedMs: 325,
            from: "running",
          },
          palette,
        ),
        connectorBubblesSvg(
          [
            { id: "cursor-local", mark: "CU", healthy: true },
            { id: "codex", mark: "AI", healthy: false },
            { id: "provider<&", mark: "P", healthy: true },
            { id: "provider-4", mark: "P4", healthy: true },
            { id: "provider-5", mark: "P5", healthy: false },
          ],
          777,
          palette,
        ),
        workspaceBadgeSvg(
          { id: "workspace:visual", name: 'R&D "Tools"' },
          palette,
        ),
      ];

      expect(digest(frames)).toBe(expected);
      expect(
        digest([
          agentProgressSvg(
            {
              activity: "planning",
              plan: { completed: 2, total: 5 },
              observedAt: "2026-07-28T09:00:00.000Z",
            },
            "running",
            palette,
          ),
        ]),
      ).toBe(progressExpected);
    },
  );

  it.each([
    [
      "dark",
      DARK_KEY_VISUAL_PALETTE,
      "cd1295782fef6f39f95674e35dd0aabfcccc60971f2ea2e7b1fb4138dd25663c",
    ],
    [
      "light",
      LIGHT_KEY_VISUAL_PALETTE,
      "cd1295782fef6f39f95674e35dd0aabfcccc60971f2ea2e7b1fb4138dd25663c",
    ],
  ] as const)(
    "keeps fixed-time %s deck bring-up frames stable",
    (_theme, palette, expected) => {
      const position = { index: 2, total: 5 };
      const frames = [0, 300, 520, 1_040].map((elapsedMs) =>
        bringUpImage(
          "data:image/svg+xml,visual-frame",
          elapsedMs,
          position,
          "data:image/svg+xml,disconnected-frame",
          palette,
        ),
      );

      expect(digest(frames)).toBe(expected);
    },
  );
});
