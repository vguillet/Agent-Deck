export const MAX_PROGRAMMATIC_CALLS_PER_SECOND = 10;
export const ANIMATION_UPDATES_PER_SECOND = 9;
export const ANIMATION_INTERVAL_MS = Math.ceil(
  1_000 / ANIMATION_UPDATES_PER_SECOND,
);

interface AnimationFrameSchedulerOptions<T> {
  targets(): readonly T[];
  key(target: T): string;
  render(target: T): Promise<void>;
  onError(error: unknown): void;
}

/**
 * Sends each visible target at most one frame per interval.
 *
 * Stream Deck keys are not intended for high-frame-rate programmatic updates,
 * so each key stays below the documented per-key call limit. Slow writes are
 * skipped independently so one key cannot stall every other key.
 */
export class AnimationFrameScheduler<T> {
  private timer: NodeJS.Timeout | undefined;
  private readonly rendering = new Set<string>();

  constructor(private readonly options: AnimationFrameSchedulerOptions<T>) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.renderFrame();
    }, ANIMATION_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private renderFrame(): void {
    for (const target of this.options.targets()) {
      const key = this.options.key(target);
      if (this.rendering.has(key)) continue;
      this.rendering.add(key);
      void this.options
        .render(target)
        .catch((error: unknown) => {
          this.options.onError(error);
        })
        .finally(() => {
          this.rendering.delete(key);
        });
    }
  }
}
