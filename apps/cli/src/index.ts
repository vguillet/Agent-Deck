#!/usr/bin/env node
import { hostname } from "node:os";
import { AgentDeckClient } from "@agent-deck/client-sdk";
import type {
  Agent,
  CanonicalEvent,
  ClientDescriptor,
} from "@agent-deck/domain";
import {
  codexHookStatus,
  installCodexHooks,
  uninstallCodexHooks,
} from "./codex-hooks.js";
import {
  cursorHookStatus,
  installCursorHooks,
  uninstallCursorHooks,
} from "./cursor-hooks.js";
import {
  cursorFocusStatus,
  installCursorFocus,
  uninstallCursorFocus,
} from "./cursor-focus.js";

const args = process.argv.slice(2);
const command = args[0] ?? "help";
const client = new AgentDeckClient();

const descriptor: ClientDescriptor = {
  id: `cli:${hostname()}:${process.pid}`,
  type: "cli",
  name: `Agent Deck CLI on ${hostname()}`,
  version: "0.1.0",
  capabilities: {
    notifications: false,
    images: false,
    animations: false,
    textInput: true,
    approvalActions: false,
  },
};

const flag = (name: string): boolean => args.includes(name);
const option = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const printAgents = (agents: Agent[]): void => {
  if (flag("--json")) {
    console.log(JSON.stringify(agents, null, 2));
    return;
  }
  console.table(
    agents.map((agent) => ({
      id: agent.id,
      state: agent.state,
      fresh: agent.freshness,
      attention: agent.requiresAttention ? "yes" : "",
      title: agent.title,
      updated: agent.lastActivityAt,
    })),
  );
};

const watch = (
  afterSequence: number,
  topics: Array<
    "agents.summary" | "attention" | "providers.health" | "system.health"
  >,
  onEvent: (event: CanonicalEvent) => void,
): Promise<never> =>
  new Promise(() => {
    const handle = client.watch(descriptor, {
      topics,
      afterSequence,
      onEvent,
      onResyncRequired: () =>
        console.error("Event history was pruned; refresh the snapshot"),
      onStatus: (status) => {
        if (status !== "connected") console.error(`[${status}]`);
      },
    });
    const stop = (): void => {
      handle.close();
      process.exit(0);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });

const main = async (): Promise<void> => {
  switch (command) {
    case "server": {
      const { startServer } = await import("@agent-deck/core-server");
      const server = await startServer();
      const close = (): void => {
        void server.close().then(() => process.exit(0));
      };
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
      return;
    }
    case "agents": {
      const page = await client.listAgents();
      printAgents(page.items);
      if (flag("--watch")) {
        await watch(page.asOfSequence, ["agents.summary"], (event) => {
          const agent = event.payload.agent as Agent | undefined;
          if (agent) printAgents([agent]);
        });
      }
      return;
    }
    case "agent": {
      const id = args[1];
      if (!id) throw new Error("Usage: agent-deck agent <id>");
      console.log(JSON.stringify(await client.getAgent(id), null, 2));
      return;
    }
    case "events": {
      const id = option("--agent");
      if (!id)
        throw new Error("Usage: agent-deck events --agent <id> [--watch]");
      const page = await client.listEvents(id);
      console.log(JSON.stringify(page.items, null, 2));
      if (flag("--watch")) {
        await watch(
          page.asOfSequence,
          ["agents.summary", "attention"],
          (event) => {
            if (event.agentId === id) console.log(JSON.stringify(event));
          },
        );
      }
      return;
    }
    case "attention": {
      const page = await client.listAttention();
      console.log(JSON.stringify(page.items, null, 2));
      if (flag("--watch"))
        await watch(
          page.asOfSequence,
          ["attention", "agents.summary"],
          (event) => console.log(JSON.stringify(event)),
        );
      return;
    }
    case "providers":
      console.log(
        JSON.stringify((await client.listProviders()).items, null, 2),
      );
      return;
    case "health":
      console.log(JSON.stringify(await client.health(), null, 2));
      return;
    case "codex-hooks": {
      const action = args[1] ?? "status";
      if (action === "install") console.log(await installCodexHooks());
      else if (action === "uninstall") console.log(await uninstallCodexHooks());
      else if (action === "status") console.log(await codexHookStatus());
      else
        throw new Error(
          "Usage: agent-deck codex-hooks install|status|uninstall",
        );
      return;
    }
    case "cursor-hooks": {
      const action = args[1] ?? "status";
      if (action === "install") console.log(await installCursorHooks());
      else if (action === "uninstall")
        console.log(await uninstallCursorHooks());
      else if (action === "status") console.log(await cursorHookStatus());
      else
        throw new Error(
          "Usage: agent-deck cursor-hooks install|status|uninstall",
        );
      return;
    }
    case "cursor-focus": {
      const action = args[1] ?? "status";
      if (action === "install") console.log(await installCursorFocus());
      else if (action === "uninstall")
        console.log(await uninstallCursorFocus());
      else if (action === "status") console.log(await cursorFocusStatus());
      else
        throw new Error(
          "Usage: agent-deck cursor-focus install|status|uninstall",
        );
      return;
    }
    case "help":
    case "--help":
    case "-h":
      console.log(`Agent Deck developer preview

Commands:
  agent-deck server
  agent-deck agents [--watch] [--json]
  agent-deck agent <id>
  agent-deck events --agent <id> [--watch]
  agent-deck attention [--watch]
  agent-deck providers
  agent-deck health
  agent-deck codex-hooks install|status|uninstall
  agent-deck cursor-hooks install|status|uninstall
  agent-deck cursor-focus install|status|uninstall`);
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
