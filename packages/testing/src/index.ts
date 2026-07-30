import { z } from "zod";
import {
  canonicalId,
  type Agent,
  type AgentRun,
  type CommandResult,
  type ProviderCommand,
  type ProviderHealth,
  type ProviderSnapshot,
} from "@agent-deck/domain";
import type {
  AgentProviderPlugin,
  ProviderContext,
  ProviderEventEmitter,
  Unsubscribe,
} from "@agent-deck/provider-sdk";

const ConfigSchema = z
  .object({
    count: z.number().int().min(1).max(50).default(6),
    intervalMs: z.number().int().min(250).default(3_000),
  })
  .default({ count: 6, intervalMs: 3_000 });

class FakeProvider implements AgentProviderPlugin {
  readonly manifest = {
    id: "fake",
    displayName: "Agent Deck Demo",
    version: "0.1.0",
    sdkVersion: 2 as const,
    capabilities: {
      discovery: true,
      liveEvents: true,
      commands: ["cancel"],
    },
  };
  readonly configSchema = ConfigSchema;
  private context: ProviderContext | undefined;
  private emit: ProviderEventEmitter | undefined;
  private timer: NodeJS.Timeout | undefined;
  private count = 6;
  private intervalMs = 3_000;
  private tick = 0;
  private readonly agents = new Map<string, Agent>();
  private readonly runs = new Map<string, AgentRun>();

  async initialise(context: ProviderContext): Promise<void> {
    this.context = context;
    const config = ConfigSchema.parse(context.config);
    this.count = config.count;
    this.intervalMs = config.intervalMs;
    this.seed(context.now());
  }

  async discover(): Promise<ProviderSnapshot> {
    const now = this.context?.now() ?? new Date().toISOString();
    return {
      reconciliation: "authoritative",
      observedAt: now,
      workspaces: [],
      projects: [
        {
          id: canonicalId("fake", "project:demo"),
          providerId: "fake",
          externalId: "demo",
          name: "agent-deck-demo",
          metadata: {},
        },
      ],
      agents: [...this.agents.values()],
      runs: [...this.runs.values()],
      attention: [],
    };
  }

  async subscribe(emit: ProviderEventEmitter): Promise<Unsubscribe> {
    this.emit = emit;
    this.timer = setInterval(() => {
      void this.advance();
    }, this.intervalMs);
    this.timer.unref();
    return async () => {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      this.emit = undefined;
    };
  }

  async execute(command: ProviderCommand): Promise<CommandResult> {
    if (command.action !== "cancel")
      return {
        commandId: command.commandId,
        status: "unsupported",
        message: `Fake provider does not support ${command.action}`,
      };
    const previous = this.agents.get(command.agentId);
    if (!previous)
      return {
        commandId: command.commandId,
        status: "failed",
        message: "Agent was not found",
      };
    const now = this.context?.now() ?? new Date().toISOString();
    const agent: Agent = {
      ...previous,
      state: "cancelled",
      requiresAttention: false,
      lastActivityAt: now,
    };
    this.agents.set(agent.id, agent);
    await this.emit?.({
      providerId: "fake",
      providerEventId: `command:${command.commandId}:agent`,
      type: "agent.state.changed",
      occurredAt: now,
      agentId: agent.id,
      ...(agent.activeRunId ? { runId: agent.activeRunId } : {}),
      payload: { agent },
    });
    const previousRun = agent.activeRunId
      ? this.runs.get(agent.activeRunId)
      : undefined;
    if (previousRun) {
      const run: AgentRun = {
        ...previousRun,
        state: "cancelled",
        finishedAt: now,
      };
      this.runs.set(run.id, run);
      await this.emit?.({
        providerId: "fake",
        providerEventId: `command:${command.commandId}:run`,
        type: "run.state.changed",
        occurredAt: now,
        agentId: agent.id,
        runId: run.id,
        payload: { run },
      });
    }
    return { commandId: command.commandId, status: "succeeded" };
  }

  async healthCheck(): Promise<ProviderHealth> {
    return {
      status: "healthy",
      checkedAt: this.context?.now() ?? new Date().toISOString(),
    };
  }

  async dispose(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.emit = undefined;
  }

  private seed(now: string): void {
    for (let index = 0; index < this.count; index++) {
      const externalId = `demo-${index + 1}`;
      const agentId = canonicalId("fake", externalId);
      const runId = canonicalId("fake", `${externalId}:run`);
      const state: Agent["state"] =
        index === 0
          ? "waiting_for_approval"
          : index === 1
            ? "running"
            : index === 2
              ? "ready_for_review"
              : "idle";
      this.agents.set(agentId, {
        id: agentId,
        providerId: "fake",
        externalId,
        title: `Demo Agent ${index + 1}`,
        projectId: canonicalId("fake", "project:demo"),
        state,
        activityEpoch: runId,
        activeRunId: runId,
        requiresAttention:
          state === "waiting_for_approval" || state === "ready_for_review",
        lastActivityAt: now,
        revision: 0,
        capabilities: {
          messages: false,
          approvals: false,
          cancellation: true,
          creation: false,
        },
        links: [],
        metadata: {},
      });
      this.runs.set(runId, {
        id: runId,
        agentId,
        providerId: "fake",
        externalId: `${externalId}:run`,
        state:
          state === "running"
            ? "running"
            : state === "waiting_for_approval"
              ? "waiting_for_approval"
              : state === "ready_for_review"
                ? "succeeded"
                : "unknown",
        startedAt: now,
        revision: 0,
        metadata: {},
      });
    }
  }

  private async advance(): Promise<void> {
    const states: Agent["state"][] = [
      "running",
      "waiting_for_approval",
      "ready_for_review",
      "idle",
    ];
    const index = this.tick % this.count;
    this.tick++;
    const id = canonicalId("fake", `demo-${index + 1}`);
    const previous = this.agents.get(id);
    if (!previous || !this.emit) return;
    const state = states[this.tick % states.length] ?? "unknown";
    const now = this.context?.now() ?? new Date().toISOString();
    const agent: Agent = {
      ...previous,
      state,
      requiresAttention:
        state === "waiting_for_approval" || state === "ready_for_review",
      lastActivityAt: now,
    };
    this.agents.set(id, agent);
    await this.emit({
      providerId: "fake",
      providerEventId: `tick:${this.tick}`,
      type: "agent.state.changed",
      occurredAt: now,
      agentId: id,
      ...(agent.activeRunId ? { runId: agent.activeRunId } : {}),
      payload: { agent },
    });
  }
}

export const createProviderPlugin = (): AgentProviderPlugin =>
  new FakeProvider();
