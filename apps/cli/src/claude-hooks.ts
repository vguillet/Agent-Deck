import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
  "Stop",
  "StopFailure",
  "SessionEnd",
] as const;
const MARKER = "claude-code/dist/reporter.js";
const NO_STATUS_LINE = "__AGENT_DECK_NO_STATUS_LINE__";

interface HookHandler {
  type?: unknown;
  command?: unknown;
  timeout?: unknown;
}

interface HookGroup {
  matcher?: unknown;
  hooks?: HookHandler[];
  [key: string]: unknown;
}

interface ClaudeSettings {
  hooks?: Record<string, HookGroup[]>;
  statusLine?: {
    type?: unknown;
    command?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ClaudeHookOptions {
  path?: string;
  reporterPath?: string;
  nodePath?: string;
  now?: () => Date;
}

const defaultPath = (): string =>
  resolve(homedir(), ".claude", "settings.json");

const defaultReporterPath = (): string =>
  fileURLToPath(
    import.meta.resolve("@agent-deck/provider-claude-code/reporter"),
  );

const load = async (path: string): Promise<ClaudeSettings> => {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error(`Claude settings must contain a JSON object: ${path}`);
    return parsed as ClaudeSettings;
  } catch (error) {
    const code =
      typeof error === "object" && error && "code" in error
        ? String(error.code)
        : "";
    if (code === "ENOENT") return {};
    throw error;
  }
};

const reporterAvailable = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};

const isAgentDeckHandler = (handler: HookHandler): boolean =>
  typeof handler.command === "string" && handler.command.includes(MARKER);

const statusCommand = (
  reporterPath: string,
  nodePath: string,
  previous: string | undefined,
): string =>
  `${JSON.stringify(nodePath)} ${JSON.stringify(reporterPath)} --status-line ${Buffer.from(
    previous ?? NO_STATUS_LINE,
  ).toString("base64url")}`;

const previousStatusCommand = (command: unknown): string | undefined => {
  if (typeof command !== "string" || !command.includes(MARKER))
    return undefined;
  const encoded = command.match(/--status-line\s+([A-Za-z0-9_-]+)/)?.[1];
  if (!encoded) return undefined;
  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  return decoded === NO_STATUS_LINE ? "" : decoded;
};

const complete = (settings: ClaudeSettings): boolean =>
  EVENTS.every((event) =>
    settings.hooks?.[event]?.some((group) =>
      group.hooks?.some(isAgentDeckHandler),
    ),
  ) &&
  typeof settings.statusLine?.command === "string" &&
  settings.statusLine.command.includes(MARKER);

const validate = (settings: ClaudeSettings, path: string): void => {
  if (
    settings.hooks !== undefined &&
    (!settings.hooks ||
      typeof settings.hooks !== "object" ||
      Array.isArray(settings.hooks))
  )
    throw new Error(`Invalid Claude hooks collection in ${path}`);
  for (const groups of Object.values(settings.hooks ?? {})) {
    if (!Array.isArray(groups))
      throw new Error(`Invalid Claude hook event collection in ${path}`);
    for (const group of groups)
      if (
        !group ||
        typeof group !== "object" ||
        (group.hooks !== undefined && !Array.isArray(group.hooks))
      )
        throw new Error(`Invalid Claude hook group in ${path}`);
  }
};

const writeAtomically = async (
  path: string,
  settings: ClaudeSettings,
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.agent-deck.tmp`;
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
};

const backup = async (path: string, now: Date): Promise<void> => {
  try {
    await copyFile(
      path,
      `${path}.backup-${now.toISOString().replaceAll(":", "-")}`,
    );
  } catch (error) {
    const code =
      typeof error === "object" && error && "code" in error
        ? String(error.code)
        : "";
    if (code !== "ENOENT") throw error;
  }
};

export const installClaudeHooks = async (
  options: ClaudeHookOptions = {},
): Promise<string> => {
  const path = options.path ?? defaultPath();
  const reporterPath = options.reporterPath ?? defaultReporterPath();
  if (!(await reporterAvailable(reporterPath)))
    throw new Error(
      `Claude Code reporter is missing at ${reporterPath}. Build Agent Deck before installing hooks.`,
    );
  const settings = await load(path);
  validate(settings, path);
  const nodePath = options.nodePath ?? process.execPath;
  const command = `${JSON.stringify(nodePath)} ${JSON.stringify(reporterPath)}`;
  const currentStatus =
    typeof settings.statusLine?.command === "string"
      ? settings.statusLine.command
      : undefined;
  const priorStatus = currentStatus?.includes(MARKER)
    ? previousStatusCommand(currentStatus)
    : currentStatus;
  const desiredStatus = statusCommand(
    reporterPath,
    nodePath,
    priorStatus || undefined,
  );
  const missingEvents = EVENTS.filter(
    (event) =>
      !settings.hooks?.[event]?.some((group) =>
        group.hooks?.some(isAgentDeckHandler),
      ),
  );
  if (!missingEvents.length && currentStatus === desiredStatus)
    return `Agent Deck Claude Code hooks already installed in ${path}`;
  await backup(path, options.now?.() ?? new Date());
  settings.hooks ??= {};
  for (const event of missingEvents) {
    settings.hooks[event] ??= [];
    settings.hooks[event].push({
      hooks: [{ type: "command", command, timeout: 1 }],
    });
  }
  settings.statusLine = {
    ...(settings.statusLine ?? {}),
    type: "command",
    command: desiredStatus,
  };
  await writeAtomically(path, settings);
  return `Installed Agent Deck Claude Code hooks in ${path}. Restart active Claude Code sessions.`;
};

export const uninstallClaudeHooks = async (
  options: ClaudeHookOptions = {},
): Promise<string> => {
  const path = options.path ?? defaultPath();
  const settings = await load(path);
  validate(settings, path);
  const installed =
    Object.values(settings.hooks ?? {}).some((groups) =>
      groups.some((group) => group.hooks?.some(isAgentDeckHandler)),
    ) ||
    (typeof settings.statusLine?.command === "string" &&
      settings.statusLine.command.includes(MARKER));
  if (!installed)
    return `Agent Deck Claude Code hooks are not installed in ${path}`;
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    const remaining = groups
      .map((group) => {
        const hooks = group.hooks?.filter(
          (handler) => !isAgentDeckHandler(handler),
        );
        return { ...group, ...(hooks ? { hooks } : {}) };
      })
      .filter((group) => (group.hooks?.length ?? 0) > 0);
    if (remaining.length) settings.hooks![event] = remaining;
    else delete settings.hooks![event];
  }
  if (settings.hooks && !Object.keys(settings.hooks).length)
    delete settings.hooks;
  const previous = previousStatusCommand(settings.statusLine?.command);
  if (previous !== undefined) {
    if (previous)
      settings.statusLine = { ...settings.statusLine, command: previous };
    else delete settings.statusLine;
  }
  await writeAtomically(path, settings);
  return `Removed Agent Deck Claude Code hooks from ${path}`;
};

export const claudeHookStatus = async (
  options: ClaudeHookOptions = {},
): Promise<string> => {
  const path = options.path ?? defaultPath();
  const settings = await load(path);
  validate(settings, path);
  if (!complete(settings))
    return `Agent Deck Claude Code hooks are not installed in ${path}`;
  const reporterPath = options.reporterPath ?? defaultReporterPath();
  return (await reporterAvailable(reporterPath))
    ? `Agent Deck Claude Code hooks are installed in ${path}`
    : `Agent Deck Claude Code hooks are configured in ${path}, but the reporter is missing at ${reporterPath}`;
};
