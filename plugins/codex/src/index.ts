import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { z } from "zod";
import {
  canonicalId,
  isActiveAgentState,
  workspaceResourcesForRoots,
  type Agent,
  type AgentRun,
  type CommandResult,
  type Project,
  type ProviderCommand,
  type ProviderEvent,
  type ProviderHealth,
  type ProviderSnapshot,
  type ProviderUsage,
  type Workspace,
} from "@agent-deck/domain";
import type {
  AgentProviderPlugin,
  ProviderContext,
  ProviderEventEmitter,
  Unsubscribe,
} from "@agent-deck/provider-sdk";
import { CodexAppServerClient } from "./app-server-client.js";

const PROVIDER_ID = "codex";

const ConfigSchema = z
  .object({
    binary: z.string().default("codex"),
  })
  .default({ binary: "codex" });

const ThreadSchema = z
  .object({
    id: z.string(),
    name: z.string().nullish(),
    cwd: z.string().nullish(),
    createdAt: z.number().nullish(),
    updatedAt: z.number().nullish(),
    status: z
      .object({
        type: z.string(),
        activeFlags: z.array(z.string()).optional(),
      })
      .nullish(),
    turns: z
      .array(
        z.object({
          id: z.string(),
          status: z.string(),
        }),
      )
      .optional(),
  })
  .passthrough();

const RateLimitWindowSchema = z
  .object({
    usedPercent: z.number().finite(),
    windowDurationMins: z.number().finite().positive().nullish(),
    resetsAt: z.union([z.number(), z.string()]).nullish(),
  })
  .passthrough();

const RateLimitsSchema = z
  .object({
    rateLimits: z
      .object({
        primary: RateLimitWindowSchema.nullish(),
        secondary: RateLimitWindowSchema.nullish(),
      })
      .nullish(),
  })
  .passthrough();

const HookSchema = z
  .object({
    protocol_version: z.literal(1).optional(),
    session_id: z.string(),
    hook_event_name: z.enum([
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PermissionRequest",
      "PostToolUse",
      "Stop",
      "SessionEnd",
    ]),
    cwd: z.string(),
    turn_id: z.string().optional(),
    tool_use_id: z.string().optional(),
    agent_activity: z
      .enum([
        "planning",
        "exploring",
        "researching",
        "editing",
        "executing",
        "delegating",
        "waiting",
        "working",
      ])
      .optional(),
    plan_progress: z
      .object({
        completed: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
      })
      .refine((plan) => plan.completed <= plan.total)
      .optional(),
    permission_mode: z.string().optional(),
    status: z.string().optional(),
    final_status: z.string().optional(),
    reason: z.string().optional(),
    agent_signal: z.enum(["question_started"]).optional(),
  })
  .strip();

type HookInput = z.infer<typeof HookSchema>;
type Thread = z.infer<typeof ThreadSchema>;
type ThreadTurn = NonNullable<Thread["turns"]>[number];

const timestamp = (
  seconds: number | null | undefined,
  fallback: string,
): string => (seconds ? new Date(seconds * 1_000).toISOString() : fallback);

const usageResetTimestamp = (
  value: number | string | null | undefined,
): string | undefined => {
  if (value === null || value === undefined) return undefined;
  const numeric = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(numeric))
    return new Date(
      numeric < 10_000_000_000 ? numeric * 1_000 : numeric,
    ).toISOString();
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
};

export const parseCodexUsage = (
  input: unknown,
  observedAt: string,
): ProviderUsage => {
  const parsed = RateLimitsSchema.safeParse(input);
  if (!parsed.success || !parsed.data.rateLimits)
    return {
      providerId: PROVIDER_ID,
      status: "unavailable",
      windows: [],
      observedAt,
      message: "Codex usage limits are unavailable",
    };
  const { primary, secondary } = parsed.data.rateLimits;
  const candidates = [primary, secondary].filter(
    (window) => window !== null && window !== undefined,
  );
  const fiveHour =
    candidates.find(
      (window) =>
        window.windowDurationMins !== null &&
        window.windowDurationMins !== undefined &&
        window.windowDurationMins <= 360,
    ) ??
    (primary?.windowDurationMins === null ||
    primary?.windowDurationMins === undefined
      ? primary
      : undefined);
  const weekly =
    candidates.find(
      (window) =>
        window.windowDurationMins !== null &&
        window.windowDurationMins !== undefined &&
        window.windowDurationMins >= 7 * 24 * 60,
    ) ??
    (secondary?.windowDurationMins === null ||
    secondary?.windowDurationMins === undefined
      ? secondary
      : undefined);
  const windows = [
    ["five-hour", "5h", fiveHour],
    ["weekly", "Week", weekly],
  ] as const;
  return {
    providerId: PROVIDER_ID,
    status: "available",
    windows: windows.map(([id, label, window]) => {
      if (!window)
        return {
          id,
          label,
          usedPercent: 0,
          available: false,
        };
      const resetsAt = usageResetTimestamp(window.resetsAt);
      return {
        id,
        label,
        usedPercent: Math.min(100, Math.max(0, window.usedPercent)),
        available: true,
        ...(resetsAt ? { resetsAt } : {}),
      };
    }),
    observedAt,
  };
};

const cursorCodexFocusLink = (threadId: string, cwd: string): string => {
  const url = new URL("cursor://agent-deck.focus/codex");
  url.searchParams.set("threadId", threadId);
  url.searchParams.set("cwd", cwd);
  return url.href;
};

const waitingState = (
  status: z.infer<typeof ThreadSchema>["status"],
  previousState?: Agent["state"],
): Agent["state"] | undefined => {
  if (previousState === "waiting_for_input") return "waiting_for_input";
  if (status?.activeFlags?.includes("waitingOnApproval"))
    return "waiting_for_approval";
  return undefined;
};

const currentTurnForDiscovery = (
  turns: ThreadTurn[] | undefined,
  hookTurnId: string | undefined,
): ThreadTurn | undefined => {
  if (!hookTurnId) return turns?.at(-1);
  return (
    turns?.find((turn) => turn.id === hookTurnId) ?? {
      id: hookTurnId,
      status: "inProgress",
    }
  );
};

const mapState = (
  status: z.infer<typeof ThreadSchema>["status"],
  previousState?: Agent["state"],
  turnStatus?: string,
): Agent["state"] => {
  if (turnStatus === "failed") return "failed";
  if (turnStatus === "interrupted") return "cancelled";
  if (turnStatus === "inProgress")
    return waitingState(status, previousState) ?? "running";
  if (turnStatus) return "ready_for_review";
  if (!status) return "unknown";
  if (status.type === "systemError") return "failed";
  if (status.type === "active")
    return waitingState(status, previousState) ?? "running";
  if (status.type === "idle") return "ready_for_review";
  if (status.type === "notLoaded") return previousState ?? "idle";
  return "unknown";
};

const terminalStatus = (input: HookInput): string =>
  (input.final_status ?? input.status ?? input.reason ?? "").toLowerCase();

const agentTerminalState = (input: HookInput): Agent["state"] => {
  const status = terminalStatus(input);
  if (status.includes("error") || status.includes("fail")) return "failed";
  if (status.includes("abort") || status.includes("cancel")) return "cancelled";
  return "ready_for_review";
};

const runTerminalState = (input: HookInput): AgentRun["state"] => {
  const status = terminalStatus(input);
  if (status.includes("error") || status.includes("fail")) return "failed";
  if (status.includes("abort") || status.includes("cancel")) return "cancelled";
  return "succeeded";
};

const isQuestionTool = (input: HookInput): boolean => {
  return input.agent_signal === "question_started";
};

const modeFor = (input: HookInput): string | undefined =>
  input.permission_mode?.trim().toLowerCase() === "plan" ||
  input.agent_signal === "question_started"
    ? "plan"
    : undefined;

const withoutProgress = (agent: Agent): Agent => {
  const copy = { ...agent };
  delete copy.progress;
  return copy;
};

const ACTIVE_HOOK_EVENTS = new Set([
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
]);

class CodexProvider implements AgentProviderPlugin {
  readonly manifest = {
    id: "codex",
    displayName: "Codex",
    version: "0.1.0",
    sdkVersion: 2 as const,
    capabilities: {
      discovery: true,
      liveEvents: true,
      commands: ["cancel"],
      usage: true,
    },
  };
  readonly configSchema = ConfigSchema;
  private context: ProviderContext | undefined;
  private client: CodexAppServerClient | undefined;
  private emit: ProviderEventEmitter | undefined;
  private readonly agents = new Map<string, Agent>();
  private readonly runs = new Map<string, AgentRun>();
  private readonly activeSessions = new Set<string>();
  private readonly activeTurns = new Map<string, string>();
  private readonly sourceRevisions = new Map<string, number>();
  private readonly questionToolUses = new Map<string, string>();
  private readonly seenHooks = new Set<string>();
  private operationQueue: Promise<void> = Promise.resolve();
  private lastError: string | undefined;

  async initialise(context: ProviderContext): Promise<void> {
    this.context = context;
    const config = ConfigSchema.parse(context.config);
    this.client = new CodexAppServerClient(config.binary);
    context.registerIngress({
      path: "/hooks",
      handle: async (input) => {
        const parsed = HookSchema.safeParse(input);
        if (!parsed.success)
          return { statusCode: 400, body: { accepted: false } };
        void this.enqueue(() => this.consumeHook(parsed.data)).catch(
          (error) => {
            this.context?.logger.warn(
              { error },
              "Failed to process Codex hook",
            );
          },
        );
        return { statusCode: 202, body: { accepted: true } };
      },
    });
  }

  async discover(): Promise<ProviderSnapshot> {
    return this.enqueue(() => this.discoverNow());
  }

  private async discoverNow(): Promise<ProviderSnapshot> {
    if (!this.context || !this.client)
      throw new Error("Codex provider not initialised");
    const now = this.context.now();
    try {
      const threads = (await this.client.listThreads())
        .map((thread) => ThreadSchema.safeParse(thread))
        .filter((result) => result.success)
        .map((result) => result.data);
      const nextAgents = new Map<string, Agent>();
      const nextRuns = new Map<string, AgentRun>();
      const projects = new Map<string, Project>();
      const workspaces = new Map<string, Workspace>();
      for (const listedThread of threads) {
        let thread = listedThread;
        const agentId = canonicalId("codex", thread.id);
        const existing = this.agents.get(agentId);
        if (
          thread.status?.type === "notLoaded" &&
          existing &&
          isActiveAgentState(existing.state)
        ) {
          const detailed = ThreadSchema.safeParse(
            await this.client.readThread(thread.id).catch(() => undefined),
          );
          if (detailed.success) thread = detailed.data;
        }
        const cwd = thread.cwd ? resolve(thread.cwd) : "";
        const resources = workspaceResourcesForRoots(
          PROVIDER_ID,
          cwd ? [cwd] : [],
        );
        const project = resources.projects[0];
        const workspace = resources.workspace;
        const hookTurnId = this.activeTurns.get(thread.id);
        const hookSessionActive = this.activeSessions.has(thread.id);
        const hookSessionWithoutTurn = hookSessionActive && !hookTurnId;
        const activeTurn = hookSessionWithoutTurn
          ? undefined
          : currentTurnForDiscovery(thread.turns, hookTurnId);
        const state = hookSessionWithoutTurn
          ? (existing?.state ?? "running")
          : mapState(thread.status, existing?.state, activeTurn?.status);
        if (!isActiveAgentState(state)) continue;
        const discoveredAt = timestamp(thread.updatedAt, now);
        const updatedAt =
          existing && existing.lastActivityAt > discoveredAt
            ? existing.lastActivityAt
            : discoveredAt;
        const discoveredRunId = activeTurn
          ? canonicalId("codex", `${thread.id}:${activeTurn.id}`)
          : undefined;
        const activeRunId = discoveredRunId ?? existing?.activeRunId;
        const title =
          thread.name ?? (cwd ? basename(cwd) : `Codex ${thread.id.slice(-6)}`);
        const previousCwd =
          typeof existing?.metadata.cwd === "string"
            ? existing.metadata.cwd
            : undefined;
        const metadata: Record<string, unknown> = { ...existing?.metadata };
        if (cwd) {
          metadata.cwd = cwd;
          metadata.workspaceRoots = [cwd];
        } else {
          delete metadata.cwd;
          delete metadata.workspaceRoots;
        }
        const changed =
          !existing ||
          existing.state !== state ||
          existing.activeRunId !== activeRunId ||
          existing.projectId !== project?.id ||
          existing.workspaceId !== workspace?.id ||
          existing.title !== title ||
          existing.lastActivityAt !== updatedAt ||
          previousCwd !== (cwd || undefined);
        const sourceRevision = changed
          ? this.nextSourceRevision(thread.id)
          : existing.sourceRevision;
        const agent: Agent = {
          id: agentId,
          providerId: PROVIDER_ID,
          externalId: thread.id,
          title,
          ...(project ? { projectId: project.id } : {}),
          ...(workspace ? { workspaceId: workspace.id } : {}),
          state,
          activityEpoch:
            discoveredRunId ??
            existing?.activityEpoch ??
            `${thread.id}:${thread.createdAt ?? thread.updatedAt ?? "active"}`,
          ...(activeRunId ? { activeRunId } : {}),
          requiresAttention:
            state === "waiting_for_approval" ||
            state === "waiting_for_input" ||
            state === "ready_for_review" ||
            state === "failed",
          lastActivityAt: updatedAt,
          revision: existing?.revision ?? 0,
          ...(sourceRevision !== undefined ? { sourceRevision } : {}),
          ...(isActiveAgentState(state) && existing?.progress
            ? { progress: existing.progress }
            : {}),
          capabilities: {
            messages: false,
            approvals: false,
            cancellation: true,
            creation: false,
          },
          links: cwd
            ? [
                {
                  rel: "focus",
                  label: "Open in Cursor Codex",
                  href: cursorCodexFocusLink(thread.id, cwd),
                },
              ]
            : [],
          metadata,
        };
        nextAgents.set(agent.id, agent);
        if (project) projects.set(project.id, project);
        if (workspace) workspaces.set(workspace.id, workspace);
        if (activeTurn && activeRunId) {
          const existingRun = this.runs.get(activeRunId);
          const run: AgentRun = {
            id: activeRunId,
            agentId: agent.id,
            providerId: PROVIDER_ID,
            externalId: activeTurn.id,
            state:
              activeTurn.status === "inProgress"
                ? state === "waiting_for_approval"
                  ? "waiting_for_approval"
                  : state === "waiting_for_input"
                    ? "waiting_for_input"
                    : "running"
                : activeTurn.status === "failed"
                  ? "failed"
                  : activeTurn.status === "interrupted"
                    ? "cancelled"
                    : "succeeded",
            revision: existingRun?.revision ?? 0,
            ...(sourceRevision !== undefined ? { sourceRevision } : {}),
            metadata: existingRun?.metadata ?? {},
          };
          nextRuns.set(run.id, run);
          if (activeTurn.status !== "inProgress") {
            this.activeSessions.delete(thread.id);
            this.activeTurns.delete(thread.id);
          }
        }
      }
      this.agents.clear();
      for (const [id, agent] of nextAgents) this.agents.set(id, agent);
      this.runs.clear();
      for (const [id, run] of nextRuns) this.runs.set(id, run);
      for (const sessionId of this.activeTurns.keys()) {
        if (!this.agents.has(canonicalId(PROVIDER_ID, sessionId)))
          this.activeTurns.delete(sessionId);
      }
      for (const sessionId of this.activeSessions)
        if (!this.agents.has(canonicalId(PROVIDER_ID, sessionId)))
          this.activeSessions.delete(sessionId);
      for (const sessionId of this.questionToolUses.keys()) {
        if (!this.agents.has(canonicalId(PROVIDER_ID, sessionId)))
          this.questionToolUses.delete(sessionId);
      }
      this.lastError = undefined;
      const snapshot = {
        reconciliation: "authoritative" as const,
        observedAt: now,
        workspaces: [...workspaces.values()],
        projects: [...projects.values()],
        agents: [...this.agents.values()],
        runs: [...this.runs.values()],
        attention: [],
      };
      return snapshot;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async subscribe(emit: ProviderEventEmitter): Promise<Unsubscribe> {
    this.emit = emit;
    return async () => {
      this.emit = undefined;
    };
  }

  async execute(command: ProviderCommand): Promise<CommandResult> {
    return this.enqueue(() => this.executeCommand(command));
  }

  private async executeCommand(
    command: ProviderCommand,
  ): Promise<CommandResult> {
    if (command.action !== "cancel")
      return {
        commandId: command.commandId,
        status: "unsupported",
        message: `Codex does not support ${command.action}`,
      };
    const agent = this.agents.get(command.agentId);
    const run = agent?.activeRunId
      ? this.runs.get(agent.activeRunId)
      : undefined;
    if (!agent || !run || !isActiveAgentState(agent.state))
      return {
        commandId: command.commandId,
        status: "failed",
        message: "Codex agent is not running",
      };
    if (!this.client)
      return {
        commandId: command.commandId,
        status: "failed",
        message: "Codex provider is not initialised",
      };
    try {
      await this.client.interruptTurn(agent.externalId, run.externalId);
    } catch (error) {
      return {
        commandId: command.commandId,
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    const now = this.context?.now() ?? new Date().toISOString();
    const sourceRevision = this.nextSourceRevision(agent.externalId);
    const cancelledAgent: Agent = {
      ...withoutProgress(agent),
      sourceRevision,
      state: "cancelled",
      requiresAttention: false,
      lastActivityAt: now,
    };
    const cancelledRun: AgentRun = {
      ...run,
      sourceRevision,
      state: "cancelled",
      finishedAt: now,
    };
    this.agents.set(cancelledAgent.id, cancelledAgent);
    this.runs.set(cancelledRun.id, cancelledRun);
    this.activeSessions.delete(agent.externalId);
    this.activeTurns.delete(agent.externalId);
    await this.emitEvent({
      providerId: "codex",
      providerEventId: `command:${command.commandId}:agent`,
      type: "agent.state.changed",
      occurredAt: now,
      agentId: cancelledAgent.id,
      runId: cancelledRun.id,
      payload: { agent: cancelledAgent },
    });
    await this.emitEvent({
      providerId: "codex",
      providerEventId: `command:${command.commandId}:run`,
      type: "run.state.changed",
      occurredAt: now,
      agentId: cancelledAgent.id,
      runId: cancelledRun.id,
      payload: { run: cancelledRun },
    });
    return { commandId: command.commandId, status: "succeeded" };
  }

  async healthCheck(): Promise<ProviderHealth> {
    const now = this.context?.now() ?? new Date().toISOString();
    try {
      await this.client?.version();
      return { status: "healthy", checkedAt: now };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : (this.lastError ?? String(error));
      return { status: "unhealthy", message, checkedAt: now };
    }
  }

  async usage(): Promise<ProviderUsage> {
    const observedAt = this.context?.now() ?? new Date().toISOString();
    try {
      if (!this.client) throw new Error("Codex provider is not initialised");
      return parseCodexUsage(await this.client.readRateLimits(), observedAt);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const normalized = message.toLowerCase();
      return {
        providerId: PROVIDER_ID,
        status:
          normalized.includes("login") ||
          normalized.includes("auth") ||
          normalized.includes("401") ||
          normalized.includes("403")
            ? "login_required"
            : normalized.includes("rate") || normalized.includes("429")
              ? "rate_limited"
              : "error",
        windows: [],
        observedAt,
        message,
      };
    }
  }

  async dispose(): Promise<void> {
    this.emit = undefined;
    this.client?.dispose();
  }

  private async consumeHook(input: HookInput): Promise<void> {
    if (!this.context) return;
    const deduplicationId =
      input.turn_id || input.tool_use_id
        ? this.eventId("hook", input)
        : undefined;
    if (deduplicationId && this.seenHooks.has(deduplicationId)) return;

    const currentTurn = this.activeTurns.get(input.session_id);
    const startsTurn = input.hook_event_name === "UserPromptSubmit";
    if (
      !startsTurn &&
      input.turn_id &&
      currentTurn &&
      input.turn_id !== currentTurn
    ) {
      return;
    }
    if (ACTIVE_HOOK_EVENTS.has(input.hook_event_name))
      this.activeSessions.add(input.session_id);
    if (startsTurn) {
      if (input.turn_id) this.activeTurns.set(input.session_id, input.turn_id);
      else this.activeTurns.delete(input.session_id);
    }

    const now = this.context.now();
    const id = canonicalId(PROVIDER_ID, input.session_id);
    const existing = this.agents.get(id);
    const cwd = resolve(input.cwd);
    const resources = workspaceResourcesForRoots(PROVIDER_ID, [cwd]);
    const project = resources.projects[0]!;
    const workspace = resources.workspace!;
    const pendingQuestion = this.questionToolUses.get(input.session_id);
    const completesQuestion =
      input.hook_event_name === "PostToolUse" &&
      Boolean(input.tool_use_id) &&
      input.tool_use_id === pendingQuestion;
    if (
      input.hook_event_name === "PreToolUse" &&
      isQuestionTool(input) &&
      input.tool_use_id
    )
      this.questionToolUses.set(input.session_id, input.tool_use_id);
    else if (!completesQuestion) this.questionToolUses.delete(input.session_id);

    const state: Agent["state"] =
      input.hook_event_name === "Stop" || input.hook_event_name === "SessionEnd"
        ? agentTerminalState(input)
        : input.hook_event_name === "PreToolUse" && isQuestionTool(input)
          ? "waiting_for_input"
          : input.hook_event_name === "PermissionRequest"
            ? "waiting_for_approval"
            : input.hook_event_name === "UserPromptSubmit" ||
                input.hook_event_name === "PreToolUse" ||
                input.hook_event_name === "PostToolUse"
              ? "running"
              : (existing?.state ?? "idle");
    const terminal =
      input.hook_event_name === "Stop" ||
      input.hook_event_name === "SessionEnd";
    if (!existing && (terminal || state === "idle" || state === "unknown")) {
      if (deduplicationId) this.rememberHook(deduplicationId);
      return;
    }
    const activity =
      input.agent_signal === "question_started"
        ? "waiting"
        : completesQuestion
          ? "working"
          : input.agent_activity;
    const retainTerminalProgress =
      terminal && (state === "recovering" || state === "failed");
    const progress = terminal
      ? retainTerminalProgress
        ? existing?.progress
        : undefined
      : startsTurn
        ? { activity: "working" as const, observedAt: now }
        : activity
          ? {
              activity,
              ...(input.plan_progress
                ? { plan: input.plan_progress }
                : existing?.progress?.plan
                  ? { plan: existing.progress.plan }
                  : {}),
              observedAt: now,
            }
          : existing?.progress;
    const runId = input.turn_id
      ? canonicalId(PROVIDER_ID, `${input.session_id}:${input.turn_id}`)
      : existing?.activeRunId;
    const metadata: Record<string, unknown> = {
      ...existing?.metadata,
      cwd,
      workspaceRoots: [cwd],
    };
    // Codex collaboration mode is distinct from its hook permission mode.
    // request_user_input is Plan-only, so a native question is authoritative
    // Plan evidence even when Codex reports permission_mode as "default".
    if (startsTurn) delete metadata.agentMode;
    const mode = modeFor(input);
    if (mode) metadata.agentMode = mode;
    const sourceRevision = this.nextSourceRevision(input.session_id);
    const agent: Agent = {
      id,
      providerId: PROVIDER_ID,
      externalId: input.session_id,
      title:
        existing?.title ??
        basename(cwd) ??
        `Codex ${input.session_id.slice(-6)}`,
      projectId: project.id,
      workspaceId: workspace.id,
      state,
      activityEpoch:
        runId ??
        (startsTurn
          ? `${input.session_id}:${now}`
          : (existing?.activityEpoch ?? `${input.session_id}:${now}`)),
      ...(runId ? { activeRunId: runId } : {}),
      requiresAttention:
        state === "waiting_for_input" ||
        state === "waiting_for_approval" ||
        state === "ready_for_review" ||
        state === "failed",
      lastActivityAt: now,
      revision: existing?.revision ?? 0,
      sourceRevision,
      ...(progress ? { progress } : {}),
      capabilities: {
        messages: false,
        approvals: false,
        cancellation: true,
        creation: false,
      },
      links: [
        {
          rel: "focus",
          label: "Open in Cursor Codex",
          href: cursorCodexFocusLink(input.session_id, cwd),
        },
      ],
      metadata,
    };
    this.agents.set(id, agent);
    await this.emitEvent({
      providerId: PROVIDER_ID,
      providerEventId: this.eventId("agent", input, sourceRevision),
      type: existing
        ? existing.state === agent.state
          ? "agent.progress.changed"
          : "agent.state.changed"
        : "agent.upserted",
      occurredAt: now,
      agentId: id,
      ...(runId ? { runId } : {}),
      payload: { agent },
    });
    if (runId) {
      const previous = this.runs.get(runId);
      const run: AgentRun = {
        id: runId,
        agentId: id,
        providerId: PROVIDER_ID,
        externalId: input.turn_id ?? previous?.externalId ?? runId,
        state: terminal
          ? runTerminalState(input)
          : state === "waiting_for_input"
            ? "waiting_for_input"
            : state === "waiting_for_approval"
              ? "waiting_for_approval"
              : "running",
        ...(previous?.startedAt
          ? { startedAt: previous.startedAt }
          : { startedAt: now }),
        ...(terminal ? { finishedAt: now } : {}),
        revision: previous?.revision ?? 0,
        sourceRevision,
        metadata: {},
      };
      this.runs.set(runId, run);
      await this.emitEvent({
        providerId: PROVIDER_ID,
        providerEventId: this.eventId("run", input, sourceRevision),
        type: previous ? "run.state.changed" : "run.upserted",
        occurredAt: now,
        agentId: id,
        runId,
        payload: { run },
      });
    }
    if (completesQuestion) this.questionToolUses.delete(input.session_id);
    if (
      (input.hook_event_name === "Stop" ||
        input.hook_event_name === "SessionEnd") &&
      (!currentTurn || !input.turn_id || input.turn_id === currentTurn)
    ) {
      this.activeSessions.delete(input.session_id);
      this.activeTurns.delete(input.session_id);
    }
    if (deduplicationId) this.rememberHook(deduplicationId);
  }

  private eventId(kind: string, input: HookInput, occurrence?: number): string {
    const material = JSON.stringify([
      kind,
      input.hook_event_name,
      input.session_id,
      input.turn_id ?? "",
      input.tool_use_id ?? "",
      input.agent_activity ?? "",
      input.plan_progress?.completed ?? "",
      input.plan_progress?.total ?? "",
      input.permission_mode ?? "",
      input.status ?? "",
      input.final_status ?? "",
      input.reason ?? "",
      input.agent_signal ?? "",
      occurrence ?? "",
    ]);
    return `hook:${createHash("sha256").update(material).digest("base64url")}`;
  }

  private rememberHook(hookId: string): void {
    this.seenHooks.add(hookId);
    if (this.seenHooks.size <= 256) return;
    const oldest = this.seenHooks.values().next().value;
    if (oldest) this.seenHooks.delete(oldest);
  }

  private nextSourceRevision(sessionId: string): number {
    const revision = (this.sourceRevisions.get(sessionId) ?? 0) + 1;
    this.sourceRevisions.set(sessionId, revision);
    return revision;
  }

  private enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async emitEvent(event: ProviderEvent): Promise<void> {
    await this.emit?.(event);
  }
}

export const createProviderPlugin = (): AgentProviderPlugin =>
  new CodexProvider();
