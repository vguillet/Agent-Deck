import {
  ACTION_IDS,
  actionSettingFields,
  serializeActionSettings,
  type ActionId,
  type AnyActionSettings,
} from "./action-settings.js";

const DEFAULT_SERVER_URL = "http://127.0.0.1:47831";
const CONFIGURATION_SCHEMA = "com.agentdeck.stream-deck/v1";
const ALL_AGENT_STATES = [
  "idle",
  "running",
  "recovering",
  "waiting_for_input",
  "waiting_for_approval",
  "ready_for_review",
  "failed",
  "cancelled",
  "unknown",
] as const;

export const COMMON_SETTING_IDS = [
  "serverUrl",
  "name",
  "role",
  "providers",
  "showSubagents",
  "keyVisualTheme",
] as const;

export const ACTION_SECTION_IDS: Record<ActionId, string | undefined> = {
  [ACTION_IDS.agentSlot]: "agentSlotSettings",
  [ACTION_IDS.agentSummary]: "agentSummarySettings",
  [ACTION_IDS.attention]: undefined,
  [ACTION_IDS.providerHealth]: undefined,
  [ACTION_IDS.providerUsage]: "providerUsageSettings",
  [ACTION_IDS.newAgent]: "newAgentSettings",
  [ACTION_IDS.systemHealth]: undefined,
};

interface CommonControlValues {
  serverUrl: string;
  name: string;
  role: string;
  providers: string;
  showSubagents: boolean;
  keyVisualTheme: string;
}

interface ConfigurationDocument {
  data: Record<string, unknown>;
  revision: number | undefined;
}

interface PropertyInspectorMessage {
  event?: unknown;
  payload?: {
    settings?: {
      serverUrl?: unknown;
    };
  };
}

interface ProviderItem {
  id: string;
  name: string;
}

export const providerItems = (value: unknown): ProviderItem[] => {
  const body = asRecord(value);
  return Array.isArray(body.items)
    ? body.items
        .map(asRecord)
        .filter(
          (provider) =>
            typeof provider.id === "string" &&
            typeof provider.displayName === "string",
        )
        .map((provider) => ({
          id: provider.id as string,
          name: provider.displayName as string,
        }))
    : [];
};

export const buildCommonConfiguration = (
  existing: Readonly<Record<string, unknown>>,
  values: CommonControlValues,
): Record<string, unknown> => ({
  ...existing,
  serverUrl: normalizeServerUrl(values.serverUrl),
  name: values.name,
  role: values.role,
  providers: values.providers
    .split(",")
    .map((provider) => provider.trim())
    .filter(Boolean),
  states: Array.isArray(existing.states) ? existing.states : ALL_AGENT_STATES,
  showSubagents: values.showSubagents,
  keyVisualTheme:
    values.keyVisualTheme === "light" || values.keyVisualTheme === "system"
      ? values.keyVisualTheme
      : "dark",
});

export const actionValuesFromControls = (
  actionId: string,
  getValue: (fieldId: string) => unknown,
): AnyActionSettings => {
  const fields =
    actionId in actionSettingFields
      ? actionSettingFields[actionId as ActionId]
      : [];
  return serializeActionSettings(
    actionId,
    Object.fromEntries(fields.map((field) => [field, getValue(field)])),
  );
};

const normalizeServerUrl = (value: string): string =>
  (value.trim() || DEFAULT_SERVER_URL).replace(/\/+$/, "");

const element = <T extends HTMLElement>(id: string): T => {
  const match = document.getElementById(id);
  if (!match) throw new Error(`Missing property inspector element #${id}`);
  return match as T;
};

const inputValue = (id: string): string =>
  element<HTMLInputElement | HTMLSelectElement>(id).value;

const controlValue = (id: string): unknown => {
  const control = element<HTMLInputElement | HTMLSelectElement>(id);
  if (control instanceof HTMLInputElement && control.type === "number")
    return control.value === "" ? undefined : Number(control.value);
  return control.value;
};

const readCommonControls = (): CommonControlValues => ({
  serverUrl: inputValue("serverUrl"),
  name: inputValue("name"),
  role: inputValue("role"),
  providers: inputValue("providers"),
  showSubagents: element<HTMLInputElement>("showSubagents").checked,
  keyVisualTheme: inputValue("keyVisualTheme"),
});

const configurationUrl = (serverUrl: string, deviceId: string): string =>
  `${normalizeServerUrl(serverUrl)}/api/v1/clients/stream-deck%3A${encodeURIComponent(deviceId)}/configuration`;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};

const readConfigurationDocument = async (
  serverUrl: string,
  deviceId: string,
): Promise<ConfigurationDocument> => {
  const response = await fetch(configurationUrl(serverUrl, deviceId));
  if (response.status === 404) return { data: {}, revision: undefined };
  if (!response.ok)
    throw new Error(`Configuration read failed (${response.status})`);
  const document = asRecord(await response.json());
  return {
    data: asRecord(document.data),
    revision:
      typeof document.revision === "number" ? document.revision : undefined,
  };
};

export const writeConfigurationWithRetry = async (
  serverUrl: string,
  deviceId: string,
  update: (
    existing: Readonly<Record<string, unknown>>,
  ) => Record<string, unknown>,
  attempts = 2,
): Promise<Record<string, unknown>> => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const existing = await readConfigurationDocument(serverUrl, deviceId);
    const data = update(existing.data);
    const response = await fetch(configurationUrl(serverUrl, deviceId), {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...(existing.revision === undefined
          ? {}
          : { "if-match": `"${existing.revision}"` }),
      },
      body: JSON.stringify({ schema: CONFIGURATION_SCHEMA, data }),
    });
    if (response.ok) return data;
    if (response.status !== 409 || attempt === attempts - 1)
      throw new Error(`Configuration save failed (${response.status})`);
  }
  throw new Error("Configuration save failed");
};

let websocket: WebSocket | undefined;
let context = "";
let deviceId = "";
let actionId = "";
let actionSettings: Record<string, unknown> = {};
let configurationData: Record<string, unknown> = {};
let commonSaveQueue = Promise.resolve();

const send = (event: string, payload: unknown): void => {
  if (websocket?.readyState !== WebSocket.OPEN) return;
  websocket.send(
    JSON.stringify({
      action: actionId,
      event,
      context,
      payload,
    }),
  );
};

const setStatus = (message: string, isError = false): void => {
  const status = element<HTMLElement>("saveStatus");
  status.textContent = message;
  status.dataset.error = String(isError);
};

const saveActionSettings = (): void => {
  send("setSettings", actionValuesFromControls(actionId, controlValue));
};

const saveCommonSettings = async (
  values: CommonControlValues,
): Promise<void> => {
  const serverUrl = normalizeServerUrl(values.serverUrl);
  const data = await writeConfigurationWithRetry(
    serverUrl,
    deviceId,
    (existing) => buildCommonConfiguration(existing, values),
  );
  configurationData = data;
  send("setGlobalSettings", { serverUrl });
  send("sendToPlugin", { type: "common-settings-updated" });
  setStatus("Saved");
};

const queueCommonSave = (): void => {
  const values = readCommonControls();
  setStatus("Saving…");
  commonSaveQueue = commonSaveQueue
    .catch(() => undefined)
    .then(() => saveCommonSettings(values))
    .catch((error: unknown) => {
      setStatus(
        error instanceof Error ? error.message : "Unable to save settings",
        true,
      );
    });
};

const setSelectValue = (
  select: HTMLSelectElement,
  value: string,
  fallbackLabel = value,
): void => {
  if (
    !Array.from(select.options).some((option) => option.value === value) &&
    value
  )
    select.add(new Option(fallbackLabel, value));
  select.value = value;
};

const populateProviders = async (serverUrl: string): Promise<void> => {
  try {
    const response = await fetch(
      `${normalizeServerUrl(serverUrl)}/api/v1/providers?limit=200`,
    );
    if (!response.ok) return;
    const providers = providerItems(await response.json());
    const select = element<HTMLSelectElement>("summaryProviderId");
    const selected =
      typeof actionSettings.summaryProviderId === "string"
        ? actionSettings.summaryProviderId
        : "";
    select.replaceChildren(new Option("All agents", ""));
    for (const provider of providers)
      select.add(new Option(provider.name, provider.id));
    setSelectValue(select, selected);
  } catch {
    // Provider discovery is optional; retain the saved value when offline.
  }
};

const populateCommonControls = (data: Record<string, unknown>): void => {
  element<HTMLInputElement>("name").value =
    typeof data.name === "string" ? data.name : "Stream Deck";
  element<HTMLInputElement>("role").value =
    typeof data.role === "string" ? data.role : "agent-monitor";
  element<HTMLInputElement>("providers").value = Array.isArray(data.providers)
    ? data.providers.filter((value) => typeof value === "string").join(",")
    : "";
  element<HTMLInputElement>("showSubagents").checked =
    data.showSubagents === true;
  setSelectValue(
    element<HTMLSelectElement>("keyVisualTheme"),
    data.keyVisualTheme === "light" || data.keyVisualTheme === "system"
      ? data.keyVisualTheme
      : "dark",
  );
};

const loadCommonSettings = async (serverUrl: string): Promise<void> => {
  element<HTMLInputElement>("serverUrl").value = serverUrl;
  await populateProviders(serverUrl);
  try {
    const document = await readConfigurationDocument(serverUrl, deviceId);
    configurationData = document.data;
    populateCommonControls(configurationData);
    setStatus("");
  } catch (error) {
    setStatus(
      error instanceof Error ? error.message : "Unable to load settings",
      true,
    );
  }
};

const showActionSection = (): void => {
  const selectedSection = ACTION_SECTION_IDS[actionId as ActionId];
  const container = element<HTMLElement>("actionSettings");
  container.hidden = !selectedSection;
  for (const section of Array.from(
    document.querySelectorAll<HTMLElement>("[data-action-settings]"),
  ))
    section.hidden = section.id !== selectedSection;
};

const populateActionControls = (): void => {
  element<HTMLInputElement>("slot").value =
    typeof actionSettings.slot === "number" ? String(actionSettings.slot) : "";
  setSelectValue(
    element<HTMLSelectElement>("look"),
    actionSettings.look === "agent" ? "agent" : "classic",
  );
  setSelectValue(
    element<HTMLSelectElement>("summaryProviderId"),
    typeof actionSettings.summaryProviderId === "string"
      ? actionSettings.summaryProviderId
      : "",
  );
  setSelectValue(
    element<HTMLSelectElement>("creationProviderId"),
    actionSettings.creationProviderId === "codex" ||
      actionSettings.creationProviderId === "claude-code"
      ? actionSettings.creationProviderId
      : "cursor-local",
  );
  setSelectValue(
    element<HTMLSelectElement>("usageDefaultProviderId"),
    actionSettings.usageDefaultProviderId === "cursor-local" ||
      actionSettings.usageDefaultProviderId === "claude-code"
      ? actionSettings.usageDefaultProviderId
      : "codex",
  );
};

const initializeListeners = (): void => {
  for (const fieldId of Object.values(actionSettingFields).flat())
    element<HTMLInputElement | HTMLSelectElement>(fieldId).addEventListener(
      "change",
      saveActionSettings,
    );
  for (const fieldId of COMMON_SETTING_IDS)
    element<HTMLInputElement | HTMLSelectElement>(fieldId).addEventListener(
      "change",
      queueCommonSave,
    );
};

declare global {
  interface Window {
    connectElgatoStreamDeckSocket: (
      port: string,
      uuid: string,
      registerEvent: string,
      info: string,
      actionInfo: string,
    ) => void;
  }
}

if (typeof window !== "undefined") {
  initializeListeners();
  window.connectElgatoStreamDeckSocket = (
    port,
    uuid,
    registerEvent,
    _info,
    rawActionInfo,
  ) => {
    context = uuid;
    const parsed = asRecord(JSON.parse(rawActionInfo) as unknown);
    deviceId = typeof parsed.device === "string" ? parsed.device : "";
    actionId = typeof parsed.action === "string" ? parsed.action : "";
    actionSettings = asRecord(asRecord(parsed.payload).settings);
    populateActionControls();
    showActionSection();

    websocket = new WebSocket(`ws://127.0.0.1:${port}`);
    websocket.addEventListener("open", () => {
      websocket?.send(JSON.stringify({ event: registerEvent, uuid }));
      send("getGlobalSettings", {});
    });
    websocket.addEventListener("message", (event) => {
      const message = JSON.parse(
        String(event.data),
      ) as PropertyInspectorMessage;
      if (message.event !== "didReceiveGlobalSettings") return;
      const configuredUrl = message.payload?.settings?.serverUrl;
      void loadCommonSettings(
        typeof configuredUrl === "string"
          ? normalizeServerUrl(configuredUrl)
          : DEFAULT_SERVER_URL,
      );
    });
  };
}
