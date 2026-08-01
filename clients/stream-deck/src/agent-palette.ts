import type { AgentState } from "@agent-deck/domain";

export type KeyVisualThemePreference = "dark" | "light" | "system";
export type ResolvedKeyVisualTheme = Exclude<
  KeyVisualThemePreference,
  "system"
>;

export interface KeyVisualPalette {
  id: ResolvedKeyVisualTheme;
  stateSurface: Readonly<Record<AgentState, string>>;
  stateAccent: Readonly<Record<AgentState, string>>;
  emptySurface: string;
  emptyCharacter: string;
  foreground: string;
  inverseForeground: string;
  labelSurface: string;
  labelOpacity: number;
  progressSurface: string;
  progressOpacity: number;
  stripe: string;
  stripeOpacity: number;
  mutedOverlay: string;
  mutedOverlayOpacity: number;
  providerTileSurface: string;
  providerForeground: string;
  providerNeutral: string;
  providerNeutralLight: string;
  providerNeutralMid: string;
  providerNeutralDark: string;
  genericLogoSurface: string;
  modeBadgeSurface: string;
  workspaceBadgeBorder: string;
  workspaceBadgeForeground: string;
  bringUpSurface: string;
  bringUpHalo: string;
  newAgentSurface: string;
  newAgentCharacter: string;
}

export const normalizeKeyVisualThemePreference = (
  value: unknown,
): KeyVisualThemePreference =>
  value === "light" || value === "system" ? value : "dark";

export const CLASSIC_AGENT_STATE_COLOUR: Readonly<Record<AgentState, string>> =
  {
    idle: "#64748b",
    running: "#2563eb",
    recovering: "#2563eb",
    waiting_for_input: "#f59e0b",
    waiting_for_approval: "#f97316",
    ready_for_review: "#10b981",
    failed: "#dc2626",
    cancelled: "#64748b",
    unknown: "#475569",
  };

export const CLASSIC_EMPTY_AGENT_COLOUR = "#000000";

export const DARK_KEY_VISUAL_PALETTE: KeyVisualPalette = {
  id: "dark",
  stateSurface: CLASSIC_AGENT_STATE_COLOUR,
  stateAccent: CLASSIC_AGENT_STATE_COLOUR,
  emptySurface: CLASSIC_EMPTY_AGENT_COLOUR,
  emptyCharacter: "#ffffff",
  foreground: "#ffffff",
  inverseForeground: "#0f172a",
  labelSurface: "#000000",
  labelOpacity: 0.34,
  progressSurface: "#000000",
  progressOpacity: 0.62,
  stripe: "#ffffff",
  stripeOpacity: 0.16,
  mutedOverlay: "#64748b",
  mutedOverlayOpacity: 0.32,
  providerTileSurface: "#11100d",
  providerForeground: "#ffffff",
  providerNeutral: "#4c4b47",
  providerNeutralLight: "#d5d4d1",
  providerNeutralMid: "#85847f",
  providerNeutralDark: "#5f5e5a",
  genericLogoSurface: "#000000",
  modeBadgeSurface: "#000000",
  workspaceBadgeBorder: "#ffffff",
  workspaceBadgeForeground: "#ffffff",
  bringUpSurface: "#020617",
  bringUpHalo: "#22d3ee",
  newAgentSurface: "#172033",
  newAgentCharacter: "#ffffff",
};

export const LIGHT_KEY_VISUAL_PALETTE: KeyVisualPalette = {
  id: "light",
  stateSurface: CLASSIC_AGENT_STATE_COLOUR,
  stateAccent: CLASSIC_AGENT_STATE_COLOUR,
  emptySurface: "#e2e8f0",
  emptyCharacter: "#cbd5e1",
  foreground: "#ffffff",
  inverseForeground: "#0f172a",
  labelSurface: "#000000",
  labelOpacity: 0.34,
  progressSurface: "#000000",
  progressOpacity: 0.62,
  stripe: "#ffffff",
  stripeOpacity: 0.16,
  mutedOverlay: "#64748b",
  mutedOverlayOpacity: 0.32,
  providerTileSurface: "#ffffff",
  providerForeground: "#0f172a",
  providerNeutral: "#4c4b47",
  providerNeutralLight: "#d5d4d1",
  providerNeutralMid: "#85847f",
  providerNeutralDark: "#5f5e5a",
  genericLogoSurface: "#ffffff",
  modeBadgeSurface: "#000000",
  workspaceBadgeBorder: "#ffffff",
  workspaceBadgeForeground: "#ffffff",
  bringUpSurface: "#020617",
  bringUpHalo: "#22d3ee",
  newAgentSurface: "#e2e8f0",
  newAgentCharacter: "#64748b",
};

export const keyVisualPalette = (
  theme: ResolvedKeyVisualTheme,
): KeyVisualPalette =>
  theme === "light" ? LIGHT_KEY_VISUAL_PALETTE : DARK_KEY_VISUAL_PALETTE;
