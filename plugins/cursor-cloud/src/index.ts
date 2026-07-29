import { Agent, Cursor, type Run, type SDKAgentInfo } from "@cursor/sdk";
import { z } from "zod";
import {
  canonicalId,
  workspaceResourcesForProjects,
  type Agent as CanonicalAgent,
  type AgentRun,
  type CommandResult,
  type Project,
  type ProviderCommand,
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

const ConfigSchema = z
  .object({
    apiKeyEnv: z.string().default("CURSOR_API_KEY"),
    includeArchived: z.boolean().default(false),
  })
  .default({ apiKeyEnv: "CURSOR_API_KEY", includeArchived: false });

const runtimeAgent = (
  info: SDKAgentInfo,
): info is SDKAgentInfo & {
  runtime: "cloud";
  repos?: string[];
  env?: { type: "cloud" | "pool" | "machine"; name?: string };
} => info.runtime === "cloud";

const runState = (status: Run["status"]): AgentRun["state"] => {
  switch (status) {
    case "running":
      return "running";
    case "finished":
      return "succeeded";
    case "error":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
};

const agentState = (
  status: SDKAgentInfo["status"],
): CanonicalAgent["state"] => {
  switch (status) {
    case "running":
      return "running";
    case "finished":
      return "ready_for_review";
    case "error":
      return "failed";
    default:
      return "unknown";
  }
};

class CursorCloudProvider implements AgentProviderPlugin {
  readonly manifest = {
    id: "cursor-cloud",
    displayName: "Cursor Cloud",
    version: "0.1.0",
    sdkVersion: 1 as const,
    capabilities: {
      discovery: true,
      liveEvents: true,
      commands: ["cancel", "archive"],
    },
  };
  readonly configSchema = ConfigSchema;
  private context: ProviderContext | undefined;
  private apiKey: string | undefined;
  private includeArchived = false;
  private emit: ProviderEventEmitter | undefined;
  private readonly agents = new Map<string, CanonicalAgent>();
  private readonly runs = new Map<string, AgentRun>();
  private readonly watchedRuns = new Map<string, AbortController>();
  private lastError: string | undefined;

  async initialise(context: ProviderContext): Promise<void> {
    this.context = context;
    const config = ConfigSchema.parse(context.config);
    this.apiKey = process.env[config.apiKeyEnv];
    this.includeArchived = config.includeArchived;
  }

  async discover(): Promise<ProviderSnapshot> {
    if (!this.context) throw new Error("Cursor provider not initialised");
    const apiKey = this.requireApiKey();
    const now = this.context.now();
    const projects = new Map<string, Project>();
    const workspaces = new Map<string, Workspace>();
    try {
      let cursor: string | undefined;
      do {
        const page = await Agent.list({
          runtime: "cloud",
          apiKey,
          includeArchived: this.includeArchived,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        for (const info of page.items) {
          if (!runtimeAgent(info)) continue;
          const repositories = [...new Set(info.repos ?? [])].sort();
          const resources = workspaceResourcesForProjects(
            "cursor-cloud",
            "repository",
            repositories.map((repo) => ({
              key: repo,
              externalId: repo,
              name:
                repo
                  .split("/")
                  .at(-1)
                  ?.replace(/\.git$/, "") ?? repo,
              metadata: {},
            })),
            { repositories },
          );
          for (const project of resources.projects)
            projects.set(project.id, project);
          if (resources.workspace)
            workspaces.set(resources.workspace.id, resources.workspace);
          const runs = await this.listAllRuns(info.agentId);
          const latest = runs.at(0);
          const state = agentState(info.status);
          const agent: CanonicalAgent = {
            id: canonicalId("cursor-cloud", info.agentId),
            providerId: "cursor-cloud",
            externalId: info.agentId,
            title:
              info.name || info.summary || `Cursor ${info.agentId.slice(-6)}`,
            ...(resources.projects[0]
              ? { projectId: resources.projects[0].id }
              : {}),
            ...(resources.workspace
              ? { workspaceId: resources.workspace.id }
              : {}),
            state,
            freshness: "fresh",
            ...(latest
              ? { activeRunId: canonicalId("cursor-cloud", latest.id) }
              : {}),
            requiresAttention:
              state === "ready_for_review" || state === "failed",
            lastActivityAt: new Date(info.lastModified).toISOString(),
            revision:
              this.agents.get(canonicalId("cursor-cloud", info.agentId))
                ?.revision ?? 0,
            archived: info.archived ?? false,
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
                href: `cursor://anysphere.cursor-deeplink/background-agent?bcId=${encodeURIComponent(info.agentId)}`,
              },
            ],
            metadata: {},
          };
          this.agents.set(agent.id, agent);
          for (const run of runs) {
            const canonical = this.mapRun(run, agent.id);
            this.runs.set(canonical.id, canonical);
            if (run.status === "running") this.watch(run, agent);
          }
        }
        cursor = page.nextCursor;
      } while (cursor);
      this.lastError = undefined;
      return {
        complete: true,
        observedAt: now,
        workspaces: [...workspaces.values()],
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
      for (const controller of this.watchedRuns.values()) controller.abort();
      this.watchedRuns.clear();
    };
  }

  async execute(command: ProviderCommand): Promise<CommandResult> {
    if (command.action === "archive") return this.archive(command);
    if (command.action !== "cancel")
      return {
        commandId: command.commandId,
        status: "unsupported",
        message: `Cursor Cloud does not support ${command.action}`,
      };
    const agent = this.agents.get(command.agentId);
    const run = agent?.activeRunId
      ? this.runs.get(agent.activeRunId)
      : undefined;
    if (!agent || !run || agent.state !== "running")
      return {
        commandId: command.commandId,
        status: "failed",
        message: "Cursor Cloud agent is not running",
      };
    try {
      await Agent.cancelRun(run.externalId, {
        runtime: "cloud",
        agentId: agent.externalId,
        apiKey: this.requireApiKey(),
      });
    } catch (error) {
      return {
        commandId: command.commandId,
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    const now = this.context?.now() ?? new Date().toISOString();
    const cancelledAgent: CanonicalAgent = {
      ...agent,
      state: "cancelled",
      requiresAttention: false,
      lastActivityAt: now,
    };
    const cancelledRun: AgentRun = {
      ...run,
      state: "cancelled",
      finishedAt: now,
    };
    this.agents.set(cancelledAgent.id, cancelledAgent);
    this.runs.set(cancelledRun.id, cancelledRun);
    await this.emit?.({
      providerId: "cursor-cloud",
      providerEventId: `command:${command.commandId}:agent`,
      type: "agent.state.changed",
      occurredAt: now,
      agentId: cancelledAgent.id,
      runId: cancelledRun.id,
      payload: { agent: cancelledAgent },
    });
    await this.emit?.({
      providerId: "cursor-cloud",
      providerEventId: `command:${command.commandId}:run`,
      type: "run.state.changed",
      occurredAt: now,
      agentId: cancelledAgent.id,
      runId: cancelledRun.id,
      payload: { run: cancelledRun },
    });
    return { commandId: command.commandId, status: "succeeded" };
  }

  private async archive(command: ProviderCommand): Promise<CommandResult> {
    const agent = this.agents.get(command.agentId);
    if (!agent)
      return {
        commandId: command.commandId,
        status: "failed",
        message: "Cursor Cloud agent was not found",
      };
    try {
      await Agent.archive(agent.externalId, {
        apiKey: this.requireApiKey(),
      });
    } catch (error) {
      return {
        commandId: command.commandId,
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    const archivedAgent: CanonicalAgent = {
      ...agent,
      archived: true,
    };
    this.agents.set(archivedAgent.id, archivedAgent);
    await this.emit?.({
      providerId: "cursor-cloud",
      providerEventId: `command:${command.commandId}:archive`,
      type: "agent.upserted",
      occurredAt: this.context?.now() ?? new Date().toISOString(),
      agentId: archivedAgent.id,
      payload: { agent: archivedAgent },
    });
    return { commandId: command.commandId, status: "succeeded" };
  }

  async healthCheck(): Promise<ProviderHealth> {
    const checkedAt = this.context?.now() ?? new Date().toISOString();
    if (!this.apiKey)
      return {
        status: "unhealthy",
        message: "Cursor API key environment variable is not set",
        checkedAt,
      };
    try {
      await Cursor.me({ apiKey: this.apiKey });
      return { status: "healthy", checkedAt };
    } catch (error) {
      return {
        status: "unhealthy",
        message:
          error instanceof Error
            ? error.message
            : (this.lastError ?? String(error)),
        checkedAt,
      };
    }
  }

  async dispose(): Promise<void> {
    for (const controller of this.watchedRuns.values()) controller.abort();
    this.watchedRuns.clear();
    this.emit = undefined;
  }

  private async listAllRuns(agentId: string): Promise<Run[]> {
    const apiKey = this.requireApiKey();
    const output: Run[] = [];
    let cursor: string | undefined;
    do {
      const page = await Agent.listRuns(agentId, {
        runtime: "cloud",
        apiKey,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      output.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return output.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }

  private mapRun(run: Run, agentId: string): AgentRun {
    const state = runState(run.status);
    const previous = this.runs.get(canonicalId("cursor-cloud", run.id));
    const startedAt = run.createdAt
      ? new Date(run.createdAt).toISOString()
      : previous?.startedAt;
    const finishedAt =
      state === "succeeded" || state === "failed" || state === "cancelled"
        ? this.context?.now()
        : undefined;
    return {
      id: canonicalId("cursor-cloud", run.id),
      agentId,
      providerId: "cursor-cloud",
      externalId: run.id,
      state,
      ...(startedAt ? { startedAt } : {}),
      ...(finishedAt ? { finishedAt } : {}),
      revision: previous?.revision ?? 0,
      metadata: {},
    };
  }

  private watch(run: Run, agent: CanonicalAgent): void {
    if (!this.emit || this.watchedRuns.has(run.id)) return;
    const controller = new AbortController();
    this.watchedRuns.set(run.id, controller);
    void (async () => {
      try {
        for await (const message of run.stream()) {
          if (controller.signal.aborted) break;
          if (message.type !== "status") continue;
          const refreshed = await Agent.getRun(run.id, {
            runtime: "cloud",
            agentId: run.agentId,
            apiKey: this.requireApiKey(),
          });
          const canonicalRun = this.mapRun(refreshed, agent.id);
          this.runs.set(canonicalRun.id, canonicalRun);
          const now = this.context?.now() ?? new Date().toISOString();
          await this.emit?.({
            providerId: "cursor-cloud",
            providerEventId: `run:${run.id}:${message.status}:${now}`,
            type: "run.state.changed",
            occurredAt: now,
            agentId: agent.id,
            runId: canonicalRun.id,
            payload: { run: canonicalRun },
          });
          const state: CanonicalAgent["state"] =
            canonicalRun.state === "running"
              ? "running"
              : canonicalRun.state === "succeeded"
                ? "ready_for_review"
                : canonicalRun.state === "failed"
                  ? "failed"
                  : canonicalRun.state === "cancelled"
                    ? "cancelled"
                    : "unknown";
          const updated: CanonicalAgent = {
            ...agent,
            state,
            freshness: "fresh",
            requiresAttention:
              state === "ready_for_review" || state === "failed",
            lastActivityAt: now,
          };
          this.agents.set(updated.id, updated);
          await this.emit?.({
            providerId: "cursor-cloud",
            providerEventId: `agent:${run.id}:${message.status}:${now}`,
            type: "agent.state.changed",
            occurredAt: now,
            agentId: updated.id,
            runId: canonicalRun.id,
            payload: { agent: updated },
          });
        }
      } catch (error) {
        if (!controller.signal.aborted)
          this.context?.logger.warn(
            { runId: run.id, error },
            "Cursor run stream disconnected; discovery will reconcile it",
          );
      } finally {
        this.watchedRuns.delete(run.id);
      }
    })();
  }

  private requireApiKey(): string {
    if (!this.apiKey)
      throw new Error("Cursor API key environment variable is not set");
    return this.apiKey;
  }
}

export const createProviderPlugin = (): AgentProviderPlugin =>
  new CursorCloudProvider();
