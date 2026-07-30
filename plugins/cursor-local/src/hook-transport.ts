const REPORT_TIMEOUT_MS = 700;
const RETRY_DELAYS_MS = [0, 75, 150, 300] as const;

type Fetcher = typeof fetch;
type Delay = (durationMs: number) => Promise<void>;

const wait: Delay = (durationMs) =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

const isAbortError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "name" in error &&
  error.name === "AbortError";

export interface HookTransportOptions {
  delay?: Delay;
  fetcher?: Fetcher;
  timeoutMs?: number;
}

export const reportCursorHook = async (
  endpoint: string,
  payload: unknown,
  options: HookTransportOptions = {},
): Promise<boolean> => {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? REPORT_TIMEOUT_MS,
  );
  const delay = options.delay ?? wait;
  const fetcher = options.fetcher ?? fetch;
  try {
    for (const retryDelay of RETRY_DELAYS_MS) {
      if (retryDelay) await delay(retryDelay);
      try {
        const response = await fetcher(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        if (response.ok) return true;
        if (response.status < 500) return false;
      } catch (error) {
        if (isAbortError(error)) return false;
      }
    }
    return false;
  } finally {
    clearTimeout(timeout);
  }
};
