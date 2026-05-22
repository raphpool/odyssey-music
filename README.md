# Odyssey Music

Odyssey Music is a Culture Graph for music discovery. It stores typed music entities as a graph, serves them over a small HTTP API, and can materialize missing or stale nodes just in time through a deterministic pipeline.

## Model

The graph has five node types:

- `genre`
- `label`
- `artist`
- `project`
- `track`

Node shape, edge cardinality, edge target constraints, teaser fields, and graph-projection metadata live in `src/node-spec.ts`. TypeScript types, Zod schemas, pipeline canonicalization, reverse-edge rules, graph projection, and migrations derive their edge metadata from that spec.

## Runtime Architecture

- `src/server.ts` is the HTTP bootstrap and route dispatcher.
- `src/services/` contains route services for search, materialization, node lookup, image resolution, and graph projection.
- `src/pipeline.ts` exposes `runPipeline()`, the canonical materializer.
- `src/musicbrainz.ts` uses the MusicBrainz HTTP API for catalog search and enrichment. There is no local SQLite MusicBrainz database.
- `src/cache.ts` stores validated node JSON by slug and applies reverse-edge updates.
- `src/cache-index.ts` builds the in-memory autocomplete/cache reconciliation index.
- `src/graph.ts` builds `/data.json` and generated graph JSON from the cache.
- `src/stream.ts` serves cached m4a audio with HTTP Range support through a yt-dlp bridge.

The legacy multi-turn agent loop is isolated under `src/legacy/`. Active server, crawler, scripts, and live tests use `runPipeline()`.

## HTTP API

- `GET /health`
- `GET /version`
- `GET /data.json`
- `GET /node/:slug`
- `GET /image/:slug`
- `GET /search?q=...&type=...`
- `POST /materialize` with `{ "type": "...", "name": "...", "disambiguator"?: "...", "mbid"?: "..." }`
- `GET /resolve/:trackSlug`
- `GET /stream/:videoId`

`/materialize` accepts structured `{type, name}` only. `/node/:slug` serves cache hits and refreshes stale nodes via `runPipeline()` according to the configured node TTL.

## Pipeline

`runPipeline()` performs deterministic research and generation:

1. Build a search query from `{type, name, disambiguator?, mbid?}`.
2. Search with Tavily and rank source results.
3. Fetch top pages with the local fetcher.
4. Ask Gemini for structured JSON using a per-type response schema.
5. Canonicalize slugs and edge fields.
6. Enrich structured metadata from MusicBrainz HTTP where available.
7. Validate with Zod and return node + metrics.

## Cache And Graph

The cache layout is:

```text
cache/
  nodes/<type>/<slug-body>.json
  pending-reverses.json
```

Writes validate payloads, merge queued reverse edges, and enqueue reverse updates for targets that are not cached yet. Graph projection is shared between the live server and `scripts/build-graph-json.ts`.

## Commands

```bash
npm install
npm run lint
npm run typecheck
npm test -- --run
npm run server
npm run crawl -- --seed "track:Tendency" --max-depth 2 --max-nodes 20 --out cache
npm run build:graph
npm run test:live
```

Required API env vars for materialization are `GEMINI_API_KEY`, `TAVILY_API_KEY`, and `FIRECRAWL_API_KEY`.
