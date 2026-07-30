import streamDeck, {
  action,
  type Action,
  type DialAction,
  type DialRotateEvent,
  type DidReceiveSettingsEvent,
  type KeyAction,
  type KeyDownEvent,
  type KeyUpEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import { AgentDeckClient, type WatchHandle } from "@agent-deck/client-sdk";
import type {
  Agent,
  Attention,
  CanonicalEvent,
  Provider,
  Workspace,
} from "@agent-deck/domain";
import {
  focusResultNeedsAlert,
  PressGestureController,
  settleFocusTask,
} from "./focus.js";
import {
  isSubagent,
  orderAgentStack,
  streamDeckAgents,
} from "./agent-filter.js";
import {
  agentLookScene,
  emptyAgentLookScene,
  normalizeAgentKeyLook,
  REMOVED_AGENT_ANIMATION_MS,
  removedAgentLookScene,
  type AgentKeyLook,
} from "./agent-look.js";
import {
  agentLabelBackgroundSvg,
  agentLabelOverflows,
  agentLabelSvg,
} from "./agent-label.js";
import { agentProgressSvg } from "./agent-progress.js";
import {
  connectorBubblesOverflow,
  connectorBubblesSvg,
  type ConnectorBubble,
} from "./connector-bubbles.js";
import {
  CLASSIC_AGENT_STATE_COLOUR,
  CLASSIC_EMPTY_AGENT_COLOUR,
} from "./agent-palette.js";
import {
  AnimationFrameScheduler,
  runningAnimationNeedsReset,
  type RunningAnimationStart,
} from "./animation-scheduler.js";
import {
  agentEdgeFrameSvg,
  agentModeFrameSvg,
  agentModeStyle,
  type AgentModeStyle,
} from "./agent-mode.js";
import {
  agentStateIndicatorSvg,
  AgentStateTransitionTracker,
  type AgentStateTransitionFrame,
} from "./agent-state-indicator.js";
import {
  agentWorkspaceBadgeSvg,
  workspaceBadgesNeeded,
} from "./workspace-badge.js";
import { ActionOutputWriter } from "./action-output-writer.js";
import { subagentBackgroundSvg } from "./subagent-background.js";
import {
  addRefreshResources,
  actionManifestIdsForResources,
  allRefreshResources,
  refreshResourcesForEvent,
  type RefreshResource,
} from "./refresh-plan.js";

interface ActionSettings {
  slot?: number;
  look?: AgentKeyLook;
  summaryProviderId?: string;
  showSubagents?: boolean;
  [key: string]: string | number | boolean | null | undefined;
}

interface DeviceConfiguration {
  serverUrl: string;
  name: string;
  role: string;
  providers: string[];
  states: Agent["state"][];
  showSubagents: boolean;
}

interface DeviceSession {
  deviceId: string;
  client: AgentDeckClient;
  configuration: DeviceConfiguration;
  connectionStatus: "connecting" | "connected" | "disconnected";
  allAgents: Agent[];
  agentById: Map<string, Agent>;
  agents: Agent[];
  workspaceBadgeByAgentId: Map<string, string>;
  agentStaticVisuals: Map<string, AgentStaticVisuals>;
  agentSummaries: Map<string, AgentSummary>;
  attention: Attention[];
  providers: Provider[];
  providerBubbles: ConnectorBubble[];
  providerBubblesOverflow: boolean;
  unhealthyProviderCount: number;
  workspaces: Workspace[];
  workspaceById: Map<string, Workspace>;
  visibleWorkspaceIds: string[];
  health: Record<string, unknown>;
  page: number;
  attentionIndex: number;
  watch?: WatchHandle;
  refreshTimer: NodeJS.Timeout | undefined;
  refreshPromise: Promise<void> | undefined;
  refreshResources: Set<RefreshResource>;
  clearingAgents: boolean;
  lastSnapshotSequence: number;
  animationStartedAt: number;
  runningAnimationStarts: Map<string, RunningAnimationStart>;
}

interface AgentSummary {
  attention: number;
  failed: boolean;
  reviewing: boolean;
  running: number;
  total: number;
  waiting: boolean;
}

interface AgentStaticVisuals {
  modeFrame: string;
  modeIcon: string;
  providerLogo: string;
  workspaceBadge: string;
}

const ALL_AGENT_STATES: Agent["state"][] = [
  "idle",
  "running",
  "waiting_for_input",
  "waiting_for_approval",
  "ready_for_review",
  "failed",
  "cancelled",
  "unknown",
];

const DEFAULT_CONFIGURATION: DeviceConfiguration = {
  serverUrl: "http://127.0.0.1:47831",
  name: "Stream Deck",
  role: "agent-monitor",
  providers: [],
  states: ALL_AGENT_STATES,
  showSubagents: false,
};

const settle = async <T>(
  promise: Promise<T>,
): Promise<PromiseSettledResult<T>> => {
  try {
    return { status: "fulfilled", value: await promise };
  } catch (reason) {
    return { status: "rejected", reason };
  }
};

const LONG_PRESS_DURATION_MS = 650;

interface ProviderStyle {
  accent: string;
  label: string;
  mark: string;
}

interface IconOptions {
  showStrip?: boolean;
  showBadge?: boolean;
  muted?: boolean;
  glyph?: string;
}

const muteSvgContent = (content: string, muted: boolean): string =>
  muted
    ? `<defs>
        <filter id="agent-slot-muted">
          <feColorMatrix type="saturate" values="0"/>
        </filter>
      </defs>
      <g filter="url(#agent-slot-muted)" opacity=".55">${content}</g>
      <rect width="144" height="144" fill="#64748b" opacity=".32"/>`
    : content;

const providerStyle = (providerId: string): ProviderStyle => {
  const id = providerId.toLowerCase();
  if (id.includes("codex") || id.includes("openai") || id.includes("chatgpt"))
    return { accent: "#10a37f", label: "OpenAI", mark: "AI" };
  if (id.includes("cursor"))
    return { accent: "#8b5cf6", label: "Cursor", mark: "CU" };
  if (id.includes("claude"))
    return { accent: "#d97757", label: "Claude", mark: "CL" };
  if (id.includes("gemini"))
    return { accent: "#4285f4", label: "Gemini", mark: "GE" };
  if (id.includes("fake") || id.includes("demo"))
    return { accent: "#06b6d4", label: "Demo", mark: "DM" };
  return {
    accent: "#94a3b8",
    label: providerId || "Agent",
    mark: "AG",
  };
};

const providerBubbles = (providers: readonly Provider[]): ConnectorBubble[] =>
  providers.map((provider) => ({
    id: provider.id,
    mark: providerStyle(provider.id).mark,
    healthy: provider.health === "healthy",
  }));

const emptyAgentSummary = (): AgentSummary => ({
  attention: 0,
  failed: false,
  reviewing: false,
  running: 0,
  total: 0,
  waiting: false,
});

const addAgentToSummary = (summary: AgentSummary, agent: Agent): void => {
  summary.total += 1;
  summary.running += Number(agent.state === "running");
  summary.attention += Number(agent.requiresAttention);
  summary.failed ||= agent.state === "failed";
  summary.waiting ||=
    agent.state === "waiting_for_input" ||
    agent.state === "waiting_for_approval";
  summary.reviewing ||= agent.state === "ready_for_review";
};

const rebuildAgentRenderCache = (session: DeviceSession): void => {
  session.agentById = new Map(
    session.allAgents.map((agent) => [agent.id, agent]),
  );
  session.workspaceById = new Map(
    session.workspaces.map((workspace) => [workspace.id, workspace]),
  );
  session.visibleWorkspaceIds = session.agents.flatMap((agent) =>
    agent.workspaceId ? [agent.workspaceId] : [],
  );
  const badgesNeeded = workspaceBadgesNeeded(session.agents);
  session.workspaceBadgeByAgentId = new Map(
    session.agents.map((agent) => [
      agent.id,
      badgesNeeded
        ? agentWorkspaceBadgeSvg(
            agent,
            agent.workspaceId
              ? session.workspaceById.get(agent.workspaceId)
              : undefined,
            session.visibleWorkspaceIds,
          )
        : "",
    ]),
  );
  session.agentStaticVisuals = new Map(
    session.agents.map((agent) => [
      agent.id,
      buildAgentStaticVisuals(
        agent,
        session.workspaceBadgeByAgentId.get(agent.id) ?? "",
      ),
    ]),
  );

  const summaries = new Map<string, AgentSummary>();
  const all = emptyAgentSummary();
  summaries.set("", all);
  for (const agent of session.allAgents) {
    addAgentToSummary(all, agent);
    let provider = summaries.get(agent.providerId);
    if (!provider) {
      provider = emptyAgentSummary();
      summaries.set(agent.providerId, provider);
    }
    addAgentToSummary(provider, agent);
  }
  session.agentSummaries = summaries;
};

const rebuildProviderRenderCache = (session: DeviceSession): void => {
  session.providerBubbles = providerBubbles(session.providers);
  session.providerBubblesOverflow = connectorBubblesOverflow(
    session.providerBubbles,
  );
  session.unhealthyProviderCount = session.providers.filter(
    (provider) =>
      provider.health === "unhealthy" || provider.health === "degraded",
  ).length;
};

const icon = (
  colour: string,
  symbol: string,
  accent = "#94a3b8",
  badge?: string,
  options: IconOptions = {},
): string => {
  const showStrip = options.showStrip ?? true;
  const showBadge = options.showBadge ?? true;
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
    ${muteSvgContent(
      `<rect width="144" height="144" fill="${colour}"/>
    ${showStrip ? `<rect width="144" height="13" rx="7" fill="${accent}"/>` : ""}
    ${
      showBadge
        ? `<circle cx="114" cy="31" r="20" fill="${accent}"/>
    <text x="114" y="37" text-anchor="middle" font-family="system-ui" font-size="15" font-weight="800" fill="white">${badge ?? ""}</text>`
        : ""
    }
    ${
      options.glyph ??
      `<text x="72" y="${showBadge ? 98 : 93}" text-anchor="middle" font-family="system-ui" font-size="58" font-weight="700" fill="white">${symbol}</text>`
    }`,
      options.muted ?? false,
    )}
  </svg>`,
  )}`;
};

type SystemDisplayState =
  "connected" | "connecting" | "disconnected" | "degraded";

const SYSTEM_STATUS_PATHS: Record<SystemDisplayState, string> = {
  connected: `<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>`,
  connecting: `<path d="M21 12a9 9 0 0 0-15.5-6.2L3 8"/>
    <path d="M3 3v5h5"/>
    <path d="M3 12a9 9 0 0 0 15.5 6.2L21 16"/>
    <path d="M21 21v-5h-5"/>`,
  disconnected: `<path d="M9.2 14.8 6.5 17.5a3.5 3.5 0 0 1-5-5l3-3a3.5 3.5 0 0 1 4.9-.1"/>
    <path d="M14.8 9.2 17.5 6.5a3.5 3.5 0 0 1 5 5l-3 3a3.5 3.5 0 0 1-4.9.1"/>
    <path d="m3 3 18 18"/>`,
  degraded: `<path d="M10.3 3.7 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z"/>
    <path d="M12 9v4"/>
    <path d="M12 17h.01"/>`,
};

const systemStatusGlyph = (state: SystemDisplayState): string => {
  return `<g transform="translate(36 36) scale(3)" fill="none" stroke="white" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
    ${SYSTEM_STATUS_PATHS[state]}
  </g>`;
};

const systemDisplay = (
  session: DeviceSession,
): { colour: string; state: SystemDisplayState } => {
  const status =
    typeof session.health.status === "string"
      ? session.health.status
      : "unknown";
  if (
    session.connectionStatus === "connecting" ||
    status === "connecting" ||
    status === "restarting" ||
    status === "loading" ||
    status === "starting"
  )
    return { colour: "#f59e0b", state: "connecting" };
  if (session.connectionStatus === "disconnected" || status === "disconnected")
    return { colour: "#dc2626", state: "disconnected" };
  if (session.connectionStatus === "connected" && status === "healthy")
    return {
      colour: CLASSIC_AGENT_STATE_COLOUR.ready_for_review,
      state: "connected",
    };
  return { colour: "#dc2626", state: "degraded" };
};

const systemIcon = (
  session: DeviceSession,
  animationElapsedMs: number,
): string => {
  const display = systemDisplay(session);
  return icon(display.colour, "", "#0f172a", String(session.allAgents.length), {
    showStrip: false,
    glyph: `${systemStatusGlyph(display.state)}
        ${connectorBubblesSvg(session.providerBubbles, animationElapsedMs)}`,
  });
};

const title = (value: string, max = 18): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const renderProviderLogo = (providerId: string): string => {
  const id = providerId.toLowerCase();
  if (id.includes("cursor"))
    return `<g transform="translate(0 93)">
      <rect x="98" y="5" width="41" height="41" rx="10" fill="#11100d"/>
      <path d="M118.5 10L133 18.5V35L118.5 43.5L104 35V18.5L118.5 10Z" fill="#4c4b47"/>
      <path d="M106 19.5H131L118.5 27.5L106 19.5Z" fill="white"/>
      <path d="M131 19.5L118.5 41V27.5L131 19.5Z" fill="#d5d4d1"/>
      <path d="M104 35V18.5L118.5 27.5L104 35Z" fill="#5f5e5a"/>
      <path d="M104 35L118.5 27.5V43.5L104 35Z" fill="#85847f"/>
    </g>`;
  if (id.includes("codex") || id.includes("openai") || id.includes("chatgpt"))
    return `<g transform="translate(0 93)">
      <rect x="98" y="5" width="41" height="41" rx="10" fill="#11100d"/>
      <g transform="translate(104 11) scale(.18)">
        <path d="M60.87 57.26V42.31c0-1.26.47-2.2 1.57-2.83l30.05-17.3c4.09-2.36 8.97-3.46 14-3.46 18.88 0 30.83 14.63 30.83 30.2 0 1.1 0 2.36-.16 3.62l-31.14-18.25c-1.89-1.1-3.78-1.1-5.66 0L60.87 57.26Zm70.16 58.2V79.75c0-2.2-.94-3.78-2.83-4.88L88.71 51.91l12.9-7.39c1.1-.63 2.05-.63 3.15 0l30.04 17.3c8.65 5.03 14.47 15.73 14.47 26.11 0 11.95-7.08 22.97-18.24 27.53ZM51.59 84 38.7 76.45c-1.1-.63-1.58-1.58-1.58-2.84v-34.6c0-16.83 12.9-29.57 30.36-29.57 6.61 0 12.74 2.2 17.93 6.13L54.43 33.5c-1.89 1.1-2.83 2.67-2.83 4.88V84Zm27.77 16.04L60.87 89.66V67.64l18.49-10.38 18.48 10.38v22.02l-18.48 10.38Zm11.87 47.82c-6.61 0-12.74-2.2-17.93-6.13l30.99-17.94c1.89-1.1 2.83-2.67 2.83-4.88V73.3l13.05 7.55c1.1.63 1.58 1.57 1.58 2.83v34.61c0 16.83-13.06 29.57-30.52 29.57Zm-37.28-35.08L23.91 95.48c-8.65-5.03-14.47-15.73-14.47-26.11 0-12.11 7.24-22.97 18.4-27.53v35.87c0 2.2.94 3.77 2.83 4.87L70 105.39l-12.9 7.39c-1.1.63-2.05.63-3.15 0Zm-1.73 25.8c-17.77 0-30.83-13.37-30.83-29.89 0-1.26.16-2.52.32-3.77l30.98 17.93c1.89 1.1 3.78 1.1 5.67 0l39.48-22.81v14.95c0 1.26-.47 2.2-1.58 2.83l-30.04 17.3c-4.09 2.36-8.97 3.46-14 3.46Z" fill="white"/>
      </g>
    </g>`;
  const mark = escapeXml(providerStyle(providerId).mark);
  return `<g transform="translate(0 93)">
      <circle cx="116" cy="24" r="17" fill="#000" opacity=".3"/>
      <text x="116" y="29" text-anchor="middle" font-family="system-ui" font-size="12" font-weight="800" fill="white">${mark}</text>
    </g>`;
};

const providerLogoCache = new Map<string, string>();

const providerLogo = (providerId: string): string => {
  const cached = providerLogoCache.get(providerId);
  if (cached) return cached;
  const logo = renderProviderLogo(providerId);
  providerLogoCache.set(providerId, logo);
  if (providerLogoCache.size > 128) {
    const oldest = providerLogoCache.keys().next().value;
    if (oldest !== undefined) providerLogoCache.delete(oldest);
  }
  return logo;
};

const agentModeIcon = (style: AgentModeStyle): string => {
  const common = `fill="none" stroke="${style.colour}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"`;
  let glyph: string;
  if (style.icon === "plan")
    glyph = `<path transform="translate(10 42) scale(.115 -.115)" fill="${style.colour}" d="M75 170Q63 170 52 176.5Q41 183 34.5 194Q28 205 28 218Q28 231 34.5 241.5Q41 252 52 258.5Q63 265 75.5 265Q88 265 99 258.5Q110 252 116.5 241.5Q123 231 123 218Q123 205 116.5 194Q110 183 99 176.5Q88 170 75 170ZM75 186Q84 186 91 190.5Q98 195 102.5 202Q107 209 107 217.5Q107 226 102.5 233Q98 240 91 244.5Q84 249 75.5 249Q67 249 60 244.5Q53 240 48.5 233Q44 226 44 217.5Q44 209 48.5 202Q53 195 60 190.5Q67 186 75 186ZM75 43Q63 43 52 49.5Q41 56 34.5 67Q28 78 28 90.5Q28 103 34.5 114Q41 125 52 131.5Q63 138 75.5 138Q88 138 99 131.5Q110 125 116.5 114.5Q123 104 123 91Q123 78 116.5 67Q110 56 99 49.5Q88 43 75 43ZM75 59Q84 59 91 63.5Q98 68 102.5 75Q107 82 107 90.5Q107 99 102.5 106Q98 113 91 117.5Q84 122 75.5 122Q67 122 60 117.5Q53 113 48.5 106Q44 99 44 90.5Q44 82 48.5 75Q53 68 60 63.5Q67 59 75 59ZM156 209Q152 209 149.5 211.5Q147 214 147 217.5Q147 221 149.5 223.5Q152 226 156 226H265Q269 226 271.5 223.5Q274 221 274 217.5Q274 214 271.5 211.5Q269 209 265 209ZM156 82Q152 82 149.5 84.5Q147 87 147 90.5Q147 94 149.5 96.5Q152 99 156 99H265Q269 99 271.5 96.5Q274 94 274 90.5Q274 87 271.5 84.5Q269 82 265 82Z"/>`;
  else if (style.icon === "debug")
    glyph = `<path transform="translate(9 43) scale(.115 -.115)" fill="${style.colour}" d="M162 288Q162 295 157.5 297Q153 299 148 295L105 265Q101 262 101 257.5Q101 253 105 250L148 220Q153 216 157.5 218Q162 220 162 227ZM136 0Q173 0 204 18.5Q235 37 253.5 68Q272 99 272 136Q272 173 253.5 204Q235 235 204 253.5Q173 272 136 272Q131 272 128 268.5Q125 265 125 260.5Q125 256 128 252.5Q131 249 136 249Q167 249 193 234Q219 219 234 193Q249 167 249 136Q249 105 234 79Q219 53 193 38Q167 23 136 23Q105 23 79 38Q53 53 38 79Q23 105 23 136Q23 164 35.5 188Q48 212 70 227Q74 231 75 235Q76 239 73.5 243.5Q71 248 66 248.5Q61 249 57 246Q30 227 15 198Q0 169 0 136Q0 99 18.5 68Q37 37 68 18.5Q99 0 136 0ZM121 73Q128 73 132 79L193 175Q196 180 196 183.5Q196 187 193 190Q190 193 185 193Q180 193 176 187L121 98L95 132Q91 138 85.5 138Q80 138 77 134.5Q74 131 74 127Q74 123 77 119L110 79Q115 73 121 73Z"/>`;
  else
    glyph = `<g ${common}>
      <path d="M14 15h24v17H25l-7 6v-6h-4z"/>
    </g>`;
  return `<g transform="translate(0 92)">
      <circle cx="26" cy="26" r="19" fill="#000" opacity=".55"/>
      ${glyph}
    </g>`;
};

const buildAgentStaticVisuals = (
  agent: Agent,
  workspaceBadge: string,
): AgentStaticVisuals => {
  const modeStyle = agentModeStyle(agent);
  return {
    modeFrame: modeStyle ? agentModeFrameSvg(modeStyle) : "",
    modeIcon: modeStyle ? agentModeIcon(modeStyle) : "",
    providerLogo: providerLogo(agent.providerId),
    workspaceBadge,
  };
};

const agentIcon = (
  agent: Agent,
  staticVisuals: AgentStaticVisuals,
  animation: { elapsedMs: number; stateElapsedMs: number },
  look: AgentKeyLook,
  muted = false,
  pressed = false,
  stateTransition?: AgentStateTransitionFrame,
): string => {
  const scene =
    look === "agent"
      ? agentLookScene(agent.state, agent.id, animation.elapsedMs)
      : `<rect width="144" height="144" fill="${CLASSIC_AGENT_STATE_COLOUR[agent.state]}"/>
      ${agentStateIndicatorSvg(agent.state, animation.stateElapsedMs, stateTransition)}`;
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
      ${muteSvgContent(
        `${scene}
      ${isSubagent(agent) ? subagentBackgroundSvg() : ""}
      ${agentLabelBackgroundSvg()}
      ${agentLabelSvg(agent.title, animation.elapsedMs)}
      ${agentProgressSvg(agent.progress, agent.state)}
      ${staticVisuals.modeFrame}
      ${staticVisuals.providerLogo}
      ${staticVisuals.modeIcon}
      ${staticVisuals.workspaceBadge}
      `,
        muted,
      )}
      ${pressed ? agentEdgeFrameSvg("#ffffff") : ""}
    </svg>`,
  )}`;
};

const emptyAgentIcon = (
  label: string,
  seed: string,
  animationElapsedMs: number,
  muted = false,
): string =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
      ${muteSvgContent(
        `${emptyAgentLookScene(seed, animationElapsedMs)}
      ${agentLabelBackgroundSvg()}
      ${agentLabelSvg(label, animationElapsedMs)}
      `,
        muted,
      )}
    </svg>`,
  )}`;

const removedAgentIcon = (
  seed: string,
  elapsedMs: number,
  muted = false,
): string =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
      ${muteSvgContent(removedAgentLookScene(seed, elapsedMs), muted)}
    </svg>`,
  )}`;

interface AnimatedTarget {
  actionContext: DialAction<ActionSettings> | KeyAction<ActionSettings>;
  session: DeviceSession;
  kind: "agent" | "system";
}

interface AgentRemovalTransition {
  agentId: string;
  seed: string;
  startedAt: number;
}

type AgentDeletionResult = "blocked" | "ignored" | "missing" | "removed";

class DeviceManager {
  private readonly sessions = new Map<string, DeviceSession>();
  private readonly pendingSessions = new Map<string, Promise<DeviceSession>>();
  private readonly actionSettings = new Map<string, ActionSettings>();
  private readonly desiredAgentIds = new Map<string, string>();
  private readonly frozenAgentIds = new Map<string, string>();
  private readonly renderedAgentLooks = new Map<string, AgentKeyLook>();
  private readonly renderedAgentLabels = new Map<string, string>();
  private readonly agentStateTransitions = new AgentStateTransitionTracker();
  private readonly pressedAgentActions = new Set<string>();
  private readonly focusRequestVersions = new Map<string, number>();
  private readonly removalTransitions = new Map<
    string,
    AgentRemovalTransition
  >();
  private readonly outputWriter = new ActionOutputWriter<string>();
  private readonly animationScheduler =
    new AnimationFrameScheduler<AnimatedTarget>({
      targets: () => this.animatedTargets(),
      key: (target) => target.actionContext.id,
      render: (target) => this.renderAnimatedTarget(target),
      onError: (error) => {
        streamDeck.logger.error(
          `Agent Deck animation failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      },
    });

  private runningAnimationElapsedMs(
    session: DeviceSession,
    agent: Agent,
    now: number,
  ): number {
    const animation = session.runningAnimationStarts.get(agent.id);
    return animation ? Math.max(0, now - animation.startedAt) : 0;
  }

  rememberAction(
    actionContext: Action<ActionSettings>,
    settings: ActionSettings,
  ): void {
    this.actionSettings.set(actionContext.id, settings);
  }

  actionIsVisible(actionId: string): boolean {
    return this.actionSettings.has(actionId);
  }

  forgetAction(actionId: string): void {
    this.actionSettings.delete(actionId);
    this.desiredAgentIds.delete(actionId);
    this.frozenAgentIds.delete(actionId);
    this.renderedAgentLooks.delete(actionId);
    this.renderedAgentLabels.delete(actionId);
    this.agentStateTransitions.clear(actionId);
    this.pressedAgentActions.delete(actionId);
    this.focusRequestVersions.set(
      actionId,
      (this.focusRequestVersions.get(actionId) ?? 0) + 1,
    );
    this.removalTransitions.delete(actionId);
    this.outputWriter.clear(actionId);
  }

  async ensure(actionContext: Action<ActionSettings>): Promise<DeviceSession> {
    const deviceId = actionContext.device.id;
    const current = this.sessions.get(deviceId);
    if (current) return current;
    const pending = this.pendingSessions.get(deviceId);
    if (pending) return pending;
    const creation = this.createSession(actionContext);
    this.pendingSessions.set(deviceId, creation);
    try {
      return await creation;
    } finally {
      this.pendingSessions.delete(deviceId);
    }
  }

  private async createSession(
    actionContext: Action<ActionSettings>,
  ): Promise<DeviceSession> {
    const deviceId = actionContext.device.id;
    const global = await streamDeck.settings.getGlobalSettings<{
      serverUrl?: string;
    }>();
    const serverUrl = global.serverUrl ?? DEFAULT_CONFIGURATION.serverUrl;
    const client = new AgentDeckClient(serverUrl);
    const document = await client
      .getClientConfiguration(`stream-deck:${deviceId}`)
      .catch(() => undefined);
    const configuration: DeviceConfiguration = {
      ...DEFAULT_CONFIGURATION,
      serverUrl,
      name: actionContext.device.name || DEFAULT_CONFIGURATION.name,
      ...(document?.data ?? {}),
    };
    // State selection is not user-configurable. Include newly introduced
    // states when loading configuration documents saved by older versions.
    configuration.states = Array.from(
      new Set<Agent["state"]>([...configuration.states, ...ALL_AGENT_STATES]),
    );
    const session: DeviceSession = {
      deviceId,
      client,
      configuration,
      connectionStatus: "connecting",
      allAgents: [],
      agentById: new Map(),
      agents: [],
      workspaceBadgeByAgentId: new Map(),
      agentStaticVisuals: new Map(),
      agentSummaries: new Map([["", emptyAgentSummary()]]),
      attention: [],
      providers: [],
      providerBubbles: [],
      providerBubblesOverflow: false,
      unhealthyProviderCount: 0,
      workspaces: [],
      workspaceById: new Map(),
      visibleWorkspaceIds: [],
      health: {},
      page: 0,
      attentionIndex: 0,
      refreshTimer: undefined,
      refreshPromise: undefined,
      refreshResources: new Set(),
      clearingAgents: false,
      lastSnapshotSequence: 0,
      animationStartedAt: Date.now(),
      runningAnimationStarts: new Map(),
    };
    this.sessions.set(deviceId, session);
    await this.refresh(session);
    session.watch = client.watch(
      {
        id: `stream-deck:${deviceId}`,
        type: "stream-deck",
        name: configuration.name,
        version: "0.1.0",
        capabilities: {
          notifications: true,
          images: true,
          animations: true,
          textInput: false,
          approvalActions: false,
        },
        metadata: { role: configuration.role },
      },
      {
        afterSequence: session.lastSnapshotSequence,
        topics: [
          "agents.summary",
          "attention",
          "providers.health",
          "system.health",
        ],
        filter: {
          ...(configuration.providers.length
            ? { providers: configuration.providers }
            : {}),
        },
        onEvent: (event) => this.onEvent(session, event),
        onResyncRequired: () => {
          void this.refresh(session);
        },
        onStatus: (status) => {
          const previousStatus = session.connectionStatus;
          session.connectionStatus = status;
          if (status === "disconnected") {
            session.allAgents = [];
            session.agents = [];
            session.attention = [];
            session.page = 0;
            session.attentionIndex = 0;
            rebuildAgentRenderCache(session);
            void this.renderVisible(session.deviceId);
          } else if (status === "connected" && previousStatus !== "connected")
            void this.refresh(session);
          else void this.renderVisible(session.deviceId);
        },
      },
    );
    this.animationScheduler.start();
    return session;
  }

  async renderAgent(
    actionContext: Action<ActionSettings>,
    settings: ActionSettings,
  ): Promise<void> {
    const session = await this.ensure(actionContext);
    const automaticSlot =
      actionContext.isKey() && actionContext.coordinates
        ? actionContext.coordinates.row * actionContext.device.size.columns +
          actionContext.coordinates.column
        : 0;
    const slot = Math.max(0, Number(settings.slot ?? automaticSlot));
    const pageSize =
      actionContext.device.size.columns * actionContext.device.size.rows || 1;
    const slotAgent = session.agents[session.page * pageSize + slot];
    const frozenAgentId = this.frozenAgentIds.get(actionContext.id);
    const agent = frozenAgentId
      ? session.agentById.get(frozenAgentId)
      : slotAgent;
    if (frozenAgentId && !agent) return;
    const look = normalizeAgentKeyLook(settings.look);
    const label = agent?.title ?? `Agent ${slot + 1}`;
    const muted = session.connectionStatus !== "connected";
    const removal = this.removalTransitions.get(actionContext.id);
    if (removal) {
      this.agentStateTransitions.clear(actionContext.id);
      this.desiredAgentIds.delete(actionContext.id);
      this.renderedAgentLooks.set(actionContext.id, look);
      this.renderedAgentLabels.set(actionContext.id, "Removed");
      const image = removedAgentIcon(
        removal.seed,
        Date.now() - removal.startedAt,
        muted,
      );
      if (actionContext.isKey() || actionContext.isDial())
        await this.outputWriter.write(
          actionContext,
          { title: "", image },
          { binding: undefined },
        );
      return;
    }
    let stateTransition: AgentStateTransitionFrame | undefined;
    if (look === "classic")
      stateTransition = this.agentStateTransitions.observe(
        actionContext.id,
        agent ? { agentId: agent.id, state: agent.state } : undefined,
      );
    else this.agentStateTransitions.clear(actionContext.id);
    if (agent) this.desiredAgentIds.set(actionContext.id, agent.id);
    else this.desiredAgentIds.delete(actionContext.id);
    this.renderedAgentLooks.set(actionContext.id, look);
    this.renderedAgentLabels.set(actionContext.id, label);
    if (!agent) {
      if (look === "agent") {
        const image = emptyAgentIcon(
          label,
          actionContext.id,
          Date.now() - session.animationStartedAt,
          muted,
        );
        if (actionContext.isKey() || actionContext.isDial())
          await this.outputWriter.write(
            actionContext,
            { title: "", image },
            { binding: undefined },
          );
        return;
      }
      if (actionContext.isKey() || actionContext.isDial())
        await this.outputWriter.write(
          actionContext,
          {
            title: label,
            image: icon(CLASSIC_EMPTY_AGENT_COLOUR, "💤", "#475569", "AG", {
              showStrip: false,
              showBadge: false,
              muted,
            }),
          },
          { binding: undefined },
        );
      return;
    }
    const now = Date.now();
    const animationElapsedMs = now - session.animationStartedAt;
    const stateAnimationElapsedMs = this.runningAnimationElapsedMs(
      session,
      agent,
      now,
    );
    if (actionContext.isKey() || actionContext.isDial())
      await this.outputWriter.write(
        actionContext,
        {
          title: "",
          image: agentIcon(
            agent,
            session.agentStaticVisuals.get(agent.id) ??
              buildAgentStaticVisuals(agent, ""),
            {
              elapsedMs: animationElapsedMs,
              stateElapsedMs: stateAnimationElapsedMs,
            },
            look,
            muted,
            this.pressedAgentActions.has(actionContext.id),
            stateTransition,
          ),
        },
        { binding: agent.id },
      );
  }

  async beginAgentPress(
    actionContext: Action<ActionSettings>,
    agentId: string,
  ): Promise<void> {
    this.frozenAgentIds.set(actionContext.id, agentId);
    this.pressedAgentActions.add(actionContext.id);
    await this.renderAgent(
      actionContext,
      this.actionSettings.get(actionContext.id) ?? {},
    );
  }

  async endAgentPress(actionContext: Action<ActionSettings>): Promise<void> {
    this.frozenAgentIds.delete(actionContext.id);
    this.pressedAgentActions.delete(actionContext.id);
    if (!this.actionSettings.has(actionContext.id)) return;
    await this.renderAgent(
      actionContext,
      this.actionSettings.get(actionContext.id) ?? {},
    );
  }

  async renderAgentSummary(
    actionContext: Action<ActionSettings>,
    settings: ActionSettings,
  ): Promise<void> {
    const session = await this.ensure(actionContext);
    const providerId = String(settings.summaryProviderId ?? "").trim();
    const summary =
      session.agentSummaries.get(providerId) ?? emptyAgentSummary();
    const { attention, failed, reviewing, running, total, waiting } = summary;
    const colour = failed
      ? CLASSIC_AGENT_STATE_COLOUR.failed
      : waiting
        ? CLASSIC_AGENT_STATE_COLOUR.waiting_for_input
        : running
          ? CLASSIC_AGENT_STATE_COLOUR.running
          : reviewing
            ? CLASSIC_AGENT_STATE_COLOUR.ready_for_review
            : CLASSIC_AGENT_STATE_COLOUR.idle;
    const style = providerId
      ? providerStyle(providerId)
      : { accent: "#38bdf8", label: "All agents", mark: "Σ" };
    await this.render(
      actionContext,
      `${style.label} · ${total}\n${running} running · ${attention} alert`,
      colour,
      attention ? String(Math.min(attention, 9)) : String(total),
      style.accent,
      style.mark,
    );
  }

  async renderAttention(actionContext: Action<ActionSettings>): Promise<void> {
    const session = await this.ensure(actionContext);
    const attention =
      session.attention[
        session.attentionIndex % Math.max(session.attention.length, 1)
      ];
    if (!attention) {
      await this.render(
        actionContext,
        "No attention",
        CLASSIC_AGENT_STATE_COLOUR.ready_for_review,
        "✓",
      );
      return;
    }
    await this.render(
      actionContext,
      `${session.attention.length} attention\n${title(attention.summary, 22)}`,
      attention.severity === "critical" ? "#dc2626" : "#f59e0b",
      "!",
    );
  }

  async renderProvider(actionContext: Action<ActionSettings>): Promise<void> {
    const session = await this.ensure(actionContext);
    const unhealthy = session.unhealthyProviderCount;
    await this.render(
      actionContext,
      unhealthy
        ? `${unhealthy} provider issue`
        : `${session.providers.length} providers\nhealthy`,
      unhealthy ? "#dc2626" : CLASSIC_AGENT_STATE_COLOUR.ready_for_review,
      "P",
    );
  }

  async renderSystem(actionContext: Action<ActionSettings>): Promise<void> {
    const session = await this.ensure(actionContext);
    const image = systemIcon(session, Date.now() - session.animationStartedAt);
    if (actionContext.isKey() || actionContext.isDial())
      await this.outputWriter.write(actionContext, { title: "", image });
  }

  async changePage(
    actionContext: Action<ActionSettings>,
    delta: number,
  ): Promise<void> {
    const session = await this.ensure(actionContext);
    const pageSize =
      actionContext.device.size.columns * actionContext.device.size.rows || 1;
    const pageCount = Math.max(1, Math.ceil(session.agents.length / pageSize));
    session.page = (session.page + delta + pageCount) % pageCount;
    await this.renderVisible(actionContext.device.id);
  }

  renderedAgentId(actionContext: Action<ActionSettings>): string | undefined {
    return this.outputWriter.committedBinding(actionContext.id);
  }

  async focusAgentById(
    actionContext: Action<ActionSettings>,
    agentId: string,
  ): Promise<void> {
    const session = await this.ensure(actionContext);
    const requestVersion =
      (this.focusRequestVersions.get(actionContext.id) ?? 0) + 1;
    this.focusRequestVersions.set(actionContext.id, requestVersion);
    let result: Awaited<ReturnType<AgentDeckClient["focusAgent"]>>;
    try {
      result = await session.client.focusAgent(agentId);
    } catch (error) {
      if (
        this.focusRequestVersions.get(actionContext.id) !== requestVersion ||
        !this.actionSettings.has(actionContext.id)
      )
        return;
      streamDeck.logger.warn(
        `Agent Deck focus failed for ${agentId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await actionContext.showAlert();
      return;
    }
    if (
      this.focusRequestVersions.get(actionContext.id) !== requestVersion ||
      !this.actionSettings.has(actionContext.id)
    )
      return;
    if (focusResultNeedsAlert(result)) {
      streamDeck.logger.warn(
        `Agent Deck focus failed for ${agentId} (${result.requestId}): ${
          result.message ?? result.status
        }`,
      );
      await actionContext.showAlert();
    }
  }

  async deleteAgentById(
    actionContext: Action<ActionSettings>,
    agentId: string,
  ): Promise<AgentDeletionResult> {
    const session = await this.ensure(actionContext);
    const agent = session.agentById.get(agentId);
    if (!agent) return "missing";
    if (agent.state === "running") {
      streamDeck.logger.warn(
        `Agent Deck remove blocked: agent ${agent.id} is still running`,
      );
      return "blocked";
    }
    if (this.removalTransitions.has(actionContext.id)) return "ignored";
    this.removalTransitions.set(actionContext.id, {
      agentId: agent.id,
      seed: agent.id,
      startedAt: Date.now(),
    });
    await this.renderVisible(session.deviceId);
    await new Promise<void>((resolvePromise) => {
      const timer = setTimeout(resolvePromise, REMOVED_AGENT_ANIMATION_MS);
      timer.unref();
    });

    let deleted: boolean;
    try {
      deleted = await session.client.deleteAgent(agent.id);
    } catch (error) {
      this.removalTransitions.delete(actionContext.id);
      await this.renderVisible(session.deviceId);
      throw error;
    }
    this.removalTransitions.delete(actionContext.id);
    if (!deleted) {
      streamDeck.logger.warn(`Agent Deck remove failed: agent was not found`);
      await this.renderVisible(session.deviceId);
      await actionContext.showAlert();
      return "missing";
    }
    session.allAgents = session.allAgents.filter(
      (candidate) => candidate.id !== agent.id,
    );
    session.agents = session.agents.filter(
      (candidate) => candidate.id !== agent.id,
    );
    session.attention = session.attention.filter(
      (item) => item.agentId !== agent.id,
    );
    rebuildAgentRenderCache(session);
    const pageSize =
      actionContext.device.size.columns * actionContext.device.size.rows || 1;
    const lastPage = Math.max(
      0,
      Math.ceil(session.agents.length / pageSize) - 1,
    );
    session.page = Math.min(session.page, lastPage);
    await this.renderVisible(session.deviceId);
    return "removed";
  }

  async changeAttention(
    actionContext: Action<ActionSettings>,
    delta: number,
  ): Promise<void> {
    const session = await this.ensure(actionContext);
    session.attentionIndex = Math.max(0, session.attentionIndex + delta);
    await this.renderVisible(actionContext.device.id);
  }

  async refreshFor(actionContext: Action<ActionSettings>): Promise<void> {
    const session = await this.ensure(actionContext);
    await this.refresh(session);
  }

  async setShowSubagents(
    actionContext: Action<ActionSettings>,
    showSubagents: boolean | undefined,
  ): Promise<void> {
    if (showSubagents === undefined) return;
    const session = await this.ensure(actionContext);
    if (session.configuration.showSubagents === showSubagents) return;
    session.configuration.showSubagents = showSubagents;
    await this.refresh(session, ["agents", "attention"]);
  }

  async clearAndRefreshFor(
    actionContext: Action<ActionSettings>,
  ): Promise<void> {
    const session = await this.ensure(actionContext);
    if (session.refreshTimer) {
      clearTimeout(session.refreshTimer);
      session.refreshTimer = undefined;
    }
    session.clearingAgents = true;
    session.allAgents = [];
    session.agents = [];
    session.attention = [];
    rebuildAgentRenderCache(session);
    session.page = 0;
    session.attentionIndex = 0;
    try {
      await this.renderVisible(session.deviceId);
      await session.client.clearAgents();
    } catch (error) {
      session.clearingAgents = false;
      await this.refresh(session);
      throw error;
    }
    session.clearingAgents = false;
    await this.refresh(session);
  }

  private onEvent(session: DeviceSession, event: CanonicalEvent): void {
    const resources = refreshResourcesForEvent(event.type);
    if (!resources.size) return;
    addRefreshResources(session.refreshResources, resources);
    if (session.refreshTimer) return;
    session.refreshTimer = setTimeout(() => {
      session.refreshTimer = undefined;
      void this.refresh(session, []);
    }, 150);
  }

  private async refresh(
    session: DeviceSession,
    resources: Iterable<RefreshResource> = allRefreshResources(),
  ): Promise<void> {
    addRefreshResources(session.refreshResources, resources);
    if (session.refreshPromise) return session.refreshPromise;
    const refreshLoop = async (): Promise<void> => {
      while (session.refreshResources.size) {
        const pendingResources = new Set(session.refreshResources);
        session.refreshResources.clear();
        await this.refreshOnce(session, pendingResources);
      }
    };
    session.refreshPromise = refreshLoop().finally(() => {
      session.refreshPromise = undefined;
    });
    return session.refreshPromise;
  }

  private async refreshOnce(
    session: DeviceSession,
    resources: ReadonlySet<RefreshResource>,
  ): Promise<void> {
    const [agents, attention, providers, workspaces, health] =
      await Promise.all([
        resources.has("agents")
          ? settle(session.client.listAgents({ limit: 200 }))
          : Promise.resolve(undefined),
        resources.has("attention")
          ? settle(session.client.listAttention())
          : Promise.resolve(undefined),
        resources.has("providers")
          ? settle(session.client.listProviders())
          : Promise.resolve(undefined),
        resources.has("workspaces")
          ? settle(session.client.listWorkspaces())
          : Promise.resolve(undefined),
        resources.has("health")
          ? settle(session.client.health())
          : Promise.resolve(undefined),
      ] as const);
    if (session.connectionStatus === "disconnected") {
      await this.renderVisible(session.deviceId);
      return;
    }
    if (workspaces?.status === "fulfilled")
      session.workspaces = workspaces.value.items;
    if (
      agents?.status === "fulfilled" &&
      !session.clearingAgents &&
      agents.value.asOfSequence >= session.lastSnapshotSequence
    ) {
      session.lastSnapshotSequence = agents.value.asOfSequence;
      const freshAgents = streamDeckAgents(
        agents.value.items,
        session.configuration.showSubagents,
      );
      const observedAt = Date.now();
      const freshAgentIds = new Set(freshAgents.map(({ id }) => id));
      for (const agent of freshAgents) {
        if (agent.state !== "running") {
          session.runningAnimationStarts.delete(agent.id);
          continue;
        }
        const current = session.runningAnimationStarts.get(agent.id);
        if (!runningAnimationNeedsReset(current, agent.activeRunId)) continue;
        const lastActivityAt = Date.parse(agent.lastActivityAt);
        session.runningAnimationStarts.set(agent.id, {
          activeRunId: agent.activeRunId,
          startedAt:
            Number.isFinite(lastActivityAt) && lastActivityAt <= observedAt
              ? lastActivityAt
              : observedAt,
        });
      }
      for (const agentId of session.runningAnimationStarts.keys())
        if (!freshAgentIds.has(agentId))
          session.runningAnimationStarts.delete(agentId);
      session.allAgents = freshAgents;
      const visibleAgents = freshAgents
        .filter(
          (agent) =>
            (!session.configuration.providers.length ||
              session.configuration.providers.includes(agent.providerId)) &&
            session.configuration.states.includes(agent.state),
        )
        .sort(
          (left, right) =>
            Number(right.requiresAttention) - Number(left.requiresAttention) ||
            right.lastActivityAt.localeCompare(left.lastActivityAt) ||
            left.id.localeCompare(right.id),
        );
      session.agents = orderAgentStack(
        session.agents,
        visibleAgents,
        session.workspaces,
      );
    }
    if (attention?.status === "fulfilled" && !session.clearingAgents) {
      const visibleAgentIds = new Set(session.allAgents.map(({ id }) => id));
      session.attention = attention.value.items.filter(
        (item) => !item.agentId || visibleAgentIds.has(item.agentId),
      );
    }
    if (providers?.status === "fulfilled")
      session.providers = providers.value.items;
    if (health?.status === "fulfilled") session.health = health.value;
    if (workspaces?.status === "fulfilled" && agents?.status !== "fulfilled")
      session.agents = orderAgentStack(
        session.agents,
        session.agents,
        session.workspaces,
      );
    if (agents?.status === "fulfilled" || workspaces?.status === "fulfilled")
      rebuildAgentRenderCache(session);
    if (providers?.status === "fulfilled") rebuildProviderRenderCache(session);
    for (const [resource, result] of [
      ["agents", agents],
      ["attention", attention],
      ["providers", providers],
      ["workspaces", workspaces],
      ["health", health],
    ] as const) {
      if (!result || result.status === "fulfilled") continue;
      streamDeck.logger.error(
        `Agent Deck ${resource} refresh failed: ${
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason)
        }`,
      );
    }
    const refreshedResources = new Set<RefreshResource>();
    for (const [resource, result] of [
      ["agents", agents],
      ["attention", attention],
      ["providers", providers],
      ["workspaces", workspaces],
      ["health", health],
    ] as const)
      if (result?.status === "fulfilled") refreshedResources.add(resource);
    await this.renderVisible(
      session.deviceId,
      actionManifestIdsForResources(refreshedResources),
    );
  }

  private animatedTargets(): AnimatedTarget[] {
    const targets: AnimatedTarget[] = [];
    for (const session of this.sessions.values()) {
      const device = streamDeck.devices.getDeviceById(session.deviceId);
      if (!device) continue;
      for (const actionContext of device.actions) {
        if (
          actionContext.manifestId === "com.agentdeck.monitor.agent-slot" &&
          this.agentSlotIsAnimated(session, actionContext)
        )
          targets.push({ actionContext, session, kind: "agent" });
        else if (
          actionContext.manifestId === "com.agentdeck.monitor.system-health" &&
          session.providerBubblesOverflow
        )
          targets.push({ actionContext, session, kind: "system" });
      }
    }
    return targets;
  }

  private agentSlotIsAnimated(
    session: DeviceSession,
    actionContext: Action<ActionSettings>,
  ): boolean {
    if (session.connectionStatus !== "connected") return false;
    if (this.removalTransitions.has(actionContext.id)) return true;
    const look = this.renderedAgentLooks.get(actionContext.id) ?? "classic";
    if (look === "classic" && this.agentStateTransitions.has(actionContext.id))
      return true;
    if (look === "agent") return true;
    const agentId = this.desiredAgentIds.get(actionContext.id);
    const agent = agentId ? session.agentById.get(agentId) : undefined;
    return Boolean(
      agent &&
      (agent.state === "running" ||
        agent.state === "failed" ||
        agent.state === "waiting_for_input" ||
        agentLabelOverflows(agent.title)),
    );
  }

  private async renderAnimatedTarget({
    actionContext,
    session,
    kind,
  }: AnimatedTarget): Promise<void> {
    const now = Date.now();
    const animationElapsedMs = now - session.animationStartedAt;
    if (kind === "system") {
      await this.outputWriter.write(actionContext, {
        image: systemIcon(session, animationElapsedMs),
      });
      return;
    }
    const removal = this.removalTransitions.get(actionContext.id);
    if (removal) {
      await this.outputWriter.write(
        actionContext,
        {
          image: removedAgentIcon(removal.seed, now - removal.startedAt),
        },
        { binding: undefined },
      );
      return;
    }
    const agentId = this.desiredAgentIds.get(actionContext.id);
    const agent = agentId ? session.agentById.get(agentId) : undefined;
    const look = this.renderedAgentLooks.get(actionContext.id) ?? "classic";
    if (!agent) {
      if (look !== "agent") return;
      await this.outputWriter.write(
        actionContext,
        {
          image: emptyAgentIcon(
            this.renderedAgentLabels.get(actionContext.id) ?? "Agent",
            actionContext.id,
            animationElapsedMs,
          ),
        },
        { binding: undefined },
      );
      return;
    }
    const stateTransition =
      look === "classic"
        ? this.agentStateTransitions.frame(
            actionContext.id,
            { agentId: agent.id, state: agent.state },
            now,
          )
        : undefined;
    await this.outputWriter.write(
      actionContext,
      {
        image: agentIcon(
          agent,
          session.agentStaticVisuals.get(agent.id) ??
            buildAgentStaticVisuals(agent, ""),
          {
            elapsedMs: animationElapsedMs,
            stateElapsedMs: this.runningAnimationElapsedMs(session, agent, now),
          },
          look,
          false,
          this.pressedAgentActions.has(actionContext.id),
          stateTransition,
        ),
      },
      { binding: agent.id },
    );
  }

  private async renderVisible(
    deviceId: string,
    manifestIds?: ReadonlySet<string>,
  ): Promise<void> {
    const device = streamDeck.devices.getDeviceById(deviceId);
    if (!device) return;
    await Promise.all(
      [...device.actions]
        .filter(
          (visible) => !manifestIds || manifestIds.has(visible.manifestId),
        )
        .map(async (visible) => {
          const settings = this.actionSettings.get(visible.id) ?? {};
          if (visible.manifestId === "com.agentdeck.monitor.agent-slot")
            await this.renderAgent(visible, settings);
          else if (visible.manifestId === "com.agentdeck.monitor.agent-summary")
            await this.renderAgentSummary(visible, settings);
          else if (visible.manifestId === "com.agentdeck.monitor.attention")
            await this.renderAttention(visible);
          else if (
            visible.manifestId === "com.agentdeck.monitor.provider-health"
          )
            await this.renderProvider(visible);
          else if (visible.manifestId === "com.agentdeck.monitor.system-health")
            await this.renderSystem(visible);
        }),
    );
  }

  private async render(
    actionContext: Action<ActionSettings>,
    text: string,
    colour: string,
    symbol: string,
    accent?: string,
    badge?: string,
    options: IconOptions = {},
  ): Promise<void> {
    if (actionContext.isKey() || actionContext.isDial())
      await this.outputWriter.write(actionContext, {
        title: text,
        image: icon(colour, symbol, accent, badge, options),
      });
  }
}

const devices = new DeviceManager();

@action({ UUID: "com.agentdeck.monitor.agent-slot" })
class AgentSlotAction extends SingletonAction<ActionSettings> {
  private readonly presses = new PressGestureController<
    string,
    AgentDeletionResult | "failed"
  >(LONG_PRESS_DURATION_MS);

  override async onWillAppear(
    ev: WillAppearEvent<ActionSettings>,
  ): Promise<void> {
    this.presses.cancel(ev.action.id);
    devices.rememberAction(ev.action, ev.payload.settings);
    await devices.renderAgent(ev.action, ev.payload.settings);
  }
  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<ActionSettings>,
  ): Promise<void> {
    devices.rememberAction(ev.action, ev.payload.settings);
    await devices.setShowSubagents(
      ev.action,
      ev.payload.settings.showSubagents,
    );
    await devices.renderAgent(ev.action, ev.payload.settings);
  }
  override onWillDisappear(ev: WillDisappearEvent<ActionSettings>): void {
    this.presses.cancel(ev.action.id);
    devices.forgetAction(ev.action.id);
  }
  override onKeyDown(ev: KeyDownEvent<ActionSettings>): void {
    const agentId = devices.renderedAgentId(ev.action);
    const started = this.presses.keyDown(
      ev.action.id,
      agentId,
      (pressedAgentId) =>
        devices
          .deleteAgentById(ev.action, pressedAgentId)
          .catch((error: unknown) => {
            streamDeck.logger.error(
              `Agent Deck remove failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return "failed" as const;
          }),
      () => {
        void devices.endAgentPress(ev.action).catch((error: unknown) => {
          streamDeck.logger.error(
            `Agent Deck press watchdog reset failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      },
    );
    if (started !== "started" || !agentId) return;
    void devices.beginAgentPress(ev.action, agentId).catch((error: unknown) => {
      streamDeck.logger.error(
        `Agent Deck press feedback failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }
  override onKeyUp(ev: KeyUpEvent<ActionSettings>): void {
    const result = this.presses.keyUp(ev.action.id);
    if (result.kind === "none") return;
    void devices.endAgentPress(ev.action).catch((error: unknown) => {
      streamDeck.logger.error(
        `Agent Deck press feedback reset failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
    if (result.kind === "short") {
      void settleFocusTask(
        devices.focusAgentById(ev.action, result.target),
        async (error) => {
          streamDeck.logger.error(
            `Agent Deck focus failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          if (devices.actionIsVisible(ev.action.id))
            await ev.action.showAlert();
        },
      );
      return;
    }
    void result.completion.then((outcome) => {
      if (
        (outcome === "blocked" || outcome === "failed") &&
        devices.actionIsVisible(ev.action.id)
      )
        return ev.action.showAlert();
    });
  }
  override async onDialRotate(
    ev: DialRotateEvent<ActionSettings>,
  ): Promise<void> {
    await devices.changePage(ev.action, Math.sign(ev.payload.ticks));
  }
}

@action({ UUID: "com.agentdeck.monitor.agent-summary" })
class AgentSummaryAction extends SingletonAction<ActionSettings> {
  override async onWillAppear(
    ev: WillAppearEvent<ActionSettings>,
  ): Promise<void> {
    devices.rememberAction(ev.action, ev.payload.settings);
    await devices.renderAgentSummary(ev.action, ev.payload.settings);
  }
  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<ActionSettings>,
  ): Promise<void> {
    devices.rememberAction(ev.action, ev.payload.settings);
    await devices.setShowSubagents(
      ev.action,
      ev.payload.settings.showSubagents,
    );
    await devices.renderAgentSummary(ev.action, ev.payload.settings);
  }
  override onWillDisappear(ev: WillDisappearEvent<ActionSettings>): void {
    devices.forgetAction(ev.action.id);
  }
  override async onKeyDown(ev: KeyDownEvent<ActionSettings>): Promise<void> {
    await devices.refreshFor(ev.action);
  }
}

@action({ UUID: "com.agentdeck.monitor.attention" })
class AttentionAction extends SingletonAction<ActionSettings> {
  override async onWillAppear(
    ev: WillAppearEvent<ActionSettings>,
  ): Promise<void> {
    devices.rememberAction(ev.action, ev.payload.settings);
    await devices.renderAttention(ev.action);
  }
  override onWillDisappear(ev: WillDisappearEvent<ActionSettings>): void {
    devices.forgetAction(ev.action.id);
  }
  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<ActionSettings>,
  ): Promise<void> {
    devices.rememberAction(ev.action, ev.payload.settings);
    await devices.setShowSubagents(
      ev.action,
      ev.payload.settings.showSubagents,
    );
    await devices.renderAttention(ev.action);
  }
  override async onKeyDown(ev: KeyDownEvent<ActionSettings>): Promise<void> {
    await devices.changeAttention(ev.action, 1);
  }
  override async onDialRotate(
    ev: DialRotateEvent<ActionSettings>,
  ): Promise<void> {
    await devices.changeAttention(ev.action, Math.sign(ev.payload.ticks));
  }
}

@action({ UUID: "com.agentdeck.monitor.provider-health" })
class ProviderHealthAction extends SingletonAction<ActionSettings> {
  override async onWillAppear(
    ev: WillAppearEvent<ActionSettings>,
  ): Promise<void> {
    devices.rememberAction(ev.action, ev.payload.settings);
    await devices.renderProvider(ev.action);
  }
  override onWillDisappear(ev: WillDisappearEvent<ActionSettings>): void {
    devices.forgetAction(ev.action.id);
  }
  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<ActionSettings>,
  ): Promise<void> {
    devices.rememberAction(ev.action, ev.payload.settings);
    await devices.setShowSubagents(
      ev.action,
      ev.payload.settings.showSubagents,
    );
    await devices.renderProvider(ev.action);
  }
  override async onKeyDown(ev: KeyDownEvent<ActionSettings>): Promise<void> {
    await devices.refreshFor(ev.action);
  }
}

@action({ UUID: "com.agentdeck.monitor.system-health" })
class SystemHealthAction extends SingletonAction<ActionSettings> {
  private readonly presses = new PressGestureController<true, void>(
    LONG_PRESS_DURATION_MS,
  );

  override async onWillAppear(
    ev: WillAppearEvent<ActionSettings>,
  ): Promise<void> {
    this.presses.cancel(ev.action.id);
    devices.rememberAction(ev.action, ev.payload.settings);
    await devices.renderSystem(ev.action);
  }
  override onWillDisappear(ev: WillDisappearEvent<ActionSettings>): void {
    this.presses.cancel(ev.action.id);
    devices.forgetAction(ev.action.id);
  }
  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<ActionSettings>,
  ): Promise<void> {
    devices.rememberAction(ev.action, ev.payload.settings);
    await devices.setShowSubagents(
      ev.action,
      ev.payload.settings.showSubagents,
    );
    await devices.renderSystem(ev.action);
  }
  override onKeyDown(ev: KeyDownEvent<ActionSettings>): void {
    this.presses.keyDown(ev.action.id, true, async () => {
      await devices.clearAndRefreshFor(ev.action).catch((error: unknown) => {
        streamDeck.logger.error(
          `Agent Deck clear and refresh failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        if (devices.actionIsVisible(ev.action.id)) void ev.action.showAlert();
      });
    });
  }
  override onKeyUp(ev: KeyUpEvent<ActionSettings>): void {
    this.presses.keyUp(ev.action.id);
  }
}

streamDeck.actions.registerAction(new AgentSlotAction());
streamDeck.actions.registerAction(new AgentSummaryAction());
streamDeck.actions.registerAction(new AttentionAction());
streamDeck.actions.registerAction(new ProviderHealthAction());
streamDeck.actions.registerAction(new SystemHealthAction());
await streamDeck.connect();
