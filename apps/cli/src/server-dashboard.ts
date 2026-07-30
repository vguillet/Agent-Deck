import type { Agent, Provider } from "@agent-deck/domain";
import type { RunningAgentDeckServer } from "@agent-deck/core-server";

interface SystemHealth {
  status: "healthy" | "degraded";
  connectedClients: number;
}

export interface ServerDashboardSnapshot {
  health: SystemHealth;
  providers: Provider[];
  agents: Agent[];
  address: string;
  updatedAt: string;
}

interface DashboardOptions {
  refreshIntervalMs?: number;
  output?: NodeJS.WriteStream;
}

const symbol = (status: string): string => {
  if (status === "healthy" || status === "running") return "●";
  if (status === "degraded" || status.startsWith("waiting")) return "◐";
  if (status === "unhealthy" || status === "failed") return "✕";
  return "○";
};

const age = (timestamp: string, now: number): string => {
  const seconds = Math.max(
    0,
    Math.floor((now - new Date(timestamp).getTime()) / 1_000),
  );
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
};

const truncate = (value: string, length: number): string =>
  value.length <= length
    ? value
    : `${value.slice(0, Math.max(1, length - 1))}…`;

const planPosition = (agent: Agent): string => {
  const plan = agent.progress?.plan;
  if (!plan) return "";
  const current = Math.min(
    plan.total,
    plan.completed + Number(plan.completed < plan.total),
  );
  return ` ${current}/${plan.total}`;
};

export const formatServerDashboard = (
  snapshot: ServerDashboardSnapshot,
  width = 100,
): string => {
  const now = new Date(snapshot.updatedAt).getTime();
  const alive = snapshot.agents
    .sort(
      (left, right) =>
        new Date(right.lastActivityAt).getTime() -
        new Date(left.lastActivityAt).getTime(),
    );
  const healthyProviders = snapshot.providers.filter(
    (provider) => provider.health === "healthy",
  ).length;
  const lines = [
    "Agent Deck backend",
    `${symbol(snapshot.health.status)} Global health: ${snapshot.health.status.toUpperCase()}`,
    `  ${snapshot.address}  ·  ${snapshot.health.connectedClients} connected client${snapshot.health.connectedClients === 1 ? "" : "s"}`,
    "",
    `Connectors (${healthyProviders}/${snapshot.providers.length} healthy)`,
  ];

  if (snapshot.providers.length === 0) {
    lines.push("  ○ No connectors enabled");
  } else {
    for (const provider of snapshot.providers) {
      const details = provider.healthMessage
        ? ` — ${provider.healthMessage}`
        : "";
      const checked = provider.lastCheckedAt
        ? ` · checked ${age(provider.lastCheckedAt, now)}`
        : "";
      lines.push(
        truncate(
          `  ${symbol(provider.health)} ${provider.displayName}: ${provider.health}${details}${checked}`,
          width,
        ),
      );
    }
  }

  lines.push("", `Alive agents (${alive.length})`);
  if (alive.length === 0) {
    lines.push("  ○ No fresh agents");
  } else {
    for (const agent of alive) {
      const progress = agent.progress
        ? ` · ${agent.progress.activity}${planPosition(agent)}`
        : "";
      lines.push(
        truncate(
          `  ${symbol(agent.state)} ${agent.title} · ${agent.state}${progress} · ${agent.providerId} · ${age(agent.lastActivityAt, now)}`,
          width,
        ),
      );
    }
  }
  lines.push(
    "",
    `Updated ${new Date(snapshot.updatedAt).toLocaleTimeString()}`,
  );
  return lines.join("\n");
};

const readSnapshot = async (
  server: RunningAgentDeckServer,
): Promise<ServerDashboardSnapshot> => {
  const [healthResponse, providersResponse, agentsResponse] = await Promise.all(
    [
      server.app.inject({ method: "GET", url: "/api/v1/system/health" }),
      server.app.inject({ method: "GET", url: "/api/v1/providers?limit=200" }),
      server.app.inject({ method: "GET", url: "/api/v1/agents?limit=200" }),
    ],
  );
  if (
    healthResponse.statusCode !== 200 ||
    providersResponse.statusCode !== 200 ||
    agentsResponse.statusCode !== 200
  ) {
    throw new Error("Unable to read the server status");
  }
  const host =
    server.configuration.server.host === "0.0.0.0"
      ? "127.0.0.1"
      : server.configuration.server.host;
  return {
    health: healthResponse.json<SystemHealth>(),
    providers: providersResponse.json<{ items: Provider[] }>().items,
    agents: agentsResponse.json<{ items: Agent[] }>().items,
    address: `http://${host}:${server.configuration.server.port}`,
    updatedAt: new Date().toISOString(),
  };
};

export const startServerDashboard = (
  server: RunningAgentDeckServer,
  options: DashboardOptions = {},
): (() => void) => {
  const output = options.output ?? process.stdout;
  let refreshing = false;
  let stopped = false;
  const refresh = async (): Promise<void> => {
    if (refreshing || stopped) return;
    refreshing = true;
    try {
      const snapshot = await readSnapshot(server);
      const dashboard = formatServerDashboard(snapshot, output.columns ?? 100);
      output.write(`${output.isTTY ? "\u001B[2J\u001B[H" : ""}${dashboard}\n`);
    } catch (error) {
      server.app.log.warn({ error }, "Server dashboard refresh failed");
    } finally {
      refreshing = false;
    }
  };
  void refresh();
  if (!output.isTTY)
    return () => {
      stopped = true;
    };
  const timer = setInterval(
    () => void refresh(),
    options.refreshIntervalMs ?? 2_000,
  );
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
};
