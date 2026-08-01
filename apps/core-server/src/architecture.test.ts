import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sourceFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = resolve(directory, entry.name);
      if (
        entry.isDirectory() &&
        (entry.name === "node_modules" || entry.name === "dist")
      )
        return Promise.resolve([]);
      return entry.isDirectory()
        ? sourceFiles(path)
        : Promise.resolve(entry.name.endsWith(".ts") ? [path] : []);
    }),
  );
  return nested.flat();
};

describe("core dependency boundary", () => {
  it("does not import provider or client implementations", async () => {
    const directory = resolve(import.meta.dirname);
    const contents = await Promise.all(
      (await sourceFiles(directory))
        .filter((path) => !path.endsWith(".test.ts"))
        .map((path) => readFile(path, "utf8")),
    );
    const source = contents.join("\n");
    expect(source).not.toMatch(/@cursor\/sdk/);
    expect(source).not.toMatch(/@elgato\/streamdeck/);
    expect(source).not.toMatch(/@agent-deck\/provider-(codex|cursor-local)/);
    expect(source).not.toMatch(/clients\/stream-deck/);
  });

  it("contains no committed ad-hoc diagnostic transport", async () => {
    const root = resolve(import.meta.dirname, "../../..");
    const files = (
      await Promise.all(
        ["apps", "clients", "packages", "plugins"].map((directory) =>
          sourceFiles(resolve(root, directory)),
        ),
      )
    ).flat();
    const source = (
      await Promise.all(files.map((path) => readFile(path, "utf8")))
    ).join("\n");
    expect(source).not.toContain(["127.0.0.1", "7387"].join(":"));
    expect(source).not.toContain(["#region", "agent", "log"].join(" "));
  });
});
