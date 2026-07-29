import { describe, expect, it, vi } from "vitest";
import {
  ActionOutputWriter,
  type ActionOutputTarget,
} from "./action-output-writer.js";

const target = (id = "key-1"): ActionOutputTarget => ({
  id,
  setImage: vi.fn(async () => undefined),
  setTitle: vi.fn(async () => undefined),
});

describe("Stream Deck action output writer", () => {
  it("deduplicates output only after it is committed", async () => {
    const writer = new ActionOutputWriter();
    const action = target();

    await writer.write(action, { title: "", image: "frame-1" });
    await writer.write(action, { title: "", image: "frame-1" });
    await writer.write(action, { title: "", image: "frame-2" });

    expect(action.setTitle).toHaveBeenCalledOnce();
    expect(action.setImage).toHaveBeenCalledTimes(2);
  });

  it("serializes writes for one action without blocking another", async () => {
    let finishFirst: (() => void) | undefined;
    const first = target("first");
    first.setImage = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve;
        }),
    );
    const second = target("second");
    const writer = new ActionOutputWriter();

    const firstWrite = writer.write(first, { image: "slow" });
    await Promise.resolve();
    await writer.write(second, { image: "fast" });
    expect(second.setImage).toHaveBeenCalledOnce();

    finishFirst?.();
    await firstWrite;
  });

  it("does not let a queued frame overtake an in-flight frame", async () => {
    let finishFirst: (() => void) | undefined;
    const calls: string[] = [];
    const action = target();
    action.setImage = vi.fn((image: string) => {
      calls.push(image);
      if (image === "first")
        return new Promise<void>((resolve) => {
          finishFirst = resolve;
        });
      return Promise.resolve();
    });
    const writer = new ActionOutputWriter();

    const firstWrite = writer.write(action, { image: "first" });
    const secondWrite = writer.write(action, { image: "second" });
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["first"]);

    finishFirst?.();
    await Promise.all([firstWrite, secondWrite]);
    expect(calls).toEqual(["first", "second"]);
  });

  it("retries values whose SDK write failed", async () => {
    const action = target();
    action.setImage = vi
      .fn()
      .mockRejectedValueOnce(new Error("write failed"))
      .mockResolvedValue(undefined);
    const writer = new ActionOutputWriter();

    await expect(writer.write(action, { image: "frame" })).rejects.toThrow(
      "write failed",
    );
    await expect(
      writer.write(action, { image: "frame" }),
    ).resolves.toBeUndefined();
    expect(action.setImage).toHaveBeenCalledTimes(2);
  });

  it("drops queued writes after an action disappears", async () => {
    let finishFirst: (() => void) | undefined;
    const action = target();
    action.setImage = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve;
        }),
    );
    const writer = new ActionOutputWriter();

    const firstWrite = writer.write(action, { image: "first" });
    const queuedWrite = writer.write(action, { image: "second" });
    await Promise.resolve();
    await Promise.resolve();
    expect(action.setImage).toHaveBeenCalledOnce();
    writer.clear(action.id);
    finishFirst?.();
    await Promise.all([firstWrite, queuedWrite]);

    expect(action.setImage).toHaveBeenCalledOnce();
  });
});
