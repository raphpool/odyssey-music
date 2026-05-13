# Implementation notes (Phase 1)

This package implements the **agent + crawler** half of the Culture Graph spec described in
`README.md`. The display algorithm and UI are out of scope here.

## Architecture

```
seed text ──┐
            v
        crawler.ts  ──┐  pops from frontier (BFS, deduped by canonical slug)
                      │
                      v
                 agent.ts  ──▶  pi-agent-core + Gemini 3.1 Flash Lite
                      │              ├─ web_search   (Tavily)
                      │              ├─ fetch_page   (Firecrawl)
                      │              └─ emit_node    (terminates the run)
                      v
                  cache.ts  ──▶  slug-keyed JSON on disk
                      │           reverse-edge materialization
                      │           pending-reverse queue for not-yet-cached targets
                      v
                 frontier ◀── enqueue every edge ref the agent emitted
```

## Modules

| File | What |
|---|---|
| `src/types.ts` | TypeScript types for nodes + per-type edge field lists. |
| `src/schemas.ts` | Zod schemas, discriminated union over the 5 node types. |
| `src/slug.ts` | Canonical slug normalization (collapses spelling variants; keeps personas distinct). |
| `src/reverse-edges.ts` | Forward edge → reverse edge mapping (samples↔sampled_by, etc.). |
| `src/cache.ts` | Slug-keyed on-disk JSON cache with per-slug locks and reverse-edge merging. |
| `src/tools/tavily.ts` | Web search tool wrapper for pi-agent-core. |
| `src/tools/firecrawl.ts` | URL → markdown fetcher tool wrapper for pi-agent-core. |
| `src/agent.ts` | The single-node materialization agent. |
| `src/crawler.ts` | BFS crawler with concurrent workers, budget enforcement, frontier dedup. |
| `src/cli.ts` | `odyssey-crawl` CLI entry. |

## Running

```bash
export GEMINI_API_KEY=...
export TAVILY_API_KEY=...
export FIRECRAWL_API_KEY=...

npm install
npm run check         # lint + typecheck + unit tests

# Crawl
npm run crawl -- --seed "jan jelinek tendency" \
  --max-depth 3 --max-nodes 100 --out /tmp/og1 --concurrency 4
```

## Tests

- `test/slug.test.ts` — spelling variants collapse, personas stay distinct.
- `test/schemas.test.ts` — Zod schemas accept/reject the right things.
- `test/cache.test.ts` — write/read, reverse-edge materialization (cached + pending paths).
- `test/agent.live.test.ts` — **live** test against Tavily/Firecrawl/Gemini, gated on env vars.
  Skipped by default (`npm run test` excludes it). Run with `npm run test:live`.

## E2E verifier

`scripts/verify-e2e.sh` runs the CLI against `"jan jelinek tendency"` with `--max-depth 3
--max-nodes 100` and then `scripts/assert-cache.ts` validates the resulting cache:

- every JSON file passes Zod
- no duplicate slugs
- node count between `min(25, maxNodes)` and `maxNodes`
- reverse-edge invariants hold across all in-cache pairs
- ≥60% of nodes have at least one citation
- average editorial article length sane
