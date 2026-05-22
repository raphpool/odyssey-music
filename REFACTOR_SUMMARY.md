# Refactor Summary

1. Single node spec — `01b8a71a51a3ed73cf32abf23f5b09a9bdc12f9b`: added `src/node-spec.ts` and wired schemas, types, pipeline edge metadata, reverse edges, and migration edge iteration to it.
2. Slug centralization — `b22cb3fb27b946aeed3b4fe36e4112565a420715`: replaced inline pipeline slug builders with `makeSlug()`.
3. Shared graph projection — `15c7a5695a1a450f7961b159aec240179c289412`: added `buildGraphFromCache()` and used it from the server and graph build script, including quarantined-ref scrubbing.
4. Config centralization — `14a091f42eff5bbf754020f50c4dd35d4438782b`: added typed config groups and removed raw env reads from runtime modules.
5. Shared logger — `1a2ef2b4e45524fa4996e99fc6e4d3939eda99bc`: added `src/logger.ts` and moved server, CLI, and MusicBrainz logging onto it.
6. Error taxonomy — `b0b3c99536875c5a025212d1e8a5745d17c7a237`: added typed app errors and made cache misses/schema failures explicit.
7. Split `server.ts` — `497e523eb7cf493f6aee947120930864b99c3675`: moved search, materialize, image, graph, and node policy into `src/services/`.
8. Split `runPipeline()` — `6023d4d549997d617c22eede182a3272da593b1a`: extracted research, Gemini draft generation, MusicBrainz enrichment, validation, and metrics stages around a short orchestrator.
9. Kill split-brain materialization — `02ff2569be093dd89d1147d97fb38fb0c04dcbff`: moved the old agent to `src/legacy/` and routed active entrypoints/tests through `runPipeline()`.
10. Remove free-text `/materialize` branch — `b75ed25caaa2929d62c0d31ae2dde0dbd8a96ecd`: made `/materialize` require structured `{type, name}` input and return 400 otherwise.
11. Move dangerous Python migration — `854c5eb41b1b670bce62d7495ba7d4553633f427`: moved the dedupe script under `scripts/migrations/`, required `--cache-dir`, and kept edge metadata sourced from the TS spec.
12. Delete dead exports — `2b0be5d8f0d8c6376e6633364ba5b0990900cc91`: removed unused schema exports and unused `CacheIndex` members.
13. Rename MusicBrainz catalog API — `ca7ba57339fad2057fe1dc512be516e590d225ab`: renamed `openCatalogIndex()` to `createMusicBrainzCatalog()` and removed stale DB-path usage.
14. Add npm ops aliases — `394cac643e07383632a0df5a53b37d9cc0289b7a`: added graph, coverage, top-up, smoke, and deploy script aliases.
15. Move incident comments to ADRs — `6ad904a0ec15fc53515d9f8ebcdc6224abd4bc49`: added ADRs and shortened pipeline/stream incident comments to invariants.
16. Rewrite docs — `a2b6980df24e0f51e20a959dc6b8d0ff60bb1cda`: rewrote README and IMPLEMENTATION for the current server/JIT/pipeline/MB HTTP architecture.
17. Fix schema fixtures — `f7afef1816541b084287d06a548f1065cb7d9fd0`: split schema rejection tests so each fixture has exactly one invalidation reason.
18. Live pipeline test — `02ff2569be093dd89d1147d97fb38fb0c04dcbff`: renamed the live test to `pipeline.live.test.ts` and made it call `runPipeline()`.

Supporting verifier compatibility — `c3e8cb409bfc75ad7c5507f8df845b2d09fdf56a`: added a Python node-spec dump wrapper that delegates to the TypeScript spec.
