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
  if (sanitized.plan_progress || sanitized.agent_activity === "planning") {
    // #region agent log
    fetch('http://127.0.0.1:7387/ingest/f84f2bef-f713-45ff-9929-62841539443f',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'d833c3'},body:JSON.stringify({sessionId:'d833c3',runId:'pre-fix',hypothesisId:'H2',location:'plugins/cursor-local/src/hook-reporter.ts:reportCursorHook',message:'Progress hook delivery result',data:{event:sanitized.hook_event_name,reported,hasConversation:Boolean(sanitized.conversation_id),hasGeneration:Boolean(sanitized.generation_id),planProgress:sanitized.plan_progress},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
  }
  if (!reported)
    process.stderr.write(
      "Agent Deck could not record this Cursor hook; mode may be stale.\n",
    );
}

process.stdout.write(`${JSON.stringify(cursorHookResponse(sanitized))}\n`);
