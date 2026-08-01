import { spawn } from "node:child_process";

export const NO_STATUS_LINE = "__AGENT_DECK_NO_STATUS_LINE__";

export const decodeStatusLineCommand = (
  encoded: string | undefined,
): string | undefined => {
  if (!encoded) return undefined;
  const command = Buffer.from(encoded, "base64url").toString("utf8");
  return command === NO_STATUS_LINE ? undefined : command;
};

export const executeStatusLine = async (
  command: string,
  input: Buffer,
): Promise<{ stdout: Buffer; stderr: Buffer }> => {
  const child = spawn(command, {
    shell: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
  child.stdin.end(input);
  await new Promise<void>((resolve) => {
    child.once("close", () => resolve());
    child.once("error", () => resolve());
  });
  return {
    stdout: Buffer.concat(stdout),
    stderr: Buffer.concat(stderr),
  };
};
