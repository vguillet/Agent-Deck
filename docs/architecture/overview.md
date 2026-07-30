# Architecture

Agent Deck has three hard dependency boundaries:

```text
provider adapters -> provider SDK -> domain/core <- API contracts <- clients
                                     |
                                  SQLite
```

The core dynamically imports provider modules named in
`agent-deck.config.json`. It never imports Cursor, Codex, Stream Deck, or a
client implementation. Provider plugins return complete canonical resources;
the SQLite reducer owns revisions, event sequences, deduplication, attention,
and freshness.

During a server run, the core stores current snapshots and canonical
state-event history. Graceful shutdown and every startup clear agent snapshots
and agent-scoped history while preserving deletion tombstones. Startup provider
discovery rebuilds the active view, suppresses agents still covered by a
tombstone, and removes tombstones that a complete provider snapshot proves are
no longer needed. Incomplete or failed discovery leaves tombstones intact.
Provider outages during a run change provider health and data freshness, not
the last known agent lifecycle state.

Provider catalogs retain running and waiting agents regardless of age.
Non-active agents and completed runs expire 24 hours after their last activity.
Codex rebuilds its registry from app-server discovery plus recent hook-only
sessions rather than retaining the full thread archive.

Providers may attach semantic `focus` or `view` links to agents. The core
persists these links and coordinates every focus request through one serialized
machine-wide queue. Local Cursor and Codex targets use the exact-window broker;
validated Cursor Cloud and generic `cursor:` links use the core's macOS
launcher. Focus remains navigation rather than an agent command or state
mutation.

Cancellation is a separate provider command. The core validates the target and
optional expected revision, then dispatches `cancel` only to the provider that
owns the agent. Codex interrupts the active turn, Cursor Cloud cancels the
active run, and local Cursor sends the conversation ID to the companion
extension's cancel command.

## Local Cursor boundary

Normal Cursor IDE and interactive Agent CLI sessions do not expose a supported
catalog or attach API. The `cursor-local` provider therefore receives
best-effort user hook events through loopback ingress. A fail-open reporter
allowlists only conversation/generation IDs, workspace roots, lifecycle status,
and non-sensitive mode/version metadata before transmission.

The provider checkpoints this sanitized registry for lifecycle continuity.
Restored conversations remain stale and hidden from Stream Deck until a new
hook confirms activity; old non-active records are removed after 24 hours. It
does not backfill from transcripts, logs, Cursor SQLite databases, or processes;
a conversation created before hook installation appears after its next
observed event. Five-minute staleness means hook telemetry stopped, not that the
Cursor process is known to have exited.

Exact local IDE focusing is provided by the separately installed Agent Deck
Focus extension for Cursor. Each connection has a stable window instance ID,
workspace roots, launch target, and supported focus target kinds. Cursor
conversations match only an equal normalized workspace-root set. Codex threads
match the unique window whose longest workspace root contains their normalized
working directory; tied or duplicate matches are rejected.

The core activates that exact Cursor launch target and sends a discriminated
focus intent. Cursor targets invoke Cursor's local Composer command. Codex
targets verify the `openai.chatgpt` extension, run its documented
`chatgpt.openSidebar` command, and dispatch an isolated exact-thread Cursor URI.
Failures are surfaced without a `codex:` or standalone Codex fallback.
Interactive Cursor Agent CLI terminal sessions are not focus targets.

## Privacy boundary

The developer preview accepts only semantic state. Provider adapters must
discard prompt text, model output, command text, tool arguments and results,
transcript paths, diffs, and artifacts before emitting a snapshot or event.
The core has no schema fields for those values.

## Deployment boundary

The unauthenticated preview refuses non-loopback binding. Remote and team
deployments require an authentication and authorization milestone and are not
safe with this build.
