import { describe, expect, it } from "vitest";
import {
  connectorBubblesOverflow,
  connectorBubblesSvg,
  connectorBubblesWidth,
  type ConnectorBubble,
} from "./connector-bubbles.js";

const connectors = (count: number): ConnectorBubble[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `provider-${index}`,
    mark: `P${index}`,
    healthy: index % 2 === 0,
  }));

describe("Stream Deck connector bubbles", () => {
  it("centres a connector list that fits", () => {
    const items = connectors(2);
    const initial = connectorBubblesSvg(items, 0);

    expect(connectorBubblesOverflow(items)).toBe(false);
    expect(initial).toBe(connectorBubblesSvg(items, 5_000));
    expect(initial.match(/data-connector=/g)).toHaveLength(2);
  });

  it("uses green rings for healthy connectors and red rings otherwise", () => {
    const svg = connectorBubblesSvg(connectors(2), 0);

    expect(svg).toContain('stroke="#22c55e"');
    expect(svg).toContain('stroke="#ef4444"');
  });

  it("uses the same provider artwork as agent-key badges", () => {
    const svg = connectorBubblesSvg(
      [
        { id: "cursor-local", mark: "CU", healthy: true },
        { id: "codex", mark: "AI", healthy: true },
      ],
      0,
    );

    expect(svg).toContain("M20.5 5 35 13.5");
    expect(svg).toContain("M60.87 57.26V42.31");
  });

  it("continuously loops a connector list that does not fit", () => {
    const items = connectors(6);
    const initial = connectorBubblesSvg(items, 0);
    const later = connectorBubblesSvg(items, 1_000);

    expect(connectorBubblesOverflow(items)).toBe(true);
    expect(initial).toContain('clip-path="url(#connector-bubbles-clip)"');
    expect(initial.match(/data-connector=/g)).toHaveLength(12);
    expect(later).not.toBe(initial);
  });

  it("wraps back to the same frame after one complete cycle", () => {
    const items = connectors(6);
    const cycleMs = ((connectorBubblesWidth(items) + 12) / 24) * 1_000;

    expect(connectorBubblesSvg(items, cycleMs)).toBe(
      connectorBubblesSvg(items, 0),
    );
  });

  it("escapes connector values before embedding them in SVG", () => {
    const svg = connectorBubblesSvg(
      [{ id: 'provider<&"', mark: "<&", healthy: true }],
      0,
    );

    expect(svg).toContain('data-connector="provider&lt;&amp;&quot;"');
    expect(svg).toContain("&lt;&amp;");
  });
});
