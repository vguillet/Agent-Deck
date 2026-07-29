import { describe, expect, it } from "vitest";
import {
  AGENT_STATE_TRANSITION_MS,
  agentStateIndicatorSvg,
  AgentStateTransitionTracker,
} from "./agent-state-indicator.js";

describe("agent state indicator", () => {
  it("tracks transitions only when the same displayed agent changes state", () => {
    const tracker = new AgentStateTransitionTracker();

    expect(
      tracker.observe("key", { agentId: "agent-1", state: "idle" }, 100),
    ).toBeUndefined();
    expect(
      tracker.observe("key", { agentId: "agent-1", state: "running" }, 200),
    ).toEqual({ elapsedMs: 0, from: "idle" });
    expect(
      tracker.frame("key", { agentId: "agent-1", state: "running" }, 450),
    ).toEqual({ elapsedMs: 250, from: "idle" });
    expect(
      tracker.observe("key", { agentId: "agent-2", state: "failed" }, 500),
    ).toBeUndefined();
  });

  it("keeps one final scheduled frame before retiring a transition", () => {
    const tracker = new AgentStateTransitionTracker();
    tracker.observe("key", { agentId: "agent-1", state: "idle" }, 100);
    tracker.observe("key", { agentId: "agent-1", state: "running" }, 200);

    expect(tracker.has("key")).toBe(true);
    expect(
      tracker.frame(
        "key",
        { agentId: "agent-1", state: "running" },
        200 + AGENT_STATE_TRANSITION_MS,
      ),
    ).toBeUndefined();
    expect(tracker.has("key")).toBe(false);
  });

  it("renders a stable icon without transition markup", () => {
    const svg = agentStateIndicatorSvg("ready_for_review", 0);

    expect(svg).toContain(">✓</text>");
    expect(svg).not.toContain("agent-state-transition");
  });

  it("renders idle agents with a dash", () => {
    expect(agentStateIndicatorSvg("idle", 0)).toContain(">-</text>");
  });

  it("hands off between state icons with a colored pop and halo", () => {
    const svg = agentStateIndicatorSvg("waiting_for_input", 0, {
      elapsedMs: AGENT_STATE_TRANSITION_MS / 2,
      from: "running",
    });

    expect(svg).toContain('data-motion="agent-state-transition"');
    expect(svg).toContain('stroke="#f59e0b"');
    expect(svg).toContain('data-motion="dotted-spinner"');
    expect(svg).toContain(">?</text>");
    expect(svg).not.toMatch(/NaN|undefined/);
  });

  it("produces distinct frames before settling on the new icon", () => {
    const frames = Array.from({ length: 6 }, (_, index) =>
      agentStateIndicatorSvg("ready_for_review", 0, {
        elapsedMs: index * 110,
        from: "waiting_for_approval",
      }),
    );
    const settled = agentStateIndicatorSvg("ready_for_review", 0, {
      elapsedMs: AGENT_STATE_TRANSITION_MS,
      from: "waiting_for_approval",
    });

    expect(new Set(frames).size).toBe(frames.length);
    expect(settled).toContain(">✓</text>");
    expect(settled).not.toContain("agent-state-transition");
  });
});
