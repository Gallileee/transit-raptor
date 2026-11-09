/**
 * Finding stops by the name a person types: "andel" should find every platform of "Anděl".
 */
import type { Stop } from "./gtfs.js";

/** Lower case, without diacritics, single spaces: "  Náměstí  Míru " -> "namesti miru". */
export function normalize(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
}

export type StopMatch =
  | { readonly kind: "found"; readonly name: string; readonly stops: number[] }
  | { readonly kind: "ambiguous"; readonly names: string[] }
  | { readonly kind: "none"; readonly suggestions: string[] };

/** Platforms (and other boardable stops, location_type 0) grouped by normalized name. */
export class StopIndex {
  private readonly byName = new Map<string, { name: string; stops: number[] }>();

  constructor(stops: readonly Stop[]) {
    for (const stop of stops) {
      if (stop.locationType !== 0) continue;
      const key = normalize(stop.name);
      const entry = this.byName.get(key);
      if (entry) entry.stops.push(stop.index);
      else this.byName.set(key, { name: stop.name, stops: [stop.index] });
    }
  }

  /**
   * An exact name (ignoring case and diacritics) wins. Otherwise a single name that starts with
   * the text is taken; several are "ambiguous"; none gives names that contain the text.
   */
  find(text: string, limit = 8): StopMatch {
    const key = normalize(text);
    if (key === "") return { kind: "none", suggestions: [] };
    const exact = this.byName.get(key);
    if (exact) return { kind: "found", name: exact.name, stops: exact.stops };
    const prefix = [...this.byName.entries()].filter(([k]) => k.startsWith(key));
    if (prefix.length === 1) {
      const [, entry] = prefix[0]!;
      return { kind: "found", name: entry.name, stops: entry.stops };
    }
    if (prefix.length > 1) {
      return { kind: "ambiguous", names: prefix.map(([, e]) => e.name).sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, limit) };
    }
    const contains = [...this.byName.entries()].filter(([k]) => k.includes(key)).map(([, e]) => e.name);
    return { kind: "none", suggestions: contains.sort((a, b) => a.localeCompare(b)).slice(0, limit) };
  }
}
