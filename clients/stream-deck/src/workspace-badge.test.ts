import type { Workspace } from "@agent-deck/domain";
import { workspaceColour } from "@agent-deck/client-sdk";
import { describe, expect, it } from "vitest";
import {
  agentWorkspaceBadgeSvg,
  workspaceAcronym,
  workspaceBadgesNeeded,
  workspaceBadgeSvg,
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

  it("prefers the server-assigned runtime colour", () => {
    const svg = workspaceBadgeSvg({
      ...workspace("workspace:agent-deck", "Agent Deck"),
      colour: "#123456",
    });

    expect(svg).toContain('fill="#123456"');
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
