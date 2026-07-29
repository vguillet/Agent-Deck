import { describe, expect, it } from "vitest";
import { agentModeFrameSvg, agentModeStyle } from "./agent-mode.js";

describe("agentModeStyle", () => {
  it("renders provider-neutral Codex plan metadata", () => {
    expect(
      agentModeStyle({
        providerId: "codex",
        metadata: { agentMode: "plan" },
      }),
    ).toEqual({ colour: "#f1b467", icon: "plan" });
  });

  it("keeps compatibility with Cursor mode metadata", () => {
    expect(
      agentModeStyle({
        providerId: "cursor-local",
        metadata: { cursorMode: "ask" },
      }),
    ).toEqual({
      colour: "#3fa266",
      frameColour: "#1c492e",
      icon: "ask",
    });
  });

  it("does not treat legacy Cursor metadata as provider-neutral", () => {
    expect(
      agentModeStyle({
        providerId: "codex",
        metadata: { cursorMode: "plan" },
      }),
    ).toBeUndefined();
  });

  it("renders the mode frame across every outer edge", () => {
    expect(agentModeFrameSvg({ colour: "#f1b467", icon: "plan" })).toBe(
      '<path d="M0 0H144V144H0Z M7 7H137V137H7Z" fill="#f1b467" fill-rule="evenodd"/>',
    );
  });

  it("uses the darker badge green for the ask mode frame", () => {
    expect(
      agentModeFrameSvg({
        colour: "#3fa266",
        frameColour: "#1c492e",
        icon: "ask",
      }),
    ).toContain('fill="#1c492e"');
  });
});
