/**
 * A small HTTP server: a JSON API over the planner, and the web page in web/.
 *
 *   GET /api/stops?q=andel[&date=YYYY-MM-DD]          -> ["Anděl"]
 *   GET /api/plan?from=&to=[&date=][&time=HH:MM][&window=MIN][&maxTransfers=N][&list=1]
 *   GET /, /app.js, /style.css                        -> the page
 *
 * Only node:http, no framework: three routes don't need one. It listens on 127.0.0.1 unless told
 * otherwise, serves a fixed list of files (no paths from the URL reach the file system) and
 * answers bad input with 400 and a message, never with a stack trace.
 */
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { FeedError } from "./gtfs.js";
import { type Planner, RequestError } from "./service.js";
import { TimeError } from "./time.js";

const WEB_DIR = join(import.meta.dirname, "..", "web");

const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
};

// The page loads Leaflet from cdnjs and map tiles from OpenStreetMap; nothing else.
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdnjs.cloudflare.com",
  "style-src 'self' https://cdnjs.cloudflare.com",
  "img-src 'self' data: https://tile.openstreetmap.org",
  "connect-src 'self'",
  "frame-ancestors 'none'",
].join("; ");

export function createAppServer(planner: Planner, log: (line: string) => void = () => {}): Server {
  return createServer((req, res) => {
    handle(planner, req, res).catch((e: unknown) => {
      log(`error: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      if (!res.headersSent) json(res, 500, { error: "internal error" });
      else res.end();
    });
  });
}

async function handle(planner: Planner, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    json(res, 405, { error: "method not allowed" });
    return;
  }

  const page = STATIC[url.pathname];
  if (page) {
    const body = await readFile(join(WEB_DIR, page.file));
    res.writeHead(200, {
      "Content-Type": page.type,
      "Content-Security-Policy": CSP,
      "Cache-Control": "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : body);
    return;
  }

  try {
    if (url.pathname === "/api/stops") {
      const q = url.searchParams.get("q") ?? "";
      json(res, 200, q.trim() ? await planner.stops(q, url.searchParams.get("date") ?? undefined) : []);
      return;
    }
    if (url.pathname === "/api/plan") {
      const p = url.searchParams;
      json(
        res,
        200,
        await planner.plan({
          from: p.get("from") ?? "",
          to: p.get("to") ?? "",
          date: p.get("date") || undefined,
          time: p.get("time") || undefined,
          window: number(p.get("window"), "window"),
          maxTransfers: number(p.get("maxTransfers"), "maxTransfers"),
          list: p.get("list") === "1" || p.get("list") === "true",
        }),
      );
      return;
    }
  } catch (e) {
    if (e instanceof RequestError) {
      json(res, 400, { error: e.message, suggestions: e.suggestions });
      return;
    }
    if (e instanceof TimeError) {
      json(res, 400, { error: e.message, suggestions: [] });
      return;
    }
    if (e instanceof FeedError) {
      json(res, 503, { error: `the timetable can't be loaded: ${e.message}` });
      return;
    }
    throw e;
  }
  json(res, 404, { error: "not found" });
}

function number(text: string | null, name: string): number | undefined {
  if (text === null || text === "") return undefined;
  const value = Number(text);
  if (!Number.isFinite(value)) throw new RequestError(`${name} must be a number`);
  return value;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}
