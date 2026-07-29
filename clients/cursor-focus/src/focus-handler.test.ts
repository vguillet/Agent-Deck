import { describe, expect, it, vi } from "vitest";
import {
  CURSOR_CANCEL_CHAT_COMMAND,
  CURSOR_OPEN_COMPOSER_COMMAND,
  focusCursorConversation,
  type FocusHandlerDependencies,
} from "./focus-handler.js";

const dependencies = (
  commands = [CURSOR_OPEN_COMPOSER_COMMAND],
): FocusHandlerDependencies & {
  executeCommand: ReturnType<typeof vi.fn>;
  showError: ReturnType<typeof vi.fn>;
} => ({
  getCommands: async () => commands,
  executeCommand: vi.fn(async () => undefined),
  showError: vi.fn(async () => undefined),
});

describe("Cursor focus URI handler", () => {
  it("opens the exact local conversation", async () => {
    const deps = dependencies();
    await expect(
      focusCursorConversation(
        "cursor://agent-deck.focus/open?conversationId=conversation-123",
        deps,
      ),
    ).resolves.toBe(true);
    expect(deps.executeCommand).toHaveBeenCalledWith(
      CURSOR_OPEN_COMPOSER_COMMAND,
      "conversation-123",
    );
    expect(deps.showError).not.toHaveBeenCalled();
  });

  it("stops the exact local conversation", async () => {
    const deps = dependencies([
      CURSOR_OPEN_COMPOSER_COMMAND,
      CURSOR_CANCEL_CHAT_COMMAND,
    ]);
    await expect(
      focusCursorConversation(
        "cursor://agent-deck.focus/stop?conversationId=conversation-123",
        deps,
      ),
    ).resolves.toBe(true);
    expect(deps.executeCommand).toHaveBeenCalledWith(
      CURSOR_CANCEL_CHAT_COMMAND,
      "conversation-123",
    );
    expect(deps.showError).not.toHaveBeenCalled();
  });

  it("rejects malformed and unexpected links", async () => {
    const deps = dependencies();
    await expect(
      focusCursorConversation(
        "cursor://agent-deck.focus/open?conversationId=bad%20id",
        deps,
      ),
    ).resolves.toBe(false);
    await expect(
      focusCursorConversation(
        "https://agent-deck.focus/open?conversationId=conversation-123",
        deps,
      ),
    ).resolves.toBe(false);
    expect(deps.executeCommand).not.toHaveBeenCalled();
    expect(deps.showError).toHaveBeenCalledTimes(2);
  });

  it("reports incompatible Cursor versions and missing conversations", async () => {
    const incompatible = dependencies([]);
    await expect(
      focusCursorConversation(
        "cursor://agent-deck.focus/open?conversationId=conversation-123",
        incompatible,
      ),
    ).resolves.toBe(false);
    expect(incompatible.showError).toHaveBeenCalledWith(
      expect.stringContaining("cannot open"),
    );

    const unavailable = dependencies();
    unavailable.executeCommand.mockRejectedValueOnce(new Error("not found"));
    await expect(
      focusCursorConversation(
        "cursor://agent-deck.focus/open?conversationId=conversation-123",
        unavailable,
      ),
    ).resolves.toBe(false);
    expect(unavailable.showError).toHaveBeenCalledWith(
      expect.stringContaining("no longer exist"),
    );
  });
});
