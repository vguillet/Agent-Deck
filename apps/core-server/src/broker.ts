import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type {
  AgentState,
  CanonicalEvent,
  ClientDescriptor,
  ClientPresence,
} from "@agent-deck/domain";
import type { EventStore } from "@agent-deck/event-store";

export type Topic =
  "agents.summary" | "attention" | "providers.health" | "system.health";

export interface Subscription {
  topics: Topic[];
  filter?: {
    providers?: string[];
    projects?: string[];
    agents?: string[];
    states?: AgentState[];
  };
}

interface Connection {
  id: string;
  socket: WebSocket;
  descriptor?: ClientDescriptor;
  connectedAt: string;
  lastSeenAt: string;
  subscription?: Subscription;
}

const topicsForEvent = (event: CanonicalEvent): Topic[] => {
  if (event.type.startsWith("attention.")) return ["attention"];
  if (event.type === "provider.health.changed")
    return ["providers.health", "system.health"];
  if (
    event.type === "agent.state.changed" ||
    event.type === "agent.progress.changed" ||
    event.type === "agent.freshness.changed" ||
    event.type === "agent.upserted"
  )
    return ["agents.summary", "attention"];
  return ["agents.summary"];
};

export class SubscriptionBroker {
  private readonly connections = new Map<string, Connection>();

  constructor(private readonly store: EventStore) {}

  add(socket: WebSocket): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.connections.set(id, {
      id,
      socket,
      connectedAt: now,
      lastSeenAt: now,
    });
    return id;
  }

  remove(connectionId: string): void {
    this.connections.delete(connectionId);
  }

  register(connectionId: string, descriptor: ClientDescriptor): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    connection.descriptor = descriptor;
    connection.lastSeenAt = new Date().toISOString();
  }

  subscribe(connectionId: string, subscription: Subscription): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    connection.subscription = subscription;
    connection.lastSeenAt = new Date().toISOString();
  }

  touch(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (connection) connection.lastSeenAt = new Date().toISOString();
  }

  get(connectionId: string): Connection | undefined {
    return this.connections.get(connectionId);
  }

  listPresence(): ClientPresence[] {
    return [...this.connections.values()]
      .filter(
        (
          connection,
        ): connection is Connection & { descriptor: ClientDescriptor } =>
          connection.descriptor !== undefined,
      )
      .map((connection) => ({
        descriptor: connection.descriptor,
        connectionId: connection.id,
        connectedAt: connection.connectedAt,
        lastSeenAt: connection.lastSeenAt,
      }))
      .sort((a, b) => a.descriptor.id.localeCompare(b.descriptor.id));
  }

  replay(connectionId: string, afterSequence: number): "ok" | "resync" {
    const connection = this.connections.get(connectionId);
    if (!connection?.subscription) return "ok";
    const earliest = this.store.earliestSequence();
    if (earliest !== undefined && afterSequence < earliest - 1) return "resync";
    let cursor = afterSequence;
    while (true) {
      const events = this.store.listEventsAfter(cursor, 500);
      for (const event of events) {
        this.sendEvent(connection, event);
        cursor = event.sequence;
      }
      if (events.length < 500) break;
    }
    return "ok";
  }

  publish(event: CanonicalEvent): void {
    for (const connection of this.connections.values()) {
      this.sendEvent(connection, event);
    }
  }

  requestResync(): void {
    const currentSequence = this.store.currentSequence();
    for (const connection of this.connections.values()) {
      this.send(connection, {
        type: "stream.resync_required",
        currentSequence,
      });
    }
  }

  heartbeat(): void {
    const now = new Date().toISOString();
    for (const connection of this.connections.values()) {
      this.send(connection, { type: "heartbeat", timestamp: now });
    }
  }

  private sendEvent(connection: Connection, event: CanonicalEvent): void {
    const subscription = connection.subscription;
    if (!subscription) return;
    if (
      !topicsForEvent(event).some((topic) =>
        subscription.topics.includes(topic),
      )
    )
      return;
    const filter = subscription.filter;
    if (
      filter?.providers?.length &&
      !filter.providers.includes(event.providerId)
    )
      return;
    if (filter?.agents?.length && !event.agentId) return;
    if (
      filter?.agents?.length &&
      event.agentId &&
      !filter.agents.includes(event.agentId)
    )
      return;
    if ((filter?.projects?.length || filter?.states?.length) && event.agentId) {
      const agent = this.store.getAgent(event.agentId);
      if (
        filter.projects?.length &&
        (!agent?.projectId || !filter.projects.includes(agent.projectId))
      )
        return;
      if (
        filter.states?.length &&
        (!agent || !filter.states.includes(agent.state))
      )
        return;
    }
    this.send(connection, { type: "event", event });
  }

  private send(connection: Connection, value: unknown): void {
    if (connection.socket.readyState !== connection.socket.OPEN) return;
    if (connection.socket.bufferedAmount > 1_048_576) {
      connection.socket.close(1013, "Slow consumer; reconnect with sequence");
      return;
    }
    connection.socket.send(JSON.stringify(value));
  }
}
