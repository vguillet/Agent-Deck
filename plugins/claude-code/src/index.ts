import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { z } from "zod";
import {
  canonicalId,
  normalizedWorkspaceRoots,
  workspaceResourcesForRoots,
  type Agent,
  type AgentProgressActivity,
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

const PROVIDER_ID = "claude-code";
const ConfigSchema = z.object({});
const CHECKPOINT_KEY = "usage-v1";

const HookSchema = z
  .object({
    protocol_version: z.literal(1),
    session_id: z.string().min(1),
    hook_event_name: z.enum([
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PermissionRequest",
      "PostToolUse",
      "PostToolUseFailure",
      "Notification",
      "SubagentStart",
      "SubagentStop",
      "TaskCreated",
      "TaskCompleted",
      "Stop",
      "StopFailure",
      "SessionEnd",
    ]),
    cwd: z.string().min(1),
    prompt_id: z.string().optional(),
    tool_use_id: z.string().optional(),
    agent_id: z.string().optional(),
    agent_type: z.string().optional(),
    permission_mode: z.string().optional(),
    notification_type: z.string().optional(),
    task_id: z.string().optional(),
    status: z.string().optional(),
    reason: z.string().optional(),
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
    agent_signal: z.literal("question_started").optional(),
  })
  .strip();

const StatusSchema = z
  .object({
    protocol_version: z.literal(1),
    session_id: z.string().min(1),
    session_name: z.string().optional(),
    workspace_roots: z.array(z.string().min(1)).min(1).max(32),
    usage: z.object({
      providerId: z.literal(PROVIDER_ID),
      status: z.enum([
        "available",
        "login_required",
        "rate_limited",
        "unavailable",
        "error",
      ]),
      windows: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          usedPercent: z.number().finite(),
          available: z.boolean().optional(),
          resetsAt: z.string().optional(),
        }),
      ),
      observedAt: z.string(),
      message: z.string().optional(),
    }),
  })
  .strip();

type HookInput = z.infer<typeof HookSchema>;
type StatusInput = z.infer<typeof StatusSchema>;

const providerUsage = (input: StatusInput["usage"]): ProviderUsage => ({
  providerId: input.providerId,
  status: input.status,
  windows: input.windows.map((window) => ({
    id: window.id,
    label: window.label,
    usedPercent: window.usedPercent,
    ...(window.available === undefined ? {} : { available: window.available }),
    ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
  })),
  observedAt: input.observedAt,
  ...(input.message ? { message: input.message } : {}),
});

const terminalText = (input: HookInput): string =>
  `${input.status ?? ""} ${input.reason ?? ""}`.toLowerCase();

const terminalState = (input: HookInput): Agent["state"] => {
  const text = terminalText(input);
  if (
    input.hook_event_name === "StopFailure" ||
    text.includes("error") ||
    text.includes("fail")
  )
    return "failed";
  if (text.includes("abort") || text.includes("cancel")) return "cancelled";
  return input.agent_id ? "idle" : "ready_for_review";
};

const runTerminalState = (input: HookInput): AgentRun["state"] => {
  const state = terminalState(input);
  return state === "failed"
    ? "failed"
    : state === "cancelled"
      ? "cancelled"
      : "succeeded";
};

const eventState = (
  input: HookInput,
  previous: Agent["state"] | undefined,
): Agent["state"] => {
  if (
    input.hook_event_name === "Stop" ||
    input.hook_event_name === "StopFailure" ||
    input.hook_event_name === "SessionEnd" ||
    input.hook_event_name === "SubagentStop"
  )
    return terminalState(input);
  if (
    input.hook_event_name === "PermissionRequest" ||
    (input.hook_event_name === "Notification" &&
      input.notification_type === "permission_prompt")
  )
    return "waiting_for_approval";
  if (
    input.agent_signal === "question_started" ||
    (input.hook_event_name === "Notification" &&
      input.notification_type === "agent_needs_input")
  )
    return "waiting_for_input";
  if (input.hook_event_name === "SessionStart") return previous ?? "idle";
  return "running";
};

const withoutProgress = (agent: Agent): Agent => {
  const copy = { ...agent };
  delete copy.progress;
  return copy;
};

class ClaudeCodeProvider implements AgentProviderPlugin {
  readonly manifest = {
    id: PROVIDER_ID,
    displayName: "Claude Code",
    version: "0.1.0",
    sdkVersion: 2 as const,
    capabilities: {
      discovery: true,
      discoveryMode: "poll" as const,
      liveEvents: true,
      commands: [],
      usage: true,
    },
  };
  readonly configSchema = ConfigSchema;
  private context: ProviderContext | undefined;
  private emit: ProviderEventEmitter | undefined;
  private readonly agents = new Map<string, Agent>();
  private readonly runs = new Map<string, AgentRun>();
  private readonly projects = new Map<string, Project>();
  private readonly workspaces = new Map<string, Workspace>();
  private readonly sourceRevisions = new Map<string, number>();
  private readonly taskIds = new Map<string, Set<string>>();
  private readonly completedTaskIds = new Map<string, Set<string>>();
  private readonly names = new Map<string, string>();
  private readonly roots = new Map<string, string[]>();
  private latestUsage: ProviderUsage | undefined;
  private operationQueue: Promise<void> = Promise.resolve();

  async initialise(context: ProviderContext): Promise<void> {
    this.context = context;
    ConfigSchema.parse(context.config);
    const stored = await context.checkpoints.get(CHECKPOINT_KEY);
    if (stored) {
      try {
        const parsed = StatusSchema.shape.usage.safeParse(JSON.parse(stored));
        if (parsed.success) this.latestUsage = providerUsage(parsed.data);
      } catch {
        context.logger.warn(
          {},
          "Ignoring invalid Claude Code usage checkpoint",
        );
      }
    }
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
    context.registerIngress({
      path: "/status",
      handle: async (input) => {
        const parsed = StatusSchema.safeParse(input);
        if (!parsed.success)
          return { statusCode: 400, body: { accepted: false } };
        await this.enqueue(() => this.consumeStatus(parsed.data));
        return { statusCode: 202, body: { accepted: true } };
      },
    });
  }

  async discover(): Promise<ProviderSnapshot> {
    return this.enqueue(() => ({
      reconciliation: "incremental",
      observedAt: this.context?.now() ?? new Date().toISOString(),
      workspaces: [...this.workspaces.values()],
      projects: [...this.projects.values()],
      agents: [...this.agents.values()],
      runs: [...this.runs.values()],
      attention: [],
    }));
  }

  async subscribe(emit: ProviderEventEmitter): Promise<Unsubscribe> {
    this.emit = emit;
    return async () => {
      this.emit = undefined;
    };
  }

  async execute(command: ProviderCommand): Promise<CommandResult> {
    return {
      commandId: command.commandId,
      status: "unsupported",
      message: `Claude Code does not support ${command.action}`,
    };
  }

  async usage(): Promise<ProviderUsage> {
    return (
      this.latestUsage ?? {
        providerId: PROVIDER_ID,
        status: "unavailable",
        windows: [],
        observedAt: this.context?.now() ?? new Date().toISOString(),
        message: "Start a Claude Code session to observe usage limits",
      }
    );
  }

  async healthCheck(): Promise<ProviderHealth> {
    return {
      status: "healthy",
      message: "Listening for Claude Code hooks and status updates",
      checkedAt: this.context?.now() ?? new Date().toISOString(),
    };
  }

  async dispose(): Promise<void> {
    this.emit = undefined;
  }

  private nativeId(input: HookInput): string {
    return input.agent_id
      ? `${input.session_id}:agent:${input.agent_id}`
      : input.session_id;
  }

  private runExternalId(input: HookInput): string | undefined {
    if (input.agent_id) return input.agent_id;
    return input.prompt_id;
  }

  private nextRevision(nativeId: string): number {
    const revision = (this.sourceRevisions.get(nativeId) ?? 0) + 1;
    this.sourceRevisions.set(nativeId, revision);
    return revision;
  }

  private resources(
    sessionId: string,
    cwd: string,
  ): {
    project: Project | undefined;
    workspace: Workspace | undefined;
    roots: string[];
  } {
    const roots = normalizedWorkspaceRoots(
      this.roots.get(sessionId) ?? [resolve(cwd)],
    );
    const resources = workspaceResourcesForRoots(PROVIDER_ID, roots);
    for (const project of resources.projects)
      this.projects.set(project.id, project);
    if (resources.workspace)
      this.workspaces.set(resources.workspace.id, resources.workspace);
    return {
      project: resources.projects[0],
      workspace: resources.workspace,
      roots,
    };
  }

  private async consumeStatus(input: StatusInput): Promise<void> {
    this.latestUsage = providerUsage(input.usage);
    this.names.set(input.session_id, input.session_name ?? "");
    this.roots.set(
      input.session_id,
      normalizedWorkspaceRoots(input.workspace_roots),
    );
    await this.context?.checkpoints.set(
      CHECKPOINT_KEY,
      JSON.stringify(this.latestUsage),
    );
    const agent = this.agents.get(canonicalId(PROVIDER_ID, input.session_id));
    if (!agent || !input.session_name) return;
    const resources = this.resources(
      input.session_id,
      input.workspace_roots[0]!,
    );
    const updated: Agent = {
      ...agent,
      title: input.session_name,
      ...(resources.project ? { projectId: resources.project.id } : {}),
      ...(resources.workspace ? { workspaceId: resources.workspace.id } : {}),
      metadata: { ...agent.metadata, workspaceRoots: resources.roots },
      sourceRevision: this.nextRevision(input.session_id),
    };
    this.agents.set(updated.id, updated);
    await this.publish("agent.progress.changed", updated, undefined, "status");
  }

  private async consumeHook(input: HookInput): Promise<void> {
    if (!this.context) return;
    const now = this.context.now();
    const nativeId = this.nativeId(input);
    const agentId = canonicalId(PROVIDER_ID, nativeId);
    const existing = this.agents.get(agentId);
    const runExternalId = this.runExternalId(input);
    const runId = runExternalId
      ? canonicalId(PROVIDER_ID, `${nativeId}:${runExternalId}`)
      : existing?.activeRunId;
    const activityEpoch =
      runId ?? existing?.activityEpoch ?? `${nativeId}:session`;
    const state = eventState(input, existing?.state);
    const terminal = [
      "Stop",
      "StopFailure",
      "SessionEnd",
      "SubagentStop",
    ].includes(input.hook_event_name);
    if (!existing && terminal) return;
    const resources = this.resources(input.session_id, input.cwd);
    const startsActivity =
      input.hook_event_name === "UserPromptSubmit" ||
      input.hook_event_name === "SubagentStart";
    if (startsActivity) {
      this.taskIds.delete(nativeId);
      this.completedTaskIds.delete(nativeId);
    }
    const taskIds = this.taskIds.get(nativeId) ?? new Set<string>();
    const completedIds =
      this.completedTaskIds.get(nativeId) ?? new Set<string>();
    if (input.hook_event_name === "TaskCreated" && input.task_id)
      taskIds.add(input.task_id);
    if (input.hook_event_name === "TaskCompleted" && input.task_id) {
      taskIds.add(input.task_id);
      completedIds.add(input.task_id);
    }
    this.taskIds.set(nativeId, taskIds);
    this.completedTaskIds.set(nativeId, completedIds);
    const activity: AgentProgressActivity =
      input.hook_event_name === "TaskCreated" ||
      input.hook_event_name === "TaskCompleted"
        ? "planning"
        : (input.agent_activity ??
          (state === "running" ? "working" : "waiting"));
    const progress = terminal
      ? undefined
      : {
          activity,
          ...(taskIds.size
            ? {
                plan: {
                  completed: Math.min(completedIds.size, taskIds.size),
                  total: taskIds.size,
                },
              }
            : !startsActivity && existing?.progress?.plan
              ? { plan: existing.progress.plan }
              : {}),
          observedAt: now,
        };
    const sourceRevision = this.nextRevision(nativeId);
    const title =
      (input.agent_id ? input.agent_type : this.names.get(input.session_id)) ||
      existing?.title ||
      basename(input.cwd) ||
      `Claude ${input.session_id.slice(-6)}`;
    const metadata: Record<string, unknown> = {
      ...existing?.metadata,
      cwd: resolve(input.cwd),
      workspaceRoots: resources.roots,
    };
    if (input.permission_mode)
      metadata.agentMode =
        input.permission_mode.toLowerCase() === "plan" ? "plan" : "agent";
    const agent: Agent = {
      ...(existing ?? {}),
      id: agentId,
      providerId: PROVIDER_ID,
      externalId: nativeId,
      title,
      kind: input.agent_id ? "subagent" : "top_level",
      ...(input.agent_id
        ? { parentAgentId: canonicalId(PROVIDER_ID, input.session_id) }
        : {}),
      ...(resources.project ? { projectId: resources.project.id } : {}),
      ...(resources.workspace ? { workspaceId: resources.workspace.id } : {}),
      state,
      activityEpoch,
      ...(runId ? { activeRunId: runId } : {}),
      requiresAttention:
        !input.agent_id &&
        [
          "waiting_for_input",
          "waiting_for_approval",
          "ready_for_review",
          "failed",
        ].includes(state),
      lastActivityAt: now,
      revision: existing?.revision ?? 0,
      sourceRevision,
      ...(progress ? { progress } : {}),
      capabilities: {
        messages: false,
        approvals: false,
        cancellation: false,
        creation: false,
      },
      links: [
        {
          rel: "focus",
          label: "Open in Cursor Claude Code",
          href: this.focusLink(input.session_id, resources.roots),
        },
      ],
      metadata,
    };
    this.agents.set(agent.id, terminal ? withoutProgress(agent) : agent);
    await this.publish(
      existing
        ? existing.state === state
          ? "agent.progress.changed"
          : "agent.state.changed"
        : "agent.upserted",
      this.agents.get(agent.id)!,
      runId,
      this.eventId(input, "agent", activityEpoch),
    );
    if (runId && runExternalId) {
      const previous = this.runs.get(runId);
      const run: AgentRun = {
        id: runId,
        agentId,
        providerId: PROVIDER_ID,
        externalId: runExternalId,
        state: terminal
          ? runTerminalState(input)
          : state === "waiting_for_input"
            ? "waiting_for_input"
            : state === "waiting_for_approval"
              ? "waiting_for_approval"
              : "running",
        startedAt: previous?.startedAt ?? now,
        ...(terminal ? { finishedAt: now } : {}),
        revision: previous?.revision ?? 0,
        sourceRevision,
        metadata: {},
      };
      this.runs.set(run.id, run);
      await this.emit?.({
        providerId: PROVIDER_ID,
        providerEventId: this.eventId(input, "run", activityEpoch),
        type: previous ? "run.state.changed" : "run.upserted",
        occurredAt: now,
        agentId,
        runId,
        payload: { run },
      });
    }
    if (terminal) {
      this.taskIds.delete(nativeId);
      this.completedTaskIds.delete(nativeId);
    }
  }

  private focusLink(sessionId: string, roots: string[]): string {
    const url = new URL("cursor://agent-deck.focus/claude");
    url.searchParams.set("sessionId", sessionId);
    for (const root of roots) url.searchParams.append("workspace", root);
    return url.href;
  }

  private eventId(
    input: HookInput,
    kind: string,
    activityEpoch: string,
  ): string {
    return `hook:${createHash("sha256")
      .update(
        JSON.stringify([
          kind,
          input.hook_event_name,
          input.session_id,
          input.prompt_id ?? "",
          input.tool_use_id ?? "",
          input.agent_id ?? "",
          input.task_id ?? "",
          input.notification_type ?? "",
          activityEpoch,
        ]),
      )
      .digest("base64url")}`;
  }

  private async publish(
    type: ProviderEvent["type"],
    agent: Agent,
    runId: string | undefined,
    eventId: string,
  ): Promise<void> {
    await this.emit?.({
      providerId: PROVIDER_ID,
      providerEventId: eventId,
      type,
      occurredAt: this.context?.now() ?? new Date().toISOString(),
      agentId: agent.id,
      ...(runId ? { runId } : {}),
      payload: { agent },
    });
  }

  private enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export const createProviderPlugin = (): AgentProviderPlugin =>
  new ClaudeCodeProvider();
