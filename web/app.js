// The page: a search form, a list of journeys, and the selected one on a Leaflet map.
// Everything shown comes from the JSON API and is written with textContent, never as HTML.

const $ = (id) => document.getElementById(id);
const form = $("search");
const status = $("status");
const results = $("results");
const suggestionsBox = $("suggestions");

const map = L.map("map", { zoomControl: true }).setView([50.0835, 14.4341], 12);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
const drawn = L.layerGroup().addTo(map);

let journeys = [];
let stepFree = false;
/** The date of the journeys shown (YYYY-MM-DD), for links to the departures board. */
let searchDate;
/** Where the journeys shown go (the API's name), for searching on from a missed change. */
let destination;
/** The timetable in use: { firstDate, lastDate, loadedAt } from the API. */
let feed;

// --- form defaults and the URL --------------------------------------------------------------

const pad = (n) => String(n).padStart(2, "0");
const now = new Date();
$("date").value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
$("time").value = `${pad(now.getHours())}:${pad(now.getMinutes())}`;

const params = new URLSearchParams(location.search);
for (const name of ["from", "to", "date", "time", "window"]) {
  if (params.get(name)) form.elements[name].value = params.get(name);
}
$("list").checked = params.get("list") === "1";
$("stepFree").checked = params.get("stepFree") === "1";

$("swap").addEventListener("click", () => {
  [$("from").value, $("to").value] = [$("to").value, $("from").value];
});

// --- stop name suggestions ------------------------------------------------------------------

function autocomplete(input, list) {
  let timer;
  let last = "";
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2 || q === last) return;
    timer = setTimeout(async () => {
      last = q;
      const response = await fetch(`/api/stops?${new URLSearchParams({ q, date: $("date").value })}`);
      if (!response.ok) return;
      list.replaceChildren(
        ...(await response.json()).map((name) => {
          const option = document.createElement("option");
          option.value = name;
          return option;
        }),
      );
    }, 200);
  });
}
autocomplete($("from"), $("from-list"));
autocomplete($("to"), $("to-list"));

// --- searching ------------------------------------------------------------------------------

form.addEventListener("submit", (event) => {
  event.preventDefault();
  search();
});

async function search() {
  const query = new URLSearchParams({
    from: $("from").value,
    to: $("to").value,
    date: $("date").value,
    time: $("time").value,
    window: $("window").value,
  });
  if ($("list").checked) query.set("list", "1");
  if ($("stepFree").checked) query.set("stepFree", "1");
  history.replaceState(null, "", `?${query}`);

  setStatus("Searching…");
  $("notice").hidden = true;
  $("avoided").hidden = true;
  suggestionsBox.hidden = true;
  results.replaceChildren();
  drawn.clearLayers();
  const started = performance.now();
  let body;
  try {
    const response = await fetch(`/api/plan?${query}`);
    body = await response.json();
    if (!response.ok) {
      setStatus(body.error ?? `Error ${response.status}`, true);
      showSuggestions(body.suggestions ?? [], body.error ?? "");
      return;
    }
  } catch {
    setStatus("The server can't be reached.", true);
    return;
  }
  journeys = body.journeys;
  stepFree = body.stepFree;
  searchDate = body.date;
  destination = body.to;
  showFeed(body.feed);
  showAvoided(body.avoided ?? []);
  const ms = Math.round(performance.now() - started);
  if (journeys.length === 0) {
    const outside = feed.firstDate && (body.date < feed.firstDate || body.date > feed.lastDate);
    setStatus(
      outside
        ? `No journeys on ${day(body.date)}: the timetable covers ${day(feed.firstDate)} to ${day(feed.lastDate)}.`
        : `No${stepFree ? " step-free" : ""} journey from ${body.from} to ${body.to}.`,
    );
    return;
  }
  showNotice(body.date);
  const kind = stepFree ? " step-free" : "";
  const live = { on: " · live delays from PID", error: " · live delays unavailable" }[body.live] ?? "";
  setStatus(`${body.from} → ${body.to}, ${body.date}: ${journeys.length}${kind} journey${journeys.length > 1 ? "s" : ""} (${ms} ms)${live}`);
  results.replaceChildren(...journeys.map(journeyItem));
  select(0);
}

/** Rides live data said are cancelled, which the journeys shown were planned around. */
function showAvoided(avoided) {
  const box = $("avoided");
  box.hidden = avoided.length === 0;
  if (box.hidden) return;
  const what = avoided.length === 1 ? "a cancelled trip" : `${avoided.length} cancelled trips`;
  const list = avoided.map((a) => `${a.mode} ${a.line} at ${a.departure} from ${stopName(a.from)}`).join(", ");
  box.textContent = `Planned around ${what}: ${list}.`;
}

/**
 * A date outside the timetable can still have journeys: PID's trains are published for the
 * whole year, the rest two weeks ahead. Then the journeys shown may not be the best ones.
 */
function showNotice(date) {
  if (!feed?.firstDate) return;
  const where =
    date > feed.lastDate
      ? `after the timetable's last date, ${day(feed.lastDate)}`
      : date < feed.firstDate
        ? `before the timetable's first date, ${day(feed.firstDate)}`
        : "";
  if (!where) return;
  const notice = $("notice");
  notice.textContent =
    `${day(date)} is ${where}: only lines whose timetables reach that day are included, ` +
    "so a better journey may be missing.";
  notice.hidden = false;
}

function setStatus(text, error = false) {
  status.textContent = text;
  status.classList.toggle("error", error);
}

/** "from: no stop called ..." comes with names to choose from; a click fills the field. */
function showSuggestions(names, error) {
  if (names.length === 0) return;
  const field = error.startsWith("to") ? $("to") : $("from");
  suggestionsBox.replaceChildren(
    ...names.map((name) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = name;
      button.addEventListener("click", () => {
        field.value = name;
        search();
      });
      return button;
    }),
  );
  suggestionsBox.hidden = false;
}

// --- the timetable in use -------------------------------------------------------------------

/** "2026-11-30" -> "30 Nov 2026". */
function day(iso) {
  return new Date(`${iso}T00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * In the footer: the dates the timetable covers and when the server loaded it. Every answer
 * carries this, so after the server swaps in a new download the page shows the new one.
 */
function showFeed(info) {
  if (!info) return;
  feed = info;
  const box = $("feed");
  const loaded = new Date(info.loadedAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const today = isoToday();
  let text;
  let warn = false;
  if (!info.firstDate) {
    text = "no dates with service";
    warn = true;
  } else if (today > info.lastDate) {
    text = `ended on ${day(info.lastDate)}`;
    warn = true;
  } else if (today < info.firstDate) {
    text = `starts on ${day(info.firstDate)}`;
    warn = true;
  } else {
    text = `valid ${day(info.firstDate)} to ${day(info.lastDate)}`;
  }
  box.textContent = `, ${text} (loaded ${loaded})`;
  box.classList.toggle("warn", warn);
}

function isoToday() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// A search answered first (one in the URL) already told us, and may be newer.
fetch("/api/feed")
  .then((response) => (response.ok ? response.json() : undefined))
  .then((info) => feed || showFeed(info), () => {});

// --- showing journeys -----------------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A hex colour from the feed, or undefined (never trusted as arbitrary CSS). */
function color(hex) {
  return /^[0-9A-F]{6}$/i.test(hex) ? `#${hex}` : undefined;
}

function stopName(stop) {
  return stop.platform ? `${stop.name} (${stop.platform})` : stop.name;
}

function journeyItem(journey, index) {
  const item = el("li", "journey");
  item.tabIndex = 0;
  item.setAttribute("role", "option");
  item.setAttribute("aria-selected", "false");

  const title = el("h2");
  title.append(el("span", "", `${journey.departure} → ${journey.arrival}`));
  const changes = journey.transfers === 0 ? "direct" : `${journey.transfers} change${journey.transfers > 1 ? "s" : ""}`;
  title.append(el("span", "meta", `${journey.minutes} min · ${changes}`));
  item.append(title);

  const legs = el("ol", "legs");
  for (const leg of journey.legs) {
    const row = el("li", "leg");
    const time = el("span", "time", leg.departure);
    // Live, for rides of the next hour: "+3 min" or "on time" under the time.
    if (leg.kind === "ride" && leg.delay !== null && !leg.canceled) {
      const late = delayText(leg.delay);
      time.append(el("span", late === "on time" ? "delay on-time" : "delay", late));
    }
    row.append(time);
    if (leg.kind === "walk") {
      row.append(el("span", "badge walk", "walk"));
      const where =
        leg.from.name === leg.to.name && !leg.from.platform && !leg.to.platform
          ? `change platforms at ${leg.from.name}`
          : `${stopName(leg.from)} → ${stopName(leg.to)}`;
      // Muzeum step-free: up one lift to the street and down another. Hlavní nádraží: out of one
      // side platform's gates and into the other's, through the shared vestibule.
      const street = leg.street ? ", out one entrance and in another" : "";
      row.append(el("span", "", `${leg.minutes} min: ${where}${street}`));
    } else {
      const badge = el("span", "badge", leg.line);
      badge.title = leg.mode;
      if (color(leg.color)) badge.style.background = color(leg.color);
      if (color(leg.textColor)) badge.style.color = color(leg.textColor);
      row.append(badge);
      const towards = leg.headsign ? ` towards ${leg.headsign}` : "";
      // Where one gets on links to that stop's departures at that time: the other ways to go.
      const text = el("span");
      text.append(boardLink(leg.from, leg.departure), ` → ${stopName(leg.to)}, ${leg.arrival}${towards}`);
      // In a step-free search, say where the feed doesn't confirm access (it never shows "no").
      if (stepFree && leg.access === "unknown") text.append(el("span", "unconfirmed", " · step-free access not confirmed"));
      if (leg.access === "yes") badge.title += " · step-free";
      row.append(text);
      if (leg.canceled) row.append(el("span", "risk", `${leg.mode} ${leg.line} at ${leg.departure} is canceled`));
      else if (leg.changeAtRisk) row.append(el("span", "risk", "The vehicle before is late: this change may be missed"));
      if (journey.fallback?.leg === journey.legs.indexOf(leg)) row.append(fallbackLine(journey.fallback, index));
      if (leg.passed.length > 0) row.append(passedList(leg.passed));
    }
    legs.append(row);
  }
  item.append(legs);

  item.addEventListener("click", () => select(index));
  item.addEventListener("keydown", (event) => {
    if (event.target !== item) return; // Enter on a link inside follows the link
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select(index);
    }
  });
  return item;
}

/**
 * A time of the journey as a date and a clock: "08:05" on the search date, or "00:10 (+1)" the
 * day after (a journey past midnight). Undefined when it can't be read.
 */
function dateAndClock(time) {
  const [, clock, days = "0"] = /^(\d{1,2}:\d{2})(?: \(([+-]?\d+)\))?$/.exec(time) ?? [];
  if (!clock || !searchDate) return undefined;
  const [y, m, d] = searchDate.split("-").map(Number);
  const date = new Date(y, m - 1, d + Number(days));
  return { date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`, time: clock };
}

/** The departures board of a stop at a time of the journey. */
function boardUrl(stop, time) {
  const at = dateAndClock(time);
  return `/departures?${new URLSearchParams(at ? { stop: stop.name, ...at } : { stop: stop.name })}`;
}

/**
 * Under a cancelled ride or a change at risk: how to go on without it, from where the ride
 * before leaves one (or where the journey starts), with a link that searches from there.
 */
function fallbackLine(fallback, index) {
  const box = el("span", "fallback");
  const lead = fallbackLead(fallback);
  const rides = fallback.journey?.legs.filter((l) => l.kind === "ride") ?? [];
  if (!fallback.journey) {
    box.append(`${lead}: nothing more from ${stopName(fallback.from)} today. `);
  } else if (rides.length === 0) {
    box.append(`${lead}: walk from ${stopName(fallback.from)}, arriving ${fallback.journey.arrival}. `);
  } else {
    const how = rides.map((r) => `${r.mode} ${r.line} at ${r.departure} from ${stopName(r.from)}`).join(", then ");
    const later = fallback.later > 0 ? ` (${fallback.later} min later)` : "";
    box.append(`${lead}: ${how}, arriving ${fallback.journey.arrival}${later}. `);
  }
  // From when the journey found leaves: searching from the stop's name at the time one gets off
  // would offer the vehicle that may be gone again, from the stop's other platforms.
  const at = dateAndClock(fallback.journey?.departure ?? fallback.at);
  if (at && destination) {
    const query = new URLSearchParams({ from: fallback.from.name, to: destination, ...at, window: "0" });
    if (stepFree) query.set("stepFree", "1");
    const link = el("a", "", "Search from there");
    link.href = `/?${query}`;
    box.append(link);
  }
  // The way on is drawn with the journey (dotted); this zooms the map to it.
  if (fallback.journey) {
    const button = el("button", "map-link", "Show on map");
    button.type = "button";
    button.addEventListener("click", (event) => {
      event.stopPropagation(); // the journey's own click would fit the map to all of it
      select(index);
      map.fitBounds(fallbackBounds, { padding: [30, 30] });
      // On a phone the map is under the list.
      $("map").scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    box.append(" ", button);
  }
  return box;
}

function fallbackLead(fallback) {
  return fallback.reason === "canceled" ? "Instead" : "If you miss it";
}

function boardLink(stop, time) {
  const link = el("a", "stop-link", stopName(stop));
  link.href = boardUrl(stop, time);
  link.title = `Departures from ${stop.name} at ${time}`;
  return link;
}

/** A dot's popup on the map: the stop, its time, and a link to its departures. */
function dotPopup(stop, time) {
  const box = el("div", "dot-popup");
  box.append(el("strong", "", `${time} ${stopName(stop)}`), el("br"));
  const link = el("a", "", "Departures from here");
  link.href = boardUrl(stop, time);
  box.append(link);
  return box;
}

/** "+3 min", "on time", "-1 min" (early) from seconds late, as the departures board says it. */
function delayText(seconds) {
  const minutes = Math.trunc(seconds / 60); // under a minute either way is on time
  return minutes === 0 ? "on time" : minutes > 0 ? `+${minutes} min` : `${minutes} min`;
}

/** "3 stops in between", opened to list them with their times. */
function passedList(passed) {
  const details = el("details", "passed");
  details.append(el("summary", "", `${passed.length} stop${passed.length > 1 ? "s" : ""} in between`));
  const list = el("ol");
  for (const stop of passed) {
    const item = el("li");
    item.append(el("span", "time", stop.arrival), el("span", "", stopName(stop)));
    list.append(item);
  }
  details.append(list);
  // Opening the list shouldn't count as a key press on the journey (Enter/Space selects it).
  details.addEventListener("keydown", (event) => event.stopPropagation());
  return details;
}

function select(index) {
  [...results.children].forEach((item, i) => item.setAttribute("aria-selected", String(i === index)));
  draw(journeys[index]);
}

/** Where the selected journey's way on without its ride at risk is drawn ([] when there's none). */
let fallbackBounds = [];

function draw(journey) {
  drawn.clearLayers();
  // First, so the journey itself is drawn over it where the two share a street.
  fallbackBounds = journey.fallback?.journey ? drawFallback(journey.fallback) : [];
  const bounds = [...fallbackBounds];
  journey.legs.forEach((leg, i) => {
    const canceled = leg.kind === "ride" && leg.canceled;
    const line =
      leg.kind === "walk"
        ? L.polyline(leg.path, { color: "#6b7280", weight: 4, dashArray: "6 6" })
        : canceled
          ? // Faded and broken: it won't run.
            L.polyline(leg.path, { color: color(leg.color) ?? "#0b5cad", weight: 6, opacity: 0.35, dashArray: "12 8", className: "canceled-leg" })
          : L.polyline(leg.path, { color: color(leg.color) ?? "#0b5cad", weight: 6, opacity: 0.9 });
    line.bindTooltip(leg.kind === "walk" ? `walk ${leg.minutes} min` : `${leg.mode} ${leg.line}${canceled ? " (canceled)" : ""}`);
    line.addTo(drawn);
    bounds.push(...leg.path);
    // Small dots in the line's colour where the vehicle stops on the way.
    for (const stop of leg.kind === "ride" ? leg.passed : []) {
      L.circleMarker([stop.lat, stop.lon], {
        radius: 3.5,
        color: color(leg.color) ?? "#0b5cad",
        weight: 2,
        fillColor: "#fff",
        fillOpacity: 1,
        className: "passed-stop",
      })
        .bindTooltip(`${stop.arrival} ${stopName(stop)}`)
        .addTo(drawn);
    }
    // A dot where each leg starts, a bigger one at the end of the journey. They sit on the
    // stops themselves: a line drawn along the street may start a few metres beside the stop.
    L.circleMarker([leg.from.lat, leg.from.lon], { radius: i === 0 ? 7 : 5, color: "#1c2430", weight: 2, fillColor: "#fff", fillOpacity: 1 })
      .bindTooltip(`${leg.departure} ${stopName(leg.from)}`)
      .bindPopup(dotPopup(leg.from, leg.departure))
      .addTo(drawn);
  });
  // The layout may have changed since the map was created (results appearing, a rotated phone);
  // without this, fitBounds works with the old size and cuts the route off.
  map.invalidateSize();
  const last = journey.legs[journey.legs.length - 1];
  L.circleMarker([last.to.lat, last.to.lon], { radius: 7, color: "#1c2430", weight: 2, fillColor: "#1c2430", fillOpacity: 1 })
    .bindTooltip(`${last.arrival} ${stopName(last.to)}`)
    .bindPopup(dotPopup(last.to, last.arrival))
    .addTo(drawn);
  map.fitBounds(bounds, { padding: [30, 30] });
}

/**
 * The way on if a change is missed (or a ride is cancelled), dotted in each line's colour, with
 * a small dot where each of its rides is boarded. Returns the points drawn, for fitting the map.
 */
function drawFallback(fallback) {
  const lead = fallbackLead(fallback);
  const points = [];
  for (const leg of fallback.journey.legs) {
    const ride = leg.kind === "ride";
    const lineColor = ride ? (color(leg.color) ?? "#0b5cad") : "#6b7280";
    L.polyline(leg.path, {
      color: lineColor,
      weight: ride ? 5 : 3,
      opacity: 0.85,
      dashArray: ride ? "1 10" : "1 7",
      lineCap: "round",
      className: "fallback-leg",
    })
      .bindTooltip(`${lead}: ${ride ? `${leg.mode} ${leg.line} at ${leg.departure}` : `walk ${leg.minutes} min`}`)
      .addTo(drawn);
    points.push(...leg.path);
    if (!ride) continue;
    L.circleMarker([leg.from.lat, leg.from.lon], { radius: 4, color: lineColor, weight: 2, fillColor: "#fff", fillOpacity: 1, className: "fallback-stop" })
      .bindTooltip(`${lead}: ${leg.departure} ${stopName(leg.from)}`)
      .bindPopup(dotPopup(leg.from, leg.departure))
      .addTo(drawn);
  }
  return points;
}

if (params.get("from") && params.get("to")) search();
