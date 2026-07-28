import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
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
      workspace_roots: ["/workspace/alpha"],
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
          href: "cursor://agent-deck.focus/open?conversationId=conversation-1",
        },
      ],
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
    });
    expect(snapshot.runs[0]).toMatchObject({
      externalId: "generation-restore",
    });
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
