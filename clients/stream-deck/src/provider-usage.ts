import type { ProviderUsage, ProviderUsageWindow } from "@agent-deck/domain";
import type { KeyVisualPalette } from "./agent-palette.js";
import { providerLogoSvg } from "./provider-logo.js";

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export const usageColour = (usedPercent: number): string => {
  if (usedPercent >= 100) return "#dc2626";
  if (usedPercent >= 90) return "#f97316";
  if (usedPercent >= 70) return "#eab308";
  return "#22c55e";
};

export const providerUsageAfterFailure = (
  previous: ProviderUsage | undefined,
  providerId: string,
  error: unknown,
  observedAt = new Date().toISOString(),
): ProviderUsage => {
  const message = error instanceof Error ? error.message : String(error);
  return previous?.status === "available"
    ? { ...previous, stale: true, message }
    : { providerId, status: "unavailable", windows: [], observedAt, message };
};

export const usageResetLabel = (
  window: ProviderUsageWindow | undefined,
  now: number,
): string => {
  if (!window?.resetsAt) return "";
  const remaining = Date.parse(window.resetsAt) - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return "resets soon";
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return `resets ${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `resets ${hours}h`;
  return `resets ${Math.ceil(hours / 24)}d`;
};

const statusLabel = (status: ProviderUsage["status"]): string => {
  if (status === "login_required") return "Login Required";
  if (status === "rate_limited") return "Rate Limited";
  if (status === "unavailable") return "Unavailable";
  return "Error";
};

export const soonestUsageReset = (
  usage: ProviderUsage,
): ProviderUsageWindow | undefined =>
  usage.windows
    .filter(
      (window) =>
        window.available !== false &&
        window.resetsAt !== undefined &&
        Number.isFinite(Date.parse(window.resetsAt)),
    )
    .sort(
      (left, right) => Date.parse(left.resetsAt!) - Date.parse(right.resetsAt!),
    )[0];

export const usageResetDaysLabel = (
  resetsAt: string | undefined,
  now: number,
): string => {
  if (!resetsAt) return "Reset unavailable";
  const remaining = Date.parse(resetsAt) - now;
  if (!Number.isFinite(remaining)) return "Reset unavailable";
  if (remaining <= 0 || remaining < 86_400_000) return "<1 day remaining";
  const days = Math.ceil(remaining / 86_400_000);
  return `${days} ${days === 1 ? "day" : "days"} remaining`;
};

export const usageResetDateLabel = (resetsAt: string | undefined): string => {
  if (!resetsAt || !Number.isFinite(Date.parse(resetsAt))) return "No date";
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(resetsAt));
};

const usageProviderLogo = (
  usage: ProviderUsage,
  palette: KeyVisualPalette,
): string =>
  providerLogoSvg(
    usage.providerId,
    {
      x: 51.5,
      y: 3,
      size: 41,
      mark: usage.providerId === "cursor-local" ? "CU" : "AI",
    },
    palette,
  );

const mutedLogo = (logo: string, muted: boolean): string =>
  muted ? `<g filter="url(#usage-muted-logo)" opacity=".62">${logo}</g>` : logo;

export const providerUsageImage = (
  usage: ProviderUsage,
  palette: KeyVisualPalette,
  _now = Date.now(),
  muted = false,
): string => {
  const background = muted
    ? "#334155"
    : palette.id === "light"
      ? "#e2e8f0"
      : "#0f172a";
  const foreground = muted
    ? "#cbd5e1"
    : palette.id === "light"
      ? "#0f172a"
      : "#f8fafc";
  const track = muted
    ? "#475569"
    : palette.id === "light"
      ? "#cbd5e1"
      : "#334155";
  const rows = usage.windows.slice(0, 2).map((window, index) => {
    const y = 57 + index * 40;
    const available = window.available !== false;
    const width = Math.round(
      (available ? Math.min(100, Math.max(0, window.usedPercent)) : 0) * 1.12,
    );
    return `
      <text x="16" y="${y}" font-family="system-ui" font-size="13" font-weight="700" fill="${foreground}">${escapeXml(window.label)}</text>
      <text x="128" y="${y}" text-anchor="end" font-family="system-ui" font-size="13" font-weight="800" fill="${foreground}">${available ? `${Math.round(window.usedPercent)}%` : "—"}</text>
      <rect x="16" y="${y + 8}" width="112" height="12" rx="6" fill="${track}"/>
      <rect x="16" y="${y + 8}" width="${width}" height="12" rx="6" fill="${muted ? "#94a3b8" : usageColour(window.usedPercent)}"/>`;
  });
  const body =
    usage.status === "available" && rows.length
      ? rows.join("")
      : `<text x="72" y="77" text-anchor="middle" font-family="system-ui" font-size="16" font-weight="800" fill="${foreground}">${statusLabel(usage.status)}</text>`;
  const providerLogo = usageProviderLogo(usage, palette);
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
      ${
        muted
          ? `<defs><filter id="usage-muted-logo"><feColorMatrix type="saturate" values="0"/></filter></defs>`
          : ""
      }
      <rect width="144" height="144" rx="14" fill="${background}"/>
      ${mutedLogo(providerLogo, muted)}
      ${usage.stale ? `<circle cx="130" cy="22" r="4" fill="#eab308"/>` : ""}
      ${body}
    </svg>`,
  )}`;
};

export const providerUsageResetImage = (
  usage: ProviderUsage,
  palette: KeyVisualPalette,
  now = Date.now(),
  muted = false,
): string => {
  const background = muted
    ? "#334155"
    : palette.id === "light"
      ? "#e2e8f0"
      : "#0f172a";
  const foreground = muted
    ? "#cbd5e1"
    : palette.id === "light"
      ? "#0f172a"
      : "#f8fafc";
  const reset = soonestUsageReset(usage);
  const hasReset = reset?.resetsAt !== undefined;
  const date = usageResetDateLabel(reset?.resetsAt);
  const remaining = usageResetDaysLabel(reset?.resetsAt, now);
  const body =
    usage.status === "available"
      ? `<text x="72" y="72" text-anchor="middle" font-family="system-ui" font-size="16" font-weight="800" fill="${foreground}">${escapeXml(date)}</text>
         <text x="72" y="96" text-anchor="middle" font-family="system-ui" font-size="12" font-weight="700" fill="${foreground}" opacity=".78">${escapeXml(remaining)}</text>
         ${hasReset ? `<text x="72" y="116" text-anchor="middle" font-family="system-ui" font-size="10" font-weight="600" fill="${foreground}" opacity=".55">${escapeXml(reset.label)} reset</text>` : ""}`
      : `<text x="72" y="83" text-anchor="middle" font-family="system-ui" font-size="16" font-weight="800" fill="${foreground}">${statusLabel(usage.status)}</text>`;
  const providerLogo = usageProviderLogo(usage, palette);
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
      ${
        muted
          ? `<defs><filter id="usage-muted-logo"><feColorMatrix type="saturate" values="0"/></filter></defs>`
          : ""
      }
      <rect width="144" height="144" rx="14" fill="${background}"/>
      ${mutedLogo(providerLogo, muted)}
      ${usage.stale ? `<circle cx="130" cy="22" r="4" fill="#eab308"/>` : ""}
      ${body}
    </svg>`,
  )}`;
};
