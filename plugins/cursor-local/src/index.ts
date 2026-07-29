import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  canonicalId,
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
    tool_name: z.string().min(1).optional(),
    agent_signal: z.enum(["question_started"]).optional(),
    workspace_roots: z.array(z.string().min(1)).default([]),
    status: z.string().optional(),
    final_status: z.string().optional(),
    reason: z.string().optional(),
    composer_mode: z.string().optional(),
    cursor_version: z.string().optional(),
    is_background_agent: z.boolean().optional(),
    is_subagent: z.boolean().optional(),
    conversation_kind: z.enum(["top_level", "background"]).optional(),
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
  sourceRevisions?: Array<[string, number]>;
  pendingHooks?: Array<[string, LifecycleHookInput[]]>;
}

type ConversationKind = "pending" | "top_level" | "subagent" | "background";

interface CursorWorkspaceTarget {
  roots: string[];
  target: string;
}

const stableHash = (values: string[]): string =>
  createHash("sha256")
    .update(values.join("\0"))
    .digest("base64url")
    .slice(0, 22);

const normalizedRoots = (roots: string[]): string[] =>
  [...new Set(roots.map((root) => resolve(root)))].sort();

const agentWorkspaceRoots = (agent: Agent | undefined): string[] => {
  const roots = agent?.metadata.workspaceRoots;
  return Array.isArray(roots)
    ? roots.filter((root): root is string => typeof root === "string")
    : [];
};

const focusLink = (
  conversationId: string,
  workspaceRoot?: string,
  windowTarget?: string,
): string => {
  const url = new URL("cursor://agent-deck.focus/open");
  url.searchParams.set("conversationId", conversationId);
  if (workspaceRoot) url.searchParams.set("workspace", workspaceRoot);
  if (windowTarget && windowTarget !== workspaceRoot)
    url.searchParams.set("window", windowTarget);
  return url.href;
};

const resourcesFor = (
  roots: string[],
): { workspace?: Workspace; projects: Project[] } => {
  const normalized = normalizedRoots(roots);
  if (!normalized.length) return { projects: [] };
  const workspaceExternalId = stableHash(normalized);
  const workspace: Workspace = {
    id: canonicalId(PROVIDER_ID, `workspace:${workspaceExternalId}`),
    providerId: PROVIDER_ID,
    externalId: workspaceExternalId,
    name:
      normalized.length === 1
        ? basename(normalized[0] ?? "") || "Cursor"
        : `${basename(normalized[0] ?? "") || "Cursor"} +${normalized.length - 1}`,
    metadata: { roots: normalized },
  };
  const projects = normalized.map((root) => {
    const externalId = stableHash([root]);
    return {
      id: canonicalId(PROVIDER_ID, `project:${externalId}`),
      providerId: PROVIDER_ID,
      externalId,
      workspaceId: workspace.id,
      name: basename(root) || "Cursor",
      metadata: { root },
    };
  });
  return { workspace, projects };
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

const isQuestionTool = (input: LifecycleHookInput): boolean =>
  input.tool_name?.replaceAll(/[-_]/g, "").toLowerCase() === "askquestion";

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
  if (input.hook_event_name === "preToolUse" && isQuestionTool(input))
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
      discoveryMode: "startup" as const,
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
    return this.enqueue(() => {
      const observedAt = this.context?.now() ?? new Date().toISOString();
      const agents = [...this.agents.values()].filter(
        (agent) =>
          this.conversationKinds.get(agent.externalId) === "top_level" ||
          this.migrationAgents.has(agent.id),
      );
      this.migrationAgents.clear();
      const agentIds = new Set(agents.map(({ id }) => id));
      return {
        complete: false,
        observedAt,
        workspaces: [...this.workspaces.values()],
        projects: [...this.projects.values()],
        agents,
        runs: [...this.runs.values()].filter((run) =>
          agentIds.has(run.agentId),
        ),
        attention: [],
      };
    });
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
  }

  private async consumeHook(input: HookInput): Promise<void> {
    if (!this.context) return;
    if (input.hook_event_name === "subagentStart") {
      this.conversationKinds.set(input.subagent_id, "subagent");
      await this.hideSubagent(input.subagent_id);
      return;
    }
    this.lastProtocolVersion =
      input.protocol_version ?? this.lastProtocolVersion;
    const explicitKind = explicitConversationKind(input);
    if (explicitKind === "background" || explicitKind === "subagent") {
      this.conversationKinds.set(input.conversation_id, explicitKind);
      this.context.logger.debug(
        { kind: explicitKind, event: input.hook_event_name },
        "Classified non-visible Cursor conversation",
      );
      await this.hideSubagent(input.conversation_id);
      return;
    }
    const knownKind = this.conversationKinds.get(input.conversation_id);
    if (knownKind === "background" || knownKind === "subagent") return;
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

    const hookRoots = normalizedRoots(input.workspace_roots);
    const roots = hookRoots.length ? hookRoots : agentWorkspaceRoots(existing);
    const resources = resourcesFor(roots);
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
    const mode = cursorMode(input.composer_mode);
    const windowTarget = this.cursorWindowTarget(roots);
    const sourceRevision = this.nextSourceRevision(input.conversation_id);
    const agent: Agent = {
      id: agentId,
      providerId: PROVIDER_ID,
      externalId: input.conversation_id,
      title: this.conversationTitle(input.conversation_id),
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
          href: focusLink(input.conversation_id, roots[0], windowTarget),
        },
      ],
      metadata: {
        ...existing?.metadata,
        ...(mode ? { cursorMode: mode } : {}),
        ...(roots.length ? { workspaceRoots: roots } : {}),
      },
    };
    this.agents.set(agent.id, agent);

    await this.emitEvent({
      providerId: PROVIDER_ID,
      providerEventId: this.eventId("agent", input),
      type: existing ? "agent.state.changed" : "agent.upserted",
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
    this.hiddenConversations.add(conversationId);
    this.pendingHooks.delete(conversationId);
    this.activeGenerations.delete(conversationId);
    const agentId = canonicalId(PROVIDER_ID, conversationId);
    const existing = this.agents.get(agentId);
    if (existing && !existing.archived) {
      const sourceRevision = this.nextSourceRevision(conversationId);
      const agent: Agent = {
        ...existing,
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
      input.tool_name ?? "",
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
        this.conversationKinds.set(conversation, "subagent");
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
        if ((kind === "subagent" || kind === "background") && !agent.archived) {
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
      if (this.backfillWorkspaceTargets()) await this.persist();
    } catch (error) {
      this.context.logger.warn(
        { error },
        "Ignoring invalid Cursor local checkpoint",
      );
    }
  }

  private backfillWorkspaceTargets(): boolean {
    const knownWorkspaces = this.knownCursorWorkspaces();
    const targetsByWorkspace = new Map(
      knownWorkspaces.map((workspace) => [
        canonicalId(PROVIDER_ID, `workspace:${stableHash(workspace.roots)}`),
        workspace,
      ]),
    );
    const targetsByProject = new Map(
      knownWorkspaces.flatMap((workspace) =>
        workspace.roots.map((root) => [
          canonicalId(PROVIDER_ID, `project:${stableHash([root])}`),
          { roots: [root], target: root } satisfies CursorWorkspaceTarget,
        ]),
      ),
    );
    let changed = false;
    for (const [id, agent] of this.agents) {
      const target =
        (agent.workspaceId
          ? targetsByWorkspace.get(agent.workspaceId)
          : undefined) ??
        (agent.projectId ? targetsByProject.get(agent.projectId) : undefined);
      if (!target) continue;
      const targetHref = focusLink(
        agent.externalId,
        target.roots[0],
        target.target,
      );
      const currentFocus = agent.links.find((link) => link.rel === "focus");
      if (
        agentWorkspaceRoots(agent).join("\0") === target.roots.join("\0") &&
        currentFocus?.href === targetHref
      )
        continue;
      this.agents.set(id, {
        ...agent,
        sourceRevision: this.nextSourceRevision(agent.externalId),
        links: agent.links.map((link) =>
          link.rel === "focus" ? { ...link, href: targetHref } : link,
        ),
        metadata: { ...agent.metadata, workspaceRoots: target.roots },
      });
      this.migrationAgents.add(id);
      changed = true;
    }
    return changed;
  }

  private cursorWindowTarget(roots: string[]): string | undefined {
    const expected = roots.join("\0");
    return this.knownCursorWorkspaces().find(
      (workspace) => workspace.roots.join("\0") === expected,
    )?.target;
  }

  private knownCursorWorkspaces(): CursorWorkspaceTarget[] {
    if (!this.stateDatabasePath) return [];
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(this.stateDatabasePath, { readOnly: true });
      const pathValue = (value: unknown): string | undefined => {
        if (typeof value !== "string" || !value) return;
        try {
          const path = value.startsWith("file:") ? fileURLToPath(value) : value;
          return path.startsWith("/") ? resolve(path) : undefined;
        } catch {
          return undefined;
        }
      };
      const parseRow = (key: string): Record<string, unknown> | undefined => {
        const row = database
          ?.prepare("SELECT value FROM ItemTable WHERE key = ?")
          .get(key) as { value?: unknown } | undefined;
        const json =
          typeof row?.value === "string"
            ? row.value
            : row?.value instanceof Uint8Array
              ? Buffer.from(row.value).toString("utf8")
              : undefined;
        return json ? (JSON.parse(json) as Record<string, unknown>) : undefined;
      };
      const metadata = parseRow("workspaceMetadata.entries") as
        | {
            entries?: Array<{
              folderUri?: unknown;
              configPath?: unknown;
              paths?: Array<{ uri?: { fsPath?: unknown; path?: unknown } }>;
            }>;
          }
        | undefined;
      const workspaces: CursorWorkspaceTarget[] = [];
      for (const entry of metadata?.entries ?? []) {
        const roots = normalizedRoots(
          (entry.paths ?? []).flatMap((path) => {
            const root =
              pathValue(path.uri?.fsPath) ?? pathValue(path.uri?.path);
            return root ? [root] : [];
          }),
        );
        const folder = pathValue(entry.folderUri);
        if (!roots.length && folder) roots.push(folder);
        const config = pathValue(entry.configPath);
        const target =
          roots.length === 1
            ? (folder ?? roots[0])
            : config?.endsWith(".code-workspace")
              ? config
              : undefined;
        if (roots.length && target) workspaces.push({ roots, target });
      }
      return workspaces;
    } catch {
      return [];
    } finally {
      database?.close();
    }
  }

  private nextSourceRevision(conversationId: string): number {
    const revision = (this.sourceRevisions.get(conversationId) ?? 0) + 1;
    this.sourceRevisions.set(conversationId, revision);
    return revision;
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
