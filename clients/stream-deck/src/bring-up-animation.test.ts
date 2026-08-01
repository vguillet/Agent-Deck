import { describe, expect, it } from "vitest";
import {
  BRING_UP_ANIMATION_MS,
  bringUpDelayMs,
  bringUpImage,
  bringUpProgress,
  bringUpSequenceDurationMs,
  type BringUpPosition,
} from "./bring-up-animation.js";

const first: BringUpPosition = { index: 0, total: 5 };

describe("Stream Deck bring-up animation", () => {
  it("staggers agent keys in sequence", () => {
    expect(bringUpDelayMs(first)).toBe(0);
    expect(bringUpDelayMs({ index: 2, total: 5 })).toBe(240);
    expect(bringUpDelayMs({ index: 4, total: 5 })).toBe(480);
    expect(bringUpDelayMs({ index: 0, total: 1 })).toBe(0);
    expect(bringUpSequenceDurationMs(5)).toBe(1_040);
    expect(bringUpDelayMs({ index: 0, total: 1, delayMs: 1_040 })).toBe(1_040);
  });

  it("clamps local progress before and after the reveal", () => {
    const last = { index: 4, total: 5 };

    expect(bringUpProgress(-100, first)).toBe(0);
    expect(bringUpProgress(100, last)).toBe(0);
    expect(bringUpProgress(bringUpSequenceDurationMs(5), last)).toBe(1);
    expect(bringUpProgress(BRING_UP_ANIMATION_MS + 100, first)).toBe(1);
  });

  it("wraps the connected image in deterministic reveal frames", () => {
    const initial = decodeURIComponent(
      bringUpImage("data:image/svg+xml,base", 0, first),
    );
    const middle = decodeURIComponent(
      bringUpImage("data:image/svg+xml,base", 310, first),
    );
    const settled = decodeURIComponent(
      bringUpImage("data:image/svg+xml,base", BRING_UP_ANIMATION_MS, first),
    );

    expect(initial).toContain('opacity="0.000"');
    expect(middle).toContain('stroke="#22d3ee"');
    expect(settled).toContain('x="0.000" y="0.000" width="144.000"');
    expect(settled).toContain('opacity="1.000"');
    expect(new Set([initial, middle, settled]).size).toBe(3);
    expect(settled).not.toMatch(/NaN|undefined/);
  });

  it("keeps the disconnected image visible until a slot starts", () => {
    const delayed = decodeURIComponent(
      bringUpImage(
        "data:image/svg+xml,connected",
        100,
        { index: 2, total: 5 },
        "data:image/svg+xml,disconnected",
      ),
    );

    expect(delayed).toContain("data:image/svg+xml,disconnected");
    expect(delayed).toContain('width="144" height="144" opacity="1.000"');
    expect(delayed).toContain('opacity="0.000"');
  });
});
