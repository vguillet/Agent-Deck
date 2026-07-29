import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { ProviderEvent } from "@agent-deck/domain";
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
    expect(snapshot.complete).toBe(false);
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

  it("waits for input while Cursor asks a question", async () => {
    const harness = await setup();
    const base = {
      conversation_id: "conversation-question",
      generation_id: "generation-question",
      workspace_roots: ["/workspace/alpha"],
      tool_use_id: "tool-question",
      tool_name: "AskQuestion",
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
      tool_name: "Shell",
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

  it("does not expose subagents as deck agents", async () => {
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

  it("suppresses a subagent on its first lifecycle event", async () => {
    const harness = await setup();
    await harness.handle({
      hook_event_name: "preToolUse",
      conversation_id: "conversation-child",
      generation_id: "generation-child",
      is_subagent: true,
      workspace_roots: ["/workspace/alpha"],
    });

    expect((await harness.plugin.discover()).agents).toHaveLength(0);
    expect(harness.events).toHaveLength(0);
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

  it("discards quarantined events when a conversation is classified as a child", async () => {
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
    expect((await harness.plugin.discover()).agents).toHaveLength(0);
    const registry = JSON.parse(harness.checkpoint()!) as {
      pendingHooks?: Array<[string, unknown[]]>;
    };
    expect(registry.pendingHooks).toEqual([]);
    await harness.close();
  });

  it("archives a previously observed agent when identified as a subagent", async () => {
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

    expect((await harness.plugin.discover()).agents).toHaveLength(0);
    expect(harness.events.at(-1)?.payload.agent).toMatchObject({
      externalId: "conversation-child",
      archived: true,
      requiresAttention: false,
    });
    await harness.close();
  });

  it("restores its registry from a checkpoint", async () => {
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
    expect(snapshot.agents[0]).toMatchObject({
      externalId: "conversation-restore",
      state: "running",
      freshness: "stale",
      requiresAttention: false,
      links: [
        {
          rel: "focus",
          href: "cursor://agent-deck.focus/open?conversationId=conversation-restore&workspace=%2Fworkspace%2Frestore",
        },
      ],
      metadata: {
        workspaceRoots: ["/workspace/restore"],
      },
    });
    expect(snapshot.runs[0]).toMatchObject({
      externalId: "generation-restore",
    });
    await restored.handle({
      hook_event_name: "postToolUse",
      conversation_id: "conversation-restore",
      generation_id: "generation-restore",
      workspace_roots: ["/workspace/restore"],
    });
    expect((await restored.plugin.discover()).agents[0]).toMatchObject({
      externalId: "conversation-restore",
      freshness: "fresh",
    });
    await restored.close();
  });

  it("prunes expired restored agents, runs, and resources", async () => {
    const first = await setup();
    await first.handle({
      hook_event_name: "beforeSubmitPrompt",
      conversation_id: "conversation-expired",
      generation_id: "generation-expired",
      workspace_roots: ["/workspace/expired"],
    });
    const registry = JSON.parse(first.checkpoint()!) as {
      agents: Array<{
        state: string;
        freshness: string;
        requiresAttention: boolean;
        lastActivityAt: string;
      }>;
      runs: Array<{
        state: string;
        finishedAt?: string;
      }>;
      projects: unknown[];
      workspaces: unknown[];
    };
    Object.assign(registry.agents[0]!, {
      state: "idle",
      freshness: "fresh",
      requiresAttention: false,
      lastActivityAt: "2026-07-27T09:41:59.000Z",
    });
    Object.assign(registry.runs[0]!, {
      state: "succeeded",
      finishedAt: "2026-07-27T09:41:59.000Z",
    });
    await first.close();

    const restored = await setup(JSON.stringify(registry));
    const snapshot = await restored.plugin.discover();

    expect(snapshot.agents).toEqual([]);
    expect(snapshot.runs).toEqual([]);
    expect(snapshot.projects).toEqual([]);
    expect(snapshot.workspaces).toEqual([]);
    const pruned = JSON.parse(restored.checkpoint()!) as {
      agents: unknown[];
      runs: unknown[];
    };
    expect(pruned.agents).toEqual([]);
    expect(pruned.runs).toEqual([]);
    await restored.close();
  });

  it("retains old active checkpoint agents as stale", async () => {
    const first = await setup();
    await first.handle({
      hook_event_name: "beforeSubmitPrompt",
      conversation_id: "conversation-active",
      generation_id: "generation-active",
      workspace_roots: ["/workspace/active"],
    });
    const registry = JSON.parse(first.checkpoint()!) as {
      agents: Array<{ lastActivityAt: string }>;
      runs: Array<{ startedAt?: string }>;
    };
    registry.agents[0]!.lastActivityAt = "2025-01-01T00:00:00.000Z";
    registry.runs[0]!.startedAt = "2025-01-01T00:00:00.000Z";
    await first.close();

    const restored = await setup(JSON.stringify(registry));
    expect((await restored.plugin.discover()).agents[0]).toMatchObject({
      externalId: "conversation-active",
      state: "running",
      freshness: "stale",
      requiresAttention: false,
    });
    await restored.close();
  });

  it("repairs missing workspace resources in older checkpoints", async () => {
    const first = await setup();
    await first.handle({
      hook_event_name: "beforeSubmitPrompt",
      conversation_id: "conversation-missing-workspace",
      generation_id: "generation-missing-workspace",
      workspace_roots: ["/workspace/legacy-app", "/workspace/shared"],
    });
    const registry = JSON.parse(first.checkpoint()!) as {
      agents: Array<{ workspaceId?: string; projectId?: string }>;
      workspaces: unknown[];
      projects: unknown[];
    };
    registry.agents[0]!.workspaceId = "cursor-local:workspace:missing";
    registry.agents[0]!.projectId = "cursor-local:project:missing";
    registry.workspaces = [];
    registry.projects = [];
    await first.close();

    const restored = await setup(JSON.stringify(registry));
    const snapshot = await restored.plugin.discover();
    const agent = snapshot.agents[0]!;

    expect(snapshot.workspaces).toHaveLength(1);
    expect(snapshot.workspaces[0]).toMatchObject({
      id: agent.workspaceId,
      name: "legacy-app +1",
      metadata: {
        roots: ["/workspace/legacy-app", "/workspace/shared"],
      },
    });
    expect(snapshot.projects).toHaveLength(2);
    expect(snapshot.projects[0]?.workspaceId).toBe(agent.workspaceId);
    expect(snapshot.projects.map(({ id }) => id)).toContain(agent.projectId);

    const repairedRegistry = JSON.parse(restored.checkpoint()!) as {
      workspaces: unknown[];
      projects: unknown[];
    };
    expect(repairedRegistry.workspaces).toHaveLength(1);
    expect(repairedRegistry.projects).toHaveLength(2);
    await restored.close();
  });

  it("backfills workspace targets for agents from older checkpoints", async () => {
    const directory = await mkdtemp(
      resolve(tmpdir(), "agent-deck-cursor-workspace-"),
    );
    const workspaceRoot = resolve(directory, "existing-workspace");
    const secondaryRoot = resolve(directory, "secondary-workspace");
    const workspaceFile = resolve(directory, "existing.code-workspace");
    const stateDatabasePath = resolve(directory, "state.vscdb");
    await mkdir(workspaceRoot);
    await mkdir(secondaryRoot);
    await writeFile(workspaceFile, "{}");
    const database = new DatabaseSync(stateDatabasePath);
    database.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
    database.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
      "workspaceMetadata.entries",
      JSON.stringify({
        entries: [
          {
            configPath: pathToFileURL(workspaceFile).href,
            paths: [
              { uri: { fsPath: workspaceRoot } },
              { uri: { fsPath: secondaryRoot } },
            ],
          },
        ],
      }),
    );
    database.close();

    const first = await setup(undefined, { stateDatabasePath });
    await first.handle({
      hook_event_name: "beforeSubmitPrompt",
      conversation_id: "conversation-legacy",
      generation_id: "generation-legacy",
      workspace_roots: [workspaceRoot, secondaryRoot],
    });
    const registry = JSON.parse(first.checkpoint()!) as {
      agents: Array<{
        links: Array<{ rel: string; href: string }>;
        metadata: Record<string, unknown>;
      }>;
    };
    registry.agents[0]!.links[0]!.href =
      "cursor://agent-deck.focus/open?conversationId=conversation-legacy";
    registry.agents[0]!.metadata = {};
    await first.close();

    const restored = await setup(JSON.stringify(registry), {
      stateDatabasePath,
    });
    const restoredAgent = (await restored.plugin.discover()).agents[0]!;
    expect(restoredAgent.metadata).toMatchObject({
      workspaceRoots: [workspaceRoot, secondaryRoot],
    });
    const focusUrl = new URL(restoredAgent.links[0]!.href);
    expect(focusUrl.searchParams.getAll("workspace")).toEqual([
      workspaceRoot,
      secondaryRoot,
    ]);
    expect(focusUrl.searchParams.get("window")).toBeNull();
    await restored.close();
  });

  it("migrates transcript subagents without exposing them", async () => {
    const first = await setup();
    await first.handle({
      hook_event_name: "sessionStart",
      conversation_id: "legacy-child",
      workspace_roots: ["/workspace/restore"],
    });
    const registry = JSON.parse(first.checkpoint()!) as Record<string, unknown>;
    registry.hiddenConversations = [];
    delete registry.conversationKinds;
    delete registry.sourceRevisions;
    delete registry.version;
    await first.close();

    const transcriptsRoot = await mkdtemp(
      resolve(tmpdir(), "agent-deck-transcripts-"),
    );
    const subagents = resolve(
      transcriptsRoot,
      "workspace",
      "agent-transcripts",
      "parent",
      "subagents",
    );
    await mkdir(subagents, { recursive: true });
    await writeFile(resolve(subagents, "legacy-child.jsonl"), "");
    const restored = await setup(JSON.stringify(registry), {
      transcriptsRoot,
    });
    const migrationSnapshot = await restored.plugin.discover();
    expect(migrationSnapshot.agents).toEqual([
      expect.objectContaining({
        externalId: "legacy-child",
        archived: true,
      }),
    ]);
    expect((await restored.plugin.discover()).agents).toHaveLength(0);
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
      hook_event_name: "sessionStart",
      conversation_id: "conversation-title",
      workspace_roots: ["/workspace/alpha"],
    });
    expect((await harness.plugin.discover()).agents[0]?.title).toBe(
      "Local cursor link setup",
    );
    await harness.close();
  });
});
