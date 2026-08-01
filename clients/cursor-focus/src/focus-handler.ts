import { isAbsolute, relative, resolve, sep } from "node:path";
import { workspaceRootsKey } from "@agent-deck/api-contract";
import type { AgentCreationProviderId } from "@agent-deck/api-contract";

export const CURSOR_OPEN_COMPOSER_COMMAND = "composer.openComposer";
export const CURSOR_CANCEL_CHAT_COMMAND = "composer.cancelChat";
export const CODEX_OPEN_SIDEBAR_COMMAND = "chatgpt.openSidebar";
export const CODEX_NEW_CHAT_COMMAND = "chatgpt.newChat";
export const CODEX_EXTENSION_ID = "openai.chatgpt";
export const CURSOR_NEW_AGENT_CHAT_COMMAND = "composer.newAgentChat";

export interface FocusHandlerDependencies {
  getWorkspaceFolders(): string[];
  getCommands(filterInternal: boolean): Promise<string[]>;
  hasExtension(extensionId: string): boolean;
  executeCommand(command: string, ...arguments_: unknown[]): Promise<unknown>;
  openExternal(uri: string): Promise<boolean>;
}

export type FocusHandlerResult =
  { status: "opened" } | { status: "unavailable" | "failed"; message: string };

export const createAgentChat = async (
  providerId: AgentCreationProviderId,
  dependencies: FocusHandlerDependencies,
): Promise<FocusHandlerResult> => {
  const command =
    providerId === "codex"
      ? CODEX_NEW_CHAT_COMMAND
      : CURSOR_NEW_AGENT_CHAT_COMMAND;
  if (providerId === "codex" && !dependencies.hasExtension(CODEX_EXTENSION_ID))
    return {
      status: "unavailable",
      message: "Install the OpenAI Codex extension to create a Codex chat.",
    };

  let commands: string[];
  try {
    commands = await dependencies.getCommands(true);
  } catch {
    commands = [];
  }
  if (!commands.includes(command))
    return {
      status: "unavailable",
      message:
        providerId === "codex"
          ? "The OpenAI Codex extension cannot create a new chat. Update it and try again."
          : "This Cursor version cannot create a new Agent chat. Update Cursor and try again.",
    };
  try {
    await dependencies.executeCommand(command);
    return { status: "opened" };
  } catch {
    return {
      status: "failed",
      message:
        providerId === "codex"
          ? "Codex could not create a new chat."
          : "Cursor could not create a new Agent chat.",
    };
  }
};

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
): Promise<FocusHandlerResult> => {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return {
      status: "unavailable",
      message: "Agent Deck received an invalid focus link.",
    };
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
      return {
        status: "unavailable",
        message:
          "This Codex thread belongs to another Cursor window. Agent Deck left this window unchanged.",
      };
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
      return {
        status: "unavailable",
        message:
          "Cursor cannot open this Codex thread. Install or update the OpenAI Codex extension.",
      };
    }
    try {
      await dependencies.executeCommand(CODEX_OPEN_SIDEBAR_COMMAND);
      if (!(await dependencies.openExternal(codexThreadUri(threadId))))
        throw new Error("Cursor rejected the Codex thread link");
      return { status: "opened" };
    } catch {
      return {
        status: "failed",
        message:
          "Cursor could not open this thread in the Codex sidebar. Update the OpenAI Codex extension and try again.",
      };
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
    return {
      status: "unavailable",
      message: "Agent Deck received an invalid Cursor conversation ID.",
    };
  }

  if (
    workspaceRoots.length &&
    workspaceRootsKey(workspaceRoots.map((root) => resolve(root))) !==
      workspaceRootsKey(
        dependencies.getWorkspaceFolders().map((folder) => resolve(folder)),
      )
  ) {
    return {
      status: "unavailable",
      message:
        "This agent belongs to another Cursor window. Agent Deck left this window unchanged.",
    };
  }

  let commands: string[];
  try {
    commands = await dependencies.getCommands(true);
  } catch {
    commands = [];
  }
  if (!commands.includes(command)) {
    return {
      status: "unavailable",
      message: `This Cursor version cannot ${command === CURSOR_CANCEL_CHAT_COMMAND ? "stop" : "open"} Agent Deck conversations. Update Cursor or reinstall Agent Deck Focus.`,
    };
  }

  try {
    await dependencies.executeCommand(command, conversationId);
    return { status: "opened" };
  } catch {
    return {
      status: "failed",
      message: `Cursor could not ${command === CURSOR_CANCEL_CHAT_COMMAND ? "stop" : "open"} this Agent Deck conversation. It may no longer exist.`,
    };
  }
};
