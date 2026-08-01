import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalId,
  type Agent,
  type ProviderEvent,
} from "@agent-deck/domain";
import type {
  ProviderContext,
  ProviderIngressRegistration,
} from "@agent-deck/provider-sdk";
import { createProviderPlugin } from "./index.js";

const setup = async (
  checkpoint?: string,
  config: Record<string, unknown> = {},
) => {
  const plugin = createProviderPlugin();
  let ingress: ProviderIngressRegistration | undefined;
  let saved: string | undefined = checkpoint;
  let tick = 0;
  const context: ProviderContext = {
    providerId: "cursor-local",
    config,
    dataDirectory: "/tmp/agent-deck-cursor-local-test",
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    now: () => `2026-07-28T09:42:${String(tick++).padStart(2, "0")}.000Z`,
    registerIngress: (registration) => {
      ingress = registration;
    },
    checkpoints: {
      get: async () => saved,
      set: async (_key, value) => {
        saved = value;
      },
    },
  };
  await plugin.initialise(context);
  const events: ProviderEvent[] = [];
  const stop = await plugin.subscribe(async (event) => {
    events.push(event);
  });
  return {
    plugin,
    events,
    handle: async (input: unknown) => {
      if (!ingress) throw new Error("Ingress was not registered");
      return ingress.handle(input);
    },
    checkpoint: () => saved,
    close: async () => {
      await stop();
      await plugin.dispose();
    },
  };
};

describe("Cursor local provider", () => {
  it("publishes a provisional top-level agent before it does work", async () => {
    const harness = await setup();
    await harness.handle({
      hook_event_name: "sessionStart",
      conversation_id: "conversation-created",
      conversation_kind: "top_level",
      workspace_roots: ["/workspace/alpha"],
    });

    const created = harness.events.at(-1);
    expect(created?.type).toBe("agent.upserted");
    expect(created?.runId).toBeUndefined();
    expect(created?.payload.agent).toMatchObject({
      externalId: "conversation-created",
      kind: "top_level",
      state: "idle",
      metadata: {
        lifecycle: "provisional",
        workspaceRoots: ["/workspace/alpha"],
      },
    });

    await harness.handle({
      hook_event_name: "beforeSubmitPrompt",
      conversation_id: "conversation-created",
      generation_id: "generation-created",
      conversation_kind: "top_level",
      workspace_roots: ["/workspace/alpha"],
    });
    expect(
      harness.events.filter((event) => event.payload.agent).at(-1)?.payload
        .agent,
    ).toMatchObject({
      state: "running",
      activityEpoch: "generation-created",
    });
    expect(
      harness.events.filter((event) => event.payload.agent).at(-1)?.payload
        .agent,
    ).not.toHaveProperty("metadata.lifecycle");
    await harness.close();
  });

  it("maps turns to stable agents and runs without retaining sensitive data", async () => {
    const harness = await setup();
    await harness.handle({
      hook_event_name: "beforeSubmitPrompt",
      conversation_id: "conversation-1",
      generation_id: "generation-1",
      workspace_roots: ["/workspace/alpha"],
      prompt: "SECRET PROMPT",
      transcript_path: "/secret/transcript.jsonl",
      tool_input: { command: "SECRET COMMAND" },
    });
    await harness.handle({
      hook_event_name: "stop",
      conversation_id: "conversation-1",
      generation_id: "generation-1",
      workspace_roots: [],
      status: "completed",
      result: "SECRET RESULT",
    });

    const snapshot = await harness.plugin.discover();
    expect(snapshot.reconciliation).toBe("incremental");
    expect(snapshot.agents).toHaveLength(1);
    expect(snapshot.agents[0]).toMatchObject({
      externalId: "conversation-1",
      title: "Cursor tion-1",
      state: "ready_for_review",
      requiresAttention: true,
      links: [
        {
          rel: "focus",
          href: "cursor://agent-deck.focus/open?conversationId=conversation-1&workspace=%2Fworkspace%2Falpha",
        },
      ],
      metadata: {
        workspaceRoots: ["/workspace/alpha"],
      },
    });
    expect(snapshot.runs[0]).toMatchObject({
      externalId: "generation-1",
      state: "succeeded",
    });
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.workspaces).toHaveLength(1);
    expect(JSON.stringify({ snapshot, events: harness.events })).not.toContain(
      "SECRET",
    );
    await harness.close();
  });

  it("tracks sanitized activity and explicit plan counts", async () => {
    const harness = await setup();
    const base = {
      conversation_id: "conversation-progress",
      generation_id: "generation-progress",
      workspace_roots: ["/workspace/alpha"],
    };
    await harness.handle({
      ...base,
      hook_event_name: "beforeSubmitPrompt",
    });
    await harness.handle({
      ...base,
      hook_event_name: "preToolUse",
      tool_use_id: "tool-plan",
      agent_activity: "planning",
      plan_progress: { completed: 2, total: 4 },
    });
    expect((await harness.plugin.discover()).agents[0]?.progress).toMatchObject(
      {
        activity: "planning",
        plan: { completed: 2, total: 4 },
      },
    );
    expect(
      harness.events.some((event) => event.type === "agent.progress.changed"),
    ).toBe(true);
    expect(
      (JSON.parse(harness.checkpoint()!) as { agents: Agent[] }).agents,
    ).toEqual([]);

    await harness.handle({
      ...base,
      hook_event_name: "stop",
      status: "completed",
    });
    expect(
      (await harness.plugin.discover()).agents[0]?.progress,
    ).toBeUndefined();
    await harness.close();
  });

  it("ignores late events from an older generation", async () => {
    const harness = await setup();
    const base = {
      conversation_id: "conversation-1",
      workspace_roots: ["/workspace/alpha"],
    };
    await harness.handle({
      ...base,
      hook_event_name: "beforeSubmitPrompt",
      generation_id: "generation-1",
    });
    await harness.handle({
      ...base,
      hook_event_name: "beforeSubmitPrompt",
      generation_id: "generation-2",
    });
    const result = await harness.handle({
      ...base,
      hook_event_name: "stop",
      generation_id: "generation-1",
      status: "error",
    });
    expect(result.statusCode).toBe(202);
    const snapshot = await harness.plugin.discover();
    expect(snapshot.agents[0]?.state).toBe("running");
    expect(snapshot.agents[0]?.activeRunId).toContain("generation-2");
    expect(
      snapshot.runs.find((run) => run.externalId === "generation-1"),
    ).toMatchObject({ state: "running" });
    await harness.close();
  });

  it("tracks Cursor's mode across hook events", async () => {
    const harness = await setup();
    const base = {
      conversation_id: "conversation-mode",
      generation_id: "generation-mode",
      workspace_roots: ["/workspace/alpha"],
    };
    await harness.handle({
      ...base,
      hook_event_name: "beforeSubmitPrompt",
      composer_mode: "chat",
    });
    await harness.handle({
      ...base,
      hook_event_name: "postToolUse",
    });

    expect((await harness.plugin.discover()).agents[0]?.metadata).toEqual({
      agentMode: "ask",
      cursorMode: "ask",
      workspaceRoots: ["/workspace/alpha"],
    });
    await harness.close();
  });

  it("clears a stale rendered mode when Cursor reports another mode", async () => {
    const harness = await setup();
    const base = {
      conversation_id: "conversation-mode-transition",
      workspace_roots: ["/workspace/alpha"],
    };
    await harness.handle({
      ...base,
      hook_event_name: "beforeSubmitPrompt",
      generation_id: "generation-plan",
      composer_mode: "plan",
    });
    await harness.handle({
      ...base,
      hook_event_name: "beforeSubmitPrompt",
      generation_id: "generation-edit",
      composer_mode: "edit",
    });

    expect((await harness.plugin.discover()).agents[0]?.metadata).toEqual({
      workspaceRoots: ["/workspace/alpha"],
    });
    await harness.close();
  });

  it("waits for input while Cursor asks a question", async () => {
    const harness = await setup();
    const base = {
      conversation_id: "conversation-question",
      generation_id: "generation-question",
      workspace_roots: ["/workspace/alpha"],
      tool_use_id: "tool-question",
      agent_activity: "waiting",
    };
    await harness.handle({
      ...base,
      hook_event_name: "preToolUse",
    });

    let snapshot = await harness.plugin.discover();
    expect(snapshot.agents[0]).toMatchObject({
      state: "waiting_for_input",
      requiresAttention: true,
    });
    expect(snapshot.runs[0]).toMatchObject({ state: "waiting_for_input" });

    await harness.handle({
      ...base,
      hook_event_name: "postToolUse",
    });
    snapshot = await harness.plugin.discover();
    expect(snapshot.agents[0]).toMatchObject({
      state: "running",
      requiresAttention: false,
    });
    expect(snapshot.runs[0]).toMatchObject({ state: "running" });
    await harness.close();
  });

  it("keeps the agent waiting after an explicit question signal", async () => {
    const harness = await setup();
    const base = {
      conversation_id: "conversation-signalled-question",
      generation_id: "generation-signalled-question",
      workspace_roots: ["/workspace/alpha"],
      tool_use_id: "tool-signal",
      agent_activity: "executing",
      agent_signal: "question_started",
    };
    await harness.handle({ ...base, hook_event_name: "preToolUse" });
    await harness.handle({
      ...base,
      hook_event_name: "postToolUse",
      agent_signal: undefined,
    });

    let snapshot = await harness.plugin.discover();
    expect(snapshot.agents[0]).toMatchObject({
      state: "waiting_for_input",
      requiresAttention: true,
    });

    await harness.handle({
      ...base,
      hook_event_name: "preToolUse",
      tool_use_id: "next-tool",
      agent_signal: undefined,
    });
    snapshot = await harness.plugin.discover();
    expect(snapshot.agents[0]).toMatchObject({
      state: "running",
      requiresAttention: false,
    });
    await harness.close();
  });

  it("does not expose background conversations as deck agents", async () => {
    const harness = await setup();
    await harness.handle({
      hook_event_name: "sessionStart",
      conversation_id: "conversation-child",
      is_background_agent: true,
      workspace_roots: ["/workspace/alpha"],
    });
    await harness.handle({
      hook_event_name: "sessionStart",
      conversation_id: "conversation-child",
      workspace_roots: ["/workspace/alpha"],
    });
    await harness.handle({
      hook_event_name: "beforeSubmitPrompt",
      conversation_id: "conversation-child",
      generation_id: "generation-child",
      workspace_roots: ["/workspace/alpha"],
    });

    const snapshot = await harness.plugin.discover();
    expect(snapshot.agents).toHaveLength(0);
    expect(snapshot.runs).toHaveLength(0);
    await harness.close();
  });

  it("exposes a typed subagent on its first lifecycle event", async () => {
    const harness = await setup();
    await harness.handle({
      hook_event_name: "preToolUse",
      conversation_id: "conversation-child",
      generation_id: "generation-child",
      is_subagent: true,
      workspace_roots: ["/workspace/alpha"],
    });

    expect((await harness.plugin.discover()).agents).toEqual([
      expect.objectContaining({
        externalId: "conversation-child",
        kind: "subagent",
        state: "running",
      }),
    ]);
    expect(harness.events).toHaveLength(2);
    await harness.handle({
      hook_event_name: "stop",
      conversation_id: "conversation-child",
      generation_id: "generation-child",
      is_subagent: true,
      workspace_roots: ["/workspace/alpha"],
    });
    expect((await harness.plugin.discover()).agents[0]).toMatchObject({
      kind: "subagent",
      state: "ready_for_review",
    });
    await harness.close();
  });

  it.each([
    ["success", "ready_for_review"],
    ["error", "failed"],
  ] as const)(
    "reconciles a completed subagent transcript with %s status",
    async (status, expectedState) => {
      const transcriptsRoot = await mkdtemp(
        resolve(tmpdir(), "agent-deck-subagent-terminal-"),
      );
      const subagents = resolve(
        transcriptsRoot,
        "workspace",
        "agent-transcripts",
        "conversation-parent",
        "subagents",
      );
      await mkdir(subagents, { recursive: true });
      await writeFile(
        resolve(subagents, "child-task.jsonl"),
        `${JSON.stringify({ type: "turn_ended", status })}\n`,
      );
      const harness = await setup(undefined, { transcriptsRoot });
      await harness.handle({
        hook_event_name: "subagentStart",
        subagent_id: "conversation-child",
        parent_conversation_id: "conversation-parent",
        workspace_roots: ["/workspace/alpha"],
      });

      expect((await harness.plugin.discover()).agents[0]).toMatchObject({
        kind: "subagent",
        state: expectedState,
        requiresAttention: false,
      });
      await harness.close();
    },
  );

  it("publishes a terminal state immediately when a watched transcript finishes", async () => {
    const transcriptsRoot = await mkdtemp(
      resolve(tmpdir(), "agent-deck-subagent-watch-"),
    );
    const subagents = resolve(
      transcriptsRoot,
      "workspace",
      "agent-transcripts",
      "conversation-parent",
      "subagents",
    );
    await mkdir(subagents, { recursive: true });
    const transcript = resolve(subagents, "child-task.jsonl");
    await writeFile(
      transcript,
      `${JSON.stringify({ role: "user", message: "working" })}\n`,
    );
    const harness = await setup(undefined, { transcriptsRoot });
    await harness.handle({
      hook_event_name: "subagentStart",
      subagent_id: "conversation-child",
      parent_conversation_id: "conversation-parent",
      workspace_roots: ["/workspace/alpha"],
    });
    await appendFile(
      transcript,
      `${JSON.stringify({ type: "turn_ended", status: "success" })}\n`,
    );

    await vi.waitFor(() => {
      expect(
        harness.events.some(
          (event) =>
            event.type === "agent.state.changed" &&
            (event.payload.agent as Agent | undefined)?.state ===
              "ready_for_review",
        ),
      ).toBe(true);
    });
    await harness.close();
  });

  it("quarantines unknown protocol events until top-level classification", async () => {
    const harness = await setup();
    await harness.handle({
      protocol_version: 2,
      hook_event_name: "preToolUse",
      conversation_id: "conversation-pending",
      generation_id: "generation-pending",
      workspace_roots: ["/workspace/alpha"],
    });
    expect((await harness.plugin.discover()).agents).toHaveLength(0);
    expect(harness.events).toHaveLength(0);

    await harness.handle({
      protocol_version: 2,
      hook_event_name: "beforeSubmitPrompt",
      conversation_id: "conversation-pending",
      conversation_kind: "top_level",
      generation_id: "generation-pending",
      workspace_roots: ["/workspace/alpha"],
    });
    expect((await harness.plugin.discover()).agents).toHaveLength(1);
    expect(
      harness.events.some((event) => event.type === "agent.upserted"),
    ).toBe(true);
    await harness.close();
  });

  it("replaces quarantined events when a conversation is classified as a child", async () => {
    const harness = await setup();
    await harness.handle({
      protocol_version: 2,
      hook_event_name: "preToolUse",
      conversation_id: "pending-child",
      generation_id: "generation-child",
      workspace_roots: [],
    });
    await harness.handle({
      hook_event_name: "subagentStart",
      subagent_id: "pending-child",
      parent_conversation_id: "parent",
      workspace_roots: [],
    });
    expect((await harness.plugin.discover()).agents).toEqual([
      expect.objectContaining({
        externalId: "pending-child",
        kind: "subagent",
        parentAgentId: canonicalId("cursor-local", "parent"),
        state: "running",
      }),
    ]);
    const registry = JSON.parse(harness.checkpoint()!) as {
      pendingHooks?: Array<[string, unknown[]]>;
    };
    expect(registry.pendingHooks).toEqual([]);
    await harness.close();
  });

  it("reclassifies a previously observed agent as a running subagent", async () => {
    const harness = await setup();
    await harness.handle({
      hook_event_name: "sessionStart",
      conversation_id: "conversation-child",
      workspace_roots: ["/workspace/alpha"],
    });
    await harness.handle({
      hook_event_name: "subagentStart",
      subagent_id: "conversation-child",
      parent_conversation_id: "conversation-parent",
      workspace_roots: ["/workspace/alpha"],
    });

    expect((await harness.plugin.discover()).agents).toHaveLength(1);
    expect(harness.events.at(-1)?.payload.agent).toMatchObject({
      externalId: "conversation-child",
      kind: "subagent",
      parentAgentId: canonicalId("cursor-local", "conversation-parent"),
      state: "running",
      requiresAttention: false,
    });
    await harness.close();
  });

  it("merges a transcript conversation ID into its canonical subagent", async () => {
    const transcriptsRoot = await mkdtemp(
      resolve(tmpdir(), "agent-deck-subagent-alias-"),
    );
    const subagents = resolve(
      transcriptsRoot,
      "workspace",
      "agent-transcripts",
      "conversation-parent",
      "subagents",
    );
    await mkdir(subagents, { recursive: true });
    await writeFile(
      resolve(subagents, "conversation-transcript.jsonl"),
      `${JSON.stringify({ role: "user", message: "working" })}\n`,
    );
    const harness = await setup(undefined, { transcriptsRoot });
    await harness.handle({
      hook_event_name: "sessionStart",
      conversation_id: "conversation-transcript",
      conversation_kind: "top_level",
      workspace_roots: ["/workspace/alpha"],
    });
    await harness.handle({
      hook_event_name: "beforeSubmitPrompt",
      conversation_id: "conversation-transcript",
      conversation_kind: "top_level",
      generation_id: "generation-child",
      workspace_roots: ["/workspace/alpha"],
    });
    await harness.handle({
      hook_event_name: "subagentStart",
      subagent_id: "tool-call-child",
      parent_conversation_id: "conversation-parent",
      workspace_roots: ["/workspace/alpha"],
    });

    expect((await harness.plugin.discover()).agents).toEqual([
      expect.objectContaining({
        externalId: "tool-call-child",
        kind: "subagent",
        parentAgentId: canonicalId("cursor-local", "conversation-parent"),
        state: "running",
      }),
    ]);
    expect(harness.events).toContainEqual(
      expect.objectContaining({
        type: "agent.removed",
        agentId: canonicalId("cursor-local", "conversation-transcript"),
      }),
    );

    await harness.handle({
      hook_event_name: "stop",
      conversation_id: "conversation-transcript",
      conversation_kind: "top_level",
      generation_id: "generation-child",
      workspace_roots: ["/workspace/alpha"],
    });
    expect((await harness.plugin.discover()).agents).toEqual([
      expect.objectContaining({
        externalId: "tool-call-child",
        kind: "subagent",
        state: "ready_for_review",
      }),
    ]);
    await harness.close();
  });

  it("does not restore live agents or runs from checkpoints", async () => {
    const first = await setup();
    await first.handle({
      hook_event_name: "beforeSubmitPrompt",
      conversation_id: "conversation-restore",
      generation_id: "generation-restore",
      workspace_roots: ["/workspace/restore"],
    });
    const checkpoint = first.checkpoint();
    await first.close();

    const restored = await setup(checkpoint);
    const snapshot = await restored.plugin.discover();
    expect(snapshot.agents).toEqual([]);
    expect(snapshot.runs).toEqual([]);
    expect(snapshot.projects).toEqual([]);
    expect(snapshot.workspaces).toEqual([]);
    await restored.close();
  });

  it("rejects malformed hook payloads", async () => {
    const harness = await setup();
    expect(
      (await harness.handle({ hook_event_name: "sessionStart" })).statusCode,
    ).toBe(400);
    expect(harness.events).toHaveLength(0);
    await harness.close();
  });

  it("uses Cursor's local conversation title metadata", async () => {
    const directory = await mkdtemp(
      resolve(tmpdir(), "agent-deck-cursor-state-"),
    );
    const stateDatabasePath = resolve(directory, "state.vscdb");
    const database = new DatabaseSync(stateDatabasePath);
    database.exec(
      "CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, value TEXT)",
    );
    database
      .prepare("INSERT INTO composerHeaders (composerId, value) VALUES (?, ?)")
      .run(
        "conversation-title",
        JSON.stringify({ name: "Local cursor link setup" }),
      );
    database.close();

    const harness = await setup(undefined, { stateDatabasePath });
    await harness.handle({
      hook_event_name: "beforeSubmitPrompt",
      conversation_id: "conversation-title",
      generation_id: "generation-title",
      workspace_roots: ["/workspace/alpha"],
    });
    expect((await harness.plugin.discover()).agents[0]?.title).toBe(
      "Local cursor link setup",
    );
    await harness.close();
  });
});
