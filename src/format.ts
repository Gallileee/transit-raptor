/** Turning journeys into text for the terminal. */
import type { Feed } from "./gtfs.js";
import type { Journey, Leg } from "./raptor.js";
import { formatClock, minutesBetween } from "./time.js";

const MODES: Record<number, string> = {
  0: "tram",
  1: "metro",
  2: "train",
  3: "bus",
  4: "ferry",
  5: "cable car",
  6: "aerial lift",
  7: "funicular",
  11: "trolleybus",
  12: "monorail",
};

function stopLabel(feed: Feed, index: number): string {
  const stop = feed.stops[index]!;
  return stop.platform ? `${stop.name} (${stop.platform})` : stop.name;
}

function minutes(from: number, to: number): string {
  return `${minutesBetween(from, to)} min`;
}

export function formatLeg(feed: Feed, leg: Leg): string {
  const span = `${formatClock(leg.departure)}–${formatClock(leg.arrival)}`;
  if (leg.kind === "walk") {
    const from = feed.stops[leg.from]!;
    const to = feed.stops[leg.to]!;
    const where =
      from.name === to.name && !from.platform && !to.platform
        ? `change platforms at ${from.name}`
        : `${stopLabel(feed, leg.from)} -> ${stopLabel(feed, leg.to)}`;
    return `  ${span}  walk ${Math.max(1, minutesBetween(leg.departure, leg.arrival))} min: ${where}`;
  }
  const route = feed.routes.get(leg.routeId);
  const mode = route ? (MODES[route.type] ?? "line") : "line";
  const name = route?.shortName || route?.longName || leg.routeId;
  const towards = leg.headsign ? ` towards ${leg.headsign}` : "";
  const stops = `${leg.stopCount} stop${leg.stopCount === 1 ? "" : "s"}`;
  return `  ${span}  ${mode} ${name}${towards}: ${stopLabel(feed, leg.from)} -> ${stopLabel(feed, leg.to)} (${stops})`;
}

export function formatJourney(feed: Feed, journey: Journey): string {
  const header =
    `${formatClock(journey.departure)} -> ${formatClock(journey.arrival)}` +
    `  (${minutes(journey.departure, journey.arrival)}, ` +
    `${journey.transfers === 0 ? "direct" : `${journey.transfers} transfer${journey.transfers > 1 ? "s" : ""}`})`;
  return [header, ...journey.legs.map((leg) => formatLeg(feed, leg))].join("\n");
}
