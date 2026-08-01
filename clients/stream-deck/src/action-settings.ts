import type { AgentKeyLook } from "./agent-look.js";

export const ACTION_IDS = {
  agentSlot: "com.agentdeck.monitor.agent-slot",
  agentSummary: "com.agentdeck.monitor.agent-summary",
  attention: "com.agentdeck.monitor.attention",
  providerHealth: "com.agentdeck.monitor.provider-health",
  providerUsage: "com.agentdeck.monitor.provider-usage",
  newAgent: "com.agentdeck.monitor.new-agent",
  systemHealth: "com.agentdeck.monitor.system-health",
} as const;

export type ActionId = (typeof ACTION_IDS)[keyof typeof ACTION_IDS];
export type ActionSettingValue = string | number | boolean | null | undefined;

interface StreamDeckSettings {
  [key: string]: ActionSettingValue;
}

export interface AgentSlotSettings extends StreamDeckSettings {
  slot?: number;
  look?: AgentKeyLook;
}

export interface AgentSummarySettings extends StreamDeckSettings {
  summaryProviderId?: string;
}

export interface NewAgentSettings extends StreamDeckSettings {
  creationProviderId?: "cursor-local" | "codex" | "claude-code";
}

export interface ProviderUsageSettings extends StreamDeckSettings {
  usageDefaultProviderId?: "cursor-local" | "codex" | "claude-code";
}

export type EmptyActionSettings = StreamDeckSettings;
export type AnyActionSettings =
  | AgentSlotSettings
  | AgentSummarySettings
  | ProviderUsageSettings
  | NewAgentSettings
  | EmptyActionSettings;

export type ActionSettingsById = {
  [ACTION_IDS.agentSlot]: AgentSlotSettings;
  [ACTION_IDS.agentSummary]: AgentSummarySettings;
  [ACTION_IDS.attention]: EmptyActionSettings;
  [ACTION_IDS.providerHealth]: EmptyActionSettings;
  [ACTION_IDS.providerUsage]: ProviderUsageSettings;
  [ACTION_IDS.newAgent]: NewAgentSettings;
  [ACTION_IDS.systemHealth]: EmptyActionSettings;
};

export const actionSettingFields = {
  [ACTION_IDS.agentSlot]: ["slot", "look"],
  [ACTION_IDS.agentSummary]: ["summaryProviderId"],
  [ACTION_IDS.attention]: [],
  [ACTION_IDS.providerHealth]: [],
  [ACTION_IDS.providerUsage]: ["usageDefaultProviderId"],
  [ACTION_IDS.newAgent]: ["creationProviderId"],
  [ACTION_IDS.systemHealth]: [],
} as const satisfies Record<ActionId, readonly string[]>;

export const isActionId = (value: string): value is ActionId =>
  Object.values(ACTION_IDS).some((actionId) => actionId === value);

export const serializeActionSettings = (
  actionId: string,
  values: Readonly<Record<string, unknown>>,
): AnyActionSettings => {
  if (actionId === ACTION_IDS.agentSlot) {
    const settings: AgentSlotSettings = {};
    const slot = values.slot;
    if (
      typeof slot === "number" &&
      Number.isInteger(slot) &&
      slot >= 0 &&
      Number.isFinite(slot)
    )
      settings.slot = slot;
    settings.look = values.look === "agent" ? "agent" : "classic";
    return settings;
  }

  if (actionId === ACTION_IDS.agentSummary)
    return {
      summaryProviderId:
        typeof values.summaryProviderId === "string"
          ? values.summaryProviderId
          : "",
    };

  if (actionId === ACTION_IDS.newAgent)
    return {
      creationProviderId:
        values.creationProviderId === "codex" ||
        values.creationProviderId === "claude-code"
          ? values.creationProviderId
          : "cursor-local",
    };

  if (actionId === ACTION_IDS.providerUsage)
    return {
      usageDefaultProviderId:
        values.usageDefaultProviderId === "cursor-local" ||
        values.usageDefaultProviderId === "claude-code"
          ? values.usageDefaultProviderId
          : "codex",
    };

  return {};
};
