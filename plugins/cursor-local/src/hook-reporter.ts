#!/usr/bin/env node
import { cursorHookResponse, sanitizeCursorHook } from "./hook-payload.js";
import { reportCursorHook } from "./hook-transport.js";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));

let input: unknown;
try {
  input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
} catch {
  process.stdout.write("{}\n");
  process.exit(0);
}

const sanitized = sanitizeCursorHook(input);
if (sanitized) {
  const endpoint =
    process.env.AGENT_DECK_CURSOR_HOOK_URL ??
    "http://127.0.0.1:47831/internal/providers/cursor-local/hooks";
  const reported = await reportCursorHook(endpoint, sanitized);
  // #region agent log
  fetch('http://127.0.0.1:7387/ingest/f84f2bef-f713-45ff-9929-62841539443f',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'810436'},body:JSON.stringify({sessionId:'810436',runId:'state-loss-pre-fix',hypothesisId:'S1,S4',location:'plugins/cursor-local/src/hook-reporter.ts:report',message:'Cursor hook sanitized and transport completed',data:{event:sanitized.hook_event_name,conversationSuffix:sanitized.conversation_id?.slice(-8),reported,hasGeneration:Boolean(sanitized.generation_id),hasToolUseId:Boolean(sanitized.tool_use_id),activity:sanitized.agent_activity,signal:sanitized.agent_signal,hasStatus:Boolean(sanitized.status),hasFinalStatus:Boolean(sanitized.final_status),hasReason:Boolean(sanitized.reason)},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  if (!reported)
    process.stderr.write(
      "Agent Deck could not record this Cursor hook; mode may be stale.\n",
    );
}

process.stdout.write(`${JSON.stringify(cursorHookResponse(sanitized))}\n`);
