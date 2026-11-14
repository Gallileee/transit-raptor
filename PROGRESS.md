# Progress log

## 2026-11-14 (scheduled run): Milestone 7, a compiled feed and a binary cache

Why: next step 3. Every start parsed ~300 MB of CSV (2.9 s for a server, 3.3 s for one CLI
query), and every new date in the server read stop_times.txt again (1.9 s). Production planners
split this the same way: OpenTripPlanner builds its graph once, saves it (`--build --save` ->
graph.obj, with a serialization version in the header) and loads that at startup (`--load`)
(https://opentripplanner.readthedocs.io/en/latest/Basic-Tutorial/). Here the "graph" is mostly
typed arrays, which can be written to disk and read back with no parsing at all.

Acceptance criteria:
- Read the CSV files once into a date-independent compiled feed; cut any date out of it, with
  results identical to the old per-date loader (checked on the real feed, not only the fixture).
- Save it with the shapes in one binary file; later starts read that file.
- The cache rebuilds itself when a feed file changes (size or modification time), and a cache
  from another format version, another feed, damaged or cut off is ignored and rewritten.
- A cache that can't be written never stops planning.
- CLI: `--cache DIR`, `--no-cache`; default `<feed>/.transit-raptor-cache/` (gitignored).

Done:
- `gtfs.ts`: `compileFeed` (all trips; stop times into typed columns with a counting sort by
  trip, sequence sort only where needed, times filled in), `feedForDate` (trips of the day are
  `subarray` views into the shared columns; only previous-day trips get shifted copies),
  `readCalendar` / `servicesOn`; `loadFeed` and `activeServices` keep their signatures. A
  broken trip (unknown stop, first stop without a time) still only fails the dates it runs on.
- `shapes.ts`: `Shapes` is built from `ShapeColumns` (ids, start offsets, lat, lon, dist), which
  is what the cache stores; `Shapes.fromColumns` checks the columns fit together.
- `cache.ts` (new): `encode` / `decode` (magic, format, header JSON, CRC-32 via `zlib.crc32`,
  arrays at 8-byte offsets, views when aligned and copies otherwise), `fingerprint`, `cacheFile`
  (one file per feed path), `openFeed` (cache or CSV, writes via a temp file + rename).
- `service.ts`: `Planner` opens the feed once (5th constructor argument `cacheDir`) and cuts
  dates from it; `cli.ts`: `--cache`, `--no-cache`; `plan`/`stops` skip shapes without a cache.
- Tests: `cache.test.ts` (16); `cli.test.ts` runs without a cache unless a test asks. 137 in
  total. Version 0.7.0.

Decisions:
- Cache the *compiled feed*, not a day's timetable: one file serves every date, and building a
  timetable from a day (0.2 s) is cheap. Caching timetables too would save 0.2 s for 2x the disk.
- Size + mtime fingerprint, not a hash of the CSV files: hashing 300 MB would cost about as much
  as the parsing it saves. The documented gap: an edit in place within the same millisecond and
  to the same size isn't noticed.
- A hand-written format instead of `v8.serialize`: V8's format may change between Node versions
  and copies every typed array; this one maps them straight from the read buffer.

Verified (Node 26, PID feed of 9 Nov):
- `npm run typecheck` clean; `npm test`: 137 passed; `npm run build` ok.
- Old loader (main, built in a worktree) vs new, CSV and cache path, deep-compared on 14, 16,
  17 (holiday) and 22 Nov: identical (28-52 k trips each); shapes columns identical (7,572).
- Timings: server first date 2,838 ms (old) -> 356 ms (cache) / 2,874 ms (no cache); second
  date 1,884 -> ~210 ms; RSS with two dates 759 MB -> ~380 MB; CLI query 3.3 s cold (writes
  the 79 MB cache) -> 0.64 s warm, output identical.
- Mutation checks, each fails at least one test: no checksum check, no mtime in the
  fingerprint, never copying unaligned arrays, fingerprint ignored.
- Not verified: the web page (nothing on it changed; the API tests run through the Planner).

## 2026-11-11 (scheduled run): Milestone 6, rides drawn along the street

Why: next step 2. The map drew every ride as straight lines between stops, so a tram along the
river cut across the blocks and a metro ride looked like a zigzag. `shapes.txt` has the real
line, and PID gives `shape_dist_traveled` for every stop and shape point. The GTFS reference
says this field is there so consumers know how much of a shape to draw for part of a trip
(https://gtfs.org/documentation/schedule/reference/#shapestxt); for feeds without it,
projecting stops onto the line is the usual fallback (gtfs-changes discussion,
https://groups.google.com/g/gtfs-changes/c/Dx5zj5trFjQ).

Acceptance criteria:
- A ride's `path` follows its shape from the boarding stop to the alighting stop, with both
  ends cut at the stops, not at the nearest shape point.
- Works with distances (binary search + interpolation) and without (projection, the second
  stop never placed before the first).
- A shape that doesn't fit its stops (cut end > 150 m away) is not used; the ride falls back
  to straight lines and the API says which one it got (`shape`).
- A broken shapes.txt costs the drawing, not the journeys (logged, straight lines).
- Memory stays reasonable: shapes are read once for all dates.

Done:
- `shapes.ts` (new): `Shapes.load` / `Shapes.of`, a `ShapeBuilder` into typed columns (counting
  sort by shape, sequence sort only where needed), `positionAtDistance`, `project`, `cut`.
- `gtfs.ts`: `Trip.shapeId`, `Trip.distances` (Float32Array, NaN where missing).
- `service.ts`: `Loaded.shapes`, loaded once per Planner in parallel with the first date;
  `LegJson.shape`; optional logger in the Planner constructor (the CLI passes stderr).
- `web/app.js`: start and end dots sit on the stops, not on the first point of the line.
- Test feed: `shapes.txt` (SH1 with distances and rows out of order, SH2 without, SH9 1.4 km
  away), `shape_id` in trips.txt, `shape_dist_traveled` in stop_times.txt.
- Tests: `shapes.test.ts` (15) + the server test now expects the shaped line; 121 in total.
  Version 0.6.0.

Decision: all shapes in memory instead of "only the shapes of the trips shown". Reading the
file is the cost (0.7 s of 1.1 s), so loading on demand would cost that per request or need an
index into the file; the whole set is only 43 MB as typed arrays. A first version with a JS
array per shape peaked ~250 MB higher while parsing; typed columns brought the peak down by
~70 MB resident.

Verified (Node 26):
- `npm run typecheck` clean; `npm test`: 121 passed.
- Mutation checks, each fails at least one test: projecting the second stop from the start of
  the line (1, after the loop test was made stricter: the first version survived), no 150 m
  check (3), no sorting by shape_pt_sequence (3).
- Real feed (11 Nov): 52,251 of 52,273 trips fit their shape end to end; every third hop
  checked: 30 of 345,780 don't. The misfits are real data problems (L3630's shape is 1.7 km
  long for a 22 km route; L2825's ends 266 m before Beroun, nemocnice). Cutting all trips:
  0.4 s. Anděl -> Letiště, Anděl -> Muzeum, Hlavní nádraží -> Florenc, Malostranská -> Pražský
  hrad, Smíchovské nádraží -> Praha-Radotín: every ride shaped (22-389 points), 13-123 ms.
- Not verified: the map in a browser (preview declined again in this unattended run).

## 2026-11-10 (scheduled run): Milestone 5, step-free journeys

Why: next step 1. A journey planner that sends a wheelchair user down an escalator is worse
than none, and PID's feed has what is needed: `wheelchair_boarding` on stops (1,156 platforms
yes, 5,347 no, the rest unknown, mostly street stops), `wheelchair_accessible` on every trip
(76,366 yes, 5,926 no) and 100 elevators in pathways.txt. Semantics from the GTFS reference
(https://gtfs.org/documentation/schedule/reference/): 0 on a platform or entrance means "as the
parent station".

Acceptance criteria:
- A step-free option in the CLI (`--step-free`), the API (`stepFree=1`) and the page (checkbox,
  kept in the URL).
- Leaves out vehicles marked as not accessible and getting on/off at stops marked as not
  accessible (inherited from the station when the platform says nothing).
- Changes inside stations without stairs, escalators or inaccessible entrances; where the
  station graph only connects two stops with stairs, the distance estimate must not offer a
  change either.
- The normal mode is unchanged (all station change times byte-identical to v0.4.0 on PID).
- Each ride says whether access is confirmed (yes / no / unknown).

Done:
- `gtfs.ts`: `Access` (0/1/2), `Stop.wheelchair` (with inheritance), `Trip.wheelchair`.
- `stations.ts`: `isStepFree`, `stationTransfers(..., stepFree)`; in step-free mode the graph also
  walks along the street between entrances of the same station (Muzeum A <-> C: the feed has a
  lift from each platform to the street and nothing inside; 8 min instead of 3).
- `timetable.ts`: `buildTimetable(feed, { walk, station, stepFree })` (was positional);
  `Timetable.stepFree`; trips filtered, boarding masked, estimates dropped where only stairs connect.
- `service.ts`: `Loaded.stepFreeTimetable()` built once per date on first use; `PlanRequest.stepFree`;
  `access` per ride; `combinedAccess`. `server.ts`: `stepFree=1`. `cli.ts`: `--step-free`.
- `web/`: checkbox, "step-free access not confirmed" on unknown rides in a step-free search.
- Test feed: accessibility columns, three lifts at Gamma (one to an exit marked not step-free),
  trip L12b. Tests: `step-free.test.ts` (14) + 1 server test; 106 in total. Version 0.5.0.

Decision: walking between entrances along the street is only used in step-free mode. In the
normal graph it would shorten about 40 changes (side-platform stations, e.g. U897 164 s -> 107 s),
which were never compared with IDOS; that comparison belongs in its own change.

Verified (Node 26):
- `npm run typecheck` clean; `npm test`: 106 passed.
- Mutation checks, each fails at least one test: no inaccessible-node rule (it survived at first:
  nothing checked platform -> street, so a test was added), no street links (2), escalators
  allowed (4), no trip filter (2), no stop mask (2), no inheritance (2), keeping the distance
  estimate (1), walking to inaccessible stops (1), no cache of the step-free timetable (1),
  access always "yes" (1).
- Real feed (10 Nov, 08:00): normal station changes identical to v0.4.0 (2,922); step-free 2,114.
  Anděl -> Muzeum: same metro, Můstek change 4 min (lifts) instead of 3. Hlavní nádraží ->
  Křižíkova: normally metro C + B via Florenc; step-free goes by tram 15 + 24, because Florenc's
  line C platforms are marked as not step-free. Anděl -> Letiště: bus 191, and metro B + bus 100
  via Zličín. The API through a real server: step-free timetable built in ~0.4 s, then ~66 ms.
- Not verified: the page in a browser (the preview was declined in this unattended run), and
  a comparison with IDOS's barrier-free search.

## 2026-11-09 (interactive): Milestone 4, a web page with a map

Why: the owner picked it from the next steps. Until now the project was a command-line tool;
a page where one types two stops and sees the journey on a map shows what it does in seconds,
and running the planner as a server means the timetable is loaded once instead of per query.

Acceptance criteria:
- `transit-raptor serve` with a JSON API (plan, stop suggestions) and a page with a map.
- The timetable of a date is loaded once and kept; memory stays bounded.
- Clear 400s for bad input (with stop names to pick from), 404/405/503 where they belong.
- Safe by default: localhost only, a fixed list of files, a CSP, no HTML built from data.
- Works at phone width; checked in a real browser on the real feed.

Done:
- `service.ts`: `Planner` (load-once cache of the two most recently used dates, `stops`,
  `plan`), `RequestError` with suggestions, `journeyJson` (names, times, line colours, and
  the coordinates of every stop passed, taken from the trip).
- `server.ts`: `createAppServer` on node:http; `/api/plan`, `/api/stops`, `/`, `/app.js`,
  `/style.css`; CSP, `nosniff`, `no-referrer`; `cli.ts`: `serve --gtfs --port --host`, which
  loads today's timetable before listening.
- `gtfs.ts`: route_color / route_text_color, normalized to six hex digits or "".
- `web/`: index.html, style.css (light and dark, a phone layout), app.js (suggestions as you
  type, journeys list with line badges, Leaflet map, search in the URL, keyboard selection).
- Tests: `server.test.ts` (22) through a real server on a free port. 91 in total. Version 0.4.0.

Verified (Node 26):
- `npm run typecheck` clean; `npm test`: 91 passed.
- Mutation checks: no CSP header (1 test fails), colours not validated (1), only the ends of a
  ride drawn (1), cache without a limit (1).
- In the browser, on the real PID feed (launch config `transit-raptor-web`, port 8095):
  Anděl -> Letiště shows the same three journeys as the CLI and IDOS, metro B yellow, A green,
  trolleybus 59 purple on the map; "nadrazi" gives the list of stations, and a click on one
  searches again. 2.1 s for a new date (loading), 50-190 ms after that. No console errors
  except the expected 400 of that ambiguous-stop test.
- Two bugs found in the browser and fixed: at phone width the panel was squeezed into a small
  scrolling box with the button and the journeys hidden (the desktop layout pins the height to
  the window; on a phone the page now scrolls as a whole); and the map could keep an old size
  after the layout changed, so `fitBounds` cut the route off (`invalidateSize()` before
  drawing). The cut-off route seen with an emulated 1280 px window was the emulation scaling
  the page, not the page: at the pane's own size the route fits.

## 2026-11-09 (interactive): Milestone 3, rRAPTOR (journeys over a time window)

Why: next step 1, picked by the owner. Plain RAPTOR leaves as early as possible from the given
time; IDOS suggests the *latest* departure that still arrives as early. Two of the six journeys
compared with IDOS differed only in that (Zličín: 7 min earlier; Křižíkova: 2 min).

Acceptance criteria:
- A profile over a window: no journey in it leaves earlier, arrives later and changes more often
  than another one.
- `plan` keeps its output (the best per number of transfers) but leaves as late as possible.
- A direct journey must not be hidden by a later departure with more changes that arrives first.
- CLI: `--window` (default 60 min) and `--list`; same arrivals as before for every old test.

Done:
- `raptor.ts` rewritten around `Search`: labels per round kept across runs; each run carries the
  previous round's arrivals forward, scans, walks, and returns the journeys it improved.
  `departureTimes` (departures from the origin and stops one can walk to, latest first, plus the
  start time), `profile` (Pareto over departure, arrival, transfers; journeys after the window
  only when there is nothing inside), `plan` (best per transfer count from the profile).
- Pruning now compares with labels of the same round only (needed for three criteria).
- CLI: `--window MIN`, `--list`; usage text explains both.
- Tests: `range.test.ts` (12); the test feed got a second line 9 trip (08:23) that reaches the
  same connection as the 08:20 one. 69 in total. Version 0.3.0.

Verified locally (Node 26):
- `npm run typecheck` clean; `npm test`: 69 passed, and the 57 earlier ones passed on the new
  core before any new test was added.
- Mutation checks: running departures earliest first fails 6 tests; pruning with the best
  arrival over all rounds (the trap from the paper) fails 5. Two mutations survived at first:
  one was a badly built mutation (it only looked at the last round, which a run often never
  reaches); the other showed dead code, a "latest departure" tie-break in `plan` that the
  profile already guarantees, so it was removed.
- Real feed: Křižíkova -> I. P. Pavlova now equals IDOS (tram 24 at 17:02); via Zličín the metro
  leaves at 08:05 instead of 08:00 (IDOS 08:07; the rest is the change estimate at Zličín, whose
  pathways don't reach the platform). A query over 60 min takes 45-190 ms; `--list` for Anděl ->
  Letiště at 08:00 gives 20 journeys.

## 2026-11-09 (interactive): Milestone 2, changes inside stations from pathways.txt

Why: next step 2, picked by the owner. Milestone 1's walking model (distance + 45 s per level)
couldn't match the official planner: IDOS needs >= 2:55 to change at Můstek but < 3:00 from the
Nádraží Veleslavín metro to the trolleybus, the opposite of what distance and depth predict.
PID's feed has the inside of 68 stations in pathways.txt.

Found while exploring the feed (before writing code): platforms (location_type 0) never appear
in pathways.txt. The graph joins *boarding areas* (location_type 4, five per metro platform,
parent = the platform), corridor nodes (3) and entrances (2). Walkways (807 of 1,532) have no
traversal_time and the feed has no `length` column; escalators and elevators have times;
stairs have stair_count. Escalators are mostly one way. A Python prototype (scratchpad, not in
the repo) checked the idea on Můstek, Muzeum, Veleslavín and Zličín before the TypeScript.

Acceptance criteria:
- Change times from the shortest path through the station graph, directed (escalators).
- Platform to platform, platform to street stop (via the best entrance) and back.
- Those times replace the distance estimate; stations without pathways keep it.
- The journeys checked against IDOS in milestone 1 match, including the Veleslavín one that was
  missing, and journeys not used for any tuning match as well.

Done:
- `gtfs.ts`: `Pathway` (mode, direction, traversal_time, stair_count), `Feed.pathways`.
- `stations.ts`: `MinHeap`, `dijkstra`, `pathwaySeconds` (traversal_time; else straight line at
  1.2 m/s, + 0.6 s per stair; elevators 60 s), `stationTransfers` (average over the boarding
  areas one gets off at, nearest one gets on at, + 45 s buffer; street stops within 300 m of an
  entrance). `geo.ts` holds `distanceMetres` so stations.ts and timetable.ts don't import each
  other.
- `timetable.ts`: station changes override the estimate; transfers.txt still has the last word.
- Tests: `stations.test.ts` (8) on a small station in the test feed; level tests moved to stops
  without pathways. 57 in total. Version 0.2.0.

The buffer: with the first version (60 s) everything matched IDOS except Veleslavín, missed by
5 s (metro arrives 08:20:00, trolleybus leaves 08:23:00; path 125 s + 60 s). Three changes
bound the buffer from both sides: Můstek (path 146 s, IDOS rejects 175 s: >= 29 s), Veleslavín
(125 s, IDOS allows 180 s: <= 55 s) and Muzeum (144 s, 225 s allowed: <= 81 s). Unlike
milestone 1's model, one value fits all three; 45 s is the middle. Then two journeys that took
no part in choosing it were compared: Křižíkova -> I. P. Pavlova (Florenc, tram -> metro C) and
Náměstí Míru -> Národní třída (Můstek A -> B). Both match IDOS to the minute.

Verified locally (Node 26):
- `npm run typecheck` clean; `npm test`: 57 passed.
- Mutation checks: not using the station graph (2 tests fail), minimum instead of average when
  getting off (3), every pathway two-way (2), stairs free (1).
- Real feed: 68 stations, 2,922 changes in 0.1 s; timetable 0.2 s in total; queries 2-15 ms;
  six journeys equal to IDOS (README table).

## 2026-11-09: Milestone 1, a RAPTOR journey planner on GTFS (MVP)

Why this project: the portfolio had a web app (lendloop, Java/Spring), a frontend app
(fitness-workout-log, React) and a developer tool (workflow-guard, Python), but nothing about
algorithms or processing real data at scale. The owner asked for either a companion to the two
apps or a completely different genre; this is the latter. Prague's PID publishes its whole
timetable as GTFS under CC BY 4.0 (https://pid.cz/o-systemu/opendata/, ~46 MB zipped, daily),
and RAPTOR (Delling, Pajor, Werneck, Transportation Science 2015) is a well-documented
algorithm that is achievable but not trivial.

Acceptance criteria:
- Load an unzipped GTFS feed for one date: calendar + calendar_dates, trips past midnight
  (from the previous day too), stop_times in any order, missing times, pickup/drop-off rules.
- RAPTOR with walking between nearby stops and transfers.txt, returning the Pareto set over
  arrival time and number of transfers.
- A CLI that takes stop names (without diacritics), date and time, and prints the journeys.
- Tests on a hand-made feed that covers each of those cases; CI.

Done:
- `csv.ts` (streaming RFC 4180 reader, BOM), `time.ts` (GTFS times past 24:00, dates,
  weekdays), `gtfs.ts` (`loadFeed`, `activeServices`), `timetable.ts` (patterns, overtaking
  split, spatial-grid footpaths, transfers.txt), `raptor.ts` (`plan`, journey reconstruction,
  "leave just in time" for a first walk), `stops.ts` (name index), `format.ts`, `cli.ts` +
  `bin.ts` (`plan`, `stops`), `scripts/fetch-pid.mjs`.
- Tests: 45 (Vitest) on `tests/fixtures/mini`.
- CI: Node 22 and 24 (typecheck, tests, build, the built CLI on the test feed) and
  workflow-guard on the workflow itself.

Verified locally (Node 26):
- `npm run typecheck`: clean (strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes).
- `npm test`: 45 passed. `npm run build` and the built CLI on the test feed: as in the README.
- Mutation checks: without splitting overtaking trips 6 tests fail; ignoring pickup_type 1;
  without previous-day trips 3; ignoring transfers.txt 2. Without target pruning all pass, as
  they should (it only makes the search faster).
- workflow-guard on `.github/workflows/ci.yml`: 0 findings.

Found on the way: four expected values in my first tests were wrong, not the code (a walking time
estimated by hand, the Monday-night case that really catches the morning express, Node's
`parseArgs` reading `-1` as an option). Each was checked against the data before changing the test.

### Same day: tried on the real PID feed

The owner approved downloading the feed (PID_GTFS.zip, 46.5 MB, 9 Nov 2026, valid 9-22 Nov).

Measured (Node 26, laptop): 1.69 M stop_times read, 52 k of 82 k trips kept for Tue 10 Nov;
load 1.3 s, timetable 0.1 s (6,576 patterns, 60,750 footpaths), 357 MB RSS / 108 MB heap,
queries 2-17 ms.

Real data showed three things the test feed couldn't:

1. **A useless Pareto journey.** Anděl -> Muzeum at 08:00 offered "direct" by night bus 907 at
   00:51 the next day, next to an 8-minute metro ride. Fixed with `withoutDetours`: drop journeys
   arriving more than max(30 min, the fastest travel time) after the fastest one.
2. **Changes that were too short.** Můstek metro B -> A came out as 1 minute: the platforms are
   86 m apart, but on different levels (-4 and -2) with escalators between them. PID's
   transfers.txt has nothing for Můstek (its 11,456 entries are type 1, guaranteed connections
   between trips; only 50 are minimum times). Fixed by reading `levels.txt` and adding 45 s per
   level of difference.
3. **Labels.** Platforms of metro stations have no platform_code, so a change read "walk:
   Můstek -> Můstek"; it now says "change platforms at Můstek".

Compared with IDOS (https://idos.cz/pid/spojeni/, opened by URL, 10 Nov 08:00):
- Anděl -> Muzeum: identical (B 08:00, Můstek 08:04, change ~3 min, A 08:09, Muzeum 08:10).
  Before fix 2 it suggested the 08:06:35 metro A, which IDOS considers impossible.
- Anděl -> Letiště: bus 191 identical; via Zličín + bus 100 the same arrival (08:44) but an
  earlier departure (no time-window search yet); IDOS's third option via Nádraží Veleslavín +
  trolleybus 59 (08:41) is missing, because the change there is estimated at 290 s (IDOS ~2 min).

Calibration attempt, reverted: a faster walk (1.3 m/s, x1.1) with 30 s per level capped at 60 s
fixed Veleslavín but made Můstek 2:10, which brought back the impossible 08:06:35 change. IDOS
needs >= 2:55 at Můstek and <= ~2:30 at Veleslavín, the opposite of what distance and depth
predict: it uses station-specific times. Too long only hides an option; too short suggests a
change that fails, so the cautious values stay. pathways.txt has the inside of stations (Můstek:
132 edges; escalators with traversal_time, stairs with stair_count, corridors without times but
with node coordinates); a shortest path through it is the real fix (next step 2).

Also fixed: `npm run fetch-pid` tried GNU tar first, which in Git Bash reads "C:" as a remote
host; it now tries unzip first and stays quiet about failed attempts unless all fail.

Tests: 49 (4 new: level penalty, the night-bus filter on the feed and as a unit, the change label).
Mutation checks: without the filter or without the level penalty, one test each fails.

## Next steps (in order)

1. Check the step-free checkbox in the browser, and compare step-free journeys with IDOS's
   barrier-free search (Muzeum A <-> C, Florenc, Hlavní nádraží).
2. Look at the shaped lines in the browser (metro under the river, tram 22 up to the castle,
   phone width), together with step 1.
3. Browser tests for the page (Playwright), now that it does more than show results.
4. Small dots for the stops passed on a ride (the path no longer goes through them).
5. Street walks between a station's entrances in the normal graph too, after comparing the ~40
   changes it would shorten (side-platform stations) with IDOS.
6. `serve`: notice a new feed download (fingerprint changed) and reload without a restart.
