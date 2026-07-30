import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import type { CursorLinkLauncher } from "./agent-focus-coordinator.js";
import type { CursorWindowActivator } from "./cursor-window-broker.js";

const open = (arguments_: string[]): Promise<void> =>
  new Promise<void>((resolvePromise, reject) => {
    const child = spawn("/usr/bin/open", arguments_, {
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`macOS open exited with ${String(code)}`));
    });
  });

export const activateCursorWindow: CursorWindowActivator = (target) =>
  open(["-a", "Cursor", target]);

export const openCursorFocusLink: CursorLinkLauncher = async (href) => {
  const url = new URL(href);
  if (url.protocol !== "cursor:")
    throw new Error(`Unsupported focus URL scheme: ${url.protocol}`);

  const isLocalConversation =
    url.hostname === "agent-deck.focus" && url.pathname === "/open";
  if (isLocalConversation) {
    const workspace = url.searchParams.get("workspace") ?? undefined;
    const windowTarget =
      url.searchParams.get("window") ?? workspace ?? undefined;
    if (workspace !== undefined && !isAbsolute(workspace))
      throw new Error("Cursor agent focus workspace must be an absolute path");
    if (windowTarget !== undefined && !isAbsolute(windowTarget))
      throw new Error("Cursor agent focus window must be an absolute path");
    if (windowTarget) await activateCursorWindow(windowTarget);
  }
  await open([url.href]);
};
