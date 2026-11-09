// Download Prague's PID timetable (GTFS) into data/pid.
//
// Source: https://pid.cz/o-systemu/opendata/ - regenerated every day around 04:00, about 50 MB
// zipped. Licence: CC BY 4.0 (credit: "PID / ROPID"; https://creativecommons.org/licenses/by/4.0/).
//
// Node has no built-in unzip, so the archive is extracted with the system's tools: `tar`
// (bsdtar, part of Windows 10+ and macOS, reads zip files) or `unzip` (Linux).
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const URL = "https://data.pid.cz/PID_GTFS.zip";
const dataDir = join(import.meta.dirname, "..", "data");
const zip = join(dataDir, "PID_GTFS.zip");
const target = join(dataDir, "pid");

mkdirSync(dataDir, { recursive: true });
console.log(`Downloading ${URL} ...`);
const response = await fetch(URL, { headers: { "User-Agent": "transit-raptor (https://github.com/Gallileee/transit-raptor)" } });
if (!response.ok) {
  console.error(`Download failed: HTTP ${response.status} ${response.statusText}`);
  process.exit(1);
}
const bytes = Buffer.from(await response.arrayBuffer());
writeFileSync(zip, bytes);
console.log(`Saved ${(bytes.length / 1e6).toFixed(1)} MB to ${zip}`);

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
const attempts = [
  ["tar", ["-xf", zip, "-C", target]],
  ["unzip", ["-q", "-o", zip, "-d", target]],
];
for (const [command, args] of attempts) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status === 0) {
    console.log(`Extracted to ${target}`);
    process.exit(0);
  }
}
console.error(`Could not extract ${zip}: neither "tar -xf" nor "unzip" worked. Extract it to ${target} by hand.`);
process.exit(1);
