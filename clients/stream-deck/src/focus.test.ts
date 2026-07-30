import { afterEach, describe, expect, it, vi } from "vitest";
import {
  focusResultNeedsAlert,
  PressGestureController,
  settleFocusTask,
} from "./focus.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("Stream Deck press gesture controller", () => {
  it("returns the exact key-down target for a short press", () => {
    vi.useFakeTimers();
    const controller = new PressGestureController<string, string>(650);
    const longPress = vi.fn(async () => "removed");

    expect(controller.keyDown("key-1", "agent-1", longPress)).toBe("started");
    expect(controller.keyUp("key-1")).toEqual({
      kind: "short",
      target: "agent-1",
    });
    expect(longPress).not.toHaveBeenCalled();
  });

  it("classifies the exact threshold as long even before its timer runs", async () => {
    let now = 0;
    const controller = new PressGestureController<string, string>(
      650,
      10_000,
      () => now,
    );
    const longPress = vi.fn(async () => "removed");
    controller.keyDown("key-1", "agent-1", longPress);

    now = 650;
    const release = controller.keyUp("key-1");
    expect(release.kind).toBe("long");
    if (release.kind === "long")
      await expect(release.completion).resolves.toBe("removed");
    expect(longPress).toHaveBeenCalledOnce();
  });

  it("runs a held long press once and never returns a short press", async () => {
    vi.useFakeTimers();
    const controller = new PressGestureController<string, string>(650);
    const longPress = vi.fn(async (target: string) => `removed:${target}`);
    controller.keyDown("key-1", "agent-1", longPress);

    await vi.advanceTimersByTimeAsync(650);
    controller.keyDown("key-1", "agent-2", longPress);
    const release = controller.keyUp("key-1");
    expect(release.kind).toBe("long");
    if (release.kind === "long")
      await expect(release.completion).resolves.toBe("removed:agent-1");
    expect(longPress).toHaveBeenCalledOnce();
  });

  it("ignores empty, duplicate, and unmatched event sequences", () => {
    vi.useFakeTimers();
    const controller = new PressGestureController<string>(650);

    expect(controller.keyDown("key-1", undefined, vi.fn())).toBe("empty");
    expect(controller.keyUp("key-1")).toEqual({ kind: "none" });
    expect(controller.keyDown("key-1", "agent-1", vi.fn())).toBe("started");
    expect(controller.keyDown("key-1", "agent-2", vi.fn())).toBe("ignored");
    expect(controller.keyUp("key-1")).toEqual({
      kind: "short",
      target: "agent-1",
    });
    expect(controller.keyUp("key-1")).toEqual({ kind: "none" });
  });

  it("cancels disappearing actions and recovers from a missing key-up", async () => {
    vi.useFakeTimers();
    const watchdog = vi.fn();
    const controller = new PressGestureController<string>(650, 10_000);

    controller.keyDown("key-1", "agent-1", vi.fn(), watchdog);
    expect(controller.cancel("key-1")).toBe(true);
    expect(controller.keyUp("key-1")).toEqual({ kind: "none" });

    controller.keyDown("key-1", "agent-2", vi.fn(), watchdog);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(controller.has("key-1")).toBe(false);
    expect(watchdog).toHaveBeenCalledOnce();
    expect(controller.keyDown("key-1", "agent-3", vi.fn())).toBe("started");
  });

  it("does not classify opened or superseded results as alerts", () => {
    expect(focusResultNeedsAlert({ status: "opened" })).toBe(false);
    expect(focusResultNeedsAlert({ status: "superseded" })).toBe(false);
    expect(focusResultNeedsAlert({ status: "unavailable" })).toBe(true);
    expect(focusResultNeedsAlert({ status: "ambiguous" })).toBe(true);
    expect(focusResultNeedsAlert({ status: "timeout" })).toBe(true);
    expect(focusResultNeedsAlert({ status: "failed" })).toBe(true);
  });

  it("settles detached focus failures even when reporting also fails", async () => {
    const failure = new Error("focus failed");
    const report = vi.fn(async () => {
      throw new Error("alert failed");
    });

    await expect(
      settleFocusTask(Promise.reject(failure), report),
    ).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledWith(failure);
  });
});
