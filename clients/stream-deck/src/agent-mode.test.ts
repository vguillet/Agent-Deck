import { describe, expect, it } from "vitest";
import { agentModeStyle } from "./agent-mode.js";

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
    ).toEqual({ colour: "#3fa266", icon: "ask" });
  });

  it("does not treat legacy Cursor metadata as provider-neutral", () => {
    expect(
      agentModeStyle({
        providerId: "codex",
        metadata: { cursorMode: "plan" },
      }),
    ).toBeUndefined();
  });
});
