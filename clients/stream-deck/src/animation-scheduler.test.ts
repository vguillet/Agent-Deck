import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANIMATION_INTERVAL_MS,
  ANIMATION_UPDATES_PER_SECOND,
  AnimationFrameScheduler,
  MAX_PROGRAMMATIC_CALLS_PER_SECOND,
  runningAnimationNeedsReset,
} from "./animation-scheduler.js";

describe("Stream Deck animation scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps each key below Stream Deck's call limit", async () => {
    const render = vi.fn(async (_target: string) => undefined);
    const scheduler = new AnimationFrameScheduler({
      targets: () => ["one", "two", "three"],
      key: (target) => target,
      render,
      onError: vi.fn(),
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(ANIMATION_UPDATES_PER_SECOND).toBeLessThan(
      MAX_PROGRAMMATIC_CALLS_PER_SECOND,
    );
    expect(1_000 / ANIMATION_INTERVAL_MS).toBeGreaterThanOrEqual(8.9);
    const framesInFirstSecond = Math.floor(1_000 / ANIMATION_INTERVAL_MS);
    for (const target of ["one", "two", "three"])
      expect(
        render.mock.calls.filter(([rendered]) => rendered === target),
      ).toHaveLength(framesInFirstSecond);
    scheduler.stop();
  });

  it("initializes animations for agents without a run id", () => {
    expect(runningAnimationNeedsReset(undefined, undefined)).toBe(true);
    expect(
      runningAnimationNeedsReset(
        { activeRunId: undefined, startedAt: 100 },
        undefined,
      ),
    ).toBe(false);
  });

  it("updates every visible key on each frame", async () => {
    const rendered: string[] = [];
    const scheduler = new AnimationFrameScheduler({
      targets: () => ["one", "two", "three"],
      key: (target) => target,
      render: async (target) => {
        rendered.push(target);
      },
      onError: vi.fn(),
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(ANIMATION_INTERVAL_MS * 2);

    expect(rendered).toEqual(["one", "two", "three", "one", "two", "three"]);
    scheduler.stop();
  });

  it("skips only the key whose previous image write is still busy", async () => {
    let finishFirstRender: (() => void) | undefined;
    const render = vi.fn((target: string) => {
      if (target === "one" && !finishFirstRender)
        return new Promise<void>((resolve) => {
          finishFirstRender = resolve;
        });
      return Promise.resolve();
    });
    const scheduler = new AnimationFrameScheduler({
      targets: () => ["one", "two"],
      key: (target) => target,
      render,
      onError: vi.fn(),
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(
      render.mock.calls.filter(([rendered]) => rendered === "one"),
    ).toHaveLength(1);
    expect(
      render.mock.calls.filter(([rendered]) => rendered === "two"),
    ).toHaveLength(Math.floor(1_000 / ANIMATION_INTERVAL_MS));

    finishFirstRender?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(ANIMATION_INTERVAL_MS);
    expect(
      render.mock.calls.filter(([rendered]) => rendered === "one"),
    ).toHaveLength(2);
    scheduler.stop();
  });
});
