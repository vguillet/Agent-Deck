import type { Agent, Workspace } from "@agent-deck/domain";

const BADGE_X = 122;
const BADGE_Y = 48;
const BADGE_RADIUS = 13;
const WORKSPACE_COLOURS = [
  "#2563eb",
  "#f97316",
  "#a855f7",
  "#14b8a6",
  "#e11d48",
  "#84cc16",
  "#d97706",
  "#06b6d4",
  "#7c3aed",
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
  const assigned = new Map<string, number>();
  const occupied = new Set<number>();
  const ids = Array.from(new Set([...visibleWorkspaceIds, workspaceId])).sort(
    (left, right) => left.localeCompare(right),
  );
  for (const id of ids) {
    let slot = hash(id) % WORKSPACE_COLOURS.length;
    while (occupied.has(slot) && occupied.size < WORKSPACE_COLOURS.length)
      slot = (slot + 1) % WORKSPACE_COLOURS.length;
    assigned.set(id, slot);
    occupied.add(slot);
  }
  return WORKSPACE_COLOURS[assigned.get(workspaceId) ?? 0] ?? "#2563eb";
};

export const workspaceBadgesNeeded = (
  agents: readonly Pick<Agent, "workspaceId">[],
): boolean =>
  new Set(
    agents.flatMap((agent) => (agent.workspaceId ? [agent.workspaceId] : [])),
  ).size > 1;

export const workspaceBadgeSvg = (
  workspace?: Workspace,
  visibleWorkspaceIds: readonly string[] = [],
): string => {
  if (!workspace) return "";
  return `<g aria-label="Workspace ${escapeXml(workspace.name)}">
    <circle cx="${BADGE_X}" cy="${BADGE_Y}" r="${BADGE_RADIUS}" fill="${workspaceColour(workspace.id, visibleWorkspaceIds)}" stroke="white" stroke-opacity=".7" stroke-width="1.5"/>
    <text x="${BADGE_X}" y="${BADGE_Y + 4}" text-anchor="middle" font-family="system-ui" font-size="10" font-weight="800" fill="white">${workspaceAcronym(workspace.name)}</text>
  </g>`;
};
