import { describe, expect, it, vi } from "vitest";
import {
  CODEX_EXTENSION_ID,
  CODEX_OPEN_SIDEBAR_COMMAND,
  CURSOR_CANCEL_CHAT_COMMAND,
  CURSOR_OPEN_COMPOSER_COMMAND,
  codexThreadUri,
  focusCursorConversation,
  type FocusHandlerDependencies,
} from "./focus-handler.js";

const dependencies = (
  commands = [CURSOR_OPEN_COMPOSER_COMMAND],
): FocusHandlerDependencies & {
  executeCommand: ReturnType<typeof vi.fn>;
  openExternal: ReturnType<typeof vi.fn>;
  showError: ReturnType<typeof vi.fn>;
} => ({
  getWorkspaceFolders: () => ["/workspace/alpha"],
  getCommands: async () => commands,
  hasExtension: () => true,
  executeCommand: vi.fn(async () => undefined),
  openExternal: vi.fn(async () => true),
  showError: vi.fn(async () => undefined),
});

describe("Cursor focus URI handler", () => {
  it("opens the exact local conversation", async () => {
    const deps = dependencies();
    await expect(
      focusCursorConversation(
        "cursor://agent-deck.focus/open?conversationId=conversation-123&workspace=%2Fworkspace%2Falpha",
        deps,
      ),
    ).resolves.toBe(true);
    expect(deps.executeCommand).toHaveBeenCalledWith(
      CURSOR_OPEN_COMPOSER_COMMAND,
      "conversation-123",
    );
    expect(deps.showError).not.toHaveBeenCalled();
  });

  it("leaves the current window unchanged when the workspace differs", async () => {
    const deps = dependencies();
    await expect(
      focusCursorConversation(
        "cursor://agent-deck.focus/open?conversationId=conversation-123&workspace=%2Fworkspace%2Fbeta",
        deps,
      ),
    ).resolves.toBe(false);
    expect(deps.executeCommand).not.toHaveBeenCalled();
    expect(deps.showError).toHaveBeenCalledWith(
      expect.stringContaining("another Cursor window"),
    );
  });

  it("requires the complete multi-root workspace identity", async () => {
    const deps = dependencies();
    deps.getWorkspaceFolders = () => ["/workspace/beta", "/workspace/alpha"];
    await expect(
      focusCursorConversation(
        "cursor://agent-deck.focus/open?conversationId=conversation-123&workspace=%2Fworkspace%2Falpha&workspace=%2Fworkspace%2Fbeta",
        deps,
      ),
    ).resolves.toBe(true);

    const incomplete = dependencies();
    incomplete.getWorkspaceFolders = () => [
      "/workspace/alpha",
      "/workspace/beta",
    ];
    await expect(
      focusCursorConversation(
        "cursor://agent-deck.focus/open?conversationId=conversation-123&workspace=%2Fworkspace%2Falpha",
        incomplete,
      ),
    ).resolves.toBe(false);
    expect(incomplete.executeCommand).not.toHaveBeenCalled();
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

  it("opens an exact local thread in the Cursor Codex sidebar", async () => {
    const deps = dependencies([CODEX_OPEN_SIDEBAR_COMMAND]);
    await expect(
      focusCursorConversation(
        "cursor://agent-deck.focus/codex?threadId=thread-123&cwd=%2Fworkspace%2Falpha%2Fproject",
        deps,
      ),
    ).resolves.toBe(true);
    expect(deps.executeCommand).toHaveBeenCalledWith(
      CODEX_OPEN_SIDEBAR_COMMAND,
    );
    expect(deps.openExternal).toHaveBeenCalledWith(
      "cursor://openai.chatgpt/local/thread-123",
    );
    expect(codexThreadUri("thread:123")).toBe(
      "cursor://openai.chatgpt/local/thread%3A123",
    );
  });

  it("rejects Codex focus in the wrong window or without a compatible extension", async () => {
    const wrongWindow = dependencies([CODEX_OPEN_SIDEBAR_COMMAND]);
    await expect(
      focusCursorConversation(
        "cursor://agent-deck.focus/codex?threadId=thread-123&cwd=%2Fworkspace%2Fbeta",
        wrongWindow,
      ),
    ).resolves.toBe(false);
    expect(wrongWindow.executeCommand).not.toHaveBeenCalled();

    const missingExtension = dependencies([CODEX_OPEN_SIDEBAR_COMMAND]);
    missingExtension.hasExtension = (extensionId) =>
      extensionId !== CODEX_EXTENSION_ID;
    await expect(
      focusCursorConversation(
        "cursor://agent-deck.focus/codex?threadId=thread-123&cwd=%2Fworkspace%2Falpha",
        missingExtension,
      ),
    ).resolves.toBe(false);
    expect(missingExtension.executeCommand).not.toHaveBeenCalled();

    const missingCommand = dependencies([]);
    await expect(
      focusCursorConversation(
        "cursor://agent-deck.focus/codex?threadId=thread-123&cwd=%2Fworkspace%2Falpha",
        missingCommand,
      ),
    ).resolves.toBe(false);
    expect(missingCommand.executeCommand).not.toHaveBeenCalled();
  });

  it("fails when Cursor rejects exact Codex thread navigation", async () => {
    const deps = dependencies([CODEX_OPEN_SIDEBAR_COMMAND]);
    deps.openExternal.mockResolvedValueOnce(false);
    await expect(
      focusCursorConversation(
        "cursor://agent-deck.focus/codex?threadId=thread-123&cwd=%2Fworkspace%2Falpha",
        deps,
      ),
    ).resolves.toBe(false);
    expect(deps.showError).toHaveBeenCalledWith(
      expect.stringContaining("Codex sidebar"),
    );
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
        "cursor://agent-deck.focus/open?conversationId=conversation-123&workspace=%2Fworkspace%2Falpha",
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
        "cursor://agent-deck.focus/open?conversationId=conversation-123&workspace=%2Fworkspace%2Falpha",
        unavailable,
      ),
    ).resolves.toBe(false);
    expect(unavailable.showError).toHaveBeenCalledWith(
      expect.stringContaining("no longer exist"),
    );
  });
});
