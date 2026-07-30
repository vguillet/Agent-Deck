import { describe, expect, it } from "vitest";
import type { Agent, Provider } from "@agent-deck/domain";
import {
  formatServerDashboard,
  type ServerDashboardSnapshot,
} from "./server-dashboard.js";

const snapshot = (): ServerDashboardSnapshot => ({
  health: { status: "degraded", connectedClients: 2 },
  providers: [
    {
      id: "cursor-local",
      displayName: "Cursor Local",
      health: "healthy",
      lastCheckedAt: "2026-07-29T08:19:55.000Z",
    } as Provider,
    {
      id: "codex",
      displayName: "Codex",
      health: "degraded",
      healthMessage: "Hook is unavailable",
    } as Provider,
  ],
  agents: [
    {
      id: "alive",
      providerId: "cursor-local",
      title: "Implement dashboard",
      state: "running",
      activityEpoch: "run-1",
      progress: {
        activity: "editing",
        plan: { completed: 2, total: 4 },
        observedAt: "2026-07-29T08:19:59.000Z",
      },
      lastActivityAt: "2026-07-29T08:19:50.000Z",
    } as Agent,
  ],
  address: "http://127.0.0.1:47831",
  updatedAt: "2026-07-29T08:20:00.000Z",
});

describe("server dashboard", () => {
  it("summarises global, connector, client, and alive-agent health", () => {
    const output = formatServerDashboard(snapshot());

    expect(output).toContain("Global health: DEGRADED");
    expect(output).toContain("2 connected clients");
    expect(output).toContain("Connectors (1/2 healthy)");
    expect(output).toContain("Codex: degraded — Hook is unavailable");
    expect(output).toContain("Alive agents (1)");
    expect(output).toContain("Implement dashboard · running");
    expect(output).toContain("editing 3/4");
  });
});
