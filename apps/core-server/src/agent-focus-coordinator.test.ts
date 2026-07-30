import { describe, expect, it, vi } from "vitest";
import type {
  CursorFocusResult,
  CursorFocusTarget,
} from "@agent-deck/api-contract";
import type { Agent, AgentLink } from "@agent-deck/domain";
import {
  AgentFocusCoordinator,
  type CursorLinkLauncher,
} from "./agent-focus-coordinator.js";
import type { CursorWindowBroker } from "./cursor-window-broker.js";

const agent = (
  providerId: string,
  externalId: string,
  metadata: Record<string, unknown> = {},
  links: AgentLink[] = [],
): Agent => ({
  id: `${providerId}:${externalId}`,
  providerId,
  externalId,
  title: externalId,
  state: "running",
  freshness: "fresh",
  requiresAttention: false,
  lastActivityAt: "2026-07-30T09:00:00.000Z",
  revision: 1,
  archived: false,
  capabilities: {
    messages: false,
    approvals: false,
    cancellation: false,
    creation: false,
  },
  links,
  metadata,
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const result = (
  status: CursorFocusResult["status"] = "opened",
): CursorFocusResult => ({
  requestId: crypto.randomUUID(),
  status,
});

const harness = (
  agents: Agent[],
  focus = vi.fn(async (_target: CursorFocusTarget) => result()),
  launch = vi.fn<CursorLinkLauncher>(async () => undefined),
) => {
  const byId = new Map(agents.map((candidate) => [candidate.id, candidate]));
  const coordinator = new AgentFocusCoordinator(
    (id) => byId.get(id),
    { focus } as unknown as CursorWindowBroker,
    launch,
  );
  return { coordinator, focus, launch };
};

describe("Agent focus coordinator", () => {
  it("maps local Cursor, Codex, and generic Cursor links centrally", async () => {
    const local = agent("cursor-local", "conversation-1", {
      workspaceRoots: ["/workspace/beta", "/workspace/alpha"],
    });
    const codex = agent("codex", "thread-1", {
      cwd: "/workspace/alpha/project",
    });
    const cloud = agent("cursor-cloud", "cloud-1", {}, [
      {
        rel: "focus",
        label: "Open",
        href: "cursor://anysphere.cursor-deeplink/background-agent?bcId=cloud-1",
      },
    ]);
    const test = harness([local, codex, cloud]);

    await expect(test.coordinator.focusAgent(local.id)).resolves.toMatchObject({
      status: "opened",
    });
    expect(test.focus).toHaveBeenLastCalledWith({
      kind: "cursor.conversation",
      conversationId: "conversation-1",
      workspaceRoots: ["/workspace/beta", "/workspace/alpha"],
    });

    await test.coordinator.focusAgent(codex.id);
    expect(test.focus).toHaveBeenLastCalledWith({
      kind: "codex.thread",
      threadId: "thread-1",
      cwd: "/workspace/alpha/project",
    });

    await test.coordinator.focusAgent(cloud.id);
    expect(test.launch).toHaveBeenCalledWith(cloud.links[0]!.href);
  });

  it("starts a replacement local conversation without waiting for prior work", async () => {
    const firstExecution = deferred<CursorFocusResult>();
    const firstLocal = agent("cursor-local", "conversation-1", {
      workspaceRoots: ["/workspace/alpha"],
    });
    const secondLocal = agent("cursor-local", "conversation-2", {
      workspaceRoots: ["/workspace/alpha"],
    });
    const focus = vi
      .fn<(target: CursorFocusTarget) => Promise<CursorFocusResult>>()
      .mockImplementationOnce(async () => firstExecution.promise)
      .mockResolvedValue(result());
    const test = harness([firstLocal, secondLocal], focus);

    const first = test.coordinator.focusAgent(firstLocal.id);
    const second = test.coordinator.focusAgent(secondLocal.id);

    await expect(first).resolves.toMatchObject({ status: "superseded" });
    await expect(second).resolves.toMatchObject({ status: "opened" });
    expect(test.focus).toHaveBeenCalledTimes(2);

    firstExecution.resolve(result("superseded"));
    await Promise.resolve();
  });

  it("coalesces identical targets while preserving caller request IDs", async () => {
    const execution = deferred<CursorFocusResult>();
    const local = agent("cursor-local", "conversation-1", {
      workspaceRoots: ["/workspace/alpha"],
    });
    const focus = vi.fn(async () => execution.promise);
    const test = harness([local], focus);

    const first = test.coordinator.focusAgent(local.id);
    const repeated = test.coordinator.focusAgent(local.id);
    expect(test.focus).toHaveBeenCalledOnce();
    execution.resolve(result());

    const [firstResult, repeatedResult] = await Promise.all([first, repeated]);
    expect(firstResult.status).toBe("opened");
    expect(repeatedResult.status).toBe("opened");
    expect(firstResult.requestId).not.toBe(repeatedResult.requestId);
  });

  it("orders missing and invalid focus requests as unavailable operations", async () => {
    const execution = deferred<CursorFocusResult>();
    const local = agent("cursor-local", "conversation-1", {
      workspaceRoots: ["/workspace/alpha"],
    });
    const invalid = agent("other", "invalid", {}, [
      { rel: "focus", label: "Open", href: "https://example.com/agent" },
    ]);
    const test = harness(
      [local, invalid],
      vi.fn(async () => execution.promise),
    );

    const first = test.coordinator.focusAgent(local.id);
    const missing = test.coordinator.focusAgent("missing:agent");
    await expect(first).resolves.toMatchObject({ status: "superseded" });
    execution.resolve(result());
    const missingResult = await missing;
    expect(missingResult.status).toBe("unavailable");
    expect(missingResult.message).toContain("no longer available");
    const invalidResult = await test.coordinator.focusAgent(invalid.id);
    expect(invalidResult.status).toBe("unavailable");
    expect(invalidResult.message).toContain("scheme");
  });

  it("reasserts the desired target after a stale open races its result", async () => {
    const first = agent("cursor-local", "conversation-1", {
      workspaceRoots: ["/workspace/alpha"],
    });
    const latest = agent("cursor-local", "conversation-2", {
      workspaceRoots: ["/workspace/beta"],
    });
    const latestExecution = deferred<CursorFocusResult>();
    const focus = vi
      .fn<(target: CursorFocusTarget) => Promise<CursorFocusResult>>()
      .mockResolvedValueOnce(result())
      .mockImplementationOnce(async () => latestExecution.promise)
      .mockResolvedValue(result());
    const test = harness([first, latest], focus);

    await test.coordinator.focusAgent(first.id);
    const latestResult = test.coordinator.focusAgent(latest.id);
    test.coordinator.lateOpened({
      kind: "cursor.conversation",
      conversationId: first.externalId,
      workspaceRoots: ["/workspace/alpha"],
    });
    expect(test.focus).toHaveBeenCalledTimes(2);
    latestExecution.resolve(result());
    await latestResult;
    await vi.waitFor(() => expect(test.focus).toHaveBeenCalledTimes(3));
    expect(test.focus).toHaveBeenLastCalledWith({
      kind: "cursor.conversation",
      conversationId: latest.externalId,
      workspaceRoots: ["/workspace/beta"],
    });
  });
});
