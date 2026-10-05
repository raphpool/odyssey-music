import { chmod, lstat, mkdtemp, readFile, rename, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApnsPushStore, createPushStore, PushStoreError } from "../../src/mobile/push-store.js";

const SECRET = "A".repeat(43);
const OTHER_SECRET = "B".repeat(43);

async function stateDir(name: string): Promise<string> {
	return mkdtemp(join(tmpdir(), `track1-push-store-${name}-`));
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

function deferred() {
	let resolve: (() => void) | undefined;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return {
		promise,
		resolve: () => resolve?.(),
	};
}

function subscription(
	overrides: Partial<{
		subscriptionId: string;
		secret: string;
		expoToken: string;
		platform: "ios" | "android";
		timezone: string;
	}> = {},
) {
	return {
		subscriptionId: "f9cdb447-c46d-4a97-b4bc-0f7ad73466bd",
		secret: SECRET,
		expoToken: "ExpoPushToken[abcDEF_123-xyz]",
		platform: "ios" as const,
		timezone: "Europe/Paris",
		...overrides,
	};
}

describe("push subscription store", () => {
	it("keeps APNs subscriptions in a separate atomic registry and partitions token replacement", async () => {
		const dir = await stateDir("apns-lifecycle");
		const time = clock();
		const store = await createApnsPushStore({ stateDir: dir, now: time.now });
		const apns = {
			subscriptionId: subscription().subscriptionId,
			secret: SECRET,
			deviceToken: "A1B2",
			appVariant: "preview" as const,
			apnsEnvironment: "sandbox" as const,
			timezone: "Europe/Paris",
		};
		const created = await store.create(apns);
		const retried = await store.create(apns);
		await store.create({
			...apns,
			subscriptionId: "67fd896e-0b5f-466d-8b9b-93c8df9cc8ce",
			appVariant: "production",
			apnsEnvironment: "production",
		});
		await store.create({
			...apns,
			subscriptionId: "a30fe0ec-3c27-4a5e-a9ca-f1b0d9d63d20",
		});

		expect(created).toMatchObject({ kind: "created", subscription: { enabled: true } });
		expect(retried).toEqual({ kind: "existing", subscription: created.subscription });
		expect((await store.list()).find((entry) => entry.subscriptionId === apns.subscriptionId)).toMatchObject({
			enabled: false,
		});
		expect((await store.list()).find((entry) => entry.appVariant === "production")).toMatchObject({
			enabled: true,
		});
		const serialized = await readFile(join(dir, "push-apns-subscriptions.json"), "utf8");
		expect(serialized).toContain('"device_token":"a1b2"');
		expect(serialized).not.toContain(SECRET);
		expect(await readFile(join(dir, "push-subscriptions.json"), "utf8").catch(() => null)).toBeNull();

		await writeFile(join(dir, "push-apns-subscriptions.json"), "{bad json");
		await expect(store.list()).rejects.toMatchObject({ code: "corrupt_registry" });
	});

	it("fails closed for concurrent or unsynced APNs registry writes", async () => {
		const apns = {
			subscriptionId: subscription().subscriptionId,
			secret: SECRET,
			deviceToken: "a1b2",
			appVariant: "preview" as const,
			apnsEnvironment: "sandbox" as const,
			timezone: "Europe/Paris",
		};
		const entered = deferred();
		const release = deferred();
		let holdFirstStore = false;
		const dir = await stateDir("apns-inter-process-lock");
		const first = await createApnsPushStore({
			stateDir: dir,
			testHooks: {
				afterLoad: async () => {
					if (!holdFirstStore) return;
					entered.resolve();
					await release.promise;
				},
			},
		});
		const second = await createApnsPushStore({ stateDir: dir });
		holdFirstStore = true;
		const firstWrite = first.create(apns);
		await entered.promise;
		await expect(second.list()).rejects.toMatchObject({ code: "corrupt_registry" });
		release.resolve();
		await expect(firstWrite).resolves.toMatchObject({ kind: "created" });

		const unsynced = await createApnsPushStore({
			stateDir: await stateDir("apns-unsynced"),
			syncDirectory: async () => {
				throw new Error("directory fsync failed");
			},
		});
		await expect(unsynced.create(apns)).rejects.toMatchObject({ code: "corrupt_registry" });
		await expect(unsynced.list()).rejects.toMatchObject({ code: "corrupt_registry" });
	});

	it("creates, persists, retries and updates subscriptions without persisting the bearer secret", async () => {
		const dir = await stateDir("lifecycle");
		const time = clock();
		const store = await createPushStore({ stateDir: dir, now: time.now });
		const created = await store.create(subscription());
		const retried = await store.create(subscription());

		expect(created).toMatchObject({
			kind: "created",
			subscription: { enabled: true, activatedLocalDate: "2026-09-26" },
		});
		expect(retried).toEqual({ kind: "existing", subscription: created.subscription });
		const serialized = JSON.parse(await readFile(join(dir, "push-subscriptions.json"), "utf8")) as {
			subscriptions: Array<Record<string, unknown>>;
		};
		expect(JSON.stringify(serialized)).not.toContain(SECRET);
		expect(serialized.subscriptions[0]).toMatchObject({
			subscription_id: subscription().subscriptionId,
			secret_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
			expo_token: subscription().expoToken,
			activated_local_date: "2026-09-26",
		});
		expect(serialized.subscriptions[0]).not.toHaveProperty("secret");

		const disabled = await store.update({ ...subscription(), enabled: false });
		expect(disabled).toMatchObject({ enabled: false, activatedLocalDate: "2026-09-26" });
		time.advance(24 * 60 * 60 * 1000);
		const reactivated = await store.update({
			...subscription(),
			enabled: true,
			timezone: "America/New_York",
		});
		expect(reactivated).toMatchObject({
			enabled: true,
			timezone: "America/New_York",
			activatedLocalDate: "2026-09-27",
		});

		const restarted = await createPushStore({ stateDir: dir, now: time.now });
		expect(await restarted.list()).toHaveLength(1);
	});

	it("serializes duplicate tokens and disables the old subscription without exposing it", async () => {
		const store = await createPushStore({ stateDir: await stateDir("duplicate-token") });
		await store.create(subscription());
		await Promise.all([
			store.create(subscription({ subscriptionId: "67fd896e-0b5f-466d-8b9b-93c8df9cc8ce" })),
			store.create(subscription({ subscriptionId: "a30fe0ec-3c27-4a5e-a9ca-f1b0d9d63d20" })),
		]);

		const entries = await store.list();
		expect(
			entries.filter((entry) => entry.enabled && entry.expoToken === subscription().expoToken),
		).toHaveLength(1);
		expect(entries.find((entry) => entry.subscriptionId === subscription().subscriptionId)).toMatchObject({
			enabled: false,
		});

		const disabledStore = await createPushStore({ stateDir: await stateDir("disabled-duplicate-token") });
		await disabledStore.create(subscription());
		await disabledStore.create(
			subscription({
				subscriptionId: "dea9228b-4c8f-4f50-bf0d-46a12de262a3",
				expoToken: "ExpoPushToken[replacement-token]",
			}),
		);
		await disabledStore.update({
			...subscription({
				subscriptionId: "dea9228b-4c8f-4f50-bf0d-46a12de262a3",
				expoToken: subscription().expoToken,
			}),
			enabled: false,
		});
		const disabledEntries = await disabledStore.list();
		expect(
			disabledEntries.find((entry) => entry.subscriptionId === subscription().subscriptionId),
		).toMatchObject({
			enabled: true,
		});
		expect(
			disabledEntries.find((entry) => entry.subscriptionId === "dea9228b-4c8f-4f50-bf0d-46a12de262a3"),
		).toMatchObject({ enabled: false });
	});

	it("limits new subscriptions after pruning while retaining idempotent and lifecycle operations", async () => {
		const dir = await stateDir("capacity");
		const time = clock();
		const store = await createPushStore({ stateDir: dir, now: time.now, maxSubscriptions: 1 });
		await store.create(subscription());
		await expect(
			store.create(subscription({ subscriptionId: "67fd896e-0b5f-466d-8b9b-93c8df9cc8ce" })),
		).rejects.toMatchObject({ code: "capacity_exceeded" });
		await expect(store.create(subscription())).resolves.toMatchObject({ kind: "existing" });
		await expect(store.update({ ...subscription(), enabled: false })).resolves.toMatchObject({
			enabled: false,
		});
		await store.remove({ subscriptionId: subscription().subscriptionId, secret: SECRET });
		await expect(
			store.create(subscription({ subscriptionId: "67fd896e-0b5f-466d-8b9b-93c8df9cc8ce" })),
		).resolves.toMatchObject({ kind: "created" });

		time.advance(90 * 24 * 60 * 60 * 1000 + 1);
		await expect(
			store.create(subscription({ subscriptionId: "a30fe0ec-3c27-4a5e-a9ca-f1b0d9d63d20" })),
		).resolves.toMatchObject({ kind: "created" });
	});

	it("rejects changed POST identities and unauthenticated changes without changing stored data", async () => {
		const store = await createPushStore({ stateDir: await stateDir("authorization") });
		await store.create(subscription());
		await expect(store.create(subscription({ timezone: "America/New_York" }))).rejects.toMatchObject({
			code: "conflict",
		});
		await expect(
			store.update({ ...subscription({ secret: OTHER_SECRET }), enabled: false }),
		).rejects.toMatchObject({
			code: "unauthorized",
		});
		await expect(
			store.remove({ subscriptionId: subscription().subscriptionId, secret: OTHER_SECRET }),
		).rejects.toMatchObject({
			code: "unauthorized",
		});
		expect((await store.list())[0]).toMatchObject({ enabled: true });
	});

	it("expires inactive subscriptions after 90 days with an injectable clock", async () => {
		const dir = await stateDir("prune");
		const time = clock();
		const store = await createPushStore({ stateDir: dir, now: time.now });
		await store.create(subscription());
		time.advance(90 * 24 * 60 * 60 * 1000 + 1);
		expect(await store.pruneInactive()).toBe(1);
		expect(await store.list()).toEqual([]);
	});

	it("fails closed for corruption or symlinks and writes owner-only state", async () => {
		const corruptDir = await stateDir("corrupt");
		const corruptPath = join(corruptDir, "push-subscriptions.json");
		await writeFile(corruptPath, "{bad json", "utf8");
		await expect(createPushStore({ stateDir: corruptDir })).rejects.toBeInstanceOf(PushStoreError);
		expect(await readFile(corruptPath, "utf8")).toBe("{bad json");

		const symlinkDir = await stateDir("symlink");
		const link = join(symlinkDir, "push-subscriptions.json");
		await symlink("missing.json", link);
		await expect(createPushStore({ stateDir: symlinkDir })).rejects.toMatchObject({
			code: "corrupt_registry",
		});
		expect((await lstat(link)).isSymbolicLink()).toBe(true);

		const symlinkRoot = await stateDir("symlink-root");
		const linkedStateDir = join(symlinkRoot, "linked-state");
		await symlink("missing-state", linkedStateDir);
		await expect(createPushStore({ stateDir: linkedStateDir })).rejects.toMatchObject({
			code: "corrupt_registry",
		});
		expect((await lstat(linkedStateDir)).isSymbolicLink()).toBe(true);

		const permissionsDir = await stateDir("permissions");
		await chmod(permissionsDir, 0o755);
		const store = await createPushStore({ stateDir: permissionsDir });
		await store.create(subscription());
		expect((await stat(permissionsDir)).mode & 0o077).toBe(0);
		expect((await stat(join(permissionsDir, "push-subscriptions.json"))).mode & 0o077).toBe(0);
		await chmod(join(permissionsDir, "push-subscriptions.json"), 0o600);

		const duplicateTokenDir = await stateDir("duplicate-active-token");
		const duplicateTokenStore = await createPushStore({ stateDir: duplicateTokenDir });
		await duplicateTokenStore.create(subscription());
		const duplicatePath = join(duplicateTokenDir, "push-subscriptions.json");
		const duplicateRegistry = JSON.parse(await readFile(duplicatePath, "utf8")) as {
			subscriptions: Array<Record<string, unknown>>;
		};
		const original = duplicateRegistry.subscriptions[0];
		if (!original) throw new Error("test setup has no subscription");
		duplicateRegistry.subscriptions.push({
			...original,
			subscription_id: "67fd896e-0b5f-466d-8b9b-93c8df9cc8ce",
		});
		await writeFile(duplicatePath, JSON.stringify(duplicateRegistry));
		await expect(createPushStore({ stateDir: duplicateTokenDir })).rejects.toMatchObject({
			code: "corrupt_registry",
		});
	});

	it("fails closed when a persisted registry disappears, is swapped, or cannot durably fsync", async () => {
		const deletedDir = await stateDir("deleted-registry");
		const deletedStore = await createPushStore({ stateDir: deletedDir });
		await deletedStore.create(subscription());
		await unlink(join(deletedDir, "push-subscriptions.json"));
		await expect(deletedStore.list()).rejects.toMatchObject({ code: "corrupt_registry" });
		await expect(deletedStore.create(subscription())).rejects.toMatchObject({ code: "corrupt_registry" });

		const swappedDir = await stateDir("swapped-registry");
		const swappedStore = await createPushStore({ stateDir: swappedDir });
		const swappedPath = join(swappedDir, "push-subscriptions.json");
		await swappedStore.create(subscription());
		await unlink(swappedPath);
		await symlink("other-registry.json", swappedPath);
		await expect(swappedStore.list()).rejects.toMatchObject({ code: "corrupt_registry" });
		expect((await lstat(swappedPath)).isSymbolicLink()).toBe(true);

		const unsyncedDir = await stateDir("unsynced-directory");
		const unsyncedStore = await createPushStore({
			stateDir: unsyncedDir,
			syncDirectory: async (path) => {
				expect(await readFile(join(path, "push-subscriptions.json"), "utf8")).toContain("subscription_id");
				throw new Error("directory fsync failed");
			},
		});
		await expect(unsyncedStore.create(subscription())).rejects.toMatchObject({ code: "corrupt_registry" });
		await expect(unsyncedStore.list()).rejects.toMatchObject({ code: "corrupt_registry" });
	});

	it("uses the loaded file and directory identities as an optimistic commit precondition", async () => {
		const createdDuringWriteDir = await stateDir("created-during-write");
		const createdDuringWritePath = join(createdDuringWriteDir, "push-subscriptions.json");
		let createTarget = false;
		const createdDuringWriteStore = await createPushStore({
			stateDir: createdDuringWriteDir,
			testHooks: {
				afterLoad: async () => {
					if (createTarget) await writeFile(createdDuringWritePath, "attacker-created");
				},
			},
		});
		createTarget = true;
		await expect(createdDuringWriteStore.create(subscription())).rejects.toMatchObject({
			code: "corrupt_registry",
		});
		expect(await readFile(createdDuringWritePath, "utf8")).toBe("attacker-created");

		const replacedDuringWriteDir = await stateDir("replaced-during-write");
		const replacedDuringWritePath = join(replacedDuringWriteDir, "push-subscriptions.json");
		let replaceTarget = false;
		const replacedDuringWriteStore = await createPushStore({
			stateDir: replacedDuringWriteDir,
			testHooks: {
				beforeCommit: async () => {
					if (replaceTarget) await writeFile(replacedDuringWritePath, "attacker-replaced");
				},
			},
		});
		await replacedDuringWriteStore.create(subscription());
		replaceTarget = true;
		await expect(
			replacedDuringWriteStore.update({ ...subscription(), enabled: false }),
		).rejects.toMatchObject({ code: "corrupt_registry" });
		expect(await readFile(replacedDuringWritePath, "utf8")).toBe("attacker-replaced");

		const swappedDirectory = await stateDir("directory-swap");
		const originalDirectory = `${swappedDirectory}-original`;
		let swapDirectory = false;
		const swappedDirectoryStore = await createPushStore({
			stateDir: swappedDirectory,
			testHooks: {
				afterLoad: async () => {
					if (!swapDirectory) return;
					await rename(swappedDirectory, originalDirectory);
					await symlink(originalDirectory, swappedDirectory);
				},
			},
		});
		swapDirectory = true;
		await expect(swappedDirectoryStore.create(subscription())).rejects.toMatchObject({
			code: "corrupt_registry",
		});
		expect((await lstat(swappedDirectory)).isSymbolicLink()).toBe(true);
		expect(
			await readFile(join(originalDirectory, "push-subscriptions.json"), "utf8").catch(() => null),
		).toBeNull();
	});

	it("treats invalid data from disk as a permanently unavailable registry", async () => {
		const dir = await stateDir("invalid-disk-entry");
		const store = await createPushStore({ stateDir: dir });
		await store.create(subscription());
		const path = join(dir, "push-subscriptions.json");
		const registry = JSON.parse(await readFile(path, "utf8")) as {
			subscriptions: Array<Record<string, unknown>>;
		};
		const first = registry.subscriptions[0];
		if (!first) throw new Error("test setup has no subscription");
		first.expo_token = "not-an-expo-token";
		await writeFile(path, JSON.stringify(registry));
		await expect(store.list()).rejects.toMatchObject({ code: "corrupt_registry" });
		await expect(store.list()).rejects.toMatchObject({ code: "corrupt_registry" });
	});

	it("rejects a tampered temporary file and valid registry substitutions between operations", async () => {
		const tamperedDir = await stateDir("tampered-temporary");
		const tamperedPath = join(tamperedDir, "push-subscriptions.json");
		const tamperedStore = await createPushStore({
			stateDir: tamperedDir,
			testHooks: {
				beforeCommit: async ({ temporaryPath }) => {
					await writeFile(temporaryPath, "tampered");
				},
			},
		});
		await expect(tamperedStore.create(subscription())).rejects.toMatchObject({ code: "corrupt_registry" });
		await expect(readFile(tamperedPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

		const changedDir = await stateDir("valid-change-between-calls");
		const changedStore = await createPushStore({ stateDir: changedDir });
		await changedStore.create(subscription());
		const changedPath = join(changedDir, "push-subscriptions.json");
		const validRegistry = JSON.parse(await readFile(changedPath, "utf8")) as {
			subscriptions: Array<Record<string, unknown>>;
		};
		const entry = validRegistry.subscriptions[0];
		if (!entry) throw new Error("test setup has no subscription");
		entry.enabled = false;
		await writeFile(changedPath, JSON.stringify(validRegistry));
		await expect(changedStore.list()).rejects.toMatchObject({ code: "corrupt_registry" });
	});

	it("serializes stores with a fail-closed inter-process sentinel lock", async () => {
		const dir = await stateDir("inter-process-lock");
		const entered = deferred();
		const release = deferred();
		let holdFirstStore = false;
		const first = await createPushStore({
			stateDir: dir,
			testHooks: {
				afterLoad: async () => {
					if (!holdFirstStore) return;
					entered.resolve();
					await release.promise;
				},
			},
		});
		const second = await createPushStore({ stateDir: dir });
		holdFirstStore = true;
		const firstWrite = first.create(subscription());
		await entered.promise;
		await expect(second.list()).rejects.toMatchObject({ code: "corrupt_registry" });
		release.resolve();
		await expect(firstWrite).resolves.toMatchObject({ kind: "created" });
		await expect(second.list()).rejects.toMatchObject({ code: "corrupt_registry" });

		const staleDir = await stateDir("stale-lock");
		const staleLock = join(staleDir, ".push-subscriptions.lock");
		await writeFile(staleLock, "stale");
		await expect(createPushStore({ stateDir: staleDir })).rejects.toMatchObject({ code: "corrupt_registry" });
		expect(await readFile(staleLock, "utf8")).toBe("stale");
	});

	it("never deletes a replacement lock and rejects a directory swap before lock creation", async () => {
		const replacementDir = await stateDir("replacement-lock");
		const replacementPath = join(replacementDir, ".push-subscriptions.lock");
		let replaceLock = false;
		const replacementStore = await createPushStore({
			stateDir: replacementDir,
			testHooks: {
				afterLoad: async () => {
					if (!replaceLock) return;
					await unlink(replacementPath);
					await writeFile(replacementPath, "replacement-process-lock");
				},
			},
		});
		await replacementStore.create(subscription());
		replaceLock = true;
		await expect(replacementStore.update({ ...subscription(), enabled: false })).rejects.toMatchObject({
			code: "corrupt_registry",
		});
		expect(await readFile(replacementPath, "utf8")).toBe("replacement-process-lock");

		const swappedDir = await stateDir("swap-before-lock");
		const originalDir = `${swappedDir}-original`;
		let swapBeforeLock = false;
		const swappedStore = await createPushStore({
			stateDir: swappedDir,
			testHooks: {
				afterLockPin: async () => {
					if (!swapBeforeLock) return;
					await rename(swappedDir, originalDir);
					await symlink(originalDir, swappedDir);
				},
			},
		});
		swapBeforeLock = true;
		await expect(swappedStore.create(subscription())).rejects.toMatchObject({ code: "corrupt_registry" });
		expect((await lstat(swappedDir)).isSymbolicLink()).toBe(true);
		await expect(readFile(join(originalDir, ".push-subscriptions.lock"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
		await expect(readFile(join(originalDir, "push-subscriptions.json"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
});
