import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventStore } from "@agent-deck/event-store";
import type { AgentProviderPlugin } from "@agent-deck/provider-sdk";
import { ProviderManager } from "./provider-manager.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const managerWithUsage = (usage: NonNullable<AgentProviderPlugin["usage"]>) => {
  const manager = new ProviderManager(
    [],
    {} as EventStore,
    Fastify(),
    "/tmp/agent-deck-test",
    30_000,
    vi.fn(),
  );
  (
    manager as unknown as {
      providers: Array<{
        configuration: Record<string, unknown>;
        plugin: Pick<AgentProviderPlugin, "usage">;
        provider: { id: string };
      }>;
    }
  ).providers.push({
    configuration: {},
    plugin: { usage },
    provider: { id: "codex" },
  });
  return manager;
};

describe("ProviderManager usage cache", () => {
  it("deduplicates concurrent provider requests", async () => {
    let resolveUsage!: (value: {
      providerId: string;
      status: "available";
      windows: [];
      observedAt: string;
    }) => void;
    const usage = vi.fn(
      () =>
        new Promise<{
          providerId: string;
          status: "available";
          windows: [];
          observedAt: string;
        }>((resolve) => {
          resolveUsage = resolve;
        }),
    );
    const manager = managerWithUsage(usage);
    const first = manager.usage("codex");
    const second = manager.usage("codex");
    resolveUsage({
      providerId: "codex",
      status: "available",
      windows: [],
      observedAt: "2026-08-01T18:00:00.000Z",
    });

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(usage).toHaveBeenCalledOnce();
  });

  it("keeps the last available snapshot when refresh fails", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const usage = vi
      .fn()
      .mockResolvedValueOnce({
        providerId: "codex",
        status: "available",
        windows: [{ id: "primary", label: "5h", usedPercent: 42 }],
        observedAt: "2026-08-01T18:00:00.000Z",
      })
      .mockResolvedValueOnce({
        providerId: "codex",
        status: "rate_limited",
        windows: [],
        observedAt: "2026-08-01T18:02:00.000Z",
        message: "Try later",
      });
    const manager = managerWithUsage(usage);
    await manager.usage("codex");
    vi.spyOn(Date, "now").mockReturnValue(122_000);

    await expect(manager.usage("codex")).resolves.toMatchObject({
      status: "available",
      stale: true,
      message: "Try later",
    });
  });
});
