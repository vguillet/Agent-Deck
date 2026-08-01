import { workspaceColour } from "@agent-deck/client-sdk";
import { workspaceResourcesForRoots } from "@agent-deck/domain";
import { describe, expect, it } from "vitest";
import { workspaceStatus } from "./workspace-status.js";

describe("Cursor workspace status", () => {
  it("describes a single-root workspace with its shared colour", () => {
    const roots = ["/workspace/alpha"];
    const workspace = workspaceResourcesForRoots(
      "cursor-local",
      roots,
    ).workspace!;

    expect(workspaceStatus(roots)).toEqual({
      text: "$(circle-filled) AL",
      tooltip: "Agent Deck workspace: alpha",
      colour: workspaceColour(workspace.id),
    });
  });

  it("describes a multi-root workspace", () => {
    expect(
      workspaceStatus(["/workspace/beta", "/workspace/alpha"]),
    ).toMatchObject({
      text: "$(circle-filled) A1",
      tooltip: "Agent Deck workspace: alpha +1",
    });
  });

  it("is stable when workspace roots are reordered", () => {
    expect(workspaceStatus(["/workspace/beta", "/workspace/alpha"])).toEqual(
      workspaceStatus(["/workspace/alpha", "/workspace/beta"]),
    );
  });

  it("prefers the registered runtime colour for the matching workspace", () => {
    const roots = ["/workspace/alpha"];
    const workspace = workspaceResourcesForRoots(
      "cursor-local",
      roots,
    ).workspace!;

    expect(
      workspaceStatus(roots, { ...workspace, colour: "#123456" }),
    ).toMatchObject({ colour: "#123456" });
  });

  it("ignores a stale acknowledgement for another workspace", () => {
    const workspace = workspaceResourcesForRoots("cursor-local", [
      "/workspace/beta",
    ]).workspace!;

    expect(
      workspaceStatus(["/workspace/alpha"], {
        ...workspace,
        colour: "#123456",
      }),
    ).not.toMatchObject({ colour: "#123456" });
  });

  it("omits the marker outside a workspace", () => {
    expect(workspaceStatus([])).toBeUndefined();
  });
});
