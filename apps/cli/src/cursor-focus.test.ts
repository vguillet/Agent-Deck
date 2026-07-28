import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  cursorFocusStatus,
  installCursorFocus,
  uninstallCursorFocus,
  type CursorFocusOptions,
} from "./cursor-focus.js";

const setup = async (initialVersion?: string) => {
  const directory = await mkdtemp(resolve(tmpdir(), "agent-deck-focus-"));
  const vsixPath = resolve(directory, "focus.vsix");
  await writeFile(vsixPath, "test");
  let version = initialVersion;
  const run = vi.fn(async (_file: string, arguments_: string[]) => {
    if (arguments_[0] === "--list-extensions")
      return {
        stdout: version
          ? `other.extension@1.0.0\nagent-deck.focus@${version}\n`
          : "",
        stderr: "",
      };
    if (arguments_[0] === "--install-extension") version = "0.1.0";
    if (arguments_[0] === "--uninstall-extension") version = undefined;
    return { stdout: "", stderr: "" };
  });
  const options: CursorFocusOptions = {
    cursorBinary: "/Applications/Cursor.app/cursor",
    vsixPath,
    run,
  };
  return { options, run };
};

describe("Cursor focus extension installer", () => {
  it("installs and reports status idempotently", async () => {
    const harness = await setup();
    await expect(installCursorFocus(harness.options)).resolves.toContain(
      "Installed",
    );
    await expect(installCursorFocus(harness.options)).resolves.toContain(
      "already installed",
    );
    await expect(cursorFocusStatus(harness.options)).resolves.toContain(
      "0.1.0 is installed",
    );
    expect(
      harness.run.mock.calls.filter(
        ([, arguments_]) => arguments_[0] === "--install-extension",
      ),
    ).toHaveLength(1);
  });

  it("upgrades existing versions and uninstalls only Agent Deck Focus", async () => {
    const harness = await setup("0.0.9");
    await installCursorFocus(harness.options);
    await expect(uninstallCursorFocus(harness.options)).resolves.toContain(
      "Removed",
    );
    expect(harness.run).toHaveBeenCalledWith(
      "/Applications/Cursor.app/cursor",
      ["--uninstall-extension", "agent-deck.focus"],
    );
    await expect(uninstallCursorFocus(harness.options)).resolves.toContain(
      "not installed",
    );
  });
});
