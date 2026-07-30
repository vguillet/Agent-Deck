import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  canonicalId,
  isAgentActiveOrRecent,
  isRunActiveOrRecent,
  normalizedWorkspaceRoots,
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
import { stopCursorConversation } from "./stop.js";

const PROVIDER_ID = "cursor-local";
const CHECKPOINT_KEY = "registry-v1";

const ConfigSchema = z.object({
  stateDatabasePath: z
    .string()
    .default(
      resolve(
        homedir(),
        "Library",
        "Application Support",
        "Cursor",
        "User",
        "globalStorage",
        "state.vscdb",
      ),
    ),
  transcriptsRoot: z
    .string()
    .default(resolve(homedir(), ".cursor", "projects")),
});

const LifecycleHookSchema = z
  .object({
    protocol_version: z.literal(2).optional(),
    hook_event_name: z.enum([
      "sessionStart",
      "beforeSubmitPrompt",
      "preToolUse",
      "postToolUse",
      "postToolUseFailure",
      "stop",
      "sessionEnd",
    ]),
    conversation_id: z.string().min(1),
    generation_id: z.string().min(1).optional(),
    tool_use_id: z.string().min(1).optional(),
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
    agent_signal: z.enum(["question_started"]).optional(),
    workspace_roots: z.array(z.string().min(1)).default([]),
    status: z.string().optional(),
    final_status: z.string().optional(),
    reason: z.string().optional(),
    composer_mode: z.string().optional(),
    cursor_version: z.string().optional(),
    is_background_agent: z.boolean().optional(),
    is_subagent: z.boolean().optional(),
    conversation_kind: z
      .enum(["top_level", "subagent", "background"])
      .optional(),
  })
  .strip();

const SubagentStartHookSchema = z
  .object({
    hook_event_name: z.literal("subagentStart"),
    subagent_id: z.string().min(1),
    parent_conversation_id: z.string().min(1).optional(),
    workspace_roots: z.array(z.string().min(1)).default([]),
  })
  .strip();

const HookSchema = z.discriminatedUnion("hook_event_name", [
  LifecycleHookSchema,
  SubagentStartHookSchema,
]);

type HookInput = z.infer<typeof HookSchema>;
type LifecycleHookInput = z.infer<typeof LifecycleHookSchema>;

interface Registry {
  version?: 2;
  agents: Agent[];
  runs: AgentRun[];
  projects: Project[];
  workspaces: Workspace[];
  activeGenerations: Array<[string, string]>;
  hiddenConversations?: string[];
  conversationKinds?: Array<[string, ConversationKind]>;
  parentConversations?: Array<[string, string]>;
  subagentTranscripts?: Array<[string, string]>;
  sourceRevisions?: Array<[string, number]>;
  pendingHooks?: Array<[string, LifecycleHookInput[]]>;
}

type ConversationKind = "pending" | "top_level" | "subagent" | "background";

interface SubagentReconciliation {
  changed: boolean;
  terminalAgents: Agent[];
}

const agentWorkspaceRoots = (agent: Agent | undefined): string[] => {
  const roots = agent?.metadata.workspaceRoots;
  return Array.isArray(roots)
    ? roots.filter((root): root is string => typeof root === "string")
    : [];
};

const focusLink = (
  conversationId: string,
  workspaceRoots: string[] = [],
): string => {
  const url = new URL("cursor://agent-deck.focus/open");
  url.searchParams.set("conversationId", conversationId);
  for (const root of workspaceRoots) url.searchParams.append("workspace", root);
  return url.href;
};

const terminalStatus = (input: LifecycleHookInput): string =>
  (input.final_status ?? input.status ?? input.reason ?? "").toLowerCase();

const agentTerminalState = (input: LifecycleHookInput): Agent["state"] => {
  const status = terminalStatus(input);
  if (status.includes("error") || status.includes("fail")) return "failed";
  if (status.includes("abort") || status.includes("cancel")) return "cancelled";
  return input.hook_event_name === "stop" ? "ready_for_review" : "idle";
};

const runTerminalState = (input: LifecycleHookInput): AgentRun["state"] => {
  const status = terminalStatus(input);
  if (status.includes("error") || status.includes("fail")) return "failed";
  if (status.includes("abort") || status.includes("cancel")) return "cancelled";
  return "succeeded";
};

const cursorMode = (value: string | undefined): string | undefined => {
  const mode = value?.trim().toLowerCase();
  if (mode === "chat" || mode === "ask") return "ask";
  if (mode === "agent" || mode === "plan" || mode === "debug") return mode;
  return undefined;
};

const withoutProgress = (agent: Agent): Agent => {
  const copy = { ...agent };
  delete copy.progress;
  return copy;
};

const explicitConversationKind = (
  input: LifecycleHookInput,
): ConversationKind | undefined => {
  if (input.conversation_kind) return input.conversation_kind;
  if (input.is_background_agent) return "background";
  if (input.is_subagent) return "subagent";
  if (
    input.hook_event_name === "beforeSubmitPrompt" ||
    input.protocol_version === undefined
  )
    return "top_level";
  return undefined;
};

const agentStateForHook = (
  input: HookInput,
  existingState: Agent["state"] | undefined,
): Agent["state"] => {
  if (
    input.hook_event_name === "stop" ||
    input.hook_event_name === "sessionEnd"
  )
    return agentTerminalState(input);
  if ("agent_signal" in input && input.agent_signal === "question_started")
    return "waiting_for_input";
  if (
    input.hook_event_name === "preToolUse" &&
    input.agent_activity === "waiting"
  )
    return "waiting_for_input";
  if (
    input.hook_event_name === "beforeSubmitPrompt" ||
    input.hook_event_name === "preToolUse" ||
    input.hook_event_name === "postToolUse" ||
    input.hook_event_name === "postToolUseFailure"
  )
    return "running";
  if (input.hook_event_name === "sessionStart") return "idle";
  return existingState ?? "idle";
};

const runStateForHook = (
  input: HookInput,
  agentState: Agent["state"],
): AgentRun["state"] => {
  if (
    input.hook_event_name === "stop" ||
    input.hook_event_name === "sessionEnd"
  )
    return runTerminalState(input);
  if (agentState === "waiting_for_input") return "waiting_for_input";
  if (agentState === "waiting_for_approval") return "waiting_for_approval";
  return "running";
};

class CursorLocalProvider implements AgentProviderPlugin {
  readonly manifest = {
    id: PROVIDER_ID,
    displayName: "Cursor Local",
    version: "0.1.0",
    sdkVersion: 1 as const,
    capabilities: {
      discovery: true,
      discoveryMode: "poll" as const,
      liveEvents: true,
      commands: ["cancel"],
    },
  };
  readonly configSchema = ConfigSchema;
  private context: ProviderContext | undefined;
  private emit: ProviderEventEmitter | undefined;
  private readonly agents = new Map<string, Agent>();
  private readonly runs = new Map<string, AgentRun>();
  private readonly projects = new Map<string, Project>();
  private readonly workspaces = new Map<string, Workspace>();
  private readonly activeGenerations = new Map<string, string>();
  private readonly hiddenConversations = new Set<string>();
  private readonly conversationKinds = new Map<string, ConversationKind>();
  private readonly parentConversations = new Map<string, string>();
  private readonly subagentTranscripts = new Map<string, string>();
  private readonly subagentTranscriptWatchers = new Map<string, FSWatcher>();
  private readonly subagentTranscriptRetryTimers = new Map<
    string,
    NodeJS.Timeout
  >();
  private readonly subagentTranscriptRetryAttempts = new Map<string, number>();
  private readonly subagentTranscriptDebounceTimers = new Map<
    string,
    NodeJS.Timeout
  >();
  private readonly sourceRevisions = new Map<string, number>();
  private readonly pendingHooks = new Map<string, LifecycleHookInput[]>();
  private readonly migrationAgents = new Set<string>();
  private operationQueue: Promise<void> = Promise.resolve();
  private lastProtocolVersion: number | undefined;
  private readonly questionSignalToolUses = new Map<string, string>();
  private stateDatabasePath = "";
  private transcriptsRoot = "";

  async initialise(context: ProviderContext): Promise<void> {
    this.context = context;
    const config = ConfigSchema.parse(context.config);
    this.stateDatabasePath = config.stateDatabasePath;
    this.transcriptsRoot = config.transcriptsRoot;
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
    return this.enqueue(async () => {
      const observedAt = this.context?.now() ?? new Date().toISOString();
      const reconciled = await this.reconcileSubagentTranscripts(observedAt);
      const { changed, expiredAgents } = this.pruneRegistry(observedAt);
      if (reconciled.changed || changed) await this.persist();
      const agents = [...this.agents.values()].filter(
        (agent) =>
          this.conversationKinds.get(agent.externalId) === "top_level" ||
          this.conversationKinds.get(agent.externalId) === "subagent" ||
          this.migrationAgents.has(agent.id),
      );
      this.migrationAgents.clear();
      const agentIds = new Set(agents.map(({ id }) => id));
      return {
        complete: false,
        observedAt,
        workspaces: [...this.workspaces.values()],
        projects: [...this.projects.values()],
        agents: [...agents, ...expiredAgents],
        runs: [...this.runs.values()].filter((run) =>
          agentIds.has(run.agentId),
        ),
        attention: [],
      };
    });
  }

  async subscribe(emit: ProviderEventEmitter): Promise<Unsubscribe> {
    this.emit = emit;
    for (const agent of this.agents.values())
      if (agent.kind === "subagent" && agent.state === "running")
        await this.trackSubagentTranscript(agent.externalId);
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
        message: `Cursor Local does not support ${command.action}`,
      };
    const agent = this.agents.get(command.agentId);
    const run = agent?.activeRunId
      ? this.runs.get(agent.activeRunId)
      : undefined;
    if (!agent || !run || agent.state !== "running")
      return {
        commandId: command.commandId,
        status: "failed",
        message: "Cursor agent is not running",
      };
    try {
      await stopCursorConversation(agent.externalId);
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
    this.activeGenerations.delete(agent.externalId);
    await this.emitEvent({
      providerId: PROVIDER_ID,
      providerEventId: `command:${command.commandId}:agent`,
      type: "agent.state.changed",
      occurredAt: now,
      agentId: cancelledAgent.id,
      runId: cancelledRun.id,
      payload: { agent: cancelledAgent },
    });
    await this.emitEvent({
      providerId: PROVIDER_ID,
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
    return {
      status: "healthy",
      message: `Listening for local Cursor hooks (protocol ${this.lastProtocolVersion ?? "legacy"}, ${this.pendingHooks.size} pending)`,
      checkedAt: this.context?.now() ?? new Date().toISOString(),
    };
  }

  async dispose(): Promise<void> {
    this.emit = undefined;
    for (const watcher of this.subagentTranscriptWatchers.values())
      watcher.close();
    this.subagentTranscriptWatchers.clear();
    for (const timer of this.subagentTranscriptRetryTimers.values())
      clearTimeout(timer);
    this.subagentTranscriptRetryTimers.clear();
    for (const timer of this.subagentTranscriptDebounceTimers.values())
      clearTimeout(timer);
    this.subagentTranscriptDebounceTimers.clear();
  }

  private async consumeHook(input: HookInput): Promise<void> {
    if (!this.context) return;
    if (input.hook_event_name === "subagentStart") {
      this.conversationKinds.set(input.subagent_id, "subagent");
      this.pendingHooks.delete(input.subagent_id);
      if (input.parent_conversation_id)
        this.parentConversations.set(
          input.subagent_id,
          input.parent_conversation_id,
        );
      await this.applyLifecycleHook({
        protocol_version: 2,
        hook_event_name: "preToolUse",
        conversation_id: input.subagent_id,
        agent_activity: "working",
        workspace_roots: input.workspace_roots,
        is_subagent: true,
        conversation_kind: "subagent",
      });
      await this.trackSubagentTranscript(input.subagent_id);
      return;
    }
    this.lastProtocolVersion =
      input.protocol_version ?? this.lastProtocolVersion;
    const explicitKind = explicitConversationKind(input);
    if (explicitKind === "background") {
      this.conversationKinds.set(input.conversation_id, explicitKind);
      this.context.logger.debug(
        { kind: explicitKind, event: input.hook_event_name },
        "Classified non-visible Cursor conversation",
      );
      await this.hideSubagent(input.conversation_id);
      return;
    }
    if (explicitKind === "subagent") {
      this.conversationKinds.set(input.conversation_id, explicitKind);
      await this.applyLifecycleHook(input);
      return;
    }
    const knownKind = this.conversationKinds.get(input.conversation_id);
    if (knownKind === "background") return;
    if (knownKind === "subagent") {
      await this.applyLifecycleHook(input);
      return;
    }
    if (explicitKind === "top_level" && knownKind !== "top_level") {
      this.conversationKinds.set(input.conversation_id, "top_level");
      const pending = this.pendingHooks.get(input.conversation_id) ?? [];
      this.pendingHooks.delete(input.conversation_id);
      for (const buffered of pending) await this.applyLifecycleHook(buffered);
    }
    if (this.conversationKinds.get(input.conversation_id) !== "top_level") {
      this.conversationKinds.set(input.conversation_id, "pending");
      const pending = this.pendingHooks.get(input.conversation_id) ?? [];
      pending.push(input);
      this.pendingHooks.set(input.conversation_id, pending.slice(-32));
      this.context.logger.debug(
        { event: input.hook_event_name, bufferedEvents: pending.length },
        "Quarantined unclassified Cursor conversation",
      );
      await this.persist();
      return;
    }
    await this.applyLifecycleHook(input);
  }

  private async applyLifecycleHook(input: LifecycleHookInput): Promise<void> {
    if (!this.context) return;
    const now = this.context.now();
    const agentId = canonicalId(PROVIDER_ID, input.conversation_id);
    const existing = this.agents.get(agentId);
    const currentGeneration = this.activeGenerations.get(input.conversation_id);
    const startsGeneration = input.hook_event_name === "beforeSubmitPrompt";

    if (
      !startsGeneration &&
      input.generation_id &&
      currentGeneration &&
      input.generation_id !== currentGeneration
    )
      return;

    if (startsGeneration && input.generation_id)
      this.activeGenerations.set(input.conversation_id, input.generation_id);

    const hookRoots = normalizedWorkspaceRoots(input.workspace_roots);
    const roots = hookRoots.length ? hookRoots : agentWorkspaceRoots(existing);
    const resources = workspaceResourcesForRoots(PROVIDER_ID, roots);
    if (resources.workspace)
      this.workspaces.set(resources.workspace.id, resources.workspace);
    for (const project of resources.projects)
      this.projects.set(project.id, project);

    const generation =
      input.generation_id ??
      this.activeGenerations.get(input.conversation_id) ??
      undefined;
    const runId = generation
      ? canonicalId(PROVIDER_ID, `${input.conversation_id}:${generation}`)
      : undefined;
    const terminal =
      input.hook_event_name === "stop" ||
      input.hook_event_name === "sessionEnd";
    const signalledToolUse = this.questionSignalToolUses.get(
      input.conversation_id,
    );
    const completesQuestionSignal =
      Boolean(signalledToolUse) &&
      input.tool_use_id === signalledToolUse &&
      (input.hook_event_name === "postToolUse" ||
        input.hook_event_name === "postToolUseFailure");
    if (input.agent_signal === "question_started" && input.tool_use_id)
      this.questionSignalToolUses.set(input.conversation_id, input.tool_use_id);
    else if (!completesQuestionSignal)
      this.questionSignalToolUses.delete(input.conversation_id);
    const state = completesQuestionSignal
      ? "waiting_for_input"
      : agentStateForHook(input, existing?.state);
    const primaryProject = resources.projects[0];
    const projectId = primaryProject?.id ?? existing?.projectId;
    const workspaceId = resources.workspace?.id ?? existing?.workspaceId;
    const kind =
      this.conversationKinds.get(input.conversation_id) === "subagent"
        ? "subagent"
        : "top_level";
    const parentConversationId = this.parentConversations.get(
      input.conversation_id,
    );
    const sourceRevision = this.nextSourceRevision(input.conversation_id);
    const activity =
      input.agent_signal === "question_started"
        ? "waiting"
        : input.agent_activity;
    const progress = terminal
      ? undefined
      : startsGeneration
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
    const metadata: Record<string, unknown> = {
      ...existing?.metadata,
    };
    if (input.composer_mode !== undefined) {
      const mode = cursorMode(input.composer_mode);
      if (mode) {
        metadata.agentMode = mode;
        metadata.cursorMode = mode;
      } else {
        delete metadata.agentMode;
        delete metadata.cursorMode;
      }
    }
    if (roots.length) metadata.workspaceRoots = roots;
    const agent: Agent = {
      id: agentId,
      providerId: PROVIDER_ID,
      externalId: input.conversation_id,
      title: this.conversationTitle(input.conversation_id),
      kind,
      ...(parentConversationId
        ? { parentAgentId: canonicalId(PROVIDER_ID, parentConversationId) }
        : {}),
      ...(projectId ? { projectId } : {}),
      ...(workspaceId ? { workspaceId } : {}),
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
      ...(progress ? { progress } : {}),
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
          label: "Open in Cursor",
          href: focusLink(input.conversation_id, roots),
        },
      ],
      metadata,
    };
    this.agents.set(agent.id, agent);

    await this.emitEvent({
      providerId: PROVIDER_ID,
      providerEventId: this.eventId("agent", input),
      type: existing
        ? existing.state === agent.state
          ? "agent.progress.changed"
          : "agent.state.changed"
        : "agent.upserted",
      occurredAt: now,
      agentId,
      ...(runId ? { runId } : {}),
      payload: { agent },
    });

    if (generation && runId) {
      const previous = this.runs.get(runId);
      const runState = runStateForHook(input, state);
      const run: AgentRun = {
        id: runId,
        agentId,
        providerId: PROVIDER_ID,
        externalId: generation,
        state: runState,
        ...(previous?.startedAt
          ? { startedAt: previous.startedAt }
          : { startedAt: now }),
        ...(terminal ? { finishedAt: now } : {}),
        revision: previous?.revision ?? 0,
        sourceRevision,
        metadata: {},
      };
      this.runs.set(run.id, run);
      await this.emitEvent({
        providerId: PROVIDER_ID,
        providerEventId: this.eventId("run", input),
        type: previous ? "run.state.changed" : "run.upserted",
        occurredAt: now,
        agentId,
        runId,
        payload: { run },
      });
    }

    if (terminal && generation === currentGeneration)
      this.activeGenerations.delete(input.conversation_id);
    await this.persist();
  }

  private async hideSubagent(conversationId: string): Promise<void> {
    if (!this.context) return;
    this.pendingHooks.delete(conversationId);
    this.activeGenerations.delete(conversationId);
    const agentId = canonicalId(PROVIDER_ID, conversationId);
    const existing = this.agents.get(agentId);
    if (existing && !existing.archived) {
      const sourceRevision = this.nextSourceRevision(conversationId);
      const agent: Agent = {
        ...withoutProgress(existing),
        sourceRevision,
        archived: true,
        requiresAttention: false,
        lastActivityAt: this.context.now(),
      };
      this.agents.set(agentId, agent);
      await this.emitEvent({
        providerId: PROVIDER_ID,
        providerEventId: `hook:subagent:${conversationId}`,
        type: "agent.state.changed",
        occurredAt: agent.lastActivityAt,
        agentId,
        ...(agent.activeRunId ? { runId: agent.activeRunId } : {}),
        payload: { agent },
      });
    }
    await this.persist();
  }

  private eventId(kind: string, input: LifecycleHookInput): string {
    const material = JSON.stringify([
      kind,
      input.hook_event_name,
      input.conversation_id,
      input.generation_id ?? "",
      input.tool_use_id ?? "",
      input.agent_activity ?? "",
      input.plan_progress?.completed ?? "",
      input.plan_progress?.total ?? "",
      input.agent_signal ?? "",
      input.status ?? "",
      input.final_status ?? "",
      input.reason ?? "",
      input.composer_mode ?? "",
    ]);
    return `hook:${createHash("sha256").update(material).digest("base64url")}`;
  }

  private async emitEvent(event: ProviderEvent): Promise<void> {
    await this.emit?.(event);
  }

  private pruneRegistry(now: string): {
    changed: boolean;
    expiredAgents: Agent[];
  } {
    let changed = false;
    const expiredAgents: Agent[] = [];
    for (const [id, agent] of this.agents) {
      if (isAgentActiveOrRecent(agent, now)) continue;
      if (this.conversationKinds.get(agent.externalId) === "top_level")
        expiredAgents.push({
          ...withoutProgress(agent),
          freshness: "stale",
          requiresAttention: false,
          sourceRevision: this.nextSourceRevision(agent.externalId),
        });
      this.agents.delete(id);
      this.activeGenerations.delete(agent.externalId);
      this.questionSignalToolUses.delete(agent.externalId);
      changed = true;
    }
    for (const [id, run] of this.runs) {
      if (this.agents.has(run.agentId) && isRunActiveOrRecent(run, now))
        continue;
      this.runs.delete(id);
      changed = true;
    }
    const workspaceIds = new Set(
      [...this.agents.values()].flatMap((agent) =>
        agent.workspaceId ? [agent.workspaceId] : [],
      ),
    );
    const projectIds = new Set(
      [...this.agents.values()].flatMap((agent) =>
        agent.projectId ? [agent.projectId] : [],
      ),
    );
    for (const [id, project] of this.projects) {
      if (
        projectIds.has(id) ||
        (project.workspaceId && workspaceIds.has(project.workspaceId))
      )
        continue;
      this.projects.delete(id);
      changed = true;
    }
    for (const project of this.projects.values()) {
      if (project.workspaceId) workspaceIds.add(project.workspaceId);
    }
    for (const id of this.workspaces.keys()) {
      if (workspaceIds.has(id)) continue;
      this.workspaces.delete(id);
      changed = true;
    }
    return { changed, expiredAgents };
  }

  private async persist(): Promise<void> {
    if (!this.context) return;
    const registry: Registry = {
      version: 2,
      agents: [...this.agents.values()],
      runs: [...this.runs.values()],
      projects: [...this.projects.values()],
      workspaces: [...this.workspaces.values()],
      activeGenerations: [...this.activeGenerations.entries()],
      hiddenConversations: [...this.hiddenConversations],
      conversationKinds: [...this.conversationKinds.entries()],
      parentConversations: [...this.parentConversations.entries()],
      subagentTranscripts: [...this.subagentTranscripts.entries()],
      sourceRevisions: [...this.sourceRevisions.entries()],
      pendingHooks: [...this.pendingHooks.entries()],
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
      const transcriptSubagents = await this.transcriptSubagentIds();
      for (const agent of registry.agents ?? [])
        this.agents.set(agent.id, {
          ...agent,
          title: this.conversationTitle(agent.externalId),
          capabilities: {
            ...agent.capabilities,
            cancellation: true,
          },
        });
      for (const run of registry.runs ?? []) this.runs.set(run.id, run);
      for (const project of registry.projects ?? [])
        this.projects.set(project.id, project);
      for (const workspace of registry.workspaces ?? [])
        this.workspaces.set(workspace.id, workspace);
      for (const [conversation, generation] of registry.activeGenerations ?? [])
        this.activeGenerations.set(conversation, generation);
      for (const conversation of registry.hiddenConversations ?? [])
        this.hiddenConversations.add(conversation);
      for (const conversation of transcriptSubagents)
        this.hiddenConversations.add(conversation);
      for (const [conversation, kind] of registry.conversationKinds ?? [])
        this.conversationKinds.set(conversation, kind);
      for (const conversation of this.hiddenConversations)
        if (!this.conversationKinds.has(conversation))
          this.conversationKinds.set(conversation, "subagent");
      for (const conversation of transcriptSubagents)
        this.conversationKinds.set(conversation, "subagent");
      for (const [conversation, parent] of registry.parentConversations ?? [])
        this.parentConversations.set(conversation, parent);
      for (const [conversation, transcript] of registry.subagentTranscripts ??
        [])
        this.subagentTranscripts.set(conversation, transcript);
      for (const agent of this.agents.values()) {
        if (!this.conversationKinds.has(agent.externalId))
          this.conversationKinds.set(agent.externalId, "top_level");
        if (agent.sourceRevision !== undefined)
          this.sourceRevisions.set(agent.externalId, agent.sourceRevision);
      }
      for (const [conversation, revision] of registry.sourceRevisions ?? [])
        this.sourceRevisions.set(conversation, revision);
      for (const [conversation, hooks] of registry.pendingHooks ?? [])
        this.pendingHooks.set(conversation, hooks.slice(-32));
      for (const [id, agent] of this.agents) {
        const kind = this.conversationKinds.get(agent.externalId);
        if (kind === "background" && !agent.archived) {
          const migrated = {
            ...agent,
            sourceRevision: this.nextSourceRevision(agent.externalId),
            archived: true,
            requiresAttention: false,
          };
          this.agents.set(id, migrated);
          this.migrationAgents.add(id);
        }
      }
      const pruned = this.pruneRegistry(this.context.now()).changed;
      let markedStale = false;
      for (const [id, agent] of this.agents) {
        if (agent.freshness === "stale" && !agent.requiresAttention) continue;
        this.agents.set(id, {
          ...withoutProgress(agent),
          freshness: "stale",
          requiresAttention: false,
          sourceRevision: this.nextSourceRevision(agent.externalId),
        });
        markedStale = true;
      }
      const repairedResources = this.repairWorkspaceResources();
      const repairedTargets = this.backfillWorkspaceTargets();
      if (pruned || markedStale || repairedResources || repairedTargets)
        await this.persist();
    } catch (error) {
      this.context.logger.warn(
        { error },
        "Ignoring invalid Cursor local checkpoint",
      );
    }
  }

  private repairWorkspaceResources(): boolean {
    let changed = false;
    for (const [id, agent] of this.agents) {
      const resources = workspaceResourcesForRoots(
        PROVIDER_ID,
        agentWorkspaceRoots(agent),
      );
      if (!resources.workspace) continue;
      const workspace = resources.workspace;
      if (!this.workspaces.has(workspace.id)) {
        this.workspaces.set(workspace.id, workspace);
        changed = true;
      }
      for (const project of resources.projects) {
        if (this.projects.has(project.id)) continue;
        this.projects.set(project.id, project);
        changed = true;
      }
      const projectId = resources.projects[0]?.id;
      if (
        agent.workspaceId !== workspace.id ||
        (projectId && agent.projectId !== projectId)
      ) {
        this.agents.set(id, {
          ...agent,
          workspaceId: workspace.id,
          ...(projectId ? { projectId } : {}),
        });
        changed = true;
      }
    }
    return changed;
  }

  private backfillWorkspaceTargets(): boolean {
    let changed = false;
    for (const [id, agent] of this.agents) {
      const storedRoots = agent.workspaceId
        ? this.workspaces.get(agent.workspaceId)?.metadata.roots
        : undefined;
      const existingRoots = agentWorkspaceRoots(agent);
      const roots = existingRoots.length
        ? existingRoots
        : Array.isArray(storedRoots)
          ? storedRoots.filter(
              (root): root is string => typeof root === "string",
            )
          : [];
      if (!roots.length) continue;
      const targetHref = focusLink(agent.externalId, roots);
      const currentFocus = agent.links.find((link) => link.rel === "focus");
      if (
        existingRoots.join("\0") === roots.join("\0") &&
        currentFocus?.href === targetHref
      )
        continue;
      this.agents.set(id, {
        ...agent,
        sourceRevision: this.nextSourceRevision(agent.externalId),
        links: agent.links.map((link) =>
          link.rel === "focus" ? { ...link, href: targetHref } : link,
        ),
        metadata: { ...agent.metadata, workspaceRoots: roots },
      });
      this.migrationAgents.add(id);
      changed = true;
    }
    return changed;
  }

  private nextSourceRevision(conversationId: string): number {
    const revision = (this.sourceRevisions.get(conversationId) ?? 0) + 1;
    this.sourceRevisions.set(conversationId, revision);
    return revision;
  }

  private async reconcileSubagentTranscripts(
    observedAt: string,
  ): Promise<SubagentReconciliation> {
    let changed = await this.assignMissingSubagentTranscripts();
    const terminalAgents: Agent[] = [];
    for (const agent of this.agents.values()) {
      const terminalAgent = await this.finishSubagentFromTranscript(
        agent,
        observedAt,
      );
      if (!terminalAgent) continue;
      terminalAgents.push(terminalAgent);
      changed = true;
    }
    return { changed, terminalAgents };
  }

  private async finishSubagentFromTranscript(
    agent: Agent,
    observedAt: string,
  ): Promise<Agent | undefined> {
    if (
      agent.kind !== "subagent" ||
      agent.state !== "running" ||
      agent.archived
    )
      return undefined;
    const transcript = this.subagentTranscripts.get(agent.externalId);
    if (!transcript) return undefined;
    const terminal = await this.subagentTranscriptTerminal(transcript);
    if (!terminal) return undefined;

    const sourceRevision = this.nextSourceRevision(agent.externalId);
    const finishedAt = terminal.finishedAt || observedAt;
    const terminalAgent: Agent = {
      ...withoutProgress(agent),
      state: terminal.status === "error" ? "failed" : "ready_for_review",
      requiresAttention: false,
      lastActivityAt: finishedAt,
      sourceRevision,
    };
    this.agents.set(agent.id, terminalAgent);
    const run = agent.activeRunId
      ? this.runs.get(agent.activeRunId)
      : undefined;
    if (run)
      this.runs.set(run.id, {
        ...run,
        state: terminal.status === "error" ? "failed" : "succeeded",
        finishedAt,
        sourceRevision,
      });
    this.activeGenerations.delete(agent.externalId);
    this.stopSubagentTranscriptTracking(agent.externalId);
    return terminalAgent;
  }

  private async reconcileAndPublishSubagentTranscripts(): Promise<void> {
    const observedAt = this.context?.now() ?? new Date().toISOString();
    const reconciliation = await this.reconcileSubagentTranscripts(observedAt);
    if (reconciliation.changed) await this.persist();
    for (const agent of reconciliation.terminalAgents)
      await this.emitEvent({
        providerId: PROVIDER_ID,
        providerEventId: `transcript:terminal:${agent.externalId}:${agent.sourceRevision ?? 0}`,
        type: "agent.state.changed",
        occurredAt: agent.lastActivityAt,
        agentId: agent.id,
        ...(agent.activeRunId ? { runId: agent.activeRunId } : {}),
        payload: { agent },
      });
  }

  private async trackSubagentTranscript(conversationId: string): Promise<void> {
    await this.assignMissingSubagentTranscripts();
    const transcript = this.subagentTranscripts.get(conversationId);
    if (!transcript) {
      this.scheduleSubagentTranscriptRetry(conversationId);
      return;
    }
    this.subagentTranscriptRetryAttempts.delete(conversationId);
    const retry = this.subagentTranscriptRetryTimers.get(conversationId);
    if (retry) clearTimeout(retry);
    this.subagentTranscriptRetryTimers.delete(conversationId);
    if (this.subagentTranscriptWatchers.has(conversationId)) return;
    try {
      const watcher = watch(transcript, { persistent: false }, () => {
        this.scheduleSubagentTranscriptReconciliation(conversationId);
      });
      watcher.on("error", () => {
        this.stopSubagentTranscriptTracking(conversationId);
      });
      this.subagentTranscriptWatchers.set(conversationId, watcher);
      await this.reconcileAndPublishSubagentTranscripts();
    } catch {
      this.scheduleSubagentTranscriptRetry(conversationId);
    }
  }

  private scheduleSubagentTranscriptRetry(conversationId: string): void {
    if (this.subagentTranscriptRetryTimers.has(conversationId)) return;
    const attempt =
      (this.subagentTranscriptRetryAttempts.get(conversationId) ?? 0) + 1;
    if (attempt > 50) {
      this.subagentTranscriptRetryAttempts.delete(conversationId);
      return;
    }
    this.subagentTranscriptRetryAttempts.set(conversationId, attempt);
    const timer = setTimeout(() => {
      this.subagentTranscriptRetryTimers.delete(conversationId);
      void this.enqueue(() => this.trackSubagentTranscript(conversationId));
    }, 100);
    timer.unref();
    this.subagentTranscriptRetryTimers.set(conversationId, timer);
  }

  private scheduleSubagentTranscriptReconciliation(
    conversationId: string,
  ): void {
    const current = this.subagentTranscriptDebounceTimers.get(conversationId);
    if (current) clearTimeout(current);
    const timer = setTimeout(() => {
      this.subagentTranscriptDebounceTimers.delete(conversationId);
      void this.enqueue(() => this.reconcileAndPublishSubagentTranscripts());
    }, 25);
    timer.unref();
    this.subagentTranscriptDebounceTimers.set(conversationId, timer);
  }

  private stopSubagentTranscriptTracking(conversationId: string): void {
    this.subagentTranscriptWatchers.get(conversationId)?.close();
    this.subagentTranscriptWatchers.delete(conversationId);
    const retry = this.subagentTranscriptRetryTimers.get(conversationId);
    if (retry) clearTimeout(retry);
    this.subagentTranscriptRetryTimers.delete(conversationId);
    this.subagentTranscriptRetryAttempts.delete(conversationId);
    const debounce = this.subagentTranscriptDebounceTimers.get(conversationId);
    if (debounce) clearTimeout(debounce);
    this.subagentTranscriptDebounceTimers.delete(conversationId);
  }

  private async assignMissingSubagentTranscripts(): Promise<boolean> {
    if (!this.transcriptsRoot) return false;
    const unassigned = [...this.agents.values()]
      .filter(
        (agent) =>
          agent.kind === "subagent" &&
          agent.state === "running" &&
          !this.subagentTranscripts.has(agent.externalId) &&
          this.parentConversations.has(agent.externalId),
      )
      .sort((left, right) =>
        right.lastActivityAt.localeCompare(left.lastActivityAt),
      );
    if (!unassigned.length) return false;

    try {
      const entries = await readdir(this.transcriptsRoot, { recursive: true });
      const claimed = new Set(this.subagentTranscripts.values());
      const candidates = await Promise.all(
        entries.flatMap((entry) => {
          const normalized = entry.replaceAll("\\", "/");
          const segments = normalized.split("/");
          const subagentsIndex = segments.lastIndexOf("subagents");
          if (
            subagentsIndex < 1 ||
            !normalized.endsWith(".jsonl") ||
            claimed.has(resolve(this.transcriptsRoot, entry))
          )
            return [];
          const path = resolve(this.transcriptsRoot, entry);
          return [
            stat(path).then((details) => ({
              path,
              parentConversationId: segments[subagentsIndex - 1]!,
              createdAt:
                details.birthtimeMs > 0 ? details.birthtimeMs : details.mtimeMs,
            })),
          ];
        }),
      );
      candidates.sort((left, right) => right.createdAt - left.createdAt);

      let changed = false;
      for (const agent of unassigned) {
        const parent = this.parentConversations.get(agent.externalId);
        const candidateIndex = candidates.findIndex(
          (candidate) => candidate.parentConversationId === parent,
        );
        if (candidateIndex < 0) continue;
        const [candidate] = candidates.splice(candidateIndex, 1);
        this.subagentTranscripts.set(agent.externalId, candidate!.path);
        changed = true;
      }
      return changed;
    } catch {
      return false;
    }
  }

  private async subagentTranscriptTerminal(
    path: string,
  ): Promise<{ status: "success" | "error"; finishedAt: string } | undefined> {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const details = await stat(path);
      const length = Math.min(details.size, 64 * 1_024);
      if (!length) return undefined;
      file = await open(path, "r");
      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, details.size - length);
      const lines = buffer.toString("utf8").trimEnd().split("\n");
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
          const record = JSON.parse(lines[index]!) as {
            type?: unknown;
            status?: unknown;
          };
          if (
            record.type === "turn_ended" &&
            (record.status === "success" || record.status === "error")
          )
            return {
              status: record.status,
              finishedAt: details.mtime.toISOString(),
            };
        } catch {
          // A partial first line is expected when reading only the file tail.
        }
      }
      return undefined;
    } catch {
      return undefined;
    } finally {
      await file?.close();
    }
  }

  private async transcriptSubagentIds(): Promise<Set<string>> {
    if (!this.transcriptsRoot) return new Set();
    try {
      const entries = await readdir(this.transcriptsRoot, { recursive: true });
      return new Set(
        entries.flatMap((entry) => {
          const normalized = entry.replaceAll("\\", "/");
          return normalized.includes("/subagents/") &&
            normalized.endsWith(".jsonl")
            ? [basename(normalized, ".jsonl")]
            : [];
        }),
      );
    } catch {
      return new Set();
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

  private conversationTitle(conversationId: string): string {
    const fallback = `Cursor ${conversationId.slice(-6)}`;
    if (!this.stateDatabasePath) return fallback;
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(this.stateDatabasePath, {
        readOnly: true,
      });
      const row = database
        .prepare("SELECT value FROM composerHeaders WHERE composerId = ?")
        .get(conversationId) as { value?: unknown } | undefined;
      if (typeof row?.value !== "string") return fallback;
      const header = JSON.parse(row.value) as { name?: unknown };
      return typeof header.name === "string" && header.name.trim()
        ? header.name.trim()
        : fallback;
    } catch {
      return fallback;
    } finally {
      database?.close();
    }
  }
}

export const createProviderPlugin = (): AgentProviderPlugin =>
  new CursorLocalProvider();
