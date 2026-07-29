const FONT_SIZE = 18;
const LABEL_CENTRE_X = 72;
const LABEL_VIEWPORT_X = 13;
const LABEL_VIEWPORT_WIDTH = 118;
const LABEL_BASELINE_Y = 25;
const LABEL_GAP = 28;
const LABEL_SCROLL_SPEED = 45;
const LABEL_CACHE_LIMIT = 512;

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

const measureLabelWidth = (value: string): number =>
  Array.from(value).reduce(
    (width, character) => width + characterWidthEm(character) * FONT_SIZE,
    0,
  );

interface LabelMetrics {
  centeredSvg?: string;
  escaped: string;
  width: number;
}

const labelCache = new Map<string, LabelMetrics>();

const labelMetrics = (value: string): LabelMetrics => {
  const cached = labelCache.get(value);
  if (cached) return cached;
  const metrics = {
    escaped: escapeXml(value),
    width: measureLabelWidth(value),
  };
  labelCache.set(value, metrics);
  if (labelCache.size > LABEL_CACHE_LIMIT) {
    const oldest = labelCache.keys().next().value;
    if (oldest !== undefined) labelCache.delete(oldest);
  }
  return metrics;
};

export const agentLabelWidth = (value: string): number =>
  labelMetrics(value).width;

export const agentLabelOverflows = (value: string): boolean =>
  agentLabelWidth(value) > LABEL_VIEWPORT_WIDTH;

export const agentLabelBackgroundSvg = (): string =>
  '<rect x="0" y="7" width="144" height="26" fill="#000" opacity=".34"/>';

const labelText = (value: string, x: number, textLength?: number): string =>
  `<text x="${x.toFixed(2)}" y="${LABEL_BASELINE_Y}" text-anchor="${textLength === undefined ? "middle" : "start"}" font-family="system-ui" font-size="${FONT_SIZE}" font-weight="650" fill="white"${textLength === undefined ? "" : ` textLength="${textLength.toFixed(2)}" lengthAdjust="spacingAndGlyphs"`}>${labelMetrics(value).escaped}</text>`;

export const agentLabelSvg = (
  value: string,
  animationElapsedMs: number,
): string => {
  const metrics = labelMetrics(value);
  const { width } = metrics;
  if (width <= LABEL_VIEWPORT_WIDTH) {
    metrics.centeredSvg ??= labelText(value, LABEL_CENTRE_X);
    return metrics.centeredSvg;
  }

  const cycleWidth = width + LABEL_GAP;
  const travelled = (animationElapsedMs * LABEL_SCROLL_SPEED) / 1_000;
  const offset = ((travelled % cycleWidth) + cycleWidth) % cycleWidth;
  const firstX = LABEL_VIEWPORT_X - offset;

  return `<defs>
        <clipPath id="agent-label-clip">
          <rect x="${LABEL_VIEWPORT_X}" y="8" width="${LABEL_VIEWPORT_WIDTH}" height="24"/>
        </clipPath>
      </defs>
      <g clip-path="url(#agent-label-clip)">
        ${labelText(value, firstX, width)}
        ${labelText(value, firstX + cycleWidth, width)}
      </g>`;
};
