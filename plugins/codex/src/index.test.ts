import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderEvent } from "@agent-deck/domain";
import type {
  ProviderContext,
  ProviderIngressRegistration,
} from "@agent-deck/provider-sdk";
import { CodexAppServerClient } from "./app-server-client.js";
import { createProviderPlugin } from "./index.js";

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
          href: "codex://threads/thr_test",
        },
      ],
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

  it("preserves hook state when discovery sees the thread as not loaded", async () => {
    vi.spyOn(CodexAppServerClient.prototype, "listThreads").mockResolvedValue([
      {
        id: "thr_test",
        cwd: "/workspace/aquila",
        updatedAt: 1_785_256_000,
        status: { type: "notLoaded" },
      },
    ]);
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
      state: "idle",
    });

    await stop();
    await plugin.dispose();
  });
});
