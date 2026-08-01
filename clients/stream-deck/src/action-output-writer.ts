export interface ActionOutputTarget {
  id: string;
  setImage(image: string): Promise<void>;
  setTitle(title: string): Promise<void>;
}

export interface ActionOutput {
  image?: string;
  title?: string;
}

export interface ActionOutputCommit<TBinding> {
  binding?: TBinding | undefined;
}

export interface StagedActionOutput<TBinding> {
  output: ActionOutput;
  commit: ActionOutputCommit<TBinding> | undefined;
}

interface WriteWaiter {
  resolve(): void;
  reject(error: unknown): void;
}

interface PendingOutput<TBinding> {
  output: ActionOutput;
  commit: ActionOutputCommit<TBinding> | undefined;
  waiters: WriteWaiter[];
}

interface ActionOutputState<TBinding> {
  binding: TBinding | undefined;
  closed: boolean;
  image: string | undefined;
  pending: PendingOutput<TBinding> | undefined;
  running: boolean;
  title: string | undefined;
}

/**
 * Commits only the newest queued frame for each action.
 *
 * Slow writes remain isolated per key. A binding advances only after the
 * matching frame has been accepted by the SDK, allowing input handling to use
 * the identity represented by the visible frame.
 */
export class ActionOutputWriter<TBinding = never> {
  private readonly states = new Map<string, ActionOutputState<TBinding>>();
  private readonly staging = new Set<string>();
  private readonly staged = new Map<string, StagedActionOutput<TBinding>>();

  write(
    target: ActionOutputTarget,
    output: ActionOutput,
    commit?: ActionOutputCommit<TBinding>,
  ): Promise<void> {
    if (this.staging.has(target.id)) {
      this.staged.set(target.id, { output, commit });
      return Promise.resolve();
    }
    let state = this.states.get(target.id);
    if (!state) {
      state = {
        binding: undefined,
        closed: false,
        image: undefined,
        pending: undefined,
        running: false,
        title: undefined,
      };
      this.states.set(target.id, state);
    }

    const promise = new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject };
      if (state.pending) {
        state.pending.output = output;
        state.pending.commit = commit;
        state.pending.waiters.push(waiter);
      } else {
        state.pending = { output, commit, waiters: [waiter] };
      }
    });
    this.pump(target, state);
    return promise;
  }

  committedBinding(actionId: string): TBinding | undefined {
    return this.states.get(actionId)?.binding;
  }

  committedImage(actionId: string): string | undefined {
    return this.states.get(actionId)?.image;
  }

  beginStaging(actionId: string): void {
    this.staging.add(actionId);
    this.staged.delete(actionId);
  }

  takeStaged(actionId: string): StagedActionOutput<TBinding> | undefined {
    this.staging.delete(actionId);
    const output = this.staged.get(actionId);
    this.staged.delete(actionId);
    return output;
  }

  discardStaged(actionId: string): void {
    this.staging.delete(actionId);
    this.staged.delete(actionId);
  }

  clear(actionId: string): void {
    this.discardStaged(actionId);
    const state = this.states.get(actionId);
    if (!state) return;
    state.closed = true;
    this.states.delete(actionId);
    if (state.pending) {
      for (const waiter of state.pending.waiters) waiter.resolve();
      state.pending = undefined;
    }
  }

  private pump(
    target: ActionOutputTarget,
    state: ActionOutputState<TBinding>,
  ): void {
    if (state.running || state.closed || !state.pending) return;
    const pending = state.pending;
    state.pending = undefined;
    state.running = true;

    void this.commit(target, state, pending)
      .then(
        () => {
          for (const waiter of pending.waiters) waiter.resolve();
        },
        (error: unknown) => {
          for (const waiter of pending.waiters) waiter.reject(error);
        },
      )
      .finally(() => {
        state.running = false;
        this.pump(target, state);
      });
  }

  private async commit(
    target: ActionOutputTarget,
    state: ActionOutputState<TBinding>,
    pending: PendingOutput<TBinding>,
  ): Promise<void> {
    if (state.closed) return;
    const writes: Promise<void>[] = [];
    if (
      pending.output.title !== undefined &&
      pending.output.title !== state.title
    )
      writes.push(
        target.setTitle(pending.output.title).then(() => {
          if (!state.closed) state.title = pending.output.title;
        }),
      );
    if (
      pending.output.image !== undefined &&
      pending.output.image !== state.image
    )
      writes.push(
        target.setImage(pending.output.image).then(() => {
          if (!state.closed) state.image = pending.output.image;
        }),
      );
    await Promise.all(writes);
    if (!state.closed && pending.commit && "binding" in pending.commit)
      state.binding = pending.commit.binding;
  }
}
