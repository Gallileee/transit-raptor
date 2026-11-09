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
  history.replaceState(null, "", `?${query}`);

  setStatus("Searching…");
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
  const ms = Math.round(performance.now() - started);
  if (journeys.length === 0) {
    setStatus(`No journey from ${body.from} to ${body.to}.`);
    return;
  }
  setStatus(`${body.from} → ${body.to}, ${body.date}: ${journeys.length} journey${journeys.length > 1 ? "s" : ""} (${ms} ms)`);
  results.replaceChildren(...journeys.map(journeyItem));
  select(0);
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
    row.append(el("span", "time", leg.departure));
    if (leg.kind === "walk") {
      row.append(el("span", "badge walk", "walk"));
      const where =
        leg.from.name === leg.to.name && !leg.from.platform && !leg.to.platform
          ? `change platforms at ${leg.from.name}`
          : `${stopName(leg.from)} → ${stopName(leg.to)}`;
      row.append(el("span", "", `${leg.minutes} min: ${where}`));
    } else {
      const badge = el("span", "badge", leg.line);
      badge.title = leg.mode;
      if (color(leg.color)) badge.style.background = color(leg.color);
      if (color(leg.textColor)) badge.style.color = color(leg.textColor);
      row.append(badge);
      const towards = leg.headsign ? ` towards ${leg.headsign}` : "";
      row.append(el("span", "", `${stopName(leg.from)} → ${stopName(leg.to)}, ${leg.arrival}${towards}`));
    }
    legs.append(row);
  }
  item.append(legs);

  item.addEventListener("click", () => select(index));
  item.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select(index);
    }
  });
  return item;
}

function select(index) {
  [...results.children].forEach((item, i) => item.setAttribute("aria-selected", String(i === index)));
  draw(journeys[index]);
}

function draw(journey) {
  drawn.clearLayers();
  const bounds = [];
  journey.legs.forEach((leg, i) => {
    const line =
      leg.kind === "walk"
        ? L.polyline(leg.path, { color: "#6b7280", weight: 4, dashArray: "6 6" })
        : L.polyline(leg.path, { color: color(leg.color) ?? "#0b5cad", weight: 6, opacity: 0.9 });
    line.bindTooltip(leg.kind === "walk" ? `walk ${leg.minutes} min` : `${leg.mode} ${leg.line}`);
    line.addTo(drawn);
    bounds.push(...leg.path);
    // A dot where each leg starts, a bigger one at the end of the journey.
    L.circleMarker(leg.path[0], { radius: i === 0 ? 7 : 5, color: "#1c2430", weight: 2, fillColor: "#fff", fillOpacity: 1 })
      .bindTooltip(`${leg.departure} ${stopName(leg.from)}`)
      .addTo(drawn);
  });
  // The layout may have changed since the map was created (results appearing, a rotated phone);
  // without this, fitBounds works with the old size and cuts the route off.
  map.invalidateSize();
  const last = journey.legs[journey.legs.length - 1];
  L.circleMarker(last.path[last.path.length - 1], { radius: 7, color: "#1c2430", weight: 2, fillColor: "#1c2430", fillOpacity: 1 })
    .bindTooltip(`${last.arrival} ${stopName(last.to)}`)
    .addTo(drawn);
  map.fitBounds(bounds, { padding: [30, 30] });
}

if (params.get("from") && params.get("to")) search();
