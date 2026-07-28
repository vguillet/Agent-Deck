import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  AgentListQuerySchema,
  AgentJsonSchema,
  ListQuerySchema,
  decodeCursor,
  encodeCursor,
} from "@agent-deck/api-contract";
import type { EventStore, StorePage } from "@agent-deck/event-store";
import { RevisionConflictError } from "@agent-deck/event-store";
import type { SubscriptionBroker } from "./broker.js";

const pageResponse = <T>(
  store: EventStore,
  page: StorePage<T>,
  offset: number,
  limit: number,
): {
  items: T[];
  nextCursor?: string;
  asOfSequence: number;
} => ({
  items: page.items,
  ...(page.hasMore ? { nextCursor: encodeCursor(offset + limit) } : {}),
  asOfSequence: store.currentSequence(),
});

const parsePage = (query: unknown): { offset: number; limit: number } => {
  const parsed = ListQuerySchema.parse(query);
  return { offset: decodeCursor(parsed.cursor), limit: parsed.limit };
};

const notFound = (
  request: FastifyRequest,
  reply: FastifyReply,
  resource: string,
): FastifyReply =>
  reply.code(404).send({
    error: {
      code: "not_found",
      message: `${resource} was not found`,
      requestId: request.id,
    },
  });

export const registerApiRoutes = (
  app: FastifyInstance,
  store: EventStore,
  broker: SubscriptionBroker,
): void => {
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async () => ({
    status: "ready",
    sequence: store.currentSequence(),
  }));

  app.get("/api/v1/agents", async (request) => {
    const query = AgentListQuerySchema.parse(request.query);
    const offset = decodeCursor(query.cursor);
    const page = store.listAgents(
      {
        ...(query.providerId ? { providerId: query.providerId } : {}),
        ...(query.projectId ? { projectId: query.projectId } : {}),
        ...(query.state ? { state: query.state } : {}),
        ...(query.requiresAttention === undefined
          ? {}
          : { requiresAttention: query.requiresAttention }),
      },
      { offset, limit: query.limit },
    );
    return pageResponse(store, page, offset, query.limit);
  });

  app.get<{ Params: { id: string } }>(
    "/api/v1/agents/:id",
    async (request, reply) => {
      const agent = store.getAgent(request.params.id);
      return agent ?? notFound(request, reply, "Agent");
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/agents/:id/runs",
    async (request, reply) => {
      if (!store.getAgent(request.params.id))
        return notFound(request, reply, "Agent");
      const { offset, limit } = parsePage(request.query);
      return pageResponse(
        store,
        store.listRuns(request.params.id, { offset, limit }),
        offset,
        limit,
      );
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/agents/:id/events",
    async (request, reply) => {
      if (!store.getAgent(request.params.id))
        return notFound(request, reply, "Agent");
      const { offset, limit } = parsePage(request.query);
      return pageResponse(
        store,
        store.listEvents({ agentId: request.params.id }, { offset, limit }),
        offset,
        limit,
      );
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/runs/:id",
    async (request, reply) => {
      const run = store.getRun(request.params.id);
      return run ?? notFound(request, reply, "Run");
    },
  );

  const collection =
    <T>(list: (page: { offset: number; limit: number }) => StorePage<T>) =>
    async (request: FastifyRequest) => {
      const { offset, limit } = parsePage(request.query);
      return pageResponse(store, list({ offset, limit }), offset, limit);
    };

  app.get(
    "/api/v1/providers",
    collection((page) => store.listProviders(page)),
  );
  app.get(
    "/api/v1/workspaces",
    collection((page) => store.listWorkspaces(page)),
  );
  app.get(
    "/api/v1/projects",
    collection((page) => store.listProjects(page)),
  );
  app.get(
    "/api/v1/attention",
    collection((page) => store.listAttention(page)),
  );

  app.get("/api/v1/clients", async () => ({
    items: broker.listPresence(),
    asOfSequence: store.currentSequence(),
  }));

  app.get<{ Params: { clientId: string } }>(
    "/api/v1/clients/:clientId/configuration",
    async (request, reply) => {
      const document = store.getClientConfiguration(request.params.clientId);
      if (!document) return notFound(request, reply, "Client configuration");
      reply.header("etag", `"${document.revision}"`);
      return document;
    },
  );

  app.put<{
    Params: { clientId: string };
    Body: { schema?: unknown; data?: unknown };
  }>("/api/v1/clients/:clientId/configuration", async (request, reply) => {
    if (
      typeof request.body?.schema !== "string" ||
      !request.body.data ||
      typeof request.body.data !== "object" ||
      Array.isArray(request.body.data)
    ) {
      return reply.code(400).send({
        error: {
          code: "invalid_configuration",
          message: "schema and object data are required",
          requestId: request.id,
        },
      });
    }
    const match = request.headers["if-match"];
    const expectedRevision =
      typeof match === "string" ? Number(match.replaceAll('"', "")) : undefined;
    try {
      const document = store.putClientConfiguration(
        request.params.clientId,
        request.body.schema,
        request.body.data as Record<string, unknown>,
        expectedRevision,
      );
      reply.header("etag", `"${document.revision}"`);
      return document;
    } catch (error) {
      if (error instanceof RevisionConflictError) {
        return reply.code(409).send({
          error: {
            code: "revision_conflict",
            message: error.message,
            requestId: request.id,
          },
        });
      }
      throw error;
    }
  });

  app.get("/api/v1/system/health", async () => {
    const providers = store.listProviders({ offset: 0, limit: 200 }).items;
    return {
      status: providers.some((provider) => provider.health === "unhealthy")
        ? "degraded"
        : "healthy",
      sequence: store.currentSequence(),
      providers: providers.map((provider) => ({
        id: provider.id,
        health: provider.health,
      })),
      connectedClients: broker.listPresence().length,
      timestamp: new Date().toISOString(),
    };
  });

  app.get("/api/v1/openapi.json", async () => ({
    openapi: "3.1.0",
    info: { title: "Agent Deck API", version: "1.0.0" },
    servers: [{ url: "http://127.0.0.1:47831" }],
    components: { schemas: { Agent: AgentJsonSchema } },
    paths: Object.fromEntries(
      [
        "/api/v1/agents",
        "/api/v1/agents/{id}",
        "/api/v1/agents/{id}/runs",
        "/api/v1/agents/{id}/events",
        "/api/v1/runs/{id}",
        "/api/v1/providers",
        "/api/v1/workspaces",
        "/api/v1/projects",
        "/api/v1/attention",
        "/api/v1/clients",
        "/api/v1/clients/{clientId}/configuration",
        "/api/v1/system/health",
      ].map((path) => [
        path,
        { get: { responses: { "200": { description: "OK" } } } },
      ]),
    ),
  }));
};
