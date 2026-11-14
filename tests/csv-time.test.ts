import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CsvError, parseLine, readCsv } from "../src/csv.js";
import {
  addDays,
  DAY,
  formatClock,
  minutesBetween,
  parseClock,
  parseDate,
  parseTime,
  TimeError,
  weekday,
} from "../src/time.js";
import { formatJourney } from "../src/format.js";
import type { Feed } from "../src/gtfs.js";
import { journeyJson, type Loaded } from "../src/service.js";

describe("parseLine", () => {
  it.each([
    ["a,b,c", ["a", "b", "c"]],
    ["a,,c,", ["a", "", "c", ""]],
    ['"Delta, Náměstí",x', ["Delta, Náměstí", "x"]],
    ['"say ""hi""",2', ['say "hi"', "2"]],
    ['""', [""]],
    ["", [""]],
  ])("%j", (line, fields) => {
    expect(parseLine(line)).toEqual(fields);
  });

  it("rejects broken quoting", () => {
    expect(() => parseLine('"open,1')).toThrow(CsvError);
    expect(() => parseLine('"a"b,1')).toThrow(CsvError);
  });
});

describe("readCsv", () => {
  it("reads by column name, skips a BOM and blank lines, handles CRLF", async () => {
    const dir = mkdtempSync(join(tmpdir(), "csv-"));
    const file = join(dir, "x.txt");
    writeFileSync(file, "﻿id,name\r\n1,One\r\n\r\n2,\"Two, too\"\r\n");
    const rows: string[][] = [];
    const count = await readCsv(file, (row) => rows.push([row("id"), row("name"), row("missing")]));
    expect(count).toBe(2);
    expect(rows).toEqual([
      ["1", "One", ""],
      ["2", "Two, too", ""],
    ]);
  });
});

describe("times", () => {
  it("parses GTFS times, also past midnight", () => {
    expect(parseTime("08:05:30")).toBe(8 * 3600 + 5 * 60 + 30);
    expect(parseTime("8:05:00")).toBe(8 * 3600 + 5 * 60);
    expect(parseTime("25:10:00")).toBe(DAY + 3600 + 600);
    expect(() => parseTime("8:5")).toThrow(TimeError);
    expect(() => parseTime("08:60:00")).toThrow(TimeError);
  });

  it("parses the command-line clock", () => {
    expect(parseClock("8:05")).toBe(29100);
    expect(parseClock("23:59:30")).toBe(86370);
    expect(() => parseClock("noon")).toThrow(TimeError);
  });

  it("formats clock times with a day marker", () => {
    expect(formatClock(29100)).toBe("08:05");
    expect(formatClock(DAY + 1800)).toBe("00:30 (+1)");
    expect(formatClock(-600)).toBe("23:50 (-1)");
  });

  it("counts minutes as the clock shows them, not by rounding seconds", () => {
    // Metro A 08:01:50 -> metro C 08:12:10 on PID was shown as "08:01 -> 08:12, 10 min".
    expect(minutesBetween(parseTime("08:01:50"), parseTime("08:12:10"))).toBe(11);
    expect(minutesBetween(parseTime("08:01:10"), parseTime("08:12:50"))).toBe(11);
    expect(minutesBetween(parseTime("08:05:00"), parseTime("08:05:59"))).toBe(0);
    expect(minutesBetween(-30, 30)).toBe(1); // 23:59 (-1) -> 00:00
  });

  it("uses those minutes in the CLI and in the API, next to the times they show", () => {
    const journey = { departure: parseTime("08:01:50"), arrival: parseTime("08:12:10"), transfers: 0, legs: [] };
    expect(formatJourney({} as Feed, journey)).toBe("08:01 -> 08:12  (11 min, direct)");
    expect(journeyJson({} as Loaded, journey)).toMatchObject({ departure: "08:01", arrival: "08:12", minutes: 11 });
  });

  it("handles dates", () => {
    expect(parseDate("2026-11-10")).toEqual({ year: 2026, month: 11, day: 10 });
    expect(parseDate("20261110")).toEqual({ year: 2026, month: 11, day: 10 });
    expect(() => parseDate("2026-02-30")).toThrow(TimeError);
    expect(addDays({ year: 2026, month: 3, day: 1 }, -1)).toEqual({ year: 2026, month: 2, day: 28 });
    expect(weekday({ year: 2026, month: 11, day: 9 })).toBe(0); // a Monday
    expect(weekday({ year: 2026, month: 11, day: 15 })).toBe(6); // a Sunday
  });
});
