import { isAbsolute, relative, resolve, sep } from "node:path";
import { workspaceRootsKey } from "@agent-deck/api-contract";

export const CURSOR_OPEN_COMPOSER_COMMAND = "composer.openComposer";
export const CURSOR_CANCEL_CHAT_COMMAND = "composer.cancelChat";
export const CODEX_OPEN_SIDEBAR_COMMAND = "chatgpt.openSidebar";
export const CODEX_EXTENSION_ID = "openai.chatgpt";

export interface FocusHandlerDependencies {
  getWorkspaceFolders(): string[];
  getCommands(filterInternal: boolean): Promise<string[]>;
  hasExtension(extensionId: string): boolean;
  executeCommand(command: string, ...arguments_: unknown[]): Promise<unknown>;
  openExternal(uri: string): Promise<boolean>;
  showError(message: string): Promise<unknown>;
}

const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

const pathContains = (root: string, path: string): boolean => {
  const nested = relative(resolve(root), resolve(path));
  return (
    nested === "" ||
    (nested !== ".." && !nested.startsWith(`..${sep}`) && !isAbsolute(nested))
  );
};

export const codexThreadUri = (threadId: string): string => {
  const url = new URL("cursor://openai.chatgpt/local/");
  url.pathname += encodeURIComponent(threadId);
  return url.href;
};

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
  if (
    parsed.protocol === "cursor:" &&
    parsed.hostname === "agent-deck.focus" &&
    parsed.pathname === "/codex"
  ) {
    const threadId = parsed.searchParams.get("threadId") ?? "";
    const cwd = parsed.searchParams.get("cwd") ?? "";
    if (
      !CONVERSATION_ID.test(threadId) ||
      !isAbsolute(cwd) ||
      !dependencies
        .getWorkspaceFolders()
        .some((workspace) => pathContains(workspace, cwd))
    ) {
      await dependencies.showError(
        "This Codex thread belongs to another Cursor window. Agent Deck left this window unchanged.",
      );
      return false;
    }
    let codexAvailable = false;
    try {
      codexAvailable =
        dependencies.hasExtension(CODEX_EXTENSION_ID) &&
        (await dependencies.getCommands(true)).includes(
          CODEX_OPEN_SIDEBAR_COMMAND,
        );
    } catch {
      codexAvailable = false;
    }
    if (!codexAvailable) {
      await dependencies.showError(
        "Cursor cannot open this Codex thread. Install or update the OpenAI Codex extension.",
      );
      return false;
    }
    try {
      await dependencies.executeCommand(CODEX_OPEN_SIDEBAR_COMMAND);
      if (!(await dependencies.openExternal(codexThreadUri(threadId))))
        throw new Error("Cursor rejected the Codex thread link");
      return true;
    } catch {
      await dependencies.showError(
        "Cursor could not open this thread in the Codex sidebar. Update the OpenAI Codex extension and try again.",
      );
      return false;
    }
  }

  const conversationId = parsed.searchParams.get("conversationId") ?? "";
  const workspaceRoots = parsed.searchParams.getAll("workspace");
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
    workspaceRoots.some((workspace) => !isAbsolute(workspace)) ||
    (command === CURSOR_OPEN_COMPOSER_COMMAND && !workspaceRoots.length)
  ) {
    await dependencies.showError(
      "Agent Deck received an invalid Cursor conversation ID.",
    );
    return false;
  }

  if (
    workspaceRoots.length &&
    workspaceRootsKey(workspaceRoots.map((root) => resolve(root))) !==
      workspaceRootsKey(
        dependencies.getWorkspaceFolders().map((folder) => resolve(folder)),
      )
  ) {
    await dependencies.showError(
      "This agent belongs to another Cursor window. Agent Deck left this window unchanged.",
    );
    return false;
  }

  let commands: string[];
  try {
    commands = await dependencies.getCommands(true);
  } catch {
    commands = [];
  }
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
