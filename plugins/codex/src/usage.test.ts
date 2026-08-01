import { describe, expect, it } from "vitest";
import { parseCodexUsage } from "./index.js";

describe("parseCodexUsage", () => {
  it("maps and clamps the primary and secondary limits", () => {
    expect(
      parseCodexUsage(
        {
          rateLimits: {
            primary: {
              usedPercent: 42,
              windowDurationMins: 300,
              resetsAt: 1_800_000_000,
            },
            secondary: {
              usedPercent: 105,
              windowDurationMins: 10_080,
              resetsAt: "2027-01-01T00:00:00Z",
            },
          },
        },
        "2026-08-01T18:00:00.000Z",
      ),
    ).toMatchObject({
      status: "available",
      windows: [
        { id: "five-hour", label: "5h", usedPercent: 42 },
        { id: "weekly", label: "Week", usedPercent: 100 },
      ],
    });
  });

  it("uses duration to place a lone weekly limit in the second bar", () => {
    expect(
      parseCodexUsage(
        {
          rateLimits: {
            primary: {
              usedPercent: 18,
              windowDurationMins: 10_080,
              resetsAt: 1_800_000_000,
            },
            secondary: null,
          },
        },
        "2026-08-01T18:00:00.000Z",
      ).windows,
    ).toEqual([
      {
        id: "five-hour",
        label: "5h",
        usedPercent: 0,
        available: false,
      },
      {
        id: "weekly",
        label: "Week",
        usedPercent: 18,
        available: true,
        resetsAt: "2027-01-15T08:00:00.000Z",
      },
    ]);
  });

  it("reports unsupported response shapes as unavailable", () => {
    expect(parseCodexUsage({}, "2026-08-01T18:00:00.000Z")).toMatchObject({
      status: "unavailable",
      windows: [],
    });
  });
});
