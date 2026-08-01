import { AGENT_STATES } from "@agent-deck/domain";
import { describe, expect, it } from "vitest";
import {
  agentLookScene,
  agentSceneVariant,
  emptyAgentLookScene,
  normalizeAgentKeyLook,
  REMOVED_AGENT_ANIMATION_MS,
  removedAgentLookScene,
} from "./agent-look.js";
import {
  CLASSIC_AGENT_STATE_COLOUR,
  CLASSIC_EMPTY_AGENT_COLOUR,
  LIGHT_KEY_VISUAL_PALETTE,
} from "./agent-palette.js";

describe("agent key look", () => {
  it("keeps classic as the backward-compatible default", () => {
    expect(normalizeAgentKeyLook(undefined)).toBe("classic");
    expect(normalizeAgentKeyLook("classic")).toBe("classic");
    expect(normalizeAgentKeyLook("unsupported")).toBe("classic");
    expect(normalizeAgentKeyLook("agent")).toBe("agent");
  });

  it.each(AGENT_STATES)("renders a valid animated scene for %s", (state) => {
    const first = agentLookScene(state, `agent:${state}`, 0);
    const later = agentLookScene(state, `agent:${state}`, 700);

    expect(first).toContain('<rect width="144" height="144" fill="');
    expect(first).not.toContain('<rect width="144" height="144" rx="24"');
    expect(first).toContain('color="#ffffff"');
    expect(first).toContain('fill="currentColor"');
    expect(first).not.toContain("Gradient");
    expect(first).not.toMatch(/NaN|undefined/);
    expect(later).not.toBe(first);
  });

  it.each(AGENT_STATES)(
    "uses the classic background colour for %s",
    (state) => {
      expect(agentLookScene(state, `colour:${state}`, 0)).toContain(
        `fill="${CLASSIC_AGENT_STATE_COLOUR[state]}"`,
      );
    },
  );

  it.each(AGENT_STATES)(
    "keeps the dark visual treatment for occupied light-mode %s slots",
    (state) => {
      const scene = agentLookScene(
        state,
        `light:${state}`,
        0,
        LIGHT_KEY_VISUAL_PALETTE,
      );
      expect(scene).toContain(
        `fill="${LIGHT_KEY_VISUAL_PALETTE.stateSurface[state]}"`,
      );
      expect(scene).toContain(`color="${LIGHT_KEY_VISUAL_PALETTE.foreground}"`);
    },
  );

  it("uses the light surface with a gray character and unchanged zzz accent", () => {
    const scene = emptyAgentLookScene("slot:4", 0, LIGHT_KEY_VISUAL_PALETTE);
    expect(scene).toContain('<rect width="144" height="144" fill="#e2e8f0"/>');
    expect(scene).toContain('color="#cbd5e1"');
    expect(scene).toContain('<g fill="#ffffff"');
  });

  it.each([
    ["running", "frantic"],
    ["ready_for_review", "celebrate"],
  ] as const)("renders smooth, energetic %s motion", (state, motion) => {
    const frames = Array.from({ length: 10 }, (_, index) =>
      agentLookScene(state, `motion:${state}`, index * 100),
    );

    expect(frames[0]).toContain(`data-motion="${motion}`);
    expect(new Set(frames).size).toBe(10);
  });

  it.each([0, 1] as const)(
    "blinks the question indicator for input variant %s",
    (variant) => {
      const seed = Array.from(
        { length: 64 },
        (_, index) => `question:${index}`,
      ).find(
        (candidate) =>
          agentSceneVariant(candidate, "waiting_for_input") === variant,
      );

      expect(seed).toBeDefined();
      expect(agentLookScene("waiting_for_input", seed!, 0)).toContain(
        'opacity="1.00"',
      );
      expect(agentLookScene("waiting_for_input", seed!, 700)).toContain(
        'opacity="0.12"',
      );
    },
  );

  it.each([...AGENT_STATES, "empty"] as const)(
    "offers two stable variants for %s",
    (state) => {
      const variants = new Set(
        Array.from({ length: 64 }, (_, index) =>
          agentSceneVariant(`agent:${index}`, state),
        ),
      );

      expect(variants).toEqual(new Set([0, 1]));
      expect(agentSceneVariant("stable-agent", state)).toBe(
        agentSceneVariant("stable-agent", state),
      );
    },
  );

  it("animates restful characters for empty slots", () => {
    const first = emptyAgentLookScene("slot:4", 0);
    const later = emptyAgentLookScene("slot:4", 900);

    expect(first).toContain('color="#ffffff"');
    expect(first).toContain(`fill="${CLASSIC_EMPTY_AGENT_COLOUR}"`);
    expect(first).not.toContain("Gradient");
    expect(first).not.toMatch(/NaN|undefined/);
    expect(later).not.toBe(first);
  });

  it("dissolves a removed agent into an empty slot", () => {
    const first = removedAgentLookScene("agent:removed", 0);
    const middle = removedAgentLookScene(
      "agent:removed",
      REMOVED_AGENT_ANIMATION_MS / 2,
    );
    const final = removedAgentLookScene(
      "agent:removed",
      REMOVED_AGENT_ANIMATION_MS,
    );

    expect(first).toContain(`fill="${CLASSIC_EMPTY_AGENT_COLOUR}"`);
    expect(first).toContain('color="#ffffff"');
    expect(new Set([first, middle, final]).size).toBe(3);
    expect(final).not.toMatch(/NaN|undefined/);
  });
});
