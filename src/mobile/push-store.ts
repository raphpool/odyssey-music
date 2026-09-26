import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

const REGISTRY_FILE = "push-subscriptions.json";
const LOCK_FILE = ".push-subscriptions.lock";
const REGISTRY_VERSION = 1;
const INACTIVE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SUBSCRIPTIONS = 1000;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const EXPO_TOKEN_PATTERN = /^(?:Expo|Exponent)PushToken\[[A-Za-z0-9_+=/-]{1,200}\]$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PushPlatform = "ios" | "android";

export interface PushSubscription {
	subscriptionId: string;
	expoToken: string;
	platform: PushPlatform;
	timezone: string;
	enabled: boolean;
	activatedLocalDate: string;
	createdAt: string;
	lastSeenAt: string;
	lastReservedLocalDate?: string;
	lastSentAt?: string;
}

export interface PushSubscriptionPublic {
	subscriptionId: string;
	enabled: boolean;
	timezone: string;
	activatedLocalDate: string;
}

export interface CreatePushSubscriptionInput {
	subscriptionId: unknown;
	secret: unknown;
	expoToken: unknown;
	platform: unknown;
	timezone: unknown;
}

export interface UpdatePushSubscriptionInput extends CreatePushSubscriptionInput {
	enabled: unknown;
}

export interface RemovePushSubscriptionInput {
	subscriptionId: string;
	secret: string;
}

export type CreatePushSubscriptionResult =
	| { kind: "created"; subscription: PushSubscriptionPublic }
	| { kind: "existing"; subscription: PushSubscriptionPublic };

export interface PushStore {
	create(input: CreatePushSubscriptionInput): Promise<CreatePushSubscriptionResult>;
	update(input: UpdatePushSubscriptionInput): Promise<PushSubscriptionPublic>;
	remove(input: RemovePushSubscriptionInput): Promise<void>;
	pruneInactive(): Promise<number>;
	list(): Promise<PushSubscription[]>;
}

export interface PushStoreOptions {
	stateDir: string;
	now?: () => Date;
	maxSubscriptions?: number;
	syncDirectory?: (path: string, directory: FileHandle) => Promise<void>;
	testHooks?: {
		afterLoad?: () => Promise<void> | void;
		afterLockPin?: () => Promise<void> | void;
		beforeCommit?: (context: { temporaryPath: string }) => Promise<void> | void;
	};
}

export class PushStoreError extends Error {
	constructor(
		readonly code:
			| "capacity_exceeded"
			| "conflict"
			| "corrupt_registry"
			| "invalid_subscription"
			| "not_found"
			| "unauthorized",
		message: string,
	) {
		super(message);
		this.name = "PushStoreError";
	}
}

interface StoredPushSubscription extends PushSubscription {
	secretHash: string;
}

interface ValidatedPushSubscriptionInput {
	subscriptionId: string;
	secret: string;
	expoToken: string;
	platform: PushPlatform;
	timezone: string;
}

interface Registry {
	version: 1;
	subscriptions: StoredPushSubscription[];
}

interface ReadRegistryResult {
	registry: Registry;
	expected: ExpectedRegistryState;
}

interface FileIdentity {
	device: number;
	inode: number;
}

interface PinnedDirectory {
	file: FileHandle;
	identity: FileIdentity;
}

interface RegistryLock {
	path: string;
	file: FileHandle;
	identity: FileIdentity;
	directory: PinnedDirectory;
}

type ExpectedRegistryState =
	| { kind: "absent"; directory: FileIdentity | null }
	| { kind: "existing"; directory: FileIdentity; file: FileIdentity; digest: string };

export async function createPushStore(options: PushStoreOptions): Promise<PushStore> {
	const now = options.now ?? (() => new Date());
	const maxSubscriptions = validateMaxSubscriptions(options.maxSubscriptions);
	const syncDirectory = options.syncDirectory ?? syncStateDirectory;
	const registryPath = join(options.stateDir, REGISTRY_FILE);
	let tail: Promise<void> = Promise.resolve();
	let expectedRegistry: ExpectedRegistryState = { kind: "absent", directory: null };
	let unavailable = false;

	async function serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = tail.then(operation, operation);
		tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async function withRegistry<T>(mutate: (registry: Registry, pruned: number) => T | Promise<T>): Promise<T> {
		return serialize(async () => {
			if (unavailable) throw new PushStoreError("corrupt_registry", "push subscription store is unavailable");
			let lock: RegistryLock | null = null;
			let result: T | undefined;
			let failure: unknown;
			try {
				lock = await acquireRegistryLock(options.stateDir, options.testHooks?.afterLockPin);
				await assertActiveLock(lock);
				const loaded = await readRegistry(
					options.stateDir,
					registryPath,
					expectedRegistry.kind === "existing",
				);
				assertMonotonicRegistryState(expectedRegistry, loaded.expected);
				expectedRegistry = loaded.expected;
				await options.testHooks?.afterLoad?.();
				await assertActiveLock(lock);
				const registry = loaded.registry;
				const before = JSON.stringify(registry);
				const countBeforePrune = registry.subscriptions.length;
				pruneInactive(registry, now());
				const operationResult = await mutate(registry, countBeforePrune - registry.subscriptions.length);
				if (before !== JSON.stringify(registry)) {
					const activeLock = lock;
					if (!activeLock) {
						throw new PushStoreError("corrupt_registry", "push subscription lock is unavailable");
					}
					await assertActiveLock(activeLock);
					await writeRegistry(
						options.stateDir,
						registryPath,
						registry,
						expectedRegistry,
						syncDirectory,
						options.testHooks?.beforeCommit,
						() => assertActiveLock(activeLock),
					);
					expectedRegistry = await readExpectedRegistryState(options.stateDir, registryPath, true);
				}
				result = operationResult;
			} catch (error) {
				failure = error;
			}
			if (lock) {
				try {
					await releaseRegistryLock(lock);
				} catch {
					unavailable = true;
					failure = new PushStoreError("corrupt_registry", "push subscription lock cannot be released");
				}
			}
			if (failure instanceof PushStoreError) {
				if (failure.code === "corrupt_registry") unavailable = true;
				throw failure;
			}
			if (failure) {
				unavailable = true;
				throw new PushStoreError("corrupt_registry", "push subscription state cannot be persisted");
			}
			return result as T;
		});
	}

	await serialize(async () => {
		let lock: RegistryLock | null = null;
		let failure: unknown;
		try {
			lock = await acquireRegistryLock(options.stateDir, options.testHooks?.afterLockPin);
			await assertActiveLock(lock);
			const loaded = await readRegistry(options.stateDir, registryPath, false);
			expectedRegistry = loaded.expected;
		} catch (error) {
			failure = error;
		}
		if (lock) {
			try {
				await releaseRegistryLock(lock);
			} catch {
				failure = new PushStoreError("corrupt_registry", "push subscription lock cannot be released");
			}
		}
		if (failure) {
			unavailable = true;
			throw failure;
		}
	});

	return {
		create: async (input) =>
			withRegistry((registry) => {
				const normalized = validateCreateInput(input);
				const existing = registry.subscriptions.find(
					(subscription) => subscription.subscriptionId === normalized.subscriptionId,
				);
				if (existing) {
					if (!constantTimeSecretMatch(existing.secretHash, normalized.secret)) {
						throw new PushStoreError("unauthorized", "push subscription authorization is invalid");
					}
					if (!sameIdentity(existing, normalized)) {
						throw new PushStoreError(
							"conflict",
							"push subscription identity conflicts with an existing subscription",
						);
					}
					return { kind: "existing", subscription: toPublic(existing) };
				}
				if (registry.subscriptions.length >= maxSubscriptions) {
					throw new PushStoreError("capacity_exceeded", "push subscription capacity is exhausted");
				}
				deactivateDuplicateTokens(registry.subscriptions, normalized.expoToken, normalized.subscriptionId);
				const timestamp = now().toISOString();
				const { secret, ...identity } = normalized;
				const subscription: StoredPushSubscription = {
					...identity,
					secretHash: hashSecret(secret),
					enabled: true,
					activatedLocalDate: localDate(now(), normalized.timezone),
					createdAt: timestamp,
					lastSeenAt: timestamp,
				};
				registry.subscriptions.push(subscription);
				return { kind: "created", subscription: toPublic(subscription) };
			}),
		update: async (input) =>
			withRegistry((registry) => {
				const normalized = validateUpdateInput(input);
				const subscription = registry.subscriptions.find(
					(candidate) => candidate.subscriptionId === normalized.subscriptionId,
				);
				if (!subscription) throw new PushStoreError("not_found", "push subscription does not exist");
				if (!constantTimeSecretMatch(subscription.secretHash, normalized.secret)) {
					throw new PushStoreError("unauthorized", "push subscription authorization is invalid");
				}
				const wasEnabled = subscription.enabled;
				subscription.expoToken = normalized.expoToken;
				subscription.platform = normalized.platform;
				subscription.timezone = normalized.timezone;
				subscription.enabled = normalized.enabled;
				subscription.lastSeenAt = now().toISOString();
				if (!wasEnabled && normalized.enabled) {
					subscription.activatedLocalDate = localDate(now(), normalized.timezone);
				}
				if (normalized.enabled) {
					deactivateDuplicateTokens(registry.subscriptions, normalized.expoToken, normalized.subscriptionId);
				}
				return toPublic(subscription);
			}),
		remove: async (input) =>
			withRegistry((registry) => {
				const subscriptionId = validateSubscriptionId(input.subscriptionId);
				const secret = validateSecret(input.secret);
				const index = registry.subscriptions.findIndex(
					(subscription) => subscription.subscriptionId === subscriptionId,
				);
				if (index === -1) return;
				const subscription = registry.subscriptions[index];
				if (!subscription || !constantTimeSecretMatch(subscription.secretHash, secret)) {
					throw new PushStoreError("unauthorized", "push subscription authorization is invalid");
				}
				registry.subscriptions.splice(index, 1);
			}),
		pruneInactive: async () => withRegistry((_registry, pruned) => pruned),
		list: async () => withRegistry((registry) => registry.subscriptions.map(copySubscription)),
	};
}

async function readRegistry(
	stateDir: string,
	path: string,
	requireExisting: boolean,
): Promise<ReadRegistryResult> {
	try {
		const expected = await readExpectedRegistryState(stateDir, path, requireExisting);
		if (expected.kind === "absent")
			return { registry: { version: REGISTRY_VERSION, subscriptions: [] }, expected };
		const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const metadata = await file.stat();
			if (!sameFileIdentity(toFileIdentity(metadata), expected.file)) {
				throw new PushStoreError("corrupt_registry", "push subscription registry changed while reading");
			}
			const raw = await file.readFile("utf8");
			if (hashRegistry(raw) !== expected.digest) {
				throw new PushStoreError("corrupt_registry", "push subscription registry changed while reading");
			}
			return { registry: parseRegistry(raw), expected };
		} finally {
			await file.close();
		}
	} catch (error) {
		if (error instanceof PushStoreError) throw error;
		throw new PushStoreError("corrupt_registry", "push subscription registry cannot be read");
	}
}

async function acquireRegistryLock(
	stateDir: string,
	afterLockPin: (() => Promise<void> | void) | undefined,
): Promise<RegistryLock> {
	try {
		await mkdir(stateDir, { recursive: true, mode: 0o700 });
	} catch {
		throw new PushStoreError("corrupt_registry", "push subscription lock is unavailable");
	}
	const directory = await openPinnedDirectory(stateDir, false);
	if (!directory)
		throw new PushStoreError("corrupt_registry", "push subscription state directory is unavailable");
	const path = join(stateDir, LOCK_FILE);
	let lock: RegistryLock | null = null;
	let file: FileHandle | null = null;
	try {
		await directory.file.chmod(0o700);
		await assertPinnedDirectoryPath(stateDir, directory.identity);
		await afterLockPin?.();
		await assertPinnedDirectoryPath(stateDir, directory.identity);
		file = await open(
			path,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		);
		lock = { path, file, identity: toFileIdentity(await file.stat()), directory };
		file = null;
		await assertPinnedDirectoryPath(stateDir, directory.identity);
		await assertOwnedLockPath(lock);
		await lock.file.sync();
		await directory.file.sync();
		return lock;
	} catch (error) {
		if (lock) {
			await discardOwnedLock(lock);
		} else {
			if (file) await file.close().catch(() => undefined);
			await directory.file.close();
		}
		if (error instanceof PushStoreError) throw error;
		throw new PushStoreError("corrupt_registry", "push subscription lock is unavailable");
	}
}

async function releaseRegistryLock(lock: RegistryLock): Promise<void> {
	try {
		await assertPinnedDirectoryPathFromHandle(lock.path, lock.directory);
		await assertOwnedLockPath(lock);
		await lock.file.close();
		await unlink(lock.path);
		await lock.directory.file.sync();
	} finally {
		await lock.file.close().catch(() => undefined);
		await lock.directory.file.close();
	}
}

async function assertActiveLock(lock: RegistryLock): Promise<void> {
	await assertPinnedDirectoryPathFromHandle(lock.path, lock.directory);
	await assertOwnedLockPath(lock);
}

async function discardOwnedLock(lock: RegistryLock): Promise<void> {
	try {
		await assertPinnedDirectoryPathFromHandle(lock.path, lock.directory);
		await assertOwnedLockPath(lock);
		await lock.file.close();
		await unlink(lock.path);
		await lock.directory.file.sync();
	} catch {
		// A swapped directory or lock is intentionally left in place. Removing an
		// unproven sentinel could unlock another process's critical section.
	} finally {
		await lock.file.close().catch(() => undefined);
		await lock.directory.file.close();
	}
}

function assertMonotonicRegistryState(previous: ExpectedRegistryState, current: ExpectedRegistryState): void {
	if (previous.kind !== current.kind || !sameNullableIdentity(previous.directory, current.directory)) {
		throw new PushStoreError("corrupt_registry", "push subscription registry changed between operations");
	}
	if (
		previous.kind === "existing" &&
		current.kind === "existing" &&
		(!sameFileIdentity(previous.file, current.file) || previous.digest !== current.digest)
	) {
		throw new PushStoreError("corrupt_registry", "push subscription registry changed between operations");
	}
}

async function readExpectedRegistryState(
	stateDir: string,
	path: string,
	requireExisting: boolean,
): Promise<ExpectedRegistryState> {
	const directory = await openPinnedDirectory(stateDir, !requireExisting);
	if (!directory) return { kind: "absent", directory: null };
	try {
		const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const metadata = await file.stat();
			if (!metadata.isFile()) {
				throw new PushStoreError("corrupt_registry", "push subscription registry is not a regular file");
			}
			const raw = await file.readFile("utf8");
			return {
				kind: "existing",
				directory: directory.identity,
				file: toFileIdentity(metadata),
				digest: hashRegistry(raw),
			};
		} finally {
			await file.close();
		}
	} catch (error) {
		if (isMissingFile(error) && !requireExisting) return { kind: "absent", directory: directory.identity };
		if (error instanceof PushStoreError) throw error;
		throw new PushStoreError("corrupt_registry", "push subscription registry cannot be read");
	} finally {
		await directory.file.close();
	}
}

async function writeRegistry(
	stateDir: string,
	path: string,
	registry: Registry,
	expected: ExpectedRegistryState,
	syncDirectory: (path: string, directory: FileHandle) => Promise<void>,
	beforeCommit: ((context: { temporaryPath: string }) => Promise<void> | void) | undefined,
	assertLock: () => Promise<void>,
): Promise<void> {
	await mkdir(stateDir, { recursive: true, mode: 0o700 });
	const directory = await openPinnedDirectory(stateDir, false);
	if (!directory)
		throw new PushStoreError("corrupt_registry", "push subscription state directory is unavailable");
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	let file: FileHandle | null = null;
	let renamed = false;
	try {
		if (expected.directory && !sameFileIdentity(directory.identity, expected.directory)) {
			throw new PushStoreError("corrupt_registry", "push subscription state directory changed");
		}
		await assertPinnedDirectoryPath(stateDir, directory.identity);
		await directory.file.chmod(0o700);
		file = await open(temporaryPath, "wx", 0o600);
		const serialized = `${JSON.stringify(serializeRegistry(registry))}\n`;
		await file.writeFile(serialized, "utf8");
		await file.sync();
		const temporaryMetadata = await file.stat();
		const temporaryState = {
			file: toFileIdentity(temporaryMetadata),
			digest: hashRegistry(serialized),
			contents: serialized,
		};
		await file.close();
		file = null;
		await beforeCommit?.({ temporaryPath });
		await assertLock();
		await assertPinnedDirectoryPath(stateDir, directory.identity);
		await assertTemporaryState(temporaryPath, temporaryState);
		await assertExpectedRegistryState(path, expected);
		await rename(temporaryPath, path);
		renamed = true;
		await syncDirectory(stateDir, directory.file);
		await assertPinnedDirectoryPath(stateDir, directory.identity);
	} finally {
		if (file) await file.close();
		if (!renamed) {
			// If the path no longer resolves to the pinned directory, deleting by
			// pathname could affect a replacement directory. Leave the random temp
			// file behind rather than following a swapped path.
			await assertPinnedDirectoryPath(stateDir, directory.identity)
				.then(() => unlink(temporaryPath))
				.catch(() => undefined);
		}
		await directory.file.close();
	}
}

async function openPinnedDirectory(stateDir: string, allowMissing: boolean): Promise<PinnedDirectory | null> {
	try {
		const file = await open(stateDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		try {
			const metadata = await file.stat();
			if (!metadata.isDirectory()) {
				throw new PushStoreError("corrupt_registry", "push subscription state directory is invalid");
			}
			return { file, identity: toFileIdentity(metadata) };
		} catch (error) {
			await file.close();
			throw error;
		}
	} catch (error) {
		if (isMissingFile(error) && allowMissing) return null;
		if (error instanceof PushStoreError) throw error;
		throw new PushStoreError("corrupt_registry", "push subscription state directory cannot be read");
	}
}

async function assertPinnedDirectoryPath(stateDir: string, expected: FileIdentity): Promise<void> {
	const current = await openPinnedDirectory(stateDir, false);
	if (!current)
		throw new PushStoreError("corrupt_registry", "push subscription state directory is unavailable");
	try {
		if (!sameFileIdentity(current.identity, expected)) {
			throw new PushStoreError("corrupt_registry", "push subscription state directory changed");
		}
	} finally {
		await current.file.close();
	}
}

async function assertPinnedDirectoryPathFromHandle(path: string, directory: PinnedDirectory): Promise<void> {
	await assertPinnedDirectoryPath(dirname(path), directory.identity);
}

async function assertOwnedLockPath(lock: RegistryLock): Promise<void> {
	try {
		const file = await open(lock.path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const metadata = await file.stat();
			if (!metadata.isFile() || !sameFileIdentity(toFileIdentity(metadata), lock.identity)) {
				throw new PushStoreError("corrupt_registry", "push subscription lock changed");
			}
		} finally {
			await file.close();
		}
	} catch (error) {
		if (error instanceof PushStoreError) throw error;
		throw new PushStoreError("corrupt_registry", "push subscription lock cannot be verified");
	}
}

async function assertTemporaryState(
	path: string,
	expected: { file: FileIdentity; digest: string; contents: string },
): Promise<void> {
	try {
		const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const metadata = await file.stat();
			const contents = await file.readFile("utf8");
			if (
				!sameFileIdentity(toFileIdentity(metadata), expected.file) ||
				hashRegistry(contents) !== expected.digest ||
				contents !== expected.contents
			) {
				throw new PushStoreError(
					"corrupt_registry",
					"push subscription temporary registry changed before commit",
				);
			}
		} finally {
			await file.close();
		}
	} catch (error) {
		if (error instanceof PushStoreError) throw error;
		throw new PushStoreError("corrupt_registry", "push subscription temporary registry cannot be verified");
	}
}

async function assertExpectedRegistryState(path: string, expected: ExpectedRegistryState): Promise<void> {
	try {
		const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			if (expected.kind === "absent") {
				throw new PushStoreError("corrupt_registry", "push subscription registry was unexpectedly created");
			}
			const metadata = await file.stat();
			const raw = await file.readFile("utf8");
			if (
				!sameFileIdentity(toFileIdentity(metadata), expected.file) ||
				hashRegistry(raw) !== expected.digest
			) {
				throw new PushStoreError("corrupt_registry", "push subscription registry changed before commit");
			}
		} finally {
			await file.close();
		}
	} catch (error) {
		if (isMissingFile(error) && expected.kind === "absent") return;
		if (error instanceof PushStoreError) throw error;
		throw new PushStoreError("corrupt_registry", "push subscription registry cannot be verified");
	}
}

async function syncStateDirectory(_stateDir: string, directory: FileHandle): Promise<void> {
	await directory.sync();
}

function toFileIdentity(metadata: { dev: number; ino: number }): FileIdentity {
	return { device: metadata.dev, inode: metadata.ino };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
	return left.device === right.device && left.inode === right.inode;
}

function sameNullableIdentity(left: FileIdentity | null, right: FileIdentity | null): boolean {
	return left === null ? right === null : right !== null && sameFileIdentity(left, right);
}

function hashRegistry(raw: string): string {
	return createHash("sha256").update(raw).digest("hex");
}

function parseRegistry(raw: string): Registry {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new PushStoreError("corrupt_registry", "push subscription registry is not valid JSON");
	}
	if (!isRecord(value) || value.version !== REGISTRY_VERSION || !Array.isArray(value.subscriptions)) {
		throw new PushStoreError("corrupt_registry", "push subscription registry has an unsupported shape");
	}
	const subscriptions = value.subscriptions.map(validateStoredSubscription);
	if (
		new Set(subscriptions.map((subscription) => subscription.subscriptionId)).size !== subscriptions.length
	) {
		throw new PushStoreError("corrupt_registry", "push subscription registry has duplicate subscription ids");
	}
	const enabledTokens = subscriptions
		.filter((subscription) => subscription.enabled)
		.map((subscription) => subscription.expoToken);
	if (new Set(enabledTokens).size !== enabledTokens.length) {
		throw new PushStoreError("corrupt_registry", "push subscription registry has duplicate active tokens");
	}
	return { version: REGISTRY_VERSION, subscriptions };
}

function validateStoredSubscription(value: unknown): StoredPushSubscription {
	try {
		if (!isRecord(value)) throw new Error("entry is not an object");
		const { secret: _, ...base } = validateCreateInput({
			subscriptionId: value.subscription_id,
			secret: "A".repeat(43),
			expoToken: value.expo_token,
			platform: value.platform,
			timezone: value.timezone,
		});
		if (typeof value.secret_hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.secret_hash)) {
			throw new Error("secret hash is invalid");
		}
		if (typeof value.enabled !== "boolean") throw new Error("enabled state is invalid");
		return {
			...base,
			secretHash: value.secret_hash,
			enabled: value.enabled,
			activatedLocalDate: validateLocalDate(value.activated_local_date),
			createdAt: validateTimestamp(value.created_at),
			lastSeenAt: validateTimestamp(value.last_seen_at),
			...(value.last_reserved_local_date === undefined
				? {}
				: { lastReservedLocalDate: validateLocalDate(value.last_reserved_local_date) }),
			...(value.last_sent_at === undefined ? {} : { lastSentAt: validateTimestamp(value.last_sent_at) }),
		};
	} catch {
		throw new PushStoreError("corrupt_registry", "push subscription entry is invalid");
	}
}

function validateCreateInput(input: CreatePushSubscriptionInput): ValidatedPushSubscriptionInput {
	return {
		subscriptionId: validateSubscriptionId(input.subscriptionId),
		secret: validateSecret(input.secret),
		expoToken: validateExpoToken(input.expoToken),
		platform: validatePlatform(input.platform),
		timezone: validateTimezone(input.timezone),
	};
}

function validateUpdateInput(
	input: UpdatePushSubscriptionInput,
): ValidatedPushSubscriptionInput & { enabled: boolean } {
	if (typeof input.enabled !== "boolean") {
		throw new PushStoreError("invalid_subscription", "push subscription enabled must be boolean");
	}
	return { ...validateCreateInput(input), enabled: input.enabled };
}

function validateSubscriptionId(value: unknown): string {
	if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
		throw new PushStoreError("invalid_subscription", "push subscription id is invalid");
	}
	return value.toLowerCase();
}

function validateSecret(value: unknown): string {
	if (
		typeof value !== "string" ||
		!SECRET_PATTERN.test(value) ||
		Buffer.from(value, "base64url").length !== 32
	) {
		throw new PushStoreError("invalid_subscription", "push subscription authorization is invalid");
	}
	return value;
}

function validateExpoToken(value: unknown): string {
	if (typeof value !== "string" || !EXPO_TOKEN_PATTERN.test(value)) {
		throw new PushStoreError("invalid_subscription", "push token is invalid");
	}
	return value;
}

function validatePlatform(value: unknown): PushPlatform {
	if (value === "ios" || value === "android") return value;
	throw new PushStoreError("invalid_subscription", "push platform is invalid");
}

function validateTimezone(value: unknown): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 100 || value.trim() !== value) {
		throw new PushStoreError("invalid_subscription", "push timezone is invalid");
	}
	try {
		return new Intl.DateTimeFormat("en-CA", { timeZone: value }).resolvedOptions().timeZone;
	} catch {
		throw new PushStoreError("invalid_subscription", "push timezone is invalid");
	}
}

function validateTimestamp(value: unknown): string {
	if (typeof value !== "string" || !Number.isFinite(new Date(value).getTime())) {
		throw new PushStoreError("corrupt_registry", "push subscription timestamp is invalid");
	}
	return value;
}

function validateLocalDate(value: unknown): string {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		throw new PushStoreError("corrupt_registry", "push subscription local date is invalid");
	}
	return value;
}

function deactivateDuplicateTokens(
	subscriptions: StoredPushSubscription[],
	expoToken: string,
	excludedSubscriptionId: string,
): void {
	for (const subscription of subscriptions) {
		if (
			subscription.subscriptionId !== excludedSubscriptionId &&
			subscription.enabled &&
			subscription.expoToken === expoToken
		) {
			subscription.enabled = false;
		}
	}
}

function sameIdentity(existing: StoredPushSubscription, input: ValidatedPushSubscriptionInput): boolean {
	return (
		existing.expoToken === input.expoToken &&
		existing.platform === input.platform &&
		existing.timezone === input.timezone
	);
}

function validateMaxSubscriptions(value: number | undefined): number {
	if (value === undefined) return DEFAULT_MAX_SUBSCRIPTIONS;
	if (!Number.isInteger(value) || value < 1 || value > DEFAULT_MAX_SUBSCRIPTIONS) {
		throw new Error(`maxSubscriptions must be an integer between 1 and ${DEFAULT_MAX_SUBSCRIPTIONS}`);
	}
	return value;
}

function hashSecret(secret: string): string {
	return `sha256:${createHash("sha256").update(secret).digest("hex")}`;
}

function constantTimeSecretMatch(secretHash: string, secret: string): boolean {
	const expected = Buffer.from(secretHash);
	const received = Buffer.from(hashSecret(secret));
	return expected.length === received.length && timingSafeEqual(expected, received);
}

function localDate(date: Date, timezone: string): string {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(date);
	const values = new Map(parts.map((part) => [part.type, part.value]));
	const year = values.get("year");
	const month = values.get("month");
	const day = values.get("day");
	if (!year || !month || !day) throw new Error("Intl did not provide a local date");
	return `${year}-${month}-${day}`;
}

function pruneInactive(registry: Registry, current: Date): void {
	const cutoff = current.getTime() - INACTIVE_TTL_MS;
	registry.subscriptions = registry.subscriptions.filter(
		(subscription) => new Date(subscription.lastSeenAt).getTime() > cutoff,
	);
}

function toPublic(subscription: PushSubscription): PushSubscriptionPublic {
	return {
		subscriptionId: subscription.subscriptionId,
		enabled: subscription.enabled,
		timezone: subscription.timezone,
		activatedLocalDate: subscription.activatedLocalDate,
	};
}

function copySubscription(subscription: StoredPushSubscription): PushSubscription {
	const { secretHash: _, ...copy } = subscription;
	return structuredClone(copy);
}

function serializeRegistry(registry: Registry) {
	return {
		version: REGISTRY_VERSION,
		subscriptions: registry.subscriptions.map((subscription) => ({
			subscription_id: subscription.subscriptionId,
			secret_hash: subscription.secretHash,
			expo_token: subscription.expoToken,
			platform: subscription.platform,
			timezone: subscription.timezone,
			enabled: subscription.enabled,
			activated_local_date: subscription.activatedLocalDate,
			created_at: subscription.createdAt,
			last_seen_at: subscription.lastSeenAt,
			...(subscription.lastReservedLocalDate === undefined
				? {}
				: { last_reserved_local_date: subscription.lastReservedLocalDate }),
			...(subscription.lastSentAt === undefined ? {} : { last_sent_at: subscription.lastSentAt }),
		})),
	};
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
