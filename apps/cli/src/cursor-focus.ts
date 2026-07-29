import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_ID = "agent-deck.focus";
const EXTENSION_VERSION = "0.3.0";
const DEFAULT_CURSOR_BINARY =
  "/Applications/Cursor.app/Contents/Resources/app/bin/cursor";

interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface CursorFocusOptions {
  cursorBinary?: string;
  vsixPath?: string;
  run?: (file: string, arguments_: string[]) => Promise<CommandResult>;
}

const defaultVsixPath = (): string => {
  const manifest = fileURLToPath(import.meta.resolve("focus/package.json"));
  return resolve(
    dirname(manifest),
    "release",
    `agent-deck.focus-${EXTENSION_VERSION}.vsix`,
  );
};

const runCommand = (
  file: string,
  arguments_: string[],
): Promise<CommandResult> =>
  new Promise((resolvePromise, reject) => {
    execFile(
      file,
      arguments_,
      { encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `${error.message}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
            ),
          );
          return;
        }
        resolvePromise({ stdout, stderr });
      },
    );
  });

const installedVersion = async (
  options: CursorFocusOptions,
): Promise<string | undefined> => {
  const run = options.run ?? runCommand;
  const result = await run(options.cursorBinary ?? DEFAULT_CURSOR_BINARY, [
    "--list-extensions",
    "--show-versions",
  ]);
  const prefix = `${EXTENSION_ID}@`;
  return result.stdout
    .split(/\r?\n/)
    .find((line) => line.trim().toLowerCase().startsWith(prefix))
    ?.trim()
    .slice(prefix.length);
};

export const cursorFocusStatus = async (
  options: CursorFocusOptions = {},
): Promise<string> => {
  const version = await installedVersion(options);
  return version
    ? `Agent Deck Focus ${version} is installed in Cursor`
    : "Agent Deck Focus is not installed in Cursor";
};

export const installCursorFocus = async (
  options: CursorFocusOptions = {},
): Promise<string> => {
  const version = await installedVersion(options);
  if (version === EXTENSION_VERSION)
    return `Agent Deck Focus ${version} is already installed in Cursor`;
  const vsix = options.vsixPath ?? defaultVsixPath();
  await access(vsix);
  const run = options.run ?? runCommand;
  await run(options.cursorBinary ?? DEFAULT_CURSOR_BINARY, [
    "--install-extension",
    vsix,
    "--force",
  ]);
  return `Installed Agent Deck Focus ${EXTENSION_VERSION} in Cursor`;
};

export const uninstallCursorFocus = async (
  options: CursorFocusOptions = {},
): Promise<string> => {
  const version = await installedVersion(options);
  if (!version) return "Agent Deck Focus is not installed in Cursor";
  const run = options.run ?? runCommand;
  await run(options.cursorBinary ?? DEFAULT_CURSOR_BINARY, [
    "--uninstall-extension",
    EXTENSION_ID,
  ]);
  return `Removed Agent Deck Focus ${version} from Cursor`;
};
