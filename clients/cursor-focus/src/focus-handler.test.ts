import { describe, expect, it, vi } from "vitest";
import {
  CODEX_EXTENSION_ID,
  CODEX_NEW_CHAT_COMMAND,
  CODEX_OPEN_SIDEBAR_COMMAND,
  CURSOR_CANCEL_CHAT_COMMAND,
  CURSOR_OPEN_COMPOSER_COMMAND,
  CURSOR_NEW_AGENT_CHAT_COMMAND,
  codexThreadUri,
  createAgentChat,
  focusCursorConversation,
  type FocusHandlerDependencies,
} from "./focus-handler.js";

const dependencies = (
  commands = [CURSOR_OPEN_COMPOSER_COMMAND],
): FocusHandlerDependencies & {
  executeCommand: ReturnType<typeof vi.fn>;
  openExternal: ReturnType<typeof vi.fn>;
} => ({
  getWorkspaceFolders: () => ["/workspace/alpha"],
  getCommands: async () => commands,
  hasExtension: () => true,
  executeCommand: vi.fn(async () => undefined),
  openExternal: vi.fn(async () => true),
});

describe("Cursor focus URI handler", () => {
  it("creates blank Cursor and Codex chats through available commands", async () => {
    const cursor = dependencies([CURSOR_NEW_AGENT_CHAT_COMMAND]);
    await expect(createAgentChat("cursor-local", cursor)).resolves.toEqual({
      status: "opened",
    });
    expect(cursor.executeCommand).toHaveBeenCalledWith(
      CURSOR_NEW_AGENT_CHAT_COMMAND,
    );

    const codex = dependencies([CODEX_NEW_CHAT_COMMAND]);
    await expect(createAgentChat("codex", codex)).resolves.toEqual({
      status: "opened",
    });
    expect(codex.executeCommand).toHaveBeenCalledWith(CODEX_NEW_CHAT_COMMAND);
  });

  it("fails safely when a new-chat command is unavailable", async () => {
    await expect(
      createAgentChat("cursor-local", dependencies([])),
    ).resolves.toMatchObject({ status: "unavailable" });
    const codex = dependencies([CODEX_NEW_CHAT_COMMAND]);
    codex.hasExtension = () => false;
    await expect(createAgentChat("codex", codex)).resolves.toMatchObject({
      status: "unavailable",
    });
  });

  it("opens the exact local conversation", async () => {
    const deps = dependencies();
    await expect(
      focusCursorConversation(
        "cursor://agent-deck.focus/open?conversationId=conversation-123&workspace=%2Fworkspace%2Falpha",
        deps,
      ),
    ).resolves.toEqual({ status: "opened" });
    expect(deps.executeCommand).toHaveBeenCalledWith(
      CURSOR_OPEN_COMPOSER_COMMAND,
      "conversation-123",
    );
  });

  it("leaves the current window unchanged when the workspace differs", async () => {
    const deps = dependencies();
    const result = await focusCursorConversation(
      "cursor://agent-deck.focus/open?conversationId=conversation-123&workspace=%2Fworkspace%2Fbeta",
      deps,
    );
    expect(result.status).toBe("unavailable");
    expect("message" in result ? result.message : "").toContain(
      "another Cursor window",
    );
    expect(deps.executeCommand).not.toHaveBeenCalled();
  });

  it("requires the complete multi-root workspace identity", async () => {
    const deps = dependencies();
    deps.getWorkspaceFolders = () => ["/workspace/beta", "/workspace/alpha"];
    await expect(
      focusCursorConversation(
        "cursor://agent-deck.focus/open?conversationId=conversation-123&workspace=%2Fworkspace%2Falpha&workspace=%2Fworkspace%2Fbeta",
        deps,
      ),
    ).resolves.toEqual({ status: "opened" });

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
    ).resolves.toMatchObject({ status: "unavailable" });
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
    ).resolves.toEqual({ status: "opened" });
    expect(deps.executeCommand).toHaveBeenCalledWith(
      CURSOR_CANCEL_CHAT_COMMAND,
      "conversation-123",
    );
  });

  it("opens an exact local thread in the Cursor Codex sidebar", async () => {
    const deps = dependencies([CODEX_OPEN_SIDEBAR_COMMAND]);
    await expect(
      focusCursorConversation(
        "cursor://agent-deck.focus/codex?threadId=thread-123&cwd=%2Fworkspace%2Falpha%2Fproject",
        deps,
      ),
    ).resolves.toEqual({ status: "opened" });
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
    ).resolves.toMatchObject({ status: "unavailable" });
    expect(wrongWindow.executeCommand).not.toHaveBeenCalled();

    const missingExtension = dependencies([CODEX_OPEN_SIDEBAR_COMMAND]);
    missingExtension.hasExtension = (extensionId) =>
      extensionId !== CODEX_EXTENSION_ID;
    await expect(
      focusCursorConversation(
        "cursor://agent-deck.focus/codex?threadId=thread-123&cwd=%2Fworkspace%2Falpha",
        missingExtension,
      ),
    ).resolves.toMatchObject({ status: "unavailable" });
    expect(missingExtension.executeCommand).not.toHaveBeenCalled();

    const missingCommand = dependencies([]);
    await expect(
      focusCursorConversation(
        "cursor://agent-deck.focus/codex?threadId=thread-123&cwd=%2Fworkspace%2Falpha",
        missingCommand,
      ),
    ).resolves.toMatchObject({ status: "unavailable" });
    expect(missingCommand.executeCommand).not.toHaveBeenCalled();
  });

  it("fails when Cursor rejects exact Codex thread navigation", async () => {
    const deps = dependencies([CODEX_OPEN_SIDEBAR_COMMAND]);
    deps.openExternal.mockResolvedValueOnce(false);
    const result = await focusCursorConversation(
      "cursor://agent-deck.focus/codex?threadId=thread-123&cwd=%2Fworkspace%2Falpha",
      deps,
    );
    expect(result.status).toBe("failed");
    expect("message" in result ? result.message : "").toContain(
      "Codex sidebar",
    );
  });

  it("rejects malformed and unexpected links", async () => {
    const deps = dependencies();
    await expect(
      focusCursorConversation(
        "cursor://agent-deck.focus/open?conversationId=bad%20id",
        deps,
      ),
    ).resolves.toMatchObject({ status: "unavailable" });
    await expect(
      focusCursorConversation(
        "https://agent-deck.focus/open?conversationId=conversation-123",
        deps,
      ),
    ).resolves.toMatchObject({ status: "unavailable" });
    expect(deps.executeCommand).not.toHaveBeenCalled();
  });

  it("reports incompatible Cursor versions and missing conversations", async () => {
    const incompatible = dependencies([]);
    const incompatibleResult = await focusCursorConversation(
      "cursor://agent-deck.focus/open?conversationId=conversation-123&workspace=%2Fworkspace%2Falpha",
      incompatible,
    );
    expect(incompatibleResult.status).toBe("unavailable");
    expect(
      "message" in incompatibleResult ? incompatibleResult.message : "",
    ).toContain("cannot open");

    const unavailable = dependencies();
    unavailable.executeCommand.mockRejectedValueOnce(new Error("not found"));
    const unavailableResult = await focusCursorConversation(
      "cursor://agent-deck.focus/open?conversationId=conversation-123&workspace=%2Fworkspace%2Falpha",
      unavailable,
    );
    expect(unavailableResult.status).toBe("failed");
    expect(
      "message" in unavailableResult ? unavailableResult.message : "",
    ).toContain("no longer exist");
  });
});
