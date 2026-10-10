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

const AA = 4.5;
const failures: string[] = [];

const check = (label: string, fg: string, bg: string) => {
  const ratio = contrast(fg, bg);
  const pass = ratio >= AA;

  if (!pass) {
    failures.push(`${label}: ${ratio.toFixed(2)}:1 (need ${AA})`);
  }

  console.log(`${pass ? "ok  " : "FAIL"} ${label.padEnd(34)} ${ratio.toFixed(2)}:1`);
};

for (const [mode, t] of [
  ["light", chumBucketLight],
  ["dark", chumBucketDark],
] as const) {
  console.log(`--- ${mode} ---`);
  check("body text on page", t.textNeutralPrimary!, t.background!);
  check("body text on card", t.textNeutralPrimary!, t.foreground!);
  check("secondary text on page", t.textNeutralSecondary!, t.background!);
  check("secondary text on card", t.textNeutralSecondary!, t.foreground!);
  check("label on accent button", t.textAccentPrimary!, t.interactiveAccentDefault!);
  check("brand text on card", t.textBrand!, t.foreground!);
  check("brand text on page", t.textBrand!, t.background!);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} contrast failure(s):`);

  for (const f of failures) {
    console.error(`  ${f}`);
  }

  process.exit(1);
}

console.log("\nall pairs meet WCAG AA");
