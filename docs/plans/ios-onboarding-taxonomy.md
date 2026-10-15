# Onboarding iOS sur la taxonomie éditoriale

Plan de la phase `plan` du process de livraison, écrit le 2026-10-15 sur le brief validé par Raphael.
Il remplace la décision D13 et le risque R8 de [`track1-ios-figma.md`](track1-ios-figma.md) pour
l'onboarding (écrans 1.2 et 1.3) et l'onglet Genres. Tout le reste de ce plan-là reste en vigueur.

Tous les chemins sont relatifs à la racine du dépôt. Les chiffres viennent du cache committé au
2026-10-15 (`jq` sur `data/genre-taxonomy.json`, `buildGraphFromCache` strict sur `cache/`).

## Problème

L'onboarding iOS construit son arbre de genres à partir des arêtes `subgenres` / `parent_genres` du
catalogue mobile (`ios/Track1Core/Sources/Track1Core/Features/Onboarding/GenreTaxonomy.swift`, D13).
Sur le cache committé, cet arbre donne 41 tuiles et 164 lignes ; 9 des 20 familles éditoriales n'ont
aucune tuile, Rock n'est pas une tuile, 32 sous-genres apparaissent sous plusieurs tuiles, et seuls
107 des 203 genres publiés sont sélectionnables. Le web, lui, montre la grille par famille de
`data/genre-taxonomy.json` (TRA-211 / D3a) : 20 familles, 203 genres publiés.

Le but : les 20 familles deviennent les tuiles de l'écran 1.2 et les genres publiés de chaque
famille deviennent les lignes de l'écran 1.3, avec les libellés éditoriaux.

Trois faits contraignent la solution :

- L'API mobile n'expose pas la taxonomie. `src/mobile/catalog.ts:98` n'émet que
  `taxonomy: { mode: "degraded", available }`. La projection existe pourtant déjà côté serveur
  (`src/genre-taxonomy-projection.ts:23-28`, type `GenreTaxonomyProjection`) et est posée sur le
  graphe que `createMobileCatalog` reçoit (`src/graph.ts:79`, `src/services/graph-service.ts:11-20`).
  Les clients déployés rejettent tout `mode` autre que `"degraded"`
  (`ios/Track1Core/Sources/Track1Core/API/APIModels.swift:73`).
- Le serveur projette la taxonomie en mode `degrade` : si `data/genre-taxonomy.json` référence un
  genre que le cache live n'a pas encore (le déploiement exclut `cache/`, qui est synchronisé à part),
  la projection entière est absente du graphe. C'est une situation de prod prévue
  (`src/services/graph-service.ts:12-15`), pas un cas d'école.
- Le profil iOS stocke `genreIDs: [NodeIdentity]` (identités `genre:*`, minimum 1,
  `ios/Track1Core/Sources/Track1Core/Profile/Profile.swift:30-54`), lues telles quelles par la
  recommandation (`Recommendation/Affinity.swift:45-49`, comparaison stricte d'identité) et par
  l'onglet Genres. Une famille n'est en général pas un nœud du graphe (3 sur 20 ont un slug :
  avant-garde, rock, jazz) ; un genre publié peut avoir plusieurs slugs (5 cas : Drill and Bass,
  Berlin School, IDM, Experimental Electronic, Rap français) ; 22 noms éditoriaux diffèrent du nom du
  nœud (« Drum & Bass » / « Drum and bass », « Prog Rock » / « Progressive Rock »). Les 203 genres
  publiés ont tous au moins un slug résolu dans le cache, et un `teaser` non vide sur ce nœud.

## Non-buts

- Changer la recommandation (`Affinity.swift`, `TodayViewModel.swift`) : elle continue de lire des
  identités `genre:*`. Aucune pondération nouvelle (famille vs sous-genre explicite).
- Rendre la projection serveur résiliente au retard du cache (dégrader genre par genre plutôt que
  tout ou rien) : c'est un chantier serveur distinct.
- Toucher au web (`web/index.html`), à `data/genre-taxonomy.json`, à la projection
  (`src/genre-taxonomy-projection.ts`) ou au client Expo gelé (`mobile/`, voir README).
- Les images de genre (Q5 du plan Figma), le design des écrans, les textes de l'écran d'accueil.
- Afficher les genres migrés mais non résolus (`droppedGenreIDs` reste une donnée, pas un message),
  comme aujourd'hui (TRA-442).
- Changer la propriété analytique `genres_count` ou l'allowlist des événements
  (`Analytics/AnalyticsEvent.swift:117-118`).
- Nettoyer les fichiers `profile.v1.json` des appareils : ils sont laissés en place (voir D6).

## Décisions d'archi

### D1 — La projection serveur voyage dans `/mobile/v1/catalog` sous `taxonomy.mode = "editorial"`

Le contrat `MobileCatalogResponse.taxonomy` devient une union discriminée sur `mode` :

```
taxonomy:
  | { mode: "degraded"; available: boolean }          // inchangé ; désormais toujours available: false
  | { mode: "editorial"; version: 2;
      families: { key; label; order; slug? }[];
      genres:   { id; name; family; slugs: string[] }[];
      legacySelectionBySlug: Record<string, string[]> }
```

Le serveur émet `editorial` quand le graphe porte `taxonomy`, `degraded` sinon. Les champs sont
recopiés explicitement depuis la projection (comme `toMobileNode` le fait pour les nœuds) : `qid`
n'est pas transmis, et un champ ajouté plus tard à la projection n'atteint pas le mobile sans
ticket. Un payload malformé (version ≠ 2, slug qui n'est pas une identité `genre:*`, clé manquante)
dégrade toute la taxonomie, il ne fait ni 500 ni projection partielle. La taxonomie n'est pas
filtrée par le paramètre `identities` (il ne concerne que nœuds et arêtes). `revision` la couvre
déjà (`catalog.ts:39-46`), donc l'ETag change quand l'éditorial change.

Côté Swift, le décodage devient tolérant : `mode` inconnu ou payload `editorial` malformé donnent
`.degraded(available: false)` au lieu de faire échouer tout le catalogue. Un `mode` absent reste
une erreur de contrat. Cette tolérance se merge **avant** le changement serveur (voir Partie 1) :
un build antérieur à 1.1 ne décode plus le catalogue dès que le serveur émet `editorial`.

Rejeté :
- Un endpoint séparé `/mobile/v1/taxonomy` : deux requêtes, deux ETags, et aucune garantie que les
  slugs de la taxonomie correspondent aux nœuds du catalogue reçu.
- Garder `mode: "degraded"` et ajouter une clé sœur `editorialTaxonomy` à la racine pour ne casser
  aucun client : le contrat mentirait (« dégradé » avec la taxonomie entière à côté).
- Recopier la projection telle quelle (`taxonomy: graph.taxonomy`) : fuite de `qid` et couplage
  silencieux du contrat mobile au type interne.
- Décodage Swift strict (rejeter tout `mode` inconnu) : c'est précisément ce qui rend ce changement
  risqué aujourd'hui.

### D2 — Le profil stocke la sélection éditoriale ET les slugs dérivés ; la recommandation ne change pas

Profil v2 :

```
Profile {
  version: 2
  local_id, revision, onboarding_completed, flow_id        // inchangés
  selection: { families: [String], genres: [String] } | null   // clés de famille, ids de taxonomie
  genre_ids: [NodeIdentity]                                  // dérivés de selection, consommés par Affinity
}
```

`genre_ids` reste la seule entrée de `Affinity.rank` et de l'onglet Genres : la recommandation
n'a jamais besoin de la taxonomie, donc elle fonctionne quand le serveur la dégrade (D4).
`selection` sert à restaurer exactement ce que la personne a coché quand elle rouvre le flux
d'édition. `selection == null` signifie « profil hérité de v1, sélection inconnue » : elle est
reconstruite à la première édition (D6).

Rejeté :
- Stocker uniquement des ids de taxonomie : `Affinity` devrait résoudre id → slugs à chaque
  classement, donc dépendre de la taxonomie, qui peut manquer.
- Stocker uniquement les slugs (profil v1 inchangé) : impossible de distinguer « famille cochée »
  de « tous ses genres cochés un par un », et l'intention éditoriale est perdue à chaque réouverture.

### D3 — Une famille sans sous-genre coché vaut toute la famille ; cocher des sous-genres restreint à ceux-là

Règle de dérivation, pure et testée seule :

```
derivedGenreIDs(selection, taxonomy) =
  ∪ pour chaque famille F de selection.families visible dans taxonomy :
      explicites = selection.genres ∩ genres(F)
      slugs( explicites non vides ? explicites : tous les genres visibles de F )
  dédoublonnée, triée par rawValue, restreinte aux nœuds présents dans le catalogue
```

Un genre à plusieurs slugs apporte tous ses slugs. Le slug propre d'une famille (rock, jazz,
avant-garde) n'est **pas** ajouté : la règle est la même pour les 20 familles. Le minimum reste
« au moins une famille » côté modèle, et « au moins un `genre_id` réconcilié » côté `ProfileStore`
(filet de sécurité pour Aujourd'hui, inchangé) ; chaque famille a au moins 3 genres publiés avec
un slug, donc le second découle du premier.

Rejeté : famille toujours développée en entier, sous-genres explicites à un poids supérieur. Cela
demande deux niveaux de poids dans `Affinity` (hors scope) ; les arêtes `subgenres` /
`related_genres` des genres explicites donnent déjà le voisinage à +1 (`Affinity.swift:55-61`).

### D4 — Taxonomie dégradée : onboarding et édition indisponibles (état existant), Aujourd'hui intact

Quand `catalog.taxonomy` est `.degraded`, `EditorialGenreTaxonomy(catalog:)` renvoie `nil` ;
`FirstLaunchOnboardingView` passe en `.unavailable` (`OnboardingFlowView.swift:191-194`, état et
bouton « réessayer » déjà là) et l'onglet Genres en `.failed` (`GenresTabView.swift:234-236`). Un
profil existant continue d'alimenter Aujourd'hui via `genre_ids` (D2). Aucun arbre de secours n'est
construit.

Rejeté :
- Garder l'arbre dérivé des arêtes comme repli : deux arbres à maintenir, et deux espaces
  d'identifiants (clés de famille / `genre:*`) dans le même profil.
- Embarquer un instantané de la projection dans l'app (ressource SwiftPM + générateur + test de
  dérive) : c'est la seule option qui garde l'onboarding **premier lancement** fonctionnel pendant
  une fenêtre de retard du cache. Elle coûte deux tickets et une procédure de régénération. Elle est
  décrite en Partie 3, **optionnelle**, à activer sur la réponse à Q2.
- Mémoriser côté client la dernière taxonomie éditoriale reçue : n'aide pas le premier lancement,
  qui est précisément l'onboarding.

### D5 — Libellés éditoriaux, description = `teaser` du premier slug présent, ordre servi

- Tuile : `label` de la famille. Ligne : `name` éditorial du genre (« Drum & Bass »), pas le nom du
  nœud.
- Description de ligne : `teaser` du nœud du premier slug du genre présent dans le catalogue ; `nil`
  s'il est absent ou vide (la ligne masque alors la description, `SubgenreRow.swift:15-23`).
- Ordre : familles par `order` puis `key` ; genres dans l'ordre servi par la projection, le même
  que la grille web (`web/index.html:1116-1118`). Un genre dont aucun slug n'est dans le catalogue
  est masqué ; une famille sans genre visible est masquée (même règle que le web, `:1175-1177`).

Rejeté : tri par nom en locale `fr` sur l'appareil, comme aujourd'hui (`GenreTaxonomy.swift:73-82`).
L'ordre serait différent du web pour la même taxonomie, sans source de vérité.

### D6 — Migration v1 → v2 paresseuse, à la première édition, via `legacySelectionBySlug`

- `ProfileStore` lit `profile.v2.json` ; s'il est absent, il lit `profile.v1.json` et le remonte en
  mémoire en v2 avec `selection = nil`, sans rien écrire. `local_id`, `revision`, `flow_id` sont
  conservés. Le premier `commit` écrit `profile.v2.json` ; le fichier v1 n'est ni réécrit ni
  supprimé (un build antérieur réinstallé le relit tel quel). `clear()` supprime les quatre fichiers
  (profil et brouillon, v1 et v2). Un brouillon v1 n'est pas relu : c'est un onboarding inachevé.
- Le modèle d'onboarding reconstruit la sélection d'un profil `selection == nil` depuis
  `genre_ids` avec `legacySelectionBySlug` (même table que la migration web,
  `web/index.html:752-787`) : un slug qui résout vers tous les genres visibles d'une famille
  (slug de famille, par exemple `genre:rock`) coche la famille seule ; un slug qui résout vers un ou
  plusieurs ids coche chaque id et sa famille ; un slug absent ou vide part dans `droppedGenreIDs`.
  La sélection reconstruite est enregistrée en v2 à l'enregistrement suivant seulement.

Conséquence assumée : un profil v1 « Rock + Prog Rock » devient « famille Rock, Prog Rock explicite »,
donc `genre_ids` se restreint à `genre:progressive-rock` à la prochaine sauvegarde (D3). Jusque-là,
Aujourd'hui lit les `genre_ids` v1 inchangés. Population concernée : l'iPhone de Raphael (L.3 #384
est encore ouvert).

Rejeté :
- Migrer au chargement du profil : la taxonomie n'est pas disponible à ce moment-là (elle arrive avec
  le catalogue, et peut manquer).
- Bumper `version` dans `profile.v1.json` : un build antérieur répond `.unsupportedVersion` et
  propose de supprimer le profil (`ProfileStore.swift:78`, `SettingsView.swift:23`).

## Découpage

Neuf tâches en deux parties, plus une troisième partie optionnelle. Points = estimate Linear.
« ∥ » marque les tâches qui peuvent tourner en worktrees simultanés.

| # | Tâche | Tier | Pts | Dépend de |
|---|---|---|---|---|
| 1.1 | iOS · décoder `taxonomy` en `degraded` / `editorial` | tier/2 | 2 | — |
| 1.2 | Serveur · émettre `taxonomy.mode = "editorial"` | tier/3 | 3 | 1.1 mergée |
| 1.3 | Doc · `track1-api.md` et renvoi dans le plan Figma | tier/1 | 1 | — ∥ 1.1, 1.2 |
| 2.1 | Core · `EditorialGenreTaxonomy` | tier/2 | 3 | 1.1 ∥ 1.2, 1.3 |
| 2.2 | Core · `GenreSelection` et profil v2 (types, dérivation) | tier/2 | 2 | 2.1 |
| 2.3 | Core · `ProfileStore` v2 et lecture v1 | tier/3 | 3 | 2.2 ∥ 2.4 |
| 2.4 | Core · `GenreOnboardingModel` (sélection, étapes, brouillon) | tier/2 | 5 | 2.2 ∥ 2.3 |
| 2.5 | Core · restauration d'un profil v1 dans le modèle | tier/2 | 3 | 2.4 |
| 2.6 | App · brancher les vues, supprimer l'arbre dérivé | tier/2 | 5 | 2.3, 2.5, 1.2 déployée |
| 3.1 | (optionnel) Instantané de la taxonomie embarqué | tier/2 | 3 | 2.1 |
| 3.2 | (optionnel) Repli du client sur l'instantané | tier/2 | 2 | 3.1, 2.6 |

Chaque PR laisse `main` compilable par `ios-check` : les nouveaux types Core sont ajoutés à côté
des anciens (2.1 à 2.5), les vues basculent et les anciens types sont supprimés en une fois (2.6).

### Partie 1 — Le contrat : la taxonomie éditoriale voyage jusqu'à l'app

Incrément livrable seul : l'app décode le nouveau contrat sans changer de comportement, le serveur
l'émet, le web n'est pas concerné (il lit le graphe, pas le catalogue mobile).

#### 1.1 — iOS · Décoder `taxonomy` en `degraded` / `editorial`

- [ ] TRA-511 Décoder `CatalogTaxonomy` comme une union tolérante

Fichiers :
- `ios/Track1Core/Sources/Track1Core/API/APIModels.swift` — `CatalogTaxonomy` (l.65-75) devient un
  `enum` ; nouveaux types `EditorialTaxonomy`, `EditorialTaxonomyFamily`, `EditorialTaxonomyGenre` ;
  clés ajoutées à `APIKeys`.
- `ios/Track1Core/Tests/Track1CoreTests/API/CatalogTaxonomyTests.swift` — nouveau (garder
  `APIClientTests.swift`, 414 lignes, hors du diff sauf si une assertion existante casse).

Contrat :
```
public enum CatalogTaxonomy: Equatable, Sendable {
  case degraded(available: Bool)
  case editorial(EditorialTaxonomy)
}
public struct EditorialTaxonomy: Equatable, Sendable {
  public let families: [EditorialTaxonomyFamily]      // ordre servi
  public let genres: [EditorialTaxonomyGenre]         // ordre servi
  public let legacySelectionBySlug: [NodeIdentity: [String]]
}
public struct EditorialTaxonomyFamily: Equatable, Sendable { key: String; label: String; order: Int; slug: NodeIdentity? }
public struct EditorialTaxonomyGenre:  Equatable, Sendable { id: String; name: String; family: String; slugs: [NodeIdentity] }
```
Règles de décodage :
- `mode == "degraded"` → `.degraded(available:)` (`available` Bool requis, comme aujourd'hui).
- `mode == "editorial"` → `.editorial` si et seulement si : `version == 2` ; `families` et `genres`
  sont des tableaux ; `key`, `label`, `id`, `name`, `family` non vides ; `order` entier ; clés de
  famille uniques ; ids de genre uniques ; chaque `genre.family` existe dans `families` ; chaque
  slug (`slugs`, `family.slug`, clés de `legacySelectionBySlug`) est une `NodeIdentity` de type
  `.genre`. Toute violation → `.degraded(available: false)`.
- Tout autre `mode` → `.degraded(available: false)`. `mode` absent ou `taxonomy` absente → erreur
  (`APIModelError.invalidValue`), comme aujourd'hui.
- Les clés non déclarées (`qid`, etc.) sont ignorées.

Critères d'acceptation :
- [ ] Les JSON `taxonomy` existants des tests (`{"mode":"degraded","available":true}`) décodent en
      `.degraded(available: true)` ; les 11 tests d'`APIClientTests` passent sans modification.
- [ ] Un payload `editorial` nominal (2 familles dont une avec `slug`, 3 genres dont un à 2 slugs,
      une table `legacySelectionBySlug` à 3 entrées, un `qid` superflu) décode en `.editorial` avec
      les valeurs et l'ordre servis.
- [ ] `mode: "v3"` → `.degraded(available: false)` ; `editorial` avec `version: 3` →
      `.degraded(available: false)` ; `editorial` avec un slug `artist:*` → idem ; `genre.family`
      inconnue → idem ; `taxonomy` sans `mode` → erreur de décodage.
- [ ] `swift test` passe ; le nombre de tests du package augmente d'au moins 7.

Tests attendus : unitaires sur le décodage (nominal, chaque règle de dégradation, erreur de contrat).

Notes : un `[NodeIdentity: [String]]` ne se décode **pas** directement avec `Decodable` (une clé non
`String`/`Int` est décodée comme un tableau plat alterné) : décoder `[String: [String]]` puis
convertir. Aucun autre lecteur de `catalog.taxonomy` n'existe dans `ios/` (vérifié) : le diff ne
touche que le décodage.

#### 1.2 — Serveur · Émettre `taxonomy.mode = "editorial"` dans le catalogue mobile

- [ ] TRA-512 Projeter la taxonomie éditoriale dans `MobileCatalogResponse.taxonomy`

Tier/3 : contrat d'API public. **≤ 200 lignes de diff**, d'où la doc en 1.3. Mergée seulement après
1.1 (voir R1).

Fichiers :
- `src/mobile/contracts.ts` — `taxonomy` (l.24-27) devient `MobileCatalogTaxonomy` ; nouveaux
  types `MobileTaxonomyFamily`, `MobileTaxonomyGenre`, `MobileEditorialTaxonomy`,
  `MobileDegradedTaxonomy`.
- `src/mobile/catalog.ts` — `toCatalogProjection` (l.84-102) : `taxonomy` lue comme `unknown` et
  recopiée champ à champ via une fonction `toMobileTaxonomy(value: unknown): MobileCatalogTaxonomy`.
- `test/fixtures/mobile-contracts.json` — `graph.taxonomy` (l.38, objet factice
  `{mode, reason}`) remplacé par une projection minimale réelle (2 familles dont `rock` avec
  `slug: "genre:rock"`, 3 genres dont un à 2 slugs, `legacySelectionBySlug` couvrant un slug de
  genre, un slug de famille et un slug redirigé). Les nœuds du fixture ne changent pas.
- `test/mobile/catalog.test.ts` — assertion l.28 mise à jour, tests ajoutés.
- Ne pas toucher : `test/mobile/generation.test.ts` (l.289, 473, 534 typent
  `{ mode: "degraded" as const, available: true }` : le type `MobileDegradedTaxonomy` garde
  `available: boolean` précisément pour ne pas y toucher), `src/mobile/http.ts`, `test/mobile/http.test.ts`.

Contrat :
```
export interface MobileTaxonomyFamily { key: string; label: string; order: number; slug?: string }
export interface MobileTaxonomyGenre  { id: string; name: string; family: string; slugs: string[] }
export interface MobileEditorialTaxonomy {
  mode: "editorial"; version: 2;
  families: MobileTaxonomyFamily[]; genres: MobileTaxonomyGenre[];
  legacySelectionBySlug: Record<string, string[]>;
}
export interface MobileDegradedTaxonomy { mode: "degraded"; available: boolean }
export type MobileCatalogTaxonomy = MobileDegradedTaxonomy | MobileEditorialTaxonomy;
```
Règles : `editorial` si `graph.taxonomy` est un objet avec `version === 2`, `families` et
`genres` tableaux d'objets aux champs typés ci-dessus (`order` nombre fini, `slug` optionnel),
`legacySelectionBySlug` objet de tableaux de chaînes ; tout slug (dans `slugs`, `family.slug`, clés
de la table) doit passer `isValidMobileIdentity` et commencer par `genre:`. Sinon
`{ mode: "degraded", available: false }`. `qid` et tout champ non listé ne sont pas recopiés.
`families` et `genres` gardent l'ordre de la projection. La taxonomie est émise identique avec ou
sans filtre `identities`.

Critères d'acceptation :
- [ ] `getCatalog()` sur le fixture renvoie `taxonomy.mode === "editorial"` avec exactement les
      familles, genres et table du fixture, sans `qid`, et `revision` reste stable d'un appel à
      l'autre.
- [ ] Le même graphe sans `taxonomy` renvoie `{ mode: "degraded", available: false }`.
- [ ] Un graphe dont `taxonomy.version` vaut 3, ou dont un slug vaut `artist:x`, renvoie
      `{ mode: "degraded", available: false }` et pas d'exception.
- [ ] Deux graphes identiques sauf la taxonomie ont deux `revision` différentes.
- [ ] `getCatalog(["project:blue-lines"])` renvoie la même `taxonomy` que l'appel sans filtre.
- [ ] `npm run check` passe (`tsc` strict : l'union se narrow sur `mode`).

Tests attendus : unitaires dans `test/mobile/catalog.test.ts` (les cinq critères ci-dessus).

Notes : `toCatalogProjection` travaille déjà sur `unknown` avec `record` / `array` / `string`
(`catalog.ts:131-150`) ; réutiliser ces helpers. Ne pas importer `GenreTaxonomyProjection` dans
`src/mobile/` : le contrat mobile est indépendant du type interne (D1).

#### 1.3 — Doc · `docs/track1-api.md` et renvoi dans le plan Figma

- [ ] TRA-513 Documenter les deux modes de `taxonomy` et renvoyer D13/R8 vers ce plan

Fichiers :
- `docs/plans/ios-onboarding-taxonomy.md` — ce plan, publié sur `main` tel que validé (il n'existe
  encore que dans le worktree du dispatcher ; les tickets y renvoient par `blob/main`).
- `docs/track1-api.md` — exemple JSON l.44 et paragraphe l.63-66 : les deux modes, la forme
  `editorial`, « `degraded` implique désormais `available: false` », taxonomie non filtrée par
  `identities`, couverte par `revision`.
- `docs/plans/track1-ios-figma.md` — une ligne sous D13 (l.247) et sous R8 (l.1736) :
  « Remplacée le 2026-10-15 par `docs/plans/ios-onboarding-taxonomy.md`. »

Critères d'acceptation :
- [ ] L'exemple JSON de `track1-api.md` est un `editorial` valide selon 1.2 (relu contre le contrat).
- [ ] Les deux renvois sont présents, rien d'autre ne change dans le plan Figma.

Tests attendus : aucun (doc). Tier/1, parallélisable avec 1.1 et 1.2.

### Partie 2 — L'onboarding raisonne en familles et genres éditoriaux

Incrément livrable : à la fin, l'écran 1.2 montre les familles, l'écran 1.3 les genres publiés, le
profil est écrit en v2, un profil v1 est repris. Chaque tâche est mergeable seule : 2.1 à 2.5 ajoutent
des types Core que l'app n'utilise pas encore ; 2.6 bascule et nettoie.

#### 2.1 — Core · `EditorialGenreTaxonomy`

- [ ] TRA-514 Construire tuiles et lignes depuis `CatalogTaxonomy.editorial` et les nœuds du catalogue

Fichiers :
- `ios/Track1Core/Sources/Track1Core/Features/Onboarding/EditorialGenreTaxonomy.swift` — nouveau.
- `ios/Track1Core/Tests/Track1CoreTests/Profile/EditorialGenreTaxonomyTests.swift` — nouveau, avec
  un helper `EditorialFixture` (catalogue JSON à taxonomie `editorial`, paramètres `nodes`,
  `edges`, `teasers`, `families`, `genres`, `legacy`) que 2.4 et 2.5 réutilisent. Ne pas étendre
  `OnboardingFixture` (`GenreTaxonomyTests.swift:120`), supprimé en 2.6.
- Ne pas toucher `GenreTaxonomy.swift` ni `OnboardingFlowModel.swift`.

Contrat :
```
public struct FamilyChoice: Equatable, Sendable, Identifiable { public let id: String /* clé */; public let name: String /* label */ }
public struct EditorialGenreChoice: Equatable, Sendable, Identifiable {
  public let id: String            // id de taxonomie (QID ou local:*)
  public let name: String          // nom éditorial
  public let definition: String?   // teaser du premier slug présent, nil si absent ou vide
  public let family: String
  public let slugs: [NodeIdentity] // seulement ceux présents dans le catalogue, ordre servi
}
public struct EditorialGenreTaxonomy: Sendable {
  public init?(catalog: Catalog)                       // nil si .degraded ou aucune famille visible
  public let families: [FamilyChoice]                  // par order puis key ; ≥ 1 genre visible
  public func genres(of family: String) -> [EditorialGenreChoice]   // ordre servi
  public func genre(_ id: String) -> EditorialGenreChoice?
  public func family(_ key: String) -> FamilyChoice?
  public func legacyGenreIDs(for slug: NodeIdentity) -> [String]    // table servie, filtrée aux genres visibles ; [] si absent
}
```
Règles : genre visible = au moins un slug dont le nœud est dans `catalog.nodes` avec `type == .genre`.
Nom = `name` éditorial, jamais `CatalogNode.name`. `definition` : `teaser` du nœud du premier slug
conservé, `nil` si `null` ou vide après trim.

Critères d'acceptation :
- [ ] `init?` renvoie `nil` sur un catalogue `.degraded`, et sur un `editorial` dont aucun genre n'a
      de slug dans le catalogue.
- [ ] Les familles sortent par `order` (pas par label), et une famille sans genre visible est absente.
- [ ] Un genre à 2 slugs dont un seul est dans le catalogue garde ce seul slug ; un genre sans slug
      présent est absent de `genres(of:)`.
- [ ] Pour un nœud « Drum and bass » et un genre éditorial « Drum & Bass », la ligne s'appelle
      « Drum & Bass » ; sa `definition` est le `teaser` du nœud ; `teaser` vide → `definition == nil`.
- [ ] `genres(of:)` garde l'ordre servi, même si un tri alphabétique donnerait autre chose.
- [ ] `legacyGenreIDs(for:)` exclut les ids de genres invisibles et renvoie `[]` pour un slug absent.
- [ ] `swift test` passe ; au moins 9 tests ajoutés.

#### 2.2 — Core · `GenreSelection` et profil v2 (types et dérivation)

- [ ] TRA-515 Ajouter `selection` au profil et la dérivation des `genre_ids`

Fichiers :
- `ios/Track1Core/Sources/Track1Core/Profile/GenreSelection.swift` — nouveau.
- `ios/Track1Core/Sources/Track1Core/Profile/Profile.swift` — `Profile` et `ProfileDraft`
  gagnent `selection: GenreSelection?` (clé JSON `selection`), paramètre d'`init` avec défaut `nil`
  pour que tous les appelants existants compilent ; `isValid()` étendu. `Profile.version` reste 1
  ici (bascule en 2.3).
- `ios/Track1Core/Tests/Track1CoreTests/Profile/GenreSelectionTests.swift` — nouveau.
- Ne pas toucher `ProfileStore.swift` (2.3).

Contrat :
```
public struct GenreSelection: Codable, Equatable, Sendable {
  public let families: [String]   // clés, ordre de sélection, uniques, ≥ 1
  public let genres: [String]     // ids de taxonomie, uniques
  public func derivedGenreIDs(in taxonomy: EditorialGenreTaxonomy) -> [NodeIdentity]   // règle D3
  func isValid() -> Bool          // families non vide, families et genres sans doublon
}
```

Critères d'acceptation :
- [ ] Famille seule → tous les slugs de tous ses genres visibles ; famille + 2 genres explicites →
      seulement les slugs de ces 2 genres ; un genre à 2 slugs apporte les 2.
- [ ] Un id de genre d'une famille non sélectionnée, un id inconnu, une famille inconnue ne
      contribuent rien ; le résultat est dédoublonné et trié par `rawValue`.
- [ ] `Profile` et `ProfileDraft` encodent/décodent avec et sans `selection` (clé absente ⇔ `nil`) ;
      un profil `selection: {families: []}` est invalide ; un profil sans `selection` reste valide.
- [ ] Les 8 tests de `ProfileStoreTests`, les 3 d'`OnboardingContractTests` et les 18 de
      `TodayViewModelTests` passent sans modification.

#### 2.3 — Core · `ProfileStore` v2 et lecture v1

- [ ] TRA-516 Écrire `profile.v2.json`, relire `profile.v1.json` sans l'écrire

Tier/3 : migration de schéma de données personnelles. **≤ 200 lignes de diff** ; l'adaptation des
8 tests existants (noms de fichiers) est mécanique et compte dedans.

Fichiers :
- `ios/Track1Core/Sources/Track1Core/Profile/Profile.swift` — `Profile.version = 2`.
- `ios/Track1Core/Sources/Track1Core/Profile/ProfileStore.swift` — fichiers `profile.v2.json` et
  `profile-draft.v2.json` ; `read()` ; `commit` ; `clear()` ; `resetIfNeeded` (seed corrompu sur le
  fichier v2).
- `ios/Track1Core/Tests/Track1CoreTests/Profile/ProfileStoreTests.swift`.

Contrat (comportements, signatures inchangées) :
- `read()` : v2 présent → décodé, `version == 2` exigé, sinon `.unsupportedVersion` ; v2 absent et
  v1 présent → décodé avec `version == 1` exigé, renvoyé comme `Profile(version: 2, selection: nil,
  mêmes local_id / genre_ids / revision / flow_id)`, **rien n'est écrit** ; aucun des deux →
  `.missing`. Un fichier illisible → `.corrupt` comme aujourd'hui.
- `commit` : écrit v2 ; reporte `draft.selection` ; `revision` incrémentée si `genre_ids` **ou**
  `selection` changent ; `local_id` et `flow_id` du profil courant (v1 relu compris) conservés ;
  accepte un brouillon `selection == nil` (profil écrit en v2 avec `selection: null`).
- `clear()` : supprime `profile.v1.json`, `profile-draft.v1.json`, `profile.v2.json`,
  `profile-draft.v2.json`.
- `beginInitialDraft` / `readDraft` : brouillon v2 seulement ; un `profile-draft.v1.json` est ignoré.

Critères d'acceptation :
- [ ] Un `profile.v1.json` valide est relu comme `.profile` avec `version == 2`, `selection == nil`,
      mêmes `local_id`, `genre_ids`, `revision` ; aucun fichier n'est créé par la lecture.
- [ ] Après cette lecture, un `commit` avec sélection écrit `profile.v2.json`, garde `local_id`,
      passe `revision` à +1, et laisse `profile.v1.json` intact octet pour octet.
- [ ] Deux `commit` successifs avec les mêmes `genre_ids` mais une `selection` différente
      incrémentent `revision` ; avec la même `selection`, non.
- [ ] v1 et v2 présents → v2 gagne. `profile.v2.json` avec `version: 3` → `.unsupportedVersion`.
- [ ] `clear()` supprime les quatre fichiers.
- [ ] Les 8 tests existants adaptés passent ; au moins 5 tests ajoutés.

#### 2.4 — Core · `GenreOnboardingModel` (sélection, étapes, brouillon)

- [ ] TRA-517 Modèle d'onboarding sur familles et genres éditoriaux

Nouveau modèle à côté d'`OnboardingFlowModel` (supprimé en 2.6). Même découpage d'API que lui,
identifiants `String` à la place de `NodeIdentity`. Diff attendu ~450 lignes (tests compris) :
au-dessus de 300 mais lisible, parce que c'est un port test par test.

Fichiers :
- `ios/Track1Core/Sources/Track1Core/Features/Onboarding/GenreOnboardingModel.swift` — nouveau.
- `ios/Track1Core/Tests/Track1CoreTests/Profile/GenreOnboardingModelTests.swift` — nouveau, bâti
  sur `EditorialFixture` (2.1).
- Ne pas toucher `OnboardingFlowModel.swift`, `OnboardingCopy.swift`, les vues.

Contrat :
```
@MainActor @Observable public final class GenreOnboardingModel {
  public init(taxonomy: EditorialGenreTaxonomy, editing: Profile? = nil, draft: ProfileDraft? = nil)
  public var familyChoices: [FamilyChoice]              // tuiles, ordre des familles
  public private(set) var selectedFamilies: [String]    // ordre de sélection
  public var selectedFamilyChoices: [FamilyChoice]      // ordre des tuiles (onglet Genres)
  public var isEditing: Bool
  public var canContinueFromGenres: Bool                // ≥ 1 famille
  public var subgenreSteps: [String]                    // == selectedFamilies
  public var selectedSubgenreCount: Int
  public let droppedGenreIDs: [NodeIdentity]            // [] dans cette tâche, rempli en 2.5
  public func toggleFamily(_ key: String)               // décocher retire ses genres explicites
  public func toggleSubgenre(_ id: String, of family: String)
  public func toggleAll(of family: String)
  public func isAllSelected(of family: String) -> Bool
  public func subgenreChoices(of family: String) -> [EditorialGenreChoice]   // [] si famille non sélectionnée
  public func isSubgenreSelected(_ id: String) -> Bool
  public func subgenreStep(after family: String) -> String?
  public func ctaTitle(forStep index: Int) -> String    // « Continuer » / « Terminer » / « Enregistrer », inchangé
  public func makeDraft() -> ProfileDraft               // selection + derivedGenreIDs, flowID et flag conservés
}
```
Restauration dans cette tâche : `draft?.selection ?? editing?.selection` non nil → familles connues
gardées dans l'ordre stocké, genres gardés s'ils sont visibles et d'une famille sélectionnée, le
reste écarté en silence. `selection == nil` → sélection vide (2.5 ajoute le chemin v1).

Critères d'acceptation :
- [ ] `familyChoices` suit l'ordre de la taxonomie ; `toggleFamily` ajoute en fin de
      `selectedFamilies`, un second appel retire la famille et ses genres explicites.
- [ ] `toggleSubgenre` ignore une famille non sélectionnée ou un genre d'une autre famille ;
      `toggleAll` coche puis décoche tous les genres de la famille ; `isAllSelected` est vrai aussi
      quand tout a été coché à la main.
- [ ] `makeDraft()` porte `selection == {families, genres}` et `genreIDs == selection.derivedGenreIDs`
      (famille seule → tous ses slugs ; famille + explicites → les leurs), et conserve `flowID` et
      `onboardingStartedRecorded` du brouillon reçu.
- [ ] Un profil v2 recréé par `makeDraft()` puis rechargé en `editing` redonne la même sélection
      (point fixe).
- [ ] `subgenreStep(after:)`, `ctaTitle(forStep:)`, `canContinueFromGenres` se comportent comme les
      tests homonymes d'`OnboardingFlowModelTests` (reporter ces cas).
- [ ] `swift test` passe ; au moins 20 tests.

#### 2.5 — Core · Restauration d'un profil v1 dans le modèle

- [ ] TRA-518 Reconstruire la sélection d'un profil `selection == nil` depuis `genre_ids`

Fichiers :
- `ios/Track1Core/Sources/Track1Core/Features/Onboarding/GenreOnboardingModel.swift` — chemin
  `selection == nil` de l'`init`, `droppedGenreIDs`.
- `ios/Track1Core/Tests/Track1CoreTests/Profile/GenreOnboardingLegacyRestoreTests.swift` — nouveau.

Contrat (règles, appliquées à `editing.genreIDs` dans l'ordre stocké, D6) :
1. `ids = taxonomy.legacyGenreIDs(for: slug)`.
2. `ids` vide → `slug` ajouté à `droppedGenreIDs`.
3. `Set(ids)` égal à l'ensemble des genres visibles d'une seule famille → cette famille sélectionnée,
   aucun genre explicite ajouté.
4. Sinon chaque id → sa famille sélectionnée si elle ne l'est pas, et l'id ajouté aux explicites.
Un brouillon (`draft`) `selection == nil` n'est jamais relu (2.3 ignore les brouillons v1).

Critères d'acceptation :
- [ ] `genre:rock` (slug de famille → 16 ids) → famille `rock` seule, 0 explicite, `isAllSelected`
      faux ; `makeDraft().genreIDs` = tous les slugs de la famille.
- [ ] `genre:progressive-rock` → famille `rock` + explicite « Prog Rock » ; `[genre:rock,
      genre:progressive-rock]` → famille `rock` + explicite « Prog Rock » seulement (D6 assumée).
- [ ] Un slug dont la table donne 2 ids de 2 familles → les 2 familles, les 2 explicites.
- [ ] Un slug absent de la table, ou dont tous les ids sont invisibles → `droppedGenreIDs`, rien
      d'autre ne change.
- [ ] Un profil v2 (`selection` non nil) ne passe pas par ces règles et a `droppedGenreIDs == []`.
- [ ] Au moins 8 tests.

#### 2.6 — App · Brancher les vues, supprimer l'arbre dérivé

- [ ] TRA-519 Basculer l'onboarding et l'onglet Genres sur `GenreOnboardingModel`

Compilée et testée par `ios-check` seulement (`ios/Track1` et `ios/Track1UITests`). Mergée après
2.3, 2.5, et **après le déploiement de 1.2** (sinon le build installé ne verrait qu'un onboarding
« indisponible »). Diff attendu ~+250 / −900 (suppressions).

Fichiers :
- `ios/Track1/Features/Onboarding/OnboardingFlowView.swift` — `Step.subgenres(String)` ;
  `FirstLaunchOnboardingView.load()` construit `EditorialGenreTaxonomy(catalog:)`, `nil` →
  `.unavailable` (état existant l.191-194, copie inchangée) ; `GenreOnboardingModel`.
- `ios/Track1/Features/Onboarding/GenresStepView.swift` — `familyChoices`, `selectedFamilies`,
  `toggleFamily`, identifiant d'accessibilité par clé de famille.
- `ios/Track1/Features/Onboarding/SubgenresStepView.swift` — `parent: FamilyChoice`, ids `String`
  (`ScrollTracker`, `RowEdgeKey`, `RowEdgeReader`).
- `ios/Track1/Features/Genres/GenresTabView.swift` — `LoadedCatalog.taxonomy:
  EditorialGenreTaxonomy`, `nil` → `.failed` ; tuiles = `selectedFamilyChoices` ;
  `ProfileEditorSheet` sur le nouveau modèle.
- `ios/Track1/Features/Settings/SettingsView.swift:107` — compte affiché depuis `selection`
  quand elle existe (« 2 familles · 5 sous-genres », singulier géré), sinon texte actuel.
- `ios/Track1/DesignSystem/Components/Onboarding/GenreTile.swift:20` et `SubgenreRow.swift:9` —
  `identifier(for:)` prend une `String` (`genre-tile-<clé>`, `subgenre-row-<id>`).
- `ios/Track1Tests/Profile/GenresStepLayoutTests.swift` — fixture JSON avec `taxonomy` éditoriale.
- `ios/Track1UITests/ProfileFlowTests.swift` — les deux fixtures (l.232-241) portent une
  `taxonomy` éditoriale (familles `family-0..2`, genres `local:genre-3..5`), identifiants mis à jour.
- Supprimés : `ios/Track1Core/Sources/Track1Core/Features/Onboarding/GenreTaxonomy.swift`,
  `OnboardingFlowModel.swift`, `ios/Track1Core/Tests/Track1CoreTests/Profile/GenreTaxonomyTests.swift`
  (et son `OnboardingFixture`), `OnboardingFlowModelTests.swift`, `OnboardingSubgenreRowsTests.swift`.
  Vérifier par `grep` qu'aucun autre fichier ne référence `GenreTaxonomy(`, `OnboardingFlowModel`,
  `GenreChoice` ou `OnboardingFixture` avant de supprimer.
- Hors scope : `Affinity.swift`, `TodayViewModel.swift`, `AnalyticsEvent.swift`
  (`genres_count` reste `profile.genreIDs.count`), le design des composants.

Critères d'acceptation :
- [ ] `ios-check` vert : build, `ios/Track1Tests` (dont les 6 de `GenresStepLayoutTests`) et les 6
      parcours de `ProfileFlowTests` passent avec les fixtures éditoriales.
- [ ] Sur un catalogue `editorial`, l'écran 1.2 liste une tuile par famille visible dans l'ordre
      `order`, l'écran 1.3 d'une famille liste ses genres avec nom éditorial et description ;
      « Terminer » écrit un `profile.v2.json` avec `selection`.
- [ ] Sur un catalogue `degraded`, le premier lancement montre l'état indisponible avec
      « réessayer », et l'onglet Genres son état d'échec ; Aujourd'hui fonctionne avec un profil
      existant (parcours existant de `ProfileFlowTests` conservé ou ajouté).
- [ ] Les réglages affichent le compte de familles et de sous-genres pour un profil v2.
- [ ] `grep -rn "GenreTaxonomy\b\|OnboardingFlowModel\|GenreChoice" ios/` ne renvoie rien.
- [ ] `swift test` passe ; le nombre total de tests du package ne baisse pas par rapport à avant
      2.1 (les cas supprimés ont leurs équivalents en 2.1, 2.4, 2.5).

### Partie 3 — (optionnelle) Instantané de la taxonomie embarqué dans l'app

À créer **seulement** si Raphael retient cette option à Q2. Elle garde l'onboarding premier
lancement fonctionnel pendant une fenêtre où le serveur dégrade la taxonomie (retard du cache live).

#### 3.1 — Générer et embarquer `genre-taxonomy.json` dans `Track1Core`

- [ ] TRA-? Instantané de la projection mobile comme ressource SwiftPM

Fichiers : `scripts/ios-taxonomy-snapshot.ts` (nouveau ; construit le graphe strict sur `cache/` et
`data/`, applique la même projection mobile que 1.2, écrit
`ios/Track1Core/Sources/Track1Core/Resources/genre-taxonomy.json`), `package.json` (script
`ios:taxonomy-snapshot`, aucune dépendance), `ios/Track1Core/Package.swift` (`resources:
[.copy("Resources/genre-taxonomy.json")]`), `test/ios-taxonomy-snapshot.test.ts` (nouveau).
Contrat : le fichier est un objet `MobileEditorialTaxonomy` (1.2). Test de compatibilité, pas
d'égalité octet : chaque slug de l'instantané existe dans `cache/nodes/genre/`, 20 familles, et le
fichier décode côté Swift (`EditorialTaxonomy`). Tier/2, 3 pts.

#### 3.2 — Repli du client sur l'instantané

- [ ] TRA-? `EditorialGenreTaxonomy` se replie sur la ressource embarquée quand le catalogue est dégradé

Fichiers : `EditorialGenreTaxonomy.swift` (`init?(catalog:)` lit `Bundle.module` quand
`catalog.taxonomy` est `.degraded` ; les slugs absents du catalogue sont filtrés comme en 2.1),
tests. Critère : sur un catalogue `degraded` contenant les nœuds genre, l'onboarding montre les
familles de l'instantané ; sur un catalogue sans nœud genre, `nil`. Tier/2, 2 pts.

## Risques

- **R1 — Un build antérieur à 1.1 ne décode plus le catalogue dès que 1.2 est déployée** (rejet de
  `mode != "degraded"`, `APIModels.swift:73`). Garde-fous : 1.2 est bloquée par 1.1 dans Linear ;
  le déploiement suit le push sur `main` (`deploy.yml`), donc l'ordre de merge est l'ordre de
  déploiement ; Raphael n'installe pas un build antérieur à 1.1 après ce déploiement (L.3 #384 est
  encore ouvert, aucun appareil n'est engagé). Le client Expo gelé (`mobile/src/api/contracts.ts:127`,
  `z.literal("degraded")`) ne décodera plus le catalogue : accepté, il est gelé et n'est pas une
  release (README l.32-36) ; `mobile-ci` ne tourne que sur `mobile/**`.
- **R2 — Taxonomie dégradée en prod pendant un retard du cache live** (`graph-service.ts:12-15`).
  Conséquence avec D4 : onboarding et édition indisponibles jusqu'à la synchronisation, Aujourd'hui
  intact. Garde-fou : l'état « réessayer » existant ; Partie 3 si Q2 le demande. À surveiller après
  la première livraison de lot de cache qui suit : si la fenêtre dépasse quelques heures, activer la
  Partie 3.
- **R3 — Un profil v1 change de sens à la première édition** (D6 : « Rock + Prog Rock » se
  restreint à Prog Rock). Garde-fou : migration paresseuse, Aujourd'hui lit les `genre_ids` v1
  jusqu'à l'enregistrement ; population = l'iPhone de Raphael.
- **R4 — Un profil v2 lu par un build antérieur.** Il ne voit que `profile.v1.json` (laissé en
  place), donc un profil figé mais valide. Si le v1 n'existe pas (profil créé en v2), il voit
  `.missing` et propose l'onboarding v1, qui écrirait un `profile.v1.json` que le build v2 ignorera.
  Accepté : cas de retour en arrière manuel sur l'appareil de Raphael.
- **R5 — Le catalogue grossit d'environ 30 Ko** (203 genres, 230 entrées de table). ETag et 304
  inchangés (`http.ts:36-43`) ; le client ne le relit qu'au changement de `revision`.
- **R6 — `genres_count` et le compte des réglages gonflent** : une famille seule donne jusqu'à
  39 `genre_ids` (house-techno). Garde-fou : les réglages affichent la sélection (2.6) ;
  `genres_count` garde sa définition (nombre de genres utilisés par la recommandation) et le
  changement de distribution est daté ici (2026-10-15) pour la lecture des tableaux Mixpanel.
- **R7 — Piège de décodage Swift** d'un dictionnaire à clés `NodeIdentity` (voir 1.1). Garde-fou :
  test nominal sur `legacySelectionBySlug` à 3 entrées.
- **R8 — Les identifiants d'accessibilité changent** (`genre-tile-<clé de famille>`,
  `subgenre-row-<id de taxonomie>`). Garde-fou : `ProfileFlowTests` mis à jour en 2.6 ; aucun autre
  consommateur (vérifié : seuls `GenreTile`, `SubgenreRow` et les tests UI).
- **R9 — Budget tier/3** : 1.2 et 2.3 doivent tenir en 200 lignes. Si 2.3 dépasse, sortir
  l'adaptation mécanique des 8 tests existants dans une PR tier/1 préalable (renommage des fichiers
  via une constante), pas l'inverse.

## Critères de sortie

- Sur le cache committé servi en `editorial`, l'écran 1.2 montre 20 tuiles (une par famille, Rock
  comprise), les écrans 1.3 totalisent 203 lignes, aucun genre n'apparaît sous deux tuiles, les
  noms sont les noms éditoriaux et chaque ligne a une description.
- Un profil enregistré par ce flux est un `profile.v2.json` avec `selection` et des `genre_ids`
  dérivés selon D3 ; Aujourd'hui recommande à partir de ces `genre_ids` sans changement dans
  `Affinity`.
- Un `profile.v1.json` existant est relu, édité (sélection reconstruite par D6) et réenregistré en
  v2 en gardant `local_id`.
- Catalogue `degraded` : décodé sans erreur, onboarding et édition en état indisponible, Aujourd'hui
  fonctionnel.
- `npm run check` vert ; `swift test` vert avec un nombre de tests ≥ celui d'avant ce projet ;
  `ios-check` vert ; `docs/track1-api.md` décrit les deux modes ; D13 et R8 du plan Figma renvoient
  ici.
- Aucun fichier de `web/`, `cache/`, `data/`, `src/genre-taxonomy*.ts`, `mobile/` modifié.

## Questions produit à arbitrer (gate)

**Arbitrage du 2026-10-15 : Raphael a validé le plan avec les six recommandations ci-dessous.** Q2 retient
(a) : la Partie 3 n'est pas créée dans Linear, elle le sera si une fenêtre de dégradation est observée
en prod (R2).

- **Q1 — Sémantique de la sélection (D3).** Famille sans sous-genre coché = toute la famille ;
  cocher des sous-genres restreint la recommandation à ceux-là. Recommandation : oui. Alternative :
  famille toujours entière, sous-genres en bonus — demande une pondération dans `Affinity`, hors scope.
- **Q2 — Repli quand le serveur dégrade la taxonomie (D4).** (a) état « indisponible, réessayer »
  existant, Aujourd'hui intact ; (b) instantané embarqué dans l'app (Partie 3, +5 pts, procédure de
  régénération) ; (c) garder l'arbre dérivé des arêtes. Recommandation : (a) maintenant, (b) dès
  qu'une fenêtre de dégradation est observée en prod ; jamais (c).
- **Q3 — Ordre des lignes (D5).** Ordre servi par la projection (identique au web) plutôt que tri
  alphabétique `fr` sur l'appareil. Recommandation : ordre servi.
- **Q4 — Migration v1 (D6).** Reconstruire paresseusement à la première édition, en acceptant que
  « parent + sous-genre » v1 devienne « famille + sous-genre explicite » (restriction). Alternative :
  effacer les profils v1 et refaire l'onboarding. Recommandation : migration paresseuse.
- **Q5 — Slug propre des familles rock / jazz / avant-garde.** Ne pas l'ajouter aux `genre_ids`
  (règle uniforme). Alternative : l'ajouter quand il existe, pour le voisinage `subgenres` du nœud.
  Recommandation : ne pas l'ajouter.
- **Q6 — Réglages et analytics.** Réglages : « N familles · M sous-genres » ; `genres_count`
  inchangé (nombre de `genre_ids`). Recommandation : oui aux deux.
