export const subagentBackgroundSvg = (): string => `
  <defs>
    <pattern id="subagent-stripes" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="6" height="14" fill="#ffffff" opacity=".16"/>
    </pattern>
  </defs>
  <rect width="144" height="144" fill="url(#subagent-stripes)" pointer-events="none"/>`;
