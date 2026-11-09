// Download Prague's PID timetable (GTFS) into data/pid.
//
// Source: https://pid.cz/o-systemu/opendata/ - regenerated every day around 04:00, about 50 MB
// zipped. Licence: CC BY 4.0 (credit: "PID / ROPID"; https://creativecommons.org/licenses/by/4.0/).
//
// Node has no built-in unzip, so the archive is extracted with the system's tools: `unzip`
// (Linux, macOS, Git Bash) or `tar` (bsdtar, part of Windows 10+ and macOS, reads zip files).
// GNU tar (Linux, Git Bash) can't read zip files and takes "C:" for a remote host, so it comes
// second and failed attempts stay quiet unless every one fails.
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
  ["unzip", ["-q", "-o", zip, "-d", target]],
  ["tar", ["-xf", zip, "-C", target]],
];
const errors = [];
for (const [command, args] of attempts) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status === 0) {
    console.log(`Extracted to ${target} with ${command}`);
    process.exit(0);
  }
  errors.push(`${command}: ${(result.error?.message ?? result.stderr ?? "").trim()}`);
}
console.error(`Could not extract ${zip}:\n  ${errors.join("\n  ")}\nExtract it to ${target} by hand.`);
process.exit(1);
