import type { CursorFocusTarget } from "@agent-deck/api-contract";
import type { Workspace } from "@agent-deck/domain";
import * as vscode from "vscode";
import WebSocket from "ws";
import { createAgentChat, focusCursorConversation } from "./focus-handler.js";
import {
  CursorWindowClient,
  type CursorWindowSnapshot,
} from "./window-client.js";
import { workspaceStatus } from "./workspace-status.js";

const focusDependencies = (): Parameters<
  typeof focusCursorConversation
>[1] => ({
  getWorkspaceFolders: () =>
    vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [],
  getCommands: (filterInternal) =>
    Promise.resolve(vscode.commands.getCommands(filterInternal)),
  hasExtension: (extensionId) =>
    vscode.extensions.getExtension(extensionId) !== undefined,
  executeCommand: (command, ...arguments_) =>
    Promise.resolve(vscode.commands.executeCommand(command, ...arguments_)),
  openExternal: async (uri) => vscode.env.openExternal(vscode.Uri.parse(uri)),
});

const windowSnapshot = (): CursorWindowSnapshot => {
  const workspaceRoots =
    vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
  const workspaceFile =
    vscode.workspace.workspaceFile?.scheme === "file"
      ? vscode.workspace.workspaceFile.fsPath
      : undefined;
  const launchTarget =
    workspaceFile ??
    (workspaceRoots.length === 1 ? workspaceRoots[0] : undefined);
  return {
    workspaceRoots,
    ...(launchTarget ? { launchTarget } : {}),
    focused: vscode.window.state.focused,
  };
};

const targetUri = (target: CursorFocusTarget): string => {
  const url = new URL(
    target.kind === "cursor.conversation"
      ? "cursor://agent-deck.focus/open"
      : "cursor://agent-deck.focus/codex",
  );
  if (target.kind === "cursor.conversation") {
    url.searchParams.set("conversationId", target.conversationId);
    for (const root of target.workspaceRoots)
      url.searchParams.append("workspace", root);
  } else {
    url.searchParams.set("threadId", target.threadId);
    url.searchParams.set("cwd", target.cwd);
  }
  return url.href;
};

export const activate = (context: vscode.ExtensionContext): void => {
  const packageJson: unknown = context.extension.packageJSON;
  const extensionVersion =
    typeof packageJson === "object" &&
    packageJson !== null &&
    "version" in packageJson
      ? String(packageJson.version)
      : "unknown";
  const workspaceStatusItem = vscode.window.createStatusBarItem(
    "agentDeck.workspace",
    vscode.StatusBarAlignment.Right,
    100,
  );
  workspaceStatusItem.name = "Agent Deck Workspace";
  const refreshWorkspaceStatus = (workspace?: Workspace): void => {
    const status = workspaceStatus(windowSnapshot().workspaceRoots, workspace);
    if (!status) {
      workspaceStatusItem.hide();
      return;
    }
    workspaceStatusItem.text = status.text;
    workspaceStatusItem.tooltip = status.tooltip;
    workspaceStatusItem.color = status.colour;
    workspaceStatusItem.accessibilityInformation = {
      label: status.tooltip,
    };
    workspaceStatusItem.show();
  };
  const windowClient = new CursorWindowClient(
    {
      getServerUrl: () =>
        vscode.workspace
          .getConfiguration("agentDeck")
          .get<string>("serverUrl", "http://127.0.0.1:47831"),
      getWindowSnapshot: windowSnapshot,
      createSocket: (url) => new WebSocket(url),
      executeTarget: (target) =>
        focusCursorConversation(targetUri(target), focusDependencies()),
      createAgent: (providerId) =>
        createAgentChat(providerId, focusDependencies()),
      workspaceRegistered: refreshWorkspaceStatus,
      random: Math.random,
      log: (message, error) => {
        if (error === undefined) console.warn(`[Agent Deck] ${message}`);
        else console.warn(`[Agent Deck] ${message}`, error);
      },
    },
    extensionVersion,
  );
  refreshWorkspaceStatus();
  windowClient.start();
  context.subscriptions.push(
    workspaceStatusItem,
    { dispose: () => windowClient.dispose() },
    vscode.window.onDidChangeWindowState((state) =>
      windowClient.windowStateChanged(state.focused),
    ),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      refreshWorkspaceStatus();
      windowClient.workspaceChanged();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("agentDeck.serverUrl"))
        windowClient.configurationChanged();
    }),
    vscode.window.registerUriHandler({
      handleUri: async (uri) => {
        const result = await focusCursorConversation(
          uri.toString(true),
          focusDependencies(),
        );
        if (result.status !== "opened")
          await vscode.window.showErrorMessage(result.message);
      },
    }),
  );
};

export const deactivate = (): void => undefined;
