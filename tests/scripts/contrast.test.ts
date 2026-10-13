import assert from "node:assert/strict";
import test from "node:test";
import { chumBucketDark, chumBucketLight } from "../../src/theme";

type Oklch = { l: number; c: number; h: number; a: number };

const parse = (value: string): Oklch => {
  const m = value.match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)$/);

  if (!m) {
    throw new Error(`not an oklch() value: ${value}`);
  }

  return { l: +m[1], c: +m[2], h: +m[3], a: m[4] === undefined ? 1 : +m[4] };
};

const luminance = (value: string): number => {
  const { l, c, h } = parse(value);
  const r = (h * Math.PI) / 180;
  const a = c * Math.cos(r);
  const b = c * Math.sin(r);
  const lp = l + 0.3963377774 * a + 0.2158037573 * b;
  const mp = l - 0.1055613458 * a - 0.0638541728 * b;
  const sp = l - 0.0894841775 * a - 1.291485548 * b;
  const [L, M, S] = [lp ** 3, mp ** 3, sp ** 3];
  const clamp = (x: number) => Math.min(1, Math.max(0, x));

  return (
    0.2126 * clamp(4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S) +
    0.7152 * clamp(-1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S) +
    0.0722 * clamp(-0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S)
  );
};

const flatten = (value: string, surface: string): string => {
  const f = parse(value);
  const b = parse(surface);

  return `oklch(${f.l * f.a + b.l * (1 - f.a)} ${f.c * f.a + b.c * (1 - f.a)} ${f.h})`;
};

const contrast = (fg: string, bg: string): number => {
  const surface = flatten(bg, "oklch(0 0 0)");
  const front = flatten(fg, surface);
  const [a, b] = [luminance(front), luminance(surface)];

  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

for (const [mode, theme] of [
  ["light", chumBucketLight],
  ["dark", chumBucketDark],
] as const) {
  const pairs = [
    ["body text on page", theme.textNeutralPrimary!, theme.background!],
    ["body text on card", theme.textNeutralPrimary!, theme.foreground!],
    ["secondary text on page", theme.textNeutralSecondary!, theme.background!],
    ["secondary text on card", theme.textNeutralSecondary!, theme.foreground!],
    ["label on accent button", theme.textAccentPrimary!, theme.interactiveAccentDefault!],
    ["brand text on card", theme.textBrand!, theme.foreground!],
    ["brand text on page", theme.textBrand!, theme.background!],
  ] as const;

  for (const [label, foreground, background] of pairs) {
    test(`${mode} theme: ${label} meets WCAG AA`, () => {
      const ratio = contrast(foreground, background);
      assert.ok(ratio >= 4.5, `${ratio.toFixed(2)}:1 must be at least 4.5:1`);
    });
  }
}
