export type Theme = "dark" | "light";

export interface RoleColorPaletteEntry {
  name: string;
  base: string;
  dark: string;
  light: string;
}

export const ROLE_COLOR_PALETTE: readonly RoleColorPaletteEntry[] = [
  { name: "Красный", base: "#e55353", dark: "#e86a6a", light: "#ca1f1f" },
  { name: "Оранжевый", base: "#ea7317", dark: "#ea7317", light: "#a3500f" },
  { name: "Янтарный", base: "#b45309", dark: "#eb6c0c", light: "#a84d08" },
  { name: "Бирюзовый", base: "#14b8a6", dark: "#14b8a6", light: "#0d7469" },
  { name: "Зелёный", base: "#10b981", dark: "#10b981", light: "#0a7653" },
  { name: "Синий", base: "#4a7fd0", dark: "#6693d7", light: "#3066b9" },
  { name: "Фиолетовый", base: "#a78bfa", dark: "#a78bfa", light: "#6d3ff7" },
  { name: "Серый", base: "#6b7280", dark: "#8b929e", light: "#616774" }
];

const THEME_SURFACES: Record<Theme, readonly string[]> = {
  dark: ["#0f1115", "#171a21", "#1f232d", "#262b36"],
  light: ["#f5f7fa", "#ffffff", "#eef1f6", "#e2e6ee"]
};

const NEUTRAL_ROLE_COLOR: Record<Theme, string> = {
  dark: "#8b929e",
  light: "#616774"
};

type Rgb = readonly [number, number, number];
type Lab = readonly [number, number, number];

function parseHex(hex: string): Rgb | null {
  const value = hex.trim().replace(/^#/, "");
  const expanded = /^[\da-f]{3}$/i.test(value)
    ? value.split("").map((digit) => digit + digit).join("")
    : value;
  if (!/^[\da-f]{6}$/i.test(expanded)) return null;
  return [
    Number.parseInt(expanded.slice(0, 2), 16),
    Number.parseInt(expanded.slice(2, 4), 16),
    Number.parseInt(expanded.slice(4, 6), 16)
  ];
}

function linearize(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  return 0.2126 * linearize(rgb[0]) + 0.7152 * linearize(rgb[1]) + 0.0722 * linearize(rgb[2]);
}

export function contrastRatio(foreground: string, background: string): number {
  const first = parseHex(foreground);
  const second = parseHex(background);
  if (!first || !second) return 0;
  const luminanceA = relativeLuminance(foreground);
  const luminanceB = relativeLuminance(background);
  return (Math.max(luminanceA, luminanceB) + 0.05) / (Math.min(luminanceA, luminanceB) + 0.05);
}

function toLab(hex: string): Lab {
  const rgb = parseHex(hex) ?? [0, 0, 0];
  const red = linearize(rgb[0]);
  const green = linearize(rgb[1]);
  const blue = linearize(rgb[2]);
  const x = (red * 0.4124564 + green * 0.3575761 + blue * 0.1804375) / 0.95047;
  const y = red * 0.2126729 + green * 0.7151522 + blue * 0.072175;
  const z = (red * 0.0193339 + green * 0.119192 + blue * 0.9503041) / 1.08883;
  const transform = (value: number): number => value > 0.008856451679
    ? Math.cbrt(value)
    : 7.787037037 * value + 16 / 116;
  const fx = transform(x);
  const fy = transform(y);
  const fz = transform(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function distance(first: Lab, second: Lab): number {
  return Math.hypot(first[0] - second[0], first[1] - second[1], first[2] - second[2]);
}

function nearestPaletteVariant(color: string, theme: Theme): string {
  const target = toLab(color);
  let closest = NEUTRAL_ROLE_COLOR[theme];
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const entry of ROLE_COLOR_PALETTE) {
    const candidate = entry[theme];
    const candidateDistance = distance(target, toLab(candidate));
    if (candidateDistance < closestDistance) {
      closest = candidate;
      closestDistance = candidateDistance;
    }
  }
  return closest;
}

export function roleColorForTheme(baseHex: string | null, theme: Theme): string | null {
  if (!baseHex) return null;
  const parsed = parseHex(baseHex);
  if (!parsed) return NEUTRAL_ROLE_COLOR[theme];

  const normalized = "#" + parsed.map((channel) => channel.toString(16).padStart(2, "0")).join("");
  const paletteEntry = ROLE_COLOR_PALETTE.find((entry) => entry.base.toLowerCase() === normalized);
  if (paletteEntry) return paletteEntry[theme];

  if (THEME_SURFACES[theme].every((surface) => contrastRatio(normalized, surface) >= 4.5)) {
    return normalized;
  }
  return nearestPaletteVariant(normalized, theme);
}
