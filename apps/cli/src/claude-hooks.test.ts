import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  claudeHookStatus,
  installClaudeHooks,
  uninstallClaudeHooks,
} from "./claude-hooks.js";

const temporarySettings = async (): Promise<{
  path: string;
  reporterPath: string;
}> => {
  const root = await mkdtemp(resolve(tmpdir(), "agent-deck-claude-hooks-"));
  const path = resolve(root, ".claude", "settings.json");
  const reporterPath = resolve(
    root,
    "provider-claude-code",
    "dist",
    "reporter.js",
  );
  await mkdir(dirname(path), { recursive: true });
  await mkdir(dirname(reporterPath), { recursive: true });
  await writeFile(reporterPath, "");
  return { path, reporterPath };
};

describe("Claude Code hook installer", () => {
  it("preserves hooks and status line, installs idempotently, and restores", async () => {
    const { path, reporterPath } = await temporarySettings();
    await writeFile(
      path,
      JSON.stringify({
        custom: true,
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "existing hook" }],
            },
          ],
        },
        statusLine: {
          type: "command",
          command: "existing status",
          padding: 1,
        },
      }),
    );
    const options = {
      path,
      reporterPath,
      nodePath: "/Applications/Node Runtime/node",
      now: () => new Date("2026-08-01T20:00:00.000Z"),
    };
    await installClaudeHooks(options);
    await installClaudeHooks(options);
    let settings = JSON.parse(await readFile(path, "utf8")) as {
      custom: boolean;
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      statusLine?: { command: string; padding?: number };
    };
    expect(settings.custom).toBe(true);
    expect(settings.hooks.PreToolUse?.[0]?.hooks[0]?.command).toBe(
      "existing hook",
    );
    expect(
      Object.values(settings.hooks)
        .flatMap((groups) => groups)
        .flatMap((group) => group.hooks)
        .filter((handler) =>
          handler.command.includes("provider-claude-code/dist/reporter.js"),
        ),
    ).toHaveLength(14);
    expect(settings.statusLine?.command).toContain("--status-line");
    expect(settings.statusLine?.padding).toBe(1);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await claudeHookStatus(options)).toContain("are installed");

    await uninstallClaudeHooks(options);
    settings = JSON.parse(await readFile(path, "utf8")) as typeof settings;
    expect(settings.hooks).toEqual({
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: "existing hook" }],
        },
      ],
    });
    expect(settings.statusLine).toEqual({
      type: "command",
      command: "existing status",
      padding: 1,
    });
  });

  it("removes a status line that did not exist before installation", async () => {
    const { path, reporterPath } = await temporarySettings();
    const options = { path, reporterPath, nodePath: "/usr/bin/node" };
    await installClaudeHooks(options);
    await uninstallClaudeHooks(options);
    expect(JSON.parse(await readFile(path, "utf8"))).not.toHaveProperty(
      "statusLine",
    );
  });
});
