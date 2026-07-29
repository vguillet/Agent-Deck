import { describe, expect, it, vi } from "vitest";
import { stopCursorConversation } from "./stop.js";

describe("Cursor local stop link", () => {
  it("targets the exact conversation", async () => {
    const launch = vi.fn(async () => undefined);
    await stopCursorConversation("conversation:123", launch);
    expect(launch).toHaveBeenCalledWith(
      "cursor://agent-deck.focus/stop?conversationId=conversation%3A123",
    );
  });
});
