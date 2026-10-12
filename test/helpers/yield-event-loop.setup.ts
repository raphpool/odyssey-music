import { afterEach } from "vitest";

// 2026-10-12 (TRA-377): CI job `test` failed with `[vitest-worker]: Timeout calling "onTaskUpdate"`
// while every test passed. Vitest's worker->main RPC has a hard-coded 60 s timeout (birpc
// DEFAULT_TIMEOUT, not configurable). Files whose tests block the worker with spawnSync/execFileSync
// (test/genre-cache-sync.test.ts, test/ios-check.test.ts) run back to back without the event loop ever
// reaching its poll phase, so once such a file exceeds ~60 s on a loaded machine the RPC replies are
// never read and the pending-call timer fires. Yielding one macrotask after each test lets the loop
// read pending replies; it changes no test outcome.
afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
