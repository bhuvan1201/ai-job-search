import { join } from "path";
import { readFileSync } from "node:fs";

// A loopback stand-in for the Algolia HN Search API and the Firebase HN API,
// serving the JSON fixtures. The CLI is pointed at it through the
// HN_ALGOLIA_API_URL / HN_FIREBASE_API_URL env overrides, so every test
// exercises the real request/parse/filter/render path offline.

export const FIXTURES = join(import.meta.dir, "fixtures");

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as T;
}

interface Item {
  id: number;
  type?: string;
  title?: string | null;
  text?: string | null;
  author?: string | null;
  created_at_i?: number;
  parent_id?: number | null;
  story_id?: number | null;
  children?: Item[];
}

/** Every item in the fixture threads, flattened, by id (stories, comments, replies). */
function allItems(): Map<number, Item> {
  const map = new Map<number, Item>();
  const walk = (it: Item) => {
    map.set(it.id, it);
    for (const c of it.children ?? []) walk(c);
  };
  walk(fixture<Item>("algolia-thread.json"));
  walk(fixture<Item>("algolia-thread-september.json"));
  // A story that is not a hiring thread, with one comment, for NOT_A_HIRING_POST.
  const other: Item = {
    id: 42000000,
    type: "story",
    title: "Ask HN: Who wants to be hired? (October 2026)",
    created_at_i: 1790866834,
    parent_id: null,
    story_id: null,
    children: [
      {
        id: 42000001,
        type: "comment",
        author: "candidate",
        text: "<p>Location: SF | Remote: yes | Willing to relocate: no</p>",
        created_at_i: 1790876000,
        parent_id: 42000000,
        story_id: 42000000,
        children: [],
      },
    ],
  };
  walk(other);
  return map;
}

/** The Firebase shape of a fixture item. */
function toFirebase(it: Item): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: it.id,
    type: it.type ?? "comment",
    by: it.author ?? undefined,
    time: it.created_at_i,
    kids: (it.children ?? []).map((c) => c.id),
  };
  if (it.type === "story") out.title = it.title;
  else {
    out.parent = it.parent_id;
    if (it.text === null) out.deleted = true;
    else out.text = it.text;
  }
  return out;
}

export interface FixtureServer {
  env: Record<string, string>;
  requests: string[];
  stop: () => void;
}

/**
 * Start the loopback server. `override` lets a test replace a response (e.g.
 * a 500 for the Algolia items endpoint, to force the Firebase fallback) by path.
 */
export function startFixtureServer(override: (path: string) => Response | null = () => null): FixtureServer {
  const requests: string[] = [];
  const items = allItems();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      requests.push(path + url.search);
      const o = override(path);
      if (o) return o;

      // Algolia search: /api/v1/search_by_date?tags=story,author_whoishiring&...
      if (path === "/api/v1/search_by_date") {
        if (url.searchParams.get("page") && url.searchParams.get("page") !== "0") {
          return Response.json({ hits: [], nbHits: 4, page: 1, hitsPerPage: 12 });
        }
        return Response.json(fixture("algolia-search.json"));
      }
      // Algolia items: /api/v1/items/<id>
      let m = path.match(/^\/api\/v1\/items\/(\d+)$/);
      if (m) {
        const it = items.get(Number(m[1]));
        return it ? Response.json(it) : new Response("Not Found", { status: 404 });
      }
      // Firebase: /v0/item/<id>.json  (unknown id -> literal null, like the real API)
      m = path.match(/^\/v0\/item\/(\d+)\.json$/);
      if (m) {
        const it = items.get(Number(m[1]));
        return Response.json(it ? toFirebase(it) : null);
      }
      return new Response("Not Found", { status: 404 });
    },
  });
  const base = server.url.toString().replace(/\/$/, "");
  return {
    env: { HN_ALGOLIA_API_URL: base, HN_FIREBASE_API_URL: base },
    requests,
    stop: () => server.stop(true),
  };
}
