import { Agent, Cursor } from "@cursor/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderContext } from "@agent-deck/provider-sdk";
import { createProviderPlugin } from "./index.js";

vi.mock("@cursor/sdk", () => ({
  Agent: {
    list: vi.fn(),
    listRuns: vi.fn(),
    getRun: vi.fn(),
    cancelRun: vi.fn(),
    archive: vi.fn(),
  },
  Cursor: {
    me: vi.fn(),
  },
}));

describe("Cursor Cloud provider focus links", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.AGENT_DECK_CURSOR_TEST_KEY;
  });

  it("publishes an exact desktop focus link", async () => {
    process.env.AGENT_DECK_CURSOR_TEST_KEY = "test-key";
    vi.mocked(Agent.list).mockResolvedValue({
      items: [
        {
          runtime: "cloud",
          agentId: "cloud-agent-1",
          name: "Cloud agent",
          status: "finished",
          lastModified: Date.parse("2026-07-28T09:00:00.000Z"),
          archived: false,
          repos: [],
        },
      ],
    } as never);
    vi.mocked(Agent.listRuns).mockResolvedValue({ items: [] });
    vi.mocked(Cursor.me).mockResolvedValue({} as never);
    const context: ProviderContext = {
      providerId: "cursor-cloud",
      config: { apiKeyEnv: "AGENT_DECK_CURSOR_TEST_KEY" },
      dataDirectory: "/tmp/agent-deck-cursor-cloud-test",
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      now: () => "2026-07-28T09:42:31.000Z",
      registerIngress: () => undefined,
      checkpoints: {
        get: async () => undefined,
        set: async () => undefined,
      },
    };
    const plugin = createProviderPlugin();
    await plugin.initialise(context);
    const snapshot = await plugin.discover();
    expect(snapshot.agents[0]?.links).toEqual([
      {
        rel: "focus",
        label: "Open in Cursor",
        href: "cursor://anysphere.cursor-deeplink/background-agent?bcId=cloud-agent-1",
      },
    ]);
    await plugin.dispose();
  });

  it("cancels the active cloud run", async () => {
    process.env.AGENT_DECK_CURSOR_TEST_KEY = "test-key";
    vi.mocked(Agent.list).mockResolvedValue({
      items: [
        {
          runtime: "cloud",
          agentId: "cloud-agent-1",
          name: "Cloud agent",
          status: "running",
          lastModified: Date.parse("2026-07-28T09:00:00.000Z"),
          archived: false,
          repos: [],
        },
      ],
    } as never);
    vi.mocked(Agent.listRuns).mockResolvedValue({
      items: [
        {
          id: "cloud-run-1",
          agentId: "cloud-agent-1",
          status: "running",
          createdAt: Date.parse("2026-07-28T09:00:00.000Z"),
        },
      ],
    } as never);
    vi.mocked(Agent.cancelRun).mockResolvedValue();
    const context: ProviderContext = {
      providerId: "cursor-cloud",
      config: { apiKeyEnv: "AGENT_DECK_CURSOR_TEST_KEY" },
      dataDirectory: "/tmp/agent-deck-cursor-cloud-test",
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      now: () => "2026-07-28T09:42:31.000Z",
      registerIngress: () => undefined,
      checkpoints: {
        get: async () => undefined,
        set: async () => undefined,
      },
    };
    const plugin = createProviderPlugin();
    await plugin.initialise(context);
    await plugin.discover();

    await expect(
      plugin.execute({
        commandId: "command-1",
        action: "cancel",
        agentId: "cursor-cloud:cloud-agent-1",
      }),
    ).resolves.toEqual({
      commandId: "command-1",
      status: "succeeded",
    });
    expect(Agent.cancelRun).toHaveBeenCalledWith("cloud-run-1", {
      runtime: "cloud",
      agentId: "cloud-agent-1",
      apiKey: "test-key",
    });
    await plugin.dispose();
  });

  it("archives a cloud agent", async () => {
    process.env.AGENT_DECK_CURSOR_TEST_KEY = "test-key";
    vi.mocked(Agent.list).mockResolvedValue({
      items: [
        {
          runtime: "cloud",
          agentId: "cloud-agent-1",
          name: "Cloud agent",
          status: "finished",
          lastModified: Date.parse("2026-07-28T09:00:00.000Z"),
          archived: false,
          repos: [],
        },
      ],
    } as never);
    vi.mocked(Agent.listRuns).mockResolvedValue({ items: [] });
    vi.mocked(Agent.archive).mockResolvedValue();
    const context: ProviderContext = {
      providerId: "cursor-cloud",
      config: { apiKeyEnv: "AGENT_DECK_CURSOR_TEST_KEY" },
      dataDirectory: "/tmp/agent-deck-cursor-cloud-test",
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      now: () => "2026-07-28T09:42:31.000Z",
      registerIngress: () => undefined,
      checkpoints: {
        get: async () => undefined,
        set: async () => undefined,
      },
    };
    const plugin = createProviderPlugin();
    await plugin.initialise(context);
    await plugin.discover();

    await expect(
      plugin.execute({
        commandId: "command-archive",
        action: "archive",
        agentId: "cursor-cloud:cloud-agent-1",
      }),
    ).resolves.toEqual({
      commandId: "command-archive",
      status: "succeeded",
    });
    expect(Agent.archive).toHaveBeenCalledWith("cloud-agent-1", {
      apiKey: "test-key",
    });
    await plugin.dispose();
  });
});
