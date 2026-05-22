# Implementation

This repository implements the Odyssey Music server, cache, materialization pipeline, crawler, operational scripts, and tests.

## Main Flow

```text
HTTP request / CLI / script
  -> service layer
  -> runPipeline()
  -> MusicBrainz HTTP enrichment
  -> Zod validation
  -> NodeCache write/read
  -> graph projection or node response
```

`runPipeline()` is the current materializer. The old agent loop is kept only under `src/legacy/` for reference.

## Modules

| Path | Role |
|---|---|
| `src/node-spec.ts` | Single source of truth for node types, edge fields, target constraints, teaser fields, optional text fields, and reverse edge pairs. |
| `src/types.ts` | Node TypeScript interfaces and re-exports from the node spec. |
| `src/schemas.ts` | Zod validation derived from node-spec edge target constraints. |
| `src/pipeline.ts` | Deterministic research, Gemini structured generation, canonicalization, MusicBrainz enrichment, validation, and metrics. |
| `src/services/` | Search, materialize, image, graph, and node services used by HTTP routes. |
| `src/server.ts` | Stdlib HTTP bootstrap, route parsing, response status/header handling. |
| `src/cache.ts` | Slug-keyed JSON cache, validation, locks, reverse-edge writes, pending reverses. |
| `src/cache-index.ts` | In-memory cache search and MBID reconciliation index. |
| `src/graph.ts` | Shared cache-to-graph projection for `/data.json` and build scripts. |
| `src/musicbrainz.ts` | MusicBrainz HTTP catalog and enrichment adapter. |
| `src/stream.ts` | yt-dlp bridge download cache and Range streaming. |
| `src/config.ts` | Centralized env/config groups and policy constants. |
| `src/logger.ts` | Shared structured logger. |

## Materialization

The server performs just-in-time materialization through `POST /materialize` and stale-node refresh through `GET /node/:slug`. Both paths use `runPipeline()` and write through `NodeCache`.

The crawler also uses `runPipeline()` when expanding graph frontiers. It expects structured seeds such as `track:Tendency`; untyped seeds are treated as track names for compatibility with the CLI shape.

## MusicBrainz

MusicBrainz is accessed over HTTP at runtime for search and enrichment. The adapter has no SQLite dependency and no database path configuration.

## Tests

- `npm test -- --run` runs unit tests and excludes live tests.
- `npm run test:live` runs `test/pipeline.live.test.ts` against Tavily, Firecrawl/local fetching, Gemini, and MusicBrainz when keys are present.

## Operational Scripts

Supported aliases are listed in `package.json`: `build:graph`, `analyze:coverage`, `topup:dangling`, `smoke:pipeline`, `deploy:web`, and `deploy:server`.
