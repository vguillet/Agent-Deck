import { isAbsolute, resolve } from "node:path";

export const CURSOR_OPEN_COMPOSER_COMMAND = "composer.openComposer";
export const CURSOR_CANCEL_CHAT_COMMAND = "composer.cancelChat";

export interface FocusHandlerDependencies {
  getWorkspaceFolders(): string[];
  getCommands(filterInternal: boolean): Promise<string[]>;
  executeCommand(command: string, ...arguments_: unknown[]): Promise<unknown>;
  showError(message: string): Promise<unknown>;
}

const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export const focusCursorConversation = async (
  uri: string,
  dependencies: FocusHandlerDependencies,
): Promise<boolean> => {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    await dependencies.showError("Agent Deck received an invalid focus link.");
    return false;
  }
  const conversationId = parsed.searchParams.get("conversationId") ?? "";
  const hasWorkspace = parsed.searchParams.has("workspace");
  const workspace = parsed.searchParams.get("workspace") ?? "";
  const command =
    parsed.pathname === "/open"
      ? CURSOR_OPEN_COMPOSER_COMMAND
      : parsed.pathname === "/stop"
        ? CURSOR_CANCEL_CHAT_COMMAND
        : undefined;
  if (
    parsed.protocol !== "cursor:" ||
    parsed.hostname !== "agent-deck.focus" ||
    !command ||
    !CONVERSATION_ID.test(conversationId) ||
    (hasWorkspace && !isAbsolute(workspace))
  ) {
    await dependencies.showError(
      "Agent Deck received an invalid Cursor conversation ID.",
    );
    return false;
  }

  if (
    hasWorkspace &&
    !dependencies
      .getWorkspaceFolders()
      .some((folder) => resolve(folder) === resolve(workspace))
  ) {
    await dependencies.showError(
      "This agent belongs to another Cursor window. Agent Deck left this window unchanged.",
    );
    return false;
  }

  const commands = await dependencies.getCommands(true);
  if (!commands.includes(command)) {
    await dependencies.showError(
      `This Cursor version cannot ${command === CURSOR_CANCEL_CHAT_COMMAND ? "stop" : "open"} Agent Deck conversations. Update Cursor or reinstall Agent Deck Focus.`,
    );
    return false;
  }

  try {
    await dependencies.executeCommand(command, conversationId);
    return true;
  } catch {
    await dependencies.showError(
      `Cursor could not ${command === CURSOR_CANCEL_CHAT_COMMAND ? "stop" : "open"} this Agent Deck conversation. It may no longer exist.`,
    );
    return false;
  }
};
