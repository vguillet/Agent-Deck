export interface ActionOutputTarget {
  id: string;
  setImage(image: string): Promise<void>;
  setTitle(title: string): Promise<void>;
}

export interface ActionOutput {
  image?: string;
  title?: string;
}

interface ActionOutputState {
  closed: boolean;
  image: string | undefined;
  tail: Promise<void>;
  title: string | undefined;
}

/**
 * Orders writes per action and suppresses values already committed to the SDK.
 * Distinct actions remain independent, so a slow key cannot stall another key.
 */
export class ActionOutputWriter {
  private readonly states = new Map<string, ActionOutputState>();

  write(target: ActionOutputTarget, output: ActionOutput): Promise<void> {
    let state = this.states.get(target.id);
    if (!state) {
      state = {
        closed: false,
        image: undefined,
        tail: Promise.resolve(),
        title: undefined,
      };
      this.states.set(target.id, state);
    }

    const run = async (): Promise<void> => {
      if (state.closed) return;
      const writes: Promise<void>[] = [];
      if (output.title !== undefined && output.title !== state.title)
        writes.push(
          target.setTitle(output.title).then(() => {
            state.title = output.title;
          }),
        );
      if (output.image !== undefined && output.image !== state.image)
        writes.push(
          target.setImage(output.image).then(() => {
            state.image = output.image;
          }),
        );
      await Promise.all(writes);
    };

    const pending = state.tail.catch(() => undefined).then(run);
    state.tail = pending;
    return pending;
  }

  clear(actionId: string): void {
    const state = this.states.get(actionId);
    if (!state) return;
    state.closed = true;
    this.states.delete(actionId);
  }
}
