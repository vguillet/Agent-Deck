import { describe, expect, it, vi } from "vitest";
import {
  codexProcessEnvironment,
  resolveCodexBinary,
} from "./app-server-client.js";

describe("Codex app-server binary resolution", () => {
  it("uses a Codex executable beside Node when the service PATH omits it", () => {
    const exists = vi.fn((path: string) => path === "/opt/node/bin/codex");

    expect(resolveCodexBinary("codex", "/opt/node/bin/node", exists)).toBe(
      "/opt/node/bin/codex",
    );
    expect(exists).toHaveBeenCalledWith("/opt/node/bin/codex");
  });

  it("leaves PATH and explicit binary resolution unchanged", () => {
    expect(resolveCodexBinary("codex", "/usr/bin/node", () => false)).toBe(
      "codex",
    );
    expect(
      resolveCodexBinary("/custom/bin/codex", "/usr/bin/node", () => true),
    ).toBe("/custom/bin/codex");
  });

  it("makes Node available to Codex launch scripts", () => {
    expect(
      codexProcessEnvironment(
        { PATH: "/usr/bin:/bin", HOME: "/home/test" },
        "/opt/node/bin/node",
      ),
    ).toEqual({
      PATH: "/opt/node/bin:/usr/bin:/bin",
      HOME: "/home/test",
    });
  });
});
