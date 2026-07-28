import { describe, expect, it } from "vitest";
import { sanitizeCursorHook } from "./hook-payload.js";

describe("Cursor hook payload sanitizer", () => {
  it("allowlists lifecycle metadata and drops sensitive content", () => {
    const sanitized = sanitizeCursorHook({
      hook_event_name: "preToolUse",
      conversation_id: "conversation-1",
      generation_id: "generation-1",
      tool_call_id: "tool-1",
      workspace_roots: ["/workspace/alpha", 42],
      composer_mode: "agent",
      prompt: "SECRET PROMPT",
      transcript_path: "/secret/transcript.jsonl",
      tool_input: { command: "SECRET COMMAND" },
      tool_result: "SECRET RESULT",
      user_email: "secret@example.com",
    });
    expect(sanitized).toEqual({
      hook_event_name: "preToolUse",
      conversation_id: "conversation-1",
      generation_id: "generation-1",
      tool_use_id: "tool-1",
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
});
