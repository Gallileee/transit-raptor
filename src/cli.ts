/**
 * transit-raptor plan  --gtfs DIR --from NAME --to NAME [--date YYYY-MM-DD] [--time HH:MM] [--max-transfers N]
 * transit-raptor stops --gtfs DIR --search TEXT
 *
 * Exit codes: 0 = journeys found (or stops listed), 1 = no journey, 2 = bad input or feed.
 */
import { parseArgs } from "node:util";
import { formatJourney } from "./format.js";
import { FeedError, loadFeed } from "./gtfs.js";
import { plan } from "./raptor.js";
import { StopIndex, type StopMatch } from "./stops.js";
import { formatDate, parseClock, parseDate, type ServiceDate, TimeError } from "./time.js";
import { buildTimetable } from "./timetable.js";

const USAGE = `Usage:
  transit-raptor plan  --gtfs DIR --from NAME --to NAME [--date YYYY-MM-DD] [--time HH:MM] [--max-transfers N]
  transit-raptor stops --gtfs DIR --search TEXT

DIR is an unzipped GTFS feed (e.g. data/pid after npm run fetch-pid).
Date and time default to now (local time).`;

class UsageError extends Error {}

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
  now: () => Date;
}

const defaultIo: Io = { out: (l) => console.log(l), err: (l) => console.error(l), now: () => new Date() };

export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  try {
    return await run(argv, io);
  } catch (e) {
    if (e instanceof UsageError || e instanceof TimeError || e instanceof FeedError) {
      io.err(`transit-raptor: ${e.message}`);
      if (e instanceof UsageError) io.err(USAGE);
      return 2;
    }
    throw e;
  }
}

async function run(argv: string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        gtfs: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
        date: { type: "string" },
        time: { type: "string" },
        "max-transfers": { type: "string", default: "4" },
        search: { type: "string" },
      },
      strict: true,
    });
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  const { values } = parsed;
  if (command !== "plan" && command !== "stops") throw new UsageError(command ? `unknown command "${command}"` : "no command");
  if (!values.gtfs) throw new UsageError("--gtfs is required");

  const now = io.now();
  const date: ServiceDate = values.date
    ? parseDate(values.date)
    : { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };

  const started = performance.now();
  const feed = await loadFeed(values.gtfs, date);
  const index = new StopIndex(feed.stops);

  if (command === "stops") {
    if (!values.search) throw new UsageError("--search is required");
    const match = index.find(values.search, 30);
    const names =
      match.kind === "found" ? [match.name] : match.kind === "ambiguous" ? match.names : match.suggestions;
    for (const name of names) io.out(name);
    return names.length > 0 ? 0 : 1;
  }

  if (!values.from || !values.to) throw new UsageError("--from and --to are required");
  const maxTransfers = Number(values["max-transfers"]);
  if (!Number.isInteger(maxTransfers) || maxTransfers < 0 || maxTransfers > 10) {
    throw new UsageError("--max-transfers must be a whole number from 0 to 10");
  }
  const departAt = values.time ? parseClock(values.time) : now.getHours() * 3600 + now.getMinutes() * 60;
  const from = resolve(index, values.from, "--from");
  const to = resolve(index, values.to, "--to");

  const timetable = buildTimetable(feed);
  const loaded = performance.now();
  const journeys = plan(timetable, { from: from.stops, to: to.stops, departAt, maxTransfers });
  const searched = performance.now();

  io.err(
    `Loaded ${feed.trips.length} trips on ${formatDate(date)} (${timetable.patterns.length} patterns, ` +
      `${feed.stops.length} stops) in ${Math.round(loaded - started)} ms; search ${Math.round(searched - loaded)} ms`,
  );
  if (journeys.length === 0) {
    io.out(`No journey from ${from.name} to ${to.name} with at most ${maxTransfers} transfers.`);
    return 1;
  }
  io.out(`${from.name} -> ${to.name}, ${formatDate(date)}`);
  for (const journey of journeys) io.out(`\n${formatJourney(feed, journey)}`);
  return 0;
}

function resolve(index: StopIndex, text: string, option: string): { name: string; stops: number[] } {
  const match: StopMatch = index.find(text);
  if (match.kind === "found") return match;
  if (match.kind === "ambiguous") {
    throw new UsageError(`${option} "${text}" matches several stops: ${match.names.join(", ")}`);
  }
  const hint = match.suggestions.length > 0 ? `; did you mean: ${match.suggestions.join(", ")}` : "";
  throw new UsageError(`${option}: no stop called "${text}"${hint}`);
}
