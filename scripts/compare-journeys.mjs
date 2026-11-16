// Compare the journeys of this working tree with another version, on a real feed.
//
//   npm run compare-journeys -- [--base main] [--gtfs data/pid] [--date YYYY-MM-DD]
//                               [--count 1000] [--seed 1] [--step-free] [--examples 10]
//                               [--jobs N] [--fail-on-diff]
//
// `npm run compare-journeys` builds this tree first. The base (a branch, tag or commit) is
// built from git into .compare/<commit>/ (gitignored, kept for the next run): its src/ and
// tsconfig files only, compiled with this tree's TypeScript. Each side opens the feed and
// resolves stop names on its own; the logic is in src/compare.ts.
//
// Each side plans in --jobs worker threads (default: 4, or fewer on a smaller machine), each
// with its own copy of the feed (~250 MB) and a share of the queries; both sides at once.
//
// Exit code: 1 if a journey of this tree has a problem (two walks in a row, time going back),
// or with --fail-on-diff if any journey differs; 2 for bad arguments or a base that won't
// build; 0 otherwise.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

const root = join(import.meta.dirname, "..");

if (!isMainThread) {
  // A worker: one side, opened once, then answers the queries it is sent.
  const side = await openSide(workerData);
  parentPort.postMessage({ names: workerData.names ? side.names : undefined });
  const { planQueries } = await import(pathToFileURL(join(root, "dist", "compare.js")).href);
  parentPort.on("message", (queries) => {
    parentPort.postMessage({ planned: planQueries(queries, side) });
    parentPort.close();
  });
}

/** One version: its own feed reading, timetable and search, on the date asked. */
async function openSide({ dist, cacheDir, gtfs, date, stepFree }) {
  const load = (name) => import(pathToFileURL(join(dist, name)).href);
  const [{ openFeed }, { feedForDate }, { buildTimetable }, { plan }, { StopIndex }, time] = await Promise.all(
    ["cache.js", "gtfs.js", "timetable.js", "raptor.js", "stops.js", "time.js"].map(load),
  );
  const { compiled } = await openFeed(gtfs, { cacheDir, shapes: false });
  const now = new Date();
  const day = date ? time.parseDate(date) : { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
  const feed = feedForDate(compiled, day);
  const timetable = buildTimetable(feed, { stepFree });
  const index = new StopIndex(feed.stops);
  return {
    names: [...new Set(feed.trips.flatMap((t) => [...t.stops].map((s) => feed.stops[s].name)))],
    resolve(name) {
      const match = index.find(name);
      return match.kind === "found" ? match.stops : undefined;
    },
    plan: (query) => plan(timetable, query),
    stopId: (i) => feed.stops[i].id,
  };
}

/** A worker for one side; `ready` resolves with its first message (the names, if asked). */
function startWorker(data) {
  const worker = new Worker(new URL(import.meta.url), { workerData: data });
  const messages = [];
  const waiting = [];
  worker.on("message", (m) => (waiting.length > 0 ? waiting.shift().resolve(m) : messages.push(m)));
  let failed;
  worker.on("error", (e) => {
    failed = e;
    waiting.splice(0).forEach((w) => w.reject(e));
  });
  const next = () => {
    if (messages.length > 0) return Promise.resolve(messages.shift());
    if (failed) return Promise.reject(failed);
    return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
  };
  return { worker, next };
}

if (isMainThread) await main();

async function main() {
const { values } = parseArgs({
  options: {
    jobs: { type: "string", default: String(Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)))) },
    base: { type: "string", default: "main" },
    gtfs: { type: "string", default: join(root, "data", "pid") },
    date: { type: "string" },
    count: { type: "string", default: "1000" },
    seed: { type: "string", default: "1" },
    "step-free": { type: "boolean", default: false },
    examples: { type: "string", default: "10" },
    "fail-on-diff": { type: "boolean", default: false },
  },
});
const whole = (name, min) => {
  const n = Number(values[name]);
  if (!Number.isInteger(n) || n < min) fail(`--${name} must be a whole number of at least ${min}`);
  return n;
};
function fail(message) {
  console.error(`compare-journeys: ${message}`);
  process.exit(2);
}
const count = whole("count", 1);
const jobs = whole("jobs", 1);
const seed = whole("seed", 0);
const examples = whole("examples", 0);

const git = (...args) => {
  const run = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) fail(`git ${args.join(" ")}: ${run.stderr.trim()}`);
  return run.stdout;
};

/** Build `ref` into .compare/<commit>/dist (once) and return that folder. */
function buildBase(ref) {
  const commit = git("rev-parse", "--verify", `${ref}^{commit}`).trim();
  const dir = join(root, ".compare", commit.slice(0, 12));
  const dist = join(dir, "dist");
  if (existsSync(join(dist, "raptor.js"))) return { commit, dist };
  rmSync(dir, { recursive: true, force: true });
  const files = git("ls-tree", "-r", "--name-only", commit, "--", "src", "tsconfig.json", "tsconfig.build.json")
    .split("\n")
    .filter(Boolean);
  for (const file of files) {
    const path = join(dir, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, spawnSync("git", ["show", `${commit}:${file}`], { cwd: root, maxBuffer: 64 * 1024 * 1024 }).stdout);
  }
  // Inside the repository, so TypeScript finds this tree's node_modules (types for Node).
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  const build = spawnSync(process.execPath, [tsc, "-p", join(dir, "tsconfig.build.json")], { encoding: "utf8" });
  if (build.status !== 0 || !existsSync(join(dist, "raptor.js"))) {
    fail(`${ref} (${commit.slice(0, 12)}) doesn't build:\n${build.stdout}${build.stderr}`);
  }
  return { commit, dist };
}

if (!existsSync(join(root, "dist", "compare.js"))) fail("build this tree first (npm run build)");
const { compareResults, formatReport, sampleQueries } = await import(pathToFileURL(join(root, "dist", "compare.js")).href);
const base = buildBase(values.base);
const started = performance.now();
const common = { gtfs: values.gtfs, date: values.date, stepFree: values["step-free"] };
const sides = [
  { dist: base.dist, cacheDir: join(root, ".compare", base.commit.slice(0, 12), "cache") },
  { dist: join(root, "dist"), cacheDir: join(values.gtfs, ".transit-raptor-cache") },
];
// The first worker of each side opens the feed alone (and writes its cache, if it has to);
// the others start once it is there. This tree's first worker gives the stop names.
const workers = sides.map((side, s) => [startWorker({ ...common, ...side, names: s === 1 })]);
const firsts = await Promise.all(workers.map(([w]) => w.next()));
for (const [s, side] of sides.entries()) {
  for (let j = 1; j < jobs; j++) workers[s].push(startWorker({ ...common, ...side, names: false }));
}
await Promise.all(workers.flatMap((list) => list.slice(1).map((w) => w.next())));
const queries = sampleQueries(firsts[1].names, count, seed);
// Each worker plans a run of the queries; the answers are put back in order.
const share = Math.ceil(queries.length / jobs);
const [before, after] = await Promise.all(
  workers.map(async (list) => {
    const parts = await Promise.all(
      list.map((w, j) => {
        w.worker.postMessage(queries.slice(j * share, (j + 1) * share));
        return w.next().then((m) => m.planned);
      }),
    );
    return parts.flat();
  }),
);
const report = compareResults(queries, before, after);
const kind = values["step-free"] ? "step-free " : "";
console.log(`${values.base} (${base.commit.slice(0, 12)}) vs this tree, ${kind}journeys on ${values.date ?? "today"}, seed ${seed}:`);
for (const line of formatReport(report, examples)) console.log(line);
console.log(`\n${Math.round(performance.now() - started)} ms (${jobs} job${jobs > 1 ? "s" : ""} a side)`);
process.exit(report.problems.length > 0 || (values["fail-on-diff"] && report.differences.length > 0) ? 1 : 0);
}
