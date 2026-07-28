import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

export class CodexAppServerClient {
  private process: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private initialising: Promise<void> | undefined;

  constructor(private readonly binary: string) {}

  async listThreads(): Promise<unknown[]> {
    await this.ensureStarted();
    const output: unknown[] = [];
    let cursor: string | undefined;
    do {
      const result = (await this.request("thread/list", {
        limit: 100,
        ...(cursor ? { cursor } : {}),
      })) as { data?: unknown[]; nextCursor?: string | null };
      output.push(...(Array.isArray(result.data) ? result.data : []));
      cursor = result.nextCursor ?? undefined;
    } while (cursor);
    return output;
  }

  async version(): Promise<string> {
    await this.ensureStarted();
    return "available";
  }

  dispose(): void {
    this.process?.kill("SIGTERM");
    this.process = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Codex app-server stopped"));
    }
    this.pending.clear();
  }

  private async ensureStarted(): Promise<void> {
    if (this.process && !this.process.killed) return;
    if (this.initialising) return this.initialising;
    this.initialising = this.start();
    try {
      await this.initialising;
    } finally {
      this.initialising = undefined;
    }
  }

  private async start(): Promise<void> {
    const child = spawn(this.binary, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.receive(line));
    child.stderr.on("data", () => {
      // The provider logger owns user-facing diagnostics. App-server stderr can
      // include progress and must not be interpreted as protocol data.
    });
    child.once("exit", (code, signal) => {
      if (this.process === child) this.process = undefined;
      const error = new Error(
        `Codex app-server exited (${code ?? signal ?? "unknown"})`,
      );
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      this.pending.clear();
    });
    child.once("error", (error) => {
      if (this.process === child) this.process = undefined;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      this.pending.clear();
    });
    await this.request("initialize", {
      clientInfo: {
        name: "agent_deck",
        title: "Agent Deck",
        version: "0.1.0",
      },
      capabilities: {
        optOutNotificationMethods: [
          "item/agentMessage/delta",
          "item/reasoning/summaryTextDelta",
          "item/reasoning/textDelta",
        ],
      },
    });
    this.notify("initialized", {});
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, 10_000);
      this.pending.set(id, { resolve, reject, timeout });
      this.write({ method, id, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  private write(value: unknown): void {
    if (!this.process?.stdin.writable)
      throw new Error("Codex app-server is not writable");
    this.process.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private receive(line: string): void {
    let message: {
      id?: number;
      result?: unknown;
      error?: { message?: string };
    };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.error) {
      pending.reject(
        new Error(message.error.message ?? "Codex app-server request failed"),
      );
    } else {
      pending.resolve(message.result);
    }
  }
}
