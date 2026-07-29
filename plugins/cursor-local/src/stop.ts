import { spawn } from "node:child_process";

export type CursorStopLauncher = (href: string) => Promise<void>;

export const openCursorStopLink: CursorStopLauncher = async (href) => {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("/usr/bin/open", [href], { stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`macOS open exited with status ${String(code)}`));
    });
  });
};

export const stopCursorConversation = (
  conversationId: string,
  launch: CursorStopLauncher = openCursorStopLink,
): Promise<void> =>
  launch(
    `cursor://agent-deck.focus/stop?conversationId=${encodeURIComponent(conversationId)}`,
  );
