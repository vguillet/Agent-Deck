import { describe, expect, it } from "vitest";
import { sanitizeClaudeHook, sanitizeClaudeStatus } from "./payload.js";

describe("Claude Code payload sanitizers", () => {
  it("retains lifecycle metadata but drops sensitive content", () => {
    const payload = sanitizeClaudeHook({
      session_id: "session-1",
      hook_event_name: "PreToolUse",
      cwd: "/workspace/aquila",
      prompt_id: "prompt-1",
      tool_use_id: "tool-1",
      tool_name: "AskUserQuestion",
      tool_input: { question: "SECRET" },
      transcript_path: "/secret/transcript.jsonl",
      permission_mode: "plan",
    });
    expect(payload).toMatchObject({
      session_id: "session-1",
      prompt_id: "prompt-1",
      agent_activity: "waiting",
      agent_signal: "question_started",
      permission_mode: "plan",
    });
    expect(JSON.stringify(payload)).not.toContain("SECRET");
    expect(JSON.stringify(payload)).not.toContain("transcript");
  });

  it("extracts official usage windows and workspace identity", () => {
    expect(
      sanitizeClaudeStatus(
        {
          session_id: "session-1",
          session_name: "Refactor",
          cwd: "/workspace/aquila",
          workspace: {
            project_dir: "/workspace/aquila",
            added_dirs: ["/workspace/shared"],
          },
          rate_limits: {
            five_hour: { used_percentage: 23.5, resets_at: 1_800_000_000 },
            seven_day: { used_percentage: 41.2, resets_at: 1_800_100_000 },
          },
          cost: { total_cost_usd: 999 },
        },
        "2026-08-01T20:00:00.000Z",
      ),
    ).toEqual({
      protocol_version: 1,
      session_id: "session-1",
      session_name: "Refactor",
      workspace_roots: ["/workspace/aquila", "/workspace/shared"],
      usage: {
        providerId: "claude-code",
        status: "available",
        windows: [
          {
            id: "five-hour",
            label: "5h",
            usedPercent: 23.5,
            available: true,
            resetsAt: "2027-01-15T08:00:00.000Z",
          },
          {
            id: "weekly",
            label: "Week",
            usedPercent: 41.2,
            available: true,
            resetsAt: "2027-01-16T11:46:40.000Z",
          },
        ],
        observedAt: "2026-08-01T20:00:00.000Z",
      },
    });
  });
});
