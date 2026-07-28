import * as vscode from "vscode";
import { focusCursorConversation } from "./focus-handler.js";

export const activate = (context: vscode.ExtensionContext): void => {
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri: async (uri) => {
        await focusCursorConversation(uri.toString(true), {
          getCommands: (filterInternal) =>
            Promise.resolve(vscode.commands.getCommands(filterInternal)),
          executeCommand: (command, ...arguments_) =>
            Promise.resolve(
              vscode.commands.executeCommand(command, ...arguments_),
            ),
          showError: (message) =>
            Promise.resolve(vscode.window.showErrorMessage(message)),
        });
      },
    }),
  );
};

export const deactivate = (): void => undefined;
