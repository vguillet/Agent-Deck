const EVENTS = new Set([
  "sessionStart",
  "beforeSubmitPrompt",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "stop",
  "sessionEnd",
]);

export interface SanitizedCursorHook {
  hook_event_name: string;
  conversation_id: string;
  generation_id?: string;
  tool_use_id?: string;
  workspace_roots: string[];
  status?: string;
  final_status?: string;
  reason?: string;
  composer_mode?: string;
  cursor_version?: string;
}

const stringValue = (
  input: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = input[key];
  return typeof value === "string" && value.length ? value : undefined;
};

export const sanitizeCursorHook = (
  value: unknown,
): SanitizedCursorHook | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const input = value as Record<string, unknown>;
  const event = stringValue(input, "hook_event_name");
  const conversation = stringValue(input, "conversation_id");
  if (!event || !EVENTS.has(event) || !conversation) return undefined;
  const workspaceRoots = Array.isArray(input.workspace_roots)
    ? input.workspace_roots.filter(
        (root): root is string => typeof root === "string" && root.length > 0,
      )
    : [];
  const generationId = stringValue(input, "generation_id");
  const toolUseId =
    stringValue(input, "tool_use_id") ?? stringValue(input, "tool_call_id");
  const status = stringValue(input, "status");
  const finalStatus = stringValue(input, "final_status");
  const reason = stringValue(input, "reason");
  const composerMode = stringValue(input, "composer_mode");
  const cursorVersion = stringValue(input, "cursor_version");
  return {
    hook_event_name: event,
    conversation_id: conversation,
    workspace_roots: workspaceRoots,
    ...(generationId ? { generation_id: generationId } : {}),
    ...(toolUseId ? { tool_use_id: toolUseId } : {}),
    ...(status ? { status } : {}),
    ...(finalStatus ? { final_status: finalStatus } : {}),
    ...(reason ? { reason } : {}),
    ...(composerMode ? { composer_mode: composerMode } : {}),
    ...(cursorVersion ? { cursor_version: cursorVersion } : {}),
  };
};
