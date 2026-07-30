import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentDeckClient } from "./index.js";

class FakeWebSocket extends EventTarget {
  static instances: FakeWebSocket[] = [];
  readonly sent: string[] = [];

  constructor(readonly url: string | URL) {
    super();
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {}

  open(): void {
    this.dispatchEvent(new Event("open"));
  }

  receive(frame: unknown): void {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(frame) }),
    );
  }

  disconnect(): void {
    this.dispatchEvent(new Event("close"));
  }
}

const descriptor = {
  id: "test-client",
  type: "automation" as const,
  name: "Test client",
  version: "0.1.0",
  capabilities: {
    notifications: true,
    images: false,
    animations: false,
    textInput: false,
    approvalActions: false,
  },
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  FakeWebSocket.instances = [];
});

describe("AgentDeckClient watch", () => {
  it("connects and advances its sequence when a resync is required", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const statuses: string[] = [];
    const onResyncRequired = vi.fn();

    const watch = new AgentDeckClient("http://127.0.0.1:47831").watch(
      descriptor,
      {
        topics: ["system.health"],
        onEvent: vi.fn(),
        onStatus: (status) => statuses.push(status),
        onResyncRequired,
      },
    );
    const first = FakeWebSocket.instances[0]!;
    first.open();
    first.receive({ type: "registered" });
    expect(JSON.parse(first.sent[1]!)).toMatchObject({ afterSequence: 0 });

    first.receive({
      type: "stream.resync_required",
      currentSequence: 42,
    });
    expect(statuses).toEqual(["connecting", "connected"]);
    expect(onResyncRequired).toHaveBeenCalledOnce();

    first.disconnect();
    await vi.advanceTimersByTimeAsync(250);
    const second = FakeWebSocket.instances[1]!;
    second.open();
    second.receive({ type: "registered" });
    expect(JSON.parse(second.sent[1]!)).toMatchObject({ afterSequence: 42 });

    watch.close();
  });
});

describe("AgentDeckClient focus", () => {
  it("returns the acknowledged Cursor focus result", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        status: "opened",
      }),
    }));
    vi.stubGlobal("fetch", fetch);

    await expect(
      new AgentDeckClient().focusAgent("cursor-local:conversation"),
    ).resolves.toMatchObject({ status: "opened" });
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:47831/api/v1/agents/cursor-local%3Aconversation/focus",
      { method: "POST" },
    );
  });
});

describe("AgentDeckClient dismissTerminalAgents", () => {
  it("dismisses terminal activity epochs", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ dismissed: 3 }),
    }));
    vi.stubGlobal("fetch", fetch);

    await expect(new AgentDeckClient().dismissTerminalAgents()).resolves.toBe(
      3,
    );
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:47831/api/v1/agents/dismiss-terminal",
      { method: "POST" },
    );
  });
});
