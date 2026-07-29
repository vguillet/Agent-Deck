const FONT_SIZE = 13;
const LABEL_CENTRE_X = 72;
const LABEL_VIEWPORT_X = 13;
const LABEL_VIEWPORT_WIDTH = 118;
const LABEL_BASELINE_Y = 129;
const LABEL_GAP = 28;
const LABEL_SCROLL_SPEED = 24;

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const characterWidthEm = (character: string): number => {
  if (/\p{Mark}/u.test(character)) return 0;
  if (/\s/u.test(character)) return 0.34;
  if (/[ilI1.,'`:;!|]/u.test(character)) return 0.32;
  if (/[mwMW@#%&]/u.test(character)) return 0.88;
  if (/[A-Z]/u.test(character)) return 0.69;
  if (/[0-9]/u.test(character)) return 0.62;
  if (/[a-z]/u.test(character)) return 0.57;
  if (/[-_()[\]{}+/\\]/u.test(character)) return 0.48;
  return 1;
};

export const agentLabelWidth = (value: string): number =>
  Array.from(value).reduce(
    (width, character) => width + characterWidthEm(character) * FONT_SIZE,
    0,
  );

export const agentLabelOverflows = (value: string): boolean =>
  agentLabelWidth(value) > LABEL_VIEWPORT_WIDTH;

const labelText = (value: string, x: number, textLength?: number): string =>
  `<text x="${x.toFixed(2)}" y="${LABEL_BASELINE_Y}" text-anchor="${textLength === undefined ? "middle" : "start"}" font-family="system-ui" font-size="${FONT_SIZE}" font-weight="650" fill="white"${textLength === undefined ? "" : ` textLength="${textLength.toFixed(2)}" lengthAdjust="spacingAndGlyphs"`}>${escapeXml(value)}</text>`;

export const agentLabelSvg = (
  value: string,
  animationElapsedMs: number,
): string => {
  const width = agentLabelWidth(value);
  if (width <= LABEL_VIEWPORT_WIDTH) return labelText(value, LABEL_CENTRE_X);

  const cycleWidth = width + LABEL_GAP;
  const travelled = (animationElapsedMs * LABEL_SCROLL_SPEED) / 1_000;
  const offset = ((travelled % cycleWidth) + cycleWidth) % cycleWidth;
  const firstX = LABEL_VIEWPORT_X - offset;

  return `<defs>
        <clipPath id="agent-label-clip">
          <rect x="${LABEL_VIEWPORT_X}" y="112" width="${LABEL_VIEWPORT_WIDTH}" height="24"/>
        </clipPath>
      </defs>
      <g clip-path="url(#agent-label-clip)">
        ${labelText(value, firstX, width)}
        ${labelText(value, firstX + cycleWidth, width)}
      </g>`;
};
