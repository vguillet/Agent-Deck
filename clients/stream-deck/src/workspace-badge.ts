import type { Agent, Workspace } from "@agent-deck/domain";
import { basename } from "node:path";

const BADGE_X = 122;
const BADGE_Y = 48;
const BADGE_RADIUS = 13;
const WORKSPACE_COLOURS = [
  "#e11d48",
  "#f97316",
  "#d97706",
  "#65a30d",
  "#16a34a",
  "#0d9488",
  "#0891b2",
  "#2563eb",
  "#4f46e5",
  "#7c3aed",
  "#a855f7",
  "#db2777",
] as const;

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const hash = (value: string): number => {
  let result = 2_166_136_261;
  for (const character of value) {
    result ^= character.codePointAt(0) ?? 0;
    result = Math.imul(result, 16_777_619);
  }
  return result >>> 0;
};

export const workspaceAcronym = (name: string): string => {
  const words = name.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length > 1)
    return words
      .slice(0, 2)
      .map((word) => Array.from(word)[0])
      .join("")
      .toLocaleUpperCase();

  return Array.from(words[0] ?? "?")
    .slice(0, 2)
    .join("")
    .toLocaleUpperCase();
};

export const workspaceColour = (
  workspaceId: string,
  visibleWorkspaceIds: readonly string[] = [workspaceId],
): string => {
  const ids = Array.from(new Set([...visibleWorkspaceIds, workspaceId])).sort(
    (left, right) => left.localeCompare(right),
  );
  const index = ids.indexOf(workspaceId);
  const slot =
    ids.length === 1
      ? hash(workspaceId) % WORKSPACE_COLOURS.length
      : Math.floor((index * WORKSPACE_COLOURS.length) / ids.length);
  return WORKSPACE_COLOURS[slot] ?? "#2563eb";
};

export const workspaceBadgesNeeded = (
  agents: readonly Pick<Agent, "workspaceId">[],
): boolean =>
  new Set(
    agents.flatMap((agent) => (agent.workspaceId ? [agent.workspaceId] : [])),
  ).size > 1;

export const workspaceBadgeSvg = (
  workspace?: Pick<Workspace, "id" | "name">,
  visibleWorkspaceIds: readonly string[] = [],
): string => {
  if (!workspace) return "";
  return `<g aria-label="Workspace ${escapeXml(workspace.name)}">
    <circle cx="${BADGE_X}" cy="${BADGE_Y}" r="${BADGE_RADIUS}" fill="${workspaceColour(workspace.id, visibleWorkspaceIds)}" stroke="white" stroke-opacity=".7" stroke-width="1.5"/>
    <text x="${BADGE_X}" y="${BADGE_Y + 4}" text-anchor="middle" font-family="system-ui" font-size="10" font-weight="800" fill="white">${workspaceAcronym(workspace.name)}</text>
  </g>`;
};

export const agentWorkspaceBadgeSvg = (
  agent: Pick<Agent, "workspaceId" | "metadata">,
  workspace?: Pick<Workspace, "id" | "name">,
  visibleWorkspaceIds: readonly string[] = [],
): string => {
  if (workspace) return workspaceBadgeSvg(workspace, visibleWorkspaceIds);
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
  return workspaceBadgeSvg(
    { id: agent.workspaceId, name },
    visibleWorkspaceIds,
  );
};
