import { AGENT_STATES } from "@agent-deck/domain";
import { describe, expect, it } from "vitest";
import {
  DARK_KEY_VISUAL_PALETTE,
  keyVisualPalette,
  LIGHT_KEY_VISUAL_PALETTE,
  normalizeKeyVisualThemePreference,
} from "./agent-palette.js";

describe("Stream Deck key visual palette", () => {
  it("keeps dark as the backward-compatible preference", () => {
    expect(normalizeKeyVisualThemePreference(undefined)).toBe("dark");
    expect(normalizeKeyVisualThemePreference("unsupported")).toBe("dark");
    expect(normalizeKeyVisualThemePreference("dark")).toBe("dark");
    expect(normalizeKeyVisualThemePreference("light")).toBe("light");
    expect(normalizeKeyVisualThemePreference("system")).toBe("system");
  });

  it("resolves complete dark and light palettes", () => {
    expect(keyVisualPalette("dark")).toBe(DARK_KEY_VISUAL_PALETTE);
    expect(keyVisualPalette("light")).toBe(LIGHT_KEY_VISUAL_PALETTE);
    for (const palette of [DARK_KEY_VISUAL_PALETTE, LIGHT_KEY_VISUAL_PALETTE])
      for (const state of AGENT_STATES) {
        expect(palette.stateSurface[state]).toMatch(/^#[0-9a-f]{6}$/i);
        expect(palette.stateAccent[state]).toMatch(/^#[0-9a-f]{6}$/i);
      }
  });

  it("only changes empty and create-agent surfaces and characters", () => {
    expect(LIGHT_KEY_VISUAL_PALETTE.foreground).toBe(
      DARK_KEY_VISUAL_PALETTE.foreground,
    );
    expect(LIGHT_KEY_VISUAL_PALETTE.stateSurface.running).toBe(
      DARK_KEY_VISUAL_PALETTE.stateSurface.running,
    );
    expect(LIGHT_KEY_VISUAL_PALETTE.emptySurface).toBe("#e2e8f0");
    expect(LIGHT_KEY_VISUAL_PALETTE.emptyCharacter).toBe("#cbd5e1");
    expect(LIGHT_KEY_VISUAL_PALETTE.newAgentSurface).toBe("#e2e8f0");
    expect(LIGHT_KEY_VISUAL_PALETTE.newAgentCharacter).toBe("#64748b");
    expect(LIGHT_KEY_VISUAL_PALETTE.providerTileSurface).toBe("#ffffff");
    expect(LIGHT_KEY_VISUAL_PALETTE.providerForeground).toBe("#0f172a");
  });
});
