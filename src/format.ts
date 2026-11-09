/** Turning journeys into text for the terminal. */
import type { Feed } from "./gtfs.js";
import type { Journey, Leg } from "./raptor.js";
import { formatClock } from "./time.js";

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

function minutes(seconds: number): string {
  return `${Math.round(seconds / 60)} min`;
}

export function formatLeg(feed: Feed, leg: Leg): string {
  const span = `${formatClock(leg.departure)}–${formatClock(leg.arrival)}`;
  if (leg.kind === "walk") {
    return `  ${span}  walk ${minutes(leg.arrival - leg.departure)}: ${stopLabel(feed, leg.from)} -> ${stopLabel(feed, leg.to)}`;
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
    `  (${minutes(journey.arrival - journey.departure)}, ` +
    `${journey.transfers === 0 ? "direct" : `${journey.transfers} transfer${journey.transfers > 1 ? "s" : ""}`})`;
  return [header, ...journey.legs.map((leg) => formatLeg(feed, leg))].join("\n");
}
