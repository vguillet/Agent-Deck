import { describe, expect, it, vi } from "vitest";
import { reportCursorHook } from "./hook-transport.js";

const noDelay = async (): Promise<void> => undefined;

describe("Cursor hook transport", () => {
  it("retries transient connection failures", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));

    await expect(
      reportCursorHook(
        "http://127.0.0.1:47831/hooks",
        { composer_mode: "plan" },
        { delay: noDelay, fetcher },
      ),
    ).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("retries server failures but not rejected payloads", async () => {
    const serverFailure = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    expect(
      await reportCursorHook(
        "http://127.0.0.1/hooks",
        {},
        {
          delay: noDelay,
          fetcher: serverFailure,
        },
      ),
    ).toBe(true);
    expect(serverFailure).toHaveBeenCalledTimes(2);

    const rejected = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 400 }));
    expect(
      await reportCursorHook(
        "http://127.0.0.1/hooks",
        {},
        {
          delay: noDelay,
          fetcher: rejected,
        },
      ),
    ).toBe(false);
    expect(rejected).toHaveBeenCalledOnce();
  });
});
