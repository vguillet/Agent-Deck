import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderEvent } from "@agent-deck/domain";
import type {
  ProviderContext,
  ProviderIngressRegistration,
} from "@agent-deck/provider-sdk";
import { CodexAppServerClient } from "./app-server-client.js";
import { createProviderPlugin } from "./index.js";

const contextFor = (
  registerIngress: (registration: ProviderIngressRegistration) => void,
  checkpoint: { value?: string } = {},
  now: () => string = () => "2026-07-29T10:00:00.000Z",
): ProviderContext => ({
  providerId: "codex",
  config: { binary: "codex" },
  dataDirectory: "/tmp/agent-deck-test",
  logger: {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
  now,
  registerIngress,
  checkpoints: {
    get: async () => checkpoint.value,
    set: async (_key, value) => {
      checkpoint.value = value;
    },
  },
});

describe("Codex provider hook ingestion", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits state only and drops sensitive hook fields", async () => {
    const plugin = createProviderPlugin();
    let ingress: ProviderIngressRegistration | undefined;
    const context: ProviderContext = {
      providerId: "codex",
      config: { binary: "codex" },
      dataDirectory: "/tmp/agent-deck-test",
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      now: () => "2026-07-28T09:42:31.000Z",
      registerIngress: (registration) => {
        ingress = registration;
      },
      checkpoints: {
        get: async () => undefined,
        set: async () => undefined,
      },
    };
    await plugin.initialise(context);
    const emitted: ProviderEvent[] = [];
    const stop = await plugin.subscribe(async (event) => {
      emitted.push(event);
    });
    const result = await ingress?.handle({
      session_id: "thr_test",
      hook_event_name: "PermissionRequest",
      cwd: "/workspace/aquila",
      turn_id: "turn_test",
      prompt: "SECRET PROMPT",
      transcript_path: "/secret/transcript.jsonl",
      tool_input: { command: "SECRET COMMAND" },
    });
    expect(result?.statusCode).toBe(202);
    expect(emitted.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(emitted);
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("transcript");
    expect(emitted[0]?.payload.agent).toMatchObject({
      state: "waiting_for_approval",
      requiresAttention: true,
      links: [
        {
          rel: "focus",
          label: "Open in Cursor Codex",
          href: "cursor://agent-deck.focus/codex?threadId=thr_test&cwd=%2Fworkspace%2Faquila",
        },
      ],
      metadata: { cwd: "/workspace/aquila" },
    });
    const interrupt = vi
      .spyOn(CodexAppServerClient.prototype, "interruptTurn")
      .mockResolvedValue();
    await expect(
      plugin.execute({
        commandId: "command-1",
        action: "cancel",
        agentId: "codex:thr_test",
      }),
    ).resolves.toEqual({
      commandId: "command-1",
      status: "succeeded",
    });
    expect(interrupt).toHaveBeenCalledWith("thr_test", "turn_test");
    expect(
      emitted.filter((event) => event.payload.agent).at(-1)?.payload.agent,
    ).toMatchObject({
      state: "cancelled",
    });
    expect(
      emitted.filter((event) => event.payload.run).at(-1)?.payload.run,
    ).toMatchObject({
      state: "cancelled",
    });
    await stop();
    await plugin.dispose();
  });

  it("tracks sanitized activity and explicit plan counts", async () => {
    const plugin = createProviderPlugin();
    let ingress: ProviderIngressRegistration | undefined;
    await plugin.initialise(
      contextFor((registration) => {
        ingress = registration;
      }),
    );
    const emitted: ProviderEvent[] = [];
    const stop = await plugin.subscribe(async (event) => {
      emitted.push(event);
    });
    const base = {
      session_id: "thr_progress",
      cwd: "/workspace/aquila",
      turn_id: "turn_progress",
    };
    await ingress?.handle({
      ...base,
      hook_event_name: "UserPromptSubmit",
    });
    await ingress?.handle({
      ...base,
      hook_event_name: "PreToolUse",
      tool_use_id: "tool_plan",
      agent_activity: "planning",
      plan_progress: { completed: 1, total: 3 },
    });

    await vi.waitFor(() => {
      expect(
        emitted.filter((event) => event.payload.agent).at(-1)?.payload.agent,
      ).toMatchObject({
        progress: {
          activity: "planning",
          plan: { completed: 1, total: 3 },
          observedAt: "2026-07-29T10:00:00.000Z",
        },
      });
    });
    expect(
      emitted.some((event) => event.type === "agent.progress.changed"),
    ).toBe(true);

    await ingress?.handle({
      ...base,
      hook_event_name: "Stop",
      status: "completed",
    });
    expect(
      emitted.filter((event) => event.payload.agent).at(-1)?.payload.agent,
    ).not.toHaveProperty("progress");
    await stop();
    await plugin.dispose();
  });

  it("preserves hook state when a not-loaded thread still has an active turn", async () => {
    vi.spyOn(CodexAppServerClient.prototype, "listThreads").mockResolvedValue([
      {
        id: "thr_test",
        cwd: "/workspace/aquila",
        updatedAt: 1_785_256_000,
        status: { type: "notLoaded" },
      },
    ]);
    vi.spyOn(CodexAppServerClient.prototype, "readThread").mockResolvedValue({
      id: "thr_test",
      cwd: "/workspace/aquila",
      updatedAt: 1_785_256_000,
      status: { type: "notLoaded" },
      turns: [{ id: "turn_previous", status: "completed" }],
    });
    const plugin = createProviderPlugin();
    let ingress: ProviderIngressRegistration | undefined;
    const context: ProviderContext = {
      providerId: "codex",
      config: { binary: "codex" },
      dataDirectory: "/tmp/agent-deck-test",
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      now: () => "2026-07-28T16:40:00.000Z",
      registerIngress: (registration) => {
        ingress = registration;
      },
      checkpoints: {
        get: async () => undefined,
        set: async () => undefined,
      },
    };
    await plugin.initialise(context);
    const stop = await plugin.subscribe(async () => undefined);

    await ingress?.handle({
      session_id: "thr_test",
      hook_event_name: "UserPromptSubmit",
      cwd: "/workspace/aquila",
      turn_id: "turn_test",
    });
    expect((await plugin.discover()).agents[0]).toMatchObject({
      state: "running",
      activeRunId: "codex:thr_test:turn_test",
      lastActivityAt: "2026-07-28T16:40:00.000Z",
    });

    await ingress?.handle({
      session_id: "thr_test",
      hook_event_name: "SessionEnd",
      cwd: "/workspace/aquila",
    });
    expect((await plugin.discover()).agents).toEqual([]);

    await stop();
    await plugin.dispose();
  });

  it("preserves a thinking session when Codex hooks omit the turn id", async () => {
    vi.spyOn(CodexAppServerClient.prototype, "listThreads").mockResolvedValue([
      {
        id: "thr_without_turn",
        cwd: "/workspace/aquila",
        status: { type: "notLoaded" },
      },
    ]);
    vi.spyOn(CodexAppServerClient.prototype, "readThread").mockResolvedValue({
      id: "thr_without_turn",
      cwd: "/workspace/aquila",
      status: { type: "notLoaded" },
      turns: [{ id: "turn_previous", status: "interrupted" }],
    });
    const plugin = createProviderPlugin();
    let ingress: ProviderIngressRegistration | undefined;
    await plugin.initialise(
      contextFor((registration) => {
        ingress = registration;
      }),
    );

    await ingress?.handle({
      session_id: "thr_without_turn",
      hook_event_name: "UserPromptSubmit",
      cwd: "/workspace/aquila",
    });
    expect((await plugin.discover()).agents[0]).toMatchObject({
      state: "running",
      requiresAttention: false,
    });

    await ingress?.handle({
      session_id: "thr_without_turn",
      hook_event_name: "Stop",
      cwd: "/workspace/aquila",
    });
    expect((await plugin.discover()).agents).toEqual([]);

    await ingress?.handle({
      session_id: "thr_without_turn",
      hook_event_name: "UserPromptSubmit",
      cwd: "/workspace/aquila",
    });
    expect((await plugin.discover()).agents[0]).toMatchObject({
      state: "running",
      requiresAttention: false,
    });
    await plugin.dispose();
  });

  it("keeps tool and question hooks authoritative without a prompt hook", async () => {
    vi.spyOn(CodexAppServerClient.prototype, "listThreads").mockResolvedValue([
      {
        id: "thr_tool_only",
        cwd: "/workspace/aquila",
        status: { type: "notLoaded" },
      },
    ]);
    vi.spyOn(CodexAppServerClient.prototype, "readThread").mockResolvedValue({
      id: "thr_tool_only",
      cwd: "/workspace/aquila",
      status: { type: "notLoaded" },
      turns: [{ id: "turn_previous", status: "interrupted" }],
    });
    const plugin = createProviderPlugin();
    let ingress: ProviderIngressRegistration | undefined;
    await plugin.initialise(
      contextFor((registration) => {
        ingress = registration;
      }),
    );

    await ingress?.handle({
      session_id: "thr_tool_only",
      hook_event_name: "PreToolUse",
      cwd: "/workspace/aquila",
      tool_use_id: "question_1",
      agent_activity: "waiting",
      agent_signal: "question_started",
    });
    expect((await plugin.discover()).agents[0]).toMatchObject({
      state: "waiting_for_input",
      requiresAttention: true,
    });

    await ingress?.handle({
      session_id: "thr_tool_only",
      hook_event_name: "PostToolUse",
      cwd: "/workspace/aquila",
      tool_use_id: "question_1",
      agent_activity: "waiting",
    });
    expect((await plugin.discover()).agents[0]).toMatchObject({
      state: "running",
      requiresAttention: false,
    });
    await plugin.dispose();
  });

  it("treats an in-progress thinking turn as running despite an idle thread status", async () => {
    vi.spyOn(CodexAppServerClient.prototype, "listThreads").mockResolvedValue([
      {
        id: "thr_thinking",
        cwd: "/workspace/aquila",
        updatedAt: 1_785_256_000,
        status: { type: "idle" },
        turns: [{ id: "turn_thinking", status: "inProgress" }],
      },
    ]);
    const plugin = createProviderPlugin();
    await plugin.initialise(contextFor(() => undefined));

    const snapshot = await plugin.discover();

    expect(snapshot.agents[0]).toMatchObject({
      state: "running",
      activeRunId: "codex:thr_thinking:turn_thinking",
      requiresAttention: false,
    });
    expect(snapshot.runs[0]).toMatchObject({
      state: "running",
    });
    await plugin.dispose();
  });

  it("detects a manually interrupted turn when Codex unloads it", async () => {
    vi.spyOn(CodexAppServerClient.prototype, "listThreads").mockResolvedValue([
      {
        id: "thr_test",
        cwd: "/workspace/aquila",
        updatedAt: 1_785_256_000,
        status: { type: "notLoaded" },
      },
    ]);
    vi.spyOn(CodexAppServerClient.prototype, "readThread").mockResolvedValue({
      id: "thr_test",
      cwd: "/workspace/aquila",
      updatedAt: 1_785_256_000,
      status: { type: "notLoaded" },
      turns: [{ id: "turn_test", status: "interrupted" }],
    });
    const plugin = createProviderPlugin();
    let ingress: ProviderIngressRegistration | undefined;
    await plugin.initialise(
      contextFor((registration) => {
        ingress = registration;
      }),
    );

    await ingress?.handle({
      session_id: "thr_test",
      hook_event_name: "UserPromptSubmit",
      cwd: "/workspace/aquila",
      turn_id: "turn_test",
    });
    const snapshot = await plugin.discover();

    expect(snapshot.agents).toEqual([]);
    expect(snapshot.runs).toEqual([]);
    await plugin.dispose();
  });

  it("discovers only currently active threads", async () => {
    const checkpoint: { value?: string } = {};
    const seconds = (value: string): number => Date.parse(value) / 1_000;
    vi.spyOn(CodexAppServerClient.prototype, "listThreads").mockResolvedValue([
      {
        id: "thr_expired",
        updatedAt: seconds("2026-07-28T09:59:59.999Z"),
        status: { type: "idle" },
      },
      {
        id: "thr_recent",
        updatedAt: seconds("2026-07-28T10:00:00.000Z"),
        status: { type: "idle" },
      },
      {
        id: "thr_active",
        updatedAt: seconds("2025-01-01T00:00:00.000Z"),
        status: { type: "active" },
      },
    ]);
    const plugin = createProviderPlugin();
    await plugin.initialise(contextFor(() => undefined, checkpoint));

    const snapshot = await plugin.discover();

    expect(snapshot.agents.map((agent) => agent.externalId)).toEqual([
      "thr_active",
    ]);
    expect(checkpoint.value).toBeUndefined();
    await plugin.dispose();
  });

  it("lets authoritative discovery remove hook-only sessions it cannot confirm", async () => {
    vi.spyOn(CodexAppServerClient.prototype, "listThreads").mockResolvedValue(
      [],
    );
    const plugin = createProviderPlugin();
    let ingress: ProviderIngressRegistration | undefined;
    await plugin.initialise(
      contextFor((registration) => {
        ingress = registration;
      }),
    );
    await ingress?.handle({
      session_id: "thr_hook_only",
      hook_event_name: "UserPromptSubmit",
      cwd: "/workspace/aquila",
      turn_id: "turn_hook_only",
    });

    const snapshot = await plugin.discover();

    expect(snapshot.agents).toEqual([]);
    expect(snapshot.runs).toEqual([]);
    await plugin.dispose();
  });

  it("does not import idle historical threads", async () => {
    let now = "2026-07-29T10:00:00.000Z";
    vi.spyOn(CodexAppServerClient.prototype, "listThreads").mockResolvedValue([
      {
        id: "thr_aging",
        updatedAt: Date.parse("2026-07-29T09:00:00.000Z") / 1_000,
        status: { type: "idle" },
      },
    ]);
    const plugin = createProviderPlugin();
    await plugin.initialise(
      contextFor(
        () => undefined,
        {},
        () => now,
      ),
    );
    expect((await plugin.discover()).agents).toEqual([]);
    now = "2026-07-30T10:00:00.000Z";
    expect((await plugin.discover()).agents).toEqual([]);
    await plugin.dispose();
  });

  it("normalizes discovered cwd metadata and never emits a Codex app link", async () => {
    vi.spyOn(CodexAppServerClient.prototype, "listThreads").mockResolvedValue([
      {
        id: "thr_discovered",
        cwd: "/workspace/alpha/../aquila",
        status: { type: "active" },
      },
      {
        id: "thr_without_cwd",
        status: { type: "idle" },
      },
    ]);
    const plugin = createProviderPlugin();
    await plugin.initialise(contextFor(() => undefined));

    const snapshot = await plugin.discover();
    const discovered = snapshot.agents.find(
      (candidate) => candidate.externalId === "thr_discovered",
    );
    expect(discovered).toMatchObject({
      metadata: {
        cwd: "/workspace/aquila",
        workspaceRoots: ["/workspace/aquila"],
      },
      links: [
        {
          label: "Open in Cursor Codex",
          href: "cursor://agent-deck.focus/codex?threadId=thr_discovered&cwd=%2Fworkspace%2Faquila",
        },
      ],
    });
    expect(discovered?.workspaceId).toBe(snapshot.workspaces[0]?.id);
    expect(discovered?.projectId).toBe(snapshot.projects[0]?.id);
    expect(snapshot.projects[0]?.workspaceId).toBe(discovered?.workspaceId);
    expect(
      snapshot.agents.find(
        (candidate) => candidate.externalId === "thr_without_cwd",
      ),
    ).toBeUndefined();
    expect(JSON.stringify(snapshot.agents)).not.toContain("codex://");
    await plugin.dispose();
  });

  it("tracks plan mode and native question waits", async () => {
    const plugin = createProviderPlugin();
    let ingress: ProviderIngressRegistration | undefined;
    await plugin.initialise(
      contextFor((registration) => {
        ingress = registration;
      }),
    );
    const emitted: ProviderEvent[] = [];
    const stop = await plugin.subscribe(async (event) => {
      emitted.push(event);
    });

    await ingress?.handle({
      protocol_version: 1,
      session_id: "thr_plan",
      hook_event_name: "UserPromptSubmit",
      cwd: "/workspace/aquila",
      turn_id: "turn_plan",
      permission_mode: "plan",
    });
    await ingress?.handle({
      protocol_version: 1,
      session_id: "thr_plan",
      hook_event_name: "PreToolUse",
      cwd: "/workspace/aquila",
      turn_id: "turn_plan",
      tool_use_id: "question_1",
      agent_activity: "waiting",
      permission_mode: "plan",
      agent_signal: "question_started",
    });
    await vi.waitFor(() => {
      expect(
        emitted.filter((event) => event.payload.agent).at(-1)?.payload.agent,
      ).toMatchObject({
        state: "waiting_for_input",
        requiresAttention: true,
        metadata: { agentMode: "plan" },
      });
    });
    expect(emitted.at(-1)?.payload.run).toMatchObject({
      state: "waiting_for_input",
    });

    await ingress?.handle({
      protocol_version: 1,
      session_id: "thr_plan",
      hook_event_name: "PostToolUse",
      cwd: "/workspace/aquila",
      turn_id: "turn_plan",
      tool_use_id: "question_1",
      agent_activity: "waiting",
      permission_mode: "plan",
    });
    await vi.waitFor(() => {
      expect(
        emitted.filter((event) => event.payload.agent).at(-1)?.payload.agent,
      ).toMatchObject({
        state: "running",
        metadata: { agentMode: "plan" },
      });
    });

    await stop();
    await plugin.dispose();
  });

  it("infers collaboration Plan mode from Codex's Plan-only question tool", async () => {
    const plugin = createProviderPlugin();
    let ingress: ProviderIngressRegistration | undefined;
    await plugin.initialise(
      contextFor((registration) => {
        ingress = registration;
      }),
    );
    const emitted: ProviderEvent[] = [];
    const stop = await plugin.subscribe(async (event) => {
      emitted.push(event);
    });

    await ingress?.handle({
      protocol_version: 1,
      session_id: "thr_collaboration_plan",
      hook_event_name: "UserPromptSubmit",
      cwd: "/workspace/aquila",
      turn_id: "turn_plan",
      permission_mode: "default",
    });
    await ingress?.handle({
      protocol_version: 1,
      session_id: "thr_collaboration_plan",
      hook_event_name: "PreToolUse",
      cwd: "/workspace/aquila",
      turn_id: "turn_plan",
      tool_use_id: "question_plan",
      agent_activity: "waiting",
      permission_mode: "default",
      agent_signal: "question_started",
    });
    await vi.waitFor(() => {
      expect(
        emitted.filter((event) => event.payload.agent).at(-1)?.payload.agent,
      ).toMatchObject({
        state: "waiting_for_input",
        metadata: { agentMode: "plan" },
      });
    });

    await ingress?.handle({
      protocol_version: 1,
      session_id: "thr_collaboration_plan",
      hook_event_name: "PostToolUse",
      cwd: "/workspace/aquila",
      turn_id: "turn_plan",
      tool_use_id: "question_plan",
      permission_mode: "default",
    });
    await vi.waitFor(() => {
      expect(
        emitted.filter((event) => event.payload.agent).at(-1)?.payload.agent,
      ).toMatchObject({ metadata: { agentMode: "plan" } });
    });

    await ingress?.handle({
      protocol_version: 1,
      session_id: "thr_collaboration_plan",
      hook_event_name: "UserPromptSubmit",
      cwd: "/workspace/aquila",
      turn_id: "turn_default",
      permission_mode: "default",
    });
    await vi.waitFor(() => {
      expect(
        emitted.filter((event) => event.payload.agent).at(-1)?.payload.agent,
      ).not.toMatchObject({ metadata: { agentMode: "plan" } });
    });

    await stop();
    await plugin.dispose();
  });

  it("rejects duplicate and late turn hooks and maps terminal failures", async () => {
    const plugin = createProviderPlugin();
    let ingress: ProviderIngressRegistration | undefined;
    await plugin.initialise(
      contextFor((registration) => {
        ingress = registration;
      }),
    );
    const emitted: ProviderEvent[] = [];
    const stop = await plugin.subscribe(async (event) => {
      emitted.push(event);
    });
    const prompt = (turnId: string) => ({
      session_id: "thr_ordered",
      hook_event_name: "UserPromptSubmit",
      cwd: "/workspace/aquila",
      turn_id: turnId,
    });
    await ingress?.handle(prompt("turn_old"));
    await ingress?.handle(prompt("turn_new"));
    await vi.waitFor(() => {
      expect(emitted).toHaveLength(4);
    });
    const count = emitted.length;
    await ingress?.handle({
      session_id: "thr_ordered",
      hook_event_name: "PostToolUse",
      cwd: "/workspace/aquila",
      turn_id: "turn_old",
      tool_use_id: "tool_old",
      agent_activity: "executing",
    });
    await ingress?.handle(prompt("turn_new"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(emitted).toHaveLength(count);

    await ingress?.handle({
      session_id: "thr_ordered",
      hook_event_name: "PreToolUse",
      cwd: "/workspace/aquila",
      turn_id: "turn_new",
      tool_use_id: "tool_plan",
      agent_activity: "planning",
      plan_progress: { completed: 1, total: 3 },
    });
    await ingress?.handle({
      session_id: "thr_ordered",
      hook_event_name: "Stop",
      cwd: "/workspace/aquila",
      turn_id: "turn_new",
      status: "failed",
    });
    await vi.waitFor(() => {
      expect(
        emitted.filter((event) => event.payload.agent).at(-1)?.payload.agent,
      ).toMatchObject({
        state: "failed",
        progress: { plan: { completed: 1, total: 3 } },
      });
    });
    await vi.waitFor(() => {
      expect(
        emitted.filter((event) => event.payload.run).at(-1)?.payload.run,
      ).toMatchObject({ state: "failed" });
    });

    await stop();
    await plugin.dispose();
  });

  it("does not restore hook lifecycle state from checkpoints", async () => {
    const checkpoint: { value?: string } = {};
    let ingress: ProviderIngressRegistration | undefined;
    const first = createProviderPlugin();
    await first.initialise(
      contextFor((registration) => {
        ingress = registration;
      }, checkpoint),
    );
    await ingress?.handle({
      session_id: "thr_restore",
      hook_event_name: "UserPromptSubmit",
      cwd: "/workspace/aquila",
      turn_id: "turn_restore",
      permission_mode: "plan",
    });
    await ingress?.handle({
      session_id: "thr_restore",
      hook_event_name: "PreToolUse",
      cwd: "/workspace/aquila",
      turn_id: "turn_restore",
      tool_use_id: "question_restore",
      agent_activity: "waiting",
      agent_signal: "question_started",
      plan_progress: { completed: 1, total: 2 },
      permission_mode: "plan",
    });
    await first.dispose();

    vi.spyOn(CodexAppServerClient.prototype, "listThreads").mockResolvedValue([
      {
        id: "thr_restore",
        cwd: "/workspace/aquila",
        status: { type: "active", activeFlags: ["waitingOnApproval"] },
        turns: [{ id: "turn_restore", status: "inProgress" }],
      },
    ]);
    const restored = createProviderPlugin();
    await restored.initialise(contextFor(() => undefined, checkpoint));
    const snapshot = await restored.discover();
    expect(snapshot.agents[0]).toMatchObject({
      state: "waiting_for_approval",
      activeRunId: "codex:thr_restore:turn_restore",
      metadata: {
        cwd: "/workspace/aquila",
        workspaceRoots: ["/workspace/aquila"],
      },
    });
    expect(snapshot.runs[0]).toMatchObject({
      state: "waiting_for_approval",
    });
    await restored.dispose();
  });
});
