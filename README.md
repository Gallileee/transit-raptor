# transit-raptor

A journey planner for public transport, built on the **RAPTOR** algorithm and real timetables
in the **GTFS** format. Point it at Prague's PID timetable, name two stops, and it finds the
connections: the fastest one for each number of transfers. On the command line, or on a web
page with a map:

```
$ transit-raptor plan --gtfs data/pid --from "Anděl" --to "Letiště" --time 08:00
$ transit-raptor serve --gtfs data/pid          # http://127.0.0.1:8080/
```

![The web page: three journeys from Anděl to the airport, the selected one on the map in the lines' own colours](docs/screenshot.jpg)

## Why

Journey planners look simple from the outside and are a classic algorithms problem on the
inside. A city like Prague has thousands of stops, tens of thousands of trips a day and
millions of stop times; "how do I get from A to B" has to be answered in milliseconds. This
project implements the algorithm from the paper rather than calling an API, and runs it on a
real, openly licensed timetable.

It is a learning project: [OpenTripPlanner](https://www.opentripplanner.org/) and
[MOTIS](https://github.com/motis-project/motis) are what production systems use.

## How it works

1. **Loading** (`gtfs.ts`, `cache.ts`). A GTFS feed is a zip of CSV files. They are read once
   (`stop_times.txt` streamed line by line, `csv.ts`) into a *compiled feed*: every trip of every
   date, its stop times sorted into typed columns. A date is then cut out of it in milliseconds:
   the services from `calendar.txt` minus/plus the exceptions in `calendar_dates.txt`, plus trips
   of the *previous* day that are still running after midnight (GTFS writes those as `24:20:00`).
   Trips of that day are views into the shared columns, so a second date costs almost nothing.
   The compiled feed and the shapes are saved in a **binary cache** (typed arrays as they are in
   memory, the small tables as JSON, a CRC-32, and a fingerprint of every feed file's size and
   modification time), so the next start reads one file instead of parsing 300 MB of CSV:
   2.9 s -> 0.36 s for Prague. A changed, damaged or foreign cache file is ignored and rewritten.
2. **Timetable** (`timetable.ts`). Trips with the same stops in the same order form a
   *pattern*, sorted by departure. A trip that overtakes another (an express) gets a pattern of
   its own, because RAPTOR finds "the first trip I can still catch" with a binary search, which
   only works if trips never overtake. Walking connections come from a spatial grid (stops
   within 300 m, at 1.2 m/s with a 1.3 detour factor, at least 60 s, plus 45 s for every level
   of height difference from `levels.txt`, i.e. escalators) and from `transfers.txt`.
3. **Changes inside stations** (`stations.ts`). Where the feed has `pathways.txt`, a station is
   a directed graph: each platform's *boarding areas* (spots along the platform), corridor
   nodes and entrances, joined by walkways, stairs, escalators (often one way) and elevators.
   A change is the shortest path through it (Dijkstra with a binary heap): platform to platform,
   or out through the best entrance to a stop on the street. Getting off, the time is the
   *average* over the platform's boarding areas (one is wherever one's carriage stopped);
   getting on, the *nearest* boarding area counts. A 45 s buffer is added for getting off and
   on. These times replace the distance estimate in those stations, in both directions.
   The graph also walks along the street between a station's entrances, so a path can leave
   by one entrance and come back in by another, or reach a stop beyond the nearest one's
   walking range; a change between platforms that does this says "out one entrance and in
   another" (at Muzeum, step-free, that is up to the street; at Hlavní nádraží, whose two
   side platforms the feed joins only outside their entrances, it is through the vestibule).
4. **RAPTOR** (`raptor.ts`), from Delling, Pajor & Werneck,
   [*Round-Based Public Transit Routing*](https://www.microsoft.com/en-us/research/?p=162045)
   (Transportation Science, 2015). Round *k* finds the earliest arrival at every stop using at
   most *k* vehicles: scan every pattern that serves a stop improved in round *k − 1* (each
   pattern once), then walk. The result is one journey per number of vehicles, kept if it
   arrives earlier than all journeys with fewer transfers: the **Pareto set** over arrival time
   and transfers. No preprocessing is needed, so a new timetable works the moment it's loaded.
   Pareto-optimal but useless journeys are dropped: anything arriving more than
   max(30 min, the fastest travel time) after the fastest journey (otherwise "direct, by the
   first night bus" shows up next to a ten-minute metro ride).
5. **rRAPTOR** (range queries, from the same paper). "Leaving at 8:00" really means "around
   8:00": RAPTOR alone takes the first vehicle that leaves, even when a later one arrives just
   as early. rRAPTOR runs RAPTOR for every departure from the origin in a window (default 60
   min), from the latest to the earliest, without resetting the labels: what a later departure
   reached stays as a bound, so an earlier one only counts where it arrives earlier, and most of
   the network is pruned. The result is a *profile*: every journey not beaten in departure,
   arrival and transfers at once. `plan` picks the fastest per number of transfers from it,
   which now also leaves as late as possible; `--list` shows the whole profile. One subtlety
   from the paper: a label may only be compared with labels of its own round, or a later
   departure with more changes would hide an earlier direct one (there is a test for that).
6. **Step-free journeys** (`--step-free`, a checkbox on the page), for wheelchairs and prams.
   A second timetable is built from the same feed: trips whose vehicle can't take a wheelchair
   (`wheelchair_accessible` 2) are left out; nobody gets on or off, or walks to, a stop marked
   as having no step-free access (`wheelchair_boarding` 2; a platform without a value takes its
   station's, as the GTFS reference says); and changes inside stations use the station graph
   without stairs and escalators, or entrances marked as not step-free. Where the only
   step-free way is out to the street and back (Muzeum A ↔ C has a lift from each platform to
   the street, nothing inside, as DPP's own station page says), the path goes along the
   street between the station's entrances, and the journey says so: "change platforms at
   Muzeum, out one entrance and in another" (`street: true` on the walk in the API). Stops and trips the feed says nothing about are allowed, and the page says on
   which rides access isn't confirmed (most street stops in PID).
7. **Drawing rides along the street** (`shapes.ts`). `shapes.txt` gives every trip's line on
   the map (Prague: 7,572 shapes, 3.3 M points). The part between where one gets on and off is
   cut out by `shape_dist_traveled`, which PID gives for every stop and shape point: a binary
   search finds the segment, and both ends are interpolated. Feeds without distances get each
   stop projected onto the nearest segment, the second stop only *after* the first (a line that
   comes back past its start isn't drawn backwards). A cut end more than 150 m from its stop
   means the shape doesn't fit (a broken shape, a different unit): the ride is then drawn
   straight between its stops, and the API says which drawing it got (`shape: true/false`).
   Shapes don't depend on the date, so they are read once, in parallel with the first day's
   timetable, into typed arrays (micro-degree integers, 32-bit distances): 43 MB.
   Since the line no longer bends through every stop, the stops a ride makes on the way are
   listed too (`passed`, with arrival times): small dots in the line's colour on the map, and
   "5 stops in between" under the ride, which opens to the list. Stops the vehicle only drives
   past (no pickup and no drop-off in `stop_times.txt`) are left out.
8. **Stop names** (`stops.ts`). "andel" finds every platform called "Anděl": names are compared
   without case, diacritics or punctuation; a unique prefix also works.

## On real data

Prague's PID feed of 9 Nov 2026 (valid 9-22 Nov), on a laptop with Node 26:

| | |
|---|---|
| Feed | 1.69 M stop times, 82 k trips, 20 k stops |
| Loading one day | 1.3 s (52 k trips kept), timetable 0.2 s: 6,576 patterns, 61,152 footpaths |
| Binary cache | 79 MB; a server start 2.9 s -> 0.36 s (cache read 0.11 s), a CLI query 3.3 s -> 0.64 s; a second date 1.9 s -> 0.2 s |
| Station graphs | 68 stations, 1,532 pathways, 2,922 changes, 0.1 s |
| Shapes | 7,572 shapes, 3.28 M points, 1.1 s, 43 MB kept; 52,251 of 52,273 trips of a day fit their shape |
| Memory | ~380 MB resident with two dates, shapes and the whole feed loaded (was ~760 MB before dates shared the stop-time arrays) |
| One query | 4.1 ms median (p90 6.5) for one departure; 5.5 ms median (p90 26) over a 60-minute window (rRAPTOR); 300 random queries, 16 Nov (were 9.3 and 11.7 before flat arrays and reused labels) |

Compared with the official planner ([IDOS for PID](https://idos.cz/pid/spojeni/)) on Tuesday
10 Nov 2026, every vehicle and arrival time below is the same to the minute:

| Journey | Both planners |
|---|---|
| Anděl -> Muzeum, 08:00 | metro B 08:00, Můstek 08:04, change ~3 min, metro A 08:09, Muzeum 08:10 |
| Anděl -> Letiště, 08:00 | bus 191 08:00-08:49; metro B + bus 100 via Zličín, 08:44 (see below); metro B + A + trolleybus 59 via Můstek and Nádraží Veleslavín, 08:41 |
| Dejvická -> Háje, 07:30 | metro A to Muzeum 07:37, change, metro C 07:41-07:58 |
| Křižíkova -> I. P. Pavlova, 17:00 | tram 24 17:02 to Florenc 17:05, metro C 17:08-17:12 |
| Náměstí Míru -> Národní třída, 17:00 | tram 22 17:01-17:10; metro A, Můstek 17:04, change ~3 min, metro B 17:08-17:09 |

The 45 s buffer is the one number not taken from the feed. The first three journeys bound it
(29-55 s, see `stations.ts`); the last two were checked afterwards, with nothing changed.

One difference is left: via Zličín, IDOS takes metro B at 08:07 and changes to bus 100 in
about 2 minutes; transit-raptor leaves at 08:05, because its estimate for that change is 3:29.
Zličín's few pathways don't reach the metro platform, so the distance estimate is used there.
(Before rRAPTOR it left at 08:00, and at 17:00 for Křižíkova instead of 17:02.)

## Stack

TypeScript 7 on Node 22+, no runtime dependencies. Vitest for tests, Playwright for the page. TypeScript because a GTFS
feed is a dozen record types whose fields are easy to mix up (a stop *index* vs a stop *id*, a
time in seconds vs a `HH:MM:SS` string); strict types catch that at compile time.

The web page is plain HTML, CSS and JavaScript (`web/`, no build step) with
[Leaflet](https://leafletjs.com/) 1.9.4 from cdnjs (pinned, with subresource integrity) and
OpenStreetMap tiles. The server is `node:http` (`src/server.ts`): a handful of routes don't
need a framework.

## Install and run

Needs Node 22.12 or newer.

```bash
git clone https://github.com/Gallileee/transit-raptor.git
cd transit-raptor
npm install
npm run build

npm run fetch-pid          # downloads Prague's timetable (~50 MB) into data/pid
node dist/bin.js plan --gtfs data/pid --from "Anděl" --to "Muzeum" --time 8:00
node dist/bin.js plan --gtfs data/pid --from "Anděl" --to "Muzeum" --date 2026-11-14 --max-transfers 1
node dist/bin.js plan --gtfs data/pid --from "Anděl" --to "Letiště" --time 8:00 --list   # the next hour
node dist/bin.js plan --gtfs data/pid --from "Hlavní nádraží" --to "Křižíkova" --step-free
node dist/bin.js stops --gtfs data/pid --search "nadrazi"
node dist/bin.js departures --gtfs data/pid --stop "Anděl" --limit 8      # the next departures
```

`--date` and `--time` default to now. `--window MIN` (default 60) is how far after `--time`
departures are considered; `--window 0` leaves as early as possible. `--list` prints every
journey worth taking in the window instead of the best per number of transfers.
`--step-free` keeps to step-free vehicles, stops and changes. The first run on a feed writes
a binary cache into `DIR/.transit-raptor-cache/` (about 80 MB for Prague; `--cache DIR` puts it
elsewhere, `--no-cache` reads the CSV files and writes nothing); later runs start in well under a
second and rebuild it by themselves when the feed is downloaded again. Any other
unzipped GTFS feed works too: pass its folder as `--gtfs`. Example output on the test feed:

```
Alpha -> Delta, Náměstí, 2026-11-10

08:05 -> 08:30  (25 min, direct)
  08:05–08:30  bus 300 towards Delta, Náměstí: Alpha -> Delta, Náměstí (2 stops)

08:00 -> 08:15  (15 min, 1 transfer)
  08:00–08:05  tram 1 towards Charlie: Alpha -> Bravo (1) (1 stop)
  08:05–08:06  walk 1 min: Bravo (1) -> Bravo (2)
  08:08–08:15  bus 200 towards Delta, Náměstí: Bravo (2) -> Delta, Náměstí (1 stop)
```

Exit codes: `0` journeys found, `1` no journey, `2` bad input or feed.

### The web page

```bash
node dist/bin.js serve --gtfs data/pid [--port 8080] [--host 127.0.0.1] [--reload 5]
```

It loads the feed and today's timetable at start (0.3 s from the cache, about 3 s without),
keeps the two most recently used dates in memory, and serves:

- `/`: a form (stop names suggested as you type), the journeys, and the selected journey on a
  map, every leg in its line's colour from `routes.txt`, walks dashed. The search is kept in
  the URL, so a result can be shared or bookmarked. The footer says which timetable is in use:
  the dates it covers and when the server loaded it, in red once its last date has passed. A
  search on a date it doesn't cover says so instead of just "no journey"; and when it does find
  journeys there (PID's trains are published for the whole year, everything else two weeks
  ahead), a notice says only some lines are included, so a better journey may be missing.
  `plan` prints the same note on stderr.
- `GET /api/plan?from=&to=[&date=YYYY-MM-DD][&time=HH:MM][&window=MIN][&maxTransfers=N][&list=1][&stepFree=1]`:
  the journeys as JSON, with names, times, line colours, the line to draw (`path`: along the
  street from `shapes.txt` when `shape` is true, otherwise straight between the stops passed)
  and, per ride, `access`: `yes` (vehicle and both stops marked step-free), `no`
  or `unknown`. The step-free timetable of a date is built on its first use (~0.4 s) and kept.
  `feed` says which timetable answered (as `/api/feed`), so the page notices a reload.
- `GET /api/stops?q=TEXT[&date=]`: stop names for the suggestions.
- `/departures?stop=NAME`: a departures board, like the one at a stop: time, minutes to go,
  line (in its colour), direction and platform for every platform of the stop. It asks again
  every 30 s while the tab is visible and counts the minutes down on the device's clock in
  between, so departures that have left drop off even if the server doesn't answer. With live
  delays (below), each departure shows "+2 min", "on time" or "canceled", the minutes count to
  when it is expected, and a vehicle due before now that is late stays on the board.
  `&date=&time=` shows the board for that moment instead, and it stays as it is. In a journey,
  the stop where one gets on links there at that time (the other ways to go from it), and so
  do the dots on the map, in a popup.
- `GET /api/departures?stop=NAME[&date=][&time=HH:MM][&limit=20][&window=120]`: the next
  departures, from the timetable's patterns (binary search for each pattern's first trip):
  trips that let people on there and go on, so a trip ending at the stop isn't listed.
  The platform is the feed's `platform_code`; where PID leaves it out (14 metro platforms at
  Muzeum, Můstek, Florenc and Nádraží Veleslavín), it is the track number the platform's
  boarding areas are named after ("Kolej 1"), as IDOS shows them (M1/M2). Trains have no
  platform in the timetable: it is decided on the day, and with live delays on, the board
  shows the track Golemio gives ("4J": track 4, south part), in bold, once it is known (and so
  does a journey where one gets on a train). `platformLive` marks it in the API.
  `live` says whether delays were added (`on`, `off`, `error`); each departure has `delay`
  (seconds, or null), `canceled` and `expectedMinutes`.

**Live delays.** PID publishes where its vehicles are through Golemio, Prague's data platform.
With a free API key from [api.golemio.cz/api-keys](https://api.golemio.cz/api-keys) in the
environment as `GOLEMIO_API_KEY`, `serve` and `departures` ask Golemio's departure board
(`/v2/pid/departureboards`) for the stop's platforms and match its answer by GTFS trip and stop
id, which are the same as in the feed. A negative delay (a vehicle ahead, or waiting at its
first stop) counts as on time: PID's vehicles don't leave early, and IDOS says "no delay"
for them. Only a board for now (within 5 minutes of the server's
clock) asks, looking 15 minutes back for late vehicles. Answers are kept 20 s (a key may make
20 requests in 8 s), the request gives up after 4 s, and if Golemio fails the board shows the
timetable and says so (logged at most once a minute). The key is sent only in the
`X-Access-Token` header to Golemio: never to the page, into a URL or the log. Keep it out of
the repository, e.g. in a gitignored `.env` file.

Journeys get them too: every ride leaving within the next hour shows its delay where one gets
on ("+3 min" under its time; one question to Golemio for all those stops, asked in pages of
100, the most Golemio answers at once, up to 5), a cancelled ride says
so, and a change is marked as at risk when the vehicle before, taken to stay as late as it is
now, arrives after the next one leaves (as late as that one is), walk included. The
journeys are planned on the timetable, then around the rides live data say are cancelled: the
search runs again without those trips (up to twice more, asking about the new journeys' rides
too), and the page says which it went around ("Planned around a cancelled trip: metro B at
12:21 from Florenc (1)."; `avoided` in `/api/plan`). Under a change at risk the page says
how to go on if it is missed: the server searches again from where the late vehicle leaves
one, from when it is expected there, and gives the journey that arrives first ("If you miss
it: metro C at 22:50 from I. P. Pavlova (1), arriving 23:03 (10 min later)", with a link that
searches from there). A cancelled ride gets one too ("Instead: ..."): from where the ride
before leaves one or, if it is the first ride, from any stop of the place searched from (one
who hasn't left can take another platform). Fallbacks never take a trip that live data say is
cancelled (RAPTOR's `Query.skip`). `/api/plan` has `live`, each ride `delay`, `canceled` and
`changeAtRisk`, and such a journey `fallback` (`leg`, `reason` "canceled" or "late", `from`,
`at`, `journey` or null when nothing goes on from there, `later` in minutes). On the map the
way on is drawn dotted in each line's colour, under the journey (where they share a street
the journey stays on top), with a small dot where each of its rides is boarded; a cancelled
ride is drawn faded and broken. Where a ride at risk (or a cancelled one) is boarded, a red
ring with a halo lies over everything else; its tooltip and popup say why ("this change may be
missed: tram 1 is +2 min late", or "the vehicle before is late" when no delay of a minute or
more is known). The map fits both, and "Show on map" next to the fallback
zooms to the way on alone (and scrolls to the map on a phone). To run with the
key:

```bash
echo "GOLEMIO_API_KEY=..." > .env      # .env is in .gitignore
node --env-file-if-exists=.env dist/bin.js serve --gtfs data/pid
```
- `GET /api/feed`: the timetable in use, `{"firstDate":"2026-11-09","lastDate":"2026-11-22",
  "loadedAt":"2026-11-14T17:30:12.345Z"}`. The dates are `feed_start_date` and `feed_end_date`
  from `feed_info.txt`, or the first and last date with service in the calendar when the feed
  doesn't give them. For PID the calendar alone would say "until 12 Dec 2026": its train
  services run all year in `calendar.txt`, while the rest of the feed stops two weeks ahead.

Bad input gets `400` with a message, and for an unknown or ambiguous stop a list of names to
pick from; a feed that can't be loaded gets `503`. The server listens on 127.0.0.1 unless told
otherwise, serves a fixed list of five files (no URL path reaches the file system), and sends a
Content-Security-Policy that only allows cdnjs and the map tiles. The page writes everything it
shows with `textContent`, and only uses a line colour if it is six hex digits.

**A new timetable without a restart.** PID publishes a new feed every day. Every `--reload`
minutes (default 5; `0` turns it off) the server compares the feed files' sizes and times
with the ones it loaded. A change is acted on only when the next check finds the files
unchanged, so a download in progress is never read. Then the new feed is loaded in the
background (Prague: ~3 s, the cache is rewritten), today's timetable is built, and only then
is it swapped in. Requests in the meantime are answered from the old feed. If the new files
can't be read, the server logs why, keeps the old feed, and tries again only when the files
change. `npm run fetch-pid` also extracts into `data/pid.new` and renames it into place.

## Tests

```bash
npm test             # vitest
npm run typecheck    # tsc --noEmit, strict
npm run test:e2e     # builds, then the page in a browser (Playwright)
npm run compare-journeys -- --base main --date 2026-11-16   # this tree vs main, on the real feed
```

`test:e2e` needs a browser: `npx playwright install chromium` once, or an installed Edge or
Chrome with `PLAYWRIGHT_CHANNEL=msedge` (or `chrome`) set.

The tests run on a hand-made feed (`tests/fixtures/mini`) in which every part exists to test one
thing: a transfer with a walk between platforms, an express that overtakes a slower bus, a stop
where the line doesn't pick up, a night bus past midnight (seen from the next day too), a public
holiday from `calendar_dates.txt`, a walk that only `transfers.txt` allows, a stop with no times,
quoted names with commas and a byte order mark, and for step-free journeys a station with lifts
(one marked as not step-free) and vehicles and stops with and without access, and three
shapes (with distances, without, and one that lies elsewhere). `cache.test.ts` checks that
every date cut from the cache equals the date read from CSV, and that a stale, damaged,
cut-off or unwritable cache only means reading the CSV again. `server.test.ts` runs the HTTP server on a free
port and calls it like a browser would (JSON shapes, errors, headers, paths outside the three
files). CI runs them on Node 22 and 24, runs the built CLI, and checks its own workflow with
[workflow-guard](https://github.com/Gallileee/workflow-guard).

`e2e/page.e2e.ts` drives the page in Chromium against the built server on the same test feed:
a search from the URL and from the form (with stop-name suggestions, and the search kept in
the URL across a reload), picking a journey by click, keyboard and tap and the map redrawn
(lines, dashed walks, dots, all inside the visible map), an ambiguous and an unknown stop, the
step-free checkbox, line colours from the feed, durations that match the times shown, the
timetable in the footer (in use, ended, and replaced by a reload), phone width and dark mode.
`e2e/departures.e2e.ts` does the same for the departures board, with the browser's clock under
the test's control: the board, the countdown and the refresh every 30 s, departures dropping off
while the server doesn't answer, an ambiguous stop, and the links between the pages.
`e2e/stop-links.e2e.ts`: from a journey's stop (list and map popup, by click and by Enter) to
the board at that time, which doesn't refresh, and back to now; the next day after midnight.
`e2e/journey-delays.e2e.ts`: live delays, changes at risk, cancelled rides and their
fallbacks, given to the page by rewriting `/api/plan`'s answer; the way on drawn dotted under
the journey, a cancelled ride faded, "Show on map" zooming to the way on, the warning ring at
the change at risk (its tooltip, popup on a phone, drawn last). It runs without the internet: Leaflet is served from `node_modules`
(the page's integrity hashes prove it is the cdnjs file), map tiles are a blank image, and any
other outside request, console error or exception fails the test. CI runs it as its own job
and keeps the report and traces when it fails.

The real feed was checked by hand in the browser too (see PROGRESS.md, 14 Nov): routes drawn
along the streets, and step-free journeys compared with IDOS.

**Journeys on the real feed, before and after a change.** `npm run compare-journeys` plans
the same random queries (1,000 by default; `--count`, `--seed`, `--date`, `--step-free`) with
this tree and with another version (`--base`, default `main`), which it builds from git into
`.compare/<commit>/`. Each side reads the feed itself. It prints how many journeys are
identical, which differ (earlier, later, same time another way) with examples, and any
journey of this tree that can't be right: two walks in a row, time going backwards, legs that
don't meet. Those make it exit 1, as does any difference with `--fail-on-diff`. It needs the
PID feed (`npm run fetch-pid`), so it isn't part of CI; run it before changing the algorithm,
the station graph or the feed reading. Each side plans in worker threads (`--jobs`, default 4,
each with its own copy of the feed), both sides at once: on PID 2,000 queries take about 5 s
(were 39 s one query after another). It finds the
chained-walk bug of 14 Nov (31 of 1,000 journeys differ from before the fix, and with the old
`raptor.ts` 32 have two walks in a row).

## Limitations

- rRAPTOR runs RAPTOR once per departure in the window; for a busy stop and a long window that
  is hundreds of runs (still well under a second for Prague, but not for a whole day).
- Outside the 68 stations with pathways, walking is straight-line distance times a detour
  factor plus a penalty per level, not a street network. Those values are cautious on purpose:
  a too-short change suggests a connection that fails in reality.
- Inside stations, walkways have no lengths or times in PID's feed, so their time is the
  straight line between their ends at 1.2 m/s. Signposted exits aren't used yet.
- Step-free mode trusts the feed: unknown stops and trips are allowed (PID marks most street
  stops as unknown), `transfers.txt` times are used as they are, and walks between stops
  outside the stations with pathways assume the street is passable. Compared with IDOS's
  barrier-free search on 16 Nov: same journey Hlavní nádraží -> Palmovka; at Muzeum A -> C it
  allows 8 min for the change where IDOS allows about 3. The 8 min hold up (see PROGRESS.md,
  14 Nov): the two lifts alone take 200 s in the feed, and the street between them is 201 m on
  OpenStreetMap's footpaths (208 m here).
- Footpaths aren't chained (one walk between two vehicles), as in the paper.
- Journeys are planned on the timetable; live delays (with a key) are shown on them and can
  flag a change at risk, but don't change which journeys are found. A delay is taken to last to
  where one gets off. Journeys of the day before, after midnight, get no live data.
- No fares, or daylight-saving corrections (GTFS times are
  measured from "noon minus 12 h", which differs from midnight on the two DST days).
- Stops without times in `stop_times.txt` get times between the timed stops around them, by
  the distance travelled (`shape_dist_traveled`, else straight lines): on PID's real times,
  blanked at every other stop, that is 15 s off at the median (p90 43 s). Stops after the last
  timed one take its departure. PID itself times every stop.
- The cache trusts file sizes and modification times: a feed file edited in place within the
  same millisecond and to the same size would not be noticed (`--no-cache` or deleting the
  folder helps). It is written for little-endian machines only (all common ones); elsewhere it
  is just not written.
- The web server is meant for one user on their own machine: no authentication, no rate
  limiting, one process. Map tiles come straight from tile.openstreetmap.org, which is fine for
  that but not for a public site (OSM's tile usage policy).
- The browser tests don't cover the map resizing itself when the layout changes (a rotated
  phone): Leaflet's own resize handling hides a missing `invalidateSize()` in every case tried.
- Walks are drawn as straight lines; only rides follow the street.
- Shapes are matched to stops by distance or by nearest segment, not by map matching: a shape
  that wanders more than 150 m from a stop is not used at all (22 trips of a day in PID, where
  the shape really ends kilometres before the last stop).

## Data

The Prague timetable is published by PID / ROPID at
[pid.cz/o-systemu/opendata](https://pid.cz/o-systemu/opendata/) under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) (credit: PID / ROPID). It is
downloaded by `npm run fetch-pid` and never committed to this repository.

## Next steps

See [PROGRESS.md](PROGRESS.md).

## License

MIT for the code.
