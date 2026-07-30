import { describe, expect, it } from "vitest";
import { subagentBackgroundSvg } from "./subagent-background.js";

describe("subagent background", () => {
  it("renders deterministic diagonal stripes across the key", () => {
    const svg = subagentBackgroundSvg();

    expect(svg).toContain('id="subagent-stripes"');
    expect(svg).toContain('patternTransform="rotate(45)"');
    expect(svg).toContain('fill="url(#subagent-stripes)"');
    expect(subagentBackgroundSvg()).toBe(svg);
  });
});
