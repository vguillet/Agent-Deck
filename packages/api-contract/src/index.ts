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
export const AgentProgressSchema = z.object({
  activity: z.enum([
    "planning",
    "exploring",
    "researching",
    "editing",
    "executing",
    "delegating",
    "waiting",
    "working",
  ]),
  plan: z
    .object({
      completed: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    })
    .refine((plan) => plan.completed <= plan.total)
    .optional(),
  observedAt: TimestampSchema,
});

export const AgentSchema = z.object({
  id: z.string().min(3),
  providerId: z.string().min(1),
  externalId: z.string().min(1),
  title: z.string().min(1),
  kind: z.enum(["top_level", "subagent"]).optional(),
  parentAgentId: z.string().min(3).optional(),
  projectId: z.string().optional(),
  workspaceId: z.string().optional(),
  state: AgentStateSchema,
  freshness: FreshnessSchema,
  activeRunId: z.string().optional(),
  requiresAttention: z.boolean(),
  lastActivityAt: TimestampSchema,
  revision: z.number().int().nonnegative(),
  sourceRevision: z.number().int().nonnegative().optional(),
  progress: AgentProgressSchema.optional(),
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
  sourceRevision: z.number().int().nonnegative().optional(),
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
    discoveryMode: z.enum(["poll", "startup"]).optional(),
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
    "agent.progress.changed",
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

export const CursorFocusTargetKindSchema = z.enum([
  "cursor.conversation",
  "codex.thread",
]);

export const CursorWindowRegistrationSchema = z.object({
  type: z.literal("window.register"),
  windowInstanceId: z.string().uuid(),
  workspaceRoots: z.array(z.string().min(1)).min(1).max(32),
  launchTarget: z.string().min(1),
  focused: z.boolean(),
  version: z.string().min(1),
  focusProtocolVersion: z.literal(2).optional(),
  focusKinds: z
    .array(CursorFocusTargetKindSchema)
    .min(1)
    .max(CursorFocusTargetKindSchema.options.length)
    .optional(),
});

export const CursorWindowStateSchema = z.object({
  type: z.literal("window.state"),
  focused: z.boolean(),
});

export const CursorFocusResultStatusSchema = z.enum([
  "opened",
  "unavailable",
  "ambiguous",
  "timeout",
  "superseded",
  "failed",
]);

export const CursorFocusResultFrameSchema = z.object({
  type: z.literal("focus.result"),
  requestId: z.string().uuid(),
  status: CursorFocusResultStatusSchema,
  message: z.string().optional(),
});

export const CursorConversationFocusTargetSchema = z.object({
  kind: z.literal("cursor.conversation"),
  conversationId: z.string().min(1),
  workspaceRoots: z.array(z.string().min(1)).min(1).max(32),
});

export const CodexThreadFocusTargetSchema = z.object({
  kind: z.literal("codex.thread"),
  threadId: z.string().min(1),
  cwd: z.string().min(1),
});

export const CursorFocusTargetSchema = z.discriminatedUnion("kind", [
  CursorConversationFocusTargetSchema,
  CodexThreadFocusTargetSchema,
]);

export const CursorFocusIntentFrameSchema = z.object({
  type: z.literal("focus.intent"),
  requestId: z.string().uuid(),
  target: CursorFocusTargetSchema,
});

export const CursorFocusCancelFrameSchema = z.object({
  type: z.literal("focus.cancel"),
  requestId: z.string().uuid(),
});

export const LegacyCursorFocusIntentFrameSchema = z.object({
  type: z.literal("focus.intent"),
  requestId: z.string().uuid(),
  conversationId: z.string().min(1),
});

export const CompatibleCursorFocusIntentFrameSchema = z.union([
  CursorFocusIntentFrameSchema,
  LegacyCursorFocusIntentFrameSchema,
]);

export const CursorWindowServerFrameSchema = z.union([
  CompatibleCursorFocusIntentFrameSchema,
  CursorFocusCancelFrameSchema,
]);

export const CursorWindowClientFrameSchema = z.discriminatedUnion("type", [
  CursorWindowRegistrationSchema,
  CursorWindowStateSchema,
  CursorFocusResultFrameSchema,
]);

export const CursorFocusResponseSchema = z.object({
  requestId: z.string().uuid(),
  status: CursorFocusResultStatusSchema,
  message: z.string().optional(),
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

export const AgentCommandRequestSchema = z.object({
  action: z.enum(["cancel", "archive"]),
  expectedRevision: z.number().int().nonnegative().optional(),
});

export const CommandResultSchema = z.object({
  commandId: z.string().min(1),
  status: z.enum(["succeeded", "failed", "unsupported"]),
  message: z.string().optional(),
});

export interface Page<T> {
  items: T[];
  nextCursor?: string;
  asOfSequence: number;
}

export type RegisterFrame = z.infer<typeof RegisterFrameSchema>;
export type SubscriptionFrame = z.infer<typeof SubscriptionSchema>;
export type CursorWindowRegistration = z.infer<
  typeof CursorWindowRegistrationSchema
>;
export type CursorFocusResult = z.infer<typeof CursorFocusResponseSchema>;
export type CursorFocusTarget = z.infer<typeof CursorFocusTargetSchema>;
export type CursorFocusTargetKind = z.infer<typeof CursorFocusTargetKindSchema>;
export type CursorFocusIntentFrame = z.infer<
  typeof CursorFocusIntentFrameSchema
>;
export type CompatibleCursorFocusIntentFrame = z.infer<
  typeof CompatibleCursorFocusIntentFrameSchema
>;
export type CursorFocusCancelFrame = z.infer<
  typeof CursorFocusCancelFrameSchema
>;
export type CursorWindowServerFrame = z.infer<
  typeof CursorWindowServerFrameSchema
>;

export const workspaceRootsKey = (roots: readonly string[]): string =>
  [...new Set(roots)].sort().join("\0");

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
