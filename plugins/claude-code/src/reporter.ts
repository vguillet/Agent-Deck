#!/usr/bin/env node
import { sanitizeClaudeHook, sanitizeClaudeStatus } from "./payload.js";
import { decodeStatusLineCommand, executeStatusLine } from "./status-line.js";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const raw = Buffer.concat(chunks);

let input: unknown;
try {
  input = JSON.parse(raw.toString("utf8")) as unknown;
} catch {
  process.stdout.write("{}\n");
  process.exit(0);
}

const statusLineIndex = process.argv.indexOf("--status-line");
const statusLine = statusLineIndex >= 0;
const passthroughCommand = statusLine
  ? decodeStatusLineCommand(process.argv[statusLineIndex + 1])
  : undefined;
const payload = statusLine
  ? sanitizeClaudeStatus(input)
  : sanitizeClaudeHook(input);

if (payload) {
  const endpoint =
    process.env.AGENT_DECK_CLAUDE_HOOK_URL ??
    `http://127.0.0.1:47831/internal/providers/claude-code/${
      statusLine ? "status" : "hooks"
    }`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 400);
  try {
    await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch {
    // Observability must never block or steer Claude Code.
  } finally {
    clearTimeout(timeout);
  }
}

if (statusLine && passthroughCommand) {
  const output = await executeStatusLine(passthroughCommand, raw);
  process.stdout.write(output.stdout);
  process.stderr.write(output.stderr);
} else if (!statusLine) {
  process.stdout.write("{}\n");
}
