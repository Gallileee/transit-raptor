/**
 * Comparing the journeys of two versions of the planner on the same queries: a regression
 * check for changes to the algorithm or the feed reading, run on a real feed
 * (`npm run compare-journeys`, see scripts/compare-journeys.mjs).
 *
 * Each side resolves stop names and plans on its own build, so the two can differ in anything
 * but the shape of a journey. Journeys are compared by stop and trip ids, not indices.
 * Besides the differences, every journey of the new side is checked for things that are never
 * right (two walks in a row, time going backwards), whatever the old side did.
 */
import type { Journey, Query } from "./raptor.js";
import { formatClock } from "./time.js";

/** One version of the planner, on one date. */
export interface Side {
  /** The stops of a stop name, or undefined if the name isn't known. */
  resolve(name: string): number[] | undefined;
  plan(query: Query): Journey[];
  stopId(index: number): string;
}

export interface SampledQuery {
  readonly from: string;
  readonly to: string;
  readonly departAt: number;
}

/** A small deterministic generator (LCG), so a seed always gives the same queries. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/**
 * `count` queries between two different names, leaving between 06:00 and 21:59 (whole
 * minutes). The same names, count and seed give the same queries.
 */
export function sampleQueries(names: readonly string[], count: number, seed: number): SampledQuery[] {
  const unique = [...new Set(names)].sort();
  if (unique.length < 2) return [];
  const next = random(seed);
  const pick = () => unique[Math.floor(next() * unique.length)]!;
  const queries: SampledQuery[] = [];
  while (queries.length < count) {
    const from = pick();
    const to = pick();
    const departAt = (6 * 60 + Math.floor(next() * 16 * 60)) * 60;
    if (from !== to) queries.push({ from, to, departAt });
  }
  return queries;
}

/** A journey as text with stop and trip ids: equal text, equal journey. */
export function journeyKey(journey: Journey, stopId: (index: number) => string): string {
  const legs = journey.legs.map((leg) =>
    leg.kind === "walk"
      ? `walk ${stopId(leg.from)}>${stopId(leg.to)} ${formatClock(leg.departure)}-${formatClock(leg.arrival)}`
      : `${leg.routeId}/${leg.tripId} ${stopId(leg.from)}>${stopId(leg.to)} ${formatClock(leg.departure)}-${formatClock(leg.arrival)}`,
  );
  return `${formatClock(journey.departure)}-${formatClock(journey.arrival)} x${journey.transfers}: ${legs.join(" | ")}`;
}

/** What is wrong with a journey, if anything. */
export function journeyProblems(journey: Journey, departAt: number): string[] {
  const problems: string[] = [];
  if (journey.legs.length === 0) problems.push("no legs");
  if (journey.departure < departAt) problems.push("leaves before the query time");
  journey.legs.forEach((leg, i) => {
    if (leg.arrival < leg.departure) problems.push(`leg ${i + 1} arrives before it leaves`);
    const before = journey.legs[i - 1];
    if (!before) return;
    if (leg.kind === "walk" && before.kind === "walk") problems.push(`legs ${i} and ${i + 1} are two walks in a row`);
    if (leg.departure < before.arrival) problems.push(`leg ${i + 1} leaves before leg ${i} arrives`);
    if (leg.from !== before.to) problems.push(`leg ${i + 1} doesn't start where leg ${i} ends`);
  });
  const rides = journey.legs.filter((leg) => leg.kind === "ride").length;
  if (journey.transfers !== Math.max(0, rides - 1)) problems.push("the number of changes doesn't match the rides");
  return problems;
}

export interface Difference {
  readonly query: SampledQuery;
  readonly base: string[];
  readonly head: string[];
  /** Earliest arrival on each side (Infinity: no journey). */
  readonly baseArrival: number;
  readonly headArrival: number;
}

export interface Report {
  /** Queries both sides could resolve and plan. */
  readonly compared: number;
  /** Queries a side couldn't resolve (a stop name only one version knows). */
  readonly skipped: number;
  readonly same: number;
  readonly differences: Difference[];
  readonly problems: { query: SampledQuery; journey: string; problems: string[] }[];
}

/**
 * One side's answer to one query, as plain data (so a worker thread can send it): its journeys
 * as keys, the earliest arrival (Infinity: none) and what is wrong with any of them.
 */
export interface Planned {
  readonly keys: string[];
  readonly arrival: number;
  readonly problems: { journey: string; problems: string[] }[];
}

/** Plan each query on one side: null where the side can't resolve a stop name. */
export function planQueries(queries: readonly SampledQuery[], side: Side, maxTransfers = 4): (Planned | null)[] {
  return queries.map((query) => {
    const from = side.resolve(query.from);
    const to = side.resolve(query.to);
    if (!from || !to) return null;
    const journeys = side.plan({ from, to, departAt: query.departAt, maxTransfers });
    const key = (j: Journey) => journeyKey(j, (i) => side.stopId(i));
    return {
      keys: journeys.map(key),
      arrival: Math.min(...journeys.map((j) => j.arrival)),
      problems: journeys.flatMap((j) => {
        const found = journeyProblems(j, query.departAt);
        return found.length > 0 ? [{ journey: key(j), problems: found }] : [];
      }),
    };
  });
}

/** Compare two sides' answers to the same queries; problems are the new side's only. */
export function compareResults(queries: readonly SampledQuery[], base: readonly (Planned | null)[], head: readonly (Planned | null)[]): Report {
  let compared = 0;
  let skipped = 0;
  let same = 0;
  const differences: Difference[] = [];
  const problems: Report["problems"] = [];
  queries.forEach((query, i) => {
    const before = base[i];
    const after = head[i];
    if (!before || !after) {
      skipped++;
      return;
    }
    compared++;
    for (const p of after.problems) problems.push({ query, ...p });
    if (before.keys.join("\n") === after.keys.join("\n")) {
      same++;
      return;
    }
    differences.push({ query, base: before.keys, head: after.keys, baseArrival: before.arrival, headArrival: after.arrival });
  });
  return { compared, skipped, same, differences, problems };
}

/** Plan every query on both sides and compare the journeys (all of them, not only the first). */
export function compareJourneys(queries: readonly SampledQuery[], base: Side, head: Side, maxTransfers = 4): Report {
  return compareResults(queries, planQueries(queries, base, maxTransfers), planQueries(queries, head, maxTransfers));
}

/** The report as lines of text: totals, then up to `examples` differences and every problem. */
export function formatReport(report: Report, examples = 10): string[] {
  const { differences } = report;
  const earlier = differences.filter((d) => d.headArrival < d.baseArrival).length;
  const later = differences.filter((d) => d.headArrival > d.baseArrival).length;
  const lines = [
    `${report.compared} queries compared (${report.skipped} skipped: a stop name only one version knows)`,
    `${report.same} identical, ${differences.length} different: ${earlier} arrive earlier, ${later} later, ` +
      `${differences.length - earlier - later} at the same time another way`,
    `${report.problems.length} journeys with problems`,
  ];
  const query = (q: SampledQuery) => `${q.from} -> ${q.to} at ${formatClock(q.departAt)}`;
  for (const d of differences.slice(0, examples)) {
    lines.push("", query(d.query));
    for (const j of d.base) lines.push(`  - ${j}`);
    for (const j of d.head) lines.push(`  + ${j}`);
  }
  for (const p of report.problems) {
    lines.push("", `PROBLEM ${query(p.query)}: ${p.problems.join("; ")}`, `  ${p.journey}`);
  }
  return lines;
}
