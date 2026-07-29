import { describe, expect, it } from "vitest";
import {
  agentLabelOverflows,
  agentLabelSvg,
  agentLabelWidth,
} from "./agent-label.js";

describe("Stream Deck agent labels", () => {
  it("keeps labels that fit centred and static", () => {
    expect(agentLabelOverflows("Fix login")).toBe(false);
    expect(agentLabelSvg("Fix login", 0)).toBe(
      agentLabelSvg("Fix login", 5_000),
    );
    expect(agentLabelSvg("Fix login", 0)).toContain(
      'x="72.00" y="25" text-anchor="middle"',
    );
  });

  it("scrolls overflowing labels continuously through a clipped viewport", () => {
    const label = "Implement continuous Stream Deck label scrolling";
    const initial = agentLabelSvg(label, 0);
    const later = agentLabelSvg(label, 1_000);

    expect(agentLabelOverflows(label)).toBe(true);
    expect(initial).toContain('clip-path="url(#agent-label-clip)"');
    expect(initial).toContain('x="13.00"');
    expect(later).toContain('x="-17.00"');
    expect(later).not.toBe(initial);
    expect(initial.match(/Implement continuous/g)).toHaveLength(2);
  });

  it("wraps back to the same frame after one complete label cycle", () => {
    const label = "A deliberately wide agent label";
    const cycleMs = ((agentLabelWidth(label) + 28) / 30) * 1_000;

    expect(agentLabelSvg(label, cycleMs)).toBe(agentLabelSvg(label, 0));
  });

  it("escapes agent titles before embedding them in SVG", () => {
    expect(agentLabelSvg('Review <API> & "tests"', 0)).toContain(
      "Review &lt;API&gt; &amp; &quot;tests&quot;",
    );
  });
});
