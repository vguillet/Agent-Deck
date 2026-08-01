import { describe, expect, it } from "vitest";
import { DARK_KEY_VISUAL_PALETTE } from "./agent-palette.js";
import {
  providerUsageImage,
  providerUsageAfterFailure,
  providerUsageResetImage,
  soonestUsageReset,
  usageColour,
  usageResetDateLabel,
  usageResetDaysLabel,
  usageResetLabel,
} from "./provider-usage.js";

describe("provider usage key", () => {
  it("retains the last successful values as stale after a refresh failure", () => {
    expect(
      providerUsageAfterFailure(
        {
          providerId: "codex",
          status: "available",
          windows: [{ id: "weekly", label: "Week", usedPercent: 42 }],
          observedAt: "2026-08-01T18:00:00.000Z",
        },
        "codex",
        new Error("Offline"),
      ),
    ).toMatchObject({
      status: "available",
      stale: true,
      message: "Offline",
      windows: [{ usedPercent: 42 }],
    });
  });

  it("uses the documented warning thresholds", () => {
    expect([69, 70, 90, 100].map(usageColour)).toEqual([
      "#22c55e",
      "#eab308",
      "#f97316",
      "#dc2626",
    ]);
  });

  it("renders both lowered usage rows without redundant reset text", () => {
    const image = decodeURIComponent(
      providerUsageImage(
        {
          providerId: "codex",
          status: "available",
          windows: [
            {
              id: "primary",
              label: "5h",
              usedPercent: 42,
              resetsAt: "2026-08-01T20:00:00.000Z",
            },
            { id: "secondary", label: "Week", usedPercent: 91 },
          ],
          observedAt: "2026-08-01T18:00:00.000Z",
          stale: true,
        },
        DARK_KEY_VISUAL_PALETTE,
        Date.parse("2026-08-01T18:00:00.000Z"),
      ),
    );
    expect(image).toContain(">5h</text>");
    expect(image).toContain(">Week</text>");
    expect(image).toContain('transform="translate(51.50 3.00) scale(1.0000)"');
    expect(image).not.toContain(">Codex</text>");
    expect(image).not.toContain('height="5"');
    expect(image).toContain('x="16" y="57"');
    expect(image).toContain('x="16" y="97"');
    expect(image).not.toContain("resets 2h");
    expect(image).toContain('<circle cx="130"');
  });

  it("formats short and long reset countdowns", () => {
    const now = Date.parse("2026-08-01T18:00:00.000Z");
    expect(
      usageResetLabel(
        {
          id: "primary",
          label: "5h",
          usedPercent: 1,
          resetsAt: "2026-08-01T18:30:00.000Z",
        },
        now,
      ),
    ).toBe("resets 30m");
  });

  it("renders a neutral disconnected state before bring-up", () => {
    const image = decodeURIComponent(
      providerUsageImage(
        {
          providerId: "codex",
          status: "available",
          windows: [{ id: "weekly", label: "Week", usedPercent: 42 }],
          observedAt: "2026-08-01T18:00:00.000Z",
        },
        DARK_KEY_VISUAL_PALETTE,
        Date.parse("2026-08-01T18:00:00.000Z"),
        true,
      ),
    );
    expect(image).toContain('fill="#334155"');
    expect(image).toContain('fill="#94a3b8"');
    expect(image).not.toContain("#22c55e");
  });

  it("selects the soonest available reset", () => {
    expect(
      soonestUsageReset({
        providerId: "codex",
        status: "available",
        windows: [
          {
            id: "weekly",
            label: "Week",
            usedPercent: 20,
            resetsAt: "2026-08-08T18:00:00.000Z",
          },
          {
            id: "five-hour",
            label: "5h",
            usedPercent: 40,
            resetsAt: "2026-08-01T21:00:00.000Z",
          },
          {
            id: "missing",
            label: "Missing",
            usedPercent: 0,
            available: false,
            resetsAt: "2026-08-01T19:00:00.000Z",
          },
        ],
        observedAt: "2026-08-01T18:00:00.000Z",
      })?.id,
    ).toBe("five-hour");
  });

  it("renders the reset date and whole days remaining", () => {
    const resetsAt = "2026-08-04T18:00:00.000Z";
    const now = Date.parse("2026-08-01T18:00:00.000Z");
    const expectedDate = usageResetDateLabel(resetsAt);
    const image = decodeURIComponent(
      providerUsageResetImage(
        {
          providerId: "cursor-local",
          status: "available",
          windows: [
            {
              id: "monthly",
              label: "Month",
              usedPercent: 30,
              resetsAt,
            },
          ],
          observedAt: "2026-08-01T18:00:00.000Z",
        },
        DARK_KEY_VISUAL_PALETTE,
        now,
      ),
    );

    expect(usageResetDaysLabel(resetsAt, now)).toBe("3 days remaining");
    expect(image).toContain(`>${expectedDate}</text>`);
    expect(image).toContain(">3 days remaining</text>");
    expect(image).toContain(">Month reset</text>");
  });

  it("uses a sub-day label and handles missing reset data", () => {
    const now = Date.parse("2026-08-01T18:00:00.000Z");
    expect(usageResetDaysLabel("2026-08-01T20:00:00.000Z", now)).toBe(
      "<1 day remaining",
    );
    expect(usageResetDaysLabel(undefined, now)).toBe("Reset unavailable");
    expect(usageResetDateLabel(undefined)).toBe("No date");
  });
});
