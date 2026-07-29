import { describe, expect, it } from "vitest";
import {
  DOTTED_SPINNER_CYCLE_MS,
  DOTTED_SPINNER_DOT_COUNT,
  dottedSpinnerSvg,
} from "./dotted-spinner.js";

describe("dotted spinner", () => {
  it("renders a complete ring of dots", () => {
    const frame = dottedSpinnerSvg(0);

    expect(frame).toContain('data-motion="dotted-spinner"');
    expect(frame.match(/<circle /g)).toHaveLength(DOTTED_SPINNER_DOT_COUNT);
    expect(frame).not.toContain("NaN");
  });

  it("moves the emphasis around the ring", () => {
    const frames = Array.from({ length: 6 }, (_, index) =>
      dottedSpinnerSvg((DOTTED_SPINNER_CYCLE_MS / 6) * index),
    );

    expect(new Set(frames).size).toBe(frames.length);
  });

  it("returns to the same frame after one cycle", () => {
    expect(dottedSpinnerSvg(DOTTED_SPINNER_CYCLE_MS)).toBe(dottedSpinnerSvg(0));
  });
});
