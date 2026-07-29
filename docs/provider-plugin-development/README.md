# Provider plugin development

A provider package exports `createProviderPlugin()` and depends on
`@agent-deck/provider-sdk`. Its manifest ID must match the configured ID and
`sdkVersion` must be `1`.

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

Hook-driven providers should also sanitize in the reporter before crossing the
loopback boundary, fail open when the core is unavailable, persist enough
sanitized state to survive restarts, and reject late events that would regress
a newer run. Stable native conversation and generation IDs should be preferred
over process IDs or timestamps. A missing hook event is not proof that a
process ended, so freshness must be described as an observation lease.
Restored checkpoint records must remain stale until current telemetry confirms
them. Provider catalogs retain active and waiting agents, but prune non-active
agents and completed runs after 24 hours so discovery does not become an
unbounded historical archive.

The local Cursor provider is intentionally separate from Cursor Cloud. Local
Cursor uses user hooks and needs no API key, has no historical backfill, and
cannot reliably infer approval or input-waiting states. Cursor Cloud uses the
Cursor SDK catalog and stream APIs.

The `execute` method handles provider commands declared in
`manifest.capabilities.commands`. The preview server currently exposes only
`cancel`. Plugins must target the canonical agent ID, return `unsupported` for
unknown actions, and emit sanitized agent/run state events after a successful
cancellation.
