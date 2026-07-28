import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
});

const HookSchema = z
  .object({
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
    workspace_roots: z.array(z.string().min(1)).default([]),
    status: z.string().optional(),
    final_status: z.string().optional(),
    reason: z.string().optional(),
    composer_mode: z.string().optional(),
    cursor_version: z.string().optional(),
  })
  .strip();

type HookInput = z.infer<typeof HookSchema>;

interface Registry {
  agents: Agent[];
  runs: AgentRun[];
  projects: Project[];
  workspaces: Workspace[];
  activeGenerations: Array<[string, string]>;
}

const stableHash = (values: string[]): string =>
  createHash("sha256")
    .update(values.join("\0"))
    .digest("base64url")
    .slice(0, 22);

const normalizedRoots = (roots: string[]): string[] =>
  [...new Set(roots.map((root) => resolve(root)))].sort();

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
    metadata: {},
  };
  const projects = normalized.map((root) => {
    const externalId = stableHash([root]);
    return {
      id: canonicalId(PROVIDER_ID, `project:${externalId}`),
      providerId: PROVIDER_ID,
      externalId,
      workspaceId: workspace.id,
      name: basename(root) || "Cursor",
      metadata: {},
    };
  });
  return { workspace, projects };
};

const terminalStatus = (input: HookInput): string =>
  (input.final_status ?? input.status ?? input.reason ?? "").toLowerCase();

const agentTerminalState = (input: HookInput): Agent["state"] => {
  const status = terminalStatus(input);
  if (status.includes("error") || status.includes("fail")) return "failed";
  if (status.includes("abort") || status.includes("cancel")) return "cancelled";
  return input.hook_event_name === "stop" ? "ready_for_review" : "idle";
};

const runTerminalState = (input: HookInput): AgentRun["state"] => {
  const status = terminalStatus(input);
  if (status.includes("error") || status.includes("fail")) return "failed";
  if (status.includes("abort") || status.includes("cancel")) return "cancelled";
  return "succeeded";
};

class CursorLocalProvider implements AgentProviderPlugin {
  readonly manifest = {
    id: PROVIDER_ID,
    displayName: "Cursor Local",
    version: "0.1.0",
    sdkVersion: 1 as const,
    capabilities: {
      discovery: true,
      liveEvents: true,
      commands: [],
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
  private stateDatabasePath = "";

  async initialise(context: ProviderContext): Promise<void> {
    this.context = context;
    this.stateDatabasePath = ConfigSchema.parse(
      context.config,
    ).stateDatabasePath;
    await this.restore();
    context.registerIngress({
      path: "/hooks",
      handle: async (input) => {
        const parsed = HookSchema.safeParse(input);
        if (!parsed.success)
          return { statusCode: 400, body: { accepted: false } };
        await this.consumeHook(parsed.data);
        return { statusCode: 202, body: { accepted: true } };
      },
    });
  }

  async discover(): Promise<ProviderSnapshot> {
    const observedAt = this.context?.now() ?? new Date().toISOString();
    return {
      // Hook checkpoints are a best-effort registry, not an authoritative
      // catalog of currently live Cursor processes.
      complete: false,
      observedAt,
      workspaces: [...this.workspaces.values()],
      projects: [...this.projects.values()],
      agents: [...this.agents.values()],
      runs: [...this.runs.values()],
      attention: [],
    };
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
      message: "Agent Deck developer preview is observation-only",
    };
  }

  async healthCheck(): Promise<ProviderHealth> {
    return {
      status: "healthy",
      message: "Listening for local Cursor hooks",
      checkedAt: this.context?.now() ?? new Date().toISOString(),
    };
  }

  async dispose(): Promise<void> {
    this.emit = undefined;
  }

  private async consumeHook(input: HookInput): Promise<void> {
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

    const roots = normalizedRoots(input.workspace_roots);
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
    const active =
      startsGeneration ||
      input.hook_event_name === "preToolUse" ||
      input.hook_event_name === "postToolUse" ||
      input.hook_event_name === "postToolUseFailure";
    const state = terminal
      ? agentTerminalState(input)
      : active
        ? "running"
        : input.hook_event_name === "sessionStart"
          ? "idle"
          : (existing?.state ?? "idle");
    const primaryProject = resources.projects[0];
    const projectId = primaryProject?.id ?? existing?.projectId;
    const workspaceId = resources.workspace?.id ?? existing?.workspaceId;
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
      requiresAttention: state === "ready_for_review" || state === "failed",
      lastActivityAt: now,
      revision: existing?.revision ?? 0,
      archived: false,
      capabilities: {
        messages: false,
        approvals: false,
        cancellation: false,
        creation: false,
      },
      links: [
        {
          rel: "focus",
          label: "Open in Cursor",
          href: `cursor://agent-deck.focus/open?conversationId=${encodeURIComponent(input.conversation_id)}`,
        },
      ],
      metadata: {},
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
      const runState: AgentRun["state"] = terminal
        ? runTerminalState(input)
        : "running";
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

  private eventId(kind: string, input: HookInput): string {
    const material = JSON.stringify([
      kind,
      input.hook_event_name,
      input.conversation_id,
      input.generation_id ?? "",
      input.tool_use_id ?? "",
      input.status ?? "",
      input.final_status ?? "",
      input.reason ?? "",
    ]);
    return `hook:${createHash("sha256").update(material).digest("base64url")}`;
  }

  private async emitEvent(event: ProviderEvent): Promise<void> {
    await this.emit?.(event);
  }

  private async persist(): Promise<void> {
    if (!this.context) return;
    const registry: Registry = {
      agents: [...this.agents.values()],
      runs: [...this.runs.values()],
      projects: [...this.projects.values()],
      workspaces: [...this.workspaces.values()],
      activeGenerations: [...this.activeGenerations.entries()],
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
      for (const agent of registry.agents ?? [])
        this.agents.set(agent.id, {
          ...agent,
          title: this.conversationTitle(agent.externalId),
        });
      for (const run of registry.runs ?? []) this.runs.set(run.id, run);
      for (const project of registry.projects ?? [])
        this.projects.set(project.id, project);
      for (const workspace of registry.workspaces ?? [])
        this.workspaces.set(workspace.id, workspace);
      for (const [conversation, generation] of registry.activeGenerations ?? [])
        this.activeGenerations.set(conversation, generation);
    } catch (error) {
      this.context.logger.warn(
        { error },
        "Ignoring invalid Cursor local checkpoint",
      );
    }
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
