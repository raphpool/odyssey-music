# Onglet Genres iOS : affichage immédiat, sans chargement

Plan de la phase `plan` du process de livraison, écrit le 2026-11-25 sur le brief de Raphael (app iOS
Track1) : « Le chargement quand j'arrive dans la tab "genre" est trop long : ça devrait s'afficher
directement, sans AUCUN chargement. » **Non validé** : aucun ticket n'est créé avant le gate humain.

Tous les chemins sont relatifs à la racine du dépôt ; les numéros de ligne sont ceux de `main` au
2026-11-25 (`0eae87e`). La page web `web/index.html` n'a pas d'onglets : le brief désigne l'app iOS.

## Problème

1. **L'onglet télécharge le catalogue entier à chaque lancement, au premier affichage.**
   `GenresTabView` garde son catalogue dans un `@State` initialisé à `.loading`
   (`ios/Track1/Features/Genres/GenresTabView.swift:82-86, 102`) et lance `loadTaxonomy()` depuis
   `.task(id: LoadKey(attempt, hasProfile))` (l.135). `loadTaxonomy` (l.275-298) appelle `loadCatalog`
   (l.98), c'est-à-dire `readers.catalog` (`RootView.swift:227`) = `APIClient.catalog()`
   (`ios/Track1Core/Sources/Track1Core/API/APIClient.swift:18-25`) : un `GET /mobile/v1/catalog` complet,
   avec `cachePolicy = .reloadIgnoringLocalCacheData` (l.90) et un timeout de 15 s (l.91). Pendant ce temps
   l'onglet dessine un `ProgressView` (l.183). Le catalogue mobile porte **tous** les nœuds matérialisés
   (1 600 dans `cache/nodes/`), toutes les arêtes et la taxonomie (`src/mobile/catalog.ts:89-114`) ;
   `TodayViewModel.swift:110` documente déjà que « la lecture du catalogue peut prendre des secondes ».
   Rien n'est conservé sur disque entre deux lancements : le coût est payé à **chaque** lancement.
2. **L'onglet n'a besoin que d'une fraction du catalogue.** `EditorialGenreTaxonomy.init?(catalog:)`
   (`ios/Track1Core/Sources/Track1Core/Features/Onboarding/EditorialGenreTaxonomy.swift:48-81`) ne lit
   que `catalog.taxonomy` et les nœuds `type == .genre` (identité, `teaser`). Les identifiants passés à
   `profileStore.commit(_:availableGenreIDs:)` (`GenresTabView.swift:291`, `ProfileStore.swift:157-164`)
   sont ces mêmes nœuds genre. Ni les arêtes, ni les 1 300 autres nœuds ne servent. La taxonomie source
   fait 80 Ko (`data/genre-taxonomy.json` : 20 familles, 546 genres) et le cache compte 316 nœuds genre.
3. **Le même catalogue vient d'être téléchargé par l'onboarding.** `FirstLaunchOnboardingView.load()`
   (`ios/Track1/Features/Onboarding/OnboardingFlowView.swift:296-318`) lit `loadCatalog()` puis construit
   la même `EditorialGenreTaxonomy` et les mêmes `genreIDs` (l.317). Quand les onglets apparaissent, le
   premier passage sur Genres recommence tout.
4. **La révalidation conditionnelle existe et n'est pas branchée.** `APIClient.catalog(etag:hasCachedRepresentation:)`
   envoie `If-None-Match` et rend `.notModified(etag:)` sur 304 (l.18-25, 102-104) ; le serveur pose
   `ETag` et répond 304 (`src/mobile/http.ts:37-40`). `ContentReaders.live` n'en passe aucun
   (`ContentReaders.swift:31`) et aucun lecteur ne conserve d'ETag.

## Non-buts

- **Today, les rappels et la recherche ne changent pas.** `TodayViewModel` continue de lire le catalogue
  complet quand il n'a pas de recommandation du jour sur disque ; `ReminderSync.scheduleStoredPlan` aussi
  (`RootView.swift:329`). Leur faire profiter de l'ETag/304 est un brief séparé (voir Q5).
- **Pas de cache du catalogue complet sur disque, pas de `URLCache`.** Le fichier serait de l'ordre du
  mégaoctet, décodé à chaque lecture, pour trois consommateurs aux besoins différents.
- **Pas de taxonomie embarquée dans le bundle de l'app** (copie de `data/genre-taxonomy.json`) : voir D5.
- **Le serveur et le contrat `GET /mobile/v1/catalog` ne changent pas** (`docs/track1-api.md`).
- **La mise en page de l'onglet** (`GenresTabMetrics`, `GenreSelectionList`, barre « Sauvegarder ») et
  le flux d'enregistrement (`save()`, l.304-328) ne changent pas.
- **L'onboarding** (`OnboardingFlowView.swift`) ne change pas : il reçoit la même fermeture `loadCatalog`,
  simplement enveloppée par l'appelant (D2).
- Aucun nouveau fichier dans la cible app (`Track1`), donc aucune édition de `project.pbxproj` : tout le
  code nouveau vit dans le package `Track1Core` (SwiftPM, sans liste de fichiers à maintenir).

## Décisions d'archi

### D1 — La source d'affichage de l'onglet est un snapshot disque du sous-ensemble « genres » du catalogue

Un fichier `genre-catalog.v1.json` dans le `LocalStore` de l'app (même dossier que `profile.v3.json` et
`daily-recommendation.v1.json`) garde le dernier catalogue utilisable, réduit à ce que l'onglet consomme :
`version`, `revision`, `taxonomy` (bloc éditorial complet), les nœuds `type == .genre` dans l'ordre servi
(identité, type, nom, `teaser`), `edges` vide ; plus l'`ETag` de la réponse qui l'a produit. Ordre de
grandeur : une centaine de kilo-octets, décodés en quelques millisecondes.

À l'apparition de l'onglet, le snapshot est lu et l'éditeur est dessiné **sans requête réseau**. Le
réseau n'intervient qu'en arrière-plan (D3) ou quand il n'y a pas de snapshot (D4).

*Alternatives rejetées :* (a) précharger le catalogue **en mémoire** au lancement et le partager avec
l'onglet : ne survit pas au relancement, dépend du réseau à chaque lancement (hors ligne, réseau lent → le
spinner revient) ; ne tient pas « AUCUN chargement ». (b) `URLCache` via `cachePolicy` : le serveur sert
`max-age=60`, donc rien ne survit d'un lancement à l'autre, et le 304 demanderait de toute façon du code.
(c) Un cache du catalogue complet partagé avec Today : hors brief, fichier lourd décodé à chaque lecture.

### D2 — Un seul acteur Core écrit et lit le snapshot : `GenreCatalogStore`, nourri par tout chargement réussi

Nouveau type dans `ios/Track1Core/Sources/Track1Core/Features/Genres/GenreCatalogStore.swift`, sur le motif
de `DailyRecommendationStore` (`ios/Track1Core/Sources/Track1Core/Recommendation/DailyRecommendationStore.swift:9-23,
83-110`) : `LocalStore` injecté, lecteur réseau injecté, `resetBeforeUse`.

    public struct GenreCatalogSnapshot: Codable, Equatable, Sendable {
        public let etag: String?
        /// Genre nodes only, no edges, taxonomy `.editorial`; `EditorialGenreTaxonomy(catalog:)` is never nil on it.
        public let catalog: Catalog
        public var taxonomy: EditorialGenreTaxonomy? { get }
        public var genreIDs: [NodeIdentity] { get }
    }
    public enum GenreCatalogSource: Equatable, Sendable { case disk, network }
    public enum GenreCatalogLoad: Sendable { case ready(GenreCatalogSnapshot, source: GenreCatalogSource); case unavailable }
    public enum GenreCatalogRefresh: Equatable, Sendable { case updated, unchanged, failed }

    public actor GenreCatalogStore {
        public init(localStore: LocalStore,
                    readCatalog: @escaping @Sendable (_ etag: String?) async -> APIResult<Catalog>,
                    resetBeforeUse: Bool = false)
        /// What the tab opens on: the snapshot on disk when there is one (no network), else one network read.
        /// Two concurrent calls share one network read.
        public func load() async -> GenreCatalogLoad
        /// `readCatalog(storedETag)`. A 200 with a new `revision` replaces the snapshot (`.updated`); a 304 or
        /// a 200 with the stored `revision` leaves the file untouched (`.unchanged`); a failure or a catalog
        /// without an editorial taxonomy changes nothing (`.failed`).
        public func refresh() async -> GenreCatalogRefresh
        /// Persists the genre subset of a catalog the caller already read; nothing for a degraded catalog.
        public func remember(_ catalog: Catalog, etag: String?) async
        /// `read`, with every `.success` remembered before it is returned.
        public nonisolated func remembering(_ read: @escaping @Sendable () async -> APIResult<Catalog>)
            -> @Sendable () async -> APIResult<Catalog>
    }

Le lecteur réseau est câblé dans `AppContainer` (comme `imageStore`, `AppContainer.swift:84`) : en
production `{ etag in await client.catalog(etag: etag, hasCachedRepresentation: etag != nil) }` ; sous
simulateur avec fixtures (`UITestFixtureReaders.make` non nil) le lecteur ignore l'etag et rend la fixture
(`onboardingCatalog ?? contentReaders.catalog`). `ContentReaders` ne change pas : le store n'est pas un
écran, et `ContentReaders` n'a que deux constructeurs (`ContentReaders.swift:29`, `UITestFixtureReaders.swift:46`)
qu'il est inutile de toucher.

L'onboarding alimente le store sans le connaître : `RootView.swift:101` passe
`genreCatalog.remembering(onboardingCatalog ?? readers?.catalog)` à la place de la fermeture nue. Le
snapshot existe donc dès que les onglets apparaissent après un premier lancement.

*Alternatives rejetées :* (a) faire de l'onboarding un consommateur de `GenreCatalogStore.load()` : modifie
`FirstLaunchOnboardingView` et ses tests pour rien de plus. (b) Ajouter un lecteur avec ETag à
`ContentReaders` : élargit la surface réseau des écrans pour un seul consommateur qui n'est pas un écran.

### D3 — Le rafraîchissement est en arrière-plan, et ce qu'il rapporte s'applique au lancement suivant

Quand `load()` a servi le disque, l'onglet lance `refresh()` dans une `Task` non structurée (même raison
que `ReminderSync.last`, `AppContainer.swift:115-118` : un changement d'onglet annule la `.task` de la vue
et ne doit pas interrompre l'écriture). Le résultat n'est **pas** appliqué à l'éditeur ouvert : la liste
des cartes ne change pas sous les doigts, les coches en cours restent, et `canSave` continue de comparer
la sélection au profil enregistré. Le prochain `load()` (prochain lancement) lit le fichier mis à jour. Un
seul `refresh()` par lancement : au-delà, `loadTaxonomy` sort sur `.ready` comme aujourd'hui (l.277).

Au lancement, quand un profil existe, `ApplicationTabs` appelle `load()` dans une `Task` non structurée
juste après `reloadProfile()` (`RootView.swift:115-118`) : sans snapshot (mise à jour depuis le build
TestFlight actuel, fichier perdu), la lecture réseau part avant que la personne touche l'onglet, et
`load()` partage cette lecture avec l'onglet s'il arrive pendant qu'elle est en vol.

*Alternatives rejetées :* (a) appliquer la taxonomie rafraîchie à l'éditeur ouvert — reconstruire
`GenreSelectionModel` en préservant les coches, pour un gain invisible (taxonomie éditoriale, changements
rares et additifs). (b) Rafraîchir uniquement au lancement et jamais depuis l'onglet — la personne qui
n'ouvre l'app que pour Genres aurait un snapshot qui ne vieillit qu'au lancement suivant ; équivalent en
pratique, mais le cas « pas de snapshot » doit de toute façon être géré par l'onglet, donc une seule
logique (`load()`) y suffit.

### D4 — Sans snapshot, le chemin actuel reste : une lecture réseau, spinner, puis prêt ou « indisponible »

`load()` sans fichier lisible lit le réseau une fois : catalogue éditorial → snapshot écrit et
`.ready(…, source: .network)` (le snapshot est aussi rendu si l'écriture échoue : le prochain lancement
relira) ; échec ou catalogue dégradé → `.unavailable`, l'onglet garde `ProgressView` puis
« Genres indisponibles pour le moment » + `genres-retry` (`attempt += 1` relance `load()`). Un fichier
illisible, d'une autre version, ou dont la taxonomie n'est pas éditoriale, vaut « pas de snapshot »
(donnée disque non fiable, même règle que `DailyRecommendationStore`).

Conséquence assumée : **avec** un snapshot, un catalogue serveur devenu dégradé ne rend plus l'onglet
indisponible ; la personne édite sur la dernière taxonomie connue et `commit(availableGenreIDs:)` réconcilie
contre les genres du snapshot (tout est local). C'est l'inverse de la décision D4 de TRA-519 (plan
[`ios-onboarding-taxonomy.md`](ios-onboarding-taxonomy.md)), prise quand rien n'était conservé ; le test UI
`testADegradedCatalogKeepsTodayAndMakesTheGenresTabUnavailable` (`ProfileFlowTests.swift:817-826`) est
réécrit en conséquence (arbitrage Q3).

### D5 — Les modèles du catalogue deviennent `Encodable` ; le fichier a la forme exacte de l'API

`Catalog`, `CatalogTaxonomy`, `EditorialTaxonomy`, `EditorialTaxonomyFamily`, `EditorialTaxonomyGenre`,
`CatalogNode`, `CatalogEdge` (`ios/Track1Core/Sources/Track1Core/API/APIModels.swift:49-178`) gagnent
`encode(to:)` sur les mêmes `APIKeys` (l.3-10) : `mode` + champs éditoriaux dans un seul conteneur,
`legacySelectionBySlug` encodé en objet `[String: [String]]` clé par `rawValue` (miroir du décodeur l.103-108),
`teaser` toujours présent et `null` quand absent (le décodeur exige la clé, `decodeRequiredNullable`
l.546-554), `slug` de famille omis quand nil (`decodeIfPresent` l.135). `Catalog`, `CatalogNode` et
`CatalogEdge` gagnent `Equatable` (synthétisé). Le snapshot est donc **relu par les décodeurs validants
existants** : un fichier altéré est rejeté exactement comme une réponse serveur invalide, et la propriété
`decode(encode(c)) == c` se teste directement. Le `revision` conservé est celui du catalogue complet dont
le snapshot dérive (le motif `^sha256:[a-f0-9]{64}$` de l.63 reste vrai).

*Alternatives rejetées :* (a) un DTO disque séparé et sa conversion vers `Catalog` : une seconde forme à
maintenir, et construire `Catalog` sans passer par `init(from:)` contourne la validation. (b) Garder les
octets bruts de la réponse : `APIClient.request` décode avant de rendre ; il faudrait un second chemin
réseau et le fichier garderait les 1 600 nœuds et les arêtes. (c) Embarquer `data/genre-taxonomy.json`
dans le bundle : `EditorialGenreTaxonomy` ne montre un genre que si le catalogue en a matérialisé un slug
(l.36-38, 58-59) ; sans les nœuds on afficherait des genres qui ne mènent nulle part, et il faudrait une
étape de build + `project.pbxproj` pour une seconde source de vérité qui dérive du serveur.

### D6 — Isolation des tests UI : le snapshot tombe avec `-track1-reset-profile`, et seul avec `-track1-reset-genre-catalog`

Le dossier `LocalStore` du simulateur survit d'un test UI à l'autre. `UITestFlows.launch` passe
`-track1-reset-profile` (`UITestFlows.swift:78`) : `AppContainer` donne `resetBeforeUse: resetProfile` au
store, comme à `RecentNodesStore` (`AppContainer.swift:68-70`, même raison : sans reset un parcours verrait
la taxonomie du précédent). `relaunch` (l.88-96) ne passe aucun reset : le snapshot du premier lancement
est bien là, c'est ce qu'on veut prouver. Un argument dédié `-track1-reset-genre-catalog` permet le cas
« profil présent, aucun snapshot » (D4) sans effacer le profil. Le snapshot n'est pas une donnée personnelle
(sous-ensemble public du catalogue) : `ProfileStore.clear()` ne le supprime pas (arbitrage Q4).

## Découpage

Deux tâches, une partie par tâche, séquentielles (2 bloquée par 1). Points = estimate Linear.

| # | Tâche | Tier | Pts | Dépend de |
|---|---|---|---|---|
| 1.1 | TRA-? · Core · `Encodable` sur les modèles du catalogue + `GenreCatalogStore` (snapshot, `load`, `refresh`, `remember`) + tests Core | tier/2 | 3 | — |
| 2.1 | TRA-? · App · Brancher le store dans `AppContainer`, `RootView`, `GenresTabView` ; préchauffage au lancement ; tests UI | tier/2 | 2 | 1.1 |

Chaque PR laisse `swift test --package-path ios/Track1Core`, `ios-check` et `npm run check` verts.

### Partie 1 — Persistance (déployable seule : aucun comportement visible ne change, le code est prêt à brancher)

- [ ] TRA-? 1.1 — `APIModels.swift` : `Encodable` sur les sept types du catalogue, `Equatable` sur `Catalog`,
  `CatalogNode`, `CatalogEdge` ; nouveau `GenreCatalogStore.swift` (snapshot réduit aux genres, `load` avec
  partage des lectures concurrentes, `refresh` conditionnel par ETag/`revision`, `remember`, `remembering`,
  `resetBeforeUse`) ; tests `API/CatalogEncodingTests.swift` et `Genres/GenreCatalogStoreTests.swift`.

### Partie 2 — Branchement (déployable seule : l'onglet s'affiche depuis le disque)

- [ ] TRA-? 2.1 — `AppContainer` construit `genreCatalog` (lecteur prod avec ETag, lecteur fixture sous
  simulateur, resets) ; `RootView` l'injecte à l'onglet, enveloppe le `loadCatalog` de l'onboarding avec
  `remembering`, préchauffe au lancement ; `GenresTabView` remplace `loadCatalog` par `genreCatalog`,
  lit `load()` et lance `refresh()` en arrière-plan ; tests UI : preuve « servi depuis le disque » (catalogue
  réseau dégradé à la relance, cartes présentes), cas « sans snapshot » toujours indisponible.

## Risques

- **Un encodage légèrement faux dégrade silencieusement la taxonomie.** `CatalogTaxonomy.init(from:)` replie
  toute violation du contrat éditorial en `.degraded(available: false)` (l.82-85) : un `encode` qui oublierait
  `version: 2` ou mal nommerait une clé produirait un snapshot qui *décode* mais rend l'onglet
  « indisponible » à chaque lancement. Garde-fous : le test aller-retour exige `.editorial` égal à l'entrée
  (pas seulement un décodage réussi) sur une taxonomie avec familles à `slug`, genres multi-slugs et table
  `legacySelectionBySlug` non vide ; et `load()` traite un snapshot sans taxonomie éditoriale comme absent
  (retour au réseau), jamais comme « indisponible ».
- **Taxonomie en retard d'un lancement.** La personne peut cocher un genre que le serveur a depuis renommé ou
  retiré ; `commit` réconcilie contre le snapshot (local), Today lit le catalogue vivant et ignore un
  identifiant inconnu. Les changements de `data/genre-taxonomy.json` sont rares et additifs ; `refresh()`
  rattrape au lancement suivant. Pas de garde-fou supplémentaire.
- **Mise à jour depuis le build actuel : aucun snapshot sur l'appareil.** Le préchauffage au lancement (D3)
  part dès que le profil est lu ; si Raphael ouvre Genres dans les premières secondes après la mise à jour,
  il voit le spinner **une fois**. Critère de sortie formulé en conséquence ; après cette ouverture, plus
  jamais.
- **Écriture disque impossible** (quota, protection de fichier) : `load()` rend quand même le catalogue lu
  en mémoire, rien n'est écrit, le lancement suivant relit le réseau. `LocalStore.write` est atomique : un
  arrêt pendant l'écriture laisse l'ancien fichier intact.
- **Entrelacement dans l'acteur** (`load` qui lit pendant qu'un `refresh` écrit) : au pire l'onglet montre
  l'ancien snapshot et le nouveau sert au lancement suivant ; les deux lectures réseau d'un même lancement
  rendent le même catalogue. Pas de verrou ; `load()` partage toutefois sa lecture réseau en vol pour que
  préchauffage + onglet ne lancent pas deux `GET` d'un mégaoctet.
- **Tests UI dépendants de l'ordre** : sans D6, le snapshot d'un test (`taxonomyCatalog`) serait servi au
  suivant (`catalogJSON` de `UITestFlows`, autres familles). Le reset avec `-track1-reset-profile` couvre
  tous les `launch` ; les sept `relaunch` existants (`ProfileFlowTests.swift:90, 176, 195, 222, 267, 278, 820`,
  `TodayFlowTests.swift:62`) relancent avec le même catalogue que leur premier lancement, sauf l.820 (réécrit
  par 2.1) et l.222 (catalogue différent mais même taxonomie, et c'est l'onboarding qui recharge).
- **Swift 6 et isolation** : les erreurs « sending value of non-Sendable type » entre cibles n'apparaissent
  que dans `ios-check` (`docs/track1-builds.md:159-160`). `GenreCatalogStore` est un `actor`, ses fermetures
  sont `@Sendable`, `Catalog` est `Sendable` : prévu pour passer, mais la preuve est la CI. `ios-check`
  ignore les PR en brouillon et n'est pas un check requis (`.github/workflows/ios-ci.yml:55`,
  `docs/track1-builds.md:37`) : passer la PR en « ready » et attendre son vert.

## Critères de sortie

- Sur un iPhone avec profil, après au moins une ouverture de l'app depuis la mise à jour : toucher l'onglet
  Genres dessine les cartes **sans** `ProgressView`, au premier passage de chaque lancement, y compris en
  mode avion.
- Preuve en CI : à la relance avec un catalogue réseau dégradé, l'onglet montre `genre-card-family-0` et
  pas `genres-retry` (le disque est la seule source possible) ; avec `-track1-reset-genre-catalog` en plus,
  il montre `genres-retry` (le chemin « sans snapshot » est intact).
- `swift test --package-path ios/Track1Core` vert avec les tests d'aller-retour et du store ; `ios-check`
  vert sans modification des assertions de `NavigationTests`, `TodayFlowTests` et des autres tests de
  `ProfileFlowTests` ; `npm run check` vert.
- Vérification de Raphael sur son iPhone après la release TestFlight : mise à jour → ouvrir l'app, attendre
  Today → Genres (une seule fois toléré avec spinner) ; tuer l'app → relancer → Genres : immédiat ; mode
  avion → relancer → Genres : immédiat, cocher un genre, Sauvegarder fonctionne.

## Questions ouvertes pour le gate

- **Q1 — Une ou deux PR ?** Le brief dit « a priori un seul ticket » ; le plan en propose deux (Core puis
  app) pour rester sous ~300 lignes de diff par PR et séparer « nouveau type persistant » de « branchement
  UI ». Recommandation : deux. Fusionner en un ticket de 5 points est possible si Raphael préfère.
- **Q2 — Fraîcheur (D3).** Un catalogue rafraîchi s'applique au lancement suivant, jamais à l'éditeur ouvert.
  OK ?
- **Q3 — Catalogue dégradé après coup (D4).** Avec un snapshot, l'onglet reste éditable sur la dernière
  taxonomie connue au lieu de devenir « indisponible » (changement de la décision D4 du plan `ios-onboarding-taxonomy.md`, TRA-519, et réécriture de son test UI).
  OK ?
- **Q4 — « Effacer mon profil » (D6).** Le snapshot survit à l'effacement du profil (donnée publique) ; le
  nouvel onboarding le réécrit. OK ?
- **Q5 — Today.** Hors brief ici. Un ticket séparé « Today et les rappels relisent le catalogue avec
  `If-None-Match` » éviterait le même téléchargement d'un mégaoctet quand la recommandation du jour n'est
  pas sur disque. À ouvrir ?
- **Q6 — Tiers.** tier/2 pour 1.1 et 2.1 (logique locale, fichier dérivé régénérable, aucun chemin
  `sensitivePath`). OK ?

## Tickets (brouillons, format `ticket-template.md`)

### 1.1 — Ajouter un snapshot disque du catalogue des genres : modèles `Encodable` et `GenreCatalogStore`

- Tier : **tier/2** · Estimate : **3** · Partie 1 · Labels : `tier/2`

```markdown
## Contexte
L'onglet Genres de l'app iOS télécharge le catalogue mobile entier (1 600 nœuds, arêtes, taxonomie) à chaque
lancement et montre un spinner pendant des secondes, alors qu'il n'a besoin que de la taxonomie éditoriale et
des ~316 nœuds `genre`. Cette tâche crée ce qui manque côté Core pour servir l'onglet depuis le disque : les
modèles du catalogue deviennent `Encodable`, et un acteur `GenreCatalogStore` garde un snapshot réduit aux
genres, le relit sans réseau, et le révalide par ETag. Rien n'est branché dans l'app ici (tâche 2.1).
Plan : docs/plans/genre-tab-instant.md#partie-1 (D1, D2, D3, D4, D5).

## Portée
Fichiers à modifier :
- `ios/Track1Core/Sources/Track1Core/API/APIModels.swift` — l.49-66 `Catalog` : `Encodable`, `Equatable`,
  `encode(to:)` sur `APIKeys` (version, revision, taxonomy, nodes, edges) ; l.72-90 `CatalogTaxonomy` :
  `encode(to:)` écrit `mode` puis, pour `.editorial`, délègue au bloc éditorial dans le **même** conteneur ;
  l.92-122 `EditorialTaxonomy` : encodage de `version` (2), `families`, `genres`, `legacySelectionBySlug`
  en `[String: [String]]` clé par `rawValue` ; l.124-140 `EditorialTaxonomyFamily` : key, label, order,
  `slug` via `encodeIfPresent` ; l.142-158 `EditorialTaxonomyGenre` : id, name, family, slugs ; l.160-173
  `CatalogNode` : `Equatable`, identity, type, name, `teaser` toujours présent (`encodeNil` quand nil) ;
  l.174-178 `CatalogEdge` : `Codable` + `Equatable` synthétisés.
Fichiers à créer :
- `ios/Track1Core/Sources/Track1Core/Features/Genres/GenreCatalogStore.swift` — `GenreCatalogSnapshot`,
  `GenreCatalogSource`, `GenreCatalogLoad`, `GenreCatalogRefresh`, `actor GenreCatalogStore`, un wrapper
  disque privé `{ version: 1, etag, catalog }`, fichier `genre-catalog.v1.json`.
- `ios/Track1Core/Tests/Track1CoreTests/API/CatalogEncodingTests.swift`
- `ios/Track1Core/Tests/Track1CoreTests/Genres/GenreCatalogStoreTests.swift`
Hors-scope explicite :
- `APIClient.swift`, `ContentReaders.swift`, `AppContainer.swift`, `RootView.swift`, `GenresTabView.swift`,
  `OnboardingFlowView.swift` : rien ne change dans l'app ; c'est la tâche 2.1.
- Les décodeurs existants (`init(from:)`) et leur tolérance (`CatalogTaxonomy` qui dégrade) : ne pas les
  modifier ; seul `Encodable` s'ajoute.
- `project.pbxproj` : aucun fichier de la cible app n'est créé (package SwiftPM uniquement).

## Contrat
    public struct GenreCatalogSnapshot: Codable, Equatable, Sendable {
        public let etag: String?
        /// Same version, revision and taxonomy as the catalog it derives from; only its `type == .genre` nodes,
        /// in served order; no edges. `EditorialGenreTaxonomy(catalog:)` is never nil on a stored snapshot.
        public let catalog: Catalog
        public var taxonomy: EditorialGenreTaxonomy? { get }    // EditorialGenreTaxonomy(catalog: catalog)
        public var genreIDs: [NodeIdentity] { get }             // catalog.nodes.filter(.genre).map(\.identity)
    }
    public enum GenreCatalogSource: Equatable, Sendable { case disk, network }
    public enum GenreCatalogLoad: Sendable { case ready(GenreCatalogSnapshot, source: GenreCatalogSource); case unavailable }
    public enum GenreCatalogRefresh: Equatable, Sendable { case updated, unchanged, failed }

    public actor GenreCatalogStore {
        public init(localStore: LocalStore,
                    readCatalog: @escaping @Sendable (_ etag: String?) async -> APIResult<Catalog>,
                    resetBeforeUse: Bool = false)
        public func load() async -> GenreCatalogLoad
        public func refresh() async -> GenreCatalogRefresh
        public func remember(_ catalog: Catalog, etag: String?) async
        public nonisolated func remembering(_ read: @escaping @Sendable () async -> APIResult<Catalog>)
            -> @Sendable () async -> APIResult<Catalog>
    }
Règles :
- `load()` : fichier lisible, version 1, catalogue qui décode et dont `EditorialGenreTaxonomy(catalog:)` est
  non nil → `.ready(snapshot, source: .disk)` sans appeler `readCatalog`. Sinon `readCatalog(nil)` :
  `.success` avec taxonomie éditoriale → snapshot écrit (écriture échouée tolérée) et `.ready(…, .network)` ;
  `.success` dégradé, `.notModified`, `.failure` → `.unavailable`, rien n'est écrit. Deux `load()` concurrents
  sans snapshot ne font qu'un `readCatalog`.
- `refresh()` : `readCatalog(storedETag)` (nil sans snapshot). `.success` avec taxonomie éditoriale et
  `revision` différente de celle stockée (ou pas de snapshot) → fichier remplacé, `.updated` ; `.notModified`
  ou `.success` de même `revision` → fichier intact (octets identiques), `.unchanged` ; `.failure` ou
  `.success` sans taxonomie éditoriale → fichier intact, `.failed`.
- `remember(_:etag:)` : écrit le sous-ensemble genres si `EditorialGenreTaxonomy(catalog:)` est non nil,
  sinon ne touche à rien (un snapshot existant reste).
- `remembering(read)` : rend une fermeture qui appelle `read`, attend `remember` sur `.success(c, etag)`,
  puis rend le résultat tel quel (y compris `.failure` et `.notModified`).
- `resetBeforeUse` : supprime le fichier au premier appel de n'importe quelle méthode (motif
  `DailyRecommendationStore.resetIfNeeded`, l.105-109).
- Encodage disque avec `JSONEncoder.outputFormatting = [.sortedKeys]` (octets déterministes).

## Critères d'acceptation
- [ ] Aller-retour : pour `catalogJSON` d'`APIClientTests.swift:393` et pour une fixture `EditorialFixture.catalog`
      avec une famille à `slug`, un genre à deux slugs, un `teaser` non nul et un nul, et `legacy` non vide,
      `decode(Catalog, encode(c)) == c` et `taxonomy` reste `.editorial` (pas `.degraded`).
- [ ] Aller-retour d'un catalogue `taxonomy: {mode: degraded, available: true}` → `.degraded(available: true)`.
- [ ] Le JSON encodé lu par `JSONSerialization` porte `teaser: null` pour un nœud sans teaser, pas de clé `slug`
      pour une famille sans slug, `legacySelectionBySlug` comme objet clé par slug, `taxonomy.mode` et
      `taxonomy.version == 2` au même niveau que `families`.
- [ ] `load()` sur un dossier vide appelle `readCatalog` une fois avec `nil`, écrit `genre-catalog.v1.json`,
      rend `.ready(source: .network)` ; le snapshot ne contient que les nœuds `type == .genre` dans l'ordre
      servi, `edges` vide, `revision` et `taxonomy` identiques à l'entrée.
- [ ] `load()` avec ce fichier présent rend `.ready(source: .disk)` égal au précédent **sans** appeler
      `readCatalog` (compteur à 0).
- [ ] `load()` : fichier corrompu (`"{"`), `version: 2`, ou catalogue stocké à taxonomie dégradée → traité
      comme absent : `readCatalog(nil)` est appelé.
- [ ] `load()` sans snapshot : `.failure(.network)` → `.unavailable` et aucun fichier ; catalogue dégradé →
      `.unavailable` et aucun fichier.
- [ ] Deux `load()` lancés pendant qu'un `readCatalog` est retenu (continuation) → un seul appel, deux
      `.ready(source: .network)`.
- [ ] `refresh()` avec snapshot d'etag `"e1"` : `readCatalog` reçoit `"e1"` ; `.notModified(etag: "e1")` →
      `.unchanged`, octets du fichier inchangés ; `.success` de même `revision` → `.unchanged`, octets
      inchangés ; `.success` d'une autre `revision` avec etag `"e2"` → `.updated`, `load()` rend la nouvelle
      avec `etag == "e2"` ; `.failure(.timeout)` et `.success` dégradé → `.failed`, octets inchangés.
- [ ] `refresh()` sans snapshot : `readCatalog` reçoit `nil` ; `.success` éditorial → `.updated` et fichier
      écrit.
- [ ] `remember` d'un catalogue dégradé après un snapshot valide : `load()` rend toujours l'ancien snapshot.
- [ ] `remembering(read)` : `read` qui rend `.success` → le résultat est rendu et `load()` sert ensuite
      `.disk` sans réseau ; `read` qui rend `.failure(.network)` → rendu tel quel, aucun fichier.
- [ ] `LocalStore(failNextWriteNamed: "genre-catalog.v1.json")` : `load()` sans snapshot rend quand même
      `.ready(source: .network)` ; un second `load()` relit le réseau (rien n'a été écrit).
- [ ] `resetBeforeUse: true` avec un fichier présent : le premier `load()` lit le réseau.
- [ ] `swift test --package-path ios/Track1Core` vert.

## Tests attendus
- unitaire `API/CatalogEncodingTests.swift` : les trois aller-retours et la forme JSON ci-dessus.
- unitaire `Genres/GenreCatalogStoreTests.swift` : un `LocalStore(directoryURL:)` sur un dossier temporaire
  unique par test (motif `ProfileStoreTests.swift:133`), un lecteur-sonde qui compte ses appels, enregistre
  l'etag reçu et peut retenir sa réponse (motif `LinksProbe(…, hold: true)`, `NodeListeningTests.swift:12`) ;
  catalogues construits avec `EditorialFixture.catalog` (`EditorialGenreTaxonomyTests.swift:224-253`) ; pour
  « octets inchangés », lire le fichier avant/après par `localStore.read(named:)`.
- intégration : aucune (la frontière réseau est le lecteur injecté).

## Tier de risque
tier/2 — logique locale et fichier dérivé régénérable ; aucun chemin `sensitivePath`, pas de migration.

## Notes d'implémentation
- `CatalogTaxonomy.init(from:)` lit `mode` **et** les champs éditoriaux dans le même conteneur `APIKeys` :
  l'encodeur doit faire pareil (un seul `container(keyedBy: APIKeys.self)`, le bloc éditorial encodé par une
  fonction `fileprivate` d'`EditorialTaxonomy` qui reçoit `inout KeyedEncodingContainer<APIKeys>`). Une clé
  mal nommée ne ferait pas échouer le décodage : elle dégraderait la taxonomie en silence (l.82-85). C'est
  pour cela que les tests d'aller-retour comparent à `.editorial(t)`.
- `Catalog` n'a pas d'init membre : en ajouter un `internal` (`version:revision:taxonomy:nodes:edges:`),
  réservé à la réduction dans le store ; il ne revalide pas, donc il ne devient pas `public`.
- `JSONDecoder` et `JSONEncoder` ne sont pas `Sendable` : propriétés calculées (`ProfileStore.swift:67-72`).
- Le partage des `load()` concurrents : une `Task<GenreCatalogLoad, Never>?` gardée dans l'acteur pendant la
  lecture réseau, awaitée par les appels suivants, remise à nil à la fin.
- Nom de fichier : `^[a-z0-9.-]+$` imposé par `LocalStore.fileURL` (l.104-105) ; `genre-catalog.v1.json`.
- Commentaires en anglais ; un commentaire qui documente une décision cite le plan (D1-D5) ; convention
  « 2026-11-25 : l'onglet Genres relisait le catalogue entier à chaque lancement ».
- Seule exécution Swift autorisée en local : `swift test --package-path ios/Track1Core`
  (`docs/track1-builds.md:130-134`). `ios-check` tourne en CI sur PR « ready ».
- Commits conventionnels, `Refs TRA-?` ; PR titrée `TRA-? …`, `Fixes TRA-?`.
```

### 2.1 — Servir l'onglet Genres depuis le snapshot disque, rafraîchir en arrière-plan et préchauffer au lancement

- Tier : **tier/2** · Estimate : **2** · Partie 2 (blockedBy 1.1) · Labels : `tier/2`

```markdown
## Contexte
Avec TRA-? (1.1), Core sait garder un snapshot des genres sur disque et le relire sans réseau. Cette tâche
le branche : l'onglet Genres lit le snapshot à son apparition (plus de spinner quand il existe), révalide
en arrière-plan, l'onboarding alimente le snapshot, et le lancement le préchauffe pour les appareils qui
n'en ont pas encore (mise à jour). Plan : docs/plans/genre-tab-instant.md#partie-2 (D2, D3, D4, D6).

## Portée
Fichiers à modifier :
- `ios/Track1/App/AppContainer.swift` — nouvelle propriété `let genreCatalog: GenreCatalogStore?` ; sous
  `#if targetEnvironment(simulator)` (l.28-51) lire `-track1-reset-genre-catalog` ; dans
  `case .success(let configuration)` (l.73-92) construire le store avec `localStore`,
  `resetBeforeUse: resetProfile || resetGenreCatalog`, et le lecteur : si `UITestFixtureReaders.make(…)` a
  rendu des lecteurs, `{ _ in await (onboardingCatalog ?? contentReaders.catalog)() }` ; sinon
  `{ etag in await client.catalog(etag: etag, hasCachedRepresentation: etag != nil) }` ; `nil` dans
  `case .failure` (l.93-97).
- `ios/Track1/App/RootView.swift` — `ApplicationTabs` reçoit `genreCatalog` (appel l.23-34, propriétés
  l.49-59) ; l.101 : `loadCatalog: genreCatalog?.remembering(loader) ?? loader` avec
  `loader = onboardingCatalog ?? readers?.catalog` ; l.115-118 : après `reloadProfile()`, si
  `case .profile = profileState` et `genreCatalog` non nil, `Task { _ = await genreCatalog.load() }` ;
  l.227 : `genreCatalog: genreCatalog` remplace `loadCatalog:`.
- `ios/Track1/Features/Genres/GenresTabView.swift` — l.97-98 : `let genreCatalog: GenreCatalogStore?`
  remplace `loadCatalog` (commentaire mis à jour) ; l.275-298 `loadTaxonomy()` : garde `.ready` et garde
  profil inchangées ; `guard let genreCatalog else { catalog = .failed }` ; `switch await genreCatalog.load()`
  → `.ready(snapshot, source)` : `snapshot.taxonomy` nil → `.failed` (défensif), sinon
  `GenreSelectionModel(taxonomy:editing:)`, `savedGenres`, `.ready(LoadedCatalog(model:, genreIDs: snapshot.genreIDs))`,
  puis si `source == .disk` : `Task { _ = await genreCatalog.refresh() }` ; `.unavailable` → `.failed`.
  Le `case .failure, .notModified` (l.295) disparaît. `ProgressView` (l.183), `unavailable` et
  `genres-retry` (l.221-232) restent pour le chemin sans snapshot.
- `ios/Track1UITests/ProfileFlowTests.swift` — l.817-826 : réécrire
  `testADegradedCatalogKeepsTodayAndMakesTheGenresTabUnavailable` en
  `testADegradedCatalogAfterAFirstLaunchKeepsTheGenresTabOnItsLastTaxonomy` ; ajouter
  `testADegradedCatalogWithoutASnapshotMakesTheGenresTabUnavailable` juste après (voir Tests attendus).
Hors-scope explicite :
- `OnboardingFlowView.swift`, `ContentReaders.swift`, `APIClient.swift`, `UITestFixtureReaders.swift`,
  `TodayViewModel.swift`, `ReminderSync` : inchangés.
- La mise en page de l'onglet (`GenresTabMetrics`), `save()`, `canSave`, la sheet de réglages.
- `ProfileStore.clear()` ne supprime pas le snapshot (plan D6, arbitrage Q4).
- Aucun nouveau fichier (le `project.pbxproj` liste les fichiers à la main).
- Les assertions des autres tests UI (`NavigationTests.swift:33-34, 46`, `TodayFlowTests.swift:144`, le reste
  de `ProfileFlowTests`) : elles doivent rester vertes sans modification.

## Contrat
`GenresTabView` :
    /// nil when the app has neither a catalog fixture nor an API client: the tab then reads as unavailable.
    let genreCatalog: GenreCatalogStore?
    // loadTaxonomy(): one `load()` per tab lifetime until `.ready`; `.disk` starts one background `refresh()`
    // whose result is never applied to the open editor (plan D3); `.unavailable` → `.failed`.
`ApplicationTabs` (RootView) :
    let genreCatalog: GenreCatalogStore?
    // .task: reloadProfile(); warm-up `Task { _ = await genreCatalog?.load() }` when a profile was read;
    // presentReminderPromptIfNeeded().
`AppContainer` :
    let genreCatalog: GenreCatalogStore?   // nil without API configuration
    // simulator: `-track1-reset-genre-catalog` resets the snapshot alone; `-track1-reset-profile` resets it too.
Argument de lancement nouveau : `-track1-reset-genre-catalog` (simulateur uniquement).

## Critères d'acceptation
- [ ] Test UI A (`testADegradedCatalogAfterAFirstLaunchKeepsTheGenresTabOnItsLastTaxonomy`) : `firstProfile()`
      (l.829-836, catalogue `taxonomyCatalog`), `relaunch(app, catalog: Self.degradedCatalog)` ;
      `today-title` présent (15 s) ; tap sur l'onglet Genres ; `genre-card-family-0` présent (5 s),
      `genre-card-family-1` présent, `genres-retry` **absent**, `genres-edit` présent et désactivé. Le
      lecteur réseau de ce lancement ne peut produire aucune carte : seules les données du disque le peuvent.
- [ ] Test UI B (`testADegradedCatalogWithoutASnapshotMakesTheGenresTabUnavailable`) : `firstProfile()`,
      `relaunch(app, catalog: Self.degradedCatalog, extraArguments: ["-track1-reset-genre-catalog"])` ;
      `today-title` présent ; tap Genres ; `genres-retry` présent (5 s), `genres-edit` désactivé (les deux
      assertions de l'ancien test l.824-825).
- [ ] `NavigationTests.testThreeTabsKeepTheirIndependentNavigationStacks` (épinglé par `ios/scripts/check.sh:143`),
      `TodayFlowTests.testACatalogWithoutLinkedWorksShowsTheEmptyStateAndOffersTheGenres`, les tests de
      `ProfileFlowTests` qui relancent l'app (l.90, 176, 195, 222, 267, 278 : reprises d'onboarding, nouveau
      profil, opt-in) et ceux qui utilisent l'onglet Genres après un premier lancement
      (`testTheGenresTabShowsTheFamiliesOfTheProfileAndOpensTheSettings` l.694,
      `testEditingTheGenresAddsAFamilyThenTodayIsComputedAgain` l.730,
      `testTheSaveButtonFollowsTheDifferenceWithTheSavedSelection` l.767,
      `testTheGenresTabDrawsTheSameCardHeaderAsTheOnboarding` l.548) restent verts sans modification de
      leurs assertions.
- [ ] `swift test --package-path ios/Track1Core` vert (rien de Core ne change, preuve de non-régression) ;
      `ios-check` vert ; `npm run check` vert.
- [ ] Sur appareil (Raphael, après TestFlight) : relancer l'app → Genres : cartes immédiates, sans spinner ;
      idem en mode avion ; cocher un genre puis « Sauvegarder » enregistre (Today se recalcule).

## Tests attendus
- UI : A et B ci-dessus dans `ProfileFlowTests.swift`, à la place de l.817-826. Identifiants : cartes
  `genre-card-family-0` / `genre-card-family-1` (familles de `editorialTaxonomy`, l.878-881),
  `genres-retry`, `genres-edit` (`Self.saveIdentifier`, l.840), fixtures `taxonomyCatalog` (l.914) et
  `degradedCatalog` (l.923, taxonomie `{mode: degraded, available: true}` l.909).
- unitaire app : aucun (`GenresTabViewTests` ne teste que les mesures ; la logique du store est testée
  en Core par 1.1).

## Tier de risque
tier/2 — branchement d'un composant testé, logique locale ; aucun chemin `sensitivePath`.

## Notes d'implémentation
- Le préchauffage et le `refresh()` sont des `Task` non structurées, pas des `.task` de vue : un changement
  d'onglet annule la `.task` de la vue (`APIClient.request` rend alors `.failure(.cancelled)`), et l'écriture
  ne doit pas dépendre de l'onglet affiché (même raison que `ReminderSync.last`, `AppContainer.swift:115-118`).
- Ne pas appliquer le résultat de `refresh()` à l'éditeur ouvert (plan D3) ; ne pas relancer `refresh()` quand
  `catalog` est déjà `.ready` (la garde l.277 reste la première ligne de `loadTaxonomy`).
- Sous simulateur, le lecteur de fixtures ignore l'etag : un `refresh()` reçoit donc un 200 de même `revision`
  → `.unchanged` sans écriture (règle de 1.1). C'est ce qui rend le test A déterministe : la relance dégradée
  rend `.failed` et le snapshot du premier lancement reste.
- `-track1-reset-profile` doit aussi effacer le snapshot (`resetBeforeUse: resetProfile || resetGenreCatalog`) :
  le dossier `LocalStore` du simulateur survit d'un test UI à l'autre, et `UITestFlows.launch` ne passe que
  les resets de l.78-79 ; sans cela, le test suivant verrait la taxonomie du précédent (même raison que
  `RecentNodesStore`, `AppContainer.swift:68-70`).
- Convention du dépôt pour le commentaire de régression : « 2026-11-25 : l'onglet relisait le catalogue
  entier (`GET /mobile/v1/catalog`) à chaque lancement et montrait un spinner pendant des secondes ».
- Pas de simulateur en local (`docs/track1-builds.md:130-134`) ; typecheck de l'app sans `xcodebuild`
  possible (l.146-160) ; les tests UI passent par `ios-check`, qui ignore les PR en brouillon et n'est pas un
  check requis : passer la PR en « ready » et attendre son vert avant de demander le merge.
- Commits conventionnels, `Refs TRA-?` ; PR titrée `TRA-? …`, `Fixes TRA-?`.
```
