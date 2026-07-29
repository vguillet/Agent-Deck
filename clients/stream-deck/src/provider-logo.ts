interface ProviderLogoOptions {
  x: number;
  y: number;
  size: number;
  mark: string;
  ring?: string;
}

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const cursorLogo = `<rect width="41" height="41" rx="10" fill="#11100d"/>
  <path d="M20.5 5 35 13.5V30L20.5 38.5 6 30V13.5L20.5 5Z" fill="#4c4b47"/>
  <path d="M8 14.5H33L20.5 22.5 8 14.5Z" fill="white"/>
  <path d="M33 14.5 20.5 36V22.5L33 14.5Z" fill="#d5d4d1"/>
  <path d="M6 30V13.5l14.5 9L6 30Z" fill="#5f5e5a"/>
  <path d="m6 30 14.5-7.5v16L6 30Z" fill="#85847f"/>`;

const openAiLogoSource = `<rect width="41" height="41" rx="10" fill="#11100d"/>
  <g transform="translate(6 6) scale(.18)">
    <path d="M60.87 57.26V42.31c0-1.26.47-2.2 1.57-2.83l30.05-17.3c4.09-2.36 8.97-3.46 14-3.46 18.88 0 30.83 14.63 30.83 30.2 0 1.1 0 2.36-.16 3.62l-31.14-18.25c-1.89-1.1-3.78-1.1-5.66 0L60.87 57.26Zm70.16 58.2V79.75c0-2.2-.94-3.78-2.83-4.88L88.71 51.91l12.9-7.39c1.1-.63 2.05-.63 3.15 0l30.04 17.3c8.65 5.03 14.47 15.73 14.47 26.11 0 11.95-7.08 22.97-18.24 27.53ZM51.59 84 38.7 76.45c-1.1-.63-1.58-1.58-1.58-2.84v-34.6c0-16.83 12.9-29.57 30.36-29.57 6.61 0 12.74 2.2 17.93 6.13L54.43 33.5c-1.89 1.1-2.83 2.67-2.83 4.88V84Zm27.77 16.04L60.87 89.66V67.64l18.49-10.38 18.48 10.38v22.02l-18.48 10.38Zm11.87 47.82c-6.61 0-12.74-2.2-17.93-6.13l30.99-17.94c1.89-1.1 2.83-2.67 2.83-4.88V73.3l13.05 7.55c1.1.63 1.58 2.83 1.58 2.83v34.61c0 16.83-13.06 29.57-30.52 29.57Zm-37.28-35.08L23.91 95.48c-8.65-5.03-14.47-15.73-14.47-26.11 0-12.11 7.24-22.97 18.4-27.53v35.87c0 2.2.94 3.77 2.83 4.87L70 105.39l-12.9 7.39c-1.1.63-2.05.63-3.15 0Zm-1.73 25.8c-17.77 0-30.83-13.37-30.83-29.89 0-1.26.16-2.52.32-3.77l30.98 17.93c1.89 1.1 3.78 1.1 5.67 0l39.48-22.81v14.95c0 1.26-.47 2.2-1.58 2.83l-30.04 17.3c-4.09 2.36-8.97 3.46-14 3.46Z" fill="white"/>
  </g>`;

const openAiLogo = openAiLogoSource.replace(
  "c1.1.63 1.58 2.83 1.58 2.83v",
  "c1.1-.63 1.58-1.57 1.58-2.83v",
);

export const providerLogoSvg = (
  providerId: string,
  options: ProviderLogoOptions,
): string => {
  const id = providerId.toLowerCase();
  let artwork: string;
  if (id.includes("cursor")) artwork = cursorLogo;
  else if (
    id.includes("codex") ||
    id.includes("openai") ||
    id.includes("chatgpt")
  )
    artwork = openAiLogo;
  else
    artwork = `<circle cx="20.5" cy="20.5" r="17" fill="#000" opacity=".3"/>
      <text x="20.5" y="25.5" text-anchor="middle" font-family="system-ui" font-size="12" font-weight="800" fill="white">${escapeXml(options.mark)}</text>`;

  const ring = options.ring
    ? `<rect x="2" y="2" width="37" height="37" rx="9" fill="none" stroke="${options.ring}" stroke-width="4"/>`
    : "";
  return `<g transform="translate(${options.x.toFixed(2)} ${options.y.toFixed(2)}) scale(${(options.size / 41).toFixed(4)})">
    ${artwork}
    ${ring}
  </g>`;
};
