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
      agent_activity: "waiting",
      permission_mode: "plan",
      agent_signal: "question_started",
    });
  });

  it("keeps only coarse activity and numeric plan progress", () => {
    const sanitized = sanitizeCodexHook({
      session_id: "thr_plan",
      hook_event_name: "PreToolUse",
      cwd: "/workspace/aquila",
      tool_use_id: "tool_plan",
      tool_name: "update_plan",
      tool_input: {
        plan: [
          { step: "SECRET completed step", status: "completed" },
          { step: "SECRET active step", status: "in_progress" },
          { step: "SECRET pending step", status: "pending" },
        ],
      },
    });

    expect(sanitized).toMatchObject({
      agent_activity: "planning",
      plan_progress: { completed: 1, total: 3 },
    });
    expect(JSON.stringify(sanitized)).not.toContain("SECRET");
    expect(JSON.stringify(sanitized)).not.toContain("update_plan");
  });

  it("converts the progress sentinel without retaining its command", () => {
    const sanitized = sanitizeCodexHook({
      session_id: "thr_progress",
      hook_event_name: "PreToolUse",
      cwd: "/workspace/aquila",
      tool_name: "Shell",
      tool_input: {
        command: "true # agent-deck:progress 2 3 SECRET",
      },
    });

    expect(sanitized).toMatchObject({
      agent_activity: "planning",
      plan_progress: { completed: 2, total: 3 },
    });
    expect(JSON.stringify(sanitized)).not.toContain("SECRET");
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
    const malformedPlan = sanitizeCodexHook({
      session_id: "thr_test",
      hook_event_name: "PreToolUse",
      cwd: "/workspace/aquila",
      tool_name: "update_plan",
      tool_input: { plan: [{ step: "SECRET", status: "invalid" }] },
    });
    expect(malformedPlan).toMatchObject({ agent_activity: "planning" });
    expect(malformedPlan).not.toHaveProperty("plan_progress");
    expect(JSON.stringify(malformedPlan)).not.toContain("SECRET");
  });
});
