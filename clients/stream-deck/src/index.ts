import streamDeck, {
  action,
  type Action,
  type DialRotateEvent,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  SingletonAction,
  type WillAppearEvent,
} from "@elgato/streamdeck";
import { AgentDeckClient, type WatchHandle } from "@agent-deck/client-sdk";
import type {
  Agent,
  Attention,
  CanonicalEvent,
  Provider,
} from "@agent-deck/domain";
import {
  DoublePressDetector,
  focusAgent,
  RenderedAgentTargets,
} from "./focus.js";

interface ActionSettings {
  slot?: number;
  summaryProviderId?: string;
  [key: string]: string | number | boolean | null | undefined;
}

interface DeviceConfiguration {
  serverUrl: string;
  name: string;
  role: string;
  providers: string[];
  states: Agent["state"][];
}

interface DeviceSession {
  deviceId: string;
  client: AgentDeckClient;
  configuration: DeviceConfiguration;
  connectionStatus: "connecting" | "connected" | "disconnected";
  allAgents: Agent[];
  agents: Agent[];
  attention: Attention[];
  providers: Provider[];
  health: Record<string, unknown>;
  page: number;
  attentionIndex: number;
  watch?: WatchHandle;
  refreshTimer: NodeJS.Timeout | undefined;
  refreshGeneration: number;
  animationTimer: NodeJS.Timeout | undefined;
  animationAngle: number;
  animationRenderPending: boolean;
}

interface SessionSnapshot {
  allAgents: Agent[];
  agents: Agent[];
  attention: Attention[];
  providers: Provider[];
  health: Record<string, unknown>;
}

const DEFAULT_CONFIGURATION: DeviceConfiguration = {
  serverUrl: "http://127.0.0.1:47831",
  name: "Stream Deck",
  role: "agent-monitor",
  providers: [],
  states: [
    "running",
    "waiting_for_input",
    "waiting_for_approval",
    "ready_for_review",
    "failed",
  ],
};

const ANIMATION_INTERVAL_MS = 50;
const ANIMATION_REVOLUTION_MS = 1_800;
const DOUBLE_PRESS_WINDOW_MS = 350;

const stateColour: Record<Agent["state"], string> = {
  idle: "#64748b",
  running: "#2563eb",
  waiting_for_input: "#f59e0b",
  waiting_for_approval: "#f97316",
  ready_for_review: "#10b981",
  failed: "#dc2626",
  cancelled: "#64748b",
  unknown: "#475569",
};

interface ProviderStyle {
  accent: string;
  label: string;
  mark: string;
}

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

const icon = (
  colour: string,
  symbol: string,
  accent = "#94a3b8",
  badge?: string,
): string =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
    <rect width="144" height="144" rx="24" fill="${colour}"/>
    <rect width="144" height="13" rx="7" fill="${accent}"/>
    <circle cx="114" cy="31" r="20" fill="${accent}"/>
    <text x="114" y="37" text-anchor="middle" font-family="system-ui" font-size="15" font-weight="800" fill="white">${badge ?? ""}</text>
    <text x="72" y="98" text-anchor="middle" font-family="system-ui" font-size="58" font-weight="700" fill="white">${symbol}</text>
  </svg>`,
  )}`;

const title = (value: string, max = 18): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const stateSymbol: Record<Exclude<Agent["state"], "running">, string> = {
  idle: "✓",
  waiting_for_input: "↻",
  waiting_for_approval: "↻",
  ready_for_review: "✓",
  failed: "×",
  cancelled: "×",
  unknown: "?",
};

const providerLogo = (providerId: string): string => {
  const id = providerId.toLowerCase();
  if (id.includes("cursor"))
    return `<g>
      <rect x="98" y="5" width="41" height="41" rx="10" fill="#11100d"/>
      <path d="M118.5 10L133 18.5V35L118.5 43.5L104 35V18.5L118.5 10Z" fill="#4c4b47"/>
      <path d="M106 19.5H131L118.5 27.5L106 19.5Z" fill="white"/>
      <path d="M131 19.5L118.5 41V27.5L131 19.5Z" fill="#d5d4d1"/>
      <path d="M104 35V18.5L118.5 27.5L104 35Z" fill="#5f5e5a"/>
      <path d="M104 35L118.5 27.5V43.5L104 35Z" fill="#85847f"/>
    </g>`;
  if (id.includes("codex") || id.includes("openai") || id.includes("chatgpt"))
    return `<g transform="translate(101 9) scale(.18)">
      <path d="M60.87 57.26V42.31c0-1.26.47-2.2 1.57-2.83l30.05-17.3c4.09-2.36 8.97-3.46 14-3.46 18.88 0 30.83 14.63 30.83 30.2 0 1.1 0 2.36-.16 3.62l-31.14-18.25c-1.89-1.1-3.78-1.1-5.66 0L60.87 57.26Zm70.16 58.2V79.75c0-2.2-.94-3.78-2.83-4.88L88.71 51.91l12.9-7.39c1.1-.63 2.05-.63 3.15 0l30.04 17.3c8.65 5.03 14.47 15.73 14.47 26.11 0 11.95-7.08 22.97-18.24 27.53ZM51.59 84 38.7 76.45c-1.1-.63-1.58-1.58-1.58-2.84v-34.6c0-16.83 12.9-29.57 30.36-29.57 6.61 0 12.74 2.2 17.93 6.13L54.43 33.5c-1.89 1.1-2.83 2.67-2.83 4.88V84Zm27.77 16.04L60.87 89.66V67.64l18.49-10.38 18.48 10.38v22.02l-18.48 10.38Zm11.87 47.82c-6.61 0-12.74-2.2-17.93-6.13l30.99-17.94c1.89-1.1 2.83-2.67 2.83-4.88V73.3l13.05 7.55c1.1.63 1.58 1.57 1.58 2.83v34.61c0 16.83-13.06 29.57-30.52 29.57Zm-37.28-35.08L23.91 95.48c-8.65-5.03-14.47-15.73-14.47-26.11 0-12.11 7.24-22.97 18.4-27.53v35.87c0 2.2.94 3.77 2.83 4.87L70 105.39l-12.9 7.39c-1.1.63-2.05.63-3.15 0Zm-1.73 25.8c-17.77 0-30.83-13.37-30.83-29.89 0-1.26.16-2.52.32-3.77l30.98 17.93c1.89 1.1 3.78 1.1 5.67 0l39.48-22.81v14.95c0 1.26-.47 2.2-1.58 2.83l-30.04 17.3c-4.09 2.36-8.97 3.46-14 3.46Z" fill="white"/>
    </g>`;
  const mark = escapeXml(providerStyle(providerId).mark);
  return `<circle cx="116" cy="24" r="17" fill="#000" opacity=".3"/>
    <text x="116" y="29" text-anchor="middle" font-family="system-ui" font-size="12" font-weight="800" fill="white">${mark}</text>`;
};

const agentStateIndicator = (
  state: Agent["state"],
  animationAngle: number,
): string => {
  if (state === "running")
    return `<g transform="rotate(${-animationAngle} 72 72) translate(36 36) scale(3)" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 12a9 9 0 0 0-15.5-6.2L3 8"/>
      <path d="M3 3v5h5"/>
      <path d="M3 12a9 9 0 0 0 15.5 6.2L21 16"/>
      <path d="M21 21v-5h-5"/>
    </g>`;
  return `<text x="72" y="91" text-anchor="middle" font-family="system-ui" font-size="64" font-weight="700" fill="white">${stateSymbol[state]}</text>`;
};

const agentIcon = (agent: Agent, animationAngle: number): string =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 144 144">
      <rect width="144" height="144" rx="24" fill="${stateColour[agent.state]}"/>
      ${providerLogo(agent.providerId)}
      ${agentStateIndicator(agent.state, animationAngle)}
      <rect x="7" y="111" width="130" height="26" rx="9" fill="#000" opacity=".34"/>
      <text x="72" y="129" text-anchor="middle" font-family="system-ui" font-size="13" font-weight="650" fill="white">${escapeXml(title(agent.title, 21))}</text>
    </svg>`,
  )}`;

class DeviceManager {
  private readonly sessions = new Map<string, DeviceSession>();
  private readonly pendingSessions = new Map<string, Promise<DeviceSession>>();
  private readonly renderedAgents = new RenderedAgentTargets();

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
    const session: DeviceSession = {
      deviceId,
      client,
      configuration,
      connectionStatus: "connecting",
      allAgents: [],
      agents: [],
      attention: [],
      providers: [],
      health: {},
      page: 0,
      attentionIndex: 0,
      refreshTimer: undefined,
      refreshGeneration: 0,
      animationTimer: undefined,
      animationAngle: 0,
      animationRenderPending: false,
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
          states: configuration.states,
        },
        onEvent: (event) => this.onEvent(session, event),
        onResyncRequired: () => {
          void this.refresh(session);
        },
        onStatus: (status) => {
          session.connectionStatus = status;
          void this.renderVisible(session.deviceId);
        },
      },
    );
    session.animationTimer = setInterval(() => {
      if (
        session.animationRenderPending ||
        !session.agents.some((agent) => agent.state === "running")
      )
        return;
      session.animationAngle =
        ((Date.now() % ANIMATION_REVOLUTION_MS) / ANIMATION_REVOLUTION_MS) *
        360;
      session.animationRenderPending = true;
      void this.renderRunningAgents(session).finally(() => {
        session.animationRenderPending = false;
      });
    }, ANIMATION_INTERVAL_MS);
    session.animationTimer.unref();
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
    const agent = session.agents[session.page * pageSize + slot];
    this.renderedAgents.set(actionContext.id, agent?.id);
    if (!agent) {
      await this.render(
        actionContext,
        `Agent ${slot + 1}`,
        "#1e293b",
        "+",
        "#475569",
        "AG",
      );
      return;
    }
    if (actionContext.isKey())
      await Promise.all([
        actionContext.setTitle(""),
        actionContext.setImage(agentIcon(agent, session.animationAngle)),
      ]);
    else if (actionContext.isDial())
      await Promise.all([
        actionContext.setTitle(""),
        actionContext.setImage(agentIcon(agent, session.animationAngle)),
      ]);
  }

  async renderAgentSummary(
    actionContext: Action<ActionSettings>,
    settings: ActionSettings,
  ): Promise<void> {
    const session = await this.ensure(actionContext);
    const providerId = String(settings.summaryProviderId ?? "").trim();
    const agents = providerId
      ? session.allAgents.filter((agent) => agent.providerId === providerId)
      : session.allAgents;
    const attention = agents.filter((agent) => agent.requiresAttention).length;
    const running = agents.filter((agent) => agent.state === "running").length;
    const failed = agents.some((agent) => agent.state === "failed");
    const waiting = agents.some(
      (agent) =>
        agent.state === "waiting_for_input" ||
        agent.state === "waiting_for_approval",
    );
    const reviewing = agents.some(
      (agent) => agent.state === "ready_for_review",
    );
    const colour = failed
      ? stateColour.failed
      : waiting
        ? stateColour.waiting_for_input
        : running
          ? stateColour.running
          : reviewing
            ? stateColour.ready_for_review
            : stateColour.idle;
    const style = providerId
      ? providerStyle(providerId)
      : { accent: "#38bdf8", label: "All agents", mark: "Σ" };
    await this.render(
      actionContext,
      `${style.label} · ${agents.length}\n${running} running · ${attention} alert`,
      colour,
      attention ? String(Math.min(attention, 9)) : String(agents.length),
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
      await this.render(actionContext, "No attention", "#166534", "✓");
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
    const unhealthy = session.providers.filter(
      (provider) =>
        provider.health === "unhealthy" || provider.health === "degraded",
    );
    await this.render(
      actionContext,
      unhealthy.length
        ? `${unhealthy.length} provider issue`
        : `${session.providers.length} providers\nhealthy`,
      unhealthy.length ? "#dc2626" : "#166534",
      "P",
    );
  }

  async renderSystem(actionContext: Action<ActionSettings>): Promise<void> {
    const session = await this.ensure(actionContext);
    const status =
      typeof session.health.status === "string"
        ? session.health.status
        : "unknown";
    let colour = "#dc2626";
    let symbol = "!";
    if (
      session.connectionStatus === "connecting" ||
      status === "connecting" ||
      status === "restarting" ||
      status === "loading" ||
      status === "starting"
    ) {
      colour = "#f59e0b";
      symbol = "↻";
    } else if (
      session.connectionStatus === "disconnected" ||
      status === "disconnected"
    )
      symbol = "×";
    else if (session.connectionStatus === "connected" && status === "healthy") {
      colour = "#16a34a";
      symbol = "✓";
    }
    await this.render(actionContext, "", colour, symbol, "#0f172a", "D");
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

  async focusRenderedAgent(
    actionContext: Action<ActionSettings>,
  ): Promise<void> {
    const session = await this.ensure(actionContext);
    const agent = this.renderedAgents.resolve(
      actionContext.id,
      session.allAgents,
    );
    const result = await focusAgent(agent);
    if (result.status === "opened" && actionContext.isKey())
      await actionContext.showOk();
    else {
      streamDeck.logger.warn(
        `Agent Deck focus failed: ${result.status === "unavailable" ? result.reason : "unknown error"}`,
      );
      await actionContext.showAlert();
    }
  }

  async removeRenderedAgent(
    actionContext: Action<ActionSettings>,
  ): Promise<void> {
    const session = await this.ensure(actionContext);
    const agent = this.renderedAgents.resolve(
      actionContext.id,
      session.allAgents,
    );
    if (!agent) {
      await actionContext.showAlert();
      return;
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
    const pageSize =
      actionContext.device.size.columns * actionContext.device.size.rows || 1;
    const lastPage = Math.max(
      0,
      Math.ceil(session.agents.length / pageSize) - 1,
    );
    session.page = Math.min(session.page, lastPage);
    await this.renderVisible(session.deviceId);
    if (actionContext.isKey()) await actionContext.showOk();
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

  async clearAndRefreshFor(
    actionContext: Action<ActionSettings>,
  ): Promise<void> {
    const session = await this.ensure(actionContext);
    const fallback: SessionSnapshot = {
      allAgents: session.allAgents,
      agents: session.agents,
      attention: session.attention,
      providers: session.providers,
      health: session.health,
    };
    if (session.refreshTimer) {
      clearTimeout(session.refreshTimer);
      session.refreshTimer = undefined;
    }
    session.refreshGeneration++;
    session.allAgents = [];
    session.agents = [];
    session.attention = [];
    session.providers = [];
    session.health = {};
    session.page = 0;
    session.attentionIndex = 0;
    session.animationAngle = 0;
    await this.renderVisible(session.deviceId);
    await this.refresh(session, fallback);
  }

  private onEvent(session: DeviceSession, _event: CanonicalEvent): void {
    if (session.refreshTimer) return;
    session.refreshTimer = setTimeout(() => {
      session.refreshTimer = undefined;
      void this.refresh(session);
    }, 150);
  }

  private async refresh(
    session: DeviceSession,
    fallback?: SessionSnapshot,
  ): Promise<void> {
    const generation = ++session.refreshGeneration;
    const [agents, attention, providers, health] = await Promise.allSettled([
      session.client.listAgents({ limit: 200 }),
      session.client.listAttention(),
      session.client.listProviders(),
      session.client.health(),
    ]);
    if (generation !== session.refreshGeneration) return;
    if (agents.status === "fulfilled") {
      const freshAgents = agents.value.items.filter(
        (agent) => agent.freshness === "fresh",
      );
      session.allAgents = freshAgents;
      session.agents = freshAgents
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
    } else if (fallback) {
      session.allAgents = fallback.allAgents;
      session.agents = fallback.agents;
    }
    if (attention.status === "fulfilled")
      session.attention = attention.value.items;
    else if (fallback) session.attention = fallback.attention;
    if (providers.status === "fulfilled")
      session.providers = providers.value.items;
    else if (fallback) session.providers = fallback.providers;
    if (health.status === "fulfilled") session.health = health.value;
    else if (fallback) session.health = fallback.health;
    for (const [resource, result] of [
      ["agents", agents],
      ["attention", attention],
      ["providers", providers],
      ["health", health],
    ] as const) {
      if (result.status === "fulfilled") continue;
      streamDeck.logger.error(
        `Agent Deck ${resource} refresh failed: ${
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason)
        }`,
      );
    }
    await this.renderVisible(session.deviceId);
  }

  private async renderRunningAgents(session: DeviceSession): Promise<void> {
    const device = streamDeck.devices.getDeviceById(session.deviceId);
    if (!device) return;
    const updates: Promise<void>[] = [];
    for (const visible of device.actions) {
      if (visible.manifestId !== "com.agentdeck.monitor.agent-slot") continue;
      const agent = this.renderedAgents.resolve(visible.id, session.allAgents);
      if (agent?.state !== "running") continue;
      updates.push(visible.setImage(agentIcon(agent, session.animationAngle)));
    }
    await Promise.all(updates);
  }

  private async renderVisible(deviceId: string): Promise<void> {
    const device = streamDeck.devices.getDeviceById(deviceId);
    if (!device) return;
    for (const visible of device.actions) {
      const settings = await visible.getSettings<ActionSettings>();
      if (visible.manifestId === "com.agentdeck.monitor.agent-slot")
        await this.renderAgent(visible, settings);
      else if (visible.manifestId === "com.agentdeck.monitor.agent-summary")
        await this.renderAgentSummary(visible, settings);
      else if (visible.manifestId === "com.agentdeck.monitor.attention")
        await this.renderAttention(visible);
      else if (visible.manifestId === "com.agentdeck.monitor.provider-health")
        await this.renderProvider(visible);
      else if (visible.manifestId === "com.agentdeck.monitor.system-health")
        await this.renderSystem(visible);
    }
  }

  private async render(
    actionContext: Action<ActionSettings>,
    text: string,
    colour: string,
    symbol: string,
    accent?: string,
    badge?: string,
  ): Promise<void> {
    if (actionContext.isKey()) {
      await Promise.all([
        actionContext.setTitle(text),
        actionContext.setImage(icon(colour, symbol, accent, badge)),
      ]);
    } else if (actionContext.isDial()) {
      await Promise.all([
        actionContext.setTitle(text),
        actionContext.setImage(icon(colour, symbol, accent, badge)),
      ]);
    }
  }
}

const devices = new DeviceManager();

@action({ UUID: "com.agentdeck.monitor.agent-slot" })
class AgentSlotAction extends SingletonAction<ActionSettings> {
  private readonly doublePresses = new DoublePressDetector(
    DOUBLE_PRESS_WINDOW_MS,
  );

  override async onWillAppear(
    ev: WillAppearEvent<ActionSettings>,
  ): Promise<void> {
    await devices.renderAgent(ev.action, ev.payload.settings);
  }
  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<ActionSettings>,
  ): Promise<void> {
    await devices.renderAgent(ev.action, ev.payload.settings);
  }
  override async onKeyDown(ev: KeyDownEvent<ActionSettings>): Promise<void> {
    const isDoublePress = this.doublePresses.press(ev.action.id, () => {
      void devices.focusRenderedAgent(ev.action).catch((error: unknown) => {
        streamDeck.logger.error(
          `Agent Deck focus failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    });
    if (isDoublePress) await devices.removeRenderedAgent(ev.action);
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
    await devices.renderAgentSummary(ev.action, ev.payload.settings);
  }
  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<ActionSettings>,
  ): Promise<void> {
    await devices.renderAgentSummary(ev.action, ev.payload.settings);
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
    await devices.renderProvider(ev.action);
  }
  override async onKeyDown(ev: KeyDownEvent<ActionSettings>): Promise<void> {
    await devices.refreshFor(ev.action);
  }
}

@action({ UUID: "com.agentdeck.monitor.system-health" })
class SystemHealthAction extends SingletonAction<ActionSettings> {
  override async onWillAppear(
    ev: WillAppearEvent<ActionSettings>,
  ): Promise<void> {
    await devices.renderSystem(ev.action);
  }
  override async onKeyDown(ev: KeyDownEvent<ActionSettings>): Promise<void> {
    await devices.clearAndRefreshFor(ev.action);
  }
}

streamDeck.actions.registerAction(new AgentSlotAction());
streamDeck.actions.registerAction(new AgentSummaryAction());
streamDeck.actions.registerAction(new AttentionAction());
streamDeck.actions.registerAction(new ProviderHealthAction());
streamDeck.actions.registerAction(new SystemHealthAction());
await streamDeck.connect();
