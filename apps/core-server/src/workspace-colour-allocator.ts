import { WORKSPACE_COLOURS, type Workspace } from "@agent-deck/domain";

const shuffled = (
  colours: readonly string[],
  random: () => number,
): string[] => {
  const result = [...colours];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex]!, result[index]!];
  }
  return result;
};

export class WorkspaceColourAllocator {
  private readonly colours: string[];
  private readonly assignments = new Map<string, string>();

  constructor(
    random: () => number = Math.random,
    palette: readonly string[] = WORKSPACE_COLOURS,
  ) {
    this.colours = shuffled(palette, random);
  }

  colour(workspaceId: string): string {
    const existing = this.assignments.get(workspaceId);
    if (existing) return existing;
    const colour =
      this.colours[this.assignments.size % this.colours.length] ?? "#2563eb";
    this.assignments.set(workspaceId, colour);
    return colour;
  }

  decorate(workspace: Workspace): Workspace {
    return { ...workspace, colour: this.colour(workspace.id) };
  }
}
