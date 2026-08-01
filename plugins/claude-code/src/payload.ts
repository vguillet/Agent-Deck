import type { AgentProgressActivity, ProviderUsage } from "@agent-deck/domain";

const EVENTS = new Set([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
  "Stop",
  "StopFailure",
  "SessionEnd",
]);

export interface SanitizedClaudeHook {
  protocol_version: 1;
  session_id: string;
  hook_event_name: string;
  cwd: string;
  prompt_id?: string | undefined;
  tool_use_id?: string | undefined;
  agent_id?: string | undefined;
  agent_type?: string | undefined;
  permission_mode?: string | undefined;
  notification_type?: string | undefined;
  task_id?: string | undefined;
  status?: string | undefined;
  reason?: string | undefined;
  agent_activity?: AgentProgressActivity | undefined;
  agent_signal?: "question_started" | undefined;
}

export interface SanitizedClaudeStatus {
  protocol_version: 1;
  session_id: string;
  session_name?: string | undefined;
  workspace_roots: string[];
  usage: ProviderUsage;
}

const stringValue = (
  input: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const normalizeTool = (value: string | undefined): string =>
  value?.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase() ?? "";

const activityForTool = (
  toolName: string | undefined,
): AgentProgressActivity | undefined => {
  const tool = normalizeTool(toolName);
  if (!tool) return undefined;
  if (["taskcreate", "taskupdate", "todowrite", "updateplan"].includes(tool))
    return "planning";
  if (["read", "glob", "grep", "search", "ls"].includes(tool))
    return "exploring";
  if (["websearch", "webfetch"].includes(tool)) return "researching";
  if (["edit", "write", "multiedit", "applypatch"].includes(tool))
    return "editing";
  if (["bash", "shell", "terminal"].includes(tool)) return "executing";
  if (["task", "agent", "subagent"].includes(tool)) return "delegating";
  if (["askuserquestion", "requestuserinput"].includes(tool)) return "waiting";
  return "working";
};

export const sanitizeClaudeHook = (
  value: unknown,
): SanitizedClaudeHook | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const input = value as Record<string, unknown>;
  const event = stringValue(input, "hook_event_name");
  const sessionId = stringValue(input, "session_id");
  const cwd = stringValue(input, "cwd");
  if (!event || !EVENTS.has(event) || !sessionId || !cwd) return undefined;
  const toolName = stringValue(input, "tool_name");
  const notificationType = stringValue(input, "notification_type");
  const question =
    (event === "PreToolUse" &&
      ["askuserquestion", "requestuserinput"].includes(
        normalizeTool(toolName),
      )) ||
    (event === "Notification" && notificationType === "agent_needs_input");
  return {
    protocol_version: 1,
    session_id: sessionId,
    hook_event_name: event,
    cwd,
    ...(stringValue(input, "prompt_id")
      ? { prompt_id: stringValue(input, "prompt_id") }
      : {}),
    ...(stringValue(input, "tool_use_id")
      ? { tool_use_id: stringValue(input, "tool_use_id") }
      : {}),
    ...(stringValue(input, "agent_id")
      ? { agent_id: stringValue(input, "agent_id") }
      : {}),
    ...(stringValue(input, "agent_type")
      ? { agent_type: stringValue(input, "agent_type") }
      : {}),
    ...(stringValue(input, "permission_mode")
      ? { permission_mode: stringValue(input, "permission_mode") }
      : {}),
    ...(notificationType ? { notification_type: notificationType } : {}),
    ...(stringValue(input, "task_id")
      ? { task_id: stringValue(input, "task_id") }
      : {}),
    ...(stringValue(input, "status")
      ? { status: stringValue(input, "status") }
      : {}),
    ...(stringValue(input, "reason")
      ? { reason: stringValue(input, "reason") }
      : {}),
    ...(activityForTool(toolName)
      ? { agent_activity: activityForTool(toolName) }
      : {}),
    ...(question ? { agent_signal: "question_started" as const } : {}),
  };
};

const finitePercent = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(100, Math.max(0, value))
    : undefined;

const resetTime = (value: unknown): string | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return new Date(value < 10_000_000_000 ? value * 1_000 : value).toISOString();
};

export const sanitizeClaudeStatus = (
  value: unknown,
  observedAt = new Date().toISOString(),
): SanitizedClaudeStatus | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const input = value as Record<string, unknown>;
  const sessionId = stringValue(input, "session_id");
  if (!sessionId) return undefined;
  const workspace =
    input.workspace &&
    typeof input.workspace === "object" &&
    !Array.isArray(input.workspace)
      ? (input.workspace as Record<string, unknown>)
      : {};
  const roots = [
    stringValue(workspace, "project_dir") ?? stringValue(input, "cwd"),
    ...(Array.isArray(workspace.added_dirs)
      ? workspace.added_dirs.filter(
          (root): root is string => typeof root === "string" && !!root,
        )
      : []),
  ].filter((root): root is string => !!root);
  const limits =
    input.rate_limits &&
    typeof input.rate_limits === "object" &&
    !Array.isArray(input.rate_limits)
      ? (input.rate_limits as Record<string, unknown>)
      : {};
  const windowFor = (key: string, id: string, label: string) => {
    const source =
      limits[key] && typeof limits[key] === "object"
        ? (limits[key] as Record<string, unknown>)
        : {};
    const usedPercent = finitePercent(source.used_percentage);
    const resetsAt = resetTime(source.resets_at);
    return {
      id,
      label,
      usedPercent: usedPercent ?? 0,
      available: usedPercent !== undefined,
      ...(resetsAt ? { resetsAt } : {}),
    };
  };
  const windows = [
    windowFor("five_hour", "five-hour", "5h"),
    windowFor("seven_day", "weekly", "Week"),
  ];
  return {
    protocol_version: 1,
    session_id: sessionId,
    ...(stringValue(input, "session_name")
      ? { session_name: stringValue(input, "session_name") }
      : {}),
    workspace_roots: [...new Set(roots)],
    usage: {
      providerId: "claude-code",
      status: windows.some((window) => window.available)
        ? "available"
        : "unavailable",
      windows,
      observedAt,
      ...(!windows.some((window) => window.available)
        ? { message: "Claude usage limits are not available for this account" }
        : {}),
    },
  };
};
