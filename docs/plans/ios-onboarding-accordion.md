# Onboarding iOS : un seul écran « Genres et sous-genres » en accordéon

Plan de la phase `plan` du process de livraison, écrit le 2026-10-18 sur le brief de Raphael. Il
succède à [`ios-onboarding-taxonomy.md`](ios-onboarding-taxonomy.md) (TRA-511 → TRA-519, livré) et
remplace, pour l'onboarding, sa décision D3 et son arbitrage Q1 (« une famille sans sous-genre coché
vaut toute la famille ») : cette règle n'a plus d'écran pour l'exprimer. Les écrans J.2 et J.3 du plan
Figma (`track1-ios-figma.md`) sont remplacés par celui-ci. Tout le reste de ces plans reste en vigueur.

Source de vérité design : Figma `phudxrQNlzQJafXLma4FyX`, section `257:447`, écran
`1.2 Genres et sous-genres` `243:1585`, carte de spec `257:416`, liste `243:1671` (cartes `243:1609`
dépliée, `243:1675` repliée avec sélection, `243:1622` repliée sans). L'ancien flux est archivé sur la
page « Archive · Onboarding v1 (genres) ». Les valeurs ci-dessous ont été lues le 2026-10-18 via le MCP
Figma (`get_design_context` sur `243:1671`).

Tous les chemins sont relatifs à la racine du dépôt. Les nombres de tests sont ceux du dépôt au
2026-10-18 (`git log` : `9e39b2e`).

## Problème

Le flux actuel (`ios/Track1/Features/Onboarding/`) enchaîne 1.1 Welcome → 1.2 grille de tuiles de
familles (`GenresStepView.swift`) → un écran de sous-genres par famille cochée (`SubgenresStepView.swift`,
poussés par `OnboardingFlowView.Step.subgenres(String)`) → « Terminer » sur le dernier. Le brief le
remplace par un seul écran 1.2 : une carte accordéon par famille, les sous-genres en chips, « Continuer »
actif dès qu'un sous-genre est coché, compteur « Total : N genre(s) » en direct.

Ce changement d'écran impose un changement de modèle. `GenreOnboardingModel`
(`ios/Track1Core/Sources/Track1Core/Features/Onboarding/GenreOnboardingModel.swift`) raisonne à deux
niveaux : des familles cochées (`selectedFamilies`, `toggleFamily`) puis des genres cochés dans ces
familles, avec la règle « famille sans genre coché = toute la famille » (`countedGenreCount`,
`GenreSelection.derivedGenreIDs`, `OnboardingCopy.wholeFamilyHint`). Sur l'écran accordéon, une famille
n'est jamais cochée pour elle-même : elle est « sélectionnée » si et seulement si au moins un de ses
sous-genres l'est. Le modèle à deux niveaux n'a donc plus d'interface qui lui corresponde.

Ce qui ne bouge pas et contraint la solution :

- Le profil v2 (`Profile.swift`, `GenreSelection.swift`, `ProfileStore.swift`) stocke
  `selection: { families, genres }` et des `genre_ids` dérivés, lus par la recommandation
  (`Affinity.swift`) et par l'onglet Genres (`GenresTabView.swift:115`, tuiles des familles via
  `selectedFamilyChoices`). On ne migre pas le profil.
- Des profils existent déjà avec une « famille seule » (`selection.genres` vide pour cette famille) :
  ceux écrits par le flux actuel (iPhone de Raphael) et ceux reconstruits depuis un v1 par
  `restoreLegacy` (règle 3 : un slug de famille coche la famille seule).
- L'édition des goûts (onglet Genres → « Modifier mes genres », `ProfileEditorSheet`) réutilise
  `OnboardingFlowView` avec `isEditing` : elle suit nécessairement le nouvel écran.
- L'écran 1.5 Notifications n'existe pas dans l'app (hors V1, `track1-ios-figma.md:257` ; aucun
  `UNUserNotificationCenter` dans `ios/Track1`). « Continuer » termine donc le flux exactement comme
  « Terminer » aujourd'hui : écriture du profil, puis Aujourd'hui et son chargement (1.6).
- Le projet Xcode référence chaque fichier explicitement (`ios/Track1.xcodeproj/project.pbxproj`,
  identifiants `F1…`/`B1…` alloués par plage ; plage libre retenue ici : `0410–041F`). Ajouter ou
  supprimer un fichier de `ios/Track1` ou `ios/Track1Tests` passe par le pbxproj ; `ios/Track1Core`
  n'en a pas besoin (`docs/track1-builds.md`).
- L'appui long sur un chip pour jouer un morceau n'existe pas sur les lignes actuelles (vérifié :
  aucun `onLongPressGesture` dans `SubgenresStepView.swift`) : hors scope, conformément au brief.

## Non-buts

- Changer le schéma du profil (`Profile`, `ProfileDraft`, `GenreSelection`, `ProfileStore`) ou la
  dérivation `GenreSelection.derivedGenreIDs(in:)` : aucun fichier de
  `ios/Track1Core/Sources/Track1Core/Profile/` n'est modifié.
- Changer la recommandation (`Affinity.swift`, `TodayViewModel.swift`), les événements analytics ou
  leurs propriétés (`onboarding_started`, `onboarding_completed` avec `genres_count =
  profile.genreIDs.count`, `preferences_updated`), ni l'allowlist d'`AnalyticsEvent.swift`.
- Créer l'écran 1.5 Notifications. Toucher à 1.1 Welcome (`WelcomeView.swift`), à 1.6
  (`RecommendationLoadingView.swift`), à la grille de tuiles de l'onglet Genres (`GenreTile` reste),
  au libellé du résumé des réglages (`OnboardingCopy.selectionSummary`, `SettingsView.swift:105-112`).
- L'appui long sur un chip (lecture d'un morceau). Les descriptions de sous-genres (`definition` reste
  dans `EditorialGenreChoice`, plus affichée). Les images de genre.
- Ajouter un token pour l'ambre `#E6A23A` dessiné dans la maquette : l'accent de sélection est le
  token sémantique existant `Track1Tokens.colorSelectionContent` (voir D4).
- Le web, le serveur, `data/genre-taxonomy.json`, le client Expo gelé.
- Nettoyer les profils existants : un profil « famille seule » est normalisé à sa prochaine édition
  seulement (D2), jamais à la lecture.

## Décisions d'archi

### D1 — Un nouveau modèle à un seul niveau, `GenreSelectionModel`, remplace `GenreOnboardingModel`

Le modèle ne connaît que des sous-genres cochés (`selectedGenres: [String]`, ids de taxonomie, ordre de
coche). Les familles sont dérivées : « sélectionnée » = au moins un sous-genre coché, dans l'ordre de la
taxonomie. Il garde l'API dont l'app a besoin (`familyChoices`, `isEditing`, `selectedFamilyChoices`,
`droppedGenreIDs`, `makeDraft()`), ajoute ce que l'écran demande (`subgenres(of:)`, `toggleSubgenre(_:)`,
`toggleAll(of:)`, `isAllSelected(of:)`, `selectedCount(of:)`, `selectedSubgenreCount`, `canContinue`,
`ctaTitle`) et perd le reste (`toggleFamily`, `canContinueFromGenres`, `subgenreSteps`,
`subgenreStep(after:)`, `ctaTitle(forStep:)`, `countedGenreCount`, `subgenreChoices(of:)`).

Il est créé **à côté** de `GenreOnboardingModel`, l'app bascule dessus en une fois (3.1), l'ancien est
supprimé ensuite (3.3). Chaque PR laisse `main` vert.

Rejeté :
- Garder le modèle à deux niveaux et faire appeler `toggleFamily` par la vue quand le premier sous-genre
  d'une famille est coché (et l'inverse quand le dernier est décoché) : deux sources de vérité, un état
  « famille cochée sans sous-genre » toujours atteignable (restauration, bug de synchronisation) et
  invisible à l'écran.
- Réécrire `GenreOnboardingModel` sur place avec des membres de compatibilité (`toggleFamily` →
  `toggleAll`) le temps de la bascule : l'écran 1.3 actuel aurait « Tous » déjà coché à l'arrivée, et
  `ProfileFlowTests.testFirstLaunchChainsTheOnboardingToTodayAndIsNotShownAgain` (qui tape « Tous » puis
  vérifie qu'il est coché) casserait entre les deux merges.

### D2 — Le profil v2 ne change pas ; « famille seule » est normalisée en « tous ses sous-genres » à l'édition

`makeDraft()` écrit `GenreSelection(families: selectedFamilies, genres: selectedGenres)` et
`genreIDs = selection.derivedGenreIDs(in: taxonomy)`, inchangée. Comme chaque famille écrite a au moins
un genre explicite, la branche « famille seule → tous ses genres » de `derivedGenreIDs` n'est plus
empruntée par ce flux ; elle reste valable pour les profils déjà écrits et n'est pas touchée.

Restauration (`editing` ou `draft`, sélection v2 présente) : un genre stocké est gardé s'il est visible
dans la taxonomie ; une famille stockée **sans aucun genre stocké visible qui lui appartienne** sélectionne
tous ses genres visibles. Résultat : mêmes `genre_ids` qu'avant (famille seule = tous ses slugs), et
l'écran montre ce que la recommandation utilise. Un profil écrit par ce flux est un point fixe de la
restauration.

Restauration d'un profil v1 (`selection == nil`) : pour chaque slug de `genre_ids` dans l'ordre stocké,
`taxonomy.legacyGenreIDs(for:)` ; vide → `droppedGenreIDs` (une fois) ; sinon chaque id est coché une
fois. La règle 3 de l'ancien `restoreLegacy` (« les ids couvrent exactement une famille → famille seule »)
disparaît : cocher tous les ids d'une famille **est** la famille. La restriction assumée par l'ancien D6
(« famille + sous-genre » v1 → sous-genre seul) disparaît aussi : `genre:rock` + `genre:progressive-rock`
cochent tout Rock, Prog Rock compris, ce qui est l'union, comme le web.

Conséquence assumée : à la prochaine sauvegarde d'un profil « famille seule », `selection.genres` passe
de `[]` à tous les ids de la famille ; `genre_ids` ne change pas ; le résumé des réglages passe de
« 1 famille » à « 1 famille · 16 sous-genres » (`selectionSummary` inchangée, elle compte ce qui est
stocké). Population : l'iPhone de Raphael.

Rejeté :
- Un profil v3 « genres seulement » : migration de données personnelles (tier/3) pour supprimer un champ
  que l'onglet Genres lit encore (`families`).
- Garder « famille seule » comme état caché du nouveau modèle : l'écran montrerait zéro chip coché pour
  une famille qui pèse en entier dans la recommandation.

### D3 — L'écran est `GenresStepView`, réécrit sur place ; une seule étape dans `OnboardingFlowView`

Le fichier, le type et l'identifiant du CTA (`onboarding-genres-continue`) sont conservés : l'écran 1.2
reste l'écran 1.2, c'est son contenu qui change. `OnboardingFlowView.Step` ne garde que `.genres` ;
`destination(for:)`, `advance(from:)` et `SubgenresStepView.swift` disparaissent. Le CTA appelle
`onFinish(model.makeDraft())`. L'édition (`ProfileEditorSheet`) ouvre le même écran en racine avec
`ctaTitle == "Enregistrer"`, comme aujourd'hui. `SwipeBackEnabler` et l'action d'accessibilité `.escape`
restent : ils servent le retour 1.2 → Welcome.

Rejeté :
- Un nouveau fichier/type (`GenreAccordionStepView`) : entrées pbxproj supplémentaires, renommages dans
  `GenresStepLayoutTests` et `OnboardingFlowView` pour le même résultat.
- Garder les anciens écrans pour l'édition : deux flux à maintenir pour une seule sémantique.

### D4 — Deux composants nouveaux et sans état, `GenreAccordionCard` et `SubgenreChip` ; les couleurs existantes

- `SubgenreChip` : pilule (`Track1Tokens.radiusFull`), bordure 2 pt (`OnboardingChoiceColors.borderWidth`),
  padding 12 pt horizontal / 8 pt vertical, libellé `monoTag` (13/16), largeur hug, hauteur 36 pt,
  couleurs `OnboardingChoiceColors.resolve(isSelected:)` (déjà testées contre les variantes Figma
  `175:21`/`175:24` : pas de fond / bordure `colorBorderContrast` / texte primaire ; sélectionné :
  fond `colorBackgroundElevated`, bordure et texte `colorSelectionContent`). Un glyphe optionnel à
  droite (gap 8 pt) sert au chip « tout sélectionner ». Il remplace `SubgenreRow` **et** `SelectAllChip`
  (radius 0, 44 pt, `monoItem` 18 pt : une autre forme).
- `GenreAccordionCard` : fond `colorSurfaceDefault` dépliée / `colorBackgroundElevated` repliée (lu dans
  `243:1609` et `243:1675`), rayon `radius20`, padding 24 pt à gauche, 16 pt à droite, 11 pt vertical ;
  en-tête = bouton (toute la ligne) : nom en `monoItem`, puis `(N sélectionné·s)` en `monoTag` à 8 pt
  quand N ≥ 1, chevron `Track1Icon(.chevronDown, color:, size: 20)` à droite, tourné de 180° déplié ;
  repliée : seconde ligne « N sous-genres » en `monoLabel` `colorTextSecondary` à 8 pt sous le titre.
  Couleur du nom, du compte et du chevron : `colorSelectionContent` dès qu'un sous-genre est coché,
  `colorTextPrimary` sinon (`colorIconPrimary` pour le chevron sans sélection). La maquette dessine cet
  accent en `nocturne.amber #E6A23A`, qui n'est pas un token sémantique de `Track1Tokens` : on prend le
  token de sélection, le même que les chips. Le corps (slot `@ViewBuilder`) : padding vertical 12 pt, le
  chip « tout sélectionner » avec 8 pt sous lui, puis les chips dans `ChipFlowLayout(spacing: 8)`.
- L'état déplié/replié est un `@State` de l'écran (`Set<String>` de clés de famille), pas du modèle :
  il n'est pas persisté et sa règle tient en un `toggle`. Il est couvert par les tests UI.

Rejeté :
- Un paramètre de mise en page sur `SubgenreRow` : la description, la limite à deux lignes, le label
  d'accessibilité composé deviennent des chemins morts dans le même type.
- Porter l'état déplié dans le modèle Core : rien à tester en pur, et un `@Observable` qui change à
  chaque dépliage ferait recalculer les compteurs.

### D5 — Mouvement : un ressort de token, nul sous Reduce Motion ; même tick de défilement, mesuré par carte

- `Track1Motion.spring(reduceMotion:)` est ajouté à côté de `Track1Motion.animation(_:emphasized:reduceMotion:)`
  (`Track1Tokens.swift:202`) : `.spring(duration: 0.35, bounce: 0.2)`, `nil` sous Reduce Motion. Il anime
  le dépliage et la rotation du chevron. Rejeté : la courbe `timingCurve` existante — la spec dit
  « spring ».
- Le tick de défilement (haptique `.impact(weight: .light, intensity: 0.5)` et son système 1104) est
  conservé tel quel. Il compte les **cartes** dont le bord inférieur passe sous le haut de la barre, pas
  les chips : les chips d'une carte dépliée sont dans un flow layout, pas dans une liste. Le code de mesure
  (`ScrollTracker`, `RowEdgeKey`, `BarTopKey`, `ContentMinYKey` et leurs lecteurs, aujourd'hui `private`
  dans `SubgenresStepView.swift:121-208`) est déplacé sans changement dans un fichier à lui (2.2) avant la
  bascule, pour que la PR d'écran ne le réécrive pas. `ScrollTickDetector` (Core) ne change pas.

### D6 — Textes : `OnboardingCopy` gagne deux formes, perd l'aide « toute la famille compte »

- `counter(_:)` « Total : N genre(s) » inchangée (le compteur sous le bouton).
- `subgenreCount(_:)` → « 1 sous-genre » / « 13 sous-genres » (0 et 1 au singulier, comme les autres).
- `selectedCount(_:)` → « (1 sélectionné) » / « (4 sélectionnés) » ; jamais affiché pour 0.
- `wholeFamilyHint` supprimée (3.3) : la règle qu'elle expliquait n'existe plus.
- Le titre du CTA reste dans le modèle : `ctaTitle` vaut « Continuer » (premier lancement, comme dessiné)
  ou « Enregistrer » (édition). L'alerte d'échec d'enregistrement du premier lancement
  (`OnboardingFlowView.swift:176`, « Appuie de nouveau sur « Terminer ». ») suit.

### D7 — Identifiants d'accessibilité

`genre-card-<clé>` sur le bouton d'en-tête de carte, `select-all-<clé>` sur le chip « tout
sélectionner » (l'ancien `select-all` global ne distingue pas deux cartes ouvertes), `subgenre-chip-<id>`
sur un chip, `onboarding-genres-continue` et `bottom-counter` inchangés. `genre-tile-<clé>` ne subsiste
que sur l'onglet Genres. `onboarding-subgenres-continue` disparaît.

## Découpage

Neuf tâches en trois parties. Points = estimate Linear. « ∥ » marque les tâches qui peuvent tourner en
worktrees simultanés.

| # | Tâche | Tier | Pts | Dépend de |
|---|---|---|---|---|
| 1.1 | Core · `OnboardingCopy.subgenreCount` et `selectedCount` | tier/1 | 1 | — ∥ |
| 1.2 | Core · `GenreSelectionModel` : sélection, compteurs, CTA, brouillon, restauration v2 | tier/2 | 3 | — ∥ 1.1, 1.4, 2.x |
| 1.3 | Core · `GenreSelectionModel` : restauration d'un profil v1 | tier/2 | 2 | 1.2 |
| 1.4 | Doc · publier ce plan et poser les renvois | tier/1 | 1 | — ∥ |
| 2.1 | DS · `SubgenreChip`, `GenreAccordionCard`, `Track1Motion.spring` | tier/1 | 3 | — ∥ Partie 1 |
| 2.2 | App · déplacer le suivi de défilement dans `OnboardingScrollTick.swift` | tier/1 | 1 | — ∥ |
| 3.1 | App · basculer `GenresStepView` en accordéon, une étape, parcours UI adaptés | tier/2 | 5 | 1.1, 1.3, 2.1, 2.2 |
| 3.2 | Tests UI · scénarios propres à l'accordéon | tier/1 | 2 | 3.1 |
| 3.3 | Nettoyage · supprimer l'ancien modèle, les anciens composants et textes | tier/2 | 2 | 3.1 |

Total : 20 points. Chaque PR laisse `swift test` et `ios-check` verts : la Partie 1 n'ajoute que des
types Core inutilisés par l'app ; la Partie 2 n'ajoute que des composants non branchés ; 3.1 bascule ;
3.3 supprime.

### Partie 1 — Core : le modèle à un seul niveau (`swift test`, app inchangée)

Incrément livrable seul : de nouveaux types dans `Track1Core`, testés sur l'hôte, que l'app ne référence
pas encore. Boucle locale : `swift test --package-path ios/Track1Core`.

#### 1.1 — Core · `OnboardingCopy.subgenreCount(_:)` et `selectedCount(_:)`

- [ ] TRA-? Ajouter les deux formes de compte de l'en-tête de carte

Fichiers :
- `ios/Track1Core/Sources/Track1Core/Features/Onboarding/OnboardingCopy.swift` — deux fonctions ajoutées
  ; `counter`, `selectionSummary`, `wholeFamilyHint` inchangées (cette dernière part en 3.3).
- `ios/Track1Core/Tests/Track1CoreTests/Profile/OnboardingCopyTests.swift` — tests ajoutés.

Contrat :
```
public static func subgenreCount(_ count: Int) -> String   // "0 sous-genre", "1 sous-genre", "13 sous-genres"
public static func selectedCount(_ count: Int) -> String   // "(0 sélectionné)", "(1 sélectionné)", "(4 sélectionnés)"
```
Un compte négatif se lit 0, comme `counter`.

Critères d'acceptation :
- [ ] `subgenreCount(0)`, `(1)`, `(2)`, `(13)`, `(-1)` donnent exactement les chaînes ci-dessus (0 et 1
      au singulier, -1 comme 0).
- [ ] `selectedCount(1)` = « (1 sélectionné) », `selectedCount(4)` = « (4 sélectionnés) »,
      `selectedCount(0)` = « (0 sélectionné) », `selectedCount(-2)` idem.
- [ ] Les 9 tests existants d'`OnboardingCopyTests` passent sans modification.

Tests attendus : unitaires, un par forme et par cas limite (au moins 6).

#### 1.2 — Core · `GenreSelectionModel` : sélection, compteurs, CTA, brouillon, restauration v2

- [ ] TRA-? Modèle de sélection à un seul niveau pour l'écran accordéon

Nouveau type à côté de `GenreOnboardingModel`, qui ne change pas. Diff attendu ~450 lignes dont ~320 de
tests : au-dessus de 300, accepté parce que les cas sont portés un à un depuis
`GenreOnboardingModelTests` (31 tests, dont ~20 gardent un sens) et que couper le modèle en deux PR
laisserait un type sans `makeDraft`.

Fichiers :
- `ios/Track1Core/Sources/Track1Core/Features/Onboarding/GenreSelectionModel.swift` — nouveau.
- `ios/Track1Core/Tests/Track1CoreTests/Profile/GenreSelectionModelTests.swift` — nouveau, bâti sur
  `EditorialFixture.catalog(nodes:edges:families:genres:)`
  (`EditorialGenreTaxonomyTests.swift:224`) et la taxonomie des tests existants (familles jazz 1,
  hip-hop 2, rock 3 ; genres Q2133 Trap à deux slugs, Q1118, local:drill, Q9999 invisible, Q8341, Q1013,
  Q3071).
- Ne pas toucher : `GenreOnboardingModel.swift`, `GenreSelection.swift`, `Profile.swift`,
  `OnboardingCopy.swift`, les vues.

Contrat :
```
@MainActor @Observable public final class GenreSelectionModel {
  public init(taxonomy: EditorialGenreTaxonomy, editing: Profile? = nil, draft: ProfileDraft? = nil)
  public var familyChoices: [FamilyChoice]                        // == taxonomy.families : une carte par famille visible, ordre servi
  public func subgenres(of family: String) -> [EditorialGenreChoice]   // chips, ordre servi ; [] pour une clé inconnue
  public private(set) var selectedGenres: [String]                // ids cochés, ordre de coche, sans doublon
  public func isSubgenreSelected(_ id: String) -> Bool
  public func toggleSubgenre(_ id: String)                        // id inconnu de la taxonomie : ignoré
  public func toggleAll(of family: String)                        // isAllSelected ? décoche tout : coche tout ; clé inconnue : rien
  public func isAllSelected(of family: String) -> Bool            // faux pour une clé inconnue
  public func selectedCount(of family: String) -> Int
  public var selectedSubgenreCount: Int                           // toutes cartes
  public var canContinue: Bool                                    // selectedSubgenreCount >= 1
  public var ctaTitle: String                                     // isEditing ? "Enregistrer" : "Continuer"
  public var isEditing: Bool                                      // editing != nil
  public var selectedFamilies: [String]                           // dérivées : familles ayant >= 1 genre coché, ordre de taxonomy.families
  public var selectedFamilyChoices: [FamilyChoice]                // idem, en FamilyChoice (onglet Genres)
  public let droppedGenreIDs: [NodeIdentity]                      // [] dans cette tâche, rempli en 1.3
  public func makeDraft() -> ProfileDraft
}
```
Règles :
- `flowID = draft?.flowID ?? editing?.flowID ?? UUID()` ; `onboardingStartedRecorded =
  draft?.onboardingStartedRecorded ?? false` ; `makeDraft()` les rend inchangés (même raison qu'aujourd'hui :
  un brouillon neuf renverrait `onboarding_started` deux fois).
- `makeDraft()` : aucun genre coché → `ProfileDraft(version: Profile.version, flowID:, genreIDs: [],
  onboardingStartedRecorded:)` sans `selection` ; sinon `selection = GenreSelection(families:
  selectedFamilies, genres: selectedGenres)` et `genreIDs = selection.derivedGenreIDs(in: taxonomy)`.
- Restauration, `stored = draft?.selection ?? editing?.selection` non nil (D2) : (1) chaque id de
  `stored.genres`, dans l'ordre, est coché s'il est visible (`taxonomy.genre(id) != nil`), une fois ;
  (2) chaque clé de `stored.families`, dans l'ordre, visible (`taxonomy.family(key) != nil`) et dont
  aucun genre visible n'a été coché en (1), coche tous ses genres visibles dans l'ordre servi. Le reste
  est écarté en silence ; `droppedGenreIDs == []`.
- `stored == nil` et `editing != nil` : sélection vide dans cette tâche (1.3 ajoute le chemin v1).
  `stored == nil` et `editing == nil` : vide.

Critères d'acceptation :
- [ ] `familyChoices` est `[jazz, hip-hop, rock]` (ordre `order`, pas alphabétique) ;
      `subgenres(of: "hip-hop")` est `[Trap, Boom bap, Drill]` (Q9999 invisible absent) ;
      `subgenres(of: "x")` est vide.
- [ ] `canContinue` est faux à vide, vrai après `toggleSubgenre("Q2133")`, faux après un second appel ;
      `toggleSubgenre("Q9999")` et `toggleSubgenre("nope")` ne changent rien.
- [ ] `toggleAll(of: "hip-hop")` coche Trap, Boom bap, Drill (`selectedCount(of:) == 3`,
      `isAllSelected` vrai) ; un second appel décoche les trois ; cocher les trois un par un rend
      `isAllSelected` vrai ; `toggleAll(of: "x")` ne change rien et `isAllSelected(of: "x")` est faux.
- [ ] `selectedSubgenreCount` est la somme sur toutes les cartes ; `selectedFamilies` suit l'ordre de la
      taxonomie quel que soit l'ordre de coche (cocher Punk puis Bebop donne `[jazz, rock]`) ;
      décocher le dernier genre d'une famille la retire de `selectedFamilies`.
- [ ] `ctaTitle` vaut « Continuer » sans `editing`, « Enregistrer » avec ; `isEditing` idem.
- [ ] `makeDraft()` à vide : `genreIDs == []`, `selection == nil`, `flowID` et
      `onboardingStartedRecorded` du brouillon reçu conservés. Avec Trap et Bebop cochés :
      `selection == GenreSelection(families: ["jazz", "hip-hop"], genres: ["Q2133", "Q8341"])` et
      `genreIDs == [genre:bebop, genre:trap, genre:trap-music]` (triés par `rawValue`, les deux slugs de Trap).
- [ ] Restauration : un profil `selection: {families: [rock], genres: []}` (famille seule) donne
      `selectedGenres == ["Q3071"]` et `isAllSelected(of: "rock")` vrai, et `makeDraft().genreIDs` est
      identique à ce qu'`GenreOnboardingModel` produit pour le même profil (`[genre:punk-rock]`) ;
      `{families: [hip-hop], genres: [Q1118]}` donne `["Q1118"]` seul ; un id invisible (`Q9999`) et une
      famille inconnue sont écartés ; `droppedGenreIDs == []`.
- [ ] Point fixe : un profil construit depuis `makeDraft()` puis rechargé en `editing` redonne
      `selectedGenres` et `makeDraft()` identiques ; deux rechargements successifs aussi.
- [ ] Un brouillon avec sélection l'emporte sur `editing` ; un brouillon sans sélection retombe sur la
      sélection d'`editing`.
- [ ] `swift test` passe ; au moins 22 tests dans le nouveau fichier ; les 31 de
      `GenreOnboardingModelTests` passent sans modification.

Tests attendus : unitaires (les critères ci-dessus, cas nominal, limites, inconnus). Les cas d'étapes de
`GenreOnboardingModelTests` (`subgenreSteps`, `subgenreStep(after:)`, `ctaTitle(forStep:)`,
`toggleFamily`, `countedGenreCount`) ne sont pas portés : ils n'ont plus de sens.

#### 1.3 — Core · `GenreSelectionModel` : restauration d'un profil v1

- [ ] TRA-? Reconstruire la sélection d'un profil `selection == nil` depuis ses `genre_ids`

Fichiers :
- `ios/Track1Core/Sources/Track1Core/Features/Onboarding/GenreSelectionModel.swift` — chemin
  `selection == nil && editing != nil` de l'`init`, `droppedGenreIDs`.
- `ios/Track1Core/Tests/Track1CoreTests/Profile/GenreSelectionModelLegacyRestoreTests.swift` — nouveau,
  porté depuis `GenreOnboardingLegacyRestoreTests.swift` (20 tests ; même fixture, même table
  `legacySelectionBySlug`).

Contrat (D2), appliqué à `editing.genreIDs` dans l'ordre stocké :
1. `ids = taxonomy.legacyGenreIDs(for: slug)` (déjà filtrés aux genres visibles).
2. `ids` vide → `slug` ajouté à `droppedGenreIDs` s'il n'y est pas.
3. Sinon chaque id est coché s'il ne l'est pas déjà, dans l'ordre de `ids`.
Un brouillon (`draft`) sans sélection n'est jamais lu ainsi. Un profil v2 (`selection` non nil) ne passe
pas par ces règles et a `droppedGenreIDs == []`.

Critères d'acceptation :
- [ ] Un slug de famille (table → tous les ids visibles de la famille) coche tous ces ids :
      `isAllSelected` vrai, `selectedFamilies == [famille]`, `makeDraft().genreIDs` = tous les slugs de
      la famille (identique à ce que l'ancien modèle produisait pour « famille seule »).
- [ ] Un slug de sous-genre coche son id seul ; `genre:rock` + `genre:progressive-rock` cochent toute la
      famille Rock (union, D2), dans un ordre ou dans l'autre.
- [ ] Un slug mappé à deux ids de deux familles coche les deux ; deux slugs menant au même id le cochent
      une fois.
- [ ] Un slug absent de la table, ou dont tous les ids sont invisibles, part dans `droppedGenreIDs`
      (ordre stocké, une seule fois pour un slug répété) et ne change rien d'autre.
- [ ] Un profil v1 sans aucun genre donne une sélection vide et `canContinue` faux ; `isEditing` reste
      vrai et `ctaTitle` vaut « Enregistrer ».
- [ ] Un profil v2 et un brouillon sans sélection ne passent pas par ces règles ; la sélection
      reconstruite est un point fixe de la restauration v2 (sauvegarde puis rechargement identiques).
- [ ] `swift test` passe ; au moins 14 tests dans le nouveau fichier.

#### 1.4 — Doc · publier ce plan et poser les renvois

- [ ] TRA-? Publier `docs/plans/ios-onboarding-accordion.md` et renvoyer D3/Q1 et J.2/J.3 vers lui

Fichiers :
- `docs/plans/ios-onboarding-accordion.md` — ce plan, tel que validé.
- `docs/plans/ios-onboarding-taxonomy.md` — une ligne sous D3 (l.121) et sous Q1 (l.702) :
  « Remplacée le 2026-10-18 par `docs/plans/ios-onboarding-accordion.md` (sélection à un seul niveau). »
- `docs/plans/track1-ios-figma.md` — une ligne sous J.2 (l.1473) et J.3 (l.1504) :
  « Écrans remplacés le 2026-10-18 par `docs/plans/ios-onboarding-accordion.md`. »

Critères d'acceptation :
- [ ] Les quatre renvois sont présents, rien d'autre ne change dans les deux plans existants.
- [ ] `npm run check` passe (aucun fichier de code touché).

Tests attendus : aucun (doc). Parallélisable avec tout.

### Partie 2 — App : les composants, non branchés (`ios-check`)

Incrément livrable seul : des composants du design system et un fichier déplacé, compilés par
`ios-check`, que l'écran actuel n'utilise pas encore. Le lint `swift-format` ne signale pas un type non
référencé.

#### 2.1 — DS · `SubgenreChip`, `GenreAccordionCard`, `Track1Motion.spring`

- [ ] TRA-? Composants de l'écran accordéon

Fichiers :
- `ios/Track1/DesignSystem/Components/Onboarding/SubgenreChip.swift` — nouveau (pbxproj
  `F1…0410`/`B1…0410`, groupe `A30000000000000000000229 /* Onboarding */`, phase Sources
  `A20000000000000000000004` de la cible `Track1`).
- `ios/Track1/DesignSystem/Components/Onboarding/GenreAccordionCard.swift` — nouveau (`…0411`, mêmes
  groupe et phase).
- `ios/Track1/DesignSystem/Track1Tokens.swift` — `Track1Motion.spring(reduceMotion:)` à côté de
  `animation(_:emphasized:reduceMotion:)` (l.202).
- `ios/Track1Tests/DesignSystem/OnboardingComponentsTests.swift` — tests ajoutés (les tests existants de
  `SubgenreRow` et `SelectAllChip` restent jusqu'à 3.3).
- `ios/Track1Tests/DesignSystem/Track1TokensTests.swift` — un test pour `spring`.
- Ne pas toucher : `SubgenreRow.swift`, `SelectAllChip.swift`, `OnboardingChoiceColors` (réutilisé tel
  quel), `ChipFlowLayout.swift`.

Contrat :
```
struct SubgenreChip: View {
  static func identifier(for id: String) -> String            // "subgenre-chip-<id>" ; posé par l'écran, pas par le chip
  init(title: String, glyph: Track1Icon.Glyph? = nil, isSelected: Bool, action: @escaping () -> Void)
}
struct GenreAccordionCard<Content: View>: View {
  static func identifier(for family: String) -> String        // "genre-card-<clé>" ; posé par l'écran sur la carte, porté par le bouton d'en-tête
  static let chevronSize: CGFloat = 20
  static func accessibilityLabel(title: String, subgenreCount: Int, selectedCount: Int) -> String
      // "Hip-hop, 13 sous-genres" ; ", 1 sélectionné" ajouté quand selectedCount >= 1 (formes d'OnboardingCopy sans parenthèses)
  init(title: String, subgenreCount: Int, selectedCount: Int, isExpanded: Bool,
       onToggle: @escaping () -> Void, @ViewBuilder content: () -> Content)
}
enum GenreAccordionCardStyle {
  static let cornerRadius = Track1Tokens.radius20
  static func background(isExpanded: Bool) -> Color            // colorSurfaceDefault / colorBackgroundElevated
  static func accent(selectedCount: Int) -> Color              // colorSelectionContent si >= 1, colorTextPrimary sinon
}
extension Track1Motion {
  static func spring(reduceMotion: Bool) -> Animation?         // .spring(duration: 0.35, bounce: 0.2) ; nil sous Reduce Motion
}
```
Rendu (D4) : chip pilule 2 pt, 12/8 pt, `monoTag`, hauteur 36 pt, hug, `OnboardingChoiceColors`,
glyphe optionnel à 8 pt à droite en couleur du titre, `.sensoryFeedback(.selection, trigger: taps)`,
`.accessibilityAddTraits(isSelected ? .isSelected : [])`. Carte : fond et rayon du style, padding
24/16/11, en-tête bouton `.plain` sur toute la largeur avec `.sensoryFeedback(.selection, trigger: taps)`,
titre `monoItem` + `OnboardingCopy.selectedCount(n)` en `monoTag` (gap 8) si n ≥ 1, chevron
`Track1Icon(.chevronDown, color: accent, size: 20)` tourné de 180° quand `isExpanded` ; repliée : ligne
`OnboardingCopy.subgenreCount(n)` en `monoLabel` `colorTextSecondary` 8 pt sous le titre ; dépliée :
`content` avec padding vertical 12 pt. `accessibilityValue` « déplié » / « replié ». L'animation est
déclenchée par l'écran (`withAnimation(Track1Motion.spring(reduceMotion:))`) ; la carte n'anime rien
seule.

Critères d'acceptation :
- [ ] `SubgenreChip.identifier(for: "Q10413") == "subgenre-chip-Q10413"` ;
      `GenreAccordionCard.identifier(for: "hip-hop") == "genre-card-hip-hop"`.
- [ ] `GenreAccordionCardStyle.background(isExpanded: true)` est `colorSurfaceDefault` (`241713ff`),
      `false` → `colorBackgroundElevated` (`1a110eff`) ; `accent(selectedCount: 0)` est
      `colorTextPrimary`, `accent(1)` est `colorSelectionContent` (`bc7722ff`) ; `cornerRadius == 20` ;
      `chevronSize == 20`.
- [ ] `accessibilityLabel("Hip-hop", 13, 0) == "Hip-hop, 13 sous-genres"` ;
      `("Jazz", 13, 4) == "Jazz, 13 sous-genres, 4 sélectionnés"` ; `("Rock", 1, 1) == "Rock, 1 sous-genre, 1 sélectionné"`.
- [ ] `Track1Motion.spring(reduceMotion: true) == nil` ; `spring(reduceMotion: false) != nil`.
- [ ] `ios-check` vert (lint `swift-format`, build, `Track1Tests`).

Tests attendus : XCTest dans `OnboardingComponentsTests` (identifiants, style, label) et
`Track1TokensTests` (spring). Le rendu est exercé par les tests UI de 3.1 et 3.2.

Notes : aucune nouvelle couleur brute ; `Track1Text(_:role:verbatim:)` avec `verbatim: true` pour les
noms venant du catalogue ; `Track1Icon(_:color:size:)` existe (`Track1Icon.swift:52`). Les sections de
tests existantes de `SubgenreRow` et `SelectAllChip` ne bougent pas ici.

#### 2.2 — App · déplacer le suivi de défilement dans `OnboardingScrollTick.swift`

- [ ] TRA-? Sortir `ScrollTracker` et ses clés de préférence de `SubgenresStepView.swift`

Déplacement pur, aucun comportement ne change.

Fichiers :
- `ios/Track1/Features/Onboarding/OnboardingScrollTick.swift` — nouveau (pbxproj `…0412`, groupe
  `A30000000000000000000018 /* Onboarding */` des Features, phase Sources `A20000000000000000000004`).
  Reçoit, en visibilité `internal` (sans `private`), `ScrollTracker`, `RowEdgeKey`, `BarTopKey`,
  `ContentMinYKey`, `RowEdgeReader`, `ContentOffsetReader`, `BarTopReader`
  (`SubgenresStepView.swift:121-208`), et `enum OnboardingScrollTick { static let sound: SystemSoundID = 1104 }`
  à la place de `SubgenresStepView.tickSound`.
- `ios/Track1/Features/Onboarding/SubgenresStepView.swift` — les types déplacés et `tickSound`
  retirés ; `AudioServicesPlaySystemSound(OnboardingScrollTick.sound)`. Rien d'autre.

Critères d'acceptation :
- [ ] `grep -n "ScrollTracker\|RowEdgeKey\|tickSound" ios/Track1/Features/Onboarding/SubgenresStepView.swift`
      ne renvoie que les usages (`@State private var scroll = ScrollTracker()`, `RowEdgeKey.self`), aucune
      déclaration.
- [ ] `ios-check` vert ; `ProfileFlowTests` (8 parcours) inchangés et verts.

Tests attendus : aucun nouveau (la règle pure est `ScrollTickDetectorTests`, Core, 6 tests, inchangée).

### Partie 3 — App : la bascule, les parcours, le nettoyage

#### 3.1 — App · basculer `GenresStepView` en accordéon, une étape, parcours UI adaptés

- [ ] TRA-? L'écran 1.2 devient l'accordéon « Genres et sous-genres » et termine le flux

Compilée et testée par `ios-check` seulement. Mergée après 1.1, 1.3, 2.1, 2.2. Diff attendu
~+260 / −330 (la suppression de `SubgenresStepView.swift` compte pour 208).

Fichiers :
- `ios/Track1/Features/Onboarding/GenresStepView.swift` — réécrit : `GenreSelectionModel` ; en-tête
  inchangé (« Sélectionne tes genres » `title1`, sous-titre `bodyMedium`, `AmbientGlow(.ember)`,
  `GenresStepLayout.contentInset` 24 pt) ; puis la liste de cartes (`VStack`, 20 cartes au plus)
  avec 16 pt d'inset horizontal, 12 pt vertical, 4 pt entre cartes ; une `GenreAccordionCard` par
  `model.familyChoices`, contenu : `SubgenreChip("Tous", glyph: isAll ? .check : .chevronDown, …)`
  (libellé et glyphe selon Q1 du gate) avec `.accessibilityIdentifier("select-all-<clé>")`, puis
  `ChipFlowLayout(spacing: Track1Tokens.spacing8)` de `SubgenreChip` par `model.subgenres(of:)` avec
  `.accessibilityIdentifier(SubgenreChip.identifier(for:))` ; `@State private var expanded = Set<String>()`
  (toutes repliées à l'arrivée ; `String?` si Q2 retient « une seule ») ; dépliage dans
  `withAnimation(Track1Motion.spring(reduceMotion:))` avec `@Environment(\.accessibilityReduceMotion)` ;
  barre `BottomActionBar(title: model.ctaTitle, isEnabled: model.canContinue, counter:
  OnboardingCopy.counter(model.selectedSubgenreCount), identifier: continueIdentifier)` en
  `safeAreaInset(edge: .bottom)` ; tick de défilement repris de l'ancien écran avec `RowEdgeReader(id:
  clé de famille)` derrière chaque carte, `BarTopReader`, `ContentOffsetReader`, espaces de coordonnées
  renommés `genres-viewport` / `genres-content`. `GenresStepLayout` garde `columnCount`, `gutter`,
  `contentInset` (onglet Genres) et gagne `listInset = Track1Tokens.spacing16`, `cardSpacing =
  Track1Tokens.spacing4`, `listVerticalInset = Track1Tokens.spacing12` ; `tileSize` est supprimée.
- `ios/Track1/Features/Onboarding/OnboardingFlowView.swift` — `Step` ne garde que `.genres` ;
  `destination(for:)` et `advance(from:)` supprimés ; `genresStep` appelle `onFinish(model.makeDraft())`
  quand `isOnGenresStep` ; types `GenreSelectionModel` ; `FirstLaunchOnboardingView.load()` construit
  `GenreSelectionModel(taxonomy:draft:)` ; alerte l.176 : « Appuie de nouveau sur « Continuer ». » ;
  commentaires de tête mis à jour (plus d'« one genre step per family »).
- `ios/Track1/Features/Genres/GenresTabView.swift` — l.115 et l.274-279 : `GenreSelectionModel`.
- `ios/Track1/Features/Onboarding/SubgenresStepView.swift` — supprimé (pbxproj : `F1…0370`, `B1…0370`,
  enfant du groupe `A3…0018`, entrée de la phase `A2…0004`).
- `ios/Track1Tests/Profile/GenresStepLayoutTests.swift` — les 4 tests de `tileSize` supprimés ;
  `testGenresBarHasItsOwnIdentifierAndKeepsTheFade` et `testContinueIsDisabledUntilAFamilyIsChosen`
  réécrits sur `GenreSelectionModel` (`toggleSubgenre("Q11401")` à la place de `toggleFamily`) ; un test
  des trois nouvelles constantes de `GenresStepLayout`.
- `ios/Track1Tests/DesignSystem/OnboardingComponentsTests.swift` —
  `testSubgenresBarHasItsOwnIdentifierAndKeepsTheFade` (l.204) supprimé avec l'écran.
- `ios/Track1UITests/UITestFlows.swift` — la famille `family-0` gagne un second genre publié
  `local:genre-0b` (slug `genre:genre-0b`, ajouté à `subgenres` et donc aux nœuds ; les œuvres restent
  liées à `subgenres[0] == genre:genre-0a`) ; `completeOnboarding` : `onboarding-start` →
  `genre-card-family-0` → `subgenre-chip-local:genre-0a` → `onboarding-genres-continue`.
- `ios/Track1UITests/ProfileFlowTests.swift` — les 8 parcours adaptés, et seulement adaptés (les
  scénarios nouveaux sont en 3.2) :
  - `testFirstLaunchChainsTheOnboardingToTodayAndIsNotShownAgain` : 1.2 arrive avec le CTA désactivé et
    les cartes repliées (`subgenre-chip-local:genre-0a` absent) ; ouvrir `genre-card-family-0`, taper
    `select-all-family-0` (coche 0a et 0b), ouvrir `genre-card-family-1`, taper
    `subgenre-chip-local:genre-1a` ; `bottom-counter` vaut « Total : 3 genres » ; le CTA a pour label
    « Continuer » ; après relance, réglages « 2 familles · 3 sous-genres » ; captures « 1.2a », « 1.2b ».
  - `testTheBackGestureOfTheSecondStepKeepsTheSelection` → renommé
    `testTheBackGestureToWelcomeKeepsTheSelection` : cocher 0a, geste de bord → `onboarding-start`
    visible ; le taper à nouveau → compteur « Total : 1 genre » et en-tête « (1 sélectionné) » visibles.
  - `testFailedProfileWriteShowsAnErrorAndCanBeRetried` et `testCorruptProfileCanBeExplicitlyPurgedThenRecreated`
    (fixture `catalogFixture`, 3 familles × 1 genre) : `genre-card-family-0` →
    `subgenre-chip-local:genre-3` → `onboarding-genres-continue` (deux fois pour le retry) ; réglages
    « 1 famille · 1 sous-genre ».
  - `testEditingTheGenresAddsAFamilyThenTodayIsComputedAgain` : l'édition ouvre l'accordéon, carte
    `family-0` repliée avec « (1 sélectionné) » ; ouvrir `genre-card-family-1`, cocher
    `subgenre-chip-local:genre-1a`, taper « Enregistrer » ; l'onglet montre les deux tuiles.
  - `testTheGenresTabShowsTheFamiliesOfTheProfileAndOpensTheSettings`, les deux parcours `degraded` :
    inchangés sauf via `completeOnboarding`.
- Hors scope : `GenreOnboardingModel.swift` et ses tests, `SubgenreRow.swift`, `SelectAllChip.swift`,
  `OnboardingCopy.wholeFamilyHint` (3.3) ; `Affinity`, analytics, `SettingsView`.

Contrat :
```
struct GenresStepView: View {
  static let continueIdentifier = "onboarding-genres-continue"                   // inchangé
  @MainActor static func isContinueEnabled(_ model: GenreSelectionModel) -> Bool // model.canContinue
  @MainActor static func actionBar(model: GenreSelectionModel, onContinue: @escaping () -> Void) -> BottomActionBar
  init(model: GenreSelectionModel, onContinue: @escaping () -> Void)
}
enum GenresStepLayout { columnCount, gutter, contentInset /* existants */ ; listInset = 16 ; cardSpacing = 4 ; listVerticalInset = 12 }
```

Critères d'acceptation :
- [ ] `ios-check` vert : build, `Track1Tests`, les 8 parcours de `ProfileFlowTests` adaptés.
- [ ] Sur la fixture UI, l'écran 1.2 liste deux cartes repliées (« 2 sous-genres », « 1 sous-genre »),
      le CTA est désactivé, aucun chip n'est visible ; ouvrir une carte montre « Tous » puis ses chips ;
      cocher un chip active le CTA et met le compteur à jour ; « Continuer » écrit un `profile.v2.json`
      avec `selection.genres` non vide et mène à Aujourd'hui (1.6).
- [ ] L'édition depuis l'onglet Genres ouvre le même écran sans Welcome, avec les sous-genres du profil
      cochés et le CTA « Enregistrer ».
- [ ] Le geste de bord depuis 1.2 revient à Welcome et la sélection survit au retour.
- [ ] `grep -rn "SubgenresStepView\|onboarding-subgenres-continue\|GenreOnboardingModel" ios/Track1 ios/Track1Tests ios/Track1UITests`
      ne renvoie rien (le Core garde l'ancien modèle jusqu'à 3.3).
- [ ] Le tick de défilement joue encore : à vérifier en lançant `ios-check` (pas de test automatisé possible
      sur une haptique), et par relecture que `RowEdgeReader` est derrière chaque carte.

Tests attendus : `GenresStepLayoutTests` (XCTest) ; `ProfileFlowTests` (XCUITest) adaptés.

Notes : le modèle est un `@State` de l'hôte (`FirstLaunchOnboardingView.Phase.ready`,
`ProfileEditorSheet`), jamais construit dans un `body`. `expanded` est un `@State` de `GenresStepView` :
il repart replié après un retour à Welcome, c'est voulu (D4). Les lookups par libellé
(`app.buttons["Tous"]`) sont remplacés par les identifiants : deux cartes ouvertes auraient deux « Tous ».

#### 3.2 — Tests UI · scénarios propres à l'accordéon

- [ ] TRA-? Couvrir « Tous » dans les deux sens, les compteurs d'en-tête, la sélection conservée repliée, plusieurs cartes ouvertes

Fichiers :
- `ios/Track1UITests/ProfileFlowTests.swift` — deux parcours ajoutés (fixture `taxonomyCatalog` de 3.1,
  famille 0 à deux genres).

Critères d'acceptation (un parcours pour les deux premiers points, un pour les deux suivants) :
- [ ] `select-all-family-0` : un tap le met `isSelected`, les deux chips de la carte sont `isSelected`,
      l'en-tête montre « (2 sélectionnés) », le compteur « Total : 2 genres » ; un second tap décoche
      tout : plus de « (… sélectionné » dans la carte, compteur « Total : 0 genre », CTA désactivé ;
      cocher les deux chips un par un remet `select-all-family-0` en `isSelected`.
- [ ] Cocher `subgenre-chip-local:genre-0a` seul montre « (1 sélectionné) » (singulier).
- [ ] Ouvrir `family-0` puis `family-1` : les chips des deux cartes sont visibles en même temps
      (si Q2 retient « une seule », ouvrir la seconde replie la première : adapter l'assertion).
- [ ] Replier `family-0` après y avoir coché 0a : le chip disparaît, l'en-tête garde « (1 sélectionné) »
      et « 2 sous-genres », le compteur ne change pas ; rouvrir montre 0a encore coché.
- [ ] `ios-check` vert.

Tests attendus : XCUITest (2 parcours). Tier/1 : tests seulement.

#### 3.3 — Nettoyage · supprimer l'ancien modèle, les anciens composants et textes

- [ ] TRA-? Retirer `GenreOnboardingModel`, `SubgenreRow`, `SelectAllChip`, `wholeFamilyHint`

Mergée après 3.1. Diff presque uniquement en suppressions (~−900).

Fichiers :
- Supprimés (Core, pas de pbxproj) :
  `ios/Track1Core/Sources/Track1Core/Features/Onboarding/GenreOnboardingModel.swift`,
  `ios/Track1Core/Tests/Track1CoreTests/Profile/GenreOnboardingModelTests.swift`,
  `ios/Track1Core/Tests/Track1CoreTests/Profile/GenreOnboardingLegacyRestoreTests.swift`.
- Supprimés (app, pbxproj `…0261`, `…0262`, enfants du groupe `A3…0229`, phase `A2…0004`) :
  `ios/Track1/DesignSystem/Components/Onboarding/SubgenreRow.swift` (déplacer d'abord
  `OnboardingChoiceColors`, l.74-97, dans `SubgenreChip.swift`, qui l'utilise),
  `ios/Track1/DesignSystem/Components/Onboarding/SelectAllChip.swift`.
- `ios/Track1Core/Sources/Track1Core/Features/Onboarding/OnboardingCopy.swift` — `wholeFamilyHint`
  supprimée ; le commentaire de `selectionSummary` (« famille laissée entière ») mis à jour : la forme
  sans sous-genre ne concerne plus que les profils écrits avant ce plan.
- `ios/Track1Core/Tests/Track1CoreTests/Profile/OnboardingCopyTests.swift` —
  `testTheHelpLineTellsThatAnEmptyListIsTheWholeFamily` supprimé.
- `ios/Track1Tests/DesignSystem/OnboardingComponentsTests.swift` — section « Subgenre row and
  Select-all chip » : les tests de `OnboardingChoiceColors` (3) restent, ceux de `SubgenreRow` (4) et de
  `SelectAllChip` (1) partent ; commentaire de tête mis à jour.
- `ios/Track1Core/Sources/Track1Core/Profile/GenreSelection.swift` — **non modifié** (non-but) ; son
  commentaire « Q1 » reste exact pour les profils existants.
- Vérifier avant de supprimer : `grep -rn "GenreOnboardingModel\|SubgenreRow\|SelectAllChip\|wholeFamilyHint\|OnboardingFixture" ios/`
  ne doit renvoyer que les fichiers listés ici.

Critères d'acceptation :
- [ ] `grep -rn "GenreOnboardingModel\|SubgenreRow\b\|SelectAllChip\|wholeFamilyHint\|toggleFamily\|subgenreSteps\|countedGenreCount" ios/`
      ne renvoie rien.
- [ ] `swift test` passe ; le nombre de tests du package est ≥ celui d'avant 1.1 moins 51 (les 31 + 20
      supprimés) plus les ajouts de 1.1, 1.2, 1.3, soit au moins le total d'avant ce projet
      (les cas supprimés ont leurs équivalents dans les nouveaux fichiers).
- [ ] `ios-check` vert ; `docs/track1-builds.md` n'a pas à changer (le décompte « 19 fichiers » y est
      historique et daté).

Tests attendus : aucun nouveau ; suppressions couvertes par les tests restants.

## Risques

- **R1 — Un profil « famille seule » change de forme stockée à sa prochaine édition** (D2) :
  `selection.genres` se remplit, `genre_ids` ne change pas, le résumé des réglages gagne « · N
  sous-genres ». Garde-fou : normalisation à l'édition seulement, jamais à la lecture ; critère de 1.2
  qui compare `makeDraft().genreIDs` à l'ancien modèle sur le même profil. Population : l'iPhone de
  Raphael.
- **R2 — La restauration v1 n'applique plus la restriction « famille + sous-genre → sous-genre »**
  (ancien D6, Q4) : `genre:rock` + `genre:progressive-rock` donnent tout Rock. C'est l'union, comme le
  web ; le cas « famille seule » n'étant plus exprimable, la restriction n'a plus de contrepartie à
  l'écran. Daté ici (2026-10-18) pour la lecture des tableaux : `genres_count` peut remonter pour ce
  profil au prochain enregistrement.
- **R3 — Un écran, 20 cartes, jusqu'à 203 chips si tout est déplié** (house-techno : 39). Garde-fous :
  cartes repliées à l'arrivée et contenu construit seulement déplié (`if isExpanded`) ;
  `ChipFlowLayout` mesure une fois par mise à jour (`makeCache`) ; `VStack` suffit pour 20 cartes.
  À surveiller sur l'iPhone de Raphael après 3.1 : si le dépliage saccade, passer la liste en
  `LazyVStack` (le tick par carte continue de marcher, il ne mesure que les cartes présentes).
- **R4 — Les identifiants d'accessibilité changent** (D7). Garde-fou : `ProfileFlowTests` et
  `UITestFlows.completeOnboarding` mis à jour dans la même PR (3.1) ; aucun autre consommateur (vérifié :
  `GenreTile`, `SubgenreRow`, `SelectAllChip` et les tests UI).
- **R5 — Deux cartes ouvertes, deux chips « Tous »** : un lookup XCUITest par libellé devient ambigu.
  Garde-fou : identifiants par famille (`select-all-<clé>`), lookups par identifiant seulement.
- **R6 — État intermédiaire entre la Partie 2 et 3.1** : composants et types Core non référencés sur
  `main`. Accepté : `swift-format` ne le signale pas, `ios-check` compile ; la fenêtre est de quelques
  PR.
- **R7 — Reduce Motion et Dynamic Type** : `spring` renvoie `nil` sous Reduce Motion (le dépliage est
  instantané) ; les chips à `monoTag` suivent `.footnote` et un nom plus large que la ligne obtient sa
  propre ligne (`ChipFlow.rows`). Pas de test automatisé ; relecture en review.
- **R8 — Budget de diff de 3.1** (~+260/−330) : au-dessus de 300 à cause de la suppression de
  `SubgenresStepView.swift` et des 8 parcours adaptés. Si la PR dépasse ~400 lignes ajoutées, sortir
  l'adaptation de `ProfileFlowTests` dans une PR tier/1 qui suit **immédiatement** (CI UI rouge entre
  les deux, à éviter) ; préférer tenir le budget en ne touchant les parcours que là où un identifiant
  change.
- **R9 — Le libellé du chip « tout sélectionner » et le nombre de cartes ouvertes dépendent du gate**
  (Q1, Q2) : les deux sont des lignes isolées de 3.1 et 3.2 (`title:`/`glyph:` du chip ; type de
  `expanded`) et sont posés dans les tickets après la réponse.

## Critères de sortie

- Sur le cache committé servi en `editorial`, l'écran 1.2 montre 20 cartes repliées (une par famille
  ayant au moins un genre visible, dans l'ordre `order`), avec « N sous-genres » exact ; dépliées, elles
  totalisent 203 chips, un chip par genre publié, aucun sous deux cartes ; aucun écran 1.3/1.4 n'existe
  plus ; « Continuer » est désactivé tant qu'aucun chip n'est coché et le compteur suit chaque tap.
- Un profil enregistré par ce flux est un `profile.v2.json` avec `selection.families` (ordre de la
  taxonomie) et `selection.genres` (≥ 1 par famille) et des `genre_ids` dérivés par
  `GenreSelection.derivedGenreIDs` inchangée ; Aujourd'hui recommande à partir de ces `genre_ids` sans
  changement dans `Affinity`.
- Un profil « famille seule » (v2) ou v1 est rouvert en édition avec les bons chips cochés et donne, tant
  qu'il n'est pas réenregistré, les mêmes `genre_ids` qu'avant.
- L'édition depuis l'onglet Genres passe par le même écran et se termine sur « Enregistrer » ; les tuiles
  de l'onglet montrent les familles dérivées.
- `swift test` vert avec un nombre de tests ≥ celui d'avant ce projet ; `ios-check` vert avec les 8
  parcours adaptés et les 2 nouveaux ; `npm run check` vert.
- `grep -rn "GenreOnboardingModel\|SubgenresStepView\|SubgenreRow\b\|SelectAllChip\|wholeFamilyHint" ios/`
  ne renvoie rien.
- Aucun fichier de `ios/Track1Core/Sources/Track1Core/Profile/`, `ios/Track1Core/Sources/Track1Core/Recommendation/`,
  `ios/Track1Core/Sources/Track1Core/Analytics/`, `web/`, `src/`, `cache/`, `data/` n'est modifié.
- Les renvois de 1.4 sont en place.

## Points à trancher au gate

- **Q1 — Libellé du chip « tout sélectionner ».** (a) « Tous » + glyphe ChevronDown, Check une fois tout
  coché (l'actuel `SelectAllChip`, variantes Figma `175:39`/`175:43`, repris dans `SubgenreChip` avec
  `glyph:`) ; (b) « ALL ⤵ » tel que dessiné dans `243:1746`, soit « ALL » + ChevronDown, et Check une
  fois tout coché. Recommandation : (a) — interface en français, états déjà spécifiés et testés, la
  maquette montre un texte de travail. Impact : une ligne de 3.1 et une assertion de 3.2.
- **Q2 — Plusieurs cartes ouvertes à la fois (défaut de la spec) ou une seule.** Recommandation :
  plusieurs — c'est ce que la spec retient, et comparer deux familles côte à côte est le cas d'usage ;
  une seule éviterait la liste très longue de R3. Impact : `Set<String>` ou `String?` dans 3.1, une
  assertion de 3.2.
- **Q3 — Libellé du CTA au premier lancement.** Figma dit « Continuer » (vers 1.5), mais 1.5 est hors V1
  et le bouton termine le flux (profil écrit, Aujourd'hui). (a) « Continuer » comme dessiné ;
  (b) « Terminer » tant que 1.5 n'existe pas. Recommandation : (a), c'est une chaîne dans `ctaTitle`
  et l'alerte d'échec ; 1.5 s'insérera sans changer le bouton.
- **Q4 — L'édition (onglet Genres) suit le nouvel écran** (D3). Alternative : garder tuiles + étapes
  pour l'édition. Recommandation : suivre — un seul flux, une seule sémantique.
- **Q5 — Normalisation « famille seule » → tous ses sous-genres à l'édition, et union pour les v1**
  (D2, R1, R2). Alternative : un profil v3 sans `families` (tier/3). Recommandation : normaliser,
  profil inchangé.
- **Q6 — Accent de sélection** : `colorSelectionContent` (`#BC7722`, le token des chips) plutôt que
  l'ambre `#E6A23A` dessiné pour le titre de carte. Recommandation : le token ; sinon ajouter
  `colorAccentAmber` à `Track1Tokens` dans 2.1 (une ligne et un test).
- **Q7 — Le tick de défilement compte les cartes** (D5), pas les chips. Recommandation : les cartes.
