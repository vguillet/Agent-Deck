import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type {
  CursorFocusResult,
  CursorFocusTarget,
} from "@agent-deck/api-contract";
import { workspaceRootsKey } from "@agent-deck/api-contract";
import type { Agent } from "@agent-deck/domain";
import type { CursorWindowBroker } from "./cursor-window-broker.js";

export type CursorLinkLauncher = (href: string) => Promise<void>;

type FocusOperation =
  | {
      kind: "broker";
      key: string;
      target: CursorFocusTarget;
    }
  | {
      kind: "link";
      key: string;
      href: string;
    }
  | {
      kind: "unavailable";
      key: string;
      message: string;
    };

interface FocusCaller {
  requestId: string;
  resolve(result: CursorFocusResult): void;
}

interface FocusJob {
  controller: AbortController;
  operation: FocusOperation;
  callers: FocusCaller[];
}

const normalizedRoots = (roots: readonly string[]): string[] =>
  [...new Set(roots.map((root) => resolve(root)))].sort();

export const cursorTargetKey = (target: CursorFocusTarget): string =>
  target.kind === "cursor.conversation"
    ? `${target.kind}:${target.conversationId}:${workspaceRootsKey(
        normalizedRoots(target.workspaceRoots),
      )}`
    : target.kind === "codex.thread"
      ? `${target.kind}:${target.threadId}:${resolve(target.cwd)}`
      : `${target.kind}:${target.sessionId}:${workspaceRootsKey(
          normalizedRoots(target.workspaceRoots),
        )}`;

const unavailable = (agentId: string, message: string): FocusOperation => ({
  kind: "unavailable",
  key: `unavailable:${agentId}:${message}`,
  message,
});

export class AgentFocusCoordinator {
  private active: FocusJob | undefined;
  private desired: FocusOperation | undefined;
  private reassertKey: string | undefined;

  constructor(
    private readonly getAgent: (id: string) => Agent | undefined,
    private readonly cursorWindows: CursorWindowBroker,
    private readonly launchLink: CursorLinkLauncher,
  ) {}

  focusAgent(agentId: string): Promise<CursorFocusResult> {
    const agent = this.getAgent(agentId);
    const operation = this.operationFor(agentId, agent);
    return new Promise<CursorFocusResult>((resolvePromise) => {
      const caller: FocusCaller = {
        requestId: randomUUID(),
        resolve: resolvePromise,
      };
      this.enqueue(operation, caller);
    });
  }

  registeredCursorWindowCount(): number {
    return this.cursorWindows.registeredCount();
  }

  lateOpened(target: CursorFocusTarget): void {
    const staleKey = `broker:${cursorTargetKey(target)}`;
    const desired = this.desired;
    if (!desired || desired.kind === "unavailable" || desired.key === staleKey)
      return;
    this.reassert(desired);
  }

  private enqueue(operation: FocusOperation, caller?: FocusCaller): void {
    this.desired = operation;
    if (this.reassertKey !== operation.key) this.reassertKey = undefined;

    if (this.active?.operation.key === operation.key) {
      if (caller) this.active.callers.push(caller);
      return;
    }

    const job: FocusJob = {
      controller: new AbortController(),
      operation,
      callers: caller ? [caller] : [],
    };
    if (this.active) {
      this.supersede(this.active);
      if (this.active.operation.kind === "link") this.active.controller.abort();
    }
    this.active = job;
    void this.run(job);
  }

  private async run(job: FocusJob): Promise<void> {
    let result: Omit<CursorFocusResult, "requestId">;
    try {
      result = await this.execute(job.operation);
    } catch (error) {
      result = {
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }

    if (this.active !== job) {
      if (job.operation.kind === "broker" && result.status === "opened") {
        const desired = this.desired;
        if (desired && desired.kind !== "unavailable") this.reassert(desired);
      }
      if (job.operation.kind === "link" && job.controller.signal.aborted) {
        const desired = this.desired;
        if (desired && desired.kind !== "unavailable") this.reassert(desired);
      }
      return;
    }
    for (const caller of job.callers)
      caller.resolve({ requestId: caller.requestId, ...result });
    job.callers = [];
    this.active = undefined;

    if (
      this.reassertKey === job.operation.key &&
      this.desired?.key === job.operation.key
    ) {
      this.reassertKey = undefined;
      this.enqueue(this.desired);
    }
  }

  private async execute(
    operation: FocusOperation,
  ): Promise<Omit<CursorFocusResult, "requestId">> {
    if (operation.kind === "unavailable")
      return { status: "unavailable", message: operation.message };
    if (operation.kind === "link") {
      await this.launchLink(operation.href);
      return { status: "opened" };
    }
    const result = await this.cursorWindows.focus(operation.target);
    return {
      status: result.status,
      ...(result.message ? { message: result.message } : {}),
    };
  }

  private supersede(job: FocusJob): void {
    for (const caller of job.callers)
      caller.resolve({
        requestId: caller.requestId,
        status: "superseded",
        message: "Superseded by a newer focus request",
      });
    job.callers = [];
  }

  private reassert(operation: FocusOperation): void {
    if (this.active?.operation.key === operation.key) {
      this.reassertKey = operation.key;
      return;
    }
    this.enqueue(operation);
  }

  private operationFor(
    agentId: string,
    agent: Agent | undefined,
  ): FocusOperation {
    if (!agent)
      return unavailable(agentId, "The displayed agent is no longer available");

    if (agent.providerId === "cursor-local") {
      const focusAgent =
        agent.kind === "subagent" && agent.parentAgentId
          ? this.getAgent(agent.parentAgentId)
          : agent;
      if (focusAgent?.providerId !== "cursor-local")
        return unavailable(
          agent.id,
          "The sub-agent's parent Cursor conversation is no longer available",
        );
      const roots = focusAgent.metadata.workspaceRoots;
      const workspaceRoots = Array.isArray(roots)
        ? roots.filter(
            (root): root is string => typeof root === "string" && !!root,
          )
        : [];
      if (!workspaceRoots.length)
        return unavailable(
          agent.id,
          "The agent has no Cursor workspace identity",
        );
      const target: CursorFocusTarget = {
        kind: "cursor.conversation",
        conversationId: focusAgent.externalId,
        workspaceRoots,
      };
      return {
        kind: "broker",
        key: `broker:${cursorTargetKey(target)}`,
        target,
      };
    }

    if (agent.providerId === "codex") {
      const cwd = agent.metadata.cwd;
      if (typeof cwd !== "string" || !cwd)
        return unavailable(
          agent.id,
          "The Codex thread has no working directory",
        );
      const target: CursorFocusTarget = {
        kind: "codex.thread",
        threadId: agent.externalId,
        cwd,
      };
      return {
        kind: "broker",
        key: `broker:${cursorTargetKey(target)}`,
        target,
      };
    }

    if (agent.providerId === "claude-code") {
      const roots = agent.metadata.workspaceRoots;
      const workspaceRoots = Array.isArray(roots)
        ? roots.filter(
            (root): root is string => typeof root === "string" && !!root,
          )
        : [];
      const sessionId = agent.externalId.split(":agent:", 1)[0] ?? "";
      if (!workspaceRoots.length || !sessionId)
        return unavailable(
          agent.id,
          "The Claude Code session has no Cursor workspace identity",
        );
      const target: CursorFocusTarget = {
        kind: "claude.session",
        sessionId,
        workspaceRoots,
      };
      return {
        kind: "broker",
        key: `broker:${cursorTargetKey(target)}`,
        target,
      };
    }

    const link = agent.links.find((candidate) => candidate.rel === "focus");
    if (!link)
      return unavailable(agent.id, "This agent does not provide a focus link");
    let url: URL;
    try {
      url = new URL(link.href);
    } catch {
      return unavailable(agent.id, "The focus link is invalid");
    }
    if (url.protocol !== "cursor:")
      return unavailable(
        agent.id,
        `The ${url.protocol} focus scheme is not allowed`,
      );
    return { kind: "link", key: `link:${url.href}`, href: url.href };
  }
}
