import { describe, expect, it } from "vitest";
import {
  ACTION_IDS,
  actionSettingFields,
  serializeActionSettings,
} from "./action-settings.js";

describe("action settings", () => {
  it("declares only the fields owned by each action", () => {
    expect(actionSettingFields).toEqual({
      [ACTION_IDS.agentSlot]: ["slot", "look"],
      [ACTION_IDS.agentSummary]: ["summaryProviderId"],
      [ACTION_IDS.attention]: [],
      [ACTION_IDS.providerHealth]: [],
      [ACTION_IDS.providerUsage]: ["usageDefaultProviderId"],
      [ACTION_IDS.newAgent]: ["creationProviderId"],
      [ACTION_IDS.systemHealth]: [],
    });
  });

  it("serializes agent slot settings without legacy common fields", () => {
    expect(
      serializeActionSettings(ACTION_IDS.agentSlot, {
        slot: 3,
        look: "agent",
        summaryProviderId: "cursor-local",
        keyVisualTheme: "light",
        showSubagents: true,
      }),
    ).toEqual({ slot: 3, look: "agent" });
  });

  it("serializes recap and creation settings independently", () => {
    expect(
      serializeActionSettings(ACTION_IDS.agentSummary, {
        summaryProviderId: "codex",
        creationProviderId: "cursor-local",
      }),
    ).toEqual({ summaryProviderId: "codex" });
    expect(
      serializeActionSettings(ACTION_IDS.newAgent, {
        summaryProviderId: "codex",
        creationProviderId: "codex",
      }),
    ).toEqual({ creationProviderId: "codex" });
    expect(
      serializeActionSettings(ACTION_IDS.providerUsage, {
        usageDefaultProviderId: "cursor-local",
        creationProviderId: "codex",
      }),
    ).toEqual({ usageDefaultProviderId: "cursor-local" });
    expect(
      serializeActionSettings(ACTION_IDS.newAgent, {
        creationProviderId: "claude-code",
      }),
    ).toEqual({ creationProviderId: "claude-code" });
    expect(
      serializeActionSettings(ACTION_IDS.providerUsage, {
        usageDefaultProviderId: "claude-code",
      }),
    ).toEqual({ usageDefaultProviderId: "claude-code" });
  });

  it("returns empty settings for actions without specific controls", () => {
    for (const actionId of [
      ACTION_IDS.attention,
      ACTION_IDS.providerHealth,
      ACTION_IDS.systemHealth,
    ])
      expect(
        serializeActionSettings(actionId, {
          slot: 4,
          keyVisualTheme: "system",
        }),
      ).toEqual({});
  });

  it("normalizes invalid values to safe action defaults", () => {
    expect(
      serializeActionSettings(ACTION_IDS.agentSlot, {
        slot: -1,
        look: "unknown",
      }),
    ).toEqual({ look: "classic" });
    expect(
      serializeActionSettings(ACTION_IDS.newAgent, {
        creationProviderId: "unknown",
      }),
    ).toEqual({ creationProviderId: "cursor-local" });
  });
});
