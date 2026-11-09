# Progress log

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

1. rRAPTOR: all journeys departing within a time window (e.g. the next hour), so the planner
   doesn't suggest leaving earlier than needed (Anděl -> Letiště via Zličín leaves 7 min early,
   Křižíkova -> I. P. Pavlova 2 min).
2. Step-free routes: skip stairs and escalators in the station graph, use elevators and
   `wheelchair_boarding`, as an option of the planner.
3. Load once, query many times: a small HTTP API (`/plan?from=&to=&time=`) and a web page with
   a map (Leaflet), with the feed kept in memory.
4. A binary cache of the loaded timetable for a date, so startup isn't parsing CSV every time.
