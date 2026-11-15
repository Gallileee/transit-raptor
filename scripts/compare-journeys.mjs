// Compare the journeys of this working tree with another version, on a real feed.
//
//   npm run compare-journeys -- [--base main] [--gtfs data/pid] [--date YYYY-MM-DD]
//                               [--count 1000] [--seed 1] [--step-free] [--examples 10]
//                               [--fail-on-diff]
//
// `npm run compare-journeys` builds this tree first. The base (a branch, tag or commit) is
// built from git into .compare/<commit>/ (gitignored, kept for the next run): its src/ and
// tsconfig files only, compiled with this tree's TypeScript. Each side opens the feed and
// resolves stop names on its own; the logic is in src/compare.ts.
//
// Exit code: 1 if a journey of this tree has a problem (two walks in a row, time going back),
// or with --fail-on-diff if any journey differs; 2 for bad arguments or a base that won't
// build; 0 otherwise.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const root = join(import.meta.dirname, "..");
const { values } = parseArgs({
  options: {
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

/** One version: its own feed reading, timetable and search, on `date`. */
async function side(dist, cacheDir) {
  const load = (name) => import(pathToFileURL(join(dist, name)).href);
  const [{ openFeed }, { feedForDate }, { buildTimetable }, { plan }, { StopIndex }, time] = await Promise.all(
    ["cache.js", "gtfs.js", "timetable.js", "raptor.js", "stops.js", "time.js"].map(load),
  );
  const { compiled } = await openFeed(values.gtfs, { cacheDir, shapes: false });
  const now = new Date();
  const date = values.date ? time.parseDate(values.date) : { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
  const feed = feedForDate(compiled, date);
  const timetable = buildTimetable(feed, { stepFree: values["step-free"] });
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

if (!existsSync(join(root, "dist", "compare.js"))) fail("build this tree first (npm run build)");
const { compareJourneys, formatReport, sampleQueries } = await import(pathToFileURL(join(root, "dist", "compare.js")).href);
const base = buildBase(values.base);
const started = performance.now();
const [before, after] = [
  await side(base.dist, join(root, ".compare", base.commit.slice(0, 12), "cache")),
  await side(join(root, "dist"), join(values.gtfs, ".transit-raptor-cache")),
];
const queries = sampleQueries(after.names, count, seed);
const report = compareJourneys(queries, before, after);
const kind = values["step-free"] ? "step-free " : "";
console.log(`${values.base} (${base.commit.slice(0, 12)}) vs this tree, ${kind}journeys on ${values.date ?? "today"}, seed ${seed}:`);
for (const line of formatReport(report, examples)) console.log(line);
console.log(`\n${Math.round(performance.now() - started)} ms`);
process.exit(report.problems.length > 0 || (values["fail-on-diff"] && report.differences.length > 0) ? 1 : 0);
