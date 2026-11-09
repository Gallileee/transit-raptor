# transit-raptor

A journey planner for public transport, built on the **RAPTOR** algorithm and real timetables
in the **GTFS** format. Point it at Prague's PID timetable, name two stops, and it finds the
connections: the fastest one for each number of transfers.

```
$ transit-raptor plan --gtfs data/pid --from "Anděl" --to "Letiště" --time 08:00
```

## Why

Journey planners look simple from the outside and are a classic algorithms problem on the
inside. A city like Prague has thousands of stops, tens of thousands of trips a day and
millions of stop times; "how do I get from A to B" has to be answered in milliseconds. This
project implements the algorithm from the paper rather than calling an API, and runs it on a
real, openly licensed timetable.

It is a learning project: [OpenTripPlanner](https://www.opentripplanner.org/) and
[MOTIS](https://github.com/motis-project/motis) are what production systems use.

## How it works

1. **Loading** (`gtfs.ts`). A GTFS feed is a zip of CSV files. `stop_times.txt` is streamed
   line by line (`csv.ts`), and only the trips that run on the requested date are kept: the
   services from `calendar.txt` minus/plus the exceptions in `calendar_dates.txt`, plus trips of
   the *previous* day that are still running after midnight (GTFS writes those as `24:20:00`).
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
5. **Stop names** (`stops.ts`). "andel" finds every platform called "Anděl": names are compared
   without case, diacritics or punctuation; a unique prefix also works.

## On real data

Prague's PID feed of 9 Nov 2026 (valid 9-22 Nov), on a laptop with Node 26:

| | |
|---|---|
| Feed | 1.69 M stop times, 82 k trips, 20 k stops |
| Loading one day | 1.3 s (52 k trips kept), timetable 0.2 s: 6,576 patterns, 61,152 footpaths |
| Station graphs | 68 stations, 1,532 pathways, 2,922 changes, 0.1 s |
| Memory | 361 MB resident, 109 MB heap |
| One query | 2-15 ms |

Compared with the official planner ([IDOS for PID](https://idos.cz/pid/spojeni/)) on Tuesday
10 Nov 2026, every vehicle and arrival time below is the same to the minute:

| Journey | Both planners |
|---|---|
| Anděl -> Muzeum, 08:00 | metro B 08:00, Můstek 08:04, change ~3 min, metro A 08:09, Muzeum 08:10 |
| Anděl -> Letiště, 08:00 | bus 191 08:00-08:49; metro B + bus 100 via Zličín, 08:44; metro B + A + trolleybus 59 via Můstek and Nádraží Veleslavín, 08:41 |
| Dejvická -> Háje, 07:30 | metro A to Muzeum 07:37, change, metro C 07:41-07:58 |
| Křižíkova -> I. P. Pavlova, 17:00 | tram to Florenc, metro C 17:08-17:12 |
| Náměstí Míru -> Národní třída, 17:00 | tram 22 17:01-17:10; metro A, Můstek 17:04, change ~3 min, metro B 17:08-17:09 |

The 45 s buffer is the one number not taken from the feed. The first three journeys bound it
(29-55 s, see `stations.ts`); the last two were checked afterwards, with nothing changed. Where
transit-raptor differs is the departure: with the same arrival it may take an earlier tram or
metro than IDOS (Zličín, Křižíkova), because it doesn't search a time window yet.

## Stack

TypeScript 7 on Node 22+, no runtime dependencies. Vitest for tests. TypeScript because a GTFS
feed is a dozen record types whose fields are easy to mix up (a stop *index* vs a stop *id*, a
time in seconds vs a `HH:MM:SS` string); strict types catch that at compile time.

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
node dist/bin.js stops --gtfs data/pid --search "nadrazi"
```

`--date` and `--time` default to now. Any other unzipped GTFS feed works too: pass its folder as
`--gtfs`. Example output on the test feed:

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

## Tests

```bash
npm test             # vitest
npm run typecheck    # tsc --noEmit, strict
```

The tests run on a hand-made feed (`tests/fixtures/mini`) in which every part exists to test one
thing: a transfer with a walk between platforms, an express that overtakes a slower bus, a stop
where the line doesn't pick up, a night bus past midnight (seen from the next day too), a public
holiday from `calendar_dates.txt`, a walk that only `transfers.txt` allows, a stop with no times,
quoted names with commas and a byte order mark. CI runs them on Node 22 and 24, runs the built
CLI, and checks its own workflow with [workflow-guard](https://github.com/Gallileee/workflow-guard).

## Limitations

- **Earliest arrival for one departure time.** It doesn't yet search a time range ("all
  connections between 8:00 and 9:00"), so it may leave earlier than needed when a later
  departure arrives at the same time (rRAPTOR does that; see next steps).
- Outside the 68 stations with pathways, walking is straight-line distance times a detour
  factor plus a penalty per level, not a street network. Those values are cautious on purpose:
  a too-short change suggests a connection that fails in reality.
- Inside stations, walkways have no lengths or times in PID's feed, so their time is the
  straight line between their ends at 1.2 m/s. Elevators, accessibility (`wheelchair_boarding`,
  stairs-free routes) and signposted exits aren't used yet.
- Footpaths aren't chained (one walk between two vehicles), as in the paper.
- No real-time delays, fares, accessibility, or daylight-saving corrections (GTFS times are
  measured from "noon minus 12 h", which differs from midnight on the two DST days).
- Stops without times in `stop_times.txt` take the previous stop's departure instead of an
  interpolated time.
- The whole day's timetable is loaded for every query (seconds for a city; a server would load
  it once).

## Data

The Prague timetable is published by PID / ROPID at
[pid.cz/o-systemu/opendata](https://pid.cz/o-systemu/opendata/) under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) (credit: PID / ROPID). It is
downloaded by `npm run fetch-pid` and never committed to this repository.

## Next steps

See [PROGRESS.md](PROGRESS.md).

## License

MIT for the code.
