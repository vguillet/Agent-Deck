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
    expect(emitted).toHaveLength(2);
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
    expect(emitted.at(-2)?.payload.agent).toMatchObject({
      state: "cancelled",
    });
    expect(emitted.at(-1)?.payload.run).toMatchObject({
      state: "cancelled",
    });
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
      turns: [{ id: "turn_test", status: "inProgress" }],
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
    expect((await plugin.discover()).agents[0]).toMatchObject({
      state: "ready_for_review",
    });

    await stop();
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

    expect(snapshot.agents[0]).toMatchObject({
      state: "cancelled",
      activeRunId: "codex:thr_test:turn_test",
      requiresAttention: false,
    });
    expect(snapshot.runs[0]).toMatchObject({
      externalId: "turn_test",
      state: "cancelled",
    });
    await plugin.dispose();
  });

  it("retains only active or 24-hour-recent discovered threads", async () => {
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

    expect(snapshot.agents.map((agent) => agent.externalId).sort()).toEqual([
      "thr_active",
      "thr_recent",
    ]);
    const registry = JSON.parse(checkpoint.value!) as {
      agents: Array<{ externalId: string }>;
    };
    expect(registry.agents.map((agent) => agent.externalId).sort()).toEqual([
      "thr_active",
      "thr_recent",
    ]);
    await plugin.dispose();
  });

  it("keeps recent hook-only sessions when app-server has not listed them", async () => {
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

    expect(snapshot.agents).toHaveLength(1);
    expect(snapshot.agents[0]?.externalId).toBe("thr_hook_only");
    expect(snapshot.runs[0]?.externalId).toBe("turn_hook_only");
    await plugin.dispose();
  });

  it("emits one stale transition when a retained thread expires", async () => {
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
    expect((await plugin.discover()).agents[0]).toMatchObject({
      externalId: "thr_aging",
      freshness: "fresh",
    });

    now = "2026-07-30T10:00:00.000Z";
    expect((await plugin.discover()).agents).toEqual([
      expect.objectContaining({
        externalId: "thr_aging",
        freshness: "stale",
        requiresAttention: false,
      }),
    ]);
    expect((await plugin.discover()).agents).toEqual([]);
    await plugin.dispose();
  });

  it("normalizes discovered cwd metadata and never emits a Codex app link", async () => {
    vi.spyOn(CodexAppServerClient.prototype, "listThreads").mockResolvedValue([
      {
        id: "thr_discovered",
        cwd: "/workspace/alpha/../aquila",
        status: { type: "idle" },
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
      )?.links,
    ).toEqual([]);
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
      tool_name: "request_user_input",
      permission_mode: "plan",
      agent_signal: "question_started",
    });
    expect(emitted.at(-2)?.payload.agent).toMatchObject({
      state: "waiting_for_input",
      requiresAttention: true,
      metadata: { agentMode: "plan" },
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
      tool_name: "request_user_input",
      permission_mode: "plan",
    });
    expect(emitted.at(-2)?.payload.agent).toMatchObject({
      state: "running",
      metadata: { agentMode: "plan" },
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
    const count = emitted.length;
    await ingress?.handle({
      session_id: "thr_ordered",
      hook_event_name: "PostToolUse",
      cwd: "/workspace/aquila",
      turn_id: "turn_old",
      tool_use_id: "tool_old",
      tool_name: "Bash",
    });
    await ingress?.handle(prompt("turn_new"));
    expect(emitted).toHaveLength(count);

    await ingress?.handle({
      session_id: "thr_ordered",
      hook_event_name: "Stop",
      cwd: "/workspace/aquila",
      turn_id: "turn_new",
      status: "failed",
    });
    expect(emitted.at(-2)?.payload.agent).toMatchObject({ state: "failed" });
    expect(emitted.at(-1)?.payload.run).toMatchObject({ state: "failed" });

    await stop();
    await plugin.dispose();
  });

  it("restores question state and mode from its checkpoint", async () => {
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
      tool_name: "request_user_input",
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
      state: "waiting_for_input",
      activeRunId: "codex:thr_restore:turn_restore",
      metadata: { agentMode: "plan" },
    });
    expect(snapshot.runs[0]).toMatchObject({
      state: "waiting_for_input",
    });
    await restored.dispose();
  });
});
