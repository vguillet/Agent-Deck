import { describe, expect, it } from "vitest";
import {
  decodeStatusLineCommand,
  executeStatusLine,
  NO_STATUS_LINE,
} from "./status-line.js";

describe("Claude Code status-line pass-through", () => {
  it("distinguishes a missing previous status line", () => {
    expect(
      decodeStatusLineCommand(
        Buffer.from(NO_STATUS_LINE).toString("base64url"),
      ),
    ).toBeUndefined();
    expect(
      decodeStatusLineCommand(
        Buffer.from("printf existing").toString("base64url"),
      ),
    ).toBe("printf existing");
  });

  it("forwards the original JSON to the existing command unchanged", async () => {
    const input = Buffer.from(
      '{"session_id":"session-1","secret":"kept-local"}',
    );
    const script = `process.stdin.pipe(process.stdout)`;
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
      script,
    )}`;
    const result = await executeStatusLine(command, input);
    expect(result.stdout).toEqual(input);
    expect(result.stderr.toString()).toBe("");
  });
});
