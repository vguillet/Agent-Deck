import { describe, expect, it, vi } from "vitest";
import { openCursorFocusLink } from "./cursor-window-activator.js";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const listeners = new Map<string, (...arguments_: unknown[]) => void>();
    queueMicrotask(() => listeners.get("close")?.(0));
    return {
      once: (event: string, listener: (...arguments_: unknown[]) => void) => {
        listeners.set(event, listener);
      },
    };
  }),
}));

describe("macOS Cursor focus link launcher", () => {
  it("opens validated Cursor links", async () => {
    await expect(
      openCursorFocusLink(
        "cursor://anysphere.cursor-deeplink/background-agent?bcId=external-1",
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects non-Cursor schemes and relative local workspaces", async () => {
    await expect(
      openCursorFocusLink("https://example.com/agent"),
    ).rejects.toThrow("Unsupported");
    await expect(
      openCursorFocusLink(
        "cursor://agent-deck.focus/open?conversationId=one&workspace=relative",
      ),
    ).rejects.toThrow("absolute path");
  });
});
