import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PermissionRequest",
  "Stop",
  "SessionEnd",
] as const;
const MARKER = "provider-codex/dist/hook-reporter.js";

interface HookHandler {
  type?: unknown;
  command?: unknown;
  timeout?: unknown;
  statusMessage?: unknown;
}

interface HookGroup {
  matcher?: unknown;
  hooks?: HookHandler[];
  [key: string]: unknown;
}

interface HooksFile {
  description?: unknown;
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

const hooksPath = (): string => resolve(homedir(), ".codex", "hooks.json");

const load = async (path: string): Promise<HooksFile> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as HooksFile;
  } catch (error) {
    const code =
      typeof error === "object" && error && "code" in error
        ? String(error.code)
        : "";
    if (code === "ENOENT") return {};
    throw error;
  }
};

const reporterPath = (): string => {
  const url = import.meta.resolve("@agent-deck/provider-codex/hook-reporter");
  return fileURLToPath(url);
};

const isAgentDeckHandler = (handler: HookHandler): boolean =>
  typeof handler.command === "string" && handler.command.includes(MARKER);

const hasAgentDeckHandler = (file: HooksFile): boolean =>
  Object.values(file.hooks ?? {}).some((groups) =>
    groups.some((group) => group.hooks?.some(isAgentDeckHandler)),
  );

const writeAtomically = async (
  path: string,
  file: HooksFile,
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.agent-deck.tmp`;
  await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
};

export const installCodexHooks = async (): Promise<string> => {
  const path = hooksPath();
  const file = await load(path);
  if (hasAgentDeckHandler(file))
    return `Agent Deck hooks already installed in ${path}`;
  try {
    await copyFile(
      path,
      `${path}.backup-${new Date().toISOString().replaceAll(":", "-")}`,
    );
  } catch (error) {
    const code =
      typeof error === "object" && error && "code" in error
        ? String(error.code)
        : "";
    if (code !== "ENOENT") throw error;
  }
  const command = `node ${JSON.stringify(reporterPath())}`;
  file.hooks ??= {};
  for (const event of EVENTS) {
    file.hooks[event] ??= [];
    file.hooks[event].push({
      hooks: [
        {
          type: "command",
          command,
          timeout: 1,
          statusMessage: "Reporting state to Agent Deck",
        },
      ],
    });
  }
  await writeAtomically(path, file);
  return `Installed Agent Deck hooks in ${path}. Open /hooks in Codex and trust the new definitions.`;
};

export const uninstallCodexHooks = async (): Promise<string> => {
  const path = hooksPath();
  const file = await load(path);
  if (!hasAgentDeckHandler(file))
    return `Agent Deck hooks are not installed in ${path}`;
  if (file.hooks) {
    for (const [event, groups] of Object.entries(file.hooks)) {
      const remaining = groups
        .map((group) => {
          const hooks = group.hooks?.filter(
            (handler) => !isAgentDeckHandler(handler),
          );
          return {
            ...group,
            ...(hooks ? { hooks } : {}),
          };
        })
        .filter((group) => (group.hooks?.length ?? 0) > 0);
      if (remaining.length) file.hooks[event] = remaining;
      else delete file.hooks[event];
    }
  }
  await writeAtomically(path, file);
  return `Removed Agent Deck hooks from ${path}`;
};

export const codexHookStatus = async (): Promise<string> => {
  const path = hooksPath();
  const file = await load(path);
  return hasAgentDeckHandler(file)
    ? `Agent Deck hooks are installed in ${path}`
    : `Agent Deck hooks are not installed in ${path}`;
};
