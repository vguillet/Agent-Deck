export const CURSOR_OPEN_COMPOSER_COMMAND = "composer.openComposer";

export interface FocusHandlerDependencies {
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
  if (
    parsed.protocol !== "cursor:" ||
    parsed.hostname !== "agent-deck.focus" ||
    parsed.pathname !== "/open" ||
    !CONVERSATION_ID.test(conversationId)
  ) {
    await dependencies.showError(
      "Agent Deck received an invalid Cursor conversation ID.",
    );
    return false;
  }

  const commands = await dependencies.getCommands(true);
  if (!commands.includes(CURSOR_OPEN_COMPOSER_COMMAND)) {
    await dependencies.showError(
      "This Cursor version cannot open Agent Deck conversation links. Update Cursor or reinstall Agent Deck Focus.",
    );
    return false;
  }

  try {
    await dependencies.executeCommand(
      CURSOR_OPEN_COMPOSER_COMMAND,
      conversationId,
    );
    return true;
  } catch {
    await dependencies.showError(
      "Cursor could not open this Agent Deck conversation. It may no longer exist.",
    );
    return false;
  }
};
