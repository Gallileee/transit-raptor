/**
 * A small streaming reader for GTFS CSV files.
 *
 * GTFS files follow RFC 4180: comma-separated, a header row, fields optionally in double
 * quotes, with `""` for a quote inside a quoted field. stop_times.txt for a whole city has
 * millions of rows, so the file is read line by line and each row is handed to a callback
 * instead of building one big array.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export class CsvError extends Error {}

/** Split one CSV line into fields. Quoted fields may contain commas and doubled quotes. */
export function parseLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      let value = "";
      i++;
      for (;;) {
        const quote = line.indexOf('"', i);
        if (quote === -1) throw new CsvError(`unterminated quoted field: ${line}`);
        value += line.slice(i, quote);
        if (line[quote + 1] === '"') {
          value += '"';
          i = quote + 2;
        } else {
          i = quote + 1;
          break;
        }
      }
      fields.push(value);
      if (i < line.length && line[i] !== ",") throw new CsvError(`text after a closing quote: ${line}`);
      i++; // skip the comma (or step past the end)
    } else {
      const comma = line.indexOf(",", i);
      const end = comma === -1 ? line.length : comma;
      fields.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return fields;
}

/** Access to one row's fields by column name. Missing columns read as "". */
export type Row = (column: string) => string;

/**
 * Stream a CSV file, calling `onRow` for every data row. Returns the number of rows.
 * A UTF-8 byte order mark before the header is ignored; blank lines are skipped.
 */
export async function readCsv(path: string, onRow: (row: Row) => void): Promise<number> {
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  let index: Map<string, number> | undefined;
  let fields: string[] = [];
  const row: Row = (column) => {
    const at = index?.get(column);
    return at === undefined ? "" : (fields[at] ?? "");
  };
  let count = 0;
  for await (const raw of lines) {
    if (raw === "") continue;
    if (index === undefined) {
      const header = parseLine(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
      index = new Map(header.map((name, i) => [name.trim(), i]));
      continue;
    }
    fields = parseLine(raw);
    onRow(row);
    count++;
  }
  return count;
}
