import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { ProviderUsage } from "@agent-deck/domain";

const CursorUsageResponseSchema = z
  .object({
    billingCycleEnd: z.union([z.string(), z.number()]).nullish(),
    planUsage: z
      .object({
        autoPercentUsed: z.number().finite().nullish(),
        apiPercentUsed: z.number().finite().nullish(),
      })
      .nullish(),
  })
  .passthrough();

const percentage = (value: number): number => Math.min(100, Math.max(0, value));

const resetTimestamp = (
  value: string | number | null | undefined,
): string | undefined => {
  if (value === null || value === undefined) return undefined;
  const numeric = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(numeric)) {
    const milliseconds = numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
    return new Date(milliseconds).toISOString();
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
};

export const parseCursorUsageResponse = (
  input: unknown,
  observedAt: string,
): ProviderUsage => {
  const parsed = CursorUsageResponseSchema.safeParse(input);
  const data = parsed.success ? parsed.data : undefined;
  const plan = data?.planUsage;
  if (
    !plan ||
    typeof plan.autoPercentUsed !== "number" ||
    typeof plan.apiPercentUsed !== "number"
  )
    return {
      providerId: "cursor-local",
      status: "unavailable",
      windows: [],
      observedAt,
      message: "Cursor usage pools are unavailable",
    };
  const resetsAt = resetTimestamp(data?.billingCycleEnd);
  return {
    providerId: "cursor-local",
    status: "available",
    windows: [
      {
        id: "cursor-models",
        label: "Cursor",
        usedPercent: percentage(plan.autoPercentUsed),
        ...(resetsAt ? { resetsAt } : {}),
      },
      {
        id: "api-models",
        label: "API",
        usedPercent: percentage(plan.apiPercentUsed),
        ...(resetsAt ? { resetsAt } : {}),
      },
    ],
    observedAt,
  };
};

const accessToken = (databasePath: string): string | undefined => {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const row = database
      .prepare("SELECT value FROM ItemTable WHERE key = ?")
      .get("cursorAuth/accessToken") as { value?: unknown } | undefined;
    return typeof row?.value === "string" && row.value.trim()
      ? row.value.trim()
      : undefined;
  } catch {
    return undefined;
  } finally {
    database?.close();
  }
};

export const fetchCursorUsage = async (
  databasePath: string,
  observedAt: string,
): Promise<ProviderUsage> => {
  const token = accessToken(databasePath);
  if (!token)
    return {
      providerId: "cursor-local",
      status: "login_required",
      windows: [],
      observedAt,
      message: "Sign in to Cursor to view usage",
    };
  try {
    const response = await fetch(
      "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "connect-protocol-version": "1",
        },
        body: "{}",
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (response.status === 401 || response.status === 403)
      return {
        providerId: "cursor-local",
        status: "login_required",
        windows: [],
        observedAt,
        message: "Cursor login has expired",
      };
    if (response.status === 429)
      return {
        providerId: "cursor-local",
        status: "rate_limited",
        windows: [],
        observedAt,
        message: "Cursor usage is rate limited",
      };
    if (!response.ok)
      return {
        providerId: "cursor-local",
        status: "error",
        windows: [],
        observedAt,
        message: `Cursor usage request failed (${response.status})`,
      };
    return parseCursorUsageResponse(await response.json(), observedAt);
  } catch {
    return {
      providerId: "cursor-local",
      status: "error",
      windows: [],
      observedAt,
      message: "Cursor usage request failed",
    };
  }
};
