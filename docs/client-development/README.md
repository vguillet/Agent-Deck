# Client development

Clients depend on `@agent-deck/client-sdk` and `@agent-deck/api-contract`, never
on a provider plugin or server implementation.

Each process or physical device supplies a stable `ClientDescriptor`. Several
clients may observe the same canonical registry concurrently; registration does
not grant ownership of agents.

Use REST for snapshots and WebSocket for changes. Rendering decisions such as
colors, icons, animation, pagination, truncation, and notification policy stay
inside the client.

Agent links are semantic. Clients use `AgentDeckClient.focusAgent` for
`rel: "focus"` navigation and must not treat it as a provider command. The
loopback core validates and serializes brokered local Cursor/Codex targets and
allowlisted `cursor:` links such as Cursor Cloud. `rel: "view"` remains a
secondary inspection surface and is never a focus fallback. No generic
`codex:` launcher is available.

Clients cancel an active run with `AgentDeckClient.cancelAgent`. Passing the
rendered agent revision protects against acting on a slot whose target changed.
Navigation and cancellation remain separate actions.

Client-specific configuration can be stored at
`/api/v1/clients/<clientId>/configuration`. The core treats the `schema` and
`data` fields as opaque and only enforces revision concurrency.
