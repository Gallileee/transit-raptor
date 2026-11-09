# Progress log

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

Not verified yet: the real PID feed. Downloading it (~46 MB from data.pid.cz) needs the owner's
OK; then record load time, memory and query time here.

## Next steps (in order)

1. Run on the real PID feed: load time, memory, a few known journeys checked against pid.cz.
2. rRAPTOR: all journeys departing within a time window (e.g. the next hour), so the planner
   doesn't suggest leaving earlier than needed.
3. Load once, query many times: a small HTTP API (`/plan?from=&to=&time=`) and a web page with
   a map (Leaflet), with the feed kept in memory.
4. A binary cache of the loaded timetable for a date, so startup isn't parsing CSV every time.
