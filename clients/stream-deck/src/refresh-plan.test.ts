import { describe, expect, it } from "vitest";
import {
  addRefreshResources,
  actionManifestIdsForResources,
  allRefreshResources,
  refreshResourcesForEvent,
} from "./refresh-plan.js";

describe("Stream Deck refresh planning", () => {
  it("refreshes only resources affected by canonical events", () => {
    expect([...refreshResourcesForEvent("agent.state.changed")]).toEqual([
      "agents",
      "attention",
    ]);
    expect([...refreshResourcesForEvent("provider.health.changed")]).toEqual([
      "providers",
      "attention",
      "health",
    ]);
    expect([...refreshResourcesForEvent("workspace.upserted")]).toEqual([
      "workspaces",
    ]);
    expect([...refreshResourcesForEvent("attention.resolved")]).toEqual([
      "attention",
    ]);
    expect([...refreshResourcesForEvent("project.upserted")]).toEqual([]);
  });

  it("keeps full refreshes explicit", () => {
    expect([...allRefreshResources()]).toEqual([
      "agents",
      "attention",
      "providers",
      "workspaces",
      "health",
    ]);
  });

  it("unions resources from every event in a debounce window", () => {
    const pending = new Set(refreshResourcesForEvent("workspace.upserted"));
    addRefreshResources(
      pending,
      refreshResourcesForEvent("provider.health.changed"),
    );

    expect([...pending]).toEqual([
      "workspaces",
      "providers",
      "attention",
      "health",
    ]);
  });

  it("renders only action kinds affected by refreshed resources", () => {
    expect([...actionManifestIdsForResources(new Set(["workspaces"]))]).toEqual(
      ["com.agentdeck.monitor.agent-slot"],
    );
    expect([
      ...actionManifestIdsForResources(new Set(["providers", "health"])),
    ]).toEqual([
      "com.agentdeck.monitor.provider-health",
      "com.agentdeck.monitor.system-health",
    ]);
  });
});
