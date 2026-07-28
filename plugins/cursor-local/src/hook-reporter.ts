#!/usr/bin/env node
import { sanitizeCursorHook } from "./hook-payload.js";

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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 400);
  try {
    await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sanitized),
      signal: controller.signal,
    });
  } catch {
    // Observability must never block or steer Cursor.
  } finally {
    clearTimeout(timeout);
  }
}

process.stdout.write("{}\n");
