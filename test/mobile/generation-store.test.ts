import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGenerationStore, GenerationStoreError } from "../../src/mobile/generation-store.js";

async function stateDir(name: string): Promise<string> {
	return mkdtemp(join(tmpdir(), `track1-generation-store-${name}-`));
}

function clock(initial = "2026-09-26T12:00:00.000Z") {
	let current = new Date(initial);
	return {
		now: () => new Date(current),
		advance(ms: number) {
			current = new Date(current.getTime() + ms);
		},
	};
}

function fingerprint(request: unknown): string {
	return `sha256:${createHash("sha256")
		.update(JSON.stringify({ userId: "local", request }))
		.digest("hex")}`;
}

describe("generation store", () => {
	it("normalizes a request fingerprint and makes retries idempotent while rejecting a conflict", async () => {
		const dir = await stateDir("idempotency");
		const time = clock();
		const store = await createGenerationStore({ stateDir: dir, now: time.now, newId: () => "generation-1" });

		const first = await store.create({
			userId: " local-profile ",
			idempotencyKey: " request-1 ",
			request: { prompt: "  deep bass  ", tags: [" techno ", "dub"] },
		});
		const retry = await store.create({
			userId: "local-profile",
			idempotencyKey: "request-1",
			request: { tags: ["techno", "dub"], prompt: "deep bass" },
		});

		expect(first.kind).toBe("created");
		expect(retry).toEqual({ kind: "existing", generation: first.generation });
		await expect(
			store.create({
				userId: "local-profile",
				idempotencyKey: "request-1",
				request: { prompt: "other request" },
			}),
		).rejects.toMatchObject({ code: "idempotency_conflict" });
	});

	it("serializes concurrent retries into one persisted generation", async () => {
		const dir = await stateDir("concurrency");
		let nextId = 0;
		const store = await createGenerationStore({ stateDir: dir, newId: () => `generation-${++nextId}` });

		const results = await Promise.all(
			Array.from({ length: 20 }, () =>
				store.create({ userId: "local", idempotencyKey: "same", request: { prompt: "one" } }),
			),
		);

		expect(results.filter((result) => result.kind === "created")).toHaveLength(1);
		expect((await store.list()).map((generation) => generation.id)).toEqual(["generation-1"]);
	});

	it("keeps JSON prototype keys in the fingerprint instead of collapsing distinct requests", async () => {
		const dir = await stateDir("prototype");
		const store = await createGenerationStore({ stateDir: dir, newId: () => "generation-1" });
		await store.create({
			userId: "local",
			idempotencyKey: "same-key",
			request: JSON.parse('{"prompt":"one","__proto__":"present"}') as unknown,
		});

		await expect(
			store.create({ userId: "local", idempotencyKey: "same-key", request: { prompt: "one" } }),
		).rejects.toMatchObject({ code: "idempotency_conflict" });
	});

	it("fails closed when a persisted immediate response has a malformed or wrong-type canonical node id", async () => {
		for (const nodeId of ["artist:Bad Body", "artist:cached-artist ", "project:cached-artist"]) {
			const dir = await stateDir("corrupt-immediate");
			const request = { type: "artist" };
			const timestamp = "2026-09-26T12:00:00.000Z";
			await writeFile(
				join(dir, "generation-store.v1.json"),
				JSON.stringify({
					version: 1,
					generations: [],
					immediateResponses: [
						{
							userId: "local",
							idempotencyKey: "immediate",
							fingerprint: fingerprint(request),
							request,
							nodeId,
							createdAt: timestamp,
							updatedAt: timestamp,
							terminalAt: timestamp,
						},
					],
				}),
			);
			await expect(createGenerationStore({ stateDir: dir })).rejects.toMatchObject({
				code: "corrupt_registry",
			});
		}
	});

	it("validates durable succeeded job node ids before transition and fails closed on reload", async () => {
		const dir = await stateDir("corrupt-outcome");
		const store = await createGenerationStore({ stateDir: dir, newId: () => "generation-1" });
		const created = await store.create({
			userId: "local",
			idempotencyKey: "job",
			request: { type: "artist", name: "Cached artist" },
		});
		await store.transition(created.generation.id, "running");

		for (const nodeId of ["artist:Bad Body", "artist:cached-artist ", "project:cached-artist"]) {
			await expect(store.transition(created.generation.id, "succeeded", { nodeId })).rejects.toMatchObject({
				code: "invalid_generation",
			});
			const active = await store.get(created.generation.id);
			expect(active).toMatchObject({ status: "running" });
			expect(active).not.toHaveProperty("outcome");
		}

		await store.transition(created.generation.id, "succeeded", { nodeId: "artist:cached-artist" });
		const path = join(dir, "generation-store.v1.json");
		const persisted = JSON.parse(await readFile(path, "utf8")) as {
			generations: Array<{ outcome?: { nodeId?: string } }>;
		};
		const generation = persisted.generations[0];
		if (!generation?.outcome) throw new Error("test setup has no terminal outcome");

		for (const nodeId of ["artist:Bad Body", "artist:cached-artist ", "project:cached-artist"]) {
			generation.outcome.nodeId = nodeId;
			await writeFile(path, JSON.stringify(persisted));
			await expect(createGenerationStore({ stateDir: dir })).rejects.toMatchObject({
				code: "corrupt_registry",
			});
		}
	});

	it("rejects inherited status names, mismatched fingerprints, and duplicate idempotency pairs in a registry", async () => {
		const statusDir = await stateDir("invalid-status");
		const statusStore = await createGenerationStore({ stateDir: statusDir, newId: () => "generation-1" });
		await statusStore.create({ userId: "local", idempotencyKey: "one", request: { prompt: "one" } });
		const statusPath = join(statusDir, "generation-store.v1.json");
		const invalidStatus = JSON.parse(await readFile(statusPath, "utf8")) as {
			generations: Array<Record<string, unknown>>;
		};
		const statusGeneration = invalidStatus.generations[0];
		if (!statusGeneration) throw new Error("test setup has no generation");
		statusGeneration.status = "constructor";
		await writeFile(statusPath, JSON.stringify(invalidStatus));
		await expect(createGenerationStore({ stateDir: statusDir })).rejects.toMatchObject({
			code: "corrupt_registry",
		});

		const consistencyDir = await stateDir("consistency");
		const consistencyStore = await createGenerationStore({
			stateDir: consistencyDir,
			newId: () => "generation-1",
		});
		await consistencyStore.create({ userId: "local", idempotencyKey: "one", request: { prompt: "one" } });
		const consistencyPath = join(consistencyDir, "generation-store.v1.json");
		const mismatched = JSON.parse(await readFile(consistencyPath, "utf8")) as {
			generations: Array<Record<string, unknown>>;
		};
		const mismatchedGeneration = mismatched.generations[0];
		if (!mismatchedGeneration) throw new Error("test setup has no generation");
		mismatchedGeneration.fingerprint = `sha256:${"0".repeat(64)}`;
		await writeFile(consistencyPath, JSON.stringify(mismatched));
		await expect(createGenerationStore({ stateDir: consistencyDir })).rejects.toMatchObject({
			code: "corrupt_registry",
		});

		const duplicateDir = await stateDir("duplicate-idempotency");
		const duplicateStore = await createGenerationStore({
			stateDir: duplicateDir,
			newId: () => "generation-1",
		});
		await duplicateStore.create({ userId: "local", idempotencyKey: "one", request: { prompt: "one" } });
		const duplicatePath = join(duplicateDir, "generation-store.v1.json");
		const duplicate = JSON.parse(await readFile(duplicatePath, "utf8")) as {
			generations: Array<Record<string, unknown>>;
		};
		const original = duplicate.generations[0];
		if (!original) throw new Error("test setup has no generation");
		duplicate.generations.push({ ...original, id: "generation-2" });
		await writeFile(duplicatePath, JSON.stringify(duplicate));
		await expect(createGenerationStore({ stateDir: duplicateDir })).rejects.toMatchObject({
			code: "corrupt_registry",
		});
	});

	it("keeps terminal generations immutable and recovers running work without a provider call", async () => {
		const dir = await stateDir("recovery");
		const time = clock();
		let nextId = 0;
		const store = await createGenerationStore({
			stateDir: dir,
			now: time.now,
			newId: () => `generation-${++nextId}`,
		});
		const created = await store.create({
			userId: "local",
			idempotencyKey: "first",
			request: { prompt: "one" },
		});
		await store.transition(created.generation.id, "running");
		const pending = await store.create({
			userId: "local",
			idempotencyKey: "second",
			request: { prompt: "two" },
		});

		const restarted = await createGenerationStore({ stateDir: dir, now: time.now });
		const recovered = await restarted.get(created.generation.id);
		expect(recovered).toMatchObject({ status: "interrupted", terminalAt: time.now().toISOString() });
		expect(await restarted.get(pending.generation.id)).toMatchObject({ status: "interrupted" });
		await expect(restarted.transition(created.generation.id, "succeeded")).rejects.toMatchObject({
			code: "terminal_generation",
		});
	});

	it("expires terminal records after 24 hours but never evicts active records", async () => {
		const dir = await stateDir("ttl");
		const time = clock();
		let nextId = 0;
		const store = await createGenerationStore({
			stateDir: dir,
			now: time.now,
			newId: () => `generation-${++nextId}`,
		});
		const completed = await store.create({
			userId: "local",
			idempotencyKey: "done",
			request: { prompt: "one" },
		});
		await store.transition(completed.generation.id, "running");
		await store.transition(completed.generation.id, "succeeded");
		const active = await store.create({
			userId: "local",
			idempotencyKey: "active",
			request: { prompt: "two" },
		});

		time.advance(24 * 60 * 60 * 1000 + 1);
		await store.create({ userId: "local", idempotencyKey: "new", request: { prompt: "three" } });

		expect(await store.get(completed.generation.id)).toBeNull();
		expect(await store.get(active.generation.id)).toMatchObject({ status: "pending" });
	});

	it("refuses a new request at the terminal cap without evicting active work", async () => {
		const dir = await stateDir("cap");
		const timestamp = "2026-09-26T12:00:00.000Z";
		const store = await createGenerationStore({ stateDir: dir, now: () => new Date(timestamp) });
		const terminal = Array.from({ length: 1000 }, (_, index) => ({
			id: `terminal-${index}`,
			userId: "local",
			idempotencyKey: `terminal-key-${index}`,
			fingerprint: fingerprint({ prompt: "done" }),
			request: { prompt: "done" },
			status: "succeeded",
			createdAt: timestamp,
			updatedAt: timestamp,
			terminalAt: timestamp,
		}));
		const active = {
			id: "active-1",
			userId: "local",
			idempotencyKey: "active-key",
			fingerprint: fingerprint({ prompt: "pending" }),
			request: { prompt: "pending" },
			status: "pending",
			createdAt: timestamp,
			updatedAt: timestamp,
			terminalAt: null,
		};
		await writeFile(
			join(dir, "generation-store.v1.json"),
			JSON.stringify({ version: 1, generations: [...terminal, active] }),
		);
		await expect(
			store.create({ userId: "local", idempotencyKey: "new", request: { prompt: "new" } }),
		).rejects.toMatchObject({
			code: "store_full",
		});
		expect(await store.get("active-1")).toMatchObject({ status: "pending" });
	});

	it("allows an already accepted active generation to become terminal after the cap is reached", async () => {
		const dir = await stateDir("cap-transition");
		const timestamp = "2026-09-26T12:00:00.000Z";
		const store = await createGenerationStore({ stateDir: dir, now: () => new Date(timestamp) });
		const terminal = Array.from({ length: 1000 }, (_, index) => ({
			id: `terminal-${index}`,
			userId: "local",
			idempotencyKey: `terminal-key-${index}`,
			fingerprint: fingerprint({ prompt: "done" }),
			request: { prompt: "done" },
			status: "succeeded",
			createdAt: timestamp,
			updatedAt: timestamp,
			terminalAt: timestamp,
		}));
		const active = {
			id: "accepted-1",
			userId: "local",
			idempotencyKey: "accepted-key",
			fingerprint: fingerprint({ prompt: "paid" }),
			request: { prompt: "paid" },
			status: "running",
			createdAt: timestamp,
			updatedAt: timestamp,
			terminalAt: null,
		};
		await writeFile(
			join(dir, "generation-store.v1.json"),
			JSON.stringify({ version: 1, generations: [...terminal, active] }),
		);
		expect(await store.transition("accepted-1", "succeeded")).toMatchObject({ status: "succeeded" });
	});

	it("fails closed for corrupted or inaccessible state without replacing it, and writes owner-only files", async () => {
		const corruptDir = await stateDir("corrupt");
		const corruptPath = join(corruptDir, "generation-store.v1.json");
		await writeFile(corruptPath, "{not json", "utf8");
		await expect(createGenerationStore({ stateDir: corruptDir })).rejects.toBeInstanceOf(
			GenerationStoreError,
		);
		expect(await readFile(corruptPath, "utf8")).toBe("{not json");

		const fileAsDirectory = join(await stateDir("inaccessible"), "not-a-directory");
		await writeFile(fileAsDirectory, "preserve me", "utf8");
		await expect(createGenerationStore({ stateDir: fileAsDirectory })).rejects.toThrow();
		expect(await readFile(fileAsDirectory, "utf8")).toBe("preserve me");

		const symlinkDir = await stateDir("symlink");
		const registryLink = join(symlinkDir, "generation-store.v1.json");
		await symlink("missing-registry.json", registryLink);
		await expect(createGenerationStore({ stateDir: symlinkDir })).rejects.toMatchObject({
			code: "corrupt_registry",
		});
		expect((await lstat(registryLink)).isSymbolicLink()).toBe(true);

		const permissionsDir = await stateDir("permissions");
		const store = await createGenerationStore({ stateDir: permissionsDir });
		await store.create({ userId: "local", idempotencyKey: "one", request: { prompt: "one" } });
		const permissions = await stat(join(permissionsDir, "generation-store.v1.json"));
		expect(permissions.mode & 0o077).toBe(0);
		await chmod(join(permissionsDir, "generation-store.v1.json"), 0o600);
	});
});
