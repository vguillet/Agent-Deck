import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const events = sqliteTable(
  "events",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    eventId: text("event_id").notNull(),
    providerId: text("provider_id").notNull(),
    providerEventId: text("provider_event_id"),
    type: text("type").notNull(),
    occurredAt: text("occurred_at").notNull(),
    observedAt: text("observed_at").notNull(),
    agentId: text("agent_id"),
    runId: text("run_id"),
    agentRevision: integer("agent_revision"),
    payload: text("payload").notNull(),
  },
  (table) => [
    uniqueIndex("events_event_id_unique").on(table.eventId),
    uniqueIndex("events_provider_event_unique").on(
      table.providerId,
      table.providerEventId,
    ),
    index("events_agent_sequence_idx").on(table.agentId, table.sequence),
  ],
);

export const agents = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey(),
    providerId: text("provider_id").notNull(),
    projectId: text("project_id"),
    state: text("state").notNull(),
    requiresAttention: integer("requires_attention", {
      mode: "boolean",
    }).notNull(),
    lastActivityAt: text("last_activity_at").notNull(),
    lastObservedAt: text("last_observed_at"),
    revision: integer("revision").notNull(),
    document: text("document").notNull(),
  },
  (table) => [
    index("agents_order_idx").on(
      table.requiresAttention,
      table.lastActivityAt,
      table.id,
    ),
  ],
);

export const dismissedAgentEpochs = sqliteTable(
  "dismissed_agent_epochs",
  {
    agentId: text("agent_id").notNull(),
    activityEpoch: text("activity_epoch").notNull(),
    dismissedAt: text("dismissed_at").notNull(),
  },
  (table) => [
    uniqueIndex("dismissed_agent_epochs_unique").on(
      table.agentId,
      table.activityEpoch,
    ),
  ],
);

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    providerId: text("provider_id").notNull(),
    state: text("state").notNull(),
    startedAt: text("started_at"),
    revision: integer("revision").notNull(),
    document: text("document").notNull(),
  },
  (table) => [index("runs_agent_idx").on(table.agentId, table.startedAt)],
);

export const clientConfigurations = sqliteTable("client_configurations", {
  clientId: text("client_id").primaryKey(),
  revision: integer("revision").notNull(),
  document: text("document").notNull(),
});
