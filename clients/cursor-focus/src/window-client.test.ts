import { afterEach, describe, expect, it, vi } from "vitest";
import type { CursorFocusTarget } from "@agent-deck/api-contract";
import {
  CursorWindowClient,
  type CursorWindowClientDependencies,
  type CursorWindowSnapshot,
  type CursorTargetExecutionResult,
  type FocusSocket,
} from "./window-client.js";

class FakeSocket implements FocusSocket {
  readonly OPEN = 1;
  readyState = 0;
  readonly sent: unknown[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  private readonly listeners = {
    open: [] as Array<() => void>,
    message: [] as Array<(raw: { toString(): string }) => void>,
    close: [] as Array<() => void>,
    error: [] as Array<(error: Error) => void>,
  };

  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (raw: { toString(): string }) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(
    event: keyof FakeSocket["listeners"],
    listener:
      | (() => void)
      | ((raw: { toString(): string }) => void)
      | ((error: Error) => void),
  ): void {
    (this.listeners[event] as Array<typeof listener>).push(listener);
  }

  send(value: string): void {
    this.sent.push(JSON.parse(value) as unknown);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closes.push({
      ...(code ? { code } : {}),
      ...(reason ? { reason } : {}),
    });
  }

  open(): void {
    this.readyState = this.OPEN;
    for (const listener of this.listeners.open) listener();
  }

  message(value: unknown): void {
    const raw = { toString: () => JSON.stringify(value) };
    for (const listener of this.listeners.message) listener(raw);
  }

  disconnect(): void {
    this.readyState = 3;
    for (const listener of this.listeners.close) listener();
  }
}

interface Harness {
  client: CursorWindowClient;
  sockets: FakeSocket[];
  urls: URL[];
  executeTarget: ReturnType<typeof vi.fn>;
  createAgent: ReturnType<typeof vi.fn>;
  workspaceRegistered: ReturnType<typeof vi.fn>;
  getSnapshot(): CursorWindowSnapshot;
  setSnapshot(snapshot: CursorWindowSnapshot): void;
  setServerUrl(url: string): void;
}

const harness = (
  initialSnapshot: CursorWindowSnapshot = {
    workspaceRoots: ["/workspace/alpha"],
    launchTarget: "/workspace/alpha",
    focused: true,
  },
): Harness => {
  let snapshot = initialSnapshot;
  let serverUrl = "http://127.0.0.1:47831";
  const sockets: FakeSocket[] = [];
  const urls: URL[] = [];
  const executeTarget = vi.fn(async (_target: CursorFocusTarget) => ({
    status: "opened" as const,
  }));
  const createAgent = vi.fn(async () => ({ status: "opened" as const }));
  const workspaceRegistered = vi.fn();
  const dependencies: CursorWindowClientDependencies = {
    getServerUrl: () => serverUrl,
    getWindowSnapshot: () => snapshot,
    createSocket: (url) => {
      urls.push(url);
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    executeTarget,
    createAgent,
    workspaceRegistered,
    random: () => 0,
    log: vi.fn(),
  };
  const client = new CursorWindowClient(
    dependencies,
    "0.5.1",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  );
  return {
    client,
    sockets,
    urls,
    executeTarget,
    createAgent,
    workspaceRegistered,
    getSnapshot: () => snapshot,
    setSnapshot: (value) => {
      snapshot = value;
    },
    setServerUrl: (value) => {
      serverUrl = value;
    },
  };
};

const intent = (
  requestId: string,
  target: CursorFocusTarget = {
    kind: "codex.thread",
    threadId: "thread-1",
    cwd: "/workspace/alpha/project",
  },
) => ({
  type: "focus.intent",
  requestId,
  target,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Cursor window connection lifecycle", () => {
  it("accepts the server workspace appearance acknowledgement", () => {
    const test = harness();
    test.client.start();
    test.sockets[0]!.open();

    test.sockets[0]!.message({
      type: "window.registered",
      workspace: {
        id: "agent-deck:workspace:alpha",
        providerId: "agent-deck",
        externalId: "alpha",
        name: "alpha",
        colour: "#123456",
        metadata: {},
      },
    });

    expect(test.workspaceRegistered).toHaveBeenCalledWith(
      expect.objectContaining({ colour: "#123456" }),
    );
  });

  it("registers capabilities and dispatches a target once", async () => {
    const test = harness({
      workspaceRoots: ["/workspace/beta", "/workspace/alpha"],
      launchTarget: "/workspace/project.code-workspace",
      focused: true,
    });
    test.client.start();
    expect(test.urls[0]?.href).toBe(
      "ws://127.0.0.1:47831/internal/cursor-focus",
    );
    test.sockets[0]!.open();
    expect(test.sockets[0]!.sent[0]).toEqual({
      type: "window.register",
      windowInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      workspaceRoots: ["/workspace/alpha", "/workspace/beta"],
      launchTarget: "/workspace/project.code-workspace",
      focused: true,
      version: "0.5.1",
      focusProtocolVersion: 2,
      focusKinds: ["cursor.conversation", "codex.thread"],
      creationProviderIds: ["cursor-local", "codex"],
    });

    test.sockets[0]!.message(intent("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"));
    await vi.waitFor(() => expect(test.executeTarget).toHaveBeenCalledOnce());
    expect(test.sockets[0]!.sent.at(-1)).toMatchObject({
      type: "focus.result",
      requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      status: "opened",
    });
  });

  it("dispatches agent creation and acknowledges with a creation result", async () => {
    const test = harness();
    test.client.start();
    test.sockets[0]!.open();
    test.sockets[0]!.message({
      type: "creation.intent",
      requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      providerId: "codex",
    });
    await vi.waitFor(() =>
      expect(test.createAgent).toHaveBeenCalledWith("codex"),
    );
    expect(test.sockets[0]!.sent.at(-1)).toMatchObject({
      type: "creation.result",
      status: "opened",
    });
  });

  it("continues dispatching legacy Cursor conversation intents", async () => {
    const test = harness();
    test.client.start();
    test.sockets[0]!.open();
    test.sockets[0]!.message({
      type: "focus.intent",
      requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      conversationId: "conversation-1",
    });

    await vi.waitFor(() => expect(test.executeTarget).toHaveBeenCalledOnce());
    expect(test.executeTarget).toHaveBeenCalledWith({
      kind: "cursor.conversation",
      conversationId: "conversation-1",
      workspaceRoots: ["/workspace/alpha"],
    });
  });

  it("defers in the background and fails an intent that is superseded", async () => {
    const test = harness({
      workspaceRoots: ["/workspace/alpha"],
      launchTarget: "/workspace/alpha",
      focused: false,
    });
    test.client.start();
    test.sockets[0]!.open();
    test.sockets[0]!.message(intent("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"));
    expect(test.executeTarget).not.toHaveBeenCalled();

    test.sockets[0]!.message(
      intent("cccccccc-cccc-4ccc-8ccc-cccccccccccc", {
        kind: "codex.thread",
        threadId: "thread-2",
        cwd: "/workspace/alpha/other",
      }),
    );
    const superseded = test.sockets[0]!.sent.at(-1) as Record<string, unknown>;
    expect(superseded).toMatchObject({
      requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      status: "superseded",
    });
    expect(superseded.message).toContain("Superseded");

    test.setSnapshot({ ...test.getSnapshot(), focused: true });
    test.client.windowStateChanged(true);
    await vi.waitFor(() => expect(test.executeTarget).toHaveBeenCalledOnce());
    expect(test.executeTarget).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thread-2" }),
    );
  });

  it("executes the newest local conversation last in the same window", async () => {
    let finishFirst!: (result: CursorTargetExecutionResult) => void;
    const firstExecution = new Promise<CursorTargetExecutionResult>(
      (resolve) => {
        finishFirst = resolve;
      },
    );
    const test = harness();
    test.executeTarget
      .mockImplementationOnce(async () => firstExecution)
      .mockResolvedValue({ status: "opened" });
    test.client.start();
    test.sockets[0]!.open();

    test.sockets[0]!.message(intent("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"));
    await vi.waitFor(() => expect(test.executeTarget).toHaveBeenCalledOnce());
    test.sockets[0]!.message(
      intent("cccccccc-cccc-4ccc-8ccc-cccccccccccc", {
        kind: "cursor.conversation",
        conversationId: "conversation-2",
        workspaceRoots: ["/workspace/alpha"],
      }),
    );
    test.sockets[0]!.message(
      intent("dddddddd-dddd-4ddd-8ddd-dddddddddddd", {
        kind: "cursor.conversation",
        conversationId: "conversation-3",
        workspaceRoots: ["/workspace/alpha"],
      }),
    );

    expect(test.sockets[0]!.sent.at(-1)).toMatchObject({
      requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      status: "superseded",
    });
    finishFirst({ status: "opened" });
    await vi.waitFor(() => expect(test.executeTarget).toHaveBeenCalledTimes(2));
    expect(test.executeTarget).toHaveBeenLastCalledWith(
      expect.objectContaining({ conversationId: "conversation-3" }),
    );
  });

  it("drops cancelled queued intents and reports late executing results", async () => {
    const background = harness({
      workspaceRoots: ["/workspace/alpha"],
      launchTarget: "/workspace/alpha",
      focused: false,
    });
    background.client.start();
    background.sockets[0]!.open();
    const queuedId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    background.sockets[0]!.message(intent(queuedId));
    background.sockets[0]!.message({
      type: "focus.cancel",
      requestId: queuedId,
    });
    background.setSnapshot({ ...background.getSnapshot(), focused: true });
    background.client.windowStateChanged(true);
    await Promise.resolve();
    expect(background.executeTarget).not.toHaveBeenCalled();

    let finish!: (result: CursorTargetExecutionResult) => void;
    const execution = new Promise<CursorTargetExecutionResult>((resolve) => {
      finish = resolve;
    });
    const active = harness();
    active.executeTarget.mockImplementationOnce(async () => execution);
    active.client.start();
    active.sockets[0]!.open();
    const activeId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    active.sockets[0]!.message(intent(activeId));
    await vi.waitFor(() => expect(active.executeTarget).toHaveBeenCalledOnce());
    active.sockets[0]!.message({
      type: "focus.cancel",
      requestId: activeId,
    });
    finish({ status: "opened" });
    await vi.waitFor(() =>
      expect(active.sockets[0]!.sent.at(-1)).toMatchObject({
        type: "focus.result",
        requestId: activeId,
        status: "opened",
      }),
    );
  });

  it("re-registers workspace changes and restarts after URL changes", () => {
    const test = harness();
    test.client.start();
    test.sockets[0]!.open();
    const instanceId = (
      test.sockets[0]!.sent[0] as { windowInstanceId: string }
    ).windowInstanceId;

    test.setSnapshot({
      workspaceRoots: ["/workspace/gamma"],
      launchTarget: "/workspace/gamma",
      focused: true,
    });
    test.client.workspaceChanged();
    expect(test.sockets[0]!.sent.at(-1)).toMatchObject({
      type: "window.register",
      windowInstanceId: instanceId,
      workspaceRoots: ["/workspace/gamma"],
    });

    test.setServerUrl("https://agent-deck.local:9443/base");
    test.client.configurationChanged();
    expect(test.sockets[0]!.closes.at(-1)?.reason).toContain(
      "configuration changed",
    );
    expect(test.urls[1]?.href).toBe(
      "wss://agent-deck.local:9443/internal/cursor-focus",
    );
    test.sockets[1]!.open();
    expect(test.sockets[1]!.sent[0]).toMatchObject({
      windowInstanceId: instanceId,
    });
  });

  it("reconnects with bounded backoff and disposes sockets and timers", () => {
    vi.useFakeTimers();
    const test = harness();
    test.client.start();
    test.sockets[0]!.open();
    test.sockets[0]!.disconnect();
    expect(test.sockets).toHaveLength(1);
    vi.advanceTimersByTime(249);
    expect(test.sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(test.sockets).toHaveLength(2);

    test.sockets[1]!.disconnect();
    test.client.dispose();
    vi.advanceTimersByTime(20_000);
    expect(test.sockets).toHaveLength(2);
  });
});
