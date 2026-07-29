import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type {
  CursorFocusTarget,
  CursorFocusTargetKind,
} from "@agent-deck/api-contract";
import { CursorWindowBroker } from "./cursor-window-broker.js";

class FakeSocket {
  readonly OPEN = 1;
  readyState = this.OPEN;
  readonly sent: string[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  sendError: Error | undefined;
  throwOnSend: Error | undefined;

  send(value: string, callback?: (error?: Error) => void): void {
    if (this.throwOnSend) throw this.throwOnSend;
    this.sent.push(value);
    callback?.(this.sendError);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closes.push({
      ...(code ? { code } : {}),
      ...(reason ? { reason } : {}),
    });
  }
}

const cursorTarget = (
  conversationId = "conversation-1",
  roots = ["/workspace/alpha"],
): CursorFocusTarget => ({
  kind: "cursor.conversation",
  conversationId,
  workspaceRoots: roots,
});

const codexTarget = (
  threadId = "thread-1",
  cwd = "/workspace/alpha/project",
): CursorFocusTarget => ({
  kind: "codex.thread",
  threadId,
  cwd,
});

let nextWindow = 1;
const register = (
  broker: CursorWindowBroker,
  socket: FakeSocket,
  roots: string[],
  options: {
    focused?: boolean;
    focusKinds?: CursorFocusTargetKind[] | null;
    instanceId?: string;
    launchTarget?: string;
    version?: string;
  } = {},
): string => {
  const connectionId = broker.add(socket as unknown as WebSocket);
  const serial = nextWindow++;
  expect(
    broker.handle(connectionId, {
      type: "window.register",
      windowInstanceId:
        options.instanceId ??
        `00000000-0000-4000-8000-${String(serial).padStart(12, "0")}`,
      workspaceRoots: roots,
      launchTarget:
        options.launchTarget ??
        `/workspace/window-${String(serial)}.code-workspace`,
      focused: options.focused ?? false,
      version: options.version ?? "0.3.0",
      ...(options.focusKinds === null
        ? {}
        : {
            focusKinds: options.focusKinds ?? [
              "cursor.conversation",
              "codex.thread",
            ],
          }),
    }),
  ).toBe(true);
  return connectionId;
};

const acknowledgeLatest = (
  broker: CursorWindowBroker,
  connectionId: string,
  socket: FakeSocket,
): string => {
  const intent = JSON.parse(socket.sent.at(-1)!) as { requestId: string };
  expect(
    broker.handle(connectionId, {
      type: "focus.result",
      requestId: intent.requestId,
      status: "opened",
    }),
  ).toBe(true);
  return intent.requestId;
};

afterEach(() => {
  vi.useRealTimers();
});

describe("Cursor window broker", () => {
  it("activates the exact window even when focused and awaits acknowledgement", async () => {
    const activate = vi.fn(async () => undefined);
    const broker = new CursorWindowBroker(activate);
    const socket = new FakeSocket();
    const connectionId = register(
      broker,
      socket,
      ["/workspace/beta", "/workspace/alpha"],
      {
        focused: true,
        launchTarget: "/workspace/project.code-workspace",
      },
    );

    const resultPromise = broker.focus(
      cursorTarget("conversation-123", ["/workspace/alpha", "/workspace/beta"]),
    );
    expect(activate).toHaveBeenCalledWith("/workspace/project.code-workspace");
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({
      type: "focus.intent",
      target: {
        kind: "cursor.conversation",
        conversationId: "conversation-123",
      },
    });
    const requestId = acknowledgeLatest(broker, connectionId, socket);
    await expect(resultPromise).resolves.toEqual({
      requestId,
      status: "opened",
    });
  });

  it("retains legacy Cursor conversation framing", async () => {
    const broker = new CursorWindowBroker(vi.fn(async () => undefined));
    const socket = new FakeSocket();
    const connectionId = register(broker, socket, ["/workspace/alpha"], {
      version: "0.2.0",
      focusKinds: null,
    });

    const resultPromise = broker.focus(cursorTarget());
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({
      type: "focus.intent",
      conversationId: "conversation-1",
    });
    expect(JSON.parse(socket.sent[0]!)).not.toHaveProperty("target");
    acknowledgeLatest(broker, connectionId, socket);
    await expect(resultPromise).resolves.toMatchObject({ status: "opened" });
  });

  it("routes Codex to the unique window with the longest containing root", async () => {
    const activate = vi.fn(async () => undefined);
    const broker = new CursorWindowBroker(activate);
    register(broker, new FakeSocket(), ["/workspace"], {
      launchTarget: "/workspace/broad.code-workspace",
    });
    const exactSocket = new FakeSocket();
    const exactConnection = register(
      broker,
      exactSocket,
      ["/workspace/alpha"],
      { launchTarget: "/workspace/alpha.code-workspace" },
    );

    const resultPromise = broker.focus(codexTarget());
    expect(activate).toHaveBeenCalledOnce();
    expect(activate).toHaveBeenCalledWith("/workspace/alpha.code-workspace");
    expect(JSON.parse(exactSocket.sent[0]!)).toMatchObject({
      target: {
        kind: "codex.thread",
        threadId: "thread-1",
        cwd: "/workspace/alpha/project",
      },
    });
    acknowledgeLatest(broker, exactConnection, exactSocket);
    await expect(resultPromise).resolves.toMatchObject({ status: "opened" });
  });

  it("fails safely for missing and duplicate best matches", async () => {
    const broker = new CursorWindowBroker(vi.fn(async () => undefined));
    await expect(broker.focus(cursorTarget())).resolves.toMatchObject({
      status: "unavailable",
    });

    register(broker, new FakeSocket(), ["/workspace/alpha"]);
    register(broker, new FakeSocket(), ["/workspace/alpha"]);
    await expect(broker.focus(codexTarget())).resolves.toMatchObject({
      status: "ambiguous",
    });
  });

  it("requires a companion upgrade before sending a Codex target", async () => {
    const broker = new CursorWindowBroker(vi.fn(async () => undefined));
    const socket = new FakeSocket();
    register(broker, socket, ["/workspace/alpha"], {
      version: "0.2.0",
      focusKinds: null,
    });

    const result = await broker.focus(codexTarget());
    expect(result.status).toBe("unavailable");
    expect(result.message).toContain("Update Agent Deck Focus");
    expect(socket.sent).toEqual([]);
  });

  it("replaces a stale reconnect with the same stable window ID", () => {
    const broker = new CursorWindowBroker(vi.fn(async () => undefined));
    const first = new FakeSocket();
    const instanceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    register(broker, first, ["/workspace/alpha"], { instanceId });
    register(broker, new FakeSocket(), ["/workspace/alpha"], { instanceId });

    expect(broker.registeredCount()).toBe(1);
    expect(first.closes).toContainEqual({
      code: 1012,
      reason: "Cursor window reconnected",
    });
  });

  it("invalidates pending work on registration changes and ignores late results", async () => {
    const broker = new CursorWindowBroker(vi.fn(async () => undefined));
    const socket = new FakeSocket();
    const instanceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const connectionId = register(broker, socket, ["/workspace/alpha"], {
      instanceId,
    });
    const pending = broker.focus(cursorTarget());
    const requestId = (JSON.parse(socket.sent[0]!) as { requestId: string })
      .requestId;

    expect(
      broker.handle(connectionId, {
        type: "window.register",
        windowInstanceId: instanceId,
        workspaceRoots: ["/workspace/beta"],
        launchTarget: "/workspace/beta",
        focused: false,
        version: "0.3.0",
        focusKinds: ["cursor.conversation", "codex.thread"],
      }),
    ).toBe(true);
    await expect(pending).resolves.toMatchObject({
      status: "failed",
      message: "Cursor window registration changed",
    });
    expect(
      broker.handle(connectionId, {
        type: "focus.result",
        requestId,
        status: "opened",
      }),
    ).toBe(true);
  });

  it("coalesces the same target and supersedes a different target", async () => {
    const activate = vi.fn(async () => undefined);
    const broker = new CursorWindowBroker(activate);
    const socket = new FakeSocket();
    const connectionId = register(broker, socket, ["/workspace/alpha"]);

    const first = broker.focus(cursorTarget("conversation-1"));
    const repeated = broker.focus(cursorTarget("conversation-1"));
    expect(socket.sent).toHaveLength(1);
    expect(activate).toHaveBeenCalledOnce();

    const replacement = broker.focus(cursorTarget("conversation-2"));
    const firstResult = await first;
    const repeatedResult = await repeated;
    expect(firstResult.status).toBe("failed");
    expect(firstResult.message).toContain("Superseded");
    expect(repeatedResult.status).toBe("failed");
    expect(repeatedResult.message).toContain("Superseded");
    expect(socket.sent).toHaveLength(2);

    acknowledgeLatest(broker, connectionId, socket);
    await expect(replacement).resolves.toMatchObject({ status: "opened" });
  });

  it("reports send, activation, disconnect, and timeout failures", async () => {
    const sendBroker = new CursorWindowBroker(vi.fn(async () => undefined));
    const sendSocket = new FakeSocket();
    sendSocket.throwOnSend = new Error("send failed");
    register(sendBroker, sendSocket, ["/workspace/alpha"]);
    await expect(sendBroker.focus(cursorTarget())).resolves.toMatchObject({
      status: "failed",
      message: "send failed",
    });

    const callbackBroker = new CursorWindowBroker(vi.fn(async () => undefined));
    const callbackSocket = new FakeSocket();
    callbackSocket.sendError = new Error("callback send failed");
    register(callbackBroker, callbackSocket, ["/workspace/alpha"]);
    await expect(callbackBroker.focus(cursorTarget())).resolves.toMatchObject({
      status: "failed",
      message: "callback send failed",
    });

    const activationBroker = new CursorWindowBroker(
      vi.fn(async () => {
        throw new Error("activation failed");
      }),
    );
    register(activationBroker, new FakeSocket(), ["/workspace/alpha"]);
    await expect(activationBroker.focus(cursorTarget())).resolves.toMatchObject(
      {
        status: "failed",
        message: "activation failed",
      },
    );

    const disconnectBroker = new CursorWindowBroker(
      vi.fn(async () => undefined),
    );
    const disconnectSocket = new FakeSocket();
    const disconnectId = register(disconnectBroker, disconnectSocket, [
      "/workspace/alpha",
    ]);
    const disconnected = disconnectBroker.focus(cursorTarget());
    disconnectBroker.remove(disconnectId);
    const disconnectedResult = await disconnected;
    expect(disconnectedResult.status).toBe("failed");
    expect(disconnectedResult.message).toContain("disconnected");

    vi.useFakeTimers();
    const timeoutBroker = new CursorWindowBroker(
      vi.fn(async () => undefined),
      5_000,
    );
    register(timeoutBroker, new FakeSocket(), ["/workspace/alpha"]);
    const timedOut = timeoutBroker.focus(cursorTarget());
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(timedOut).resolves.toMatchObject({ status: "timeout" });
  });

  it("does not report opened before activation also succeeds", async () => {
    let rejectActivation!: (error: Error) => void;
    const activation = new Promise<void>((_resolve, reject) => {
      rejectActivation = reject;
    });
    const broker = new CursorWindowBroker(() => activation);
    const socket = new FakeSocket();
    const connectionId = register(broker, socket, ["/workspace/alpha"]);

    const resultPromise = broker.focus(cursorTarget());
    acknowledgeLatest(broker, connectionId, socket);
    rejectActivation(new Error("could not activate exact window"));

    await expect(resultPromise).resolves.toMatchObject({
      status: "failed",
      message: "could not activate exact window",
    });
  });
});
