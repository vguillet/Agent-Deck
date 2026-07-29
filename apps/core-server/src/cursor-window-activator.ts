import { spawn } from "node:child_process";
import type { CursorWindowActivator } from "./cursor-window-broker.js";

export const activateCursorWindow: CursorWindowActivator = (target) =>
  new Promise<void>((resolvePromise, reject) => {
    const child = spawn("/usr/bin/open", ["-a", "Cursor", target], {
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else
        reject(
          new Error(`Cursor window activation exited with ${String(code)}`),
        );
    });
  });
