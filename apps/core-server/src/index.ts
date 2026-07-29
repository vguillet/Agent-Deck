import { dirname, resolve } from "node:path";
import Fastify, { LogController, type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import type { RawData } from "ws";
import {
  ClientDescriptorSchema,
  RegisterFrameSchema,
  SubscriptionSchema,
} from "@agent-deck/api-contract";
import { SqliteEventStore } from "@agent-deck/persistence-sqlite";
import { SubscriptionBroker } from "./broker.js";
import { loadConfiguration, type AgentDeckConfiguration } from "./config.js";
import { activateCursorWindow } from "./cursor-window-activator.js";
import { CursorWindowBroker } from "./cursor-window-broker.js";
import { ProviderManager } from "./provider-manager.js";
import { registerApiRoutes } from "./routes.js";

export interface RunningAgentDeckServer {
  app: FastifyInstance;
  configuration: AgentDeckConfiguration;
  close(): Promise<void>;
}

export const buildServer = async (
  configuration?: AgentDeckConfiguration,
): Promise<RunningAgentDeckServer> => {
  const config = configuration ?? (await loadConfiguration());
  const app = Fastify({
    logger: true,
    logController: new LogController({ disableRequestLogging: true }),
  });
  await app.register(websocket, {
    options: { maxPayload: 64 * 1024 },
  });
  const store = new SqliteEventStore(config.databasePath);
  store.migrate();
  store.clearAgents();
  const broker = new SubscriptionBroker(store);
  const cursorWindows = new CursorWindowBroker(activateCursorWindow);
  const providerManager = new ProviderManager(
    config.providers,
    store,
    app,
    resolve(dirname(config.databasePath), "providers"),
    config.healthIntervalMs,
    (event) => broker.publish(event),
  );
  await providerManager.initialise();
  providerManager.registerIngressRoutes();
  registerApiRoutes(app, store, broker, cursorWindows, providerManager);

  app.get("/internal/cursor-focus", { websocket: true }, (socket) => {
    const connectionId = cursorWindows.add(socket);
    const registrationTimeout = setTimeout(() => {
      if (!cursorWindows.isRegistered(connectionId))
        socket.close(1008, "Cursor window registration required");
    }, 10_000);
    registrationTimeout.unref();
    socket.on("message", (raw: RawData) => {
      let value: unknown;
      try {
        value = JSON.parse(raw.toString()) as unknown;
      } catch {
        socket.close(1008, "Invalid JSON");
        return;
      }
      if (!cursorWindows.handle(connectionId, value))
        socket.close(1008, "Invalid Cursor window frame");
      else if (cursorWindows.isRegistered(connectionId))
        clearTimeout(registrationTimeout);
    });
    socket.on("close", () => {
      clearTimeout(registrationTimeout);
      cursorWindows.remove(connectionId);
    });
  });

  app.get("/api/v1/stream", { websocket: true }, (socket) => {
    const connectionId = broker.add(socket);
    const registrationTimeout = setTimeout(() => {
      if (!broker.get(connectionId)?.descriptor)
        socket.close(1008, "Registration required");
    }, 10_000);
    registrationTimeout.unref();

    socket.on("message", (raw: RawData) => {
      broker.touch(connectionId);
      let value: unknown;
      try {
        value = JSON.parse(raw.toString()) as unknown;
      } catch {
        socket.send(JSON.stringify({ type: "error", code: "invalid_json" }));
        return;
      }
      const connection = broker.get(connectionId);
      if (!connection?.descriptor) {
        const parsed = RegisterFrameSchema.safeParse(value);
        if (!parsed.success) {
          socket.close(1008, "Valid registration required");
          return;
        }
        const descriptor = ClientDescriptorSchema.parse(parsed.data.client);
        broker.register(connectionId, {
          id: descriptor.id,
          type: descriptor.type,
          name: descriptor.name,
          version: descriptor.version,
          capabilities: descriptor.capabilities,
          ...(descriptor.metadata ? { metadata: descriptor.metadata } : {}),
        });
        clearTimeout(registrationTimeout);
        socket.send(
          JSON.stringify({
            type: "registered",
            connectionId,
            currentSequence: store.currentSequence(),
          }),
        );
        return;
      }
      const parsed = SubscriptionSchema.safeParse(value);
      if (!parsed.success) {
        socket.send(
          JSON.stringify({
            type: "error",
            code: "invalid_frame",
            details: parsed.error.flatten(),
          }),
        );
        return;
      }
      const filter = parsed.data.filter;
      broker.subscribe(connectionId, {
        topics: parsed.data.topics,
        ...(filter
          ? {
              filter: {
                ...(filter.providers ? { providers: filter.providers } : {}),
                ...(filter.projects ? { projects: filter.projects } : {}),
                ...(filter.agents ? { agents: filter.agents } : {}),
                ...(filter.states ? { states: filter.states } : {}),
              },
            }
          : {}),
      });
      const replay =
        parsed.data.afterSequence === undefined
          ? "ok"
          : broker.replay(connectionId, parsed.data.afterSequence);
      socket.send(
        JSON.stringify(
          replay === "resync"
            ? {
                type: "stream.resync_required",
                currentSequence: store.currentSequence(),
              }
            : {
                type: "subscribed",
                currentSequence: store.currentSequence(),
              },
        ),
      );
    });
    socket.on("close", () => {
      clearTimeout(registrationTimeout);
      broker.remove(connectionId);
    });
  });

  app.setErrorHandler((error, request, reply) => {
    const candidate = error as Error & { issues?: unknown };
    const validation = Array.isArray(candidate.issues);
    request.log.error({ error }, "Request failed");
    void reply.code(validation ? 400 : 500).send({
      error: {
        code: validation ? "validation_error" : "internal_error",
        message: validation ? candidate.message : "Internal server error",
        requestId: request.id,
      },
    });
  });

  await providerManager.start();

  const heartbeat = setInterval(() => broker.heartbeat(), 30_000);
  heartbeat.unref();
  const runMaintenance = (): void => {
    const now = new Date();
    for (const event of store.markStale(
      new Date(now.getTime() - config.staleAfterMs).toISOString(),
      now.toISOString(),
    )) {
      broker.publish(event);
    }
    store.pruneEvents(
      new Date(
        now.getTime() - config.retentionDays * 24 * 60 * 60 * 1_000,
      ).toISOString(),
    );
  };
  runMaintenance();
  const maintenance = setInterval(runMaintenance, 60_000);
  maintenance.unref();

  let closed = false;
  return {
    app,
    configuration: config,
    close: async () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearInterval(maintenance);
      cursorWindows.close();
      await providerManager.dispose();
      store.clearAgents();
      await app.close();
      store.close();
    },
  };
};

export const startServer = async (): Promise<RunningAgentDeckServer> => {
  const server = await buildServer();
  await server.app.listen(server.configuration.server);
  return server;
};

export * from "./config.js";
