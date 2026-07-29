import { describe, expect, it } from "vitest";
import { sanitizeCursorHook } from "./hook-payload.js";

describe("Cursor hook payload sanitizer", () => {
  it("allowlists lifecycle metadata and drops sensitive content", () => {
    const sanitized = sanitizeCursorHook({
      hook_event_name: "preToolUse",
      conversation_id: "conversation-1",
      generation_id: "generation-1",
      tool_call_id: "tool-1",
      tool_name: "AskQuestion",
      workspace_roots: ["/workspace/alpha", 42],
      composer_mode: "agent",
      prompt: "SECRET PROMPT",
      transcript_path: "/secret/transcript.jsonl",
      tool_input: { command: "SECRET COMMAND" },
      tool_result: "SECRET RESULT",
      user_email: "secret@example.com",
    });
    expect(sanitized).toEqual({
      protocol_version: 2,
      hook_event_name: "preToolUse",
      conversation_id: "conversation-1",
      generation_id: "generation-1",
      tool_use_id: "tool-1",
      tool_name: "AskQuestion",
      workspace_roots: ["/workspace/alpha"],
      composer_mode: "agent",
    });
    expect(JSON.stringify(sanitized)).not.toContain("SECRET");
  });

  it("rejects unsupported events and missing identities", () => {
    expect(
      sanitizeCursorHook({
        hook_event_name: "afterAgentThought",
        conversation_id: "conversation-1",
      }),
    ).toBeUndefined();
    expect(
      sanitizeCursorHook({ hook_event_name: "sessionStart" }),
    ).toBeUndefined();
  });

  it("converts the question sentinel without retaining its command", () => {
    const sanitized = sanitizeCursorHook({
      hook_event_name: "preToolUse",
      conversation_id: "conversation-question",
      tool_name: "Shell",
      tool_input: {
        command: "true # agent-deck:question-start SECRET",
      },
    });

    expect(sanitized).toEqual({
      protocol_version: 2,
      hook_event_name: "preToolUse",
      conversation_id: "conversation-question",
      tool_name: "Shell",
      agent_signal: "question_started",
      workspace_roots: [],
    });
    expect(JSON.stringify(sanitized)).not.toContain("SECRET");
  });

  it("retains only subagent identity metadata", () => {
    expect(
      sanitizeCursorHook({
        hook_event_name: "subagentStart",
        subagent_id: "child-1",
        parent_conversation_id: "parent-1",
        task: "SECRET TASK",
        subagent_model: "SECRET MODEL",
      }),
    ).toEqual({
      protocol_version: 2,
      hook_event_name: "subagentStart",
      subagent_id: "child-1",
      parent_conversation_id: "parent-1",
      workspace_roots: [],
    });
  });

  it("recognizes background sessions from Cursor's session identity", () => {
    expect(
      sanitizeCursorHook({
        hook_event_name: "sessionStart",
        session_id: "background-1",
        is_background_agent: true,
      }),
    ).toEqual({
      protocol_version: 2,
      hook_event_name: "sessionStart",
      conversation_id: "background-1",
      conversation_kind: "background",
      workspace_roots: [],
    });
  });

  it("positively classifies interactive sessions as top level", () => {
    expect(
      sanitizeCursorHook({
        hook_event_name: "sessionStart",
        session_id: "top-1",
        is_background_agent: false,
      }),
    ).toMatchObject({
      protocol_version: 2,
      conversation_id: "top-1",
      conversation_kind: "top_level",
    });
  });

  it("identifies subagent transcripts without retaining their path", () => {
    const sanitized = sanitizeCursorHook({
      hook_event_name: "preToolUse",
      conversation_id: "child-1",
      transcript_path:
        "/private/cursor/agent-transcripts/parent/subagents/child-1.jsonl",
    });
    expect(sanitized).toBeUndefined();
  });
});
