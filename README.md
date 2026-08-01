# Agent Deck

Agent Deck is a headless, local agent observability service. Provider plugins
translate Claude Code, Codex, local Cursor, and Cursor Cloud state into one canonical
registry; CLI and Stream Deck clients render that state without
provider-specific logic.

This developer preview is metadata-only and binds only to `127.0.0.1`. Its
only control operation is an explicit request to stop an agent. It does not
store prompts, messages, tool arguments, command output, diffs, or artifacts.
For Codex and local Cursor, it can display an allowlisted coarse activity and
numeric plan completion. Plan counts appear only when a recognized plan/Todo
tool supplies structured statuses; step text is discarded before ingestion.

## Requirements

- macOS 13 or newer
- Node.js 24 or newer
- Claude Code CLI or the Anthropic Claude Code extension in Cursor
- Codex CLI for the Codex provider
- Cursor IDE or Agent CLI for the local Cursor provider
- OpenAI Codex extension (`openai.chatgpt`) in Cursor for Codex thread focus
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

Then open `/hooks` inside Codex, review the seven Agent Deck hook definitions,
and trust them. The installation command preserves existing hooks, repairs
partial installations, and creates a backup before changing
`~/.codex/hooks.json`. Codex plan mode uses the same plan badge as Cursor;
native `request_user_input` calls appear as waiting-for-input, and approval
prompts remain visually distinct.

Enable metadata-only observation for Claude Code CLI sessions and the official
Claude Code extension in Cursor:

```sh
node apps/cli/dist/index.js claude-hooks install
```

The command merges fail-open handlers into `~/.claude/settings.json`,
preserves existing hooks, and wraps an existing status-line command without
changing its output. Restart active Claude Code sessions after installation.
Agent Deck receives only lifecycle identifiers, workspace identity, coarse
activity, numeric task counts, and official 5-hour/weekly usage percentages.
Prompts, messages, tool inputs and outputs, and transcript contents remain
local. Interactive Claude Code does not expose a supported external interrupt
API, so this provider does not advertise cancellation.

Enable metadata-only observation for normal local Cursor IDE and interactive
Agent CLI sessions:

```sh
node apps/cli/dist/index.js cursor-hooks install
```

The command merges eight fail-open handlers into `~/.cursor/hooks.json`,
preserves unrelated hooks, and creates a backup. Existing conversations appear
after their next lifecycle or tool event; Agent Deck does not scan Cursor
transcripts, logs, or internal databases. Local hooks expose running,
ready-for-review, failed, cancelled, and native question-waiting states. No
Cursor API key is needed for this provider.
The fail-open `sessionStart` hook also adds a privacy-safe reporting instruction:
before todo updates, the agent sends only completed and total counts through a
no-op shell sentinel. Step text remains local to Cursor.

Install the companion extension that lets Stream Deck keys open exact local
Cursor IDE conversations, Codex threads, and Claude Code sessions:

```sh
node apps/cli/dist/index.js cursor-focus install
```

Reload open Cursor windows after installing or upgrading the extension.
The extension receives only the native conversation or thread ID and workspace
identity. Agent Deck selects one exact Cursor window: local Cursor
conversations require equal normalized root sets, while Codex chooses the
unique longest workspace root containing the thread `cwd`. Missing or duplicate
matches fail safely. Codex focus requires the OpenAI Codex extension in Cursor;
Claude focus and creation require the Anthropic Claude Code extension. There is
no focus fallback to a standalone app. Cursor Agent CLI terminal
sessions remain observable but are not focus targets.

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
every agent or a selected provider such as Claude Code, Codex/OpenAI, or Cursor. Provider
accents distinguish agent types while the key's main colour reflects lifecycle
state. Each Agent Slot can keep that Classic look or opt into animated Agent
characters rendered as flat white silhouettes, with stable variants for idle,
working, input, approval, review, failed, cancelled, and unknown states.
The configurable New Agent action opens a blank Cursor Agent, Codex, or Claude Code chat in
the uniquely focused, connected Cursor workspace. Cursor creation requires a
version that exposes `composer.newAgentChat`; Codex creation requires the
OpenAI extension command `chatgpt.newChat`; Claude Code uses Anthropic's
documented extension URI. Missing, unsupported, or ambiguous
focused windows fail safely and alert on the key. A blank chat appears in Agent
Deck only after its first prompt produces a lifecycle hook event.
Each Provider Usage key is fixed to the provider selected in its property
inspector. Pressing it temporarily shows the soonest reset date and days
remaining, then returns to the two-bar usage view after three seconds.
Codex and Claude Code show rolling 5-hour and weekly limits; Cursor shows the monthly Cursor
Models and API Models pools. The key refreshes automatically every two minutes,
uses green/yellow/orange/red thresholds, shows reset countdowns, and retains the
last successful values with a stale marker after a transient failure. Codex
usage comes from the local Codex app-server login. Cursor reads the signed-in
token from Cursor's local state database in read-only mode and sends it only to
Cursor's HTTPS dashboard endpoint; the token is never persisted or logged by
Agent Deck. Cursor does not publish this personal usage endpoint, so future
Cursor changes may temporarily make that view unavailable. Claude Code usage
comes from its official status-line payload and appears for Claude.ai Pro/Max
subscribers after the first API response in a session.
Working variants use energetic tool and writing loops; review variants jump and
present their finished work. Empty character-mode slots use the same restful
idle scenes. A single press latches the agent currently rendered on key-down,
then opens that exact Claude Code session or Codex thread in Cursor, local Cursor conversation, or
Cursor Cloud conversation. Focus switches are serialized machine-wide, and
rapid presses retain only the newest queued target. A long press deletes the
Agent Deck record and its history, suppressing provider
rediscovery until that external agent reports newer activity. Encoder rotation
changes pages; keypad presses do not page. Long-pressing System Health clears
all agent records and the device's in-memory snapshot, then immediately
rediscovers active agents.

## Commands

```text
agent-deck server
agent-deck agents [--watch] [--json]
agent-deck agent <id>
agent-deck events --agent <id> [--watch]
agent-deck attention [--watch]
agent-deck providers
agent-deck health
agent-deck claude-hooks install|status|uninstall
agent-deck codex-hooks install|status|uninstall
agent-deck cursor-hooks install|status|uninstall
agent-deck cursor-focus install|status|uninstall
```

See [Architecture](docs/architecture/overview.md),
[Protocol](docs/protocol/v1.md), [Provider development](docs/provider-plugin-development/README.md),
and [Client development](docs/client-development/README.md).
