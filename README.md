# Agent Deck

Agent Deck is a headless, local agent observability service. Provider plugins
translate Codex, local Cursor, and Cursor Cloud state into one canonical
registry; CLI and Stream Deck clients render that state without
provider-specific logic.

This developer preview is metadata-only and binds only to `127.0.0.1`. Its
only control operation is an explicit request to stop an agent. It does not
store prompts, messages, tool arguments, command output, diffs, or artifacts.

## Requirements

- macOS 13 or newer
- Node.js 24 or newer
- Codex CLI for the Codex provider
- Cursor IDE or Agent CLI for the local Cursor provider
- A Cursor API key for the Cursor Cloud provider
- Stream Deck 7.1 or newer for the hardware client

## Quick start

```sh
npm install
npm run build
cp agent-deck.config.example.json agent-deck.config.json
export CURSOR_API_KEY="..."
npm run dev
```

In a second terminal:

```sh
node apps/cli/dist/index.js providers
node apps/cli/dist/index.js agents --watch
```

Enable live observation for independently launched Codex sessions:

```sh
node apps/cli/dist/index.js codex-hooks install
```

Then open `/hooks` inside Codex, review the five Agent Deck hook definitions,
and trust them. The installation command preserves existing hooks and creates a
backup before changing `~/.codex/hooks.json`.

Enable metadata-only observation for normal local Cursor IDE and interactive
Agent CLI sessions:

```sh
node apps/cli/dist/index.js cursor-hooks install
```

The command merges seven fail-open handlers into `~/.cursor/hooks.json`,
preserves unrelated hooks, and creates a backup. Existing conversations appear
after their next lifecycle or tool event; Agent Deck does not scan Cursor
transcripts, logs, or internal databases. Local hooks expose running,
ready-for-review, failed, and cancelled states, but do not provide authoritative
waiting-for-input or waiting-for-approval signals. No Cursor API key is needed
for this provider.

Install the companion extension that lets Stream Deck keys open the exact local
Cursor IDE conversation:

```sh
node apps/cli/dist/index.js cursor-focus install
```

The extension receives only the native conversation ID. It checks that the
installed Cursor version exposes the required local conversation commands and
shows an in-app error instead of silently opening or stopping the wrong
conversation. Cursor Agent CLI terminal sessions remain observable but are not
focus targets.

For a credential-free demo:

```sh
npm run demo
```

## Stream Deck

Build and validate the plugin:

```sh
npm run build:assets --workspace @agent-deck/stream-deck
npm run package --workspace @agent-deck/stream-deck
```

The packaged development artifact is written under
`clients/stream-deck/release/`. Each physical device registers as a separate
client using its Stream Deck device ID. Agent Slot actions are numbered,
dynamic placeholders: the filtered agent list fills and clears them as agents
appear and disappear. Slots use their physical key position automatically, with
an optional explicit index for custom layouts. Agent Recap actions can summarize
every agent or a selected provider such as Codex/OpenAI or Cursor. Provider
accents distinguish agent types while the key's main colour reflects lifecycle
state. Each Agent Slot can keep that Classic look or opt into animated Agent
characters rendered as flat white silhouettes, with stable variants for idle,
working, input, approval, review, failed, cancelled, and unknown states.
Working variants use energetic tool and writing loops; review variants jump and
present their finished work. Empty character-mode slots use the same restful
idle scenes. Pressing an occupied Agent Slot opens that exact Codex, local
Cursor, or Cursor Cloud conversation. A double press stops its active run. A
long press deletes the Agent Deck record and its history, suppressing provider
rediscovery until that external agent reports newer activity. Encoder rotation
changes pages; keypad presses do not page.

## Commands

```text
agent-deck server
agent-deck agents [--watch] [--json]
agent-deck agent <id>
agent-deck events --agent <id> [--watch]
agent-deck attention [--watch]
agent-deck providers
agent-deck health
agent-deck codex-hooks install|status|uninstall
agent-deck cursor-hooks install|status|uninstall
agent-deck cursor-focus install|status|uninstall
```

See [Architecture](docs/architecture/overview.md),
[Protocol](docs/protocol/v1.md), [Provider development](docs/provider-plugin-development/README.md),
and [Client development](docs/client-development/README.md).
