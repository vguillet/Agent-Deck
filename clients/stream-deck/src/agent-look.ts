import type { AgentState } from "@agent-deck/domain";
import {
  DARK_KEY_VISUAL_PALETTE,
  type KeyVisualPalette,
} from "./agent-palette.js";

export type AgentKeyLook = "classic" | "agent";

const FLAT_WHITE = "currentColor";
export const REMOVED_AGENT_ANIMATION_MS = 800;

const hash = (value: string): number => {
  let result = 2_166_136_261;
  for (const character of value) {
    result ^= character.codePointAt(0) ?? 0;
    result = Math.imul(result, 16_777_619);
  }
  return result >>> 0;
};

export const normalizeAgentKeyLook = (value: unknown): AgentKeyLook =>
  value === "agent" ? "agent" : "classic";

export const agentSceneVariant = (
  seed: string,
  state: AgentState | "empty",
): 0 | 1 => (hash(`${seed}:${state}`) % 2) as 0 | 1;

const animation = (elapsedMs: number, periodMs: number): number =>
  ((elapsedMs % periodMs) / periodMs) * Math.PI * 2;

const number = (value: number): string => value.toFixed(2);

const blinkOpacity = (elapsedMs: number): string =>
  number(elapsedMs % 1_000 < 600 ? 1 : 0.12);

const agent = ({
  x = 72,
  y = 58,
  scale = 1,
  rotation = 0,
  headX = 0,
  headY = 0,
  leftArm = "rest",
  rightArm = "rest",
}: {
  x?: number;
  y?: number;
  scale?: number;
  rotation?: number;
  headX?: number;
  headY?: number;
  leftArm?: "rest" | "forward" | "raised" | "side";
  rightArm?: "rest" | "forward" | "raised" | "side";
}): string => {
  const arm = (
    side: "left" | "right",
    pose: "rest" | "forward" | "raised" | "side",
  ): string => {
    const direction = side === "left" ? -1 : 1;
    const shoulderX = 72 + direction * 15;
    const paths = {
      rest: `M${shoulderX} 69 Q${72 + direction * 24} 79 ${72 + direction * 22} 91`,
      forward: `M${shoulderX} 70 Q${72 + direction * 20} 74 ${72 + direction * 29} 67`,
      raised: `M${shoulderX} 70 Q${72 + direction * 25} 58 ${72 + direction * 22} 42`,
      side: `M${shoulderX} 70 Q${72 + direction * 27} 68 ${72 + direction * 31} 76`,
    };
    return `<path d="${paths[pose]}" fill="none" stroke="${FLAT_WHITE}" stroke-width="10" stroke-linecap="round"/>`;
  };

  return `<g transform="translate(${number(x - 72)} ${number(y - 58)}) rotate(${number(rotation)} 72 70) scale(${number(scale)} ${number(scale)})">
    ${arm("left", leftArm)}
    ${arm("right", rightArm)}
    <rect x="55" y="61" width="34" height="35" rx="15" fill="${FLAT_WHITE}"/>
    <rect x="58" y="87" width="13" height="20" rx="6.5" fill="${FLAT_WHITE}"/>
    <rect x="73" y="87" width="13" height="20" rx="6.5" fill="${FLAT_WHITE}"/>
    <circle cx="${number(72 + headX)}" cy="${number(47 + headY)}" r="19" fill="${FLAT_WHITE}"/>
  </g>`;
};

const gear = (
  x: number,
  y: number,
  rotation: number,
  accent: string,
  broken = false,
): string => {
  const teeth = Array.from({ length: broken ? 6 : 8 }, (_, index) => {
    const angle = index * (360 / 8);
    if (broken && (index === 1 || index === 2)) return "";
    return `<rect x="-3" y="-17" width="6" height="9" rx="1.5" fill="${accent}" transform="rotate(${angle})"/>`;
  }).join("");
  return `<g transform="translate(${x} ${y}) rotate(${number(rotation)})">
    ${teeth}
    <circle r="12" fill="none" stroke="${accent}" stroke-width="3"/>
    <circle r="4.5" fill="${accent}"/>
    ${broken ? `<path d="M-4 -11 L1 -2 L-3 3 L4 11" fill="none" stroke="${accent}" stroke-width="1.6"/>` : ""}
  </g>`;
};

const questionBubble = (
  x: number,
  y: number,
  accent: string,
  scale: number,
): string => `<g transform="translate(${x} ${y}) scale(${number(scale)})">
  <circle r="14" fill="none" stroke="${accent}" stroke-width="2"/>
  <path d="M-4 -4 Q-4 -9 1 -9 Q7 -9 7 -4 Q7 0 2 2 L2 5" fill="none" stroke="${accent}" stroke-width="3" stroke-linecap="round"/>
  <circle cx="2" cy="9" r="1.8" fill="${accent}"/>
  <path d="M-8 11 L-12 17 L-2 13" fill="none" stroke="${accent}" stroke-width="2"/>
</g>`;

const clipboard = (
  x: number,
  y: number,
  accent: string,
  pulse: number,
): string => `<g transform="translate(${x} ${y}) rotate(-5)">
  <rect x="-12" y="-16" width="24" height="31" rx="3" fill="${accent}" fill-opacity=".16" stroke="${accent}" stroke-width="2"/>
  <rect x="-5" y="-19" width="10" height="5" rx="2" fill="${accent}"/>
  <path d="M-7 -6 H7 M-7 0 H4 M-7 6 H7" stroke="${accent}" stroke-width="1.6" stroke-linecap="round"/>
  <circle cx="7" cy="9" r="${number(2.2 + pulse * 1.2)}" fill="${accent}" opacity="${number(0.55 + pulse * 0.35)}"/>
</g>`;

const cube = (
  x: number,
  y: number,
  accent: string,
  scale: number,
): string => `<g transform="translate(${x} ${y}) scale(${number(scale)})">
  <path d="M0 -12 L13 -5 L0 2 L-13 -5 Z" fill="${accent}"/>
  <path d="M-13 -5 L0 2 V16 L-13 9 Z" fill="${accent}" fill-opacity=".72" stroke="${accent}" stroke-width="1"/>
  <path d="M13 -5 L0 2 V16 L13 9 Z" fill="${accent}" fill-opacity=".4" stroke="${accent}" stroke-width="1"/>
</g>`;

const sceneBackground = (background: string): string =>
  `<rect width="144" height="144" fill="${background}"/>`;

const idleScene = (
  variant: 0 | 1,
  elapsedMs: number,
  accent: string,
): string => {
  const phase = animation(elapsedMs, variant === 0 ? 3_600 : 4_800);
  if (variant === 0) {
    const breathe = Math.sin(phase) * 0.8;
    const drift = ((elapsedMs % 2_400) / 2_400) * 9;
    return `${agent({
      y: 59 + breathe,
      rotation: -4,
      headX: -2,
      headY: 2,
    })}
      <g fill="${accent}" font-family="system-ui" font-weight="800" opacity="${number(0.45 + 0.35 * ((Math.sin(phase) + 1) / 2))}">
        <text x="94" y="${number(52 - drift)}" font-size="10">z</text>
        <text x="104" y="${number(42 - drift)}" font-size="14">Z</text>
      </g>`;
  }
  const glance = Math.sin(phase) * 4;
  const pulse = (Math.sin(phase * 2) + 1) / 2;
  return `${agent({
    y: 58 + Math.sin(phase * 2) * 0.6,
    headX: glance,
    rightArm: "raised",
  })}
    <path d="M98 35 L104 30 M101 42 L109 41" stroke="${accent}" stroke-width="2.2" stroke-linecap="round" opacity="${number(0.45 + pulse * 0.45)}"/>`;
};

const runningScene = (
  variant: 0 | 1,
  elapsedMs: number,
  accent: string,
): string => {
  const phase = animation(elapsedMs, 1_000);
  if (variant === 0) {
    const hammerSwing = -28 + ((Math.sin(phase * 2) + 1) / 2) * 72;
    const bounce = Math.abs(Math.sin(phase * 2)) * 2.6;
    return `<g data-motion="frantic-build">
      ${agent({
        x: 52 + Math.sin(phase) * 1.5,
        y: 60 - bounce,
        scale: 0.86,
        rotation: Math.sin(phase * 2) * 4,
        leftArm: "forward",
        rightArm: "forward",
      })}
      ${gear(101, 82, (elapsedMs / 5) % 360, accent)}
      <g transform="translate(80 48) rotate(${number(hammerSwing)} 0 16)">
        <path d="M0 10 V31" stroke="${accent}" stroke-width="4" stroke-linecap="round"/>
        <rect x="-8" y="4" width="16" height="9" rx="2" fill="${accent}"/>
      </g>
      <path d="M82 37 L78 29 M90 36 L91 27 M98 40 L104 33 M113 56 L120 52" stroke="${accent}" stroke-width="2.4" stroke-linecap="round" opacity="${number(0.65 + 0.35 * Math.sin(phase * 2) ** 2)}"/>
      <path d="M31 75 H23 M33 84 H26" stroke="${accent}" stroke-width="2.2" stroke-linecap="round" opacity=".72"/>
    </g>`;
  }
  const penX = Math.sin(phase * 3) * 5;
  const bounce = Math.abs(Math.sin(phase * 2)) * 2;
  const paperLift = ((elapsedMs % 800) / 800) * 14;
  return `<g data-motion="frantic-write">
    ${agent({
      x: 66 + Math.sin(phase * 2) * 1.4,
      y: 51 - bounce,
      scale: 0.86,
      rotation: 3 + Math.sin(phase * 2) * 3.5,
      rightArm: "forward",
    })}
    <g transform="translate(0 ${number(Math.sin(phase * 2) * 1.2)})">
      <rect x="28" y="85" width="88" height="9" rx="3" fill="${accent}"/>
      <rect x="36" y="93" width="5" height="16" rx="2" fill="${accent}" opacity=".65"/>
      <rect x="103" y="93" width="5" height="16" rx="2" fill="${accent}" opacity=".65"/>
      <rect x="73" y="78" width="23" height="10" rx="2" fill="${accent}" opacity=".58"/>
      <path d="M${number(83 + penX)} 76 L${number(89 + penX)} 86" stroke="${accent}" stroke-width="3" stroke-linecap="round"/>
      <path d="M70 74 H61 M99 76 H109" stroke="${accent}" stroke-width="2" stroke-linecap="round" opacity=".8"/>
    </g>
    <g fill="${accent}" opacity=".72">
      <rect x="36" y="${number(59 - paperLift)}" width="13" height="9" rx="1.5" transform="rotate(${number(-12 + Math.sin(phase) * 8)} 42 63)"/>
      <rect x="99" y="${number(51 - ((paperLift + 7) % 14))}" width="12" height="8" rx="1.5" transform="rotate(${number(15 + Math.sin(phase * 1.5) * 10)} 105 55)"/>
    </g>
    <path d="M43 39 L37 32 M50 36 L49 27 M91 37 L96 29" stroke="${accent}" stroke-width="2.4" stroke-linecap="round"/>
  </g>`;
};

const inputScene = (
  variant: 0 | 1,
  elapsedMs: number,
  accent: string,
): string => {
  const phase = animation(elapsedMs, 2_000);
  const pulse = 0.94 + ((Math.sin(phase) + 1) / 2) * 0.1;
  if (variant === 0)
    return `${agent({
      x: 61,
      y: 59 + Math.sin(phase * 2) * 0.6,
      scale: 0.94,
      rightArm: "raised",
    })}
      <g opacity="${blinkOpacity(elapsedMs)}">
        ${questionBubble(103, 44, accent, pulse)}
      </g>`;
  return `${agent({
    x: 48,
    y: 62,
    scale: 0.82,
    leftArm: "forward",
    rightArm: "forward",
  })}
    <g opacity="${blinkOpacity(elapsedMs)}" transform="translate(94 ${number(69 + Math.sin(phase) * 2)})">
      <rect x="-18" y="-20" width="36" height="40" rx="5" fill="${accent}" fill-opacity=".16" stroke="${accent}" stroke-width="2"/>
      <text x="0" y="10" text-anchor="middle" font-family="system-ui" font-size="31" font-weight="800" fill="${accent}">?</text>
    </g>`;
};

const approvalScene = (
  variant: 0 | 1,
  elapsedMs: number,
  accent: string,
): string => {
  const phase = animation(elapsedMs, 2_400);
  const pulse = (Math.sin(phase) + 1) / 2;
  if (variant === 0)
    return `${agent({
      x: 55,
      y: 59,
      scale: 0.9,
      rightArm: "forward",
    })}
      ${clipboard(99, 70 + Math.sin(phase) * 1.2, accent, pulse)}`;
  const tap = Math.max(0, Math.sin(phase * 2)) * 2;
  return `${agent({
    y: 58 + tap,
    rotation: Math.sin(phase) * 1.5,
    leftArm: "side",
    rightArm: "side",
  })}
    <g transform="translate(103 42)">
      <circle r="13" fill="none" stroke="${accent}" stroke-width="2"/>
      <path d="M-4 -6 V2 L2 6 M4 -6 V2 L-2 6" fill="none" stroke="${accent}" stroke-width="2.2" stroke-linecap="round"/>
    </g>`;
};

const reviewScene = (
  variant: 0 | 1,
  elapsedMs: number,
  accent: string,
): string => {
  const phase = animation(elapsedMs, 1_200);
  const pulse = (Math.sin(phase) + 1) / 2;
  const jump = Math.max(0, Math.sin(phase)) ** 2 * 8;
  const confettiDrift = ((elapsedMs % 1_200) / 1_200) * 16;
  if (variant === 0)
    return `<g data-motion="celebrate-cube">
      ${agent({
        x: 49 + Math.sin(phase) * 1.5,
        y: 62 - jump,
        scale: 0.88,
        rotation: Math.sin(phase) * 5,
        leftArm: "raised",
        rightArm: "forward",
      })}
      ${cube(
        101,
        68 - jump * 0.35 + Math.sin(phase * 2) * 3,
        accent,
        0.9 + pulse * 0.14,
      )}
      <path d="M91 38 L92 28 M103 39 L109 30 M114 47 L123 43 M84 45 L79 37" stroke="${accent}" stroke-width="2.5" stroke-linecap="round" opacity="${number(0.65 + pulse * 0.35)}"/>
      <g fill="${accent}" opacity=".78">
        <rect x="30" y="${number(35 + confettiDrift)}" width="3" height="8" rx="1" transform="rotate(${number(elapsedMs / 7)} 31 39)"/>
        <rect x="116" y="${number(26 + ((confettiDrift + 8) % 16))}" width="7" height="3" rx="1" transform="rotate(${number(-elapsedMs / 8)} 119 28)"/>
      </g>
    </g>`;
  return `<g data-motion="celebrate-check">
    ${agent({
      x: 48 + Math.sin(phase) * 1.3,
      y: 62 - jump,
      scale: 0.84,
      rotation: -Math.sin(phase) * 5,
      leftArm: "raised",
      rightArm: "forward",
    })}
    <g transform="translate(99 ${number(68 - jump * 0.35 + Math.sin(phase * 2) * 2)}) scale(${number(0.96 + pulse * 0.07)})">
      <rect x="-21" y="-22" width="42" height="44" rx="6" fill="${accent}" fill-opacity=".16" stroke="${accent}" stroke-width="2"/>
      <path d="M-10 1 L-2 9 L12 -8" fill="none" stroke="${accent}" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>
    </g>
    <path d="M85 37 L83 28 M97 35 L101 26 M112 40 L119 33 M119 53 L128 51" stroke="${accent}" stroke-width="2.5" stroke-linecap="round" opacity="${number(0.65 + pulse * 0.35)}"/>
    <g fill="${accent}" opacity=".78">
      <rect x="29" y="${number(29 + confettiDrift)}" width="7" height="3" rx="1" transform="rotate(${number(elapsedMs / 8)} 32 31)"/>
      <rect x="117" y="${number(31 + ((confettiDrift + 6) % 16))}" width="3" height="8" rx="1" transform="rotate(${number(-elapsedMs / 7)} 118 35)"/>
    </g>
  </g>`;
};

const failedScene = (
  variant: 0 | 1,
  elapsedMs: number,
  accent: string,
): string => {
  const phase = animation(elapsedMs, 1_800);
  if (variant === 0)
    return `${agent({
      x: 53,
      y: 62,
      scale: 0.88,
      rotation: -5 + Math.sin(phase) * 1.2,
      rightArm: "raised",
    })}
      ${gear(100, 84, -16, accent, true)}
      <path d="M90 40 Q97 32 103 39 T116 38" fill="none" stroke="${accent}" stroke-width="2.2" stroke-linecap="round" opacity="${number(0.55 + Math.sin(phase) ** 2 * 0.4)}"/>`;
  const push = Math.sin(phase * 3) * 1.5;
  return `<g transform="translate(${number(push)} 0)">
      ${agent({
        x: 54,
        y: 60,
        scale: 0.9,
        rotation: 5,
        leftArm: "forward",
        rightArm: "forward",
      })}
    </g>
    <g transform="translate(${number(push * 0.3)} 0)">
      <rect x="94" y="47" width="22" height="60" rx="4" fill="${accent}" fill-opacity=".16" stroke="${accent}" stroke-width="2"/>
      <path d="M94 61 H116 M94 79 H116 M94 97 H116" stroke="${accent}" stroke-width="1.5"/>
    </g>`;
};

const cancelledScene = (
  variant: 0 | 1,
  elapsedMs: number,
  accent: string,
): string => {
  const phase = animation(elapsedMs, 3_500);
  if (variant === 0)
    return `${agent({
      y: 65 + Math.sin(phase) * 0.7,
      scale: 0.9,
      rotation: -3,
      headY: 2,
    })}
      <path d="M95 47 H115" stroke="${accent}" stroke-width="4" stroke-linecap="round" opacity=".7"/>`;
  return `${agent({
    x: 48,
    y: 61,
    scale: 0.84,
    leftArm: "forward",
    rightArm: "forward",
  })}
    <g transform="translate(96 ${number(76 + Math.sin(phase) * 1.3)})">
      <path d="M-17 -12 L0 -20 L17 -12 L0 -4 Z" fill="${accent}"/>
      <path d="M-17 -12 L0 -4 V16 L-17 8 Z M17 -12 L0 -4 V16 L17 8 Z" fill="${accent}" fill-opacity=".4" stroke="${accent}" stroke-width="1"/>
    </g>`;
};

const unknownScene = (
  variant: 0 | 1,
  elapsedMs: number,
  accent: string,
): string => {
  const phase = animation(elapsedMs, 2_600);
  if (variant === 0) {
    const sweep = Math.sin(phase) * 10;
    return `${agent({
      x: 57,
      y: 60,
      scale: 0.9,
      rightArm: "forward",
      headX: Math.sin(phase) * 2,
    })}
      <g transform="translate(${number(101 + sweep)} 66) rotate(${number(20 + sweep)})">
        <circle r="11" fill="none" stroke="${accent}" stroke-width="2.5"/>
        <path d="M8 8 L18 18" stroke="${accent}" stroke-width="4" stroke-linecap="round"/>
      </g>`;
  }
  return `${agent({
    y: 60 + Math.sin(phase * 2) * 0.8,
    rotation: Math.sin(phase) * 2,
    leftArm: "side",
    rightArm: "side",
  })}
    ${questionBubble(105, 43, accent, 0.85 + ((Math.sin(phase) + 1) / 2) * 0.08)}`;
};

export const agentLookScene = (
  state: AgentState,
  seed: string,
  elapsedMs: number,
  palette: KeyVisualPalette = DARK_KEY_VISUAL_PALETTE,
): string => {
  const accent = FLAT_WHITE;
  const variant = agentSceneVariant(seed, state);
  let content: string;
  if (state === "idle") content = idleScene(variant, elapsedMs, accent);
  else if (state === "running")
    content = runningScene(variant, elapsedMs, accent);
  else if (state === "recovering")
    content = `${runningScene(variant, elapsedMs, accent)}
      <g data-state-warning="recovering">
        <path d="M72 35 L84 58 H60 Z" fill="${palette.stateAccent.waiting_for_input}" stroke="${palette.inverseForeground}" stroke-width="1.5"/>
        <text x="72" y="54" text-anchor="middle" font-family="system-ui" font-size="15" font-weight="900" fill="${palette.inverseForeground}">!</text>
      </g>`;
  else if (state === "waiting_for_input")
    content = inputScene(variant, elapsedMs, accent);
  else if (state === "waiting_for_approval")
    content = approvalScene(variant, elapsedMs, accent);
  else if (state === "ready_for_review")
    content = reviewScene(variant, elapsedMs, accent);
  else if (state === "failed")
    content = failedScene(variant, elapsedMs, accent);
  else if (state === "cancelled")
    content = cancelledScene(variant, elapsedMs, accent);
  else content = unknownScene(variant, elapsedMs, accent);

  return `${sceneBackground(palette.stateSurface[state])}<g color="${palette.foreground}">${content}</g>`;
};

export const emptyAgentLookScene = (
  seed: string,
  elapsedMs: number,
  palette: KeyVisualPalette = DARK_KEY_VISUAL_PALETTE,
): string => {
  return `${sceneBackground(palette.emptySurface)}<g color="${palette.emptyCharacter}">${idleScene(
    agentSceneVariant(seed, "empty"),
    elapsedMs,
    palette.foreground,
  )}</g>`;
};

export const removedAgentLookScene = (
  seed: string,
  elapsedMs: number,
  palette: KeyVisualPalette = DARK_KEY_VISUAL_PALETTE,
): string => {
  const progress = Math.min(
    1,
    Math.max(0, elapsedMs / REMOVED_AGENT_ANIMATION_MS),
  );
  const eased = 1 - (1 - progress) ** 3;
  const scale = Math.max(0.08, 1 - eased * 0.92);
  const opacity = Math.max(0, 1 - progress * 1.15);
  const spin = (hash(seed) % 2 ? 1 : -1) * eased * 32;
  const particles = Array.from({ length: 8 }, (_, index) => {
    const angle = ((hash(`${seed}:${index}`) % 360) * Math.PI) / 180;
    const distance = 12 + eased * (22 + (index % 3) * 7);
    const x = 72 + Math.cos(angle) * distance;
    const y = 70 + Math.sin(angle) * distance;
    return `<circle cx="${number(x)}" cy="${number(y)}" r="${number(
      Math.max(0, 3.2 * (1 - progress)),
    )}" fill="${FLAT_WHITE}" opacity="${number(opacity)}"/>`;
  }).join("");

  return `${sceneBackground(palette.emptySurface)}
    <g color="${palette.emptyCharacter}">
    <g opacity="${number(opacity)}" transform="rotate(${number(spin)} 72 70)">
      ${agent({ y: 58 + eased * 10, scale })}
    </g>
    ${particles}
    <g opacity="${number(Math.min(1, progress * 2.4))}" stroke="${FLAT_WHITE}" stroke-width="5" stroke-linecap="round">
      <path d="M58 70 H86"/>
    </g>
    </g>`;
};
