import { z } from "zod";

export const AgentStateSchema = z.enum([
  "idle",
  "running",
  "waiting_for_input",
  "waiting_for_approval",
  "ready_for_review",
  "failed",
  "cancelled",
  "unknown",
]);
export const RunStateSchema = z.enum([
  "queued",
  "running",
  "waiting_for_input",
  "waiting_for_approval",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
]);
export const FreshnessSchema = z.enum(["fresh", "stale"]);
export const TimestampSchema = z.iso.datetime({ offset: true });
export const MetadataSchema = z.record(z.string(), z.unknown());

export const AgentSchema = z.object({
  id: z.string().min(3),
  providerId: z.string().min(1),
  externalId: z.string().min(1),
  title: z.string().min(1),
  projectId: z.string().optional(),
  workspaceId: z.string().optional(),
  state: AgentStateSchema,
  freshness: FreshnessSchema,
  activeRunId: z.string().optional(),
  requiresAttention: z.boolean(),
  lastActivityAt: TimestampSchema,
  revision: z.number().int().nonnegative(),
  archived: z.boolean(),
  capabilities: z.object({
    messages: z.boolean(),
    approvals: z.boolean(),
    cancellation: z.boolean(),
    creation: z.boolean(),
  }),
  links: z.array(
    z.object({
      rel: z.enum(["focus", "view"]),
      label: z.string().min(1),
      href: z.url(),
    }),
  ),
  metadata: MetadataSchema,
});

export const AgentJsonSchema = z.toJSONSchema(AgentSchema);

export const RunSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  providerId: z.string(),
  externalId: z.string(),
  state: RunStateSchema,
  promptSummary: z.string().optional(),
  startedAt: TimestampSchema.optional(),
  finishedAt: TimestampSchema.optional(),
  revision: z.number().int().nonnegative(),
  metadata: MetadataSchema,
});

export const AttentionSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  agentId: z.string().optional(),
  runId: z.string().optional(),
  type: z.enum([
    "input",
    "approval",
    "review",
    "failure",
    "stale",
    "provider_health",
  ]),
  severity: z.enum(["info", "warning", "critical"]),
  summary: z.string(),
  actions: z.array(z.string()),
  openedAt: TimestampSchema,
  resolvedAt: TimestampSchema.optional(),
});

export const ProviderSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  version: z.string(),
  health: z.enum(["starting", "healthy", "degraded", "unhealthy", "stopped"]),
  healthMessage: z.string().optional(),
  lastCheckedAt: TimestampSchema.optional(),
  consecutiveFailures: z.number().int().nonnegative(),
  capabilities: z.object({
    discovery: z.boolean(),
    liveEvents: z.boolean(),
    commands: z.array(z.string()),
  }),
});

export const WorkspaceSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  externalId: z.string(),
  name: z.string(),
  metadata: MetadataSchema,
});

export const ProjectSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  externalId: z.string(),
  workspaceId: z.string().optional(),
  name: z.string(),
  metadata: MetadataSchema,
});

export const EventSchema = z.object({
  sequence: z.number().int().nonnegative(),
  eventId: z.string(),
  providerId: z.string(),
  providerEventId: z.string().optional(),
  type: z.enum([
    "provider.health.changed",
    "workspace.upserted",
    "project.upserted",
    "agent.upserted",
    "agent.state.changed",
    "agent.freshness.changed",
    "run.upserted",
    "run.state.changed",
    "attention.opened",
    "attention.resolved",
  ]),
  occurredAt: TimestampSchema,
  observedAt: TimestampSchema,
  agentId: z.string().optional(),
  runId: z.string().optional(),
  agentRevision: z.number().int().nonnegative().optional(),
  payload: MetadataSchema,
});

export const ClientDescriptorSchema = z.object({
  id: z.string().min(1),
  type: z.enum([
    "stream-deck",
    "desktop",
    "web",
    "mobile",
    "cli",
    "automation",
    "custom",
  ]),
  name: z.string().min(1),
  version: z.string().min(1),
  capabilities: z.object({
    notifications: z.boolean(),
    images: z.boolean(),
    animations: z.boolean(),
    textInput: z.boolean(),
    approvalActions: z.boolean(),
  }),
  metadata: MetadataSchema.optional(),
});

export const SubscriptionSchema = z.object({
  type: z.literal("subscribe"),
  topics: z
    .array(
      z.enum([
        "agents.summary",
        "attention",
        "providers.health",
        "system.health",
      ]),
    )
    .min(1),
  afterSequence: z.number().int().nonnegative().optional(),
  filter: z
    .object({
      providers: z.array(z.string()).optional(),
      projects: z.array(z.string()).optional(),
      agents: z.array(z.string()).optional(),
      states: z.array(AgentStateSchema).optional(),
    })
    .optional(),
});

export const RegisterFrameSchema = z.object({
  type: z.literal("register"),
  client: ClientDescriptorSchema,
});

export const ListQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const AgentListQuerySchema = ListQuerySchema.extend({
  providerId: z.string().optional(),
  projectId: z.string().optional(),
  state: AgentStateSchema.optional(),
  requiresAttention: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
});

export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
    requestId: z.string(),
  }),
});

export interface Page<T> {
  items: T[];
  nextCursor?: string;
  asOfSequence: number;
}

export type RegisterFrame = z.infer<typeof RegisterFrameSchema>;
export type SubscriptionFrame = z.infer<typeof SubscriptionSchema>;

export const encodeCursor = (offset: number): string =>
  Buffer.from(String(offset), "utf8").toString("base64url");

export const decodeCursor = (cursor?: string): number => {
  if (!cursor) return 0;
  const decoded = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!Number.isSafeInteger(decoded) || decoded < 0) {
    throw new Error("Invalid cursor");
  }
  return decoded;
};
