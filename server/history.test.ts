import { describe, expect, it } from "vitest";
import { accountForecast, currentCycle, forecastWindow, hostWhen, record, trend, type History, type Sample } from "./history";
import { zoneNote } from "../shared/format";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-14T12:00:00Z");
const iso = (hours: number) => new Date(NOW + hours * HOUR).toISOString();
const window = (used: number, resetsInHours: number) => ({ id: "seven_day", label: "Weekly", usedPercent: used, resetsAt: iso(resetsInHours) });

describe("usage history", () => {
  it("records at most one point every few minutes unless usage moved", () => {
    const history: History = {};
    const usage = (used: number) => ({ fetchedAt: iso(0), windows: [window(used, 48)], error: null, cached: false, resets: null });
    expect(record(history, "a", usage(10), NOW)).toBe(true);
    expect(record(history, "a", usage(10.2), NOW + 60_000)).toBe(false);
    expect(record(history, "a", usage(12), NOW + 120_000)).toBe(true);
    expect(history.a?.seven_day).toHaveLength(2);
  });

  it("starts the trend over after a reset", () => {
    const samples: Sample[] = [[1, 80], [2, 95], [3, 2], [4, 5]];
    expect(currentCycle(samples)).toEqual([[3, 2], [4, 5]]);
  });

  it("forecasts when a climbing window runs out, and says when it lasts until reset", () => {
    // 2% an hour for the last 10 hours, now at 60%: 40% left runs out in about 20 hours.
    const samples: Sample[] = Array.from({ length: 11 }, (_, index) => [NOW - (10 - index) * HOUR, 40 + index * 2]);
    const soon = forecastWindow(window(60, 48), samples, NOW);
    expect(Date.parse(soon!.runsOutAt!)).toBeCloseTo(NOW + 20 * HOUR, -5);
    expect(forecastWindow(window(60, 10), samples, NOW)?.runsOutAt).toBeNull();
  });

  it("falls back to the average pace with too little history, and says nothing for flat usage", () => {
    // Two readings an hour apart aren't a trend; 60% used 5 days in lasts the 2 days to the reset.
    expect(forecastWindow(window(60, 48), [[NOW - HOUR, 50], [NOW, 60]], NOW)).toMatchObject({ runsOutAt: null });
    const flat: Sample[] = Array.from({ length: 6 }, (_, index) => [NOW - (5 - index) * HOUR, 30]);
    expect(forecastWindow(window(30, 48), flat, NOW)).toBeNull();
  });

  it("shows the window that runs out first", () => {
    const climbing: Sample[] = Array.from({ length: 11 }, (_, index) => [NOW - (10 - index) * HOUR, 40 + index * 2]);
    const usage = { fetchedAt: iso(0), windows: [{ ...window(20, 3), id: "five_hour", label: "5-hour" }, window(60, 48)], error: null, cached: false, resets: null };
    expect(accountForecast(usage, { seven_day: climbing, five_hour: [] }, NOW)?.windowId).toBe("seven_day");
  });

  it("buckets a week into a small chart", () => {
    const points = trend([[NOW - 1_000, 40], [NOW - 8 * 24 * HOUR, 10]], 7, NOW);
    expect(points).toHaveLength(7);
    expect(points.at(-1)).toBe(40);
    expect(points.filter((point) => point !== null)).toHaveLength(1);
  });

  it("uses the window's average pace until there's an hour of history", () => {
    // A weekly window that started 3.5 days ago (resets in 3.5 days) and is 70% used: at that pace
    // it runs out in 1.5 days, before it resets.
    const forecast = forecastWindow(window(70, 84), [], NOW);
    expect(Date.parse(forecast!.runsOutAt!)).toBeCloseTo(NOW + 36 * HOUR, -5);
    // 30% used halfway through: lasts until it resets.
    expect(forecastWindow(window(30, 84), [], NOW)?.runsOutAt).toBeNull();
    // Already out, or just started: nothing to say.
    expect(forecastWindow(window(100, 84), [], NOW)).toBeNull();
    expect(forecastWindow(window(5, 7 * 24 - 0.5), [], NOW)).toBeNull();
  });

  it("writes times in the host's time zone, daylight saving included", () => {
    const at = "2026-10-15T17:12:00Z";
    expect(hostWhen(at, NOW, "Asia/Seoul")).toBe("Fri 02:12");
    expect(hostWhen(at, NOW, "Europe/Paris")).toBe("Thu 19:12"); // summer time, UTC+2
    expect(hostWhen("2026-10-26T17:12:00Z", Date.parse("2026-10-25T00:00:00Z"), "Europe/Paris")).toBe("Mon 18:12"); // winter time
    expect(hostWhen("2026-11-30T00:00:00Z", NOW, "Asia/Seoul")).toBe("30 Nov");
  });

  it("names the host's zone only when the viewer's clock differs", () => {
    const here = -new Date(NOW).getTimezoneOffset();
    expect(zoneNote({ name: "Seoul", offsetMinutes: here }, NOW)).toBe("");
    expect(zoneNote({ name: "Seoul", offsetMinutes: here + 60 }, NOW)).toBe(" (Seoul time)");
  });
});
