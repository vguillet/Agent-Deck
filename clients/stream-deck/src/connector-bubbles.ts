import { providerLogoSvg } from "./provider-logo.js";

const BUBBLE_DIAMETER = 28;
const BUBBLE_GAP = 8;
const LOOP_GAP = 12;
const VIEWPORT_X = 8;
const VIEWPORT_WIDTH = 128;
const CENTRE_X = 72;
const CENTRE_Y = 121;
const SCROLL_SPEED = 24;

export interface ConnectorBubble {
  id: string;
  mark: string;
  healthy: boolean;
}

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export const connectorBubblesWidth = (
  connectors: readonly ConnectorBubble[],
): number =>
  connectors.length
    ? connectors.length * BUBBLE_DIAMETER + (connectors.length - 1) * BUBBLE_GAP
    : 0;

export const connectorBubblesOverflow = (
  connectors: readonly ConnectorBubble[],
): boolean => connectorBubblesWidth(connectors) > VIEWPORT_WIDTH;

const bubbleGroup = (
  connectors: readonly ConnectorBubble[],
  startX: number,
): string =>
  connectors
    .map((connector, index) => {
      const centreX =
        startX + BUBBLE_DIAMETER / 2 + index * (BUBBLE_DIAMETER + BUBBLE_GAP);
      const ring = connector.healthy ? "#22c55e" : "#ef4444";
      return `<g data-connector="${escapeXml(connector.id)}">
        ${providerLogoSvg(connector.id, {
          x: centreX - BUBBLE_DIAMETER / 2,
          y: CENTRE_Y - BUBBLE_DIAMETER / 2,
          size: BUBBLE_DIAMETER,
          mark: connector.mark,
          ring,
        })}
      </g>`;
    })
    .join("");

export const connectorBubblesSvg = (
  connectors: readonly ConnectorBubble[],
  animationElapsedMs: number,
): string => {
  const width = connectorBubblesWidth(connectors);
  if (!width) return "";
  if (width <= VIEWPORT_WIDTH)
    return bubbleGroup(connectors, CENTRE_X - width / 2);

  const cycleWidth = width + LOOP_GAP;
  const travelled = (animationElapsedMs * SCROLL_SPEED) / 1_000;
  const offset = ((travelled % cycleWidth) + cycleWidth) % cycleWidth;
  const firstX = VIEWPORT_X - offset;

  return `<defs>
      <clipPath id="connector-bubbles-clip">
        <rect x="${VIEWPORT_X}" y="106" width="${VIEWPORT_WIDTH}" height="31"/>
      </clipPath>
    </defs>
    <g clip-path="url(#connector-bubbles-clip)">
      ${bubbleGroup(connectors, firstX)}
      ${bubbleGroup(connectors, firstX + cycleWidth)}
    </g>`;
};
