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

The core stores current snapshots and a 30-day canonical state-event history.
Provider outages change provider health and data freshness, not the last known
agent lifecycle state.

Providers may attach semantic `focus` or `view` links to agents. The core
persists and serves these links without launching applications or interpreting
provider-specific URL schemes. A local client decides whether and how to open a
link, so focusing an app does not become an agent command or state mutation.

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

The provider checkpoints this sanitized registry so a core restart preserves
known sessions. It does not backfill from transcripts, logs, Cursor SQLite
databases, or processes; a conversation created before hook installation
appears after its next observed event. Five-minute staleness means hook
telemetry stopped, not that the Cursor process is known to have exited.

Exact local IDE focusing is provided by the separately installed Agent Deck
Focus extension for Cursor. It receives a conversation ID over Cursor's URI
handler and invokes Cursor's local open or cancel command. It does not apply to
interactive Agent CLI terminal sessions.

## Privacy boundary

The developer preview accepts only semantic state. Provider adapters must
discard prompt text, model output, command text, tool arguments and results,
transcript paths, diffs, and artifacts before emitting a snapshot or event.
The core has no schema fields for those values.

## Deployment boundary

The unauthenticated preview refuses non-loopback binding. Remote and team
deployments require an authentication and authorization milestone and are not
safe with this build.
