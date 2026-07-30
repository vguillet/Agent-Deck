# Agent Deck Focus for Cursor

This private companion extension registers each live Cursor window with the
local Agent Deck server and advertises support for Cursor conversations and
Codex threads. It opens acknowledged requests only in the selected, active
window. `cursor://agent-deck.focus/open` remains available as a compatibility
entry point. The extension does not read or transmit conversation content.

Codex thread focus requires the OpenAI Codex extension (`openai.chatgpt`) in
Cursor. Agent Deck invokes its documented
[`chatgpt.openSidebar` command](https://learn.chatgpt.com/docs/developer-commands#extension-commands),
then uses an isolated Cursor URI adapter to select `/local/<thread-id>`. If the
extension, command, workspace match, or exact URI dispatch is unavailable,
focus fails visibly. The standalone Codex app is never used as a fallback.

Version 0.4.0 is required for serialized focus cancellation and recovery.
Version 0.3.0 supports Codex thread targets, and a 0.2.0 companion continues
to receive legacy Cursor-conversation intents, but the server returns an
explicit upgrade-required failure for Codex targets.

Install and manage it with:

```sh
agent-deck cursor-focus install
agent-deck cursor-focus status
agent-deck cursor-focus uninstall
```
