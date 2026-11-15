// The departures board: the next departures from a stop, refreshed every 30 s while the page is
// visible, with "in N min" counted down on the device's clock in between.
// Everything shown comes from the JSON API and is written with textContent, never as HTML.

const $ = (id) => document.getElementById(id);
const form = $("search");
const input = $("stop");
const status = $("status");
const table = $("departures");
const suggestionsBox = $("suggestions");

const REFRESH_MS = 30_000;
const TICK_MS = 15_000;

/** The board shown: the stop asked for and the departures with their times as Dates. */
let board;
let refreshTimer;

const pad = (n) => String(n).padStart(2, "0");
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const clock = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** A hex colour from the feed, or undefined (never trusted as arbitrary CSS). */
function color(hex) {
  return /^[0-9A-F]{6}$/i.test(hex) ? `#${hex}` : undefined;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setStatus(text, error = false) {
  status.textContent = text;
  status.classList.toggle("error", error);
}

// --- stop name suggestions ------------------------------------------------------------------

let typing;
input.addEventListener("input", () => {
  clearTimeout(typing);
  const q = input.value.trim();
  if (q.length < 2) return;
  typing = setTimeout(async () => {
    const response = await fetch(`/api/stops?${new URLSearchParams({ q })}`);
    if (!response.ok) return;
    $("stop-list").replaceChildren(
      ...(await response.json()).map((name) => {
        const option = document.createElement("option");
        option.value = name;
        return option;
      }),
    );
  }, 200);
});

// --- loading the board ----------------------------------------------------------------------

form.addEventListener("submit", (event) => {
  event.preventDefault();
  show(input.value);
});

async function show(stop) {
  history.replaceState(null, "", `?${new URLSearchParams({ stop })}`);
  suggestionsBox.hidden = true;
  clearTimeout(refreshTimer);
  setStatus("Loading…");
  await refresh(stop);
}

/** Ask for the departures from now (the device's clock) and draw them. */
async function refresh(stop) {
  const now = new Date();
  const query = new URLSearchParams({ stop, date: isoDate(now), time: clock(now) });
  let body;
  try {
    const response = await fetch(`/api/departures?${query}`);
    body = await response.json();
    if (!response.ok) {
      board = undefined;
      table.hidden = true;
      setStatus(body.error ?? `Error ${response.status}`, true);
      showSuggestions(body.suggestions ?? []);
      return;
    }
  } catch {
    // Keep the board shown and try again later: the countdown goes on meanwhile.
    setStatus("The server can't be reached; trying again.", true);
    schedule(stop);
    return;
  }
  input.value = body.stop;
  board = { stop: body.stop, at: now, departures: body.departures.map((d) => ({ ...d, time: when(now, body.time, d.minutes) })) };
  draw();
  setStatus(body.departures.length === 0 ? `No departures from ${body.stop} in the next 2 hours.` : "");
  $("updated").textContent = `Updated ${now.toLocaleTimeString("en-GB")}`;
  schedule(stop);
}

/** The departure as a Date: the request's minute plus the minutes the API counted. */
function when(now, time, minutes) {
  const [h, m] = time.split(":").map(Number);
  const asked = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
  return new Date(asked.getTime() + minutes * 60_000);
}

function schedule(stop) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (document.hidden) schedule(stop); // a hidden tab doesn't need fresh times
    else refresh(stop);
  }, REFRESH_MS);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && board && Date.now() - board.at.getTime() > REFRESH_MS) refresh(board.stop);
});

// --- drawing --------------------------------------------------------------------------------

/** "now", "1 min", "12 min", counted the way a clock shows it. */
function inMinutes(time, now = new Date()) {
  const minutes = Math.floor(time.getTime() / 60_000) - Math.floor(now.getTime() / 60_000);
  return minutes <= 0 ? "now" : `${minutes} min`;
}

function draw() {
  const now = new Date();
  $("caption").textContent = `Next departures from ${board.stop}`;
  // Departures that have left since the last refresh drop off the board.
  const shown = board.departures.filter((d) => d.time.getTime() >= now.getTime() - 60_000 + 1);
  table.tBodies[0].replaceChildren(
    ...shown.map((d) => {
      const row = el("tr");
      row.append(el("td", "time", d.departure));
      row.append(el("td", "in", inMinutes(d.time, now)));
      const line = el("td");
      const badge = el("span", "badge", d.line);
      badge.title = d.access === "yes" ? `${d.mode} · step-free` : d.mode;
      if (color(d.color)) badge.style.background = color(d.color);
      if (color(d.textColor)) badge.style.color = color(d.textColor);
      line.append(badge);
      row.append(line);
      row.append(el("td", "", d.headsign));
      row.append(el("td", "platform", d.platform));
      return row;
    }),
  );
  table.hidden = shown.length === 0;
}

setInterval(() => {
  if (board) draw();
}, TICK_MS);

/** "stop: no stop called ..." comes with names to choose from; a click shows that board. */
function showSuggestions(names) {
  if (names.length === 0) return;
  suggestionsBox.replaceChildren(
    ...names.map((name) => {
      const button = el("button", "", name);
      button.type = "button";
      button.addEventListener("click", () => {
        input.value = name;
        show(name);
      });
      return button;
    }),
  );
  suggestionsBox.hidden = false;
}

const params = new URLSearchParams(location.search);
if (params.get("stop")) {
  input.value = params.get("stop");
  show(params.get("stop"));
}
