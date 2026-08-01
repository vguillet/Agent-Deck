import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  CursorWindowServerFrameSchema,
  type AgentCreationIntentFrame,
  type AgentCreationProviderId,
  type CompatibleCursorFocusIntentFrame,
  type CursorFocusTarget,
} from "@agent-deck/api-contract";
import type { Workspace } from "@agent-deck/domain";

export interface CursorWindowSnapshot {
  workspaceRoots: string[];
  launchTarget?: string;
  focused: boolean;
}

export interface FocusSocket {
  readonly OPEN: number;
  readonly readyState: number;
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (raw: { toString(): string }) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  send(value: string): void;
  close(code?: number, reason?: string): void;
}

export interface CursorWindowClientDependencies {
  getServerUrl(): string;
  getWindowSnapshot(): CursorWindowSnapshot;
  createSocket(url: URL): FocusSocket;
  executeTarget(
    target: CursorFocusTarget,
  ): Promise<CursorTargetExecutionResult>;
  createAgent(
    providerId: AgentCreationProviderId,
  ): Promise<CursorTargetExecutionResult>;
  workspaceRegistered(workspace: Workspace): void;
  random(): number;
  log(message: string, error?: unknown): void;
}

export type CursorTargetExecutionResult =
  { status: "opened" } | { status: "unavailable" | "failed"; message: string };

type CursorWindowIntent =
  CompatibleCursorFocusIntentFrame | AgentCreationIntentFrame;

const normalizedSnapshot = (
  snapshot: CursorWindowSnapshot,
): CursorWindowSnapshot => ({
  ...snapshot,
  workspaceRoots: [
    ...new Set(snapshot.workspaceRoots.map((root) => resolve(root))),
  ].sort(),
  ...(snapshot.launchTarget
    ? { launchTarget: resolve(snapshot.launchTarget) }
    : {}),
});

export class CursorWindowClient {
  private readonly windowInstanceId: string;
  private socket: FocusSocket | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private retryMs = 250;
  private pendingIntent: CursorWindowIntent | undefined;
  private executingIntent: CursorWindowIntent | undefined;
  private readonly cancelledExecutions = new Set<string>();
  private executing = false;
  private disposed = false;

  constructor(
    private readonly dependencies: CursorWindowClientDependencies,
    private readonly version: string,
    windowInstanceId = randomUUID(),
  ) {
    this.windowInstanceId = windowInstanceId;
  }

  start(): void {
    this.connect();
  }

  workspaceChanged(): void {
    const snapshot = normalizedSnapshot(this.dependencies.getWindowSnapshot());
    if (!this.validSnapshot(snapshot)) {
      this.disconnect("Cursor workspace is not focusable");
      return;
    }
    const socket = this.socket;
    if (socket && socket.readyState === socket.OPEN)
      this.sendRegistration(snapshot);
    else this.connect();
  }

  configurationChanged(): void {
    this.disconnect("Agent Deck server configuration changed");
    this.connect();
  }

  windowStateChanged(focused: boolean): void {
    this.send({ type: "window.state", focused });
    if (focused) void this.flush();
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.disconnect("Cursor window closed");
  }

  private connect(): void {
    if (this.disposed || this.socket || this.reconnectTimer) return;
    const snapshot = normalizedSnapshot(this.dependencies.getWindowSnapshot());
    if (!this.validSnapshot(snapshot)) return;

    let url: URL;
    try {
      url = new URL(this.dependencies.getServerUrl());
      if (url.protocol !== "http:" && url.protocol !== "https:")
        throw new Error("Agent Deck server URL must use HTTP or HTTPS");
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.pathname = "/internal/cursor-focus";
      url.search = "";
      url.hash = "";
    } catch (error) {
      this.dependencies.log("Invalid Agent Deck server URL", error);
      return;
    }

    let socket: FocusSocket;
    try {
      socket = this.dependencies.createSocket(url);
    } catch (error) {
      this.dependencies.log("Could not create Agent Deck connection", error);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.on("open", () => {
      if (this.socket !== socket) return;
      this.retryMs = 250;
      const current = normalizedSnapshot(this.dependencies.getWindowSnapshot());
      if (!this.validSnapshot(current)) {
        this.disconnect("Cursor workspace is not focusable");
        return;
      }
      this.sendRegistration(current);
    });
    socket.on("message", (raw) => {
      if (this.socket !== socket) return;
      let value: unknown;
      try {
        value = JSON.parse(raw.toString()) as unknown;
      } catch {
        return;
      }
      const parsed = CursorWindowServerFrameSchema.safeParse(value);
      if (!parsed.success) return;
      if (parsed.data.type === "window.registered") {
        this.dependencies.workspaceRegistered(
          parsed.data.workspace as Workspace,
        );
        return;
      }
      if (
        parsed.data.type === "focus.cancel" ||
        parsed.data.type === "creation.cancel"
      ) {
        if (this.pendingIntent?.requestId === parsed.data.requestId)
          this.pendingIntent = undefined;
        if (this.executingIntent?.requestId === parsed.data.requestId)
          this.cancelledExecutions.add(parsed.data.requestId);
        return;
      }
      if (this.pendingIntent)
        this.send({
          type: "focus.result",
          requestId: this.pendingIntent.requestId,
          status: "superseded",
          message: "Superseded by a newer focus request",
        });
      this.pendingIntent = parsed.data;
      void this.flush();
    });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.pendingIntent = undefined;
      this.scheduleReconnect();
    });
    socket.on("error", (error) => {
      this.dependencies.log("Agent Deck Cursor connection failed", error);
      if (this.socket !== socket) return;
      this.disconnect("Agent Deck connection failed");
      this.scheduleReconnect();
    });
  }

  private disconnect(reason: string): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    this.pendingIntent = undefined;
    try {
      socket?.close(1000, reason);
    } catch (error) {
      this.dependencies.log(
        "Could not close Agent Deck Cursor connection",
        error,
      );
    }
  }

  private async flush(): Promise<void> {
    if (
      this.executing ||
      !normalizedSnapshot(this.dependencies.getWindowSnapshot()).focused
    )
      return;
    this.executing = true;
    try {
      while (
        this.pendingIntent &&
        normalizedSnapshot(this.dependencies.getWindowSnapshot()).focused
      ) {
        const intent = this.pendingIntent;
        this.pendingIntent = undefined;
        this.executingIntent = intent;
        const snapshot = normalizedSnapshot(
          this.dependencies.getWindowSnapshot(),
        );
        let result: CursorTargetExecutionResult;
        try {
          if (intent.type === "creation.intent")
            result = await this.dependencies.createAgent(intent.providerId);
          else {
            const target: CursorFocusTarget =
              "target" in intent
                ? intent.target
                : {
                    kind: "cursor.conversation",
                    conversationId: intent.conversationId,
                    workspaceRoots: snapshot.workspaceRoots,
                  };
            result = await this.dependencies.executeTarget(target);
          }
        } catch (error) {
          result = {
            status: "failed",
            message: error instanceof Error ? error.message : String(error),
          };
        }
        this.send({
          type:
            intent.type === "creation.intent"
              ? "creation.result"
              : "focus.result",
          requestId: intent.requestId,
          status: result.status,
          ...("message" in result ? { message: result.message } : {}),
        });
        this.cancelledExecutions.delete(intent.requestId);
        if (this.executingIntent?.requestId === intent.requestId)
          this.executingIntent = undefined;
      }
    } finally {
      this.executingIntent = undefined;
      this.executing = false;
      if (
        this.pendingIntent &&
        normalizedSnapshot(this.dependencies.getWindowSnapshot()).focused
      )
        void this.flush();
    }
  }

  private sendRegistration(snapshot: CursorWindowSnapshot): void {
    if (
      this.send({
        type: "window.register",
        windowInstanceId: this.windowInstanceId,
        workspaceRoots: snapshot.workspaceRoots,
        launchTarget: snapshot.launchTarget!,
        focused: snapshot.focused,
        version: this.version,
        focusProtocolVersion: 2,
        focusKinds: ["cursor.conversation", "codex.thread", "claude.session"],
        creationProviderIds: ["cursor-local", "codex", "claude-code"],
      })
    )
      return;
    this.disconnect("Could not register Cursor window");
    this.scheduleReconnect();
  }

  private send(value: unknown): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== socket.OPEN) return false;
    try {
      socket.send(JSON.stringify(value));
      return true;
    } catch (error) {
      this.dependencies.log("Could not send Agent Deck Cursor frame", error);
      return false;
    }
  }

  private scheduleReconnect(): void {
    if (
      this.disposed ||
      this.reconnectTimer ||
      !this.validSnapshot(
        normalizedSnapshot(this.dependencies.getWindowSnapshot()),
      )
    )
      return;
    const delay = Math.min(
      10_000,
      Math.round(this.retryMs * (1 + this.dependencies.random() * 0.2)),
    );
    this.retryMs = Math.min(this.retryMs * 2, 10_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }

  private validSnapshot(
    snapshot: CursorWindowSnapshot,
  ): snapshot is CursorWindowSnapshot & { launchTarget: string } {
    return Boolean(snapshot.workspaceRoots.length && snapshot.launchTarget);
  }
}
