// The departures board: the next departures from a stop, refreshed every 30 s while the page is
// visible, with "in N min" counted down on the device's clock in between. With ?date=&time= in
// the address (a link from a journey) it shows the board for that moment instead, and stays.
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
/** A board for another moment ({ date: "YYYY-MM-DD", time: "HH:MM" }), or undefined for now. */
let planned;

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
  show(input.value); // a stop typed in: from now
});

async function show(stop, at = undefined) {
  planned = at;
  history.replaceState(null, "", `?${new URLSearchParams({ stop, ...at })}`);
  suggestionsBox.hidden = true;
  clearTimeout(refreshTimer);
  setStatus("Loading…");
  await refresh(stop);
}

/** Ask for the departures from now (the device's clock), or the planned moment, and draw them. */
async function refresh(stop) {
  const now = new Date();
  const query = new URLSearchParams({ stop, ...(planned ?? { date: isoDate(now), time: clock(now) }) });
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
  const asked = moment(body.date, body.time);
  board = {
    stop: body.stop,
    at: now,
    // A planned board counts from its own moment and doesn't move.
    reference: planned ? asked : undefined,
    // When it is expected to leave: the timetable's time plus the live delay, if there is one.
    departures: body.departures.map((d) => ({ ...d, time: new Date(asked.getTime() + d.expectedMinutes * 60_000) })),
  };
  draw();
  const later = planned ? ` after ${body.time} on ${day(body.date)}` : " in the next 2 hours";
  setStatus(body.departures.length === 0 ? `No departures from ${body.stop}${later}.` : "");
  const updated = $("updated");
  if (planned) {
    const live = el("a", "", "Show departures from now");
    live.href = `?${new URLSearchParams({ stop: body.stop })}`;
    live.addEventListener("click", (event) => {
      event.preventDefault();
      show(body.stop);
    });
    updated.replaceChildren(`Timetable for ${day(body.date)} at ${body.time} · `, live);
  } else {
    const live = { on: " · live delays from PID", error: " · live delays unavailable, timetable times" }[body.live] ?? "";
    updated.textContent = `Updated ${now.toLocaleTimeString("en-GB")}${live}`;
    schedule(stop);
  }
}

/** "2026-11-16", "08:05" -> that minute, local time. */
function moment(date, time) {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, m] = time.split(":").map(Number);
  return new Date(y, mo - 1, d, h, m);
}

/** "2026-11-30" -> "30 Nov 2026". */
function day(iso) {
  return new Date(`${iso}T00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function schedule(stop) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    if (document.hidden) schedule(stop); // a hidden tab doesn't need fresh times
    else refresh(stop);
  }, REFRESH_MS);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && board && !planned && Date.now() - board.at.getTime() > REFRESH_MS) refresh(board.stop);
});

// --- drawing --------------------------------------------------------------------------------

/** "+3 min", "on time", "-1 min" (early) from seconds late, as the CLI says it. */
function delayText(seconds) {
  const minutes = Math.trunc(seconds / 60); // under a minute either way is on time
  return minutes === 0 ? "on time" : minutes > 0 ? `+${minutes} min` : `${minutes} min`;
}

/** "now", "1 min", "12 min", counted the way a clock shows it. */
function inMinutes(time, now = new Date()) {
  const minutes = Math.floor(time.getTime() / 60_000) - Math.floor(now.getTime() / 60_000);
  return minutes <= 0 ? "now" : `${minutes} min`;
}

function draw() {
  const now = board.reference ?? new Date();
  $("caption").textContent = `Next departures from ${board.stop}`;
  // Departures that have left since the last refresh drop off the board.
  const shown = board.departures.filter((d) => d.time.getTime() >= now.getTime() - 60_000 + 1);
  table.tBodies[0].replaceChildren(
    ...shown.map((d) => {
      const row = el("tr");
      const time = el("td", "time", d.departure);
      if (d.delay !== null && d.delay !== undefined && !d.canceled) {
        const late = delayText(d.delay);
        time.append(" ", el("span", late === "on time" ? "delay on-time" : "delay", late));
      }
      row.append(time);
      if (d.canceled) row.classList.add("canceled");
      row.append(el("td", "in", d.canceled ? "canceled" : inMinutes(d.time, now)));
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
        show(name, planned);
      });
      return button;
    }),
  );
  suggestionsBox.hidden = false;
}

const params = new URLSearchParams(location.search);
if (params.get("stop")) {
  input.value = params.get("stop");
  const [date, time] = [params.get("date"), params.get("time")];
  const at = /^\d{4}-\d{2}-\d{2}$/.test(date ?? "") && /^\d{1,2}:\d{2}$/.test(time ?? "") ? { date, time } : undefined;
  show(params.get("stop"), at);
}
