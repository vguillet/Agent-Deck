import type { Workspace } from "@agent-deck/domain";
import { describe, expect, it } from "vitest";
import {
  agentWorkspaceBadgeSvg,
  workspaceAcronym,
  workspaceBadgesNeeded,
  workspaceBadgeSvg,
  workspaceColour,
} from "./workspace-badge.js";

const workspace = (id: string, name: string): Workspace => ({
  id,
  providerId: "cursor-local",
  externalId: id,
  name,
  metadata: {},
});

describe("Stream Deck workspace badges", () => {
  it.each([
    ["Agent Deck", "AD"],
    ["agent-deck", "AD"],
    ["Monorepo", "MO"],
    ["Équipe mobile", "ÉM"],
  ])("turns %s into the %s acronym", (name, acronym) => {
    expect(workspaceAcronym(name)).toBe(acronym);
  });

  it("assigns a stable colour from the workspace identity", () => {
    expect(workspaceColour("workspace:alpha")).toBe(
      workspaceColour("workspace:alpha"),
    );
    expect(workspaceColour("workspace:alpha")).not.toBe(
      workspaceColour("workspace:beta"),
    );
  });

  it("keeps all visible workspace colours distinct", () => {
    const ids = Array.from({ length: 10 }, (_, index) => `workspace:${index}`);
    const colours = ids.map((id) => workspaceColour(id, ids));

    expect(new Set(colours).size).toBe(ids.length);
  });

  it("spreads small workspace sets across the colour wheel", () => {
    const two = ["workspace:alpha", "workspace:beta"];
    expect(two.map((id) => workspaceColour(id, two))).toEqual([
      "#e11d48",
      "#0891b2",
    ]);

    const three = [...two, "workspace:gamma"];
    expect(three.map((id) => workspaceColour(id, three))).toEqual([
      "#e11d48",
      "#16a34a",
      "#4f46e5",
    ]);
  });

  it("only shows badges when agents span multiple workspaces", () => {
    expect(workspaceBadgesNeeded([])).toBe(false);
    expect(
      workspaceBadgesNeeded([
        { workspaceId: "workspace:alpha" },
        { workspaceId: "workspace:alpha" },
      ]),
    ).toBe(false);
    expect(
      workspaceBadgesNeeded([
        { workspaceId: "workspace:alpha" },
        { workspaceId: "workspace:beta" },
      ]),
    ).toBe(true);
  });

  it("renders the badge below the label on the right", () => {
    const svg = workspaceBadgeSvg(
      workspace("workspace:agent-deck", "Agent Deck"),
    );

    expect(svg).toContain('cx="122" cy="48"');
    expect(svg).toContain(">AD</text>");
    expect(svg).toContain(workspaceColour("workspace:agent-deck"));
  });

  it("omits unknown workspaces and escapes accessible labels", () => {
    expect(workspaceBadgeSvg()).toBe("");
    expect(
      workspaceBadgeSvg(workspace("workspace:safe", 'R&D "Tools"')),
    ).toContain('aria-label="Workspace R&amp;D &quot;Tools&quot;"');
  });

  it("derives a missing workspace name from a single agent root", () => {
    const svg = agentWorkspaceBadgeSvg({
      workspaceId: "workspace:agent-deck",
      metadata: {
        workspaceRoots: ["/Users/test/Repos/Agent-Deck"],
      },
    });

    expect(svg).toContain('aria-label="Workspace Agent-Deck"');
    expect(svg).toContain(">AD</text>");
  });

  it("derives a multi-root workspace name and acronym", () => {
    const svg = agentWorkspaceBadgeSvg({
      workspaceId: "workspace:website",
      metadata: {
        workspaceRoots: [
          "/Users/test/Repos/Website",
          "/Users/test/Repos/api",
          "/Users/test/Repos/admin",
        ],
      },
    });

    expect(svg).toContain('aria-label="Workspace Website +2"');
    expect(svg).toContain(">W2</text>");
  });
});
