import streamDeck, {
  action,
  type Action,
  type DialAction,
  type DialRotateEvent,
  type DidReceiveSettingsEvent,
  type KeyAction,
  type KeyDownEvent,
  type KeyUpEvent,
  type SendToPluginEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import {
  AgentDeckClient,
  workspaceColour,
  type WatchHandle,
} from "@agent-deck/client-sdk";
import {
  workspaceResourcesForRoots,
  type Agent,
  type Attention,
  type CanonicalEvent,
  type Provider,
  type ProviderUsage,
  type Workspace,
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
  DARK_KEY_VISUAL_PALETTE,
  keyVisualPalette,
  normalizeKeyVisualThemePreference,
  type KeyVisualPalette,
  type KeyVisualThemePreference,
  type ResolvedKeyVisualTheme,
} from "./agent-palette.js";
import {
  AnimationFrameScheduler,
  runningAnimationNeedsReset,
  type RunningAnimationStart,
} from "./animation-scheduler.js";
import {
  bringUpImage,
  bringUpSequenceDurationMs,
} from "./bring-up-animation.js";
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
  resolveSystemAppearance,
  systemAppearanceChanged,
} from "./system-appearance.js";
import {
  addRefreshResources,
  actionManifestIdsForResources,
  allRefreshResources,
  refreshResourcesForEvent,
  type RefreshResource,
} from "./refresh-plan.js";
import {
  ACTION_IDS,
  type AgentSlotSettings,
  type AgentSummarySettings,
  type AnyActionSettings,
  type EmptyActionSettings,
  type NewAgentSettings,
  type ProviderUsageSettings,
} from "./action-settings.js";
import {
  providerUsageImage,
  providerUsageResetImage,
} from "./provider-usage.js";

type ActionSettings = AnyActionSettings;

interface DeviceConfiguration {
  serverUrl: string;
  name: string;
  role: string;
  providers: string[];
  states: Agent["state"][];
  showSubagents: boolean;
  keyVisualTheme: KeyVisualThemePreference;
}

interface DeviceSession {
  deviceId: string;
  client: AgentDeckClient;
  configuration: DeviceConfiguration;
  resolvedKeyVisualTheme: ResolvedKeyVisualTheme;
  connectionStatus: "connecting" | "connected" | "disconnected";
  allAgents: Agent[];
  agentById: Map<string, Agent>;
  agents: Agent[];
  workspaceBadgeByAgentId: Map<string, string>;
  agentStaticVisuals: Map<string, AgentStaticVisuals>;
  agentSummaries: Map<string, AgentSummary>;
  attention: Attention[];
  providers: Provider[];
  providerUsage: Map<string, ProviderUsage>;
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
  bringUpStartedAt: number | undefined;
  hasCompletedBringUp: boolean;
  bringUpHeldActionIds: Set<string>;
  bringUpImages: Map<string, BringUpSnapshot>;
  bringUpTimer: NodeJS.Timeout | undefined;
  creationContext?: Awaited<
    ReturnType<AgentDeckClient["getAgentCreationContext"]>
  >;
  creationContextCheckedAt: number;
  creationContextPromise: Promise<void> | undefined;
  creationContextTimer?: NodeJS.Timeout;
  usageTimer?: NodeJS.Timeout;
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
  "recovering",
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
  keyVisualTheme: "dark",
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
const SYSTEM_APPEARANCE_POLL_MS = 5_000;
const USAGE_RESET_VIEW_MS = 3_000;
const USAGE_PROVIDER_IDS = ["codex", "cursor-local", "claude-code"] as const;
type UsageProviderId = (typeof USAGE_PROVIDER_IDS)[number];

const normalizeUsageProviderId = (value: unknown): UsageProviderId =>
  value === "cursor-local" || value === "claude-code" ? value : "codex";

const sessionPalette = (session: DeviceSession): KeyVisualPalette =>
  keyVisualPalette(session.resolvedKeyVisualTheme);

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

const muteSvgContent = (
  content: string,
  muted: boolean,
  palette: KeyVisualPalette,
): string =>
  muted
    ? `<defs>
        <filter id="agent-slot-muted">
          <feColorMatrix type="saturate" values="0"/>
        </filter>
      </defs>
      <g filter="url(#agent-slot-muted)" opacity=".55">${content}</g>
      <rect width="144" height="144" fill="${palette.mutedOverlay}" opacity="${palette.mutedOverlayOpacity}"/>`
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
  summary.running += Number(
    agent.state === "running" || agent.state === "recovering",
  );
  summary.attention += Number(agent.requiresAttention);
  summary.failed ||= agent.state === "failed";
  summary.waiting ||=
    agent.state === "waiting_for_input" ||
    agent.state === "waiting_for_approval";
  summary.reviewing ||= agent.state === "ready_for_review";
};

const rebuildAgentRenderCache = (session: DeviceSession): void => {
  const palette = sessionPalette(session);
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
            palette,
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
        palette,
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
  palette: KeyVisualPalette = DARK_KEY_VISUAL_PALETTE,
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
    <text x="114" y="37" text-anchor="middle" font-family="system-ui" font-size="15" font-weight="800" fill="${palette.inverseForeground}">${badge ?? ""}</text>`
        : ""
    }
    ${
      options.glyph ??
      `<text x="72" y="${showBadge ? 98 : 93}" text-anchor="middle" font-family="system-ui" font-size="58" font-weight="700" fill="${palette.foreground}">${symbol}</text>`
    }`,
      options.muted ?? false,
      palette,
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

const systemStatusGlyph = (
  state: SystemDisplayState,
  palette: KeyVisualPalette,
): string => {
  return `<g transform="translate(36 36) scale(3)" fill="none" stroke="${palette.foreground}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
    ${SYSTEM_STATUS_PATHS[state]}
  </g>`;
};

const systemDisplay = (
  session: DeviceSession,
): { colour: string; state: SystemDisplayState } => {
  const palette = sessionPalette(session);
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
    return {
      colour: palette.stateSurface.waiting_for_input,
      state: "connecting",
    };
  if (session.connectionStatus === "disconnected" || status === "disconnected")
    return { colour: palette.stateSurface.failed, state: "disconnected" };
  if (session.connectionStatus === "connected" && status === "healthy")
    return {
      colour: palette.stateSurface.ready_for_review,
      state: "connected",
    };
  return { colour: palette.stateSurface.failed, state: "degraded" };
};

const systemIcon = (
  session: DeviceSession,
  animationElapsedMs: number,
): string => {
  const display = systemDisplay(session);
  const palette = sessionPalette(session);
  return icon(
    display.colour,
    "",
    palette.foreground,
    String(session.allAgents.length),
    {
      showStrip: false,
      glyph: `${systemStatusGlyph(display.state, palette)}
        ${connectorBubblesSvg(session.providerBubbles, animationElapsedMs, palette)}`,
    },
    palette,
  );
};

const title = (value: string, max = 18): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const renderProviderLogo = (
  providerId: string,
  palette: KeyVisualPalette,
): string => {
  const id = providerId.toLowerCase();
  if (id.includes("cursor"))
    return `<g transform="translate(0 93)">
      <rect x="98" y="5" width="41" height="41" rx="10" fill="${palette.providerTileSurface}"/>
      <path d="M118.5 10L133 18.5V35L118.5 43.5L104 35V18.5L118.5 10Z" fill="${palette.providerNeutral}"/>
      <path d="M106 19.5H131L118.5 27.5L106 19.5Z" fill="${palette.providerForeground}"/>
      <path d="M131 19.5L118.5 41V27.5L131 19.5Z" fill="${palette.providerNeutralLight}"/>
      <path d="M104 35V18.5L118.5 27.5L104 35Z" fill="${palette.providerNeutralDark}"/>
      <path d="M104 35L118.5 27.5V43.5L104 35Z" fill="${palette.providerNeutralMid}"/>
    </g>`;
  if (id.includes("codex") || id.includes("openai") || id.includes("chatgpt"))
    return `<g transform="translate(0 93)">
      <rect x="98" y="5" width="41" height="41" rx="10" fill="${palette.providerTileSurface}"/>
      <g transform="translate(104 11) scale(.18)">
        <path d="M60.87 57.26V42.31c0-1.26.47-2.2 1.57-2.83l30.05-17.3c4.09-2.36 8.97-3.46 14-3.46 18.88 0 30.83 14.63 30.83 30.2 0 1.1 0 2.36-.16 3.62l-31.14-18.25c-1.89-1.1-3.78-1.1-5.66 0L60.87 57.26Zm70.16 58.2V79.75c0-2.2-.94-3.78-2.83-4.88L88.71 51.91l12.9-7.39c1.1-.63 2.05-.63 3.15 0l30.04 17.3c8.65 5.03 14.47 15.73 14.47 26.11 0 11.95-7.08 22.97-18.24 27.53ZM51.59 84 38.7 76.45c-1.1-.63-1.58-1.58-1.58-2.84v-34.6c0-16.83 12.9-29.57 30.36-29.57 6.61 0 12.74 2.2 17.93 6.13L54.43 33.5c-1.89 1.1-2.83 2.67-2.83 4.88V84Zm27.77 16.04L60.87 89.66V67.64l18.49-10.38 18.48 10.38v22.02l-18.48 10.38Zm11.87 47.82c-6.61 0-12.74-2.2-17.93-6.13l30.99-17.94c1.89-1.1 2.83-2.67 2.83-4.88V73.3l13.05 7.55c1.1.63 1.58 1.57 1.58 2.83v34.61c0 16.83-13.06 29.57-30.52 29.57Zm-37.28-35.08L23.91 95.48c-8.65-5.03-14.47-15.73-14.47-26.11 0-12.11 7.24-22.97 18.4-27.53v35.87c0 2.2.94 3.77 2.83 4.87L70 105.39l-12.9 7.39c-1.1.63-2.05.63-3.15 0Zm-1.73 25.8c-17.77 0-30.83-13.37-30.83-29.89 0-1.26.16-2.52.32-3.77l30.98 17.93c1.89 1.1 3.78 1.1 5.67 0l39.48-22.81v14.95c0 1.26-.47 2.2-1.58 2.83l-30.04 17.3c-4.09 2.36-8.97 3.46-14 3.46Z" fill="${palette.providerForeground}"/>
      </g>
    </g>`;
  if (id.includes("claude"))
    return `<g transform="translate(0 93)">
      <rect x="98" y="5" width="41" height="41" rx="10" fill="${palette.providerTileSurface}"/>
      <g transform="translate(106 13)" fill="${palette.providerForeground}">
        <path d="M10.8 0h5.4l.9 7.1 5.8-4.2 2.7 4.7-6.6 3 6.6 3-2.7 4.7-5.8-4.2-.9 7.1h-5.4l-.9-7.1-5.8 4.2-2.7-4.7 6.6-3-6.6-3 2.7-4.7 5.8 4.2z"/>
      </g>
    </g>`;
  const mark = escapeXml(providerStyle(providerId).mark);
  return `<g transform="translate(0 93)">
      <circle cx="116" cy="24" r="17" fill="${palette.genericLogoSurface}" opacity=".72"/>
      <text x="116" y="29" text-anchor="middle" font-family="system-ui" font-size="12" font-weight="800" fill="${palette.providerForeground}">${mark}</text>
    </g>`;
};

const providerLogoCache = new Map<string, string>();

const providerLogo = (
  providerId: string,
  palette: KeyVisualPalette,
): string => {
  const cacheKey = `${palette.id}\0${providerId}`;
  const cached = providerLogoCache.get(cacheKey);
  if (cached) return cached;
  const logo = renderProviderLogo(providerId, palette);
  providerLogoCache.set(cacheKey, logo);
  if (providerLogoCache.size > 128) {
    const oldest = providerLogoCache.keys().next().value;
    if (oldest !== undefined) providerLogoCache.delete(oldest);
  }
  return logo;
};

const agentModeIcon = (
  style: AgentModeStyle,
  palette: KeyVisualPalette,
): string => {
  const iconColour =
    style.icon === "debug" ? palette.workspaceBadgeForeground : style.colour;
  const badgeSurface =
    style.icon === "debug" ? style.colour : palette.modeBadgeSurface;
  const common = `fill="none" stroke="${iconColour}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"`;
  let glyph: string;
  if (style.icon === "plan")
    glyph = `<path transform="translate(12.12 43.77) scale(.115 -.115)" fill="${iconColour}" d="M75 170Q63 170 52 176.5Q41 183 34.5 194Q28 205 28 218Q28 231 34.5 241.5Q41 252 52 258.5Q63 265 75.5 265Q88 265 99 258.5Q110 252 116.5 241.5Q123 231 123 218Q123 205 116.5 194Q110 183 99 176.5Q88 170 75 170ZM75 186Q84 186 91 190.5Q98 195 102.5 202Q107 209 107 217.5Q107 226 102.5 233Q98 240 91 244.5Q84 249 75.5 249Q67 249 60 244.5Q53 240 48.5 233Q44 226 44 217.5Q44 209 48.5 202Q53 195 60 190.5Q67 186 75 186ZM75 43Q63 43 52 49.5Q41 56 34.5 67Q28 78 28 90.5Q28 103 34.5 114Q41 125 52 131.5Q63 138 75.5 138Q88 138 99 131.5Q110 125 116.5 114.5Q123 104 123 91Q123 78 116.5 67Q110 56 99 49.5Q88 43 75 43ZM75 59Q84 59 91 63.5Q98 68 102.5 75Q107 82 107 90.5Q107 99 102.5 106Q98 113 91 117.5Q84 122 75.5 122Q67 122 60 117.5Q53 113 48.5 106Q44 99 44 90.5Q44 82 48.5 75Q53 68 60 63.5Q67 59 75 59ZM156 209Q152 209 149.5 211.5Q147 214 147 217.5Q147 221 149.5 223.5Q152 226 156 226H265Q269 226 271.5 223.5Q274 221 274 217.5Q274 214 271.5 211.5Q269 209 265 209ZM156 82Q152 82 149.5 84.5Q147 87 147 90.5Q147 94 149.5 96.5Q152 99 156 99H265Q269 99 271.5 96.5Q274 94 274 90.5Q274 87 271.5 84.5Q269 82 265 82Z"/>`;
  else if (style.icon === "debug")
    glyph = `<path transform="translate(10.14 42.1) scale(.115 -.115)" fill="${iconColour}" d="M162 288Q162 295 157.5 297Q153 299 148 295L105 265Q101 262 101 257.5Q101 253 105 250L148 220Q153 216 157.5 218Q162 220 162 227ZM136 0Q173 0 204 18.5Q235 37 253.5 68Q272 99 272 136Q272 173 253.5 204Q235 235 204 253.5Q173 272 136 272Q131 272 128 268.5Q125 265 125 260.5Q125 256 128 252.5Q131 249 136 249Q167 249 193 234Q219 219 234 193Q249 167 249 136Q249 105 234 79Q219 53 193 38Q167 23 136 23Q105 23 79 38Q53 53 38 79Q23 105 23 136Q23 164 35.5 188Q48 212 70 227Q74 231 75 235Q76 239 73.5 243.5Q71 248 66 248.5Q61 249 57 246Q30 227 15 198Q0 169 0 136Q0 99 18.5 68Q37 37 68 18.5Q99 0 136 0ZM121 73Q128 73 132 79L193 175Q196 180 196 183.5Q196 187 193 190Q190 193 185 193Q180 193 176 187L121 98L95 132Q91 138 85.5 138Q80 138 77 134.5Q74 131 74 127Q74 123 77 119L110 79Q115 73 121 73Z"/>`;
  else
    glyph = `<g transform="translate(.62 1.41)" ${common}>
      <path d="M14 15h24v17H25l-7 6v-6h-4z"/>
    </g>`;
  return `<g transform="translate(0 92)">
      <circle cx="26" cy="26" r="19" fill="${badgeSurface}" opacity=".72"/>
      ${glyph}
    </g>`;
};

const buildAgentStaticVisuals = (
  agent: Agent,
  workspaceBadge: string,
  palette: KeyVisualPalette,
): AgentStaticVisuals => {
  const modeStyle = agentModeStyle(agent);
  return {
    modeFrame: modeStyle ? agentModeFrameSvg(modeStyle) : "",
    modeIcon: modeStyle ? agentModeIcon(modeStyle, palette) : "",
    providerLogo: providerLogo(agent.providerId, palette),
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
  palette: KeyVisualPalette = DARK_KEY_VISUAL_PALETTE,
): string => {
  const scene =
    look === "agent"
      ? agentLookScene(agent.state, agent.id, animation.elapsedMs, palette)
      : `<rect width="144" height="144" fill="${palette.stateSurface[agent.state]}"/>
      ${agentStateIndicatorSvg(
        agent.state,
        animation.stateElapsedMs,
        stateTransition,
        palette,
      )}`;
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
      ${muteSvgContent(
        `${scene}
      ${isSubagent(agent) ? subagentBackgroundSvg(palette) : ""}
      ${agentLabelBackgroundSvg(palette)}
      ${agentLabelSvg(agent.title, animation.elapsedMs, palette)}
      ${agentProgressSvg(agent.progress, agent.state, palette)}
      ${staticVisuals.modeFrame}
      ${staticVisuals.providerLogo}
      ${staticVisuals.modeIcon}
      ${staticVisuals.workspaceBadge}
      `,
        muted,
        palette,
      )}
      ${pressed ? agentEdgeFrameSvg(palette.foreground) : ""}
    </svg>`,
  )}`;
};

const emptyAgentIcon = (
  label: string,
  seed: string,
  animationElapsedMs: number,
  muted = false,
  palette: KeyVisualPalette = DARK_KEY_VISUAL_PALETTE,
): string =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
      ${muteSvgContent(
        `${emptyAgentLookScene(seed, animationElapsedMs, palette)}
      ${agentLabelBackgroundSvg(palette)}
      ${agentLabelSvg(label, animationElapsedMs, palette)}
      `,
        muted,
        palette,
      )}
    </svg>`,
  )}`;

const newAgentIcon = (
  providerId: string,
  workspaceAccent: string,
  muted = false,
  palette: KeyVisualPalette = DARK_KEY_VISUAL_PALETTE,
): string => {
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
      ${muteSvgContent(
        `<rect width="144" height="144" fill="${palette.newAgentSurface}"/>
        <g transform="translate(50 45) scale(1.55) translate(-118.5 -118.5)">${providerLogo(providerId, palette)}</g>
        <circle cx="72" cy="51" r="20" fill="${palette.newAgentCharacter}" stroke="${palette.newAgentSurface}" stroke-width="3"/>
        <path d="M40 127c3-32 14-49 32-49s29 17 32 49z" fill="${palette.newAgentCharacter}" stroke="${palette.newAgentSurface}" stroke-width="3" stroke-linejoin="round"/>
        <circle cx="116" cy="27" r="18" fill="none" stroke="${workspaceAccent}" stroke-width="3"/>
        <path d="M112 15h9v8h8v9h-8v8h-9v-8h-8v-9h8z" fill="${workspaceAccent}"/>`,
        muted,
        palette,
      )}
    </svg>`,
  )}`;
};

const removedAgentIcon = (
  seed: string,
  elapsedMs: number,
  muted = false,
  palette: KeyVisualPalette = DARK_KEY_VISUAL_PALETTE,
): string =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
      ${muteSvgContent(
        removedAgentLookScene(seed, elapsedMs, palette),
        muted,
        palette,
      )}
    </svg>`,
  )}`;

interface AnimatedTarget {
  actionContext: DialAction<AnyActionSettings> | KeyAction<AnyActionSettings>;
  session: DeviceSession;
  kind: "agent" | "bring-up" | "system";
}

interface BringUpSnapshot {
  binding: string | undefined;
  delayMs?: number;
  image: string;
  index: number;
  previousImage: string | undefined;
  title: string | undefined;
  total: number;
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
  private readonly actionSettings = new Map<string, AnyActionSettings>();
  private readonly usageResetTimers = new Map<string, NodeJS.Timeout>();
  private readonly usageResetUntil = new Map<string, number>();
  private readonly desiredAgentIds = new Map<string, string>();
  private readonly frozenAgentIds = new Map<string, string>();
  private readonly renderedAgentLooks = new Map<string, AgentKeyLook>();
  private readonly renderedAgentLabels = new Map<string, string>();
  private readonly renderedAgentSlots = new Map<string, number>();
  private readonly agentStateTransitions = new AgentStateTransitionTracker();
  private readonly pressedAgentActions = new Set<string>();
  private readonly focusRequestVersions = new Map<string, number>();
  private readonly removalTransitions = new Map<
    string,
    AgentRemovalTransition
  >();
  private readonly outputWriter = new ActionOutputWriter<string>();
  private systemAppearanceTimer: NodeJS.Timeout | undefined;
  private systemAppearancePromise: Promise<void> | undefined;
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
    actionContext: Action<AnyActionSettings>,
    settings: AnyActionSettings,
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
    this.renderedAgentSlots.delete(actionId);
    this.cancelUsageReset(actionId);
    this.agentStateTransitions.clear(actionId);
    this.pressedAgentActions.delete(actionId);
    this.focusRequestVersions.set(
      actionId,
      (this.focusRequestVersions.get(actionId) ?? 0) + 1,
    );
    this.removalTransitions.delete(actionId);
    this.outputWriter.clear(actionId);
  }

  async ensure(
    actionContext: Action<AnyActionSettings>,
  ): Promise<DeviceSession> {
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
    actionContext: Action<AnyActionSettings>,
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
    configuration.keyVisualTheme = normalizeKeyVisualThemePreference(
      configuration.keyVisualTheme,
    );
    // State selection is not user-configurable. Include newly introduced
    // states when loading configuration documents saved by older versions.
    configuration.states = Array.from(
      new Set<Agent["state"]>([...configuration.states, ...ALL_AGENT_STATES]),
    );
    const resolvedKeyVisualTheme =
      configuration.keyVisualTheme === "system"
        ? await resolveSystemAppearance()
        : configuration.keyVisualTheme;
    const session: DeviceSession = {
      deviceId,
      client,
      configuration,
      resolvedKeyVisualTheme,
      connectionStatus: "connecting",
      allAgents: [],
      agentById: new Map(),
      agents: [],
      workspaceBadgeByAgentId: new Map(),
      agentStaticVisuals: new Map(),
      agentSummaries: new Map([["", emptyAgentSummary()]]),
      attention: [],
      providers: [],
      providerUsage: new Map(),
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
      bringUpStartedAt: undefined,
      hasCompletedBringUp: false,
      bringUpHeldActionIds: new Set(),
      bringUpImages: new Map(),
      bringUpTimer: undefined,
      creationContextCheckedAt: 0,
      creationContextPromise: undefined,
    };
    this.sessions.set(deviceId, session);
    this.syncSystemAppearanceMonitor();
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
          if (status !== previousStatus)
            this.cancelUsageResetsForDevice(session.deviceId);
          if (status === "disconnected") {
            this.cancelBringUp(session);
            session.allAgents = [];
            session.agents = [];
            session.attention = [];
            session.page = 0;
            session.attentionIndex = 0;
            rebuildAgentRenderCache(session);
            void this.renderVisible(session.deviceId);
          } else if (status === "connected" && previousStatus !== "connected")
            void this.refreshSystemAppearance().then(() =>
              this.refreshAndStartBringUp(session),
            );
          else void this.renderVisible(session.deviceId);
        },
      },
    );
    this.animationScheduler.start();
    session.creationContextTimer = setInterval(() => {
      const device = streamDeck.devices.getDeviceById(session.deviceId);
      if (
        !device ||
        ![...device.actions].some(
          (candidate) =>
            candidate.manifestId === "com.agentdeck.monitor.new-agent",
        )
      )
        return;
      void this.refreshCreationContext(session).then((changed) => {
        if (changed)
          return this.renderVisible(
            session.deviceId,
            new Set(["com.agentdeck.monitor.new-agent"]),
          );
      });
    }, 1_500);
    session.creationContextTimer.unref();
    session.usageTimer = setInterval(() => {
      const device = streamDeck.devices.getDeviceById(session.deviceId);
      if (
        !device ||
        ![...device.actions].some(
          (candidate) => candidate.manifestId === ACTION_IDS.providerUsage,
        )
      )
        return;
      void this.refreshUsage(session);
    }, 120_000);
    session.usageTimer.unref();
    return session;
  }

  private syncSystemAppearanceMonitor(): void {
    const needed = [...this.sessions.values()].some(
      ({ configuration }) => configuration.keyVisualTheme === "system",
    );
    if (!needed) {
      if (this.systemAppearanceTimer) clearInterval(this.systemAppearanceTimer);
      this.systemAppearanceTimer = undefined;
      return;
    }
    if (this.systemAppearanceTimer) return;
    this.systemAppearanceTimer = setInterval(() => {
      void this.refreshSystemAppearance();
    }, SYSTEM_APPEARANCE_POLL_MS);
    this.systemAppearanceTimer.unref();
  }

  async refreshSystemAppearance(): Promise<void> {
    if (this.systemAppearancePromise) return this.systemAppearancePromise;
    if (
      ![...this.sessions.values()].some(
        ({ configuration }) => configuration.keyVisualTheme === "system",
      )
    )
      return;
    this.systemAppearancePromise = resolveSystemAppearance()
      .then(async (appearance) => {
        const changedDeviceIds: string[] = [];
        for (const session of this.sessions.values()) {
          if (
            session.configuration.keyVisualTheme !== "system" ||
            !systemAppearanceChanged(session.resolvedKeyVisualTheme, appearance)
          )
            continue;
          session.resolvedKeyVisualTheme = appearance;
          rebuildAgentRenderCache(session);
          changedDeviceIds.push(session.deviceId);
        }
        await Promise.all(
          changedDeviceIds.map((deviceId) => this.renderVisible(deviceId)),
        );
      })
      .finally(() => {
        this.systemAppearancePromise = undefined;
      });
    return this.systemAppearancePromise;
  }

  private cancelBringUp(session: DeviceSession): void {
    if (session.bringUpTimer) clearTimeout(session.bringUpTimer);
    session.bringUpTimer = undefined;
    session.bringUpStartedAt = undefined;
    session.hasCompletedBringUp = false;
    session.bringUpImages.clear();
    this.releaseBringUpHeldActions(session);
  }

  private releaseBringUpHeldActions(session: DeviceSession): void {
    for (const actionId of session.bringUpHeldActionIds)
      this.outputWriter.discardStaged(actionId);
    session.bringUpHeldActionIds.clear();
  }

  private async refreshAndStartBringUp(session: DeviceSession): Promise<void> {
    const device = streamDeck.devices.getDeviceById(session.deviceId);
    if (!device) return;

    this.cancelBringUp(session);
    const agentKeys = [...device.actions]
      .flatMap((actionContext) => {
        const slot = this.renderedAgentSlots.get(actionContext.id);
        return actionContext.isKey() &&
          actionContext.manifestId === "com.agentdeck.monitor.agent-slot" &&
          typeof slot === "number"
          ? [{ actionContext, slot }]
          : [];
      })
      .sort((left, right) => left.slot - right.slot);
    const usageKeys = [...device.actions].filter(
      (actionContext) =>
        actionContext.isKey() &&
        actionContext.manifestId === ACTION_IDS.providerUsage,
    );
    const creationKeys = [...device.actions].filter(
      (actionContext) =>
        actionContext.isKey() &&
        actionContext.manifestId === ACTION_IDS.newAgent,
    );
    for (const actionContext of usageKeys) {
      const settings = (this.actionSettings.get(actionContext.id) ??
        {}) as ProviderUsageSettings;
      const providerId = normalizeUsageProviderId(
        settings.usageDefaultProviderId,
      );
      await this.writeUsage(actionContext, session, providerId);
    }
    await Promise.all(
      creationKeys.map((actionContext) =>
        this.renderCreation(
          actionContext,
          (this.actionSettings.get(actionContext.id) ?? {}) as NewAgentSettings,
          true,
        ),
      ),
    );
    const postAgentKeys = [...usageKeys, ...creationKeys];
    const animatedKeys = [
      ...agentKeys.map(({ actionContext }) => actionContext),
      ...postAgentKeys,
    ];
    const previousImages = new Map(
      animatedKeys.map((actionContext) => [
        actionContext.id,
        this.outputWriter.committedImage(actionContext.id),
      ]),
    );
    for (const actionContext of device.actions) {
      if (!actionContext.isKey()) continue;
      this.outputWriter.beginStaging(actionContext.id);
      session.bringUpHeldActionIds.add(actionContext.id);
    }

    try {
      await this.refresh(session);
      await Promise.all([
        ...usageKeys.map((actionContext) =>
          this.renderUsage(
            actionContext,
            (this.actionSettings.get(actionContext.id) ??
              {}) as ProviderUsageSettings,
            true,
          ),
        ),
        ...creationKeys.map((actionContext) =>
          this.renderCreation(
            actionContext,
            (this.actionSettings.get(actionContext.id) ??
              {}) as NewAgentSettings,
          ),
        ),
      ]);
    } catch (error) {
      this.releaseBringUpHeldActions(session);
      throw error;
    }
    if (session.connectionStatus !== "connected") {
      this.releaseBringUpHeldActions(session);
      await this.renderVisible(session.deviceId);
      return;
    }

    for (const [index, { actionContext }] of agentKeys.entries()) {
      const staged = this.outputWriter.takeStaged(actionContext.id);
      session.bringUpHeldActionIds.delete(actionContext.id);
      if (staged?.output.image)
        session.bringUpImages.set(actionContext.id, {
          binding: staged.commit?.binding,
          image: staged.output.image,
          index,
          previousImage: previousImages.get(actionContext.id),
          title: staged.output.title,
          total: agentKeys.length,
        });
    }
    const postAgentDelayMs =
      agentKeys.length > 0 ? bringUpSequenceDurationMs(agentKeys.length) : 0;
    for (const actionContext of postAgentKeys) {
      const staged = this.outputWriter.takeStaged(actionContext.id);
      session.bringUpHeldActionIds.delete(actionContext.id);
      if (staged?.output.image)
        session.bringUpImages.set(actionContext.id, {
          binding: staged.commit?.binding,
          delayMs: postAgentDelayMs,
          image: staged.output.image,
          index: 0,
          previousImage: previousImages.get(actionContext.id),
          title: staged.output.title,
          total: 1,
        });
    }
    if (session.bringUpImages.size === 0) {
      session.hasCompletedBringUp = true;
      this.releaseBringUpHeldActions(session);
      await this.renderVisible(session.deviceId);
      return;
    }

    session.bringUpStartedAt = Date.now();
    await Promise.all(
      animatedKeys.map((actionContext) =>
        this.renderAnimatedTarget({
          actionContext,
          session,
          kind: "bring-up",
        }),
      ),
    );
    session.bringUpTimer = setTimeout(
      () => {
        session.bringUpTimer = undefined;
        session.bringUpStartedAt = undefined;
        session.hasCompletedBringUp = true;
        session.bringUpImages.clear();
        this.releaseBringUpHeldActions(session);
        if (session.connectionStatus === "connected")
          void this.renderVisible(session.deviceId);
      },
      postAgentKeys.length > 0
        ? postAgentDelayMs + bringUpSequenceDurationMs(1)
        : bringUpSequenceDurationMs(agentKeys.length),
    );
    session.bringUpTimer.unref();
  }

  async renderAgent(
    actionContext: Action<ActionSettings>,
    settings: AgentSlotSettings,
  ): Promise<void> {
    const session = await this.ensure(actionContext);
    const palette = sessionPalette(session);
    const automaticSlot =
      actionContext.isKey() && actionContext.coordinates
        ? actionContext.coordinates.row * actionContext.device.size.columns +
          actionContext.coordinates.column
        : 0;
    const slot = Math.max(0, Number(settings.slot ?? automaticSlot));
    this.renderedAgentSlots.set(actionContext.id, slot);
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
        palette,
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
          palette,
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
            image: icon(
              palette.emptySurface,
              "💤",
              palette.stateAccent.unknown,
              "AG",
              {
                showStrip: false,
                showBadge: false,
                muted,
              },
              palette,
            ),
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
              buildAgentStaticVisuals(agent, "", palette),
            {
              elapsedMs: animationElapsedMs,
              stateElapsedMs: stateAnimationElapsedMs,
            },
            look,
            muted,
            this.pressedAgentActions.has(actionContext.id),
            stateTransition,
            palette,
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
    settings: AgentSummarySettings,
  ): Promise<void> {
    const session = await this.ensure(actionContext);
    const palette = sessionPalette(session);
    const providerId = String(settings.summaryProviderId ?? "").trim();
    const summary =
      session.agentSummaries.get(providerId) ?? emptyAgentSummary();
    const { attention, failed, reviewing, running, total, waiting } = summary;
    const colour = failed
      ? palette.stateSurface.failed
      : waiting
        ? palette.stateSurface.waiting_for_input
        : running
          ? palette.stateSurface.running
          : reviewing
            ? palette.stateSurface.ready_for_review
            : palette.stateSurface.idle;
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
      {},
      palette,
    );
  }

  async renderAttention(actionContext: Action<ActionSettings>): Promise<void> {
    const session = await this.ensure(actionContext);
    const palette = sessionPalette(session);
    const attention =
      session.attention[
        session.attentionIndex % Math.max(session.attention.length, 1)
      ];
    if (!attention) {
      await this.render(
        actionContext,
        "No attention",
        palette.stateSurface.ready_for_review,
        "✓",
        undefined,
        undefined,
        {},
        palette,
      );
      return;
    }
    await this.render(
      actionContext,
      `${session.attention.length} attention\n${title(attention.summary, 22)}`,
      attention.severity === "critical"
        ? palette.stateSurface.failed
        : palette.stateSurface.waiting_for_input,
      "!",
      undefined,
      undefined,
      {},
      palette,
    );
  }

  async renderProvider(actionContext: Action<ActionSettings>): Promise<void> {
    const session = await this.ensure(actionContext);
    const palette = sessionPalette(session);
    const unhealthy = session.unhealthyProviderCount;
    await this.render(
      actionContext,
      unhealthy
        ? `${unhealthy} provider issue`
        : `${session.providers.length} providers\nhealthy`,
      unhealthy
        ? palette.stateSurface.failed
        : palette.stateSurface.ready_for_review,
      "P",
      undefined,
      undefined,
      {},
      palette,
    );
  }

  private unavailableUsage(providerId: UsageProviderId): ProviderUsage {
    return {
      providerId,
      status: "unavailable",
      windows: [],
      observedAt: new Date().toISOString(),
    };
  }

  cancelUsageReset(actionId: string): void {
    const timer = this.usageResetTimers.get(actionId);
    if (timer) clearTimeout(timer);
    this.usageResetTimers.delete(actionId);
    this.usageResetUntil.delete(actionId);
  }

  private cancelUsageResetsForDevice(deviceId: string): void {
    const device = streamDeck.devices.getDeviceById(deviceId);
    if (!device) return;
    for (const actionContext of device.actions)
      if (actionContext.manifestId === ACTION_IDS.providerUsage)
        this.cancelUsageReset(actionContext.id);
  }

  private async writeUsage(
    actionContext: Action<ProviderUsageSettings>,
    session: DeviceSession,
    providerId: UsageProviderId,
    forceColour = false,
  ): Promise<void> {
    if (!actionContext.isKey()) return;
    const usage =
      session.providerUsage.get(providerId) ??
      this.unavailableUsage(providerId);
    const showingReset =
      (this.usageResetUntil.get(actionContext.id) ?? 0) > Date.now();
    const muted =
      !forceColour &&
      (session.connectionStatus !== "connected" ||
        !session.hasCompletedBringUp);
    await this.outputWriter.write(actionContext, {
      title: "",
      image: showingReset
        ? providerUsageResetImage(
            usage,
            sessionPalette(session),
            Date.now(),
            muted,
          )
        : providerUsageImage(usage, sessionPalette(session), Date.now(), muted),
    });
  }

  async renderUsage(
    actionContext: Action<ProviderUsageSettings>,
    settings: ProviderUsageSettings,
    forceColour = false,
  ): Promise<void> {
    const session = await this.ensure(actionContext);
    const providerId = normalizeUsageProviderId(
      settings.usageDefaultProviderId,
    );
    if (!session.providerUsage.has(providerId)) {
      const usage = await session.client
        .getProviderUsage(providerId)
        .catch(() => this.unavailableUsage(providerId));
      session.providerUsage.set(providerId, usage);
    }
    await this.writeUsage(actionContext, session, providerId, forceColour);
  }

  async showUsageReset(
    actionContext: Action<ProviderUsageSettings>,
    settings: ProviderUsageSettings,
  ): Promise<void> {
    const session = await this.ensure(actionContext);
    const providerId = normalizeUsageProviderId(
      settings.usageDefaultProviderId,
    );
    this.cancelUsageReset(actionContext.id);
    this.usageResetUntil.set(
      actionContext.id,
      Date.now() + USAGE_RESET_VIEW_MS,
    );
    await this.writeUsage(actionContext, session, providerId);
    const timer = setTimeout(() => {
      this.usageResetTimers.delete(actionContext.id);
      this.usageResetUntil.delete(actionContext.id);
      if (!this.actionSettings.has(actionContext.id)) return;
      const currentSettings = (this.actionSettings.get(actionContext.id) ??
        {}) as ProviderUsageSettings;
      void this.renderUsage(actionContext, currentSettings);
    }, USAGE_RESET_VIEW_MS);
    timer.unref();
    this.usageResetTimers.set(actionContext.id, timer);
  }

  private async refreshUsage(session: DeviceSession): Promise<void> {
    const entries = await Promise.all(
      USAGE_PROVIDER_IDS.map(
        async (providerId) =>
          [
            providerId,
            await session.client
              .getProviderUsage(providerId)
              .catch(() => this.unavailableUsage(providerId)),
          ] as const,
      ),
    );
    for (const [providerId, usage] of entries)
      session.providerUsage.set(providerId, usage);
    await this.renderVisible(
      session.deviceId,
      new Set([ACTION_IDS.providerUsage]),
    );
  }

  async renderSystem(actionContext: Action<ActionSettings>): Promise<void> {
    const session = await this.ensure(actionContext);
    const image = systemIcon(session, Date.now() - session.animationStartedAt);
    if (actionContext.isKey() || actionContext.isDial())
      await this.outputWriter.write(actionContext, { title: "", image });
  }

  private async refreshCreationContext(
    session: DeviceSession,
    force = false,
  ): Promise<boolean> {
    const previous = JSON.stringify(session.creationContext);
    if (session.creationContextPromise) {
      await session.creationContextPromise;
      return previous !== JSON.stringify(session.creationContext);
    }
    const now = Date.now();
    if (!force && now - session.creationContextCheckedAt < 1_250) return false;
    session.creationContextCheckedAt = now;
    session.creationContextPromise = session.client
      .getAgentCreationContext()
      .then((context) => {
        session.creationContext = context;
      })
      .catch((error: unknown) => {
        streamDeck.logger.debug(
          `Agent Deck creation context unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      })
      .finally(() => {
        session.creationContextPromise = undefined;
      });
    await session.creationContextPromise;
    return previous !== JSON.stringify(session.creationContext);
  }

  async renderCreation(
    actionContext: Action<ActionSettings>,
    settings: NewAgentSettings,
    forceDisconnected = false,
  ): Promise<void> {
    const session = await this.ensure(actionContext);
    const palette = sessionPalette(session);
    await this.refreshCreationContext(session);
    const providerId = settings.creationProviderId ?? "cursor-local";
    const roots =
      session.creationContext?.status === "available"
        ? session.creationContext.workspaceRoots
        : undefined;
    const workspace = roots?.length
      ? workspaceResourcesForRoots(providerId, roots).workspace
      : undefined;
    const workspaceAccent =
      session.creationContext?.workspaceColour ??
      (workspace ? workspaceColour(workspace) : palette.foreground);
    if (actionContext.isKey() || actionContext.isDial())
      await this.outputWriter.write(actionContext, {
        title: "",
        image: newAgentIcon(
          providerId,
          workspaceAccent,
          forceDisconnected || session.connectionStatus !== "connected",
          palette,
        ),
      });
  }

  async createAgent(
    actionContext: Action<ActionSettings>,
    settings: NewAgentSettings,
  ): Promise<boolean> {
    const session = await this.ensure(actionContext);
    const providerId = settings.creationProviderId ?? "cursor-local";
    const result = await session.client.createAgent(providerId);
    if (result.status === "opened") return true;
    streamDeck.logger.warn(
      `Agent Deck creation failed (${result.requestId}): ${
        result.message ?? result.status
      }`,
    );
    return false;
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

  async dismissAgentById(
    actionContext: Action<ActionSettings>,
    agentId: string,
  ): Promise<AgentDeletionResult> {
    const session = await this.ensure(actionContext);
    const agent = session.agentById.get(agentId);
    if (!agent) return "missing";
    if (agent.state === "running" || agent.state === "recovering") {
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
      deleted = await session.client.dismissAgent(agent.id);
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

  async reloadCommonSettings(
    actionContext: Action<ActionSettings>,
  ): Promise<void> {
    const deviceId = actionContext.device.id;
    this.cancelUsageResetsForDevice(deviceId);
    const session = this.sessions.get(deviceId);
    if (session) {
      session.watch?.close();
      if (session.refreshTimer) clearTimeout(session.refreshTimer);
      if (session.bringUpTimer) clearTimeout(session.bringUpTimer);
      if (session.creationContextTimer)
        clearTimeout(session.creationContextTimer);
      if (session.usageTimer) clearInterval(session.usageTimer);
      this.sessions.delete(deviceId);
    }
    this.syncSystemAppearanceMonitor();
    await this.ensure(actionContext);
    await this.renderVisible(deviceId);
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
      await session.client.dismissTerminalAgents();
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
    if (event.type === "agent.progress.changed") {
      // #region agent log
      fetch(
        "http://127.0.0.1:7387/ingest/f84f2bef-f713-45ff-9929-62841539443f",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Debug-Session-Id": "d833c3",
          },
          body: JSON.stringify({
            sessionId: "d833c3",
            runId: "pre-fix",
            hypothesisId: "H5",
            location: "clients/stream-deck/src/index.ts:onEvent",
            message: "Stream Deck received progress event",
            data: {
              sequence: event.sequence,
              refreshAgents: resources.has("agents"),
              refreshPending: Boolean(session.refreshTimer),
              refreshInFlight: Boolean(session.refreshPromise),
            },
            timestamp: Date.now(),
          }),
        },
      ).catch(() => {});
      // #endregion
    }
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
    if (resources.has("agents")) {
      // #region agent log
      fetch(
        "http://127.0.0.1:7387/ingest/f84f2bef-f713-45ff-9929-62841539443f",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Debug-Session-Id": "d833c3",
          },
          body: JSON.stringify({
            sessionId: "d833c3",
            runId: "pre-fix",
            hypothesisId: "H5",
            location: "clients/stream-deck/src/index.ts:refreshOnce",
            message: "Stream Deck fetched agent snapshot",
            data: {
              status: agents?.status,
              snapshotSequence:
                agents?.status === "fulfilled"
                  ? agents.value.asOfSequence
                  : undefined,
              lastSnapshotSequence: session.lastSnapshotSequence,
              clearingAgents: session.clearingAgents,
              progressAgents:
                agents?.status === "fulfilled"
                  ? agents.value.items
                      .filter((agent) => agent.progress?.plan)
                      .map((agent) => ({
                        state: agent.state,
                        plan: agent.progress?.plan,
                      }))
                  : [],
            },
            timestamp: Date.now(),
          }),
        },
      ).catch(() => {});
      // #endregion
    }
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
        if (agent.state !== "running" && agent.state !== "recovering") {
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
          session.bringUpStartedAt !== undefined &&
          actionContext.isKey() &&
          session.bringUpImages.has(actionContext.id)
        ) {
          targets.push({ actionContext, session, kind: "bring-up" });
          continue;
        }
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
        agent.state === "recovering" ||
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
    const palette = sessionPalette(session);
    if (kind === "bring-up") {
      const snapshot = session.bringUpImages.get(actionContext.id);
      if (
        !snapshot ||
        session.bringUpStartedAt === undefined ||
        !actionContext.isKey()
      )
        return;
      await this.outputWriter.write(
        actionContext,
        {
          image: bringUpImage(
            snapshot.image,
            now - session.bringUpStartedAt,
            {
              index: snapshot.index,
              total: snapshot.total,
              ...(snapshot.delayMs === undefined
                ? {}
                : { delayMs: snapshot.delayMs }),
            },
            snapshot.previousImage,
            palette,
          ),
          ...(snapshot.title === undefined ? {} : { title: snapshot.title }),
        },
        { binding: snapshot.binding },
      );
      return;
    }
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
          image: removedAgentIcon(
            removal.seed,
            now - removal.startedAt,
            false,
            palette,
          ),
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
            false,
            palette,
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
            buildAgentStaticVisuals(agent, "", palette),
          {
            elapsedMs: animationElapsedMs,
            stateElapsedMs: this.runningAnimationElapsedMs(session, agent, now),
          },
          look,
          false,
          this.pressedAgentActions.has(actionContext.id),
          stateTransition,
          palette,
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
          else if (visible.manifestId === ACTION_IDS.providerUsage)
            await this.renderUsage(visible, settings);
          else if (visible.manifestId === "com.agentdeck.monitor.system-health")
            await this.renderSystem(visible);
          else if (visible.manifestId === "com.agentdeck.monitor.new-agent")
            await this.renderCreation(visible, settings);
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
    palette: KeyVisualPalette = DARK_KEY_VISUAL_PALETTE,
  ): Promise<void> {
    if (actionContext.isKey() || actionContext.isDial())
      await this.outputWriter.write(actionContext, {
        title: text,
        image: icon(colour, symbol, accent, badge, options, palette),
      });
  }
}

const devices = new DeviceManager();
streamDeck.system.onSystemDidWakeUp(() => {
  void devices.refreshSystemAppearance();
});

const isCommonSettingsUpdated = (payload: unknown): boolean =>
  typeof payload === "object" &&
  payload !== null &&
  "type" in payload &&
  payload.type === "common-settings-updated";

@action({ UUID: ACTION_IDS.agentSlot })
class AgentSlotAction extends SingletonAction<AgentSlotSettings> {
  private readonly presses = new PressGestureController<
    string,
    AgentDeletionResult | "failed"
  >(LONG_PRESS_DURATION_MS);

  override async onWillAppear(
    ev: WillAppearEvent<AgentSlotSettings>,
  ): Promise<void> {
    this.presses.cancel(ev.action.id);
    devices.rememberAction(ev.action, ev.payload.settings);
    await devices.renderAgent(ev.action, ev.payload.settings);
  }
  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<AgentSlotSettings>,
  ): Promise<void> {
    devices.rememberAction(ev.action, ev.payload.settings);
    await devices.renderAgent(ev.action, ev.payload.settings);
  }
  override async onSendToPlugin(
    ev: SendToPluginEvent<Record<string, string>, AgentSlotSettings>,
  ): Promise<void> {
    if (isCommonSettingsUpdated(ev.payload))
      await devices.reloadCommonSettings(ev.action);
  }
  override onWillDisappear(ev: WillDisappearEvent<AgentSlotSettings>): void {
    this.presses.cancel(ev.action.id);
    devices.forgetAction(ev.action.id);
  }
  override onKeyDown(ev: KeyDownEvent<AgentSlotSettings>): void {
    const agentId = devices.renderedAgentId(ev.action);
    const started = this.presses.keyDown(
      ev.action.id,
      agentId,
      (pressedAgentId) =>
        devices
          .dismissAgentById(ev.action, pressedAgentId)
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
  override onKeyUp(ev: KeyUpEvent<AgentSlotSettings>): void {
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
    ev: DialRotateEvent<AgentSlotSettings>,
  ): Promise<void> {
    await devices.changePage(ev.action, Math.sign(ev.payload.ticks));
  }
}

@action({ UUID: ACTION_IDS.agentSummary })
class AgentSummaryAction extends SingletonAction<AgentSummarySettings> {
  override async onWillAppear(
    ev: WillAppearEvent<AgentSummarySettings>,
  ): Promise<void> {
    devices.rememberAction(ev.action, ev.payload.settings);
    await devices.renderAgentSummary(ev.action, ev.payload.settings);
  }
  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<AgentSummarySettings>,
  ): Promise<void> {
    devices.rememberAction(ev.action, ev.payload.settings);
    await devices.renderAgentSummary(ev.action, ev.payload.settings);
  }
  override async onSendToPlugin(
    ev: SendToPluginEvent<Record<string, string>, AgentSummarySettings>,
  ): Promise<void> {
    if (isCommonSettingsUpdated(ev.payload))
      await devices.reloadCommonSettings(ev.action);
  }
  override onWillDisappear(ev: WillDisappearEvent<AgentSummarySettings>): void {
    devices.forgetAction(ev.action.id);
  }
  override async onKeyDown(
    ev: KeyDownEvent<AgentSummarySettings>,
  ): Promise<void> {
    await devices.refreshFor(ev.action);
  }
}

@action({ UUID: ACTION_IDS.attention })
class AttentionAction extends SingletonAction<EmptyActionSettings> {
  override async onWillAppear(
    ev: WillAppearEvent<EmptyActionSettings>,
  ): Promise<void> {
    devices.rememberAction(ev.action, ev.payload.settings);
    await devices.renderAttention(ev.action);
  }
  override onWillDisappear(ev: WillDisappearEvent<EmptyActionSettings>): void {
    devices.forgetAction(ev.action.id);
  }
  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<EmptyActionSettings>,
  ): Promise<void> {
    devices.rememberAction(ev.action, ev.payload.settings);
    await devices.renderAttention(ev.action);
  }
  override async onSendToPlugin(
    ev: SendToPluginEvent<Record<string, string>, EmptyActionSettings>,
  ): Promise<void> {
    if (isCommonSettingsUpdated(ev.payload))
      await devices.reloadCommonSettings(ev.action);
  }
  override async onKeyDown(
    ev: KeyDownEvent<EmptyActionSettings>,
  ): Promise<void> {
    await devices.changeAttention(ev.action, 1);
  }
  override async onDialRotate(
    ev: DialRotateEvent<EmptyActionSettings>,
  ): Promise<void> {
    await devices.changeAttention(ev.action, Math.sign(ev.payload.ticks));
  }
}

@action({ UUID: ACTION_IDS.providerHealth })
class ProviderHealthAction extends SingletonAction<EmptyActionSettings> {
  override async onWillAppear(
    ev: WillAppearEvent<EmptyActionSettings>,
  ): Promise<void> {
    devices.rememberAction(ev.action, ev.payload.settings);
    await devices.renderProvider(ev.action);
  }
  override onWillDisappear(ev: WillDisappearEvent<EmptyActionSettings>): void {
    devices.forgetAction(ev.action.id);
  }
  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<EmptyActionSettings>,
  ): Promise<void> {
    devices.rememberAction(ev.action, ev.payload.settings);
    await devices.renderProvider(ev.action);
  }
  override async onSendToPlugin(
    ev: SendToPluginEvent<Record<string, string>, EmptyActionSettings>,
  ): Promise<void> {
    if (isCommonSettingsUpdated(ev.payload))
      await devices.reloadCommonSettings(ev.action);
  }
  override async onKeyDown(
    ev: KeyDownEvent<EmptyActionSettings>,
  ): Promise<void> {
    await devices.refreshFor(ev.action);
  }
}

@action({ UUID: ACTION_IDS.providerUsage })
class ProviderUsageAction extends SingletonAction<ProviderUsageSettings> {
  override async onWillAppear(
    ev: WillAppearEvent<ProviderUsageSettings>,
  ): Promise<void> {
    devices.cancelUsageReset(ev.action.id);
    devices.rememberAction(ev.action, ev.payload.settings);
    await devices.renderUsage(ev.action, ev.payload.settings);
  }
  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<ProviderUsageSettings>,
  ): Promise<void> {
    devices.cancelUsageReset(ev.action.id);
    devices.rememberAction(ev.action, ev.payload.settings);
    await devices.renderUsage(ev.action, ev.payload.settings);
  }
  override async onSendToPlugin(
    ev: SendToPluginEvent<Record<string, string>, ProviderUsageSettings>,
  ): Promise<void> {
    if (isCommonSettingsUpdated(ev.payload))
      await devices.reloadCommonSettings(ev.action);
  }
  override onWillDisappear(
    ev: WillDisappearEvent<ProviderUsageSettings>,
  ): void {
    devices.forgetAction(ev.action.id);
  }
  override async onKeyDown(
    ev: KeyDownEvent<ProviderUsageSettings>,
  ): Promise<void> {
    await devices.showUsageReset(ev.action, ev.payload.settings);
  }
}

@action({ UUID: ACTION_IDS.systemHealth })
class SystemHealthAction extends SingletonAction<EmptyActionSettings> {
  private readonly presses = new PressGestureController<true, void>(
    LONG_PRESS_DURATION_MS,
  );

  override async onWillAppear(
    ev: WillAppearEvent<EmptyActionSettings>,
  ): Promise<void> {
    this.presses.cancel(ev.action.id);
    devices.rememberAction(ev.action, ev.payload.settings);
    await devices.renderSystem(ev.action);
  }
  override onWillDisappear(ev: WillDisappearEvent<EmptyActionSettings>): void {
    this.presses.cancel(ev.action.id);
    devices.forgetAction(ev.action.id);
  }
  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<EmptyActionSettings>,
  ): Promise<void> {
    devices.rememberAction(ev.action, ev.payload.settings);
    await devices.renderSystem(ev.action);
  }
  override async onSendToPlugin(
    ev: SendToPluginEvent<Record<string, string>, EmptyActionSettings>,
  ): Promise<void> {
    if (isCommonSettingsUpdated(ev.payload))
      await devices.reloadCommonSettings(ev.action);
  }
  override onKeyDown(ev: KeyDownEvent<EmptyActionSettings>): void {
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
  override onKeyUp(ev: KeyUpEvent<EmptyActionSettings>): void {
    this.presses.keyUp(ev.action.id);
  }
}

@action({ UUID: ACTION_IDS.newAgent })
class NewAgentAction extends SingletonAction<NewAgentSettings> {
  override async onWillAppear(
    ev: WillAppearEvent<NewAgentSettings>,
  ): Promise<void> {
    devices.rememberAction(ev.action, ev.payload.settings);
    await devices.renderCreation(ev.action, ev.payload.settings);
  }
  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<NewAgentSettings>,
  ): Promise<void> {
    devices.rememberAction(ev.action, ev.payload.settings);
    await devices.renderCreation(ev.action, ev.payload.settings);
  }
  override async onSendToPlugin(
    ev: SendToPluginEvent<Record<string, string>, NewAgentSettings>,
  ): Promise<void> {
    if (isCommonSettingsUpdated(ev.payload))
      await devices.reloadCommonSettings(ev.action);
  }
  override onWillDisappear(ev: WillDisappearEvent<NewAgentSettings>): void {
    devices.forgetAction(ev.action.id);
  }
  override async onKeyDown(ev: KeyDownEvent<NewAgentSettings>): Promise<void> {
    try {
      const opened = await devices.createAgent(ev.action, ev.payload.settings);
      if (opened) await ev.action.showOk();
      else await ev.action.showAlert();
    } catch (error) {
      streamDeck.logger.error(
        `Agent Deck creation failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await ev.action.showAlert();
    }
  }
}

streamDeck.actions.registerAction(new AgentSlotAction());
streamDeck.actions.registerAction(new AgentSummaryAction());
streamDeck.actions.registerAction(new AttentionAction());
streamDeck.actions.registerAction(new ProviderHealthAction());
streamDeck.actions.registerAction(new ProviderUsageAction());
streamDeck.actions.registerAction(new SystemHealthAction());
streamDeck.actions.registerAction(new NewAgentAction());
await streamDeck.connect();
