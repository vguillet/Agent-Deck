import { describe, expect, it } from "vitest";
import { parseCursorUsageResponse } from "./cursor-usage.js";

describe("parseCursorUsageResponse", () => {
  it("maps Cursor and API monthly pools", () => {
    expect(
      parseCursorUsageResponse(
        {
          billingCycleEnd: "2026-09-01T00:00:00.000Z",
          planUsage: {
            autoPercentUsed: 25.5,
            apiPercentUsed: 82,
          },
        },
        "2026-08-01T18:00:00.000Z",
      ),
    ).toEqual({
      providerId: "cursor-local",
      status: "available",
      windows: [
        {
          id: "cursor-models",
          label: "Cursor",
          usedPercent: 25.5,
          resetsAt: "2026-09-01T00:00:00.000Z",
        },
        {
          id: "api-models",
          label: "API",
          usedPercent: 82,
          resetsAt: "2026-09-01T00:00:00.000Z",
        },
      ],
      observedAt: "2026-08-01T18:00:00.000Z",
    });
  });

  it("does not accept partial pool data", () => {
    expect(
      parseCursorUsageResponse(
        { planUsage: { apiPercentUsed: 20 } },
        "2026-08-01T18:00:00.000Z",
      ).status,
    ).toBe("unavailable");
  });
});
