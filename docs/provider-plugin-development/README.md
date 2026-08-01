# Provider plugin development

A provider package exports `createProviderPlugin()` and depends on
`@agent-deck/provider-sdk`. Its manifest ID must match the configured ID and
`sdkVersion` must be `2`.

Plugins are responsible for:

- validating their own configuration;
- translating native resources and status into canonical snapshots/events;
- generating stable canonical IDs;
- reconnecting or reconciling provider streams;
- stripping all non-state telemetry before emission;
- reporting health without replacing last known agent state;
- stopping subscriptions and subprocesses during `dispose`.

`ProviderContext.registerIngress` mounts a provider-owned loopback route below
`/internal/providers/<providerId>`. Ingress handlers must validate and sanitize
native payloads before emitting canonical events.

Hook-driven providers should sanitize in the reporter before crossing the
loopback boundary, fail open when the core is unavailable, and reject late
events that would regress a newer run. Stable native conversation and
generation IDs become `activityEpoch` values and are preferred over process IDs
or timestamps. Lifecycle agents and runs must not be restored from checkpoints.
Incremental snapshots renew an observation lease; the core removes active
agents after five minutes without accepted telemetry.

Catalog providers return `reconciliation: "authoritative"` and report only
currently active agents. Successful omission removes an active agent; failed
discovery leaves the projection unchanged. Hook-only providers use
`reconciliation: "incremental"`. Providers may emit a terminal state only for
an epoch Agent Deck previously observed active. Terminal agents remain visible
until dismissed. Removal is represented by `agent.removed` and `run.removed`
events.

The local Cursor provider uses user hooks and needs no API key, has no
historical backfill, and cannot reliably infer approval or input-waiting
states.

Claude Code is a hook-driven incremental provider shared by standalone CLI
sessions and the official Anthropic extension in Cursor. Its reporter strips
prompts, messages, tool inputs and outputs, and transcript paths before sending
metadata over loopback. A status-line wrapper preserves existing output while
forwarding only workspace identity, session naming, and Claude's documented
5-hour and weekly rate-limit fields. Exact focus and creation use the official
Claude Code extension URI in a uniquely matched Cursor workspace.

The `execute` method handles provider commands declared in
`manifest.capabilities.commands`. The preview server currently exposes only
`cancel`. Plugins must target the canonical agent ID, return `unsupported` for
unknown actions, and emit sanitized agent/run state events after a successful
cancellation.
Interactive Claude Code sessions have no supported external interruption API,
so that provider declares no commands and must return `unsupported` instead of
signalling or terminating a process.
