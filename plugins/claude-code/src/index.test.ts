import { describe, expect, it } from "vitest";
import type { ProviderEvent } from "@agent-deck/domain";
import type {
  ProviderContext,
  ProviderIngressRegistration,
} from "@agent-deck/provider-sdk";
import { createProviderPlugin } from "./index.js";

const contextFor = (
  registrations: ProviderIngressRegistration[],
): ProviderContext => ({
  providerId: "claude-code",
  config: {},
  dataDirectory: "/tmp/agent-deck-claude-test",
  logger: {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
  now: () => "2026-08-01T20:00:00.000Z",
  registerIngress: (registration) => registrations.push(registration),
  checkpoints: {
    get: async () => undefined,
    set: async () => undefined,
  },
});

describe("Claude Code provider", () => {
  it("maps hooks, task progress, subagents, and usage", async () => {
    const registrations: ProviderIngressRegistration[] = [];
    const plugin = createProviderPlugin();
    await plugin.initialise(contextFor(registrations));
    const emitted: ProviderEvent[] = [];
    await plugin.subscribe(async (event) => {
      emitted.push(event);
    });
    const hooks = registrations.find(({ path }) => path === "/hooks")!;
    const status = registrations.find(({ path }) => path === "/status")!;
    await hooks.handle({
      protocol_version: 1,
      session_id: "session-1",
      hook_event_name: "UserPromptSubmit",
      cwd: "/workspace/aquila",
      prompt_id: "prompt-1",
    });
    await hooks.handle({
      protocol_version: 1,
      session_id: "session-1",
      hook_event_name: "TaskCreated",
      cwd: "/workspace/aquila",
      prompt_id: "prompt-1",
      task_id: "task-1",
    });
    await hooks.handle({
      protocol_version: 1,
      session_id: "session-1",
      hook_event_name: "TaskCompleted",
      cwd: "/workspace/aquila",
      prompt_id: "prompt-1",
      task_id: "task-1",
    });
    await hooks.handle({
      protocol_version: 1,
      session_id: "session-1",
      hook_event_name: "PermissionRequest",
      cwd: "/workspace/aquila",
      prompt_id: "prompt-1",
      tool_use_id: "tool-1",
    });
    await hooks.handle({
      protocol_version: 1,
      session_id: "session-1",
      hook_event_name: "SubagentStart",
      cwd: "/workspace/aquila",
      prompt_id: "prompt-1",
      agent_id: "agent-1",
      agent_type: "Explore",
    });
    await status.handle({
      protocol_version: 1,
      session_id: "session-1",
      session_name: "Claude refactor",
      workspace_roots: ["/workspace/aquila"],
      usage: {
        providerId: "claude-code",
        status: "available",
        windows: [
          {
            id: "five-hour",
            label: "5h",
            usedPercent: 25,
            available: true,
          },
        ],
        observedAt: "2026-08-01T20:00:00.000Z",
      },
    });
    const snapshot = await plugin.discover();
    expect(snapshot.agents).toHaveLength(2);
    expect(
      snapshot.agents.find(({ kind }) => kind === "top_level"),
    ).toMatchObject({
      title: "Claude refactor",
      state: "waiting_for_approval",
      progress: { plan: { completed: 1, total: 1 } },
      capabilities: { cancellation: false },
    });
    expect(
      snapshot.agents.find(({ kind }) => kind === "subagent"),
    ).toMatchObject({
      title: "Explore",
      parentAgentId: "claude-code:session-1",
    });
    expect(await plugin.usage!()).toMatchObject({
      providerId: "claude-code",
      status: "available",
    });
    expect(JSON.stringify(emitted)).not.toContain("tool_input");
  });

  it("rejects cancellation instead of killing an interactive process", async () => {
    const plugin = createProviderPlugin();
    await plugin.initialise(contextFor([]));
    await expect(
      plugin.execute({
        commandId: "command-1",
        action: "cancel",
        agentId: "claude-code:session-1",
      }),
    ).resolves.toEqual({
      commandId: "command-1",
      status: "unsupported",
      message: "Claude Code does not support cancel",
    });
  });

  it("scopes task progress and notification deduplication to one activity", async () => {
    const registrations: ProviderIngressRegistration[] = [];
    const plugin = createProviderPlugin();
    await plugin.initialise(contextFor(registrations));
    const emitted: ProviderEvent[] = [];
    await plugin.subscribe(async (event) => {
      emitted.push(event);
    });
    const hooks = registrations.find(({ path }) => path === "/hooks")!;
    const send = (input: Record<string, unknown>) =>
      hooks.handle({
        protocol_version: 1,
        session_id: "session-1",
        cwd: "/workspace/aquila",
        ...input,
      });

    await send({ hook_event_name: "UserPromptSubmit", prompt_id: "prompt-1" });
    await send({
      hook_event_name: "TaskCompleted",
      prompt_id: "prompt-1",
      task_id: "task-1",
    });
    await send({ hook_event_name: "UserPromptSubmit", prompt_id: "prompt-2" });

    const topLevel = (await plugin.discover()).agents.find(
      ({ kind }) => kind === "top_level",
    );
    expect(topLevel?.progress?.plan).toBeUndefined();

    await send({
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
    });
    await send({
      hook_event_name: "Notification",
      notification_type: "agent_needs_input",
    });
    const notificationEvents = emitted.slice(-2);
    expect(notificationEvents[0]?.providerEventId).not.toBe(
      notificationEvents[1]?.providerEventId,
    );

    await send({
      hook_event_name: "Notification",
      notification_type: "agent_needs_input",
    });
    expect(emitted.at(-1)?.providerEventId).toBe(
      notificationEvents[1]?.providerEventId,
    );
  });

  it("resets reused subagent task tracking at SubagentStart", async () => {
    const registrations: ProviderIngressRegistration[] = [];
    const plugin = createProviderPlugin();
    await plugin.initialise(contextFor(registrations));
    const hooks = registrations.find(({ path }) => path === "/hooks")!;
    const send = (
      hook_event_name: string,
      extra: Record<string, unknown> = {},
    ) =>
      hooks.handle({
        protocol_version: 1,
        session_id: "session-1",
        hook_event_name,
        cwd: "/workspace/aquila",
        agent_id: "agent-1",
        ...extra,
      });

    await send("SubagentStart");
    await send("TaskCompleted", { task_id: "task-1" });
    await send("SubagentStop");
    await send("SubagentStart");

    const subagent = (await plugin.discover()).agents.find(
      ({ kind }) => kind === "subagent",
    );
    expect(subagent?.progress?.plan).toBeUndefined();
  });
});
