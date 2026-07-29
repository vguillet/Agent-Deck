import {
  mkdir,
  mkdtemp,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  codexHookStatus,
  installCodexHooks,
  uninstallCodexHooks,
} from "./codex-hooks.js";

const reporterPathFor = (path: string): string =>
  resolve(dirname(path), "codex", "dist", "hook-reporter.js");

const temporaryHooksPath = async (): Promise<string> => {
  const path = resolve(
    await mkdtemp(resolve(tmpdir(), "agent-deck-codex-hooks-")),
    "hooks.json",
  );
  const reporterPath = reporterPathFor(path);
  await mkdir(dirname(reporterPath), { recursive: true });
  await writeFile(reporterPath, "");
  return path;
};

const options = (path: string) => ({
  path,
  reporterPath: reporterPathFor(path),
  nodePath: "/Applications/Node Runtime/node",
  now: () => new Date("2026-07-29T10:00:00.000Z"),
});

describe("Codex hook installer", () => {
  it("preserves existing hooks and installs idempotently", async () => {
    const path = await temporaryHooksPath();
    await writeFile(
      path,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "existing hook" }],
            },
          ],
        },
      }),
    );

    await installCodexHooks(options(path));
    await installCodexHooks(options(path));
    const file = JSON.parse(await readFile(path, "utf8")) as {
      hooks: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
    };
    expect(file.hooks.PreToolUse?.[0]?.hooks?.[0]?.command).toBe(
      "existing hook",
    );
    expect(
      Object.values(file.hooks)
        .flatMap((groups) => groups)
        .flatMap((group) => group.hooks ?? [])
        .filter((hook) =>
          hook.command?.includes("codex/dist/hook-reporter.js"),
        ),
    ).toHaveLength(7);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await codexHookStatus(options(path))).toContain("are installed");
  });

  it("repairs a partial installation and uninstalls only Agent Deck", async () => {
    const path = await temporaryHooksPath();
    const command =
      '"/Applications/Node Runtime/node" "/Applications/Agent Deck/plugins/codex/dist/hook-reporter.js"';
    await writeFile(
      path,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command }] }],
          Stop: [
            {
              hooks: [{ type: "command", command: "existing stop hook" }],
            },
          ],
        },
      }),
    );

    await installCodexHooks(options(path));
    let file = JSON.parse(await readFile(path, "utf8")) as {
      hooks: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
    };
    expect(file.hooks.SessionStart).toHaveLength(1);
    expect(file.hooks.PostToolUse).toHaveLength(1);

    await uninstallCodexHooks(options(path));
    file = JSON.parse(await readFile(path, "utf8")) as typeof file;
    expect(file.hooks).toEqual({
      Stop: [
        {
          hooks: [{ type: "command", command: "existing stop hook" }],
        },
      ],
    });
    expect(await codexHookStatus(options(path))).toContain("not installed");
  });

  it("reports and rejects an installation whose reporter is missing", async () => {
    const path = await temporaryHooksPath();
    await installCodexHooks(options(path));
    await unlink(reporterPathFor(path));

    expect(await codexHookStatus(options(path))).toContain(
      "reporter is missing",
    );
    await expect(installCodexHooks(options(path))).rejects.toThrow(
      "Codex hook reporter is missing",
    );
  });
});
