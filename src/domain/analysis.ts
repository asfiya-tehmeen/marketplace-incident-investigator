/**
 * Deterministic anomaly analysis. The model never does arithmetic: every number
 * an investigation reports is computed here and stored as evidence.
 *
 * Method: compare each 3-hour block of the last 7 days with the same block in
 * the two previous weeks (seasonality-aware baseline), work in log-ratios,
 * estimate noise from week 2 vs week 1, and find the most negative contiguous
 * run of blocks (max-subarray). That gives onset, end, effect size and z-score.
 */

export const BLOCK_HOURS = 3;
export const SIGNIFICANCE_Z = 4;
export const MIN_EFFECT = 0.15;
/** Episode edges must be at least this many noise SDs below baseline. */
export const EDGE_SD = 2.5;
/** Episodes shorter than this many blocks (12h) need a drop of at least SHORT_EPISODE_EFFECT. */
export const MIN_BLOCKS = 4;
export const SHORT_EPISODE_EFFECT = 0.5;

export interface HourPoint {
  ts: string; // ISO hour
  value: number;
}

export interface Episode {
  significant: boolean;
  onset: string | null;
  end: string | null; // exclusive; null if still ongoing at end of data
  ongoing: boolean;
  effectPct: number; // e.g. -62.4
  z: number;
  noiseSd: number;
  blocks: number;
  baselineTotal: number;
  observedTotal: number;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Groups hourly points into fixed blocks. Input must be contiguous and sorted. */
export function toBlocks(points: HourPoint[], hours = BLOCK_HOURS): HourPoint[] {
  const out: HourPoint[] = [];
  for (let i = 0; i + hours <= points.length; i += hours) {
    let v = 0;
    for (let j = i; j < i + hours; j++) v += points[j]!.value;
    out.push({ ts: points[i]!.ts, value: v });
  }
  return out;
}

/**
 * Detects the most significant drop in the final week of a 3-week hourly series.
 * The series must cover exactly 21 days of hours (504 points), oldest first.
 */
export function detectDrop(points: HourPoint[]): Episode {
  if (points.length < 21 * 24) throw new Error(`need 21 days of hourly data, got ${points.length} points`);
  const p = points.slice(-21 * 24);
  const blocks = toBlocks(p);
  const perWeek = (7 * 24) / BLOCK_HOURS;
  const w1 = blocks.slice(0, perWeek);
  const w2 = blocks.slice(perWeek, 2 * perWeek);
  const w3 = blocks.slice(2 * perWeek);

  const lr = (a: number, b: number) => Math.log((a + 1) / (b + 1));
  // Noise: how much week 2 differs from week 1 when nothing is wrong.
  const noise = w2.map((b, i) => lr(b.value, w1[i]!.value));
  const mean = noise.reduce((s, x) => s + x, 0) / noise.length;
  const noiseSd = Math.sqrt(noise.reduce((s, x) => s + (x - mean) ** 2, 0) / (noise.length - 1)) || 1e-6;

  const expected = w3.map((_, i) => (w1[i]!.value + w2[i]!.value) / 2);
  const ratios = w3.map((b, i) => lr(b.value, expected[i]!));

  // Most negative contiguous run (Kadane on -ratio).
  let best = 0, bestStart = -1, bestEnd = -1, cur = 0, curStart = 0;
  for (let i = 0; i < ratios.length; i++) {
    if (cur <= 0) {
      cur = -ratios[i]!;
      curStart = i;
    } else cur += -ratios[i]!;
    if (cur > best) {
      best = cur;
      bestStart = curStart;
      bestEnd = i + 1;
    }
  }

  // Kadane happily absorbs neighbouring noise blocks while the running sum stays
  // favourable, which made onsets up to 10h early in calibration. Trim edges that
  // are not individually significant.
  const edge = -EDGE_SD * noiseSd;
  while (bestStart >= 0 && bestStart < bestEnd && ratios[bestStart]! > edge) bestStart++;
  while (bestEnd > bestStart && ratios[bestEnd - 1]! > edge) bestEnd--;
  if (bestStart >= bestEnd) bestStart = -1;

  if (bestStart < 0) {
    return { significant: false, onset: null, end: null, ongoing: false, effectPct: 0, z: 0, noiseSd: round1(noiseSd * 1000) / 1000, blocks: 0, baselineTotal: sum(expected), observedTotal: sum(w3.map((b) => b.value)) };
  }

  const n = bestEnd - bestStart;
  const meanLr = ratios.slice(bestStart, bestEnd).reduce((s, x) => s + x, 0) / n;
  const z = meanLr / (noiseSd / Math.sqrt(n));
  const observed = sum(w3.slice(bestStart, bestEnd).map((b) => b.value));
  const base = sum(expected.slice(bestStart, bestEnd));
  const effect = base > 0 ? observed / base - 1 : 0;
  const ongoing = bestEnd >= w3.length - 1; // allow one recovered block at the very end
  return {
    // Short episodes must be severe: night blocks have small counts and more noise than
    // noiseSd assumes, which produced 9-hour -18% false positives in calibration.
    significant: Math.abs(z) >= SIGNIFICANCE_Z && -effect >= MIN_EFFECT && (n >= MIN_BLOCKS || -effect >= SHORT_EPISODE_EFFECT),
    onset: w3[bestStart]!.ts,
    end: ongoing ? null : w3[bestEnd]!.ts,
    ongoing,
    effectPct: round1(effect * 100),
    z: round1(z),
    noiseSd: Math.round(noiseSd * 1000) / 1000,
    blocks: n,
    baselineTotal: Math.round(base),
    observedTotal: observed,
  };
}

/** Change of observed vs expected (2-week same-hour baseline) over a window of the last week. */
export function windowEffect(points: HourPoint[], fromTs: string, toTs: string | null): { effectPct: number; observed: number; expected: number } {
  const p = points.slice(-21 * 24);
  const wk = 7 * 24;
  let obs = 0, exp = 0;
  for (let i = 2 * wk; i < p.length; i++) {
    const ts = p[i]!.ts;
    if (ts < fromTs || (toTs !== null && ts >= toTs)) continue;
    obs += p[i]!.value;
    exp += (p[i - wk]!.value + p[i - 2 * wk]!.value) / 2;
  }
  return { effectPct: exp > 0 ? round1((obs / exp - 1) * 100) : 0, observed: obs, expected: Math.round(exp) };
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

export function hoursBetween(a: string, b: string): number {
  return (Date.parse(b) - Date.parse(a)) / 3_600_000;
}
