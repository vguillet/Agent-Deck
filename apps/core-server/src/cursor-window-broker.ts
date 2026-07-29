import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { WebSocket } from "ws";
import {
  CursorWindowClientFrameSchema,
  workspaceRootsKey,
  type CursorFocusResult,
  type CursorFocusTarget,
  type CursorFocusTargetKind,
  type CursorWindowRegistration,
} from "@agent-deck/api-contract";

export type CursorWindowActivator = (target: string) => Promise<void>;

interface WindowConnection {
  id: string;
  socket: WebSocket;
  registration?: CursorWindowRegistration;
  focused: boolean;
  pending?: PendingFocus;
}

interface PendingFocus {
  requestId: string;
  targetKey: string;
  target: CursorFocusTarget;
  activated: boolean;
  acknowledgement?: CursorFocusResult;
  timer: NodeJS.Timeout;
  promise: Promise<CursorFocusResult>;
  resolve(result: CursorFocusResult): void;
}

interface WindowMatch {
  connection: WindowConnection;
  score: number;
}

const normalizedRoots = (roots: readonly string[]): string[] =>
  [...new Set(roots.map((root) => resolve(root)))].sort();

const registrationKey = (registration: CursorWindowRegistration): string =>
  [
    workspaceRootsKey(registration.workspaceRoots),
    registration.launchTarget,
    ...(registration.focusKinds ?? []),
  ].join("\0");

const targetKey = (target: CursorFocusTarget): string =>
  target.kind === "cursor.conversation"
    ? `${target.kind}:${target.conversationId}:${workspaceRootsKey(normalizedRoots(target.workspaceRoots))}`
    : `${target.kind}:${target.threadId}:${resolve(target.cwd)}`;

const pathContains = (root: string, path: string): boolean => {
  const nested = relative(root, path);
  return (
    nested === "" ||
    (nested !== ".." && !nested.startsWith(`..${sep}`) && !isAbsolute(nested))
  );
};

const supportedKinds = (
  registration: CursorWindowRegistration,
): CursorFocusTargetKind[] =>
  registration.focusKinds ?? ["cursor.conversation"];

export class CursorWindowBroker {
  private readonly connections = new Map<string, WindowConnection>();
  private readonly connectionsByWindow = new Map<string, string>();

  constructor(
    private readonly activate: CursorWindowActivator,
    private readonly timeoutMs = 5_000,
  ) {}

  add(socket: WebSocket): string {
    const id = randomUUID();
    this.connections.set(id, { id, socket, focused: false });
    return id;
  }

  remove(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    if (
      connection.registration &&
      this.connectionsByWindow.get(connection.registration.windowInstanceId) ===
        connectionId
    )
      this.connectionsByWindow.delete(connection.registration.windowInstanceId);
    this.finish(connection, {
      requestId: connection.pending?.requestId ?? randomUUID(),
      status: "failed",
      message: "Cursor window disconnected",
    });
    this.connections.delete(connectionId);
  }

  handle(connectionId: string, value: unknown): boolean {
    const connection = this.connections.get(connectionId);
    if (!connection) return false;
    const parsed = CursorWindowClientFrameSchema.safeParse(value);
    if (!parsed.success) return false;
    const frame = parsed.data;
    if (frame.type === "window.register")
      return this.register(connection, frame);
    if (!connection.registration) return false;
    if (frame.type === "window.state") {
      connection.focused = frame.focused;
      return true;
    }
    if (connection.pending?.requestId !== frame.requestId) return true;
    const result = {
      requestId: frame.requestId,
      status: frame.status,
      ...(frame.message ? { message: frame.message } : {}),
    } satisfies CursorFocusResult;
    if (result.status !== "opened") this.finish(connection, result);
    else {
      connection.pending.acknowledgement = result;
      if (connection.pending.activated) this.finish(connection, result);
    }
    return true;
  }

  async focus(target: CursorFocusTarget): Promise<CursorFocusResult> {
    const requestId = randomUUID();
    const validation = this.validateTarget(target);
    if (validation)
      return { requestId, status: "unavailable", message: validation };

    const matches = this.matches(target);
    if (!matches.length)
      return {
        requestId,
        status: "unavailable",
        message:
          target.kind === "cursor.conversation"
            ? "The agent's Cursor window is not open"
            : "No open Cursor window contains the Codex thread workspace",
      };
    const bestScore = Math.max(...matches.map(({ score }) => score));
    const bestMatches = matches.filter(({ score }) => score === bestScore);
    if (bestMatches.length > 1)
      return {
        requestId,
        status: "ambiguous",
        message: "More than one Cursor window matches this agent",
      };

    const connection = bestMatches[0]!.connection;
    const registration = connection.registration!;
    if (!supportedKinds(registration).includes(target.kind))
      return {
        requestId,
        status: "unavailable",
        message:
          target.kind === "codex.thread"
            ? "Update Agent Deck Focus in Cursor to open Codex threads"
            : "This Cursor window cannot focus this agent type",
      };

    const key = targetKey(target);
    if (connection.pending?.targetKey === key)
      return connection.pending.promise;
    if (connection.pending)
      this.finish(connection, {
        requestId: connection.pending.requestId,
        status: "failed",
        message: "Superseded by a newer focus request",
      });

    let resolveResult!: (result: CursorFocusResult) => void;
    const promise = new Promise<CursorFocusResult>((resolvePromise) => {
      resolveResult = resolvePromise;
    });
    const timer = setTimeout(() => {
      this.finish(connection, {
        requestId,
        status: "timeout",
        message: "Cursor did not acknowledge the focus request",
      });
    }, this.timeoutMs);
    timer.unref();
    connection.pending = {
      requestId,
      targetKey: key,
      target,
      activated: false,
      timer,
      promise,
      resolve: resolveResult,
    };

    if (!this.sendIntent(connection, target, requestId)) return promise;
    let activation: Promise<void>;
    try {
      activation = this.activate(registration.launchTarget);
    } catch (error) {
      this.finish(connection, {
        requestId,
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
      return promise;
    }
    void activation.then(
      () => {
        const pending = connection.pending;
        if (!pending || pending.requestId !== requestId) return;
        pending.activated = true;
        if (pending.acknowledgement)
          this.finish(connection, pending.acknowledgement);
      },
      (error: unknown) => {
        this.finish(connection, {
          requestId,
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return promise;
  }

  close(): void {
    for (const connection of [...this.connections.values()]) {
      this.remove(connection.id);
      try {
        connection.socket.close(1001, "Agent Deck server stopping");
      } catch {
        // The socket may already be closing.
      }
    }
  }

  isRegistered(connectionId: string): boolean {
    return this.connections.get(connectionId)?.registration !== undefined;
  }

  registeredCount(): number {
    return [...this.connections.values()].filter(
      (connection) => connection.registration,
    ).length;
  }

  private register(
    connection: WindowConnection,
    frame: CursorWindowRegistration,
  ): boolean {
    if (
      !isAbsolute(frame.launchTarget) ||
      frame.workspaceRoots.some((root) => !isAbsolute(root))
    )
      return false;
    if (
      connection.registration &&
      connection.registration.windowInstanceId !== frame.windowInstanceId
    )
      return false;

    const registration: CursorWindowRegistration = {
      ...frame,
      workspaceRoots: normalizedRoots(frame.workspaceRoots),
      launchTarget: resolve(frame.launchTarget),
      ...(frame.focusKinds
        ? { focusKinds: [...new Set(frame.focusKinds)].sort() }
        : {}),
    };
    const previousConnectionId = this.connectionsByWindow.get(
      registration.windowInstanceId,
    );
    if (previousConnectionId && previousConnectionId !== connection.id) {
      const previous = this.connections.get(previousConnectionId);
      if (previous) {
        this.remove(previous.id);
        try {
          previous.socket.close(1012, "Cursor window reconnected");
        } catch {
          // The replaced socket may already be closing.
        }
      }
    }
    if (
      connection.registration &&
      registrationKey(connection.registration) !== registrationKey(registration)
    )
      this.finish(connection, {
        requestId: connection.pending?.requestId ?? randomUUID(),
        status: "failed",
        message: "Cursor window registration changed",
      });

    connection.registration = registration;
    connection.focused = registration.focused;
    this.connectionsByWindow.set(registration.windowInstanceId, connection.id);
    return true;
  }

  private validateTarget(target: CursorFocusTarget): string | undefined {
    if (target.kind === "cursor.conversation") {
      if (!target.conversationId.trim())
        return "The agent has no Cursor conversation ID";
      if (!target.workspaceRoots.length)
        return "The agent has no Cursor workspace identity";
      if (target.workspaceRoots.some((root) => !isAbsolute(root)))
        return "The agent has an invalid Cursor workspace identity";
      return;
    }
    if (!target.threadId.trim()) return "The Codex thread has no ID";
    if (!isAbsolute(target.cwd))
      return "The Codex thread has no valid working directory";
    return;
  }

  private matches(target: CursorFocusTarget): WindowMatch[] {
    if (target.kind === "cursor.conversation") {
      const key = workspaceRootsKey(normalizedRoots(target.workspaceRoots));
      return [...this.connections.values()].flatMap((connection) => {
        const registration = connection.registration;
        return registration &&
          workspaceRootsKey(registration.workspaceRoots) === key
          ? [{ connection, score: 0 }]
          : [];
      });
    }

    const cwd = resolve(target.cwd);
    return [...this.connections.values()].flatMap((connection) => {
      const roots =
        connection.registration?.workspaceRoots.filter((root) =>
          pathContains(root, cwd),
        ) ?? [];
      return roots.length
        ? [{ connection, score: Math.max(...roots.map((root) => root.length)) }]
        : [];
    });
  }

  private sendIntent(
    connection: WindowConnection,
    target: CursorFocusTarget,
    requestId: string,
  ): boolean {
    if (connection.socket.readyState !== connection.socket.OPEN) {
      this.finish(connection, {
        requestId,
        status: "failed",
        message: "Cursor window connection is not open",
      });
      return false;
    }
    const modern = connection.registration?.focusKinds !== undefined;
    const frame =
      modern || target.kind === "codex.thread"
        ? { type: "focus.intent", requestId, target }
        : {
            type: "focus.intent",
            requestId,
            conversationId: target.conversationId,
          };
    try {
      connection.socket.send(JSON.stringify(frame), (error) => {
        if (!error) return;
        this.finish(connection, {
          requestId,
          status: "failed",
          message: error.message,
        });
      });
      return true;
    } catch (error) {
      this.finish(connection, {
        requestId,
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private finish(
    connection: WindowConnection,
    result: CursorFocusResult,
  ): void {
    const pending = connection.pending;
    if (!pending || pending.requestId !== result.requestId) return;
    clearTimeout(pending.timer);
    delete connection.pending;
    pending.resolve(result);
  }
}
