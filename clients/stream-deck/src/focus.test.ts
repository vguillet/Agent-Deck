import { describe, expect, it, vi } from "vitest";
import type { Agent } from "@agent-deck/domain";
import {
  DoublePressDetector,
  focusAgent,
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
  it("distinguishes a delayed single press from a double press", () => {
    vi.useFakeTimers();
    const detector = new DoublePressDetector(350);
    const singlePress = vi.fn();

    expect(detector.press("key-1", singlePress)).toBe(false);
    vi.advanceTimersByTime(349);
    expect(singlePress).not.toHaveBeenCalled();
    expect(detector.press("key-1", singlePress)).toBe(true);
    vi.advanceTimersByTime(350);
    expect(singlePress).not.toHaveBeenCalled();

    expect(detector.press("key-1", singlePress)).toBe(false);
    vi.advanceTimersByTime(350);
    expect(singlePress).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("keeps the rendered agent target when the live list is reordered", () => {
    const targets = new RenderedAgentTargets();
    const first = agent("cursor-local:first");
    const second = agent("cursor-local:second");
    targets.set("key-1", first.id);
    expect(targets.resolve("key-1", [second, first])).toBe(first);
    expect(targets.resolve("key-1", [second])).toBeUndefined();
  });

  it.each([
    "codex://threads/thread-1",
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

  it("rejects absent and unsafe focus links without launching", async () => {
    const launch = vi.fn(async () => undefined);
    await expect(focusAgent(undefined, launch)).resolves.toMatchObject({
      status: "unavailable",
    });
    await expect(
      focusAgent(agent("fake:one", "https://example.com/agent"), launch),
    ).resolves.toMatchObject({ status: "unavailable" });
    await expect(focusAgent(agent("fake:two"), launch)).resolves.toMatchObject({
      status: "unavailable",
    });
    expect(launch).not.toHaveBeenCalled();
  });

  it("reports launcher failures", async () => {
    await expect(
      focusAgent(
        agent("codex:one", "codex://threads/one"),
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
