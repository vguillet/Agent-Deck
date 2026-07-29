import type { AgentProgressActivity } from "@agent-deck/domain";

const EVENTS = new Set([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "Stop",
  "SessionEnd",
]);

export interface SanitizedCodexHook {
  protocol_version: 1;
  session_id: string;
  hook_event_name: string;
  cwd: string;
  turn_id?: string;
  tool_use_id?: string;
  agent_activity?: AgentProgressActivity;
  plan_progress?: {
    completed: number;
    total: number;
  };
  permission_mode?: string;
  status?: string;
  final_status?: string;
  reason?: string;
  agent_signal?: "question_started";
}

const stringValue = (
  input: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = input[key];
  return typeof value === "string" && value.length ? value : undefined;
};

const isQuestionTool = (toolName: string | undefined): boolean => {
  const normalized = normalizeToolName(toolName);
  return normalized === "requestuserinput" || normalized === "askquestion";
};

const normalizeToolName = (toolName: string | undefined): string | undefined =>
  toolName?.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase();

const activityForTool = (
  toolName: string | undefined,
): AgentProgressActivity | undefined => {
  const normalized = normalizeToolName(toolName);
  if (!normalized) return undefined;
  if (
    normalized === "todowrite" ||
    normalized === "updateplan" ||
    normalized === "plan"
  )
    return "planning";
  if (
    [
      "read",
      "readfile",
      "glob",
      "grep",
      "rg",
      "search",
      "codebasesearch",
    ].includes(normalized)
  )
    return "exploring";
  if (normalized === "websearch" || normalized === "webfetch")
    return "researching";
  if (["edit", "write", "applypatch", "editnotebook"].includes(normalized))
    return "editing";
  if (
    ["shell", "bash", "terminal", "runcommand", "execcommand"].includes(
      normalized,
    )
  )
    return "executing";
  if (["task", "subagent", "subagentstart"].includes(normalized))
    return "delegating";
  if (normalized === "requestuserinput" || normalized === "askquestion")
    return "waiting";
  return "working";
};

const planProgress = (
  toolName: string | undefined,
  toolInput: Record<string, unknown> | undefined,
): SanitizedCodexHook["plan_progress"] => {
  const normalized = normalizeToolName(toolName);
  if (
    normalized !== "todowrite" &&
    normalized !== "updateplan" &&
    normalized !== "plan"
  )
    return undefined;
  const items = Array.isArray(toolInput?.todos)
    ? toolInput.todos
    : Array.isArray(toolInput?.plan)
      ? toolInput.plan
      : undefined;
  if (!items || items.length > 1_000) return undefined;
  const statuses = items.map((item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? (item as Record<string, unknown>).status
      : undefined,
  );
  if (
    statuses.some(
      (status) =>
        typeof status !== "string" ||
        !["pending", "in_progress", "completed"].includes(status.toLowerCase()),
    )
  )
    return undefined;
  return {
    completed: statuses.filter(
      (status) => String(status).toLowerCase() === "completed",
    ).length,
    total: statuses.length,
  };
};

const planProgressFromCommand = (
  command: string | undefined,
): SanitizedCodexHook["plan_progress"] => {
  const match = command?.match(
    /(?:^|\s)agent-deck:progress\s+(\d+)\s+(\d+)(?:\s|$)/,
  );
  if (!match) return undefined;
  const completed = Number(match[1]);
  const total = Number(match[2]);
  if (
    !Number.isSafeInteger(completed) ||
    !Number.isSafeInteger(total) ||
    completed < 0 ||
    completed > total ||
    total > 1_000
  )
    return undefined;
  return { completed, total };
};

const planProgressFromValue = (
  value: unknown,
  depth = 0,
): SanitizedCodexHook["plan_progress"] => {
  if (depth > 4) return undefined;
  if (typeof value === "string") return planProgressFromCommand(value);
  if (!value || typeof value !== "object") return undefined;
  const values = Array.isArray(value)
    ? value.slice(0, 100)
    : Object.values(value as Record<string, unknown>);
  for (const nested of values) {
    const progress = planProgressFromValue(nested, depth + 1);
    if (progress) return progress;
  }
  return undefined;
};

export const sanitizeCodexHook = (
  value: unknown,
): SanitizedCodexHook | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const input = value as Record<string, unknown>;
  const event = stringValue(input, "hook_event_name");
  const sessionId = stringValue(input, "session_id");
  const cwd = stringValue(input, "cwd");
  if (!event || !EVENTS.has(event) || !sessionId || !cwd) return undefined;

  const turnId = stringValue(input, "turn_id");
  const toolUseId = stringValue(input, "tool_use_id");
  const toolName = stringValue(input, "tool_name");
  const toolInput =
    input.tool_input &&
    typeof input.tool_input === "object" &&
    !Array.isArray(input.tool_input)
      ? (input.tool_input as Record<string, unknown>)
      : undefined;
  const command =
    typeof toolInput?.command === "string" ? toolInput.command : undefined;
  const commandPlanProgress =
    planProgressFromCommand(command) ??
    (normalizeToolName(toolName)?.includes("shell")
      ? planProgressFromValue(input)
      : undefined);
  const agentActivity = commandPlanProgress
    ? "planning"
    : activityForTool(toolName);
  const sanitizedPlanProgress =
    commandPlanProgress ?? planProgress(toolName, toolInput);
  const permissionMode = stringValue(input, "permission_mode");
  const status = stringValue(input, "status");
  const finalStatus = stringValue(input, "final_status");
  const reason = stringValue(input, "reason");
  const agentSignal =
    event === "PreToolUse" && isQuestionTool(toolName)
      ? "question_started"
      : undefined;

  return {
    protocol_version: 1,
    session_id: sessionId,
    hook_event_name: event,
    cwd,
    ...(turnId ? { turn_id: turnId } : {}),
    ...(toolUseId ? { tool_use_id: toolUseId } : {}),
    ...(agentActivity ? { agent_activity: agentActivity } : {}),
    ...(sanitizedPlanProgress ? { plan_progress: sanitizedPlanProgress } : {}),
    ...(permissionMode ? { permission_mode: permissionMode } : {}),
    ...(status ? { status } : {}),
    ...(finalStatus ? { final_status: finalStatus } : {}),
    ...(reason ? { reason } : {}),
    ...(agentSignal ? { agent_signal: agentSignal } : {}),
  };
};
