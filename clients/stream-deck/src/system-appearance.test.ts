import { describe, expect, it } from "vitest";
import {
  parseAppleInterfaceStyle,
  resolveSystemAppearance,
  systemAppearanceChanged,
} from "./system-appearance.js";

describe("macOS system appearance", () => {
  it("parses dark and light Apple interface styles", () => {
    expect(
      parseAppleInterfaceStyle({ stdout: "Dark\n", stderr: "", exitCode: 0 }),
    ).toBe("dark");
    expect(
      parseAppleInterfaceStyle({ stdout: "Light\n", stderr: "", exitCode: 0 }),
    ).toBe("light");
  });

  it("treats the absent AppleInterfaceStyle preference as light", () => {
    expect(
      parseAppleInterfaceStyle({
        stdout: "",
        stderr:
          "The domain/default pair of (kCFPreferencesAnyApplication, AppleInterfaceStyle) does not exist",
        exitCode: 1,
      }),
    ).toBe("light");
  });

  it("falls back safely to dark on unexpected detection failures", async () => {
    expect(
      parseAppleInterfaceStyle({
        stdout: "",
        stderr: "permission denied",
        exitCode: 1,
      }),
    ).toBe("dark");
    expect(
      await resolveSystemAppearance(async () => {
        throw new Error("unavailable");
      }),
    ).toBe("dark");
  });

  it("does not report a change when the resolved appearance is unchanged", () => {
    expect(systemAppearanceChanged("dark", "dark")).toBe(false);
    expect(systemAppearanceChanged("light", "light")).toBe(false);
    expect(systemAppearanceChanged("dark", "light")).toBe(true);
  });
});
