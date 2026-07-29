import { describe, expect, it } from "vitest";
import {
  DOTTED_SPINNER_BREATH_MS,
  DOTTED_SPINNER_COUNTER_CYCLE_MS,
  DOTTED_SPINNER_CYCLE_MS,
  DOTTED_SPINNER_DOT_COUNT,
  dottedSpinnerSvg,
} from "./dotted-spinner.js";

const radii = (frame: string): number[] =>
  [...frame.matchAll(/<circle [^>]* r="([\d.]+)"/g)].map((match) =>
    Number(match[1]),
  );

const ringDistances = (frame: string): number[] =>
  [...frame.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)"/g)].map((match) =>
    Math.hypot(Number(match[1]) - 72, Number(match[2]) - 72),
  );

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

  it("moves a second wave in the opposite direction at a different speed", () => {
    const frame = dottedSpinnerSvg(DOTTED_SPINNER_CYCLE_MS / 4);
    const frameRadii = radii(frame);
    const frameDistances = ringDistances(frame);

    expect(DOTTED_SPINNER_COUNTER_CYCLE_MS).not.toBe(DOTTED_SPINNER_CYCLE_MS);
    expect(frameRadii[3]).toBeGreaterThan(7);
    expect(frameRadii[10]).toBeGreaterThan(5);
    expect(frameRadii[11]).toBeGreaterThan(5);
    expect(frameDistances[3]).toBeCloseTo(28);
    expect(frameDistances[10]).toBeLessThan(28);
    expect(frameDistances[11]).toBeLessThan(28);
  });

  it("adds the emphasis of both waves when they meet", () => {
    expect(radii(dottedSpinnerSvg(0))[0]).toBe(12);
  });

  it("slowly grows and shrinks around its centre", () => {
    expect(dottedSpinnerSvg(0)).toContain('data-scale="0.68"');
    expect(dottedSpinnerSvg(DOTTED_SPINNER_BREATH_MS / 2)).toContain(
      'data-scale="1.00"',
    );
  });

  it("returns to the same frame after all animation cycles complete", () => {
    expect(dottedSpinnerSvg(7_200)).toBe(dottedSpinnerSvg(0));
  });
});
