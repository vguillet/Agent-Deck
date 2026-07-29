import { describe, expect, it } from "vitest";
import { sanitizeCodexHook } from "./hook-payload.js";

describe("sanitizeCodexHook", () => {
  it("keeps lifecycle metadata and identifies user-input requests", () => {
    expect(
      sanitizeCodexHook({
        session_id: "thr_test",
        hook_event_name: "PreToolUse",
        cwd: "/workspace/aquila",
        turn_id: "turn_test",
        tool_use_id: "tool_test",
        tool_name: "request_user_input",
        permission_mode: "plan",
        tool_input: { questions: [{ question: "Secret question" }] },
        transcript_path: "/secret/transcript.jsonl",
      }),
    ).toEqual({
      protocol_version: 1,
      session_id: "thr_test",
      hook_event_name: "PreToolUse",
      cwd: "/workspace/aquila",
      turn_id: "turn_test",
      tool_use_id: "tool_test",
      tool_name: "request_user_input",
      permission_mode: "plan",
      agent_signal: "question_started",
    });
  });

  it("rejects unsupported or incomplete payloads", () => {
    expect(
      sanitizeCodexHook({
        session_id: "thr_test",
        hook_event_name: "PreCompact",
        cwd: "/workspace/aquila",
      }),
    ).toBeUndefined();
    expect(
      sanitizeCodexHook({
        hook_event_name: "Stop",
        cwd: "/workspace/aquila",
      }),
    ).toBeUndefined();
  });
});
