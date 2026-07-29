import { describe, expect, it } from "vitest";
import { agentProgressSvg } from "./agent-progress.js";

describe("agent progress renderer", () => {
  it("renders coarse activity and explicit counts for active agents", () => {
    const svg = agentProgressSvg(
      {
        activity: "planning",
        plan: { completed: 2, total: 5 },
        observedAt: "2026-07-28T09:00:00.000Z",
      },
      "running",
    );

    expect(svg).toContain("3/5");
    expect(svg).not.toContain("PLANNING");
  });

  it("hides activity when no explicit steps exist", () => {
    expect(
      agentProgressSvg(
        {
          activity: "editing",
          observedAt: "2026-07-28T09:00:00.000Z",
        },
        "running",
      ),
    ).toBe("");
  });

  it("hides progress for terminal agents", () => {
    expect(
      agentProgressSvg(
        {
          activity: "editing",
          observedAt: "2026-07-28T09:00:00.000Z",
        },
        "ready_for_review",
      ),
    ).toBe("");
  });
});
