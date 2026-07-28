import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EVENTS = [
  "sessionStart",
  "beforeSubmitPrompt",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "stop",
  "sessionEnd",
] as const;
const MARKER = "--agent-deck-cursor-local-hook";

interface CursorHook {
  command?: unknown;
  matcher?: unknown;
  timeout?: unknown;
  failClosed?: unknown;
  [key: string]: unknown;
}

interface CursorHooksFile {
  version?: unknown;
  hooks?: Record<string, CursorHook[]>;
  [key: string]: unknown;
}

export interface CursorHookOptions {
  path?: string;
  reporterPath?: string;
  nodePath?: string;
  now?: () => Date;
}

const defaultHooksPath = (): string =>
  resolve(homedir(), ".cursor", "hooks.json");

const load = async (path: string): Promise<CursorHooksFile> => {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error(`Cursor hooks file must contain a JSON object: ${path}`);
    return parsed as CursorHooksFile;
  } catch (error) {
    const code =
      typeof error === "object" && error && "code" in error
        ? String(error.code)
        : "";
    if (code === "ENOENT") return {};
    throw error;
  }
};

const reporterPath = (): string =>
  fileURLToPath(
    import.meta.resolve("@agent-deck/provider-cursor-local/hook-reporter"),
  );

const isAgentDeckHook = (hook: CursorHook): boolean =>
  typeof hook.command === "string" && hook.command.includes(MARKER);

const hasAgentDeckHook = (file: CursorHooksFile): boolean =>
  Object.values(file.hooks ?? {}).some((hooks) => hooks.some(isAgentDeckHook));

const validate = (file: CursorHooksFile, path: string): void => {
  if (file.version !== undefined && file.version !== 1)
    throw new Error(`Unsupported Cursor hooks version in ${path}`);
  if (
    file.hooks !== undefined &&
    (!file.hooks || typeof file.hooks !== "object" || Array.isArray(file.hooks))
  )
    throw new Error(`Invalid Cursor hooks collection in ${path}`);
  for (const hooks of Object.values(file.hooks ?? {}))
    if (!Array.isArray(hooks))
      throw new Error(`Invalid Cursor hook event collection in ${path}`);
};

const writeAtomically = async (
  path: string,
  file: CursorHooksFile,
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.agent-deck.tmp`;
  await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
};

const quote = (value: string): string => JSON.stringify(value);

export const installCursorHooks = async (
  options: CursorHookOptions = {},
): Promise<string> => {
  const path = options.path ?? defaultHooksPath();
  const file = await load(path);
  validate(file, path);
  if (hasAgentDeckHook(file))
    return `Agent Deck Cursor hooks already installed in ${path}`;
  try {
    await copyFile(
      path,
      `${path}.backup-${(options.now?.() ?? new Date())
        .toISOString()
        .replaceAll(":", "-")}`,
    );
  } catch (error) {
    const code =
      typeof error === "object" && error && "code" in error
        ? String(error.code)
        : "";
    if (code !== "ENOENT") throw error;
  }
  const command = `${quote(options.nodePath ?? process.execPath)} ${quote(
    options.reporterPath ?? reporterPath(),
  )} ${MARKER}`;
  file.version = 1;
  file.hooks ??= {};
  for (const event of EVENTS) {
    file.hooks[event] ??= [];
    file.hooks[event].push({
      command,
      timeout: 1,
      failClosed: false,
    });
  }
  await writeAtomically(path, file);
  return `Installed Agent Deck Cursor hooks in ${path}`;
};

export const uninstallCursorHooks = async (
  options: CursorHookOptions = {},
): Promise<string> => {
  const path = options.path ?? defaultHooksPath();
  const file = await load(path);
  validate(file, path);
  if (!hasAgentDeckHook(file))
    return `Agent Deck Cursor hooks are not installed in ${path}`;
  for (const [event, hooks] of Object.entries(file.hooks ?? {})) {
    const remaining = hooks.filter((hook) => !isAgentDeckHook(hook));
    if (remaining.length) file.hooks![event] = remaining;
    else delete file.hooks![event];
  }
  await writeAtomically(path, file);
  return `Removed Agent Deck Cursor hooks from ${path}`;
};

export const cursorHookStatus = async (
  options: CursorHookOptions = {},
): Promise<string> => {
  const path = options.path ?? defaultHooksPath();
  const file = await load(path);
  validate(file, path);
  return hasAgentDeckHook(file)
    ? `Agent Deck Cursor hooks are installed in ${path}`
    : `Agent Deck Cursor hooks are not installed in ${path}`;
};
