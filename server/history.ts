import { join } from "node:path";
import type { Usage, UsageWindow } from "../shared/model";
import { readJson, writeJsonAtomic } from "./json-file";
import { dataDir } from "./paths";

/** `[when (ms), percent used]`. */
export type Sample = [number, number];
/** Per account, per usage window. */
export type History = Record<string, Record<string, Sample[]>>;

const KEEP_MS = 8 * 24 * 60 * 60_000;
const SPACING_MS = 10 * 60_000;
/** A drop this large means the window reset: the trend starts over from there. */
const RESET_DROP = 15;
/** The trend is read from this much recent history. */
const TREND_MS = 24 * 60 * 60_000;

/** Adds a reading: at most one point per window every few minutes, unless usage moved. */
export function record(history: History, accountId: string, usage: Usage, now: number = Date.now()): boolean {
  let changed = false;
  const windows = (history[accountId] ??= {});
  for (const window of usage.windows) {
    const samples = (windows[window.id] ??= []);
    const last = samples.at(-1);
    if (last && now - last[0] < SPACING_MS && Math.abs(last[1] - window.usedPercent) < 1) continue;
    samples.push([now, Math.round(window.usedPercent * 10) / 10]);
    while (samples.length > 0 && now - samples[0]![0] > KEEP_MS) samples.shift();
    changed = true;
  }
  return changed;
}

/** The samples since the window last reset (usage only climbs within one window). */
export function currentCycle(samples: readonly Sample[]): Sample[] {
  let start = 0;
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index - 1]![1] - samples[index]![1] >= RESET_DROP) start = index;
  }
  return samples.slice(start);
}

export interface Forecast {
  windowId: string;
  windowLabel: string;
  /** When usage reaches 100% at the recent pace; `null` when it won't before the window resets. */
  runsOutAt: string | null;
  resetsAt: string | null;
}

/** How long a usage window lasts, from its name; `null` when it can't be told. */
export function windowLength(window: UsageWindow): number | null {
  const name = `${window.id} ${window.label}`;
  if (/five|5h|5-hour|session/i.test(name)) return 5 * 60 * 60_000;
  if (/week|seven|7d/i.test(name)) return 7 * 24 * 60 * 60_000;
  if (/month/i.test(name)) return 30 * 24 * 60 * 60_000;
  return null;
}

/**
 * When a window runs out: at its recent pace (a straight-line fit over the last day of history),
 * or, before there's an hour of history, at its average pace since the window started (known from
 * its length and reset time). `null` when usage isn't climbing or nothing can be told.
 */
export function forecastWindow(window: UsageWindow, samples: readonly Sample[], now: number = Date.now()): Forecast | null {
  if (window.usedPercent >= 100) return null; // Already out: the limit itself says when it's back.
  const recent = currentCycle(samples).filter(([at]) => now - at <= TREND_MS);
  if (recent.length < 3 || recent.at(-1)![0] - recent[0]![0] < 60 * 60_000) return averagePace(window, now);
  const n = recent.length;
  const meanT = recent.reduce((sum, [t]) => sum + t, 0) / n;
  const meanU = recent.reduce((sum, [, u]) => sum + u, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (const [t, u] of recent) {
    numerator += (t - meanT) * (u - meanU);
    denominator += (t - meanT) ** 2;
  }
  const slope = denominator > 0 ? numerator / denominator : 0; // percent per ms
  if (slope <= 0) return null;
  const at = now + Math.max(0, 100 - window.usedPercent) / slope;
  const resets = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  return {
    windowId: window.id,
    windowLabel: window.label,
    runsOutAt: Number.isFinite(resets) && at >= resets ? null : new Date(at).toISOString(),
    resetsAt: window.resetsAt,
  };
}

/** The forecast from a window's average pace since it started. */
function averagePace(window: UsageWindow, now: number): Forecast | null {
  const length = windowLength(window);
  const resets = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  if (!length || !Number.isFinite(resets)) return null;
  const elapsed = now - (resets - length);
  // Too early in the window to tell a pace from a single burst.
  if (elapsed < Math.min(length / 10, 60 * 60_000) || window.usedPercent <= 0) return null;
  const at = now + ((100 - window.usedPercent) * elapsed) / window.usedPercent;
  return { windowId: window.id, windowLabel: window.label, runsOutAt: at >= resets ? null : new Date(at).toISOString(), resetsAt: window.resetsAt };
}

/**
 * The forecast worth showing for an account: the window that runs out first, preferring the long
 * (weekly, monthly) ones, since a 5-hour window refills before the forecast matters.
 */
export function accountForecast(usage: Usage | undefined, windows: Record<string, Sample[]> | undefined, now: number = Date.now()): Forecast | null {
  if (!usage || !windows) return null;
  const forecasts = usage.windows
    .map((window) => forecastWindow(window, windows[window.id] ?? [], now))
    .filter((forecast): forecast is Forecast => forecast !== null);
  const running = forecasts.filter((forecast) => forecast.runsOutAt).sort((a, b) => Date.parse(a.runsOutAt!) - Date.parse(b.runsOutAt!));
  if (running[0]) return running[0];
  const long = forecasts.find((forecast) => /week|seven|month/i.test(`${forecast.windowId} ${forecast.windowLabel}`));
  return long ?? forecasts[0] ?? null;
}

/** Up to `points` evenly spaced readings of one window over the last week, for a small trend chart. */
export function trend(samples: readonly Sample[] | undefined, points = 42, now: number = Date.now()): Array<number | null> {
  const span = 7 * 24 * 60 * 60_000;
  const bucket = span / points;
  const out: Array<number | null> = new Array(points).fill(null);
  for (const [at, used] of samples ?? []) {
    const index = Math.floor((at - (now - span)) / bucket);
    if (index >= 0 && index < points) out[index] = Math.max(out[index] ?? 0, used);
  }
  return out;
}

/**
 * "Thu 14:00" within the coming week, else "Oct 23", in the host's own time zone (daylight saving
 * included). Formatted here because the daemon has full time-zone data; some app runtimes don't.
 */
export function hostWhen(at: string | null, now: number = Date.now(), timeZone?: string): string | null {
  const time = at ? Date.parse(at) : Number.NaN;
  if (!Number.isFinite(time)) return null;
  const options: Intl.DateTimeFormatOptions =
    time - now < 6 * 24 * 60 * 60_000
      ? { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }
      : { month: "short", day: "numeric", timeZone };
  return new Intl.DateTimeFormat("en-GB", options).format(new Date(time)).replace(",", "");
}

/** The host's time zone, and its current offset from UTC in minutes (east positive). */
export function hostTimeZone(now: number = Date.now()): { name: string; offsetMinutes: number } {
  const id = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  return { name: id.split("/").pop()?.replace(/_/g, " ") ?? id, offsetMinutes: -new Date(now).getTimezoneOffset() };
}

const historyPath = () => join(dataDir(), "usage-history.json");

export async function loadHistory(): Promise<History> {
  const saved = await readJson(historyPath()).catch(() => undefined);
  return saved && typeof saved === "object" ? (saved as History) : {};
}

export async function saveHistory(history: History): Promise<void> {
  await writeJsonAtomic(historyPath(), history);
}
