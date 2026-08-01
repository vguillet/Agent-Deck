import { describe, expect, it } from "vitest";
import { WORKSPACE_COLOURS } from "@agent-deck/domain";
import { WorkspaceColourAllocator } from "./workspace-colour-allocator.js";

describe("WorkspaceColourAllocator", () => {
  it("uses an expanded palette of 24 unique colors", () => {
    expect(WORKSPACE_COLOURS).toHaveLength(24);
    expect(new Set(WORKSPACE_COLOURS).size).toBe(24);
  });

  it("keeps assignments stable and unique within one server run", () => {
    const allocator = new WorkspaceColourAllocator(
      () => 0,
      ["#111111", "#222222", "#333333"],
    );

    const colours = ["alpha", "beta", "gamma"].map((id) =>
      allocator.colour(id),
    );

    expect(new Set(colours).size).toBe(3);
    expect(allocator.colour("alpha")).toBe(colours[0]);
  });

  it("creates a fresh assignment order for a new server run", () => {
    const palette = ["#111111", "#222222", "#333333"];
    const firstRun = new WorkspaceColourAllocator(() => 0, palette);
    const secondRun = new WorkspaceColourAllocator(() => 0.999, palette);

    expect(firstRun.colour("alpha")).not.toBe(secondRun.colour("alpha"));
  });

  it("decorates without mutating provider workspace documents", () => {
    const allocator = new WorkspaceColourAllocator(() => 0, ["#111111"]);
    const workspace = {
      id: "workspace:alpha",
      providerId: "agent-deck",
      externalId: "alpha",
      name: "alpha",
      metadata: {},
    };

    expect(allocator.decorate(workspace)).toEqual({
      ...workspace,
      colour: "#111111",
    });
    expect(workspace).not.toHaveProperty("colour");
  });
});
