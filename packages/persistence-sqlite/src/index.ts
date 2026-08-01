import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type {
  Agent,
  AgentRun,
  Attention,
  CanonicalEvent,
  ClientConfigurationDocument,
  Project,
  Provider,
  ProviderEvent,
  ProviderSnapshot,
  Workspace,
} from "@agent-deck/domain";
import {
  attentionForAgentState,
  isActiveAgentState,
  isTerminalVisibleAgentState,
} from "@agent-deck/domain";
import {
  RevisionConflictError,
  type AgentFilters,
  type EventStore,
  type PageRequest,
  type StorePage,
} from "@agent-deck/event-store";

type Row = Record<string, unknown>;

const isProvisionalAgent = (agent: Agent | undefined): boolean =>
  agent?.state === "idle" && agent.metadata.lifecycle === "provisional";

const MIGRATION = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  document TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  document TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  workspace_id TEXT,
  document TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  project_id TEXT,
  state TEXT NOT NULL,
  requires_attention INTEGER NOT NULL,
  last_activity_at TEXT NOT NULL,
  last_observed_at TEXT,
  revision INTEGER NOT NULL,
  document TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agents_order_idx
  ON agents(requires_attention DESC, last_activity_at DESC, id ASC);
CREATE TABLE IF NOT EXISTS dismissed_agent_epochs (
  agent_id TEXT NOT NULL,
  activity_epoch TEXT NOT NULL,
  dismissed_at TEXT NOT NULL,
  PRIMARY KEY(agent_id, activity_epoch)
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  state TEXT NOT NULL,
  started_at TEXT,
  revision INTEGER NOT NULL,
  document TEXT NOT NULL,
  FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS runs_agent_idx ON runs(agent_id, started_at DESC, id);
CREATE TABLE IF NOT EXISTS attention (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  agent_id TEXT,
  severity TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  resolved_at TEXT,
  document TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS attention_open_idx
  ON attention(resolved_at, severity DESC, opened_at DESC, id);
CREATE TABLE IF NOT EXISTS events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  provider_id TEXT NOT NULL,
  provider_event_id TEXT,
  type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  agent_id TEXT,
  run_id TEXT,
  agent_revision INTEGER,
  payload TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS events_provider_event_unique
  ON events(provider_id, provider_event_id)
  WHERE provider_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_agent_sequence_idx ON events(agent_id, sequence);
CREATE INDEX IF NOT EXISTS events_observed_idx ON events(observed_at);
CREATE TABLE IF NOT EXISTS provider_checkpoints (
  provider_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(provider_id, key)
);
CREATE TABLE IF NOT EXISTS client_configurations (
  client_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  document TEXT NOT NULL
);
`;

const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const stringify = (value: unknown): string => JSON.stringify(value);

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stable(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const equivalent = (left: unknown, right: unknown): boolean =>
  stable(left) === stable(right);

export class SqliteEventStore implements EventStore {
  private readonly db: Database.Database;
  private readonly incrementalProviders = new Set<string>();

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
  }

  migrate(): void {
    this.db.exec(MIGRATION);
    const recordMigration = this.db.prepare(
      "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)",
    );
    const appliedAt = new Date().toISOString();
    for (const version of [1, 2]) recordMigration.run(version, appliedAt);
    const version3 = this.db
      .prepare("SELECT 1 FROM schema_migrations WHERE version = 3")
      .get();
    if (!version3) {
      this.db.transaction(() => {
        this.db
          .prepare("DELETE FROM attention WHERE agent_id IS NOT NULL")
          .run();
        this.db.prepare("DELETE FROM events WHERE agent_id IS NOT NULL").run();
        this.db.prepare("DELETE FROM runs").run();
        this.db.prepare("DELETE FROM agents").run();
        this.db.exec(`
          DROP INDEX IF EXISTS agents_order_idx;
          CREATE TABLE agents_v3 (
            id TEXT PRIMARY KEY,
            provider_id TEXT NOT NULL,
            project_id TEXT,
            state TEXT NOT NULL,
            requires_attention INTEGER NOT NULL,
            last_activity_at TEXT NOT NULL,
            last_observed_at TEXT,
            revision INTEGER NOT NULL,
            document TEXT NOT NULL
          );
          DROP TABLE agents;
          ALTER TABLE agents_v3 RENAME TO agents;
          CREATE INDEX agents_order_idx
            ON agents(requires_attention DESC, last_activity_at DESC, id ASC);
        `);
        this.db.exec("DROP TABLE IF EXISTS deleted_agents");
        recordMigration.run(3, appliedAt);
      })();
    }
  }

  close(): void {
    this.db.close();
  }

  currentSequence(): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events")
      .get() as Row;
    return Number(row.sequence);
  }

  earliestSequence(): number | undefined {
    const row = this.db
      .prepare("SELECT MIN(sequence) AS sequence FROM events")
      .get() as Row;
    return row.sequence === null || row.sequence === undefined
      ? undefined
      : Number(row.sequence);
  }

  applyProviderEvent(input: ProviderEvent): CanonicalEvent | undefined {
    return this.db.transaction((event: ProviderEvent) => {
      if (
        event.type === "agent.upserted" ||
        event.type === "agent.state.changed" ||
        event.type === "agent.progress.changed"
      ) {
        const incoming = event.payload.agent as Agent | undefined;
        const existing = incoming ? this.getAgent(incoming.id) : undefined;
        if (
          incoming &&
          !isActiveAgentState(incoming.state) &&
          !isTerminalVisibleAgentState(incoming.state) &&
          !isProvisionalAgent(incoming)
        ) {
          if (!existing) return undefined;
          return this.applyProviderEvent({
            ...event,
            type: "agent.removed",
            payload: { agent: existing },
          });
        }
        if (
          incoming &&
          isTerminalVisibleAgentState(incoming.state) &&
          (!existing || existing.activityEpoch !== incoming.activityEpoch)
        )
          return undefined;
      }
      if (
        event.agentId &&
        event.type !== "agent.removed" &&
        event.type !== "run.removed" &&
        this.suppressDismissedEpoch(event)
      )
        return undefined;
      if (
        event.type !== "agent.removed" &&
        (event.type === "run.upserted" || event.type === "run.state.changed") &&
        event.agentId &&
        !this.getAgent(event.agentId)
      )
        return undefined;
      if (
        event.providerEventId &&
        this.db
          .prepare(
            "SELECT 1 FROM events WHERE provider_id = ? AND provider_event_id = ?",
          )
          .get(event.providerId, event.providerEventId)
      ) {
        return undefined;
      }

      const normalized = this.reduce(event);
      if (!normalized.changed) return undefined;

      const observedAt = new Date().toISOString();
      const eventId =
        event.providerEventId ??
        createHash("sha256")
          .update(
            stable({
              providerId: event.providerId,
              type: event.type,
              occurredAt: event.occurredAt,
              agentId: event.agentId,
              runId: event.runId,
              payload: normalized.payload,
            }),
          )
          .digest("base64url");

      const result = this.db
        .prepare(
          `INSERT INTO events(
            event_id, provider_id, provider_event_id, type, occurred_at,
            observed_at, agent_id, run_id, agent_revision, payload
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          eventId,
          event.providerId,
          event.providerEventId ?? null,
          event.type,
          event.occurredAt,
          observedAt,
          event.agentId ?? null,
          event.runId ?? null,
          normalized.agentRevision ?? null,
          stringify(normalized.payload),
        );

      return {
        ...event,
        eventId,
        sequence: Number(result.lastInsertRowid),
        observedAt,
        payload: normalized.payload,
        ...(normalized.agentRevision === undefined
          ? {}
          : { agentRevision: normalized.agentRevision }),
      };
    })(input);
  }

  applySnapshot(
    providerId: string,
    snapshot: ProviderSnapshot,
  ): CanonicalEvent[] {
    return this.db.transaction(() => {
      if (snapshot.reconciliation === "incremental")
        this.incrementalProviders.add(providerId);
      else this.incrementalProviders.delete(providerId);
      const output: CanonicalEvent[] = [];
      const push = (event: ProviderEvent): void => {
        const persisted = this.applyProviderEvent(event);
        if (persisted) output.push(persisted);
      };
      for (const workspace of snapshot.workspaces)
        push({
          providerId,
          type: "workspace.upserted",
          occurredAt: snapshot.observedAt,
          payload: { workspace },
        });
      for (const project of snapshot.projects)
        push({
          providerId,
          type: "project.upserted",
          occurredAt: snapshot.observedAt,
          payload: { project },
        });
      for (const agent of snapshot.agents)
        push({
          providerId,
          type: "agent.upserted",
          occurredAt: snapshot.observedAt,
          agentId: agent.id,
          payload: { agent },
        });
      for (const run of snapshot.runs) {
        if (!this.getAgent(run.agentId)) continue;
        push({
          providerId,
          type: "run.upserted",
          occurredAt: snapshot.observedAt,
          agentId: run.agentId,
          runId: run.id,
          payload: { run },
        });
      }
      for (const attention of snapshot.attention)
        push({
          providerId,
          type: "attention.opened",
          occurredAt: snapshot.observedAt,
          ...(attention.agentId ? { agentId: attention.agentId } : {}),
          ...(attention.runId ? { runId: attention.runId } : {}),
          payload: { attention },
        });
      if (snapshot.reconciliation === "authoritative") {
        const reported = new Set(snapshot.agents.map((agent) => agent.id));
        const reportedRuns = new Set(snapshot.runs.map((run) => run.id));
        const existingRuns = this.db
          .prepare("SELECT document FROM runs WHERE provider_id = ?")
          .all(providerId) as Row[];
        for (const row of existingRuns) {
          const run = parse<AgentRun>(row.document);
          if (reportedRuns.has(run.id) || !reported.has(run.agentId)) continue;
          push({
            providerId,
            type: "run.removed",
            occurredAt: snapshot.observedAt,
            agentId: run.agentId,
            runId: run.id,
            payload: { run },
          });
        }
        const existing = this.db
          .prepare("SELECT document FROM agents WHERE provider_id = ?")
          .all(providerId) as Row[];
        for (const row of existing) {
          const agent = parse<Agent>(row.document);
          if (
            reported.has(agent.id) ||
            isTerminalVisibleAgentState(agent.state)
          )
            continue;
          for (const run of this.listRuns(agent.id, {
            offset: 0,
            limit: Number.MAX_SAFE_INTEGER,
          }).items)
            push({
              providerId,
              type: "run.removed",
              occurredAt: snapshot.observedAt,
              agentId: agent.id,
              runId: run.id,
              payload: { run },
            });
          push({
            providerId,
            type: "agent.removed",
            occurredAt: snapshot.observedAt,
            agentId: agent.id,
            payload: { agent },
          });
        }
      }
      this.pruneResources();
      return output;
    })();
  }

  updateProvider(provider: Provider): CanonicalEvent | undefined {
    return this.applyProviderEvent({
      providerId: provider.id,
      type: "provider.health.changed",
      occurredAt: provider.lastCheckedAt ?? new Date().toISOString(),
      payload: { provider },
    });
  }

  private reduce(event: ProviderEvent): {
    changed: boolean;
    payload: Record<string, unknown>;
    agentRevision?: number;
  } {
    switch (event.type) {
      case "provider.health.changed":
        return this.upsertProvider(event.payload, event.occurredAt);
      case "workspace.upserted":
        return this.upsertWorkspace(event.payload);
      case "project.upserted":
        return this.upsertProject(event.payload);
      case "agent.upserted":
      case "agent.state.changed":
      case "agent.progress.changed":
        return this.upsertAgent(event.payload, event.occurredAt);
      case "agent.removed":
        return this.removeAgent(event.payload);
      case "run.upserted":
      case "run.state.changed":
        return this.upsertRun(event.payload);
      case "run.removed":
        return this.removeRun(event.payload);
      case "attention.opened":
        return this.openAttention(event.payload);
      case "attention.resolved":
        return this.resolveAttention(event.payload);
    }
  }

  private upsertDocument(
    table: "providers",
    keyColumn: "id",
    payload: Record<string, unknown>,
    property: "provider",
  ): { changed: boolean; payload: Record<string, unknown> } {
    const document = payload[property] as Provider;
    const existing = this.db
      .prepare(`SELECT document FROM ${table} WHERE ${keyColumn} = ?`)
      .get(document.id) as Row | undefined;
    if (existing && equivalent(parse(existing.document), document))
      return { changed: false, payload };
    this.db
      .prepare(
        `INSERT INTO ${table}(id, document) VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET document = excluded.document`,
      )
      .run(document.id, stringify(document));
    return { changed: true, payload: { [property]: document } };
  }

  private upsertProvider(
    payload: Record<string, unknown>,
    occurredAt: string,
  ): { changed: boolean; payload: Record<string, unknown> } {
    const result = this.upsertDocument("providers", "id", payload, "provider");
    if (!result.changed) return result;
    const provider = payload.provider as Provider;
    const id = `${provider.id}:provider-health`;
    if (provider.health === "unhealthy" || provider.health === "degraded") {
      const existing = this.db
        .prepare("SELECT document FROM attention WHERE id = ?")
        .get(id) as Row | undefined;
      const openedAt = existing
        ? parse<Attention>(existing.document).openedAt
        : occurredAt;
      const attention: Attention = {
        id,
        providerId: provider.id,
        type: "provider_health",
        severity: provider.health === "unhealthy" ? "critical" : "warning",
        summary:
          provider.healthMessage ??
          `${provider.displayName} is ${provider.health}`,
        actions: [],
        openedAt,
      };
      this.openAttention({ attention });
    } else {
      this.resolveAttention({ attentionId: id, resolvedAt: occurredAt });
    }
    return result;
  }

  private upsertWorkspace(payload: Record<string, unknown>): {
    changed: boolean;
    payload: Record<string, unknown>;
  } {
    const workspace = payload.workspace as Workspace;
    const existing = this.getDocument<Workspace>("workspaces", workspace.id);
    if (existing && equivalent(existing, workspace))
      return { changed: false, payload };
    this.db
      .prepare(
        `INSERT INTO workspaces(id, provider_id, document) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           provider_id = excluded.provider_id, document = excluded.document`,
      )
      .run(workspace.id, workspace.providerId, stringify(workspace));
    return { changed: true, payload: { workspace } };
  }

  private upsertProject(payload: Record<string, unknown>): {
    changed: boolean;
    payload: Record<string, unknown>;
  } {
    const project = payload.project as Project;
    const existing = this.getDocument<Project>("projects", project.id);
    if (existing && equivalent(existing, project))
      return { changed: false, payload };
    this.db
      .prepare(
        `INSERT INTO projects(id, provider_id, workspace_id, document)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET provider_id = excluded.provider_id,
           workspace_id = excluded.workspace_id, document = excluded.document`,
      )
      .run(
        project.id,
        project.providerId,
        project.workspaceId ?? null,
        stringify(project),
      );
    return { changed: true, payload: { project } };
  }

  private upsertAgent(
    payload: Record<string, unknown>,
    occurredAt: string,
  ): {
    changed: boolean;
    payload: Record<string, unknown>;
    agentRevision?: number;
  } {
    const incoming = payload.agent as Agent;
    const existing = this.getAgent(incoming.id);
    if (
      existing?.sourceRevision !== undefined &&
      incoming.sourceRevision !== undefined &&
      incoming.sourceRevision <= existing.sourceRevision
    )
      return { changed: false, payload };
    const candidate: Agent = {
      ...incoming,
      revision: existing?.revision ?? 0,
      ...(incoming.sourceRevision === undefined &&
      existing?.sourceRevision !== undefined
        ? { sourceRevision: existing.sourceRevision }
        : {}),
    };
    if (existing && equivalent(existing, candidate)) {
      this.db
        .prepare("UPDATE agents SET last_observed_at = ? WHERE id = ?")
        .run(occurredAt, incoming.id);
      return { changed: false, payload };
    }
    candidate.revision = (existing?.revision ?? 0) + 1;
    this.db
      .prepare(
        `INSERT INTO agents(
          id, provider_id, project_id, state, requires_attention,
          last_activity_at, last_observed_at, revision, document
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          provider_id = excluded.provider_id, project_id = excluded.project_id,
          state = excluded.state,
          requires_attention = excluded.requires_attention,
          last_activity_at = excluded.last_activity_at,
          last_observed_at = excluded.last_observed_at,
          revision = excluded.revision, document = excluded.document`,
      )
      .run(
        candidate.id,
        candidate.providerId,
        candidate.projectId ?? null,
        candidate.state,
        candidate.requiresAttention ? 1 : 0,
        candidate.lastActivityAt,
        occurredAt,
        candidate.revision,
        stringify(candidate),
      );
    this.reconcileStateAttention(candidate, occurredAt);
    return {
      changed: true,
      payload: { agent: candidate },
      agentRevision: candidate.revision,
    };
  }

  private removeAgent(payload: Record<string, unknown>): {
    changed: boolean;
    payload: Record<string, unknown>;
  } {
    const agent = payload.agent as Agent | undefined;
    if (!agent || !this.getAgent(agent.id)) return { changed: false, payload };
    this.db.prepare("DELETE FROM attention WHERE agent_id = ?").run(agent.id);
    this.db.prepare("DELETE FROM runs WHERE agent_id = ?").run(agent.id);
    this.db.prepare("DELETE FROM agents WHERE id = ?").run(agent.id);
    return { changed: true, payload: { agent } };
  }

  private removeRun(payload: Record<string, unknown>): {
    changed: boolean;
    payload: Record<string, unknown>;
  } {
    const run = payload.run as AgentRun | undefined;
    if (!run || !this.getRun(run.id)) return { changed: false, payload };
    this.db.prepare("DELETE FROM runs WHERE id = ?").run(run.id);
    return { changed: true, payload: { run } };
  }

  private reconcileStateAttention(agent: Agent, occurredAt: string): void {
    let attention = agent.requiresAttention
      ? attentionForAgentState(agent, occurredAt)
      : undefined;
    const id = `${agent.id}:state-attention`;
    if (!attention) {
      const existing = this.db
        .prepare(
          "SELECT document FROM attention WHERE id = ? AND resolved_at IS NULL",
        )
        .get(id) as Row | undefined;
      if (existing) {
        const resolved = {
          ...parse<Attention>(existing.document),
          resolvedAt: occurredAt,
        };
        this.db
          .prepare(
            "UPDATE attention SET resolved_at = ?, document = ? WHERE id = ?",
          )
          .run(occurredAt, stringify(resolved), id);
      }
      return;
    }
    const current = this.db
      .prepare(
        "SELECT document FROM attention WHERE id = ? AND resolved_at IS NULL",
      )
      .get(id) as Row | undefined;
    if (current) {
      attention = {
        ...attention,
        openedAt: parse<Attention>(current.document).openedAt,
      };
    }
    this.db
      .prepare(
        `INSERT INTO attention(
          id, provider_id, agent_id, severity, opened_at, resolved_at, document
        ) VALUES (?, ?, ?, ?, ?, NULL, ?)
        ON CONFLICT(id) DO UPDATE SET provider_id = excluded.provider_id,
          agent_id = excluded.agent_id, severity = excluded.severity,
          opened_at = CASE WHEN attention.resolved_at IS NULL
            THEN attention.opened_at ELSE excluded.opened_at END,
          resolved_at = NULL, document = excluded.document`,
      )
      .run(
        attention.id,
        attention.providerId,
        attention.agentId ?? null,
        attention.severity,
        attention.openedAt,
        stringify(attention),
      );
  }

  private upsertRun(payload: Record<string, unknown>): {
    changed: boolean;
    payload: Record<string, unknown>;
  } {
    const incoming = payload.run as AgentRun;
    const existing = this.getRun(incoming.id);
    if (
      existing?.sourceRevision !== undefined &&
      incoming.sourceRevision !== undefined &&
      incoming.sourceRevision <= existing.sourceRevision
    )
      return { changed: false, payload };
    const candidate: AgentRun = {
      ...incoming,
      revision: existing?.revision ?? 0,
    };
    if (existing && equivalent(existing, candidate))
      return { changed: false, payload };
    candidate.revision = (existing?.revision ?? 0) + 1;
    this.db
      .prepare(
        `INSERT INTO runs(
          id, agent_id, provider_id, state, started_at, revision, document
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET agent_id = excluded.agent_id,
          provider_id = excluded.provider_id, state = excluded.state,
          started_at = excluded.started_at, revision = excluded.revision,
          document = excluded.document`,
      )
      .run(
        candidate.id,
        candidate.agentId,
        candidate.providerId,
        candidate.state,
        candidate.startedAt ?? null,
        candidate.revision,
        stringify(candidate),
      );
    return { changed: true, payload: { run: candidate } };
  }

  private openAttention(payload: Record<string, unknown>): {
    changed: boolean;
    payload: Record<string, unknown>;
  } {
    const attention = payload.attention as Attention;
    const existing = this.db
      .prepare("SELECT document FROM attention WHERE id = ?")
      .get(attention.id) as Row | undefined;
    if (existing && equivalent(parse(existing.document), attention))
      return { changed: false, payload };
    this.db
      .prepare(
        `INSERT INTO attention(
          id, provider_id, agent_id, severity, opened_at, resolved_at, document
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET provider_id = excluded.provider_id,
          agent_id = excluded.agent_id, severity = excluded.severity,
          opened_at = excluded.opened_at, resolved_at = excluded.resolved_at,
          document = excluded.document`,
      )
      .run(
        attention.id,
        attention.providerId,
        attention.agentId ?? null,
        attention.severity,
        attention.openedAt,
        attention.resolvedAt ?? null,
        stringify(attention),
      );
    return { changed: true, payload: { attention } };
  }

  private resolveAttention(payload: Record<string, unknown>): {
    changed: boolean;
    payload: Record<string, unknown>;
  } {
    const attentionId = String(payload.attentionId);
    const resolvedAt = String(payload.resolvedAt);
    const row = this.db
      .prepare("SELECT document, resolved_at FROM attention WHERE id = ?")
      .get(attentionId) as Row | undefined;
    if (!row || row.resolved_at) return { changed: false, payload };
    const attention = {
      ...parse<Attention>(row.document),
      resolvedAt,
    };
    this.db
      .prepare(
        "UPDATE attention SET resolved_at = ?, document = ? WHERE id = ?",
      )
      .run(resolvedAt, stringify(attention), attentionId);
    return { changed: true, payload: { attentionId, resolvedAt } };
  }

  listAgents(filters: AgentFilters, page: PageRequest): StorePage<Agent> {
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    if (filters.providerId) {
      clauses.push("provider_id = ?");
      parameters.push(filters.providerId);
    }
    if (filters.projectId) {
      clauses.push("project_id = ?");
      parameters.push(filters.projectId);
    }
    if (filters.state) {
      clauses.push("state = ?");
      parameters.push(filters.state);
    }
    if (filters.requiresAttention !== undefined) {
      clauses.push("requires_attention = ?");
      parameters.push(filters.requiresAttention ? 1 : 0);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `SELECT document FROM agents ${where}
         ORDER BY requires_attention DESC, last_activity_at DESC, id ASC
         LIMIT ? OFFSET ?`,
      )
      .all(...parameters, page.limit + 1, page.offset) as Row[];
    return this.pageDocuments(rows, page.limit);
  }

  getAgent(id: string): Agent | undefined {
    return this.getDocument("agents", id);
  }

  dismissAgent(id: string): CanonicalEvent[] {
    return this.db.transaction((agentId: string) => {
      const agent = this.getAgent(agentId);
      if (!agent) return [];
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO dismissed_agent_epochs(agent_id, activity_epoch, dismissed_at)
           VALUES (?, ?, ?)
           ON CONFLICT(agent_id, activity_epoch) DO UPDATE SET
             dismissed_at = excluded.dismissed_at`,
        )
        .run(agent.id, agent.activityEpoch, now);
      const output: CanonicalEvent[] = [];
      for (const run of this.listRuns(agent.id, {
        offset: 0,
        limit: Number.MAX_SAFE_INTEGER,
      }).items) {
        const event = this.applyProviderEvent({
          providerId: agent.providerId,
          type: "run.removed",
          occurredAt: now,
          agentId: agent.id,
          runId: run.id,
          payload: { run },
        });
        if (event) output.push(event);
      }
      const event = this.applyProviderEvent({
        providerId: agent.providerId,
        type: "agent.removed",
        occurredAt: now,
        agentId: agent.id,
        payload: { agent },
      });
      if (event) output.push(event);
      this.pruneResources();
      return output;
    })(id);
  }

  dismissTerminalAgents(): CanonicalEvent[] {
    const agents = this.db
      .prepare(
        `SELECT document FROM agents
         WHERE state IN ('ready_for_review', 'failed', 'cancelled')`,
      )
      .all() as Row[];
    return agents.flatMap((row) =>
      this.dismissAgent(parse<Agent>(row.document).id),
    );
  }

  clearAgents(): number {
    return this.db.transaction(() => {
      const result = this.db.prepare("DELETE FROM agents").run();
      this.db.prepare("DELETE FROM attention WHERE agent_id IS NOT NULL").run();
      this.db
        .prepare(
          "DELETE FROM events WHERE agent_id IS NOT NULL OR run_id IS NOT NULL",
        )
        .run();
      this.db.prepare("DELETE FROM runs").run();
      this.pruneResources();
      return result.changes;
    })();
  }

  listRuns(agentId: string, page: PageRequest): StorePage<AgentRun> {
    const rows = this.db
      .prepare(
        `SELECT document FROM runs WHERE agent_id = ?
         ORDER BY started_at DESC, id ASC LIMIT ? OFFSET ?`,
      )
      .all(agentId, page.limit + 1, page.offset) as Row[];
    return this.pageDocuments(rows, page.limit);
  }

  getRun(id: string): AgentRun | undefined {
    return this.getDocument("runs", id);
  }

  listEventsAfter(sequence: number, limit: number): CanonicalEvent[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?",
        )
        .all(sequence, limit) as Row[]
    ).map((row) => this.eventFromRow(row));
  }

  listProviders(page: PageRequest): StorePage<Provider> {
    return this.listDocuments("providers", "id ASC", page);
  }

  listWorkspaces(page: PageRequest): StorePage<Workspace> {
    return this.listDocuments("workspaces", "id ASC", page);
  }

  listProjects(page: PageRequest): StorePage<Project> {
    return this.listDocuments("projects", "id ASC", page);
  }

  listAttention(page: PageRequest): StorePage<Attention> {
    const rows = this.db
      .prepare(
        `SELECT document FROM attention WHERE resolved_at IS NULL
         ORDER BY CASE severity WHEN 'critical' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END DESC,
         opened_at DESC, id ASC LIMIT ? OFFSET ?`,
      )
      .all(page.limit + 1, page.offset) as Row[];
    return this.pageDocuments(rows, page.limit);
  }

  getClientConfiguration(
    clientId: string,
  ): ClientConfigurationDocument | undefined {
    return this.getDocument("client_configurations", clientId, "client_id");
  }

  putClientConfiguration(
    clientId: string,
    schema: string,
    data: Record<string, unknown>,
    expectedRevision?: number,
  ): ClientConfigurationDocument {
    return this.db.transaction(() => {
      const existing = this.getClientConfiguration(clientId);
      if (
        expectedRevision !== undefined &&
        expectedRevision !== (existing?.revision ?? 0)
      ) {
        throw new RevisionConflictError();
      }
      const document: ClientConfigurationDocument = {
        clientId,
        schema,
        revision: (existing?.revision ?? 0) + 1,
        data,
        updatedAt: new Date().toISOString(),
      };
      this.db
        .prepare(
          `INSERT INTO client_configurations(client_id, revision, document)
           VALUES (?, ?, ?) ON CONFLICT(client_id) DO UPDATE SET
             revision = excluded.revision, document = excluded.document`,
        )
        .run(clientId, document.revision, stringify(document));
      return document;
    })();
  }

  getCheckpoint(providerId: string, key: string): string | undefined {
    const row = this.db
      .prepare(
        "SELECT value FROM provider_checkpoints WHERE provider_id = ? AND key = ?",
      )
      .get(providerId, key) as Row | undefined;
    return row ? String(row.value) : undefined;
  }

  setCheckpoint(providerId: string, key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO provider_checkpoints(provider_id, key, value, updated_at)
         VALUES (?, ?, ?, ?) ON CONFLICT(provider_id, key) DO UPDATE SET
           value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(providerId, key, value, new Date().toISOString());
  }

  expireLeases(beforeTimestamp: string, now: string): CanonicalEvent[] {
    if (!this.incrementalProviders.size) return [];
    const placeholders = [...this.incrementalProviders].map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT document FROM agents WHERE provider_id IN (${placeholders})
         AND COALESCE(last_observed_at, last_activity_at) < ? AND state IN (
           'idle', 'running', 'recovering', 'waiting_for_input',
           'waiting_for_approval'
         )`,
      )
      .all(...this.incrementalProviders, beforeTimestamp) as Row[];
    const output: CanonicalEvent[] = [];
    for (const row of rows) {
      const agent = parse<Agent>(row.document);
      for (const run of this.listRuns(agent.id, {
        offset: 0,
        limit: Number.MAX_SAFE_INTEGER,
      }).items) {
        const event = this.applyProviderEvent({
          providerId: agent.providerId,
          type: "run.removed",
          occurredAt: now,
          agentId: agent.id,
          runId: run.id,
          payload: { run },
        });
        if (event) output.push(event);
      }
      const event = this.applyProviderEvent({
        providerId: agent.providerId,
        type: "agent.removed",
        occurredAt: now,
        agentId: agent.id,
        payload: { agent },
      });
      if (event) output.push(event);
    }
    this.pruneResources();
    return output;
  }

  pruneEvents(beforeTimestamp: string): number {
    return this.db
      .prepare("DELETE FROM events WHERE observed_at < ?")
      .run(beforeTimestamp).changes;
  }

  private getDocument<T>(table: string, id: string, key = "id"): T | undefined {
    const row = this.db
      .prepare(`SELECT document FROM ${table} WHERE ${key} = ?`)
      .get(id) as Row | undefined;
    return row ? parse<T>(row.document) : undefined;
  }

  private suppressDismissedEpoch(event: ProviderEvent): boolean {
    const agent = event.payload.agent as Agent | undefined;
    if (!agent || agent.id !== event.agentId) return false;
    const dismissed = this.db
      .prepare(
        `SELECT 1 FROM dismissed_agent_epochs
         WHERE agent_id = ? AND activity_epoch = ?`,
      )
      .get(agent.id, agent.activityEpoch);
    if (dismissed) return true;
    this.db
      .prepare(
        "DELETE FROM dismissed_agent_epochs WHERE agent_id = ? AND activity_epoch <> ?",
      )
      .run(agent.id, agent.activityEpoch);
    return false;
  }

  private pruneResources(): void {
    this.db
      .prepare(
        `DELETE FROM projects
         WHERE id NOT IN (SELECT project_id FROM agents WHERE project_id IS NOT NULL)`,
      )
      .run();
    this.db
      .prepare(
        `DELETE FROM workspaces
         WHERE id NOT IN (
           SELECT json_extract(document, '$.workspaceId') FROM agents
           WHERE json_extract(document, '$.workspaceId') IS NOT NULL
           UNION
           SELECT workspace_id FROM projects WHERE workspace_id IS NOT NULL
         )`,
      )
      .run();
  }

  private listDocuments<T>(
    table: string,
    order: string,
    page: PageRequest,
  ): StorePage<T> {
    const rows = this.db
      .prepare(
        `SELECT document FROM ${table} ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .all(page.limit + 1, page.offset) as Row[];
    return this.pageDocuments(rows, page.limit);
  }

  private pageDocuments<T>(rows: Row[], limit: number): StorePage<T> {
    return {
      items: rows.slice(0, limit).map((row) => parse<T>(row.document)),
      hasMore: rows.length > limit,
    };
  }

  private eventFromRow(row: Row): CanonicalEvent {
    const base: CanonicalEvent = {
      sequence: Number(row.sequence),
      eventId: String(row.event_id),
      providerId: String(row.provider_id),
      type: String(row.type) as CanonicalEvent["type"],
      occurredAt: String(row.occurred_at),
      observedAt: String(row.observed_at),
      payload: parse<Record<string, unknown>>(row.payload),
    };
    if (row.provider_event_id)
      base.providerEventId = String(row.provider_event_id);
    if (row.agent_id) base.agentId = String(row.agent_id);
    if (row.run_id) base.runId = String(row.run_id);
    if (row.agent_revision !== null && row.agent_revision !== undefined)
      base.agentRevision = Number(row.agent_revision);
    return base;
  }
}

export const createMemoryStore = (): SqliteEventStore => {
  const store = new SqliteEventStore(":memory:");
  store.migrate();
  return store;
};

export const createSyntheticEventId = (): string => randomUUID();
export * from "./schema.js";
