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
  tool_name?: string;
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
  const normalized = toolName?.replaceAll(/[-_]/g, "").toLowerCase();
  return normalized === "requestuserinput" || normalized === "askquestion";
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
    ...(toolName ? { tool_name: toolName } : {}),
    ...(permissionMode ? { permission_mode: permissionMode } : {}),
    ...(status ? { status } : {}),
    ...(finalStatus ? { final_status: finalStatus } : {}),
    ...(reason ? { reason } : {}),
    ...(agentSignal ? { agent_signal: agentSignal } : {}),
  };
};
