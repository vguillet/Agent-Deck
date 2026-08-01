import { execFile } from "node:child_process";

import type { ResolvedKeyVisualTheme } from "./agent-palette.js";

export interface AppearanceCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type AppearanceCommand = () => Promise<AppearanceCommandResult>;

export const systemAppearanceChanged = (
  current: ResolvedKeyVisualTheme,
  next: ResolvedKeyVisualTheme,
): boolean => current !== next;

const runDefaults: AppearanceCommand = () =>
  new Promise((resolve) => {
    execFile(
      "/usr/bin/defaults",
      ["read", "-g", "AppleInterfaceStyle"],
      { encoding: "utf8" },
      (error, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          exitCode:
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            typeof error.code === "number"
              ? error.code
              : error
                ? 1
                : 0,
        });
      },
    );
  });

export const parseAppleInterfaceStyle = ({
  stdout,
  stderr,
  exitCode,
}: AppearanceCommandResult): ResolvedKeyVisualTheme => {
  if (exitCode === 0)
    return stdout.trim().toLowerCase() === "dark" ? "dark" : "light";
  if (
    stderr.toLowerCase().includes("does not exist") ||
    stderr.toLowerCase().includes("domain/default pair")
  )
    return "light";
  return "dark";
};

export const resolveSystemAppearance = async (
  command: AppearanceCommand = runDefaults,
): Promise<ResolvedKeyVisualTheme> => {
  try {
    return parseAppleInterfaceStyle(await command());
  } catch {
    return "dark";
  }
};
