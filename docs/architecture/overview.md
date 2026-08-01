# Architecture

Agent Deck has three hard dependency boundaries:

```text
provider adapters -> provider SDK -> domain/core <- API contracts <- clients
                                     |
                                  SQLite
```

The core dynamically imports provider modules named in
`agent-deck.config.json`. It never imports Cursor, Codex, Stream Deck, or a
client implementation. Provider plugins return canonical resources using either
authoritative or incremental reconciliation; the SQLite reducer owns revisions,
event sequences, deduplication, attention, leases, and visible membership.

The core is a live projection, not an agent-history service. Every startup
begins with an empty catalog. Active agents are `running`,
`waiting_for_input`, or `waiting_for_approval`. Agents observed transitioning
to `ready_for_review`, `failed`, or `cancelled` remain visible until dismissed.
Each agent carries a provider-generated `activityEpoch`; dismissal suppresses
only that epoch, and a genuinely new run or generation restores visibility.

Successful authoritative snapshots remove absent active agents and runs.
Failed discovery does not mutate membership. Incremental providers renew an
observation lease; an expired lease removes an active agent. Canonical
`agent.removed` and `run.removed` events keep clients synchronized. The event
log is retained only as a bounded transport replay buffer.

Providers may attach semantic `focus` or `view` links to agents. The core
persists these links and coordinates every focus request through one serialized
machine-wide queue. Local Cursor and Codex targets use the exact-window broker;
validated generic `cursor:` links use the core's macOS launcher. Focus remains
navigation rather than an agent command or state mutation.

Cancellation is a separate provider command. The core validates the target and
optional expected revision, then dispatches `cancel` only to the provider that
owns the agent. Codex interrupts the active turn, and local Cursor sends the
conversation ID to the companion extension's cancel command.

## Local Cursor boundary

Normal Cursor IDE and interactive Agent CLI sessions do not expose a supported
catalog or attach API. The `cursor-local` provider therefore receives
best-effort user hook events through loopback ingress. A fail-open reporter
allowlists only conversation/generation IDs, workspace roots, lifecycle status,
and non-sensitive mode/version metadata before transmission.

The provider checkpoints only sanitized classification and deduplication data;
it never restores agents or runs. It does not backfill from transcripts, logs,
Cursor SQLite databases, or processes. A conversation created before hook
installation appears after its next observed event. Each accepted lifecycle
hook renews a five-minute lease; expiry removes the agent because continued
execution can no longer be confirmed.

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
