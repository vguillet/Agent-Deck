import { describe, expect, it, vi } from "vitest";
import type { Agent } from "@agent-deck/domain";
import {
  AgentPressDetector,
  createMacOSFocusLauncher,
  focusAgent,
  LongPressDetector,
  RenderedAgentTargets,
} from "./focus.js";

const agent = (id: string, href?: string): Agent => ({
  id,
  providerId: id.split(":")[0] ?? "fake",
  externalId: id,
  title: id,
  state: "running",
  freshness: "fresh",
  requiresAttention: false,
  lastActivityAt: "2026-07-28T09:00:00.000Z",
  revision: 1,
  archived: false,
  capabilities: {
    messages: false,
    approvals: false,
    cancellation: false,
    creation: false,
  },
  links: href ? [{ rel: "focus", label: "Open", href }] : [],
  metadata: {},
});

describe("Stream Deck agent focus", () => {
  it("only dispatches a destructive button action after a long press", () => {
    vi.useFakeTimers();
    const detector = new LongPressDetector(650);
    const longPress = vi.fn();

    detector.keyDown("overview", longPress);
    vi.advanceTimersByTime(649);
    detector.keyUp("overview");
    expect(longPress).not.toHaveBeenCalled();

    detector.keyDown("overview", longPress);
    vi.advanceTimersByTime(650);
    detector.keyDown("overview", longPress);
    vi.advanceTimersByTime(650);
    detector.keyUp("overview");
    expect(longPress).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("dispatches a single press immediately for the latched agent", () => {
    vi.useFakeTimers();
    const detector = new AgentPressDetector(650);
    const singlePress = vi.fn();
    const longPress = vi.fn();

    detector.keyDown("key-1", "agent-1", { onLongPress: longPress });
    detector.keyUp("key-1", singlePress);
    expect(singlePress).toHaveBeenCalledWith("agent-1");
    expect(longPress).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("keeps the key-down target across reordering and accepts repeated presses", () => {
    vi.useFakeTimers();
    const detector = new AgentPressDetector(650);
    const targets = new RenderedAgentTargets();
    const singlePress = vi.fn();
    targets.set("key-1", "agent-1");

    detector.keyDown("key-1", targets.id("key-1"), {
      onLongPress: vi.fn(),
    });
    targets.set("key-1", "agent-2");
    detector.keyUp("key-1", singlePress);
    detector.keyDown("key-1", targets.id("key-1"), {
      onLongPress: vi.fn(),
    });
    detector.keyUp("key-1", singlePress);

    expect(singlePress).toHaveBeenNthCalledWith(1, "agent-1");
    expect(singlePress).toHaveBeenNthCalledWith(2, "agent-2");
    vi.useRealTimers();
  });

  it("dispatches a long press without a single press", () => {
    vi.useFakeTimers();
    const detector = new AgentPressDetector(650);
    const singlePress = vi.fn();
    const longPress = vi.fn();

    detector.keyDown("key-1", "agent-1", { onLongPress: longPress });
    vi.advanceTimersByTime(649);
    expect(longPress).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    detector.keyUp("key-1", singlePress);
    expect(longPress).toHaveBeenCalledWith("agent-1");
    expect(singlePress).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("keeps the rendered agent target when the live list is reordered", () => {
    const targets = new RenderedAgentTargets();
    const first = agent("cursor-local:first");
    const second = agent("cursor-local:second");
    targets.set("key-1", first.id);
    expect(targets.id("key-1")).toBe(first.id);
    expect(
      targets.resolve(
        "key-1",
        new Map([
          [second.id, second],
          [first.id, first],
        ]),
      ),
    ).toBe(first);
    expect(
      targets.resolve("key-1", new Map([[second.id, second]])),
    ).toBeUndefined();
  });

  it("cancels a gesture when its key disappears", () => {
    vi.useFakeTimers();
    const detector = new AgentPressDetector(650);
    const singlePress = vi.fn();
    const longPress = vi.fn();

    detector.keyDown("key-1", "agent-1", { onLongPress: longPress });
    detector.cancel("key-1");
    vi.advanceTimersByTime(650);
    detector.keyUp("key-1", singlePress);
    expect(longPress).not.toHaveBeenCalled();
    expect(singlePress).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it.each([
    "cursor://agent-deck.focus/open?conversationId=conversation-1",
    "cursor://anysphere.cursor-deeplink/background-agent?bcId=cloud-1",
  ])("dispatches an allowed focus URL: %s", async (href) => {
    const launch = vi.fn(async () => undefined);
    await expect(focusAgent(agent("agent:one", href), launch)).resolves.toEqual(
      {
        status: "opened",
        href,
      },
    );
    expect(launch).toHaveBeenCalledWith(href);
  });

  it("activates a local agent workspace before opening its conversation", async () => {
    const calls: Array<[string, string[]]> = [];
    const launch = createMacOSFocusLauncher(async (file, arguments_) => {
      calls.push([file, arguments_]);
    });
    const href =
      "cursor://agent-deck.focus/open?conversationId=conversation-1&workspace=%2Fworkspace%2Falpha%20project&window=%2Fworkspace%2Falpha.code-workspace";

    await launch(href);

    expect(calls).toEqual([
      ["/usr/bin/open", ["-a", "Cursor", "/workspace/alpha.code-workspace"]],
      ["/usr/bin/open", [href]],
    ]);
  });

  it.each([
    "cursor://agent-deck.focus/open?conversationId=legacy",
    "cursor://anysphere.cursor-deeplink/background-agent?bcId=cloud-1&workspace=%2Fignored",
  ])("opens an untargeted or non-local link directly: %s", async (href) => {
    const run = vi.fn(async () => undefined);
    await createMacOSFocusLauncher(run)(href);
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith("/usr/bin/open", [href]);
  });

  it("rejects a relative local workspace without launching", async () => {
    const run = vi.fn(async () => undefined);
    await expect(
      createMacOSFocusLauncher(run)(
        "cursor://agent-deck.focus/open?conversationId=one&workspace=relative",
      ),
    ).rejects.toThrow("absolute path");
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects absent and unsafe focus links without launching", async () => {
    const launch = vi.fn(async () => undefined);
    await expect(focusAgent(undefined, launch)).resolves.toMatchObject({
      status: "unavailable",
    });
    await expect(
      focusAgent(agent("fake:one", "https://example.com/agent"), launch),
    ).resolves.toMatchObject({ status: "unavailable" });
    await expect(
      focusAgent(agent("codex:one", "codex://threads/one"), launch),
    ).resolves.toMatchObject({ status: "unavailable" });
    await expect(focusAgent(agent("fake:two"), launch)).resolves.toMatchObject({
      status: "unavailable",
    });
    expect(launch).not.toHaveBeenCalled();
  });

  it("reports launcher failures", async () => {
    await expect(
      focusAgent(
        agent(
          "cursor:one",
          "cursor://anysphere.cursor-deeplink/background-agent?bcId=one",
        ),
        vi.fn(async () => {
          throw new Error("open failed");
        }),
      ),
    ).resolves.toEqual({
      status: "unavailable",
      reason: "open failed",
    });
  });
});
