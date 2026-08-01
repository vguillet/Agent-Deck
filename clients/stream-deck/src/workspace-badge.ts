import type { Agent, Workspace } from "@agent-deck/domain";
import { workspaceAcronym, workspaceColour } from "@agent-deck/client-sdk";
import { basename } from "node:path";
import {
  DARK_KEY_VISUAL_PALETTE,
  type KeyVisualPalette,
} from "./agent-palette.js";

export { workspaceAcronym } from "@agent-deck/client-sdk";

const BADGE_X = 122;
const BADGE_Y = 48;
const BADGE_RADIUS = 13;

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export const workspaceBadgesNeeded = (
  agents: readonly Pick<Agent, "workspaceId">[],
): boolean =>
  new Set(
    agents.flatMap((agent) => (agent.workspaceId ? [agent.workspaceId] : [])),
  ).size > 1;

export const workspaceBadgeSvg = (
  workspace?: Pick<Workspace, "id" | "name" | "colour">,
  palette: KeyVisualPalette = DARK_KEY_VISUAL_PALETTE,
): string => {
  if (!workspace) return "";
  return `<g aria-label="Workspace ${escapeXml(workspace.name)}">
    <circle cx="${BADGE_X}" cy="${BADGE_Y}" r="${BADGE_RADIUS}" fill="${workspaceColour(workspace)}" stroke="${palette.workspaceBadgeBorder}" stroke-opacity=".7" stroke-width="1.5"/>
    <text x="${BADGE_X}" y="${BADGE_Y + 4}" text-anchor="middle" font-family="system-ui" font-size="10" font-weight="800" fill="${palette.workspaceBadgeForeground}">${workspaceAcronym(workspace.name)}</text>
  </g>`;
};

export const agentWorkspaceBadgeSvg = (
  agent: Pick<Agent, "workspaceId" | "metadata">,
  workspace?: Pick<Workspace, "id" | "name" | "colour">,
  palette: KeyVisualPalette = DARK_KEY_VISUAL_PALETTE,
): string => {
  if (workspace) return workspaceBadgeSvg(workspace, palette);
  if (!agent.workspaceId) return "";
  const roots = agent.metadata.workspaceRoots;
  if (!Array.isArray(roots)) return "";
  const workspaceRoots = roots.filter(
    (root): root is string => typeof root === "string" && root.length > 0,
  );
  if (!workspaceRoots.length) return "";
  const firstName = basename(workspaceRoots[0]!) || "Workspace";
  const name =
    workspaceRoots.length === 1
      ? firstName
      : `${firstName} +${workspaceRoots.length - 1}`;
  return workspaceBadgeSvg({ id: agent.workspaceId, name }, palette);
};
