import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTION_IDS } from "./action-settings.js";
import {
  ACTION_SECTION_IDS,
  COMMON_SETTING_IDS,
  actionValuesFromControls,
  buildCommonConfiguration,
  providerItems,
  writeConfigurationWithRetry,
} from "./property-inspector.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("property inspector settings scopes", () => {
  it("shows an action section only for actions with specific settings", () => {
    expect(ACTION_SECTION_IDS).toEqual({
      [ACTION_IDS.agentSlot]: "agentSlotSettings",
      [ACTION_IDS.agentSummary]: "agentSummarySettings",
      [ACTION_IDS.attention]: undefined,
      [ACTION_IDS.providerHealth]: undefined,
      [ACTION_IDS.providerUsage]: "providerUsageSettings",
      [ACTION_IDS.newAgent]: "newAgentSettings",
      [ACTION_IDS.systemHealth]: undefined,
    });
  });

  it("exposes the complete device-wide Common field set", () => {
    expect(COMMON_SETTING_IDS).toEqual([
      "serverUrl",
      "name",
      "role",
      "providers",
      "showSubagents",
      "keyVisualTheme",
    ]);
  });

  it("reads only controls owned by the selected action", () => {
    const requested: string[] = [];
    const settings = actionValuesFromControls(
      ACTION_IDS.newAgent,
      (fieldId) => {
        requested.push(fieldId);
        return fieldId === "creationProviderId" ? "codex" : "ignored";
      },
    );

    expect(requested).toEqual(["creationProviderId"]);
    expect(settings).toEqual({ creationProviderId: "codex" });
  });

  it("builds Common configuration without discarding server-owned data", () => {
    expect(
      buildCommonConfiguration(
        { states: ["running"], futureSetting: "preserved" },
        {
          serverUrl: "http://localhost:47831/",
          name: "Office Deck",
          role: "agent-monitor",
          providers: "cursor-local, codex, ",
          showSubagents: true,
          keyVisualTheme: "system",
        },
      ),
    ).toEqual({
      states: ["running"],
      futureSetting: "preserved",
      serverUrl: "http://localhost:47831",
      name: "Office Deck",
      role: "agent-monitor",
      providers: ["cursor-local", "codex"],
      showSubagents: true,
      keyVisualTheme: "system",
    });
  });

  it("refetches and retries one optimistic-lock conflict", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: { serverOwned: "old" }, revision: 4 }),
          {
            status: 200,
          },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { serverOwned: "new", concurrent: true },
            revision: 5,
          }),
          {
            status: 200,
          },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await writeConfigurationWithRetry(
      "http://localhost:47831",
      "device-1",
      (existing) => ({ ...existing, keyVisualTheme: "light" }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "if-match": '"4"',
      },
    });
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "if-match": '"5"',
      },
    });
    expect(
      JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body)),
    ).toMatchObject({
      data: {
        serverOwned: "new",
        concurrent: true,
        keyVisualTheme: "light",
      },
    });
  });

  it("uses provider displayName values from the API contract", () => {
    expect(
      providerItems({
        items: [
          { id: "codex", displayName: "Codex" },
          { id: "invalid", name: "Legacy name" },
        ],
      }),
    ).toEqual([{ id: "codex", name: "Codex" }]);
  });
});
