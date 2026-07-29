import { describe, expect, it } from "vitest";
import {
  AgentJsonSchema,
  AgentSchema,
  CompatibleCursorFocusIntentFrameSchema,
  CursorWindowClientFrameSchema,
  workspaceRootsKey,
} from "./index.js";

const agent = {
  id: "codex:thread-1",
  providerId: "codex",
  externalId: "thread-1",
  title: "Agent focus",
  state: "running",
  freshness: "fresh",
  requiresAttention: false,
  lastActivityAt: "2026-07-28T09:00:00.000Z",
  revision: 1,
  archived: false,
  capabilities: {
    messages: false,
    approvals: false,
    cancellation: false,
    creation: false,
  },
  links: [
    {
      rel: "focus",
      label: "Open in Cursor Codex",
      href: "cursor://agent-deck.focus/codex?threadId=thread-1&cwd=%2Fworkspace%2Falpha",
    },
  ],
  metadata: {},
};

describe("Agent focus link contract", () => {
  it("accepts focus links and publishes them in JSON Schema", () => {
    expect(AgentSchema.parse(agent).links[0]).toEqual(agent.links[0]);
    expect(JSON.stringify(AgentJsonSchema)).toContain('"focus"');
  });

  it("rejects invalid relations and URLs", () => {
    expect(() =>
      AgentSchema.parse({
        ...agent,
        links: [{ rel: "launch", label: "Open", href: "not a URL" }],
      }),
    ).toThrow();
  });
});

describe("Cursor window focus contract", () => {
  it("validates live window registration and normalizes root ordering", () => {
    expect(
      CursorWindowClientFrameSchema.parse({
        type: "window.register",
        windowInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        workspaceRoots: ["/workspace/b", "/workspace/a"],
        launchTarget: "/workspace/project.code-workspace",
        focused: false,
        version: "0.3.0",
        focusKinds: ["cursor.conversation", "codex.thread"],
      }).type,
    ).toBe("window.register");
    expect(workspaceRootsKey(["/workspace/b", "/workspace/a"])).toBe(
      workspaceRootsKey(["/workspace/a", "/workspace/b"]),
    );
  });

  it("accepts discriminated and legacy focus intents", () => {
    expect(
      CompatibleCursorFocusIntentFrameSchema.parse({
        type: "focus.intent",
        requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        target: {
          kind: "codex.thread",
          threadId: "thread-1",
          cwd: "/workspace/alpha",
        },
      }),
    ).toMatchObject({ target: { kind: "codex.thread" } });
    expect(
      CompatibleCursorFocusIntentFrameSchema.parse({
        type: "focus.intent",
        requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        conversationId: "conversation-1",
      }),
    ).toMatchObject({ conversationId: "conversation-1" });
  });
});
