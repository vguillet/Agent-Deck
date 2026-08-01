import { workspaceAcronym, workspaceColour } from "@agent-deck/client-sdk";
import { workspaceResourcesForRoots, type Workspace } from "@agent-deck/domain";

export interface WorkspaceStatus {
  text: string;
  tooltip: string;
  colour: string;
}

export const workspaceStatus = (
  workspaceRoots: readonly string[],
  registeredWorkspace?: Workspace,
): WorkspaceStatus | undefined => {
  const localWorkspace = workspaceResourcesForRoots(
    "cursor-local",
    workspaceRoots,
  ).workspace;
  if (!localWorkspace) return undefined;
  const workspace =
    registeredWorkspace?.id === localWorkspace.id
      ? registeredWorkspace
      : localWorkspace;

  return {
    text: `$(circle-filled) ${workspaceAcronym(workspace.name)}`,
    tooltip: `Agent Deck workspace: ${workspace.name}`,
    colour: workspaceColour(workspace),
  };
};
