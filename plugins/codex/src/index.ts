import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { z } from "zod";
import {
  canonicalId,
  isActiveAgentState,
  isAgentActiveOrRecent,
  isRunActiveOrRecent,
  workspaceResourcesForRoots,
  type Agent,
  type AgentRun,
  type CommandResult,
  type Project,
  type ProviderCommand,
  type ProviderEvent,
  type ProviderHealth,
  type ProviderSnapshot,
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
const CHECKPOINT_KEY = "registry-v1";

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
    tool_name: z.string().optional(),
    permission_mode: z.string().optional(),
    status: z.string().optional(),
    final_status: z.string().optional(),
    reason: z.string().optional(),
    agent_signal: z.enum(["question_started"]).optional(),
  })
  .strip();

type HookInput = z.infer<typeof HookSchema>;

interface Registry {
  version: 1;
  agents: Agent[];
  runs: AgentRun[];
  activeTurns: Array<[string, string]>;
  sourceRevisions: Array<[string, number]>;
  questionToolUses: Array<[string, string]>;
  seenHooks: string[];
}

const timestamp = (
  seconds: number | null | undefined,
  fallback: string,
): string => (seconds ? new Date(seconds * 1_000).toISOString() : fallback);

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
  const normalized = input.tool_name?.replaceAll(/[-_]/g, "").toLowerCase();
  return (
    input.agent_signal === "question_started" ||
    normalized === "requestuserinput" ||
    normalized === "askquestion"
  );
};

const modeFor = (permissionMode: string | undefined): string | undefined =>
  permissionMode?.trim().toLowerCase() === "plan" ? "plan" : undefined;

class CodexProvider implements AgentProviderPlugin {
  readonly manifest = {
    id: "codex",
    displayName: "Codex",
    version: "0.1.0",
    sdkVersion: 1 as const,
    capabilities: {
      discovery: true,
      liveEvents: true,
      commands: ["cancel"],
    },
  };
  readonly configSchema = ConfigSchema;
  private context: ProviderContext | undefined;
  private client: CodexAppServerClient | undefined;
  private emit: ProviderEventEmitter | undefined;
  private readonly agents = new Map<string, Agent>();
  private readonly runs = new Map<string, AgentRun>();
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
    await this.restore();
    context.registerIngress({
      path: "/hooks",
      handle: async (input) => {
        const parsed = HookSchema.safeParse(input);
        if (!parsed.success)
          return { statusCode: 400, body: { accepted: false } };
        await this.enqueue(() => this.consumeHook(parsed.data));
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
      const previousAgents = new Map(this.agents);
      const threads = (await this.client.listThreads())
        .map((thread) => ThreadSchema.safeParse(thread))
        .filter((result) => result.success)
        .map((result) => result.data);
      const threadIds = new Set(threads.map((thread) => thread.id));
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
        const activeTurn = thread.turns?.at(-1);
        const state = mapState(
          thread.status,
          existing?.state,
          activeTurn?.status,
        );
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
          freshness: "fresh",
          ...(activeRunId ? { activeRunId } : {}),
          requiresAttention:
            state === "waiting_for_approval" ||
            state === "waiting_for_input" ||
            state === "ready_for_review" ||
            state === "failed",
          lastActivityAt: updatedAt,
          revision: existing?.revision ?? 0,
          ...(sourceRevision !== undefined ? { sourceRevision } : {}),
          archived: false,
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
        if (!isAgentActiveOrRecent(agent, now)) continue;
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
          if (activeTurn.status !== "inProgress")
            this.activeTurns.delete(thread.id);
        }
      }
      for (const agent of this.agents.values()) {
        if (
          threadIds.has(agent.externalId) ||
          !isAgentActiveOrRecent(agent, now)
        )
          continue;
        const cwd =
          typeof agent.metadata.cwd === "string" ? agent.metadata.cwd : "";
        if (cwd) {
          const resources = workspaceResourcesForRoots(PROVIDER_ID, [cwd]);
          const project = resources.projects[0];
          const workspace = resources.workspace;
          if (project) projects.set(project.id, project);
          if (workspace) workspaces.set(workspace.id, workspace);
          const groupingChanged =
            agent.projectId !== project?.id ||
            agent.workspaceId !== workspace?.id ||
            !Array.isArray(agent.metadata.workspaceRoots);
          nextAgents.set(
            agent.id,
            groupingChanged
              ? {
                  ...agent,
                  ...(project ? { projectId: project.id } : {}),
                  ...(workspace ? { workspaceId: workspace.id } : {}),
                  sourceRevision: this.nextSourceRevision(agent.externalId),
                  metadata: {
                    ...agent.metadata,
                    workspaceRoots: [cwd],
                  },
                }
              : agent,
          );
        } else {
          nextAgents.set(agent.id, agent);
        }
      }
      for (const run of this.runs.values()) {
        if (
          nextRuns.has(run.id) ||
          !nextAgents.has(run.agentId) ||
          !isRunActiveOrRecent(run, now)
        )
          continue;
        nextRuns.set(run.id, run);
      }
      this.agents.clear();
      for (const [id, agent] of nextAgents) this.agents.set(id, agent);
      this.runs.clear();
      for (const [id, run] of nextRuns) this.runs.set(id, run);
      for (const sessionId of this.activeTurns.keys()) {
        if (!this.agents.has(canonicalId(PROVIDER_ID, sessionId)))
          this.activeTurns.delete(sessionId);
      }
      for (const sessionId of this.questionToolUses.keys()) {
        if (!this.agents.has(canonicalId(PROVIDER_ID, sessionId)))
          this.questionToolUses.delete(sessionId);
      }
      const expiredAgents = [...previousAgents.values()]
        .filter((agent) => !this.agents.has(agent.id))
        .map((agent): Agent => ({
          ...agent,
          freshness: "stale",
          requiresAttention: false,
          sourceRevision: this.nextSourceRevision(agent.externalId),
        }));
      this.lastError = undefined;
      const snapshot = {
        complete: true,
        observedAt: now,
        workspaces: [...workspaces.values()],
        projects: [...projects.values()],
        agents: [...this.agents.values(), ...expiredAgents],
        runs: [...this.runs.values()],
        attention: [],
      };
      await this.persist();
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
      ...agent,
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
    await this.persist();
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

  async dispose(): Promise<void> {
    this.emit = undefined;
    this.client?.dispose();
  }

  private async consumeHook(input: HookInput): Promise<void> {
    if (!this.context) return;
    const hookId = this.eventId("hook", input);
    if (this.seenHooks.has(hookId)) return;

    const currentTurn = this.activeTurns.get(input.session_id);
    const startsTurn = input.hook_event_name === "UserPromptSubmit";
    if (
      !startsTurn &&
      input.turn_id &&
      currentTurn &&
      input.turn_id !== currentTurn
    )
      return;
    if (startsTurn && input.turn_id)
      this.activeTurns.set(input.session_id, input.turn_id);

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
    const runId = input.turn_id
      ? canonicalId(PROVIDER_ID, `${input.session_id}:${input.turn_id}`)
      : existing?.activeRunId;
    const metadata: Record<string, unknown> = {
      ...existing?.metadata,
      cwd,
      workspaceRoots: [cwd],
    };
    if (input.permission_mode !== undefined) {
      const mode = modeFor(input.permission_mode);
      if (mode) metadata.agentMode = mode;
      else delete metadata.agentMode;
    }
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
      freshness: "fresh",
      ...(runId ? { activeRunId: runId } : {}),
      requiresAttention:
        state === "waiting_for_input" ||
        state === "waiting_for_approval" ||
        state === "ready_for_review" ||
        state === "failed",
      lastActivityAt: now,
      revision: existing?.revision ?? 0,
      sourceRevision,
      archived: false,
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
      providerEventId: this.eventId("agent", input),
      type: existing ? "agent.state.changed" : "agent.upserted",
      occurredAt: now,
      agentId: id,
      ...(runId ? { runId } : {}),
      payload: { agent },
    });
    if (runId) {
      const previous = this.runs.get(runId);
      const terminal =
        input.hook_event_name === "Stop" ||
        input.hook_event_name === "SessionEnd";
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
        providerEventId: this.eventId("run", input),
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
      (!input.turn_id || input.turn_id === currentTurn)
    )
      this.activeTurns.delete(input.session_id);
    this.rememberHook(hookId);
    await this.persist();
  }

  private eventId(kind: string, input: HookInput): string {
    const material = JSON.stringify([
      kind,
      input.hook_event_name,
      input.session_id,
      input.turn_id ?? "",
      input.tool_use_id ?? "",
      input.tool_name ?? "",
      input.permission_mode ?? "",
      input.status ?? "",
      input.final_status ?? "",
      input.reason ?? "",
      input.agent_signal ?? "",
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

  private async persist(): Promise<void> {
    if (!this.context) return;
    const registry: Registry = {
      version: 1,
      agents: [...this.agents.values()],
      runs: [...this.runs.values()],
      activeTurns: [...this.activeTurns.entries()],
      sourceRevisions: [...this.sourceRevisions.entries()],
      questionToolUses: [...this.questionToolUses.entries()],
      seenHooks: [...this.seenHooks],
    };
    await this.context.checkpoints.set(
      CHECKPOINT_KEY,
      JSON.stringify(registry),
    );
  }

  private async restore(): Promise<void> {
    if (!this.context) return;
    const raw = await this.context.checkpoints.get(CHECKPOINT_KEY);
    if (!raw) return;
    try {
      const registry = JSON.parse(raw) as Registry;
      if (registry.version !== 1) throw new Error("Unsupported checkpoint");
      for (const agent of registry.agents ?? []) {
        this.agents.set(agent.id, agent);
        if (agent.sourceRevision !== undefined)
          this.sourceRevisions.set(agent.externalId, agent.sourceRevision);
      }
      for (const run of registry.runs ?? []) this.runs.set(run.id, run);
      for (const [session, turn] of registry.activeTurns ?? [])
        this.activeTurns.set(session, turn);
      for (const [session, revision] of registry.sourceRevisions ?? [])
        this.sourceRevisions.set(session, revision);
      for (const [session, toolUse] of registry.questionToolUses ?? [])
        this.questionToolUses.set(session, toolUse);
      for (const hookId of registry.seenHooks ?? []) this.rememberHook(hookId);
    } catch (error) {
      this.context.logger.warn({ error }, "Ignoring invalid Codex checkpoint");
    }
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
