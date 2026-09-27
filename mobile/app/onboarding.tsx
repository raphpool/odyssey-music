import { router } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Button, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAnalytics } from "../src/analytics/provider";
import { createApiClient } from "../src/api/client";
import type { Catalog } from "../src/api/contracts";
import { type ProfileDraft, selectionIsComplete } from "../src/profile/model";
import { ProfileStore } from "../src/profile/store";
import { profileFromState, useProfile } from "../src/profile/useProfile";

type CatalogState = { kind: "loading" } | { kind: "loaded"; catalog: Catalog } | { kind: "error" };

function genreNodes(catalog: Catalog): Array<{ id: string; name: string }> {
	return catalog.nodes
		.filter((node) => node.type === "genre")
		.map((node) => ({ id: node.identity, name: node.name }))
		.sort((left, right) => left.name.localeCompare(right.name, "fr"));
}

export default function OnboardingScreen() {
	const analytics = useAnalytics();
	const profile = useProfile();
	const store = useMemo(() => new ProfileStore(), []);
	const client = useMemo(() => createApiClient(), []);
	const current = profileFromState(profile.state);
	const editing = current !== undefined;
	const [catalogState, setCatalogState] = useState<CatalogState>({ kind: "loading" });
	const [draft, setDraft] = useState<ProfileDraft>();
	const [saving, setSaving] = useState(false);
	const [message, setMessage] = useState<string>();
	const queuedStartFlow = useRef<string | undefined>(undefined);
	const completing = useRef(false);

	const loadCatalog = useCallback(async () => {
		setCatalogState({ kind: "loading" });
		const response = await client.getCatalog();
		setCatalogState(
			response.kind === "success" ? { kind: "loaded", catalog: response.value } : { kind: "error" },
		);
	}, [client]);

	useEffect(() => {
		void loadCatalog();
	}, [loadCatalog]);

	useEffect(() => {
		if (!profile.ready || (profile.state.kind !== "missing" && profile.state.kind !== "profile")) return;
		let active = true;
		void store.beginDraft(current?.genre_ids).then((next) => {
			if (!active) return;
			if (next === undefined)
				setMessage("Les choix ne peuvent pas être enregistrés sur cet appareil. Réessayez.");
			else setDraft(next);
		});
		return () => {
			active = false;
		};
	}, [current?.genre_ids, profile.ready, profile.state.kind, store]);

	const genres = catalogState.kind === "loaded" ? genreNodes(catalogState.catalog) : [];
	const availableGenreIds = genres.map((genre) => genre.id);

	useEffect(() => {
		if (
			editing ||
			draft === undefined ||
			draft.started_recorded ||
			queuedStartFlow.current === draft.flow_id ||
			catalogState.kind !== "loaded" ||
			genres.length === 0 ||
			analytics.consent.status !== "granted"
		)
			return;
		let active = true;
		void store.prepareOnboardingStarted(draft.flow_id).then((started) => {
			if (!active) return;
			if (started === undefined) {
				setMessage("Les choix ne peuvent pas être enregistrés sur cet appareil. Réessayez.");
				return;
			}
			queuedStartFlow.current = started.flow_id;
		});
		return () => {
			active = false;
		};
	}, [analytics, catalogState.kind, draft, editing, genres.length, store]);

	const retryProfile = async () => {
		setMessage(undefined);
		const reloaded = await profile.reload();
		if (reloaded.kind === "corrupt") {
			const cleared = await store.clear();
			if (cleared.kind !== "cleared") {
				setMessage("Le profil corrompu n’a pas pu être réinitialisé. Réessayez.");
				return;
			}
			await profile.reload();
		}
		if (reloaded.kind === "unavailable") {
			setMessage("Le stockage local est indisponible. Réessayez avant de choisir vos goûts.");
			return;
		}
		const next = await store.beginDraft(reloaded.kind === "profile" ? reloaded.profile.genre_ids : []);
		if (next === undefined)
			setMessage("Les choix ne peuvent pas être enregistrés sur cet appareil. Réessayez.");
		else setDraft(next);
	};

	const toggleGenre = async (genreId: string) => {
		if (draft === undefined || saving) return;
		setSaving(true);
		setMessage(undefined);
		const genreIds = draft.genre_ids.includes(genreId)
			? draft.genre_ids.filter((currentGenreId) => currentGenreId !== genreId)
			: [...draft.genre_ids, genreId];
		const next = { ...draft, genre_ids: genreIds };
		if (await store.saveDraft(next)) setDraft(next);
		else setMessage("La sélection n’a pas pu être enregistrée. Réessayez.");
		setSaving(false);
	};

	const complete = async () => {
		if (
			draft === undefined ||
			saving ||
			completing.current ||
			!selectionIsComplete(draft.genre_ids, availableGenreIds)
		)
			return;
		completing.current = true;
		setSaving(true);
		setMessage(undefined);
		const result = await store.commit({
			genreIds: draft.genre_ids,
			availableGenreIds,
			flowId: draft.flow_id,
			trackOnboardingCompletion: !editing && analytics.consent.status === "granted",
		});
		if (result.kind !== "saved") {
			setMessage(
				result.kind === "invalid"
					? "Sélectionnez suffisamment de genres pour continuer."
					: "Le profil n’a pas pu être enregistré. Réessayez.",
			);
			setSaving(false);
			completing.current = false;
			return;
		}
		await profile.reload();
		if (editing) {
			void analytics.trackEvent(
				"preferences_updated",
				{ genres_count: result.profile.genre_ids.length, action: "updated" },
				{ source: "settings" },
			);
			router.replace("/(tabs)/settings");
		} else {
			router.replace("/(tabs)");
		}
	};

	const canComplete =
		draft !== undefined &&
		catalogState.kind === "loaded" &&
		selectionIsComplete(draft.genre_ids, availableGenreIds);
	const selectedUnavailable =
		draft === undefined
			? 0
			: draft.genre_ids.filter((genreId) => !availableGenreIds.includes(genreId)).length;

	if (!profile.ready || catalogState.kind === "loading") {
		return (
			<SafeAreaView style={styles.safeArea}>
				<ActivityIndicator accessibilityLabel="Chargement des goûts" />
			</SafeAreaView>
		);
	}
	if (draft === undefined && profile.state.kind !== "corrupt") {
		return (
			<SafeAreaView style={styles.safeArea}>
				<ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
					<Text accessibilityRole="header" allowFontScaling style={styles.title}>
						Vos goûts musicaux
					</Text>
					<Text accessibilityRole="alert" allowFontScaling style={styles.error}>
						{message ?? "Le stockage local est indisponible. Réessayez avant de choisir vos goûts."}
					</Text>
					<Button title="Réessayer" onPress={() => void retryProfile()} />
					<Button title="Ouvrir la Recherche" onPress={() => router.replace("/(tabs)/search")} />
					<Button title="Ouvrir les Réglages" onPress={() => router.replace("/(tabs)/settings")} />
				</ScrollView>
			</SafeAreaView>
		);
	}

	return (
		<SafeAreaView style={styles.safeArea}>
			<ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
				<Text accessibilityRole="header" allowFontScaling style={styles.title}>
					{editing ? "Modifier mes goûts" : "Vos goûts musicaux"}
				</Text>
				<Text allowFontScaling style={styles.intro}>
					Choisissez des genres pour préparer votre découverte du jour. Ces choix restent sur ce téléphone.
				</Text>
				{profile.state.kind === "corrupt" ? (
					<View style={styles.message}>
						<Text accessibilityRole="alert" allowFontScaling style={styles.error}>
							Le profil musical local est illisible. Vous pouvez le réinitialiser ; la Recherche reste
							disponible.
						</Text>
						<Button title="Réinitialiser le profil" onPress={() => void retryProfile()} disabled={saving} />
						<Button
							title="Ouvrir les Réglages"
							onPress={() => router.replace("/(tabs)/settings")}
							disabled={saving}
						/>
					</View>
				) : catalogState.kind === "error" ? (
					<View style={styles.message}>
						<Text accessibilityRole="alert" allowFontScaling style={styles.error}>
							Les genres ne sont pas disponibles pour le moment.
						</Text>
						<Button title="Réessayer" onPress={() => void loadCatalog()} />
					</View>
				) : genres.length === 0 ? (
					<View style={styles.message}>
						<Text accessibilityRole="alert" allowFontScaling style={styles.error}>
							Aucun genre n’est disponible. Réessayez ou explorez la Recherche sans profil.
						</Text>
						<Button title="Réessayer" onPress={() => void loadCatalog()} />
					</View>
				) : (
					<>
						<Text allowFontScaling style={styles.count}>
							{draft?.genre_ids.length ?? 0} sélectionné{(draft?.genre_ids.length ?? 0) > 1 ? "s" : ""}
							{genres.length >= 3 ? " — 3 minimum" : " — sélectionnez-les tous"}
						</Text>
						{selectedUnavailable > 0 ? (
							<Text allowFontScaling style={styles.note}>
								{selectedUnavailable} goût{selectedUnavailable > 1 ? "s" : ""} temporairement indisponible
								{selectedUnavailable > 1 ? "s sont conservés." : " est conservé."}
							</Text>
						) : null}
						<View accessibilityRole="list" style={styles.grid}>
							{genres.map((genre) => {
								const selected = draft?.genre_ids.includes(genre.id) ?? false;
								return (
									<Pressable
										accessibilityHint="Double-tapez pour modifier la sélection"
										accessibilityRole="checkbox"
										accessibilityState={{ checked: selected, disabled: saving }}
										accessibilityLabel={genre.name}
										key={genre.id}
										disabled={saving}
										onPress={() => void toggleGenre(genre.id)}
										style={[styles.genre, selected ? styles.genreSelected : undefined]}
									>
										<Text allowFontScaling style={selected ? styles.genreTextSelected : styles.genreText}>
											{genre.name}
										</Text>
									</Pressable>
								);
							})}
						</View>
						<Button
							title={editing ? "Enregistrer mes goûts" : "Continuer"}
							onPress={() => void complete()}
							disabled={!canComplete || saving}
						/>
					</>
				)}
				{message === undefined ? null : (
					<Text accessibilityRole="alert" allowFontScaling style={styles.error}>
						{message}
					</Text>
				)}
				<Button
					title="Ouvrir la Recherche"
					onPress={() => router.replace("/(tabs)/search")}
					disabled={saving}
				/>
			</ScrollView>
		</SafeAreaView>
	);
}

const styles = StyleSheet.create({
	safeArea: { backgroundColor: "#ffffff", flex: 1 },
	content: { flexGrow: 1, gap: 16, padding: 24 },
	title: { fontSize: 30, fontWeight: "700", lineHeight: 38 },
	intro: { fontSize: 17, lineHeight: 25 },
	count: { fontSize: 16, fontWeight: "600", lineHeight: 24 },
	grid: { gap: 10 },
	genre: { borderColor: "#606060", borderRadius: 8, borderWidth: 1, padding: 14 },
	genreSelected: { backgroundColor: "#202020", borderColor: "#202020" },
	genreText: { color: "#202020", fontSize: 17 },
	genreTextSelected: { color: "#ffffff", fontSize: 17, fontWeight: "700" },
	note: { color: "#505050", fontSize: 14, lineHeight: 20 },
	message: { gap: 12 },
	error: { color: "#9c1c1c", fontSize: 16, lineHeight: 23 },
});
