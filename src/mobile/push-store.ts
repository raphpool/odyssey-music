import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

const REGISTRY_FILE = "push-subscriptions.json";
const LOCK_FILE = ".push-subscriptions.lock";
const APNS_REGISTRY_FILE = "push-apns-subscriptions.json";
const APNS_LOCK_FILE = ".push-apns-subscriptions.lock";
const REGISTRY_VERSION = 1;
const INACTIVE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const DELIVERY_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SUBSCRIPTIONS = 1000;
const DEFAULT_MAX_DELIVERIES = 2000;
const MAX_RESERVED_LOCAL_DATES = 40;
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
	reservedLocalDates?: string[];
	lastSentAt?: string;
}

export interface PushSubscriptionPublic {
	subscriptionId: string;
	enabled: boolean;
	timezone: string;
	activatedLocalDate: string;
}

export interface PushNotificationReservation {
	subscriptionId: string;
	notificationId: string;
	targetLocalDate: string;
	reservedAt: string;
}

export interface ReserveNotificationOptions {
	requireScheduledEligibility?: boolean;
}

export type PushDeliveryStatus =
	| "reserved"
	| "sending"
	| "accepted"
	| "rejected"
	| "unknown"
	| "receipt_ok"
	| "receipt_error"
	| "receipt_unknown";

export interface PushDelivery extends PushNotificationReservation {
	status: PushDeliveryStatus;
	ticketId?: string;
	acceptedAt?: string;
	finalizedAt?: string;
}

export interface PushNotificationToSend extends PushNotificationReservation {
	expoToken: string;
}

export interface PushReceiptRequest extends PushDelivery {
	ticketId: string;
}

export interface PushSendOutcome {
	notificationId: string;
	status: "accepted" | "rejected" | "unknown";
	ticketId?: string;
	deviceNotRegistered?: boolean;
}

export interface PushReceiptOutcome {
	ticketId: string;
	status: "ok" | "error" | "unknown";
	deviceNotRegistered?: boolean;
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
	reserveNotification(
		reservation: PushNotificationReservation,
		options?: ReserveNotificationOptions,
	): Promise<PushDelivery>;
	claimReservedNotifications(reservations: PushNotificationReservation[]): Promise<PushNotificationToSend[]>;
	recordSendOutcomes(outcomes: PushSendOutcome[]): Promise<void>;
	listReceiptRequests(limit: number): Promise<PushReceiptRequest[]>;
	recordReceiptOutcomes(outcomes: PushReceiptOutcome[]): Promise<void>;
	listDeliveries(): Promise<PushDelivery[]>;
}

export interface PushStoreOptions {
	stateDir: string;
	now?: () => Date;
	maxSubscriptions?: number;
	maxDeliveries?: number;
	syncDirectory?: (path: string, directory: FileHandle) => Promise<void>;
	testHooks?: {
		afterLoad?: () => Promise<void> | void;
		afterLockPin?: () => Promise<void> | void;
		beforeCommit?: (context: { temporaryPath: string }) => Promise<void> | void;
	};
}

export type ApnsAppVariant = "preview" | "production";
export type ApnsEnvironment = "sandbox" | "production";

export interface ApnsPushSubscription {
	subscriptionId: string;
	deviceToken: string;
	appVariant: ApnsAppVariant;
	apnsEnvironment: ApnsEnvironment;
	timezone: string;
	enabled: boolean;
	activatedLocalDate: string;
	createdAt: string;
	lastSeenAt: string;
}

export interface ApnsNotificationReservation {
	subscriptionId: string;
	notificationId: string;
	targetLocalDate: string;
	reservedAt: string;
	deviceToken: string;
	tokenVersion: number;
	appVariant: ApnsAppVariant;
	apnsEnvironment: ApnsEnvironment;
}

export interface CreateApnsPushSubscriptionInput {
	subscriptionId: unknown;
	secret: unknown;
	deviceToken: unknown;
	appVariant: unknown;
	apnsEnvironment: unknown;
	timezone: unknown;
}

export interface UpdateApnsPushSubscriptionInput extends CreateApnsPushSubscriptionInput {
	enabled: unknown;
}

export interface RemoveApnsPushSubscriptionInput {
	subscriptionId: string;
	secret: unknown;
}

export interface ApnsPushStore {
	create(input: CreateApnsPushSubscriptionInput): Promise<CreatePushSubscriptionResult>;
	update(input: UpdateApnsPushSubscriptionInput): Promise<PushSubscriptionPublic>;
	remove(input: RemoveApnsPushSubscriptionInput): Promise<void>;
	pruneInactive(): Promise<number>;
	list(): Promise<ApnsPushSubscription[]>;
	reserveNotification(
		reservation: Omit<
			ApnsNotificationReservation,
			"deviceToken" | "tokenVersion" | "appVariant" | "apnsEnvironment"
		>,
	): Promise<ApnsNotificationReservation>;
	disableReservedToken(reservation: ApnsNotificationReservation): Promise<void>;
}

export interface ApnsPushStoreOptions {
	stateDir: string;
	now?: () => Date;
	maxSubscriptions?: number;
	syncDirectory?: (path: string, directory: FileHandle) => Promise<void>;
	testHooks?: PushStoreOptions["testHooks"];
}

export class PushStoreError extends Error {
	constructor(
		readonly code:
			| "capacity_exceeded"
			| "conflict"
			| "corrupt_registry"
			| "invalid_subscription"
			| "invalid_delivery"
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

interface StoredPushDelivery extends PushDelivery {
	tokenHash: string;
}

interface ValidatedPushSubscriptionInput {
	subscriptionId: string;
	secret: string;
	expoToken: string;
	platform: PushPlatform;
	timezone: string;
}

interface StoredApnsPushSubscription extends ApnsPushSubscription {
	secretHash: string;
	tokenVersion: number;
	reservations?: ApnsNotificationReservation[];
}

interface ValidatedApnsPushSubscriptionInput {
	subscriptionId: string;
	secret: string;
	deviceToken: string;
	appVariant: ApnsAppVariant;
	apnsEnvironment: ApnsEnvironment;
	timezone: string;
}

interface ApnsRegistry {
	version: 1;
	subscriptions: StoredApnsPushSubscription[];
}

interface Registry {
	version: 1;
	subscriptions: StoredPushSubscription[];
	deliveries: StoredPushDelivery[];
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

interface RegistryAccessOptions<T extends { subscriptions: unknown[] }> {
	stateDir: string;
	registryFile: string;
	lockFile: string;
	now: () => Date;
	syncDirectory: (path: string, directory: FileHandle) => Promise<void>;
	testHooks: PushStoreOptions["testHooks"] | undefined;
	parse: (raw: string) => T;
	empty: () => T;
	prune: (registry: T, currentTime: Date) => void;
	serialize: (registry: T) => unknown;
}

async function createRegistryAccess<T extends { subscriptions: unknown[] }>(
	options: RegistryAccessOptions<T>,
): Promise<{
	withRegistry: <R>(mutate: (registry: T, pruned: number, currentTime: Date) => R | Promise<R>) => Promise<R>;
}> {
	const registryPath = join(options.stateDir, options.registryFile);
	let tail: Promise<void> = Promise.resolve();
	let expectedRegistry: ExpectedRegistryState = { kind: "absent", directory: null };
	let unavailable = false;
	async function serialize<R>(operation: () => Promise<R>): Promise<R> {
		const result = tail.then(operation, operation);
		tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
	async function withRegistry<R>(
		mutate: (registry: T, pruned: number, currentTime: Date) => R | Promise<R>,
	): Promise<R> {
		return serialize(async () => {
			if (unavailable) throw new PushStoreError("corrupt_registry", "push subscription store is unavailable");
			let lock: RegistryLock | null = null;
			let result: R | undefined;
			let failure: unknown;
			try {
				lock = await acquireRegistryLock(options.stateDir, options.lockFile, options.testHooks?.afterLockPin);
				await assertActiveLock(lock);
				const loaded = await readRegistry(
					options.stateDir,
					registryPath,
					expectedRegistry.kind === "existing",
					options.parse,
					options.empty,
				);
				assertMonotonicRegistryState(expectedRegistry, loaded.expected);
				expectedRegistry = loaded.expected;
				await options.testHooks?.afterLoad?.();
				await assertActiveLock(lock);
				const registry = loaded.registry;
				const before = JSON.stringify(registry);
				const countBeforePrune = registry.subscriptions.length;
				const currentTime = options.now();
				options.prune(registry, currentTime);
				const operationResult = await mutate(
					registry,
					countBeforePrune - registry.subscriptions.length,
					currentTime,
				);
				if (before !== JSON.stringify(registry)) {
					const activeLock = lock;
					if (!activeLock)
						throw new PushStoreError("corrupt_registry", "push subscription lock is unavailable");
					await assertActiveLock(activeLock);
					await writeRegistry(
						options.stateDir,
						registryPath,
						registry,
						expectedRegistry,
						options.syncDirectory,
						options.testHooks?.beforeCommit,
						() => assertActiveLock(activeLock),
						options.serialize,
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
			return result as R;
		});
	}
	await serialize(async () => {
		let lock: RegistryLock | null = null;
		let failure: unknown;
		try {
			lock = await acquireRegistryLock(options.stateDir, options.lockFile, options.testHooks?.afterLockPin);
			await assertActiveLock(lock);
			const loaded = await readRegistry(options.stateDir, registryPath, false, options.parse, options.empty);
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
	return { withRegistry };
}

export async function createPushStore(options: PushStoreOptions): Promise<PushStore> {
	const now = options.now ?? (() => new Date());
	const maxSubscriptions = validateMaxSubscriptions(options.maxSubscriptions);
	const maxDeliveries = validateMaxDeliveries(options.maxDeliveries);
	const { withRegistry } = await createRegistryAccess({
		stateDir: options.stateDir,
		registryFile: REGISTRY_FILE,
		lockFile: LOCK_FILE,
		now,
		syncDirectory: options.syncDirectory ?? syncStateDirectory,
		testHooks: options.testHooks,
		parse: parseRegistry,
		empty: () => ({ version: 1 as const, subscriptions: [], deliveries: [] }),
		prune: (registry, currentTime) => {
			pruneInactive(registry, currentTime);
			pruneDeliveries(registry, currentTime);
		},
		serialize: serializeRegistry,
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
		reserveNotification: async (reservation, options = {}) =>
			withRegistry((registry, _pruned, currentTime) => {
				const normalized = validateReservation(reservation);
				const existing = registry.deliveries.find(
					(delivery) => delivery.notificationId === normalized.notificationId,
				);
				if (existing) {
					if (!sameReservation(existing, normalized)) {
						throw new PushStoreError("invalid_delivery", "push notification reservation conflicts");
					}
					return copyDelivery(existing);
				}
				const subscription = registry.subscriptions.find(
					(candidate) => candidate.subscriptionId === normalized.subscriptionId,
				);
				if (!subscription || !subscription.enabled) {
					throw new PushStoreError("not_found", "push subscription is not available for delivery");
				}
				if (
					options.requireScheduledEligibility &&
					!isCurrentlyScheduledEligible(subscription, normalized, currentTime)
				) {
					throw new PushStoreError("not_found", "push subscription is not eligible for a scheduled delivery");
				}
				if (
					subscriptionHasReservedDate(subscription, normalized.targetLocalDate) ||
					registry.deliveries.some(
						(delivery) =>
							delivery.subscriptionId === normalized.subscriptionId &&
							delivery.targetLocalDate === normalized.targetLocalDate,
					)
				) {
					throw new PushStoreError(
						"invalid_delivery",
						"push subscription already has a delivery for this date",
					);
				}
				if (registry.deliveries.length >= maxDeliveries) {
					throw new PushStoreError("capacity_exceeded", "push delivery capacity is exhausted");
				}
				subscription.lastReservedLocalDate = normalized.targetLocalDate;
				subscription.reservedLocalDates = appendReservedLocalDate(
					subscription.reservedLocalDates,
					normalized.targetLocalDate,
				);
				const delivery: StoredPushDelivery = {
					...normalized,
					tokenHash: hashToken(subscription.expoToken),
					status: "reserved",
				};
				registry.deliveries.push(delivery);
				return copyDelivery(delivery);
			}),
		claimReservedNotifications: async (reservations) =>
			withRegistry((registry) => {
				const normalized = validateReservationBatch(reservations);
				const claimed: PushNotificationToSend[] = [];
				for (const reservation of normalized) {
					const delivery = registry.deliveries.find(
						(candidate) => candidate.notificationId === reservation.notificationId,
					);
					if (!delivery || !sameReservation(delivery, reservation) || delivery.status !== "reserved") {
						throw new PushStoreError("invalid_delivery", "push notification is not reserved for sending");
					}
					const subscription = registry.subscriptions.find(
						(candidate) => candidate.subscriptionId === reservation.subscriptionId,
					);
					if (
						!subscription ||
						!subscription.enabled ||
						hashToken(subscription.expoToken) !== delivery.tokenHash
					) {
						delivery.status = "rejected";
						delivery.finalizedAt = now().toISOString();
						continue;
					}
					delivery.status = "sending";
					claimed.push({ ...reservation, expoToken: subscription.expoToken });
				}
				return claimed;
			}),
		recordSendOutcomes: async (outcomes) =>
			withRegistry((registry) => {
				const normalized = validateSendOutcomes(outcomes);
				const assignedTickets = new Set(
					registry.deliveries.flatMap((delivery) =>
						delivery.ticketId === undefined ? [] : [delivery.ticketId],
					),
				);
				if (
					normalized.some(
						(outcome) => outcome.ticketId !== undefined && assignedTickets.has(outcome.ticketId),
					)
				) {
					throw new PushStoreError("invalid_delivery", "push receipt ticket is already assigned");
				}
				for (const outcome of normalized) {
					const delivery = registry.deliveries.find(
						(candidate) => candidate.notificationId === outcome.notificationId,
					);
					if (!delivery || delivery.status !== "sending") {
						throw new PushStoreError("invalid_delivery", "push notification outcome has no claimed delivery");
					}
					delivery.status = outcome.status;
					if (outcome.status === "accepted") {
						if (!outcome.ticketId) {
							throw new PushStoreError("invalid_delivery", "accepted push notification requires a ticket");
						}
						delivery.ticketId = outcome.ticketId;
						delivery.acceptedAt = now().toISOString();
					} else {
						delivery.finalizedAt = now().toISOString();
					}
					const subscription = registry.subscriptions.find(
						(candidate) => candidate.subscriptionId === delivery.subscriptionId,
					);
					if (subscription && outcome.status === "accepted") subscription.lastSentAt = now().toISOString();
					if (
						outcome.deviceNotRegistered &&
						subscription &&
						hashToken(subscription.expoToken) === delivery.tokenHash
					) {
						subscription.enabled = false;
					}
				}
			}),
		listReceiptRequests: async (limit) =>
			withRegistry((registry) => {
				if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
					throw new PushStoreError("invalid_delivery", "push receipt request limit is invalid");
				}
				const current = now().getTime();
				return registry.deliveries
					.filter(
						(delivery): delivery is StoredPushDelivery & { ticketId: string; acceptedAt: string } =>
							delivery.status === "accepted" &&
							delivery.ticketId !== undefined &&
							delivery.acceptedAt !== undefined &&
							current - new Date(delivery.acceptedAt).getTime() >= 15 * 60 * 1000,
					)
					.slice(0, limit)
					.map((delivery) => ({ ...copyDelivery(delivery), ticketId: delivery.ticketId }));
			}),
		recordReceiptOutcomes: async (outcomes) =>
			withRegistry((registry) => {
				const normalized = validateReceiptOutcomes(outcomes);
				for (const outcome of normalized) {
					const delivery = registry.deliveries.find(
						(candidate) => candidate.status === "accepted" && candidate.ticketId === outcome.ticketId,
					);
					if (!delivery) continue;
					delivery.status =
						outcome.status === "ok"
							? "receipt_ok"
							: outcome.status === "error"
								? "receipt_error"
								: "receipt_unknown";
					delivery.finalizedAt = now().toISOString();
					if (outcome.deviceNotRegistered) {
						const subscription = registry.subscriptions.find(
							(candidate) => candidate.subscriptionId === delivery.subscriptionId,
						);
						if (subscription?.expoToken && hashToken(subscription.expoToken) === delivery.tokenHash) {
							subscription.enabled = false;
						}
					}
				}
			}),
		listDeliveries: async () => withRegistry((registry) => registry.deliveries.map(copyDelivery)),
	};
}

// APNs has an independent lifecycle from the legacy Expo sender. Sharing a file would let
// future delivery bookkeeping change the native-client contract, so its registry and lock stay separate.
export async function createApnsPushStore(options: ApnsPushStoreOptions): Promise<ApnsPushStore> {
	const now = options.now ?? (() => new Date());
	const maxSubscriptions = validateMaxSubscriptions(options.maxSubscriptions);
	const { withRegistry } = await createRegistryAccess({
		stateDir: options.stateDir,
		registryFile: APNS_REGISTRY_FILE,
		lockFile: APNS_LOCK_FILE,
		now,
		syncDirectory: options.syncDirectory ?? syncStateDirectory,
		testHooks: options.testHooks,
		parse: parseApnsRegistry,
		empty: () => ({ version: 1 as const, subscriptions: [] }),
		prune: pruneApnsInactive,
		serialize: serializeApnsRegistry,
	});

	return {
		create: async (input) =>
			withRegistry((registry, _pruned, currentTime) => {
				const normalized = validateApnsCreateInput(input);
				const existing = registry.subscriptions.find(
					(subscription) => subscription.subscriptionId === normalized.subscriptionId,
				);
				if (existing) {
					if (!constantTimeSecretMatch(existing.secretHash, normalized.secret)) {
						throw new PushStoreError("unauthorized", "APNs subscription authorization is invalid");
					}
					if (!sameApnsIdentity(existing, normalized)) {
						throw new PushStoreError(
							"conflict",
							"APNs subscription identity conflicts with an existing subscription",
						);
					}
					return { kind: "existing", subscription: toPublic(existing) };
				}
				if (registry.subscriptions.length >= maxSubscriptions) {
					throw new PushStoreError("capacity_exceeded", "APNs subscription capacity is exhausted");
				}
				deactivateDuplicateApnsTokens(registry.subscriptions, normalized);
				const timestamp = currentTime.toISOString();
				const { secret, ...identity } = normalized;
				const subscription: StoredApnsPushSubscription = {
					...identity,
					secretHash: hashSecret(secret),
					tokenVersion: 1,
					enabled: true,
					activatedLocalDate: localDate(currentTime, normalized.timezone),
					createdAt: timestamp,
					lastSeenAt: timestamp,
				};
				registry.subscriptions.push(subscription);
				return { kind: "created", subscription: toPublic(subscription) };
			}),
		update: async (input) =>
			withRegistry((registry, _pruned, currentTime) => {
				const normalized = validateApnsUpdateInput(input);
				const subscription = registry.subscriptions.find(
					(candidate) => candidate.subscriptionId === normalized.subscriptionId,
				);
				if (!subscription) throw new PushStoreError("not_found", "APNs subscription does not exist");
				if (!constantTimeSecretMatch(subscription.secretHash, normalized.secret)) {
					throw new PushStoreError("unauthorized", "APNs subscription authorization is invalid");
				}
				const wasEnabled = subscription.enabled;
				// Every accepted client refresh advances the snapshot version. A provider response that
				// races any refresh must never disable the refreshed subscription.
				subscription.tokenVersion += 1;
				subscription.deviceToken = normalized.deviceToken;
				subscription.appVariant = normalized.appVariant;
				subscription.apnsEnvironment = normalized.apnsEnvironment;
				subscription.timezone = normalized.timezone;
				subscription.enabled = normalized.enabled;
				subscription.lastSeenAt = currentTime.toISOString();
				if (!wasEnabled && normalized.enabled) {
					subscription.activatedLocalDate = localDate(currentTime, normalized.timezone);
				}
				if (normalized.enabled) deactivateDuplicateApnsTokens(registry.subscriptions, normalized);
				return toPublic(subscription);
			}),
		remove: async (input) =>
			withRegistry((registry) => {
				const subscriptionId = validateSubscriptionId(input.subscriptionId);
				const index = registry.subscriptions.findIndex(
					(subscription) => subscription.subscriptionId === subscriptionId,
				);
				if (index === -1) return;
				const secret = validateExistingApnsSecret(input.secret);
				const subscription = registry.subscriptions[index];
				if (!subscription || !constantTimeSecretMatch(subscription.secretHash, secret)) {
					throw new PushStoreError("unauthorized", "APNs subscription authorization is invalid");
				}
				registry.subscriptions.splice(index, 1);
			}),
		pruneInactive: async () => withRegistry((_registry, pruned) => pruned),
		list: async () => withRegistry((registry) => registry.subscriptions.map(copyApnsSubscription)),
		reserveNotification: async (reservation) =>
			withRegistry((registry, _pruned, currentTime) => {
				const normalized = validateApnsReservation(reservation);
				const subscription = registry.subscriptions.find(
					(candidate) => candidate.subscriptionId === normalized.subscriptionId,
				);
				if (!subscription || !isCurrentlyApnsScheduledEligible(subscription, normalized, currentTime)) {
					throw new PushStoreError("not_found", "APNs subscription is not eligible for a scheduled delivery");
				}
				if (
					subscription.reservations?.some((entry) => entry.targetLocalDate === normalized.targetLocalDate)
				) {
					throw new PushStoreError(
						"invalid_delivery",
						"APNs subscription already has a delivery for this date",
					);
				}
				const stored: ApnsNotificationReservation = {
					...normalized,
					deviceToken: subscription.deviceToken,
					tokenVersion: subscription.tokenVersion,
					appVariant: subscription.appVariant,
					apnsEnvironment: subscription.apnsEnvironment,
				};
				subscription.reservations = appendApnsReservation(subscription.reservations, stored);
				return structuredClone(stored);
			}),
		disableReservedToken: async (reservation) =>
			withRegistry((registry) => {
				const normalized = validateStoredApnsReservation(reservation);
				const subscription = registry.subscriptions.find(
					(candidate) => candidate.subscriptionId === normalized.subscriptionId,
				);
				if (
					subscription?.enabled &&
					subscription.reservations?.some((entry) => sameApnsReservation(entry, normalized)) &&
					subscription.deviceToken === normalized.deviceToken &&
					subscription.tokenVersion === normalized.tokenVersion
				) {
					subscription.enabled = false;
				}
			}),
	};
}

async function readRegistry<T>(
	stateDir: string,
	path: string,
	requireExisting: boolean,
	parse: (raw: string) => T,
	empty: () => T,
): Promise<{ registry: T; expected: ExpectedRegistryState }> {
	try {
		const expected = await readExpectedRegistryState(stateDir, path, requireExisting);
		if (expected.kind === "absent") return { registry: empty(), expected };
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
			return { registry: parse(raw), expected };
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
	lockFile: string,
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
	const path = join(stateDir, lockFile);
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

async function writeRegistry<T>(
	stateDir: string,
	path: string,
	registry: T,
	expected: ExpectedRegistryState,
	syncDirectory: (path: string, directory: FileHandle) => Promise<void>,
	beforeCommit: ((context: { temporaryPath: string }) => Promise<void> | void) | undefined,
	assertLock: () => Promise<void>,
	serialize: (registry: T) => unknown,
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
		const serialized = `${JSON.stringify(serialize(registry))}\n`;
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
	const deliveries =
		value.deliveries === undefined
			? []
			: Array.isArray(value.deliveries)
				? value.deliveries.map(validateStoredDelivery)
				: (() => {
						throw new PushStoreError("corrupt_registry", "push delivery registry is invalid");
					})();
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
	if (new Set(deliveries.map((delivery) => delivery.notificationId)).size !== deliveries.length) {
		throw new PushStoreError("corrupt_registry", "push delivery registry has duplicate notification ids");
	}
	const deliveryDates = deliveries.map(
		(delivery) => `${delivery.subscriptionId}:${delivery.targetLocalDate}`,
	);
	if (new Set(deliveryDates).size !== deliveryDates.length) {
		throw new PushStoreError("corrupt_registry", "push delivery registry has duplicate subscription dates");
	}
	const tickets = deliveries.flatMap((delivery) =>
		delivery.ticketId === undefined ? [] : [delivery.ticketId],
	);
	if (new Set(tickets).size !== tickets.length) {
		throw new PushStoreError("corrupt_registry", "push delivery registry has duplicate receipt tickets");
	}
	return { version: REGISTRY_VERSION, subscriptions, deliveries };
}

function parseApnsRegistry(raw: string): ApnsRegistry {
	try {
		const value: unknown = JSON.parse(raw);
		if (!isRecord(value) || value.version !== REGISTRY_VERSION || !Array.isArray(value.subscriptions)) {
			throw new Error("registry shape is invalid");
		}
		if (!Object.keys(value).every((key) => key === "version" || key === "subscriptions")) {
			throw new Error("registry contains undeclared data");
		}
		const subscriptions = value.subscriptions.map(validateStoredApnsSubscription);
		if (
			new Set(subscriptions.map((subscription) => subscription.subscriptionId)).size !== subscriptions.length
		) {
			throw new Error("registry has duplicate subscription ids");
		}
		const enabledTokens = subscriptions
			.filter((subscription) => subscription.enabled)
			.map(
				(subscription) =>
					`${subscription.appVariant}:${subscription.apnsEnvironment}:${subscription.deviceToken}`,
			);
		if (new Set(enabledTokens).size !== enabledTokens.length) {
			throw new Error("registry has duplicate active tokens");
		}
		return { version: REGISTRY_VERSION, subscriptions };
	} catch {
		throw new PushStoreError("corrupt_registry", "APNs subscription registry is invalid");
	}
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
			...(value.reserved_local_dates === undefined
				? {}
				: { reservedLocalDates: validateReservedLocalDates(value.reserved_local_dates) }),
			...(value.last_sent_at === undefined ? {} : { lastSentAt: validateTimestamp(value.last_sent_at) }),
		};
	} catch {
		throw new PushStoreError("corrupt_registry", "push subscription entry is invalid");
	}
}

function validateStoredApnsSubscription(value: unknown): StoredApnsPushSubscription {
	try {
		if (!isRecord(value)) throw new Error("entry is not an object");
		const allowed = new Set([
			"subscription_id",
			"secret_hash",
			"device_token",
			"app_variant",
			"apns_environment",
			"timezone",
			"enabled",
			"activated_local_date",
			"created_at",
			"last_seen_at",
			"token_version",
			"reservations",
		]);
		if (!Object.keys(value).every((key) => allowed.has(key)))
			throw new Error("entry contains undeclared data");
		const { secret: _, ...base } = validateApnsCreateInput({
			subscriptionId: value.subscription_id,
			secret: "A".repeat(43),
			deviceToken: value.device_token,
			appVariant: value.app_variant,
			apnsEnvironment: value.apns_environment,
			timezone: value.timezone,
		});
		if (typeof value.secret_hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.secret_hash)) {
			throw new Error("secret hash is invalid");
		}
		if (typeof value.enabled !== "boolean") throw new Error("enabled state is invalid");
		const tokenVersion = value.token_version === undefined ? 1 : value.token_version;
		if (typeof tokenVersion !== "number" || !Number.isSafeInteger(tokenVersion) || tokenVersion < 1) {
			throw new Error("token version is invalid");
		}
		return {
			...base,
			secretHash: value.secret_hash,
			enabled: value.enabled,
			activatedLocalDate: validateLocalDate(value.activated_local_date),
			createdAt: validateTimestamp(value.created_at),
			lastSeenAt: validateTimestamp(value.last_seen_at),
			tokenVersion,
			...(value.reservations === undefined
				? {}
				: { reservations: validateApnsReservations(value.reservations, base.subscriptionId) }),
		};
	} catch {
		throw new PushStoreError("corrupt_registry", "APNs subscription entry is invalid");
	}
}

function validateStoredDelivery(value: unknown): StoredPushDelivery {
	try {
		if (!isRecord(value)) throw new Error("entry is not an object");
		const reservation = validateReservation({
			subscriptionId: value.subscription_id,
			notificationId: value.notification_id,
			targetLocalDate: value.target_local_date,
			reservedAt: value.reserved_at,
		});
		if (typeof value.token_hash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.token_hash)) {
			throw new Error("token hash is invalid");
		}
		if (!isDeliveryStatus(value.status)) throw new Error("delivery status is invalid");
		const status = value.status;
		const ticketId = value.ticket_id === undefined ? undefined : validateTicketId(value.ticket_id);
		const acceptedAt = value.accepted_at === undefined ? undefined : validateTimestamp(value.accepted_at);
		const finalizedAt = value.finalized_at === undefined ? undefined : validateTimestamp(value.finalized_at);
		const hasReceiptTicket = ticketId !== undefined && acceptedAt !== undefined;
		if (status === "accepted" && (!hasReceiptTicket || finalizedAt !== undefined))
			throw new Error("accepted delivery lacks receipt ticket");
		if (
			(status === "receipt_ok" || status === "receipt_error" || status === "receipt_unknown") &&
			(!hasReceiptTicket || finalizedAt === undefined)
		) {
			throw new Error("final receipt delivery is invalid");
		}
		if (
			(status === "reserved" || status === "sending") &&
			(ticketId !== undefined || acceptedAt !== undefined || finalizedAt !== undefined)
		) {
			throw new Error("pending delivery metadata is invalid");
		}
		if (
			(status === "rejected" || status === "unknown") &&
			(ticketId !== undefined || acceptedAt !== undefined || finalizedAt === undefined)
		) {
			throw new Error("final delivery metadata is invalid");
		}
		return {
			...reservation,
			tokenHash: value.token_hash,
			status,
			...(ticketId === undefined ? {} : { ticketId }),
			...(acceptedAt === undefined ? {} : { acceptedAt }),
			...(finalizedAt === undefined ? {} : { finalizedAt }),
		};
	} catch {
		throw new PushStoreError("corrupt_registry", "push delivery entry is invalid");
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

function validateApnsCreateInput(input: CreateApnsPushSubscriptionInput): ValidatedApnsPushSubscriptionInput {
	const appVariant = validateApnsAppVariant(input.appVariant);
	const apnsEnvironment = validateApnsEnvironment(input.apnsEnvironment);
	if (
		(appVariant === "production" && apnsEnvironment !== "production") ||
		(appVariant === "preview" && apnsEnvironment !== "sandbox" && apnsEnvironment !== "production")
	) {
		throw new PushStoreError("invalid_subscription", "APNs variant and environment are incompatible");
	}
	return {
		subscriptionId: validateSubscriptionId(input.subscriptionId),
		secret: validateSecret(input.secret),
		deviceToken: validateApnsDeviceToken(input.deviceToken),
		appVariant,
		apnsEnvironment,
		timezone: validateTimezone(input.timezone),
	};
}

function validateApnsUpdateInput(
	input: UpdateApnsPushSubscriptionInput,
): ValidatedApnsPushSubscriptionInput & { enabled: boolean } {
	if (typeof input.enabled !== "boolean") {
		throw new PushStoreError("invalid_subscription", "APNs subscription enabled must be boolean");
	}
	return { ...validateApnsCreateInput(input), enabled: input.enabled };
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

function validateExistingApnsSecret(value: unknown): string {
	try {
		return validateSecret(value);
	} catch {
		throw new PushStoreError("unauthorized", "APNs subscription authorization is invalid");
	}
}

function validateExpoToken(value: unknown): string {
	if (typeof value !== "string" || !EXPO_TOKEN_PATTERN.test(value)) {
		throw new PushStoreError("invalid_subscription", "push token is invalid");
	}
	return value;
}

function validateApnsDeviceToken(value: unknown): string {
	if (typeof value !== "string" || !/^[0-9a-fA-F]{2,512}$/.test(value) || value.length % 2 !== 0) {
		throw new PushStoreError("invalid_subscription", "APNs device token is invalid");
	}
	return value.toLowerCase();
}

function validateApnsAppVariant(value: unknown): ApnsAppVariant {
	if (value === "preview" || value === "production") return value;
	throw new PushStoreError("invalid_subscription", "APNs app variant is invalid");
}

function validateApnsEnvironment(value: unknown): ApnsEnvironment {
	if (value === "sandbox" || value === "production") return value;
	throw new PushStoreError("invalid_subscription", "APNs environment is invalid");
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

function validateReservedLocalDates(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > MAX_RESERVED_LOCAL_DATES) {
		throw new PushStoreError("corrupt_registry", "push reserved date history is invalid");
	}
	const dates = value.map(validateLocalDate);
	if (new Set(dates).size !== dates.length) {
		throw new PushStoreError("corrupt_registry", "push reserved date history has duplicates");
	}
	return dates;
}

function validateReservation(value: {
	subscriptionId: unknown;
	notificationId: unknown;
	targetLocalDate: unknown;
	reservedAt: unknown;
}): PushNotificationReservation {
	return {
		subscriptionId: validateSubscriptionId(value.subscriptionId),
		notificationId: validateNotificationId(value.notificationId),
		targetLocalDate: validateLocalDate(value.targetLocalDate),
		reservedAt: validateTimestamp(value.reservedAt),
	};
}

function validateApnsReservation(value: {
	subscriptionId: unknown;
	notificationId: unknown;
	targetLocalDate: unknown;
	reservedAt: unknown;
}): Omit<ApnsNotificationReservation, "deviceToken" | "tokenVersion" | "appVariant" | "apnsEnvironment"> {
	return validateReservation(value);
}

function validateStoredApnsReservation(value: unknown): ApnsNotificationReservation {
	if (!isRecord(value)) throw new PushStoreError("invalid_delivery", "APNs reservation is invalid");
	const reservation = validateReservation({
		subscriptionId: value.subscriptionId,
		notificationId: value.notificationId,
		targetLocalDate: value.targetLocalDate,
		reservedAt: value.reservedAt,
	});
	const tokenVersion = value.tokenVersion;
	if (typeof tokenVersion !== "number" || !Number.isSafeInteger(tokenVersion) || tokenVersion < 1) {
		throw new PushStoreError("invalid_delivery", "APNs reservation token version is invalid");
	}
	return {
		...reservation,
		deviceToken: validateApnsDeviceToken(value.deviceToken),
		tokenVersion,
		appVariant: validateApnsAppVariant(value.appVariant),
		apnsEnvironment: validateApnsEnvironment(value.apnsEnvironment),
	};
}

function validateApnsReservations(value: unknown, subscriptionId: string): ApnsNotificationReservation[] {
	if (!Array.isArray(value) || value.length > MAX_RESERVED_LOCAL_DATES) {
		throw new PushStoreError("corrupt_registry", "APNs reservation history is invalid");
	}
	const reservations = value.map((entry) => {
		if (!isRecord(entry)) throw new PushStoreError("corrupt_registry", "APNs reservation is invalid");
		return validateStoredApnsReservation({
			subscriptionId: entry.subscription_id,
			notificationId: entry.notification_id,
			targetLocalDate: entry.target_local_date,
			reservedAt: entry.reserved_at,
			deviceToken: entry.device_token,
			tokenVersion: entry.token_version,
			appVariant: entry.app_variant,
			apnsEnvironment: entry.apns_environment,
		});
	});
	if (
		reservations.some((reservation) => reservation.subscriptionId !== subscriptionId) ||
		new Set(reservations.map((reservation) => reservation.targetLocalDate)).size !== reservations.length
	) {
		throw new PushStoreError("corrupt_registry", "APNs reservation history is invalid");
	}
	return reservations;
}

function validateReservationBatch(value: PushNotificationReservation[]): PushNotificationReservation[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
		throw new PushStoreError("invalid_delivery", "push notification batch is invalid");
	}
	const reservations = value.map(validateReservation);
	if (new Set(reservations.map((reservation) => reservation.notificationId)).size !== reservations.length) {
		throw new PushStoreError("invalid_delivery", "push notification batch has duplicate ids");
	}
	return reservations;
}

function validateNotificationId(value: unknown): string {
	if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
		throw new PushStoreError("invalid_delivery", "push notification id is invalid");
	}
	return value.toLowerCase();
}

function validateTicketId(value: unknown): string {
	if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
		throw new PushStoreError("invalid_delivery", "push receipt ticket is invalid");
	}
	return value.toLowerCase();
}

function validateSendOutcomes(value: PushSendOutcome[]): PushSendOutcome[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
		throw new PushStoreError("invalid_delivery", "push send outcome batch is invalid");
	}
	const outcomes = value.map((outcome) => {
		const notificationId = validateNotificationId(outcome.notificationId);
		if (outcome.status !== "accepted" && outcome.status !== "rejected" && outcome.status !== "unknown") {
			throw new PushStoreError("invalid_delivery", "push send outcome is invalid");
		}
		const ticketId = outcome.ticketId === undefined ? undefined : validateTicketId(outcome.ticketId);
		if ((outcome.status === "accepted") !== (ticketId !== undefined)) {
			throw new PushStoreError("invalid_delivery", "push acceptance ticket is invalid");
		}
		if (outcome.deviceNotRegistered !== undefined && typeof outcome.deviceNotRegistered !== "boolean") {
			throw new PushStoreError("invalid_delivery", "push send outcome is invalid");
		}
		if (outcome.deviceNotRegistered && outcome.status !== "rejected") {
			throw new PushStoreError("invalid_delivery", "push device error must reject the delivery");
		}
		return {
			notificationId,
			status: outcome.status,
			...(ticketId === undefined ? {} : { ticketId }),
			...(outcome.deviceNotRegistered === undefined
				? {}
				: { deviceNotRegistered: outcome.deviceNotRegistered }),
		};
	});
	if (new Set(outcomes.map((outcome) => outcome.notificationId)).size !== outcomes.length) {
		throw new PushStoreError("invalid_delivery", "push send outcomes have duplicate ids");
	}
	const tickets = outcomes.flatMap((outcome) => (outcome.ticketId === undefined ? [] : [outcome.ticketId]));
	if (new Set(tickets).size !== tickets.length) {
		throw new PushStoreError("invalid_delivery", "push send outcomes have duplicate tickets");
	}
	return outcomes;
}

function validateReceiptOutcomes(value: PushReceiptOutcome[]): PushReceiptOutcome[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
		throw new PushStoreError("invalid_delivery", "push receipt outcome batch is invalid");
	}
	const outcomes = value.map((outcome) => {
		const ticketId = validateTicketId(outcome.ticketId);
		if (outcome.status !== "ok" && outcome.status !== "error" && outcome.status !== "unknown") {
			throw new PushStoreError("invalid_delivery", "push receipt outcome is invalid");
		}
		if (outcome.deviceNotRegistered !== undefined && typeof outcome.deviceNotRegistered !== "boolean") {
			throw new PushStoreError("invalid_delivery", "push receipt outcome is invalid");
		}
		return {
			ticketId,
			status: outcome.status,
			...(outcome.deviceNotRegistered === undefined
				? {}
				: { deviceNotRegistered: outcome.deviceNotRegistered }),
		};
	});
	if (new Set(outcomes.map((outcome) => outcome.ticketId)).size !== outcomes.length) {
		throw new PushStoreError("invalid_delivery", "push receipt outcomes have duplicate tickets");
	}
	return outcomes;
}

function isDeliveryStatus(value: unknown): value is PushDeliveryStatus {
	return (
		value === "reserved" ||
		value === "sending" ||
		value === "accepted" ||
		value === "rejected" ||
		value === "unknown" ||
		value === "receipt_ok" ||
		value === "receipt_error" ||
		value === "receipt_unknown"
	);
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

function deactivateDuplicateApnsTokens(
	subscriptions: StoredApnsPushSubscription[],
	input: Pick<
		ValidatedApnsPushSubscriptionInput,
		"subscriptionId" | "deviceToken" | "appVariant" | "apnsEnvironment"
	>,
): void {
	for (const subscription of subscriptions) {
		if (
			subscription.subscriptionId !== input.subscriptionId &&
			subscription.enabled &&
			subscription.deviceToken === input.deviceToken &&
			subscription.appVariant === input.appVariant &&
			subscription.apnsEnvironment === input.apnsEnvironment
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

function sameApnsIdentity(
	existing: StoredApnsPushSubscription,
	input: ValidatedApnsPushSubscriptionInput,
): boolean {
	return (
		existing.deviceToken === input.deviceToken &&
		existing.appVariant === input.appVariant &&
		existing.apnsEnvironment === input.apnsEnvironment &&
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

function validateMaxDeliveries(value: number | undefined): number {
	if (value === undefined) return DEFAULT_MAX_DELIVERIES;
	if (!Number.isInteger(value) || value < 1 || value > DEFAULT_MAX_DELIVERIES) {
		throw new Error(`maxDeliveries must be an integer between 1 and ${DEFAULT_MAX_DELIVERIES}`);
	}
	return value;
}

function hashSecret(secret: string): string {
	return `sha256:${createHash("sha256").update(secret).digest("hex")}`;
}

function hashToken(token: string): string {
	return `sha256:${createHash("sha256").update(token).digest("hex")}`;
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

function localHour(date: Date, timezone: string): number {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: timezone,
		hour: "2-digit",
		hourCycle: "h23",
	}).formatToParts(date);
	const hour = new Map(parts.map((part) => [part.type, part.value])).get("hour");
	if (!hour || !/^\d{2}$/.test(hour)) throw new Error("Intl did not provide a local hour");
	return Number.parseInt(hour, 10);
}

// The scheduler reads a snapshot before it can take the file lock. Recompute its decision while
// holding that lock so an update cannot turn 09:00 into 03:00 (or reactivate today) in between.
function isCurrentlyScheduledEligible(
	subscription: StoredPushSubscription,
	reservation: PushNotificationReservation,
	current: Date,
): boolean {
	if (!subscription.enabled) return false;
	if (current.getTime() - new Date(subscription.lastSeenAt).getTime() >= INACTIVE_TTL_MS) return false;
	const date = localDate(current, subscription.timezone);
	if (reservation.targetLocalDate !== date || date <= subscription.activatedLocalDate) return false;
	const hour = localHour(current, subscription.timezone);
	return hour >= 9 && hour < 10;
}

function isCurrentlyApnsScheduledEligible(
	subscription: StoredApnsPushSubscription,
	reservation: Omit<
		ApnsNotificationReservation,
		"deviceToken" | "tokenVersion" | "appVariant" | "apnsEnvironment"
	>,
	current: Date,
): boolean {
	if (!subscription.enabled) return false;
	if (current.getTime() - new Date(subscription.lastSeenAt).getTime() >= INACTIVE_TTL_MS) return false;
	const date = localDate(current, subscription.timezone);
	if (reservation.targetLocalDate !== date || date <= subscription.activatedLocalDate) return false;
	const hour = localHour(current, subscription.timezone);
	return hour >= 9 && hour < 10;
}

function pruneInactive(registry: Registry, current: Date): void {
	const cutoff = current.getTime() - INACTIVE_TTL_MS;
	registry.subscriptions = registry.subscriptions.filter(
		(subscription) => new Date(subscription.lastSeenAt).getTime() > cutoff,
	);
}

function pruneApnsInactive(registry: ApnsRegistry, current: Date): void {
	const cutoff = current.getTime() - INACTIVE_TTL_MS;
	registry.subscriptions = registry.subscriptions.filter(
		(subscription) => new Date(subscription.lastSeenAt).getTime() > cutoff,
	);
}

function pruneDeliveries(registry: Registry, current: Date): void {
	const currentTime = current.getTime();
	for (const delivery of registry.deliveries) {
		if (currentTime - new Date(delivery.reservedAt).getTime() < DELIVERY_TTL_MS) continue;
		if (delivery.status === "accepted") {
			delivery.status = "receipt_unknown";
			delivery.finalizedAt = current.toISOString();
		} else if (delivery.status === "reserved" || delivery.status === "sending") {
			delivery.status = "unknown";
			delivery.finalizedAt = current.toISOString();
		}
	}
	// Retention is measured from reservation, not from receipt finalization. A final
	// `receipt_unknown` remains observable at the exact 24-hour boundary, then the
	// next operation removes it rather than keeping a second 24-hour copy.
	registry.deliveries = registry.deliveries.filter(
		(delivery) => currentTime - new Date(delivery.reservedAt).getTime() <= DELIVERY_TTL_MS,
	);
}

function sameReservation(left: PushNotificationReservation, right: PushNotificationReservation): boolean {
	return (
		left.subscriptionId === right.subscriptionId &&
		left.notificationId === right.notificationId &&
		left.targetLocalDate === right.targetLocalDate &&
		left.reservedAt === right.reservedAt
	);
}

function sameApnsReservation(left: ApnsNotificationReservation, right: ApnsNotificationReservation): boolean {
	return (
		sameReservation(left, right) &&
		left.deviceToken === right.deviceToken &&
		left.tokenVersion === right.tokenVersion &&
		left.appVariant === right.appVariant &&
		left.apnsEnvironment === right.apnsEnvironment
	);
}

function subscriptionHasReservedDate(subscription: StoredPushSubscription, targetLocalDate: string): boolean {
	return (
		subscription.lastReservedLocalDate === targetLocalDate ||
		subscription.reservedLocalDates?.includes(targetLocalDate) === true
	);
}

function appendReservedLocalDate(dates: string[] | undefined, targetLocalDate: string): string[] {
	const history = dates ?? [];
	return [...history, targetLocalDate].slice(-MAX_RESERVED_LOCAL_DATES);
}

function appendApnsReservation(
	reservations: ApnsNotificationReservation[] | undefined,
	reservation: ApnsNotificationReservation,
): ApnsNotificationReservation[] {
	return [...(reservations ?? []), reservation].slice(-MAX_RESERVED_LOCAL_DATES);
}

function toPublic(
	subscription: Pick<
		PushSubscriptionPublic,
		"subscriptionId" | "enabled" | "timezone" | "activatedLocalDate"
	>,
): PushSubscriptionPublic {
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

function copyApnsSubscription(subscription: StoredApnsPushSubscription): ApnsPushSubscription {
	const { secretHash: _, tokenVersion: _tokenVersion, reservations: _reservations, ...copy } = subscription;
	return structuredClone(copy);
}

function copyDelivery(delivery: StoredPushDelivery): PushDelivery {
	const { tokenHash: _, ...copy } = delivery;
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
			...(subscription.reservedLocalDates === undefined
				? {}
				: { reserved_local_dates: subscription.reservedLocalDates }),
			...(subscription.lastSentAt === undefined ? {} : { last_sent_at: subscription.lastSentAt }),
		})),
		deliveries: registry.deliveries.map((delivery) => ({
			subscription_id: delivery.subscriptionId,
			notification_id: delivery.notificationId,
			target_local_date: delivery.targetLocalDate,
			reserved_at: delivery.reservedAt,
			token_hash: delivery.tokenHash,
			status: delivery.status,
			...(delivery.ticketId === undefined ? {} : { ticket_id: delivery.ticketId }),
			...(delivery.acceptedAt === undefined ? {} : { accepted_at: delivery.acceptedAt }),
			...(delivery.finalizedAt === undefined ? {} : { finalized_at: delivery.finalizedAt }),
		})),
	};
}

function serializeApnsRegistry(registry: ApnsRegistry) {
	return {
		version: REGISTRY_VERSION,
		subscriptions: registry.subscriptions.map((subscription) => ({
			subscription_id: subscription.subscriptionId,
			secret_hash: subscription.secretHash,
			device_token: subscription.deviceToken,
			app_variant: subscription.appVariant,
			apns_environment: subscription.apnsEnvironment,
			timezone: subscription.timezone,
			enabled: subscription.enabled,
			activated_local_date: subscription.activatedLocalDate,
			created_at: subscription.createdAt,
			last_seen_at: subscription.lastSeenAt,
			token_version: subscription.tokenVersion,
			...(subscription.reservations === undefined
				? {}
				: {
						reservations: subscription.reservations.map((reservation) => ({
							subscription_id: reservation.subscriptionId,
							notification_id: reservation.notificationId,
							target_local_date: reservation.targetLocalDate,
							reserved_at: reservation.reservedAt,
							device_token: reservation.deviceToken,
							token_version: reservation.tokenVersion,
							app_variant: reservation.appVariant,
							apns_environment: reservation.apnsEnvironment,
						})),
					}),
		})),
	};
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
