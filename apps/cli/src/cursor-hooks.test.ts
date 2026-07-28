import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cursorHookStatus,
  installCursorHooks,
  uninstallCursorHooks,
} from "./cursor-hooks.js";

const temporaryHooksPath = async (): Promise<string> =>
  resolve(
    await mkdtemp(resolve(tmpdir(), "agent-deck-cursor-hooks-")),
    "hooks.json",
  );

const options = (path: string) => ({
  path,
  reporterPath: "/Applications/Agent Deck/reporter.js",
  nodePath: "/Applications/Node Runtime/node",
  now: () => new Date("2026-07-28T10:00:00.000Z"),
});

describe("Cursor hook installer", () => {
  it("preserves existing hooks and installs idempotently", async () => {
    const path = await temporaryHooksPath();
    await writeFile(
      path,
      `${JSON.stringify({
        version: 1,
        hooks: {
          preToolUse: [{ command: "existing hook", matcher: "Shell" }],
        },
      })}\n`,
    );

    await installCursorHooks(options(path));
    await installCursorHooks(options(path));
    const file = JSON.parse(await readFile(path, "utf8")) as {
      hooks: Record<string, Array<{ command: string }>>;
    };
    expect(file.hooks.preToolUse).toHaveLength(2);
    expect(file.hooks.preToolUse?.[0]?.command).toBe("existing hook");
    expect(
      Object.values(file.hooks)
        .flat()
        .filter((hook) =>
          hook.command.includes("--agent-deck-cursor-local-hook"),
        ),
    ).toHaveLength(7);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await cursorHookStatus(options(path))).toContain("are installed");
  });

  it("uninstalls only Agent Deck hooks", async () => {
    const path = await temporaryHooksPath();
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        hooks: { sessionStart: [{ command: "existing hook" }] },
      }),
    );
    await installCursorHooks(options(path));
    await uninstallCursorHooks(options(path));
    const file = JSON.parse(await readFile(path, "utf8")) as {
      hooks: Record<string, Array<{ command: string }>>;
    };
    expect(file.hooks).toEqual({
      sessionStart: [{ command: "existing hook" }],
    });
    expect(await cursorHookStatus(options(path))).toContain("not installed");
  });

  it("refuses unsupported versions and malformed JSON", async () => {
    const unsupported = await temporaryHooksPath();
    await writeFile(unsupported, JSON.stringify({ version: 2, hooks: {} }));
    await expect(installCursorHooks(options(unsupported))).rejects.toThrow(
      "Unsupported Cursor hooks version",
    );

    const malformed = await temporaryHooksPath();
    await writeFile(malformed, "{");
    await expect(installCursorHooks(options(malformed))).rejects.toThrow();
  });
});
