export const PROFILE_VERSION = 1 as const;
export const MINIMUM_GENRES = 3;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GENRE_ID = /^genre:[a-z0-9]+(?:-[a-z0-9]+)*(?:--[a-z0-9]+(?:-[a-z0-9]+)*)?$/;

export type Profile = {
	version: typeof PROFILE_VERSION;
	local_id: string;
	genre_ids: string[];
	revision: number;
	onboarding_completed: boolean;
	flow_id: string;
};

export type ProfileDraft = {
	version: typeof PROFILE_VERSION;
	flow_id: string;
	genre_ids: string[];
	started_recorded: boolean;
};

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function isGenreId(value: unknown): value is string {
	return typeof value === "string" && GENRE_ID.test(value);
}

export function isUuid(value: unknown): value is string {
	return typeof value === "string" && UUID.test(value);
}

export function normalizedGenreIds(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || !value.every(isGenreId)) return undefined;
	const genreIds = [...new Set(value)];
	return genreIds.length === value.length ? genreIds : undefined;
}

export function parseProfile(value: unknown): Profile | undefined {
	const candidate = object(value);
	if (
		candidate === undefined ||
		candidate.version !== PROFILE_VERSION ||
		!isUuid(candidate.local_id) ||
		!isUuid(candidate.flow_id) ||
		typeof candidate.revision !== "number" ||
		!Number.isSafeInteger(candidate.revision) ||
		candidate.revision < 1 ||
		candidate.onboarding_completed !== true
	)
		return undefined;
	const genreIds = normalizedGenreIds(candidate.genre_ids);
	return genreIds === undefined
		? undefined
		: {
				version: PROFILE_VERSION,
				local_id: candidate.local_id,
				genre_ids: genreIds,
				revision: candidate.revision,
				onboarding_completed: true,
				flow_id: candidate.flow_id,
			};
}

export function parseProfileDraft(value: unknown): ProfileDraft | undefined {
	const candidate = object(value);
	if (
		candidate === undefined ||
		candidate.version !== PROFILE_VERSION ||
		!isUuid(candidate.flow_id) ||
		typeof candidate.started_recorded !== "boolean"
	)
		return undefined;
	const genreIds = normalizedGenreIds(candidate.genre_ids);
	return genreIds === undefined
		? undefined
		: {
				version: PROFILE_VERSION,
				flow_id: candidate.flow_id,
				genre_ids: genreIds,
				started_recorded: candidate.started_recorded,
			};
}

export function selectionIsComplete(
	genreIds: readonly string[],
	availableGenreIds: readonly string[],
): boolean {
	const available = new Set(availableGenreIds);
	const selectedAvailable = genreIds.filter((genreId) => available.has(genreId));
	if (available.size === 0) return false;
	return available.size < MINIMUM_GENRES
		? selectedAvailable.length === available.size
		: genreIds.length >= MINIMUM_GENRES;
}

export function randomUuid(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	bytes[6] = ((bytes.at(6) ?? 0) & 0x0f) | 0x40;
	bytes[8] = ((bytes.at(8) ?? 0) & 0x3f) | 0x80;
	const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
