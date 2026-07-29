import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import type { Agent } from "@agent-deck/domain";

export type FocusResult =
  | { status: "opened"; href: string }
  | { status: "unavailable"; reason: string };

export type FocusLauncher = (href: string) => Promise<void>;
export type ProcessLauncher = (
  file: string,
  arguments_: string[],
) => Promise<void>;

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

interface PressCallbacks {
  onDoublePress(): void;
  onLongPress(): void;
}

interface ActivePress {
  longPressTimer?: NodeJS.Timeout;
  handled: boolean;
}

interface PendingSinglePress {
  timer: NodeJS.Timeout;
}

export class AgentPressDetector {
  private readonly active = new Map<string, ActivePress>();
  private readonly pendingSingles = new Map<string, PendingSinglePress>();

  constructor(
    private readonly doublePressWindowMs: number,
    private readonly longPressDurationMs: number,
  ) {}

  keyDown(actionId: string, callbacks: PressCallbacks): void {
    if (this.active.has(actionId)) return;
    const pendingSingle = this.pendingSingles.get(actionId);
    if (pendingSingle) {
      clearTimeout(pendingSingle.timer);
      this.pendingSingles.delete(actionId);
      this.active.set(actionId, { handled: true });
      callbacks.onDoublePress();
      return;
    }

    const active: ActivePress = { handled: false };
    const timer = setTimeout(() => {
      active.handled = true;
      callbacks.onLongPress();
    }, this.longPressDurationMs);
    timer.unref();
    active.longPressTimer = timer;
    this.active.set(actionId, active);
  }

  keyUp(actionId: string, onSinglePress: () => void): void {
    const active = this.active.get(actionId);
    if (!active) return;
    this.active.delete(actionId);
    if (active.longPressTimer) clearTimeout(active.longPressTimer);
    if (active.handled) return;

    const timer = setTimeout(() => {
      this.pendingSingles.delete(actionId);
      onSinglePress();
    }, this.doublePressWindowMs);
    timer.unref();
    this.pendingSingles.set(actionId, { timer });
  }
}

const spawnCommand: ProcessLauncher = (file, arguments_) =>
  new Promise<void>((resolvePromise, reject) => {
    const child = spawn(file, arguments_, {
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${file} exited with status ${String(code)}`));
    });
  });

export const createMacOSFocusLauncher = (
  run: ProcessLauncher = spawnCommand,
): FocusLauncher => {
  return async (href) => {
    const url = new URL(href);
    if (url.protocol !== "codex:" && url.protocol !== "cursor:")
      throw new Error(`Unsupported focus URL scheme: ${url.protocol}`);

    const isLocalCursorAgent =
      url.protocol === "cursor:" &&
      url.hostname === "agent-deck.focus" &&
      url.pathname === "/open";
    const workspace = isLocalCursorAgent
      ? (url.searchParams.get("workspace") ?? undefined)
      : undefined;
    const windowTarget = isLocalCursorAgent
      ? (url.searchParams.get("window") ?? workspace)
      : undefined;
    if (workspace !== undefined && !isAbsolute(workspace))
      throw new Error("Cursor agent focus workspace must be an absolute path");
    if (windowTarget !== undefined && !isAbsolute(windowTarget))
      throw new Error("Cursor agent focus window must be an absolute path");
    if (windowTarget)
      await run("/usr/bin/open", ["-a", "Cursor", windowTarget]);
    await run("/usr/bin/open", [url.href]);
  };
};

export const openMacOSFocusLink = createMacOSFocusLauncher();

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
