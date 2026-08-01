import { mkdtemp, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cursorHookStatus,
  installCursorHooks,
  uninstallCursorHooks,
} from "./cursor-hooks.js";

const temporaryHooksPath = async (): Promise<string> => {
  const directory = await mkdtemp(
    resolve(tmpdir(), "agent-deck-cursor-hooks-"),
  );
  await writeFile(resolve(directory, "reporter.js"), "");
  return resolve(directory, "hooks.json");
};

const options = (path: string) => ({
  path,
  reporterPath: resolve(dirname(path), "reporter.js"),
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
    ).toHaveLength(8);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await cursorHookStatus(options(path))).toContain("are installed");
  });

  it("adds newly supported events to an existing installation", async () => {
    const path = await temporaryHooksPath();
    const command = `"/Applications/Node Runtime/node" ${JSON.stringify(
      resolve(dirname(path), "reporter.js"),
    )} --agent-deck-cursor-local-hook`;
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        hooks: {
          sessionStart: [{ command }],
        },
      }),
    );

    await installCursorHooks(options(path));
    const file = JSON.parse(await readFile(path, "utf8")) as {
      hooks: Record<string, Array<{ command: string }>>;
    };
    expect(file.hooks.sessionStart).toHaveLength(1);
    expect(file.hooks.subagentStart).toHaveLength(1);
    expect(
      Object.values(file.hooks)
        .flat()
        .filter((hook) =>
          hook.command.includes("--agent-deck-cursor-local-hook"),
        ),
    ).toHaveLength(8);
  });

  it("repairs hooks that reference an obsolete Node runtime", async () => {
    const path = await temporaryHooksPath();
    const staleCommand = `"/obsolete/node" ${JSON.stringify(
      resolve(dirname(path), "reporter.js"),
    )} --agent-deck-cursor-local-hook`;
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        hooks: Object.fromEntries(
          [
            "sessionStart",
            "beforeSubmitPrompt",
            "preToolUse",
            "postToolUse",
            "postToolUseFailure",
            "subagentStart",
            "stop",
            "sessionEnd",
          ].map((event) => [event, [{ command: staleCommand }]]),
        ),
      }),
    );

    await installCursorHooks(options(path));
    const file = JSON.parse(await readFile(path, "utf8")) as {
      hooks: Record<string, Array<{ command: string }>>;
    };
    expect(
      Object.values(file.hooks)
        .flat()
        .every((hook) =>
          hook.command.startsWith('"/Applications/Node Runtime/node"'),
        ),
    ).toBe(true);
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

  it("reports partial installations and refuses a missing reporter", async () => {
    const path = await temporaryHooksPath();
    const command = `"/Applications/Node Runtime/node" ${JSON.stringify(
      resolve(dirname(path), "reporter.js"),
    )} --agent-deck-cursor-local-hook`;
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        hooks: { sessionStart: [{ command }] },
      }),
    );
    expect(await cursorHookStatus(options(path))).toContain(
      "partially installed",
    );

    await installCursorHooks(options(path));
    await unlink(resolve(dirname(path), "reporter.js"));
    expect(await cursorHookStatus(options(path))).toContain(
      "reporter is unavailable",
    );
    await expect(installCursorHooks(options(path))).rejects.toThrow(
      "reporter is unavailable",
    );
  });
});
