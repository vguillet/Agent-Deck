const EVENTS = new Set([
  "sessionStart",
  "beforeSubmitPrompt",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "subagentStart",
  "stop",
  "sessionEnd",
]);

export interface SanitizedCursorHook {
  protocol_version: 2;
  hook_event_name: string;
  conversation_id?: string;
  subagent_id?: string;
  parent_conversation_id?: string;
  conversation_kind?: "top_level" | "background";
  generation_id?: string;
  tool_use_id?: string;
  tool_name?: string;
  agent_signal?: "question_started";
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
  const conversation =
    stringValue(input, "conversation_id") ?? stringValue(input, "session_id");
  const subagentId = stringValue(input, "subagent_id");
  const parentConversationId = stringValue(input, "parent_conversation_id");
  const isBackgroundAgent =
    typeof input.is_background_agent === "boolean"
      ? input.is_background_agent
      : undefined;
  const transcriptPath = stringValue(input, "transcript_path");
  const isSubagent = transcriptPath
    ?.replaceAll("\\", "/")
    .split("/")
    .includes("subagents");
  if (
    !event ||
    !EVENTS.has(event) ||
    (event === "subagentStart" ? !subagentId : !conversation)
  )
    return undefined;
  if (isSubagent && event !== "subagentStart") return undefined;
  const workspaceRoots = Array.isArray(input.workspace_roots)
    ? input.workspace_roots.filter(
        (root): root is string => typeof root === "string" && root.length > 0,
      )
    : [];
  const generationId = stringValue(input, "generation_id");
  const toolUseId =
    stringValue(input, "tool_use_id") ?? stringValue(input, "tool_call_id");
  const toolName = stringValue(input, "tool_name");
  const toolInput =
    input.tool_input &&
    typeof input.tool_input === "object" &&
    !Array.isArray(input.tool_input)
      ? (input.tool_input as Record<string, unknown>)
      : undefined;
  const command =
    typeof toolInput?.command === "string" ? toolInput.command : undefined;
  const agentSignal = command?.includes("agent-deck:question-start")
    ? "question_started"
    : undefined;
  const status = stringValue(input, "status");
  const finalStatus = stringValue(input, "final_status");
  const reason = stringValue(input, "reason");
  const composerMode = stringValue(input, "composer_mode");
  const cursorVersion = stringValue(input, "cursor_version");
  let conversationKind: "top_level" | "background" | undefined;
  if (isBackgroundAgent === true) conversationKind = "background";
  else if (isBackgroundAgent === false || event === "beforeSubmitPrompt")
    conversationKind = "top_level";
  return {
    protocol_version: 2,
    hook_event_name: event,
    workspace_roots: workspaceRoots,
    ...(conversation ? { conversation_id: conversation } : {}),
    ...(subagentId ? { subagent_id: subagentId } : {}),
    ...(parentConversationId
      ? { parent_conversation_id: parentConversationId }
      : {}),
    ...(conversationKind ? { conversation_kind: conversationKind } : {}),
    ...(generationId ? { generation_id: generationId } : {}),
    ...(toolUseId ? { tool_use_id: toolUseId } : {}),
    ...(toolName ? { tool_name: toolName } : {}),
    ...(agentSignal ? { agent_signal: agentSignal } : {}),
    ...(status ? { status } : {}),
    ...(finalStatus ? { final_status: finalStatus } : {}),
    ...(reason ? { reason } : {}),
    ...(composerMode ? { composer_mode: composerMode } : {}),
    ...(cursorVersion ? { cursor_version: cursorVersion } : {}),
  };
};
