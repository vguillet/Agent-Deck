import type { AgentProgressActivity } from "@agent-deck/domain";

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
  conversation_kind?: "top_level" | "subagent" | "background";
  generation_id?: string;
  tool_use_id?: string;
  agent_activity?: AgentProgressActivity;
  plan_progress?: {
    completed: number;
    total: number;
  };
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
): SanitizedCursorHook["plan_progress"] => {
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
): SanitizedCursorHook["plan_progress"] => {
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
): SanitizedCursorHook["plan_progress"] => {
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

export const cursorHookResponse = (
  hook: SanitizedCursorHook | undefined,
): Record<string, unknown> =>
  hook?.hook_event_name === "sessionStart"
    ? {
        additional_context:
          "Immediately before every TodoWrite or todo-list update, run `true # agent-deck:progress <completed> <total>` as a separate Shell command, replacing the placeholders with the number of completed items and total items. Then perform the todo update normally. Report numbers only; never include step text.",
      }
    : {};

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
  const agentSignal = command?.includes("agent-deck:question-start")
    ? "question_started"
    : undefined;
  const status = stringValue(input, "status");
  const finalStatus = stringValue(input, "final_status");
  const reason = stringValue(input, "reason");
  const composerMode = stringValue(input, "composer_mode");
  const cursorVersion = stringValue(input, "cursor_version");
  let conversationKind: "top_level" | "subagent" | "background" | undefined;
  if (isSubagent) conversationKind = "subagent";
  else if (isBackgroundAgent === true) conversationKind = "background";
  else if (isBackgroundAgent === false) conversationKind = "top_level";
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
    ...(agentActivity ? { agent_activity: agentActivity } : {}),
    ...(sanitizedPlanProgress ? { plan_progress: sanitizedPlanProgress } : {}),
    ...(agentSignal ? { agent_signal: agentSignal } : {}),
    ...(status ? { status } : {}),
    ...(finalStatus ? { final_status: finalStatus } : {}),
    ...(reason ? { reason } : {}),
    ...(composerMode ? { composer_mode: composerMode } : {}),
    ...(cursorVersion ? { cursor_version: cursorVersion } : {}),
  };
};
