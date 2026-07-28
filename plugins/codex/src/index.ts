import { createHash } from "node:crypto";
import { basename } from "node:path";
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
} from "@agent-deck/domain";
import type {
  AgentProviderPlugin,
  ProviderContext,
  ProviderEventEmitter,
  Unsubscribe,
} from "@agent-deck/provider-sdk";
import { CodexAppServerClient } from "./app-server-client.js";

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
    session_id: z.string(),
    hook_event_name: z.enum([
      "SessionStart",
      "UserPromptSubmit",
      "PermissionRequest",
      "Stop",
      "SessionEnd",
    ]),
    cwd: z.string(),
    turn_id: z.string().optional(),
  })
  .passthrough();

const timestamp = (
  seconds: number | null | undefined,
  fallback: string,
): string => (seconds ? new Date(seconds * 1_000).toISOString() : fallback);

const projectFor = (cwd: string): Project => {
  const externalId = createHash("sha256")
    .update(cwd)
    .digest("base64url")
    .slice(0, 22);
  return {
    id: canonicalId("codex", `project:${externalId}`),
    providerId: "codex",
    externalId,
    name: basename(cwd) || "Codex",
    metadata: {},
  };
};

const mapState = (
  status: z.infer<typeof ThreadSchema>["status"],
  previousState?: Agent["state"],
): Agent["state"] => {
  if (!status) return "unknown";
  if (status.type === "systemError") return "failed";
  if (status.type === "active") {
    return status.activeFlags?.includes("waitingOnApproval")
      ? "waiting_for_approval"
      : "running";
  }
  if (status.type === "idle") return "ready_for_review";
  if (status.type === "notLoaded") return previousState ?? "idle";
  return "unknown";
};

class CodexProvider implements AgentProviderPlugin {
  readonly manifest = {
    id: "codex",
    displayName: "Codex",
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
  private client: CodexAppServerClient | undefined;
  private emit: ProviderEventEmitter | undefined;
  private readonly agents = new Map<string, Agent>();
  private readonly runs = new Map<string, AgentRun>();
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
        await this.consumeHook(parsed.data);
        return { statusCode: 202, body: { accepted: true } };
      },
    });
  }

  async discover(): Promise<ProviderSnapshot> {
    if (!this.context || !this.client)
      throw new Error("Codex provider not initialised");
    const now = this.context.now();
    try {
      const threads = (await this.client.listThreads())
        .map((thread) => ThreadSchema.safeParse(thread))
        .filter((result) => result.success)
        .map((result) => result.data);
      const projects = new Map<string, Project>();
      for (const thread of threads) {
        const agentId = canonicalId("codex", thread.id);
        const existing = this.agents.get(agentId);
        const cwd = thread.cwd ?? "";
        const project = cwd ? projectFor(cwd) : undefined;
        if (project) projects.set(project.id, project);
        const state = mapState(thread.status, existing?.state);
        const discoveredAt = timestamp(thread.updatedAt, now);
        const updatedAt =
          existing && existing.lastActivityAt > discoveredAt
            ? existing.lastActivityAt
            : discoveredAt;
        const activeTurn = thread.turns?.at(-1);
        const discoveredRunId = activeTurn
          ? canonicalId("codex", `${thread.id}:${activeTurn.id}`)
          : undefined;
        const activeRunId =
          thread.status?.type === "notLoaded"
            ? (existing?.activeRunId ?? discoveredRunId)
            : discoveredRunId;
        const agent: Agent = {
          id: agentId,
          providerId: "codex",
          externalId: thread.id,
          title:
            thread.name ??
            (cwd ? basename(cwd) : `Codex ${thread.id.slice(-6)}`),
          ...(project ? { projectId: project.id } : {}),
          state,
          freshness: "fresh",
          ...(activeRunId ? { activeRunId } : {}),
          requiresAttention:
            state === "waiting_for_approval" ||
            state === "waiting_for_input" ||
            state === "ready_for_review" ||
            state === "failed",
          lastActivityAt: updatedAt,
          revision: 0,
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
              label: "Open in Codex",
              href: `codex://threads/${encodeURIComponent(thread.id)}`,
            },
          ],
          metadata: {},
        };
        this.agents.set(agent.id, agent);
        if (activeTurn && activeRunId) {
          const run: AgentRun = {
            id: activeRunId,
            agentId: agent.id,
            providerId: "codex",
            externalId: activeTurn.id,
            state:
              activeTurn.status === "inProgress"
                ? state === "waiting_for_approval"
                  ? "waiting_for_approval"
                  : "running"
                : activeTurn.status === "failed"
                  ? "failed"
                  : activeTurn.status === "interrupted"
                    ? "cancelled"
                    : "succeeded",
            revision: 0,
            metadata: {},
          };
          this.runs.set(run.id, run);
        }
      }
      this.lastError = undefined;
      return {
        complete: true,
        observedAt: now,
        workspaces: [],
        projects: [...projects.values()],
        agents: [...this.agents.values()],
        runs: [...this.runs.values()],
        attention: [],
      };
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
    return {
      commandId: command.commandId,
      status: "unsupported",
      message: "Agent Deck developer preview is observation-only",
    };
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

  private async consumeHook(input: z.infer<typeof HookSchema>): Promise<void> {
    if (!this.context) return;
    const now = this.context.now();
    const id = canonicalId("codex", input.session_id);
    const existing = this.agents.get(id);
    const project = projectFor(input.cwd);
    const state: Agent["state"] =
      input.hook_event_name === "UserPromptSubmit"
        ? "running"
        : input.hook_event_name === "PermissionRequest"
          ? "waiting_for_approval"
          : input.hook_event_name === "Stop"
            ? "ready_for_review"
            : input.hook_event_name === "SessionEnd"
              ? "idle"
              : (existing?.state ?? "idle");
    const runId = input.turn_id
      ? canonicalId("codex", `${input.session_id}:${input.turn_id}`)
      : existing?.activeRunId;
    const agent: Agent = {
      id,
      providerId: "codex",
      externalId: input.session_id,
      title:
        existing?.title ??
        basename(input.cwd) ??
        `Codex ${input.session_id.slice(-6)}`,
      projectId: project.id,
      state,
      freshness: "fresh",
      ...(runId ? { activeRunId: runId } : {}),
      requiresAttention:
        state === "waiting_for_approval" || state === "ready_for_review",
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
          label: "Open in Codex",
          href: `codex://threads/${encodeURIComponent(input.session_id)}`,
        },
      ],
      metadata: {},
    };
    this.agents.set(id, agent);
    await this.emitEvent({
      providerId: "codex",
      providerEventId: `hook:${input.hook_event_name}:${input.session_id}:${input.turn_id ?? "session"}:${now}`,
      type: "agent.state.changed",
      occurredAt: now,
      agentId: id,
      ...(runId ? { runId } : {}),
      payload: { agent },
    });
    if (input.turn_id && runId) {
      const previous = this.runs.get(runId);
      const run: AgentRun = {
        id: runId,
        agentId: id,
        providerId: "codex",
        externalId: input.turn_id,
        state:
          state === "running"
            ? "running"
            : state === "waiting_for_approval"
              ? "waiting_for_approval"
              : input.hook_event_name === "Stop"
                ? "succeeded"
                : (previous?.state ?? "unknown"),
        ...(previous?.startedAt
          ? { startedAt: previous.startedAt }
          : input.hook_event_name === "UserPromptSubmit"
            ? { startedAt: now }
            : {}),
        ...(input.hook_event_name === "Stop" ? { finishedAt: now } : {}),
        revision: previous?.revision ?? 0,
        metadata: {},
      };
      this.runs.set(runId, run);
      await this.emitEvent({
        providerId: "codex",
        providerEventId: `hook:run:${input.hook_event_name}:${input.session_id}:${input.turn_id}:${now}`,
        type: "run.state.changed",
        occurredAt: now,
        agentId: id,
        runId,
        payload: { run },
      });
    }
  }

  private async emitEvent(event: ProviderEvent): Promise<void> {
    await this.emit?.(event);
  }
}

export const createProviderPlugin = (): AgentProviderPlugin =>
  new CodexProvider();
