import { spawn } from "node:child_process";
import type { Agent } from "@agent-deck/domain";

export type FocusResult =
  | { status: "opened"; href: string }
  | { status: "unavailable"; reason: string };

export type FocusLauncher = (href: string) => Promise<void>;

export class RenderedAgentTargets {
  private readonly targets = new Map<string, string>();

  set(actionId: string, agentId: string | undefined): void {
    if (agentId) this.targets.set(actionId, agentId);
    else this.targets.delete(actionId);
  }

  resolve(actionId: string, currentAgents: Agent[]): Agent | undefined {
    const agentId = this.targets.get(actionId);
    return agentId
      ? currentAgents.find((agent) => agent.id === agentId)
      : undefined;
  }
}

export class DoublePressDetector {
  private readonly pending = new Map<string, NodeJS.Timeout>();

  constructor(private readonly windowMs: number) {}

  press(actionId: string, onSinglePress: () => void): boolean {
    const pending = this.pending.get(actionId);
    if (pending) {
      clearTimeout(pending);
      this.pending.delete(actionId);
      return true;
    }
    const timer = setTimeout(() => {
      this.pending.delete(actionId);
      onSinglePress();
    }, this.windowMs);
    timer.unref();
    this.pending.set(actionId, timer);
    return false;
  }
}

export const openMacOSFocusLink: FocusLauncher = async (href) => {
  const url = new URL(href);
  if (url.protocol !== "codex:" && url.protocol !== "cursor:")
    throw new Error(`Unsupported focus URL scheme: ${url.protocol}`);
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("/usr/bin/open", [url.href], {
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`macOS open exited with status ${String(code)}`));
    });
  });
};

export const focusAgent = async (
  agent: Agent | undefined,
  launch: FocusLauncher = openMacOSFocusLink,
): Promise<FocusResult> => {
  if (!agent)
    return { status: "unavailable", reason: "The displayed agent is gone" };
  const link = agent.links.find((candidate) => candidate.rel === "focus");
  if (!link)
    return {
      status: "unavailable",
      reason: "This agent does not provide a focus link",
    };
  let url: URL;
  try {
    url = new URL(link.href);
  } catch {
    return { status: "unavailable", reason: "The focus link is invalid" };
  }
  if (url.protocol !== "codex:" && url.protocol !== "cursor:")
    return {
      status: "unavailable",
      reason: `The ${url.protocol} focus scheme is not allowed`,
    };
  try {
    await launch(url.href);
    return { status: "opened", href: url.href };
  } catch (error) {
    return {
      status: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
};
