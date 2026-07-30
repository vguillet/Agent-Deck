export const focusResultNeedsAlert = (result: { status: string }): boolean =>
  result.status !== "opened" && result.status !== "superseded";

export const settleFocusTask = async (
  task: Promise<void>,
  onFailure: (error: unknown) => Promise<void> | void,
): Promise<void> => {
  try {
    await task;
  } catch (error) {
    try {
      await onFailure(error);
    } catch {
      // Detached Stream Deck event work must never reject without an observer.
    }
  }
};

interface ActivePress<TTarget, TLongResult> {
  actionId: string;
  downAt: number;
  longPress: (target: TTarget) => Promise<TLongResult> | TLongResult;
  longPromise?: Promise<TLongResult>;
  target: TTarget;
  thresholdTimer: NodeJS.Timeout;
  watchdogTimer: NodeJS.Timeout;
  onWatchdog: (() => void) | undefined;
}

export type PressStartResult = "empty" | "ignored" | "started";

export type PressReleaseResult<TTarget, TLongResult> =
  | { kind: "none" }
  | { kind: "short"; target: TTarget }
  | { kind: "long"; completion: Promise<TLongResult> };

/**
 * Owns the complete down/up/threshold lifecycle for keyed actions.
 *
 * The release timestamp is authoritative at the threshold boundary, avoiding a
 * race between a 650 ms key-up and the timer callback. A watchdog recovers from
 * hardware or SDK sequences that omit key-up entirely.
 */
export class PressGestureController<TTarget, TLongResult = void> {
  private readonly active = new Map<
    string,
    ActivePress<TTarget, TLongResult>
  >();

  constructor(
    private readonly longPressDurationMs: number,
    private readonly watchdogDurationMs = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  keyDown(
    actionId: string,
    target: TTarget | undefined,
    onLongPress: (target: TTarget) => Promise<TLongResult> | TLongResult,
    onWatchdog?: () => void,
  ): PressStartResult {
    if (this.active.has(actionId)) return "ignored";
    if (target === undefined) return "empty";

    const active = {} as ActivePress<TTarget, TLongResult>;
    active.actionId = actionId;
    active.downAt = this.now();
    active.target = target;
    active.longPress = onLongPress;
    active.onWatchdog = onWatchdog;
    active.thresholdTimer = setTimeout(() => {
      this.startLong(active);
    }, this.longPressDurationMs);
    active.thresholdTimer.unref();
    active.watchdogTimer = setTimeout(() => {
      if (this.active.get(actionId) !== active) return;
      this.active.delete(actionId);
      clearTimeout(active.thresholdTimer);
      active.onWatchdog?.();
    }, this.watchdogDurationMs);
    active.watchdogTimer.unref();
    this.active.set(actionId, active);
    return "started";
  }

  keyUp(actionId: string): PressReleaseResult<TTarget, TLongResult> {
    const active = this.active.get(actionId);
    if (!active) return { kind: "none" };
    if (this.now() - active.downAt >= this.longPressDurationMs)
      this.startLong(active);
    this.active.delete(actionId);
    clearTimeout(active.thresholdTimer);
    clearTimeout(active.watchdogTimer);
    return active.longPromise
      ? { kind: "long", completion: active.longPromise }
      : { kind: "short", target: active.target };
  }

  cancel(actionId: string): boolean {
    const active = this.active.get(actionId);
    if (!active) return false;
    this.active.delete(actionId);
    clearTimeout(active.thresholdTimer);
    clearTimeout(active.watchdogTimer);
    return true;
  }

  has(actionId: string): boolean {
    return this.active.has(actionId);
  }

  private startLong(active: ActivePress<TTarget, TLongResult>): void {
    if (active.longPromise || this.active.get(active.actionId) !== active)
      return;
    active.longPromise = Promise.resolve().then(() =>
      active.longPress(active.target),
    );
    void active.longPromise.catch(() => undefined);
  }
}
