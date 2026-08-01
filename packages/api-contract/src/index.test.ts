import { describe, expect, it } from "vitest";
import {
  AgentCommandRequestSchema,
  AgentCreationContextSchema,
  AgentCreationRequestSchema,
  AgentJsonSchema,
  AgentSchema,
  CompatibleCursorFocusIntentFrameSchema,
  CursorFocusResultStatusSchema,
  CursorWindowClientFrameSchema,
  CursorWindowServerFrameSchema,
  EventSchema,
  workspaceRootsKey,
} from "./index.js";

const agent = {
  id: "codex:thread-1",
  providerId: "codex",
  externalId: "thread-1",
  title: "Agent focus",
  state: "running",
  activityEpoch: "run-1",
  requiresAttention: false,
  lastActivityAt: "2026-07-28T09:00:00.000Z",
  revision: 1,
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

describe("Agent lifecycle contract", () => {
  it("requires a non-empty activity epoch", () => {
    const withoutEpoch = { ...agent } as Partial<typeof agent>;
    delete withoutEpoch.activityEpoch;
    expect(() => AgentSchema.parse(withoutEpoch)).toThrow();
    expect(() => AgentSchema.parse({ ...agent, activityEpoch: "" })).toThrow();
  });

  it("does not publish freshness or archive fields", () => {
    expect(AgentJsonSchema).not.toHaveProperty("properties.freshness");
    expect(AgentJsonSchema).not.toHaveProperty("properties.archived");
  });

  it("accepts canonical removal events", () => {
    const event = {
      sequence: 1,
      eventId: "event-1",
      providerId: "codex",
      type: "agent.removed",
      occurredAt: "2026-07-28T09:02:00.000Z",
      observedAt: "2026-07-28T09:02:00.000Z",
      agentId: agent.id,
      payload: { agent },
    };
    expect(EventSchema.parse(event).type).toBe("agent.removed");
    expect(
      EventSchema.parse({
        ...event,
        type: "run.removed",
        runId: "codex:run-1",
      }).type,
    ).toBe("run.removed");
  });

  it("allows cancellation but rejects archive commands", () => {
    expect(AgentCommandRequestSchema.parse({ action: "cancel" })).toEqual({
      action: "cancel",
    });
    expect(() =>
      AgentCommandRequestSchema.parse({ action: "archive" }),
    ).toThrow();
  });
});

describe("Agent progress contract", () => {
  it("accepts coarse activity and numeric plan counts", () => {
    expect(
      AgentSchema.parse({
        ...agent,
        progress: {
          activity: "planning",
          plan: { completed: 2, total: 4 },
          observedAt: "2026-07-28T09:01:00.000Z",
        },
      }).progress,
    ).toMatchObject({
      activity: "planning",
      plan: { completed: 2, total: 4 },
    });
  });

  it("rejects impossible plan counts", () => {
    expect(() =>
      AgentSchema.parse({
        ...agent,
        progress: {
          activity: "planning",
          plan: { completed: 5, total: 4 },
          observedAt: "2026-07-28T09:01:00.000Z",
        },
      }),
    ).toThrow();
  });
});

describe("Agent hierarchy contract", () => {
  it("accepts typed subagents with canonical parents", () => {
    expect(
      AgentSchema.parse({
        ...agent,
        kind: "subagent",
        parentAgentId: "cursor-local:parent-1",
      }),
    ).toMatchObject({
      kind: "subagent",
      parentAgentId: "cursor-local:parent-1",
    });
  });
});

describe("Cursor window focus contract", () => {
  it("represents focus supersession without treating it as failure", () => {
    expect(CursorFocusResultStatusSchema.parse("superseded")).toBe(
      "superseded",
    );
  });

  it("validates agent creation requests and window frames", () => {
    expect(
      AgentCreationRequestSchema.parse({ providerId: "cursor-local" }),
    ).toEqual({ providerId: "cursor-local" });
    expect(() =>
      AgentCreationRequestSchema.parse({ providerId: "unknown" }),
    ).toThrow();
    expect(
      CursorWindowServerFrameSchema.parse({
        type: "creation.intent",
        requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        providerId: "codex",
      }),
    ).toMatchObject({ type: "creation.intent", providerId: "codex" });
    expect(
      CursorWindowServerFrameSchema.parse({
        type: "window.registered",
        workspace: {
          id: "agent-deck:workspace:alpha",
          providerId: "agent-deck",
          externalId: "alpha",
          name: "alpha",
          colour: "#123456",
          metadata: {},
        },
      }),
    ).toMatchObject({
      type: "window.registered",
      workspace: { colour: "#123456" },
    });
    expect(
      CursorWindowClientFrameSchema.parse({
        type: "creation.result",
        requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        status: "opened",
      }),
    ).toMatchObject({ type: "creation.result", status: "opened" });
    expect(
      AgentCreationContextSchema.parse({
        status: "available",
        workspaceRoots: ["/workspace/alpha"],
        workspaceColour: "#123456",
      }),
    ).toMatchObject({
      workspaceRoots: ["/workspace/alpha"],
      workspaceColour: "#123456",
    });
  });

  it("validates live window registration and normalizes root ordering", () => {
    expect(
      CursorWindowClientFrameSchema.parse({
        type: "window.register",
        windowInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        workspaceRoots: ["/workspace/b", "/workspace/a"],
        launchTarget: "/workspace/project.code-workspace",
        focused: false,
        version: "0.3.0",
        focusProtocolVersion: 2,
        focusKinds: ["cursor.conversation", "codex.thread"],
      }).type,
    ).toBe("window.register");
    expect(workspaceRootsKey(["/workspace/b", "/workspace/a"])).toBe(
      workspaceRootsKey(["/workspace/a", "/workspace/b"]),
    );
  });

  it("accepts protocol-v2 focus cancellation frames", () => {
    expect(
      CursorWindowServerFrameSchema.parse({
        type: "focus.cancel",
        requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    ).toEqual({
      type: "focus.cancel",
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });
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
