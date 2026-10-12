# Accélérer `ios-check` sans perte de qualité — package `Track1Core` et simulateur réutilisable

> Projet Linear : **Track1 mobile**. Brief validé par Raphael le 2026-10-12. Intègre TRA-421
> (simulateur `track1-ci-pool`, en Backlog). Statut : **plan en attente de validation, aucun
> ticket créé.** Base : `main` à `e922802` (TRA-420, PR #343).

## Problème

Mesures du 2026-10-12 sur la PR #343, `ios-check` à chaud : **7 min 40**.

| Étape | Durée | Part |
| --- | --- | --- |
| Démarrage d'un simulateur neuf (`simctl create` à chaque run) | 3 min 50 | 50 % |
| Build avec cache DerivedData | 7 s | — |
| `Track1Tests` : 198 tests XCTest hébergés dans l'app (`TEST_HOST`) | 17 s cumulées | — |
| `Track1UITests` : 9 tests | 114 s | 25 % |
| Passe Preview : 7 tests ciblés (TRA-420) | build + tests | — |

Trois défauts, dans l'ordre de leur coût :

1. **Le simulateur est recréé à chaque run.** TRA-421 le décrit et le résout ; il n'est pas démarré.
2. **Une erreur de logique n'est connue qu'après le simulateur et le build**, soit au plus tôt
   4 à 5 minutes après le début du job, alors que 22 des 34 fichiers Swift de l'app n'importent
   ni UIKit ni SwiftUI. Les 198 tests unitaires exigent pourtant tous le simulateur, parce qu'ils
   sont hébergés dans l'app.
3. **Aucune boucle locale.** Les agents n'ont pas le droit de lancer `xcodebuild` ni un
   simulateur sur ce Mac, qui héberge les deux runners CI. Chaque itération coûte un run complet.

Cible : `ios-check` entre 4 et 5 min à chaud, un échec de logique signalé en moins d'une minute,
`swift test` exécutable en local par les agents.

## Non-buts

- **Sauter ou réduire les tests UI.** Les 9 tests de `Track1UITests` restent sur chaque PR iOS.
  La passe Preview (7 tests, TRA-420) reste telle quelle.
- **Extraire la logique enfouie dans les vues SwiftUI** : `NodeArticleParser` et
  `NodeArticleView.safeCitationURL` (`ios/Track1/Features/Node/NodeArticleView.swift`),
  `NodeRelationGroup` et `RelationTapGuard` (`NodeRelationsView.swift`), `AppRouter`
  (`ios/Track1/App/AppRouter.swift`, SwiftUI pour `Binding` seulement), `AnalyticsClient` et
  `AnalyticsTransport` (`ios/Track1/Analytics/AnalyticsClient.swift`, SwiftUI pour `ScenePhase`).
  Ces fichiers sont modifiés ou supprimés par TRA-398, TRA-400 et TRA-408 : les toucher maintenant
  est une collision frontale. Suivi après la fin du plan Figma.
- Migrer les tests vers Swift Testing ; déplacer les tests qui touchent la plateforme
  (`AnalyticsClientTests`, `APIContractIntegrationTests`, `UITestFixtureReadersTests`, les tests
  `Node/*` qui lisent des types définis dans des vues, le test `Bundle.main` d'`AppConfigurationTests`).
- Toucher `.github/workflows/` : `ios-ci.yml` déclenche déjà sur `ios/**`, qui couvre le package.
- Garder un simulateur allumé en permanence ; lancer `xcodebuild` en local.
- Migrer le pbxproj vers les groupes synchronisés d'Xcode 16 (D5 du plan Figma, maintenue).
- Le trousseau : absent du code (prévu par TRA-346). Rien à faire ici.

## État des lieux vérifié

- App : `ios/Track1/`, 34 fichiers `.swift`. 21 n'importent que Foundation/Observation, 12 importent
  SwiftUI, 1 importe Segment (`Analytics/SegmentAdapter.swift`). UIKit n'est importé nulle part.
- Parmi les 21 fichiers Foundation, deux restent dans l'app : `App/AppContainer.swift` (construit
  `AppRouter` et `AnalyticsClient`, lit `Bundle.main`, deux `#if targetEnvironment(simulator)`) et
  `App/UITestFixtureReaders.swift` (entièrement sous `#if targetEnvironment(simulator)`). Les
  **19 autres** forment le périmètre du package (annexe A).
- Tests : `ios/Track1Tests/`, 198 tests XCTest, tous `@testable import Track1`, aucun helper partagé
  entre fichiers, aucune ressource. 127 sont déplaçables (71 purs, 53 passant par `LocalStore` sur un
  dossier temporaire, 3 tests de `validate` dans `AppConfigurationTests`). 71 restent hébergés dans
  l'app (annexe B).
- Projet : `ios/Track1.xcodeproj/project.pbxproj`, `objectVersion = 56`, 66 `PBXFileReference`
  explicites, aucun groupe synchronisé, une seule dépendance SPM distante (`Segment`, `exactVersion
  1.10.0`), aucun `XCLocalSwiftPackageReference`, aucun `Package.swift` dans le dépôt. Plages d'IDs
  D5 : `0200–03EF` réservées par le plan Figma, **`03F0–03FF` libres**.
- `ios/scripts/check.sh` (477 lignes) : lint swift-format sur `Track1`, `Track1Tests`,
  `Track1UITests` (L214) → `-resolvePackageDependencies` → cache DerivedData verrouillé par `mkdir`
  (L104–162) → harnais de contrat Node → `simctl create` (L435) → pour `Track1` puis `Track1Preview`,
  `build-for-testing` et `test-without-building`. Aucune mesure de temps.
- Gardes vitest qui devront voir le package : `test/ios-check.test.ts` (racines swift-format L63, garde
  « Bundle et drapeaux » L542–562, 4 actions xcodebuild attendues L411–431, faux outils injectés par
  `PATH`), `test/ios-no-webview.test.ts` (ne lit que `ios/Track1`), `test/native-ci-triggers.test.ts`
  (`filesUnder("ios")`, ignore `.build`).
- `scripts/ci/pr-policy.ts` compte le diff **sans détection de renommage** : un fichier déplacé
  coûte deux fois sa taille. Il avertit au-delà de 1 000 lignes ou 20 fichiers, sans bloquer.
- Swift 6 (`SWIFT_VERSION = 6.0`, `SWIFT_STRICT_CONCURRENCY = complete`), `IPHONEOS_DEPLOYMENT_TARGET
  = 17.0`, Xcode 26.4 épinglé par `ios/.xcode-version`.

## Décisions d'archi

### D1 — Un seul package local `ios/Track1Core`, un seul module, arborescence miroir

Le package vit dans `ios/Track1Core/` avec `Package.swift`, `Sources/Track1Core/` et
`Tests/Track1CoreTests/`. Les fichiers gardent leur chemin relatif actuel sous ces racines
(`Sources/Track1Core/Features/Node/NodeViewModel.swift`, `Tests/Track1CoreTests/Node/NodeViewModelTests.swift`),
pour que `git mv` soit un renommage pur, lisible avec `git diff -M`.

Manifeste (contrat, pas de code) : `swift-tools-version: 6.0` ; `platforms: iOS 17, macOS 14`
(`@Observable` exige macOS 14) ; un produit `library` `Track1Core` ; une cible `Track1Core` ; une
cible de test `Track1CoreTests` en XCTest ; mode de langage Swift 6 (implicite avec tools 6.0, ce
qui équivaut à `SWIFT_STRICT_CONCURRENCY = complete`). Aucune dépendance.

**Rejeté :** plusieurs packages (API, Domaine, ViewModels) — trois fois plus de liaisons pbxproj et
d'API publiques pour un gain nul à cette taille. **Rejeté :** un package « ombre » qui compilerait
les mêmes fichiers une seconde fois sans être lié à l'app — pas de frontière de module, deux
listes de sources à maintenir, et l'app ne verrait jamais une régression du package.

### D2 — Liaison par `XCLocalSwiftPackageReference`, `objectVersion` 56 → 60, IDs dans `03F0–03FF`

Objets à ajouter au pbxproj, dans la convention D5 (préfixe + 18 zéros + suffixe) :

- `L10000000000000000003F0` : `XCLocalSwiftPackageReference`, `relativePath = Track1Core`, ajouté à
  `packageReferences` du `PBXProject` `A00000000000000000000001`, à côté de `R10000000000000000000001`.
- `S10000000000000000003F1` : `XCSwiftPackageProductDependency`, `package = L1…03F0`,
  `productName = Track1Core`, ajouté à `packageProductDependencies` de la cible `A10000000000000000000001`.
- `B10000000000000000003F2` : `PBXBuildFile` avec `productRef = S1…03F1`, ajouté à la phase
  Frameworks `A20000000000000000000001` de l'app.
- `objectVersion = 60` et `compatibilityVersion = "Xcode 15.0"` : c'est le format qu'Xcode 15 a
  introduit avec ce type d'objet.

Les cibles de test ne lient pas le package : `Track1Tests` l'obtient par `TEST_HOST`, comme Segment
aujourd'hui.

Rien de tout cela n'est vérifiable sans Xcode. La tâche 1.1 est donc une **tranche verticale
minimale** validée par `ios-check`. Repli, à appliquer dans la même PR si `xcodebuild` ne résout
pas la référence : la forme héritée (Xcode 11–14), soit un `PBXFileReference`
`F10000000000000000003F3` (`lastKnownFileType = folder`, `path = Track1Core`) dans le groupe racine
et la même `XCSwiftPackageProductDependency` **sans** attribut `package`, `objectVersion` inchangé.

**Rejeté :** la forme héritée en premier choix — format que Xcode 15+ réécrit à l'ouverture, moins
documenté. **Rejeté :** un `.xcworkspace` — change le point d'entrée de `check.sh`, `archive.sh` et
des gardes vitest. **Rejeté :** groupes synchronisés Xcode 16 — D5 du plan Figma.

### D3 — Frontière : les 19 fichiers Foundation et leurs 127 tests passent ; `LocalStore` inclus

Partent dans le package les 19 fichiers de l'annexe A. `LocalStore` en fait partie : c'est du
Foundation pur, injectable (`directoryURL`, `fileManager`). Sa seule ligne spécifique est la classe
de protection `FileProtectionType.completeUntilFirstUserAuthentication` (L76 et L107) : elle passe sous
`#if os(iOS)` avec un commentaire daté, parce que les classes de protection sont un concept iOS et
que leur comportement sur un volume macOS de test n'est pas garanti. `isExcludedFromBackup` reste
inconditionnel. **Aucun test ne vérifie la protection aujourd'hui** (vérifié par grep) : rien n'est
perdu, mais rien n'est gagné non plus (question 3).

Les 53 tests qui passent par `LocalStore` (`ProfileStoreTests`, `OnboardingContractTests`,
`DailyRecommendationStoreTests`, `TodayViewModelTests`, `TodayViewModelConcurrencyTests`) sont des
tests de logique sur un vrai store en dossier temporaire ; ils vont dans le package.

Restent dans l'app : `AppContainer`, `UITestFixtureReaders`, `SegmentAdapter`, `AnalyticsClient`,
`AppRouter`, toutes les vues, et les 71 tests de l'annexe B. Les 23 tests de
`UITestFixtureReadersTests` sont sous `#if targetEnvironment(simulator)` : déplacés, ils
**disparaîtraient silencieusement** sous `swift test` macOS (garde en 1.3).

Conséquence Swift 6 : un type `public` perd l'inférence implicite de `Sendable`. Chaque type
valeur rendu public qui traverse un acteur (`LocalStore`, `ProfileStore`, `DailyRecommendationStore`)
ou `@MainActor` doit déclarer `Sendable` explicitement. Le compilateur le signale ; `swift build`
local le montre pour le package, `ios-check` pour l'app.

**Rejeté :** garder les 53 tests à store sur le simulateur — ce sont les tests de la logique
métier centrale (profil, recommandation du jour), précisément ceux qui doivent échouer en moins
d'une minute. **Rejeté :** un protocole de store pour mocker `LocalStore` — on ne mocke pas ce qu'on
possède.

### D4 — Migration par couche de dépendance, une PR par couche, deux commits par PR

Le graphe des 19 fichiers (annexe A) donne quatre couches sans cycle, à condition de déplacer
`ListeningActions` et `NodeViewModel` ensemble (cycle par les `typealias` de `NodeViewModel.swift`
L11–13). Chaque PR de déplacement contient **deux commits** :

1. `refactor(ios): move <couche> to Track1Core` — `git mv` des sources et des tests, retrait des
   `PBXFileReference`, `PBXBuildFile`, entrées de groupes et de phases correspondants, rien d'autre.
   `git diff -M --stat` doit montrer 100 % de renommages hors pbxproj.
2. `refactor(ios): expose <couche> API` — `public`, `public init` explicites, `Sendable`,
   `import Track1Core` dans les fichiers qui consomment la couche.

Un implémenteur sans Xcode valide le commit 2 en local par `swift test --package-path ios/Track1Core` ;
`ios-check` valide le côté app. C'est pour cela que l'annotation et le déplacement vont dans la même
PR : une PR d'annotation seule, pendant que les fichiers sont encore dans l'app, serait invérifiable
en local.

Le diff brut (sans renommage, tel que `pr-policy` le compte) sera de 1 900 à 4 000 lignes par PR.
L'avertissement « scope review » s'affichera ; la description de PR cite `git diff -M --stat`.

**Rejeté :** une seule PR de déplacement (≈ 12 000 lignes brutes ; un échec CI bloque tout).
**Rejeté :** des PR d'annotation séparées des PR de déplacement (voir ci-dessus). **Rejeté :** huit
PR par domaine — chaque PR qui touche les lignes uniques des phases `Sources` et des groupes est une
fenêtre de conflit pour les branches Figma ouvertes ; quatre est le minimum qui garde chaque PR
sous 4 000 lignes brutes.

### D5 — `swift test` dans `check.sh`, avant toute étape simulateur

`check.sh` lance `swift test --package-path "$ios_dir/Track1Core" --scratch-path
"$derived_data_root/Track1Core/.build" --skip-update` juste après le lint swift-format et avant
`-resolvePackageDependencies`. `setup_derived_data_cache` (et son verrou) est appelé avant, pour que
le `.build` du package profite du même cache, du même verrou et de la même purge. Un watchdog bash
borne l'étape (`TRACK1_SWIFT_TEST_TIMEOUT_SECONDS`, défaut 300 ; macOS n'a pas `timeout` GNU). Un
échec arrête le script avant la création du simulateur : c'est ce qui donne le signal en moins d'une
minute et libère le runner.

**Rejeté :** un job GitHub `swift-test` séparé — tier/3, un second runner qui compile pendant que le
premier fait tourner le simulateur sur le même Mac déjà juste en mémoire, double checkout, pour un
gain que TRA-421 apporte déjà.

### D6 — Les tests hébergés dans l'app n'utilisent jamais `@testable import Track1Core`

Les 71 tests restants importent `Track1Core` par son API publique (`import Track1Core`, en plus de
`@testable import Track1`). Les accès repérés sont tous couverts par des membres publics :
`public private(set) var` pour `state`, `listening`, `isOpeningListening`, `listeningFailure` de
`NodeViewModel` ; `public init` explicites pour `AnalyticsEnvelope`, `AppConfigurationValues`,
`GenerationRequest`, `SearchResponse`, `ContentReaders`, `ProfileDraft` (memberwise aujourd'hui) ;
`APIResult.value` public. Une garde vitest l'interdit (1.3).

**Rejeté :** `@testable import Track1Core` depuis l'app — dépend de la compilation du package avec
`ENABLE_TESTABILITY` sous des configurations nommées `Development` et `Preview`, comportement
d'Xcode non garanti pour des noms autres que `Debug`.

## Découpage

Ordre : Partie 0 et 1.1 en parallèle ; 1.2 après TRA-421 et 1.1 ; 1.3 après 1.1, en parallèle de
1.2 ; Partie 2 strictement séquentielle (2.1 → 2.2 → 2.3 → 2.4) après 1.2 ; Partie 3 à la fin.
Chaque partie est déployable seule : après la Partie 1, `ios-check` teste déjà un package minimal ;
après chaque PR de la Partie 2, l'app compile et tous les tests tournent, dans le package ou dans
l'app.

Les estimations tiennent compte du calibrage iOS (les PR Swift livrent 1,5 à 2,5 fois l'estimation).
« brut » = lignes ajoutées + supprimées sans détection de renommage.

### Partie 0 — Simulateur réutilisable (TRA-421, existant)

- [ ] **TRA-421** Réutiliser le simulateur d'`ios-check` au lieu d'en créer un à chaque run —
  tier/2, 2 points, **à sortir du Backlog tel quel**. Portée, critères et tests sont déjà dans le
  ticket (`track1-ci-pool`, `shutdown` sans `delete`, désinstallation des bundles
  `com.dropcliffs.track1.*` et `keychain reset` au lieu d'`erase`, verrou `mkdir`, repli éphémère).

Deux amendements à porter dans le ticket :
- Le critère « les 207 tests de `Track1` » devient « tous les tests des schémas `Track1` et
  `Track1Preview` » : après la Partie 2, `Track1` en compte 80 (71 + 9 UI).
- TRA-421 et la tâche 1.2 modifient tous deux `ios/scripts/check.sh` et `test/ios-check.test.ts`.
  TRA-421 passe en premier ; 1.2 est `blockedBy` TRA-421.

### Partie 1 — Le package existe et la CI le teste en premier

#### 1.1 Créer `Track1Core`, le lier à l'app, y déplacer `URLValidation`

tier/2 · 2 à 3 h · ≈ 300 lignes brutes · parallèle avec TRA-421 · bloque 1.2, 1.3, 2.1

**Portée**
- Créer `ios/Track1Core/Package.swift` (contrat D1), `ios/Track1Core/Sources/Track1Core/`,
  `ios/Track1Core/Tests/Track1CoreTests/`.
- `git mv ios/Track1/API/URLValidation.swift ios/Track1Core/Sources/Track1Core/API/URLValidation.swift` ;
  `enum URLValidation` et ses deux fonctions statiques deviennent `public`. Retirer du pbxproj sa
  `PBXFileReference`, son `PBXBuildFile`, son entrée dans le groupe `API` et dans la phase Sources
  `A20000000000000000000004`.
- `import Track1Core` dans `ios/Track1/API/APIModels.swift`, `ios/Track1/Listening/ListeningActions.swift`,
  `ios/Track1/Features/Node/NodeArticleView.swift`.
- Liaison pbxproj selon D2 (trois objets, `objectVersion`, `compatibilityVersion`).
- `ios/Track1Core/Tests/Track1CoreTests/API/URLValidationTests.swift` : quatre tests de
  caractérisation reprenant les cas déjà couverts indirectement par `APIClientTests.swift` L21
  (`127.0.0.1`, `[::ffff:7f00:1]`) et `ListeningTests.swift` L118–159 (`open.spotify.com`,
  `music.apple.com`, hôte étranger refusé). Pas d'autre test nouveau.
- `.gitignore` : `ios/Track1Core/.build/` et `ios/Track1Core/.swiftpm/`.
- Hors scope : `check.sh`, les gardes vitest, tout autre fichier Swift.

**Critères d'acceptation**
- [ ] `plutil -lint ios/Track1.xcodeproj/project.pbxproj` passe en local.
- [ ] `swift test --package-path ios/Track1Core` passe en local sur macOS : 4 tests, 0 échec.
- [ ] `ios-check` est vert sur la PR : l'app lie `Track1Core`, les 198 + 9 tests passent sur le
  simulateur (le compte de `Track1Tests` ne bouge pas : aucun test n'a quitté l'app).
- [ ] Si `xcodebuild` ne résout pas `L1…03F0`, la PR passe à la forme héritée (D2) et le dit dans sa
  description ; le plan est mis à jour dans la même PR.
- [ ] `npm run check` vert (aucune garde vitest n'est modifiée ici ; si l'une d'elles casse à cause du
  nouveau dossier, la corriger est dans la portée de 1.3, pas de 1.1 — en parler dans la PR).

**Tests attendus** : `URLValidationTests` (4). `ios-check` est le test de la liaison.

**Notes** : `swift test` en local est **autorisé** à partir de cette tâche (pas de simulateur, pas de
`xcodebuild`, quelques centaines de Mo). `xcodebuild` reste interdit en local. PR en brouillon : le
dispatcher la passe en ready et lit le log `ios-check`.

#### 1.2 Lancer `swift test` dans `check.sh` avant le simulateur, avec mesure de temps

tier/2 · 3 h · ≈ 280 lignes · blockedBy TRA-421, 1.1 · parallèle avec 1.3 · bloque 2.1

**Portée**
- `ios/scripts/check.sh` : (a) étendre `discover_swift_files` (L209–237) à la racine
  `$ios_dir/Track1Core` pour swift-format ; (b) appeler `setup_derived_data_cache` avant l'étape
  package ; (c) nouvelle fonction `run_package_tests` selon D5, appelée après le lint et avant
  `-resolvePackageDependencies` ; (d) watchdog bash borné par `TRACK1_SWIFT_TEST_TIMEOUT_SECONDS`
  (défaut 300) qui tue `swift test` et sort en erreur avec un message explicite ; (e) journaliser la
  durée de chaque étape (`SECONDS`) sur une ligne `[check] <étape>: <n>s` — lint, package, resolve,
  simulateur, build et tests par schéma — pour mesurer les critères de sortie sans lire les
  horodatages GitHub.
- `test/ios-check.test.ts` : faux `swift` dans les deux harnais (`runCheckScript` L269–383 et
  `runSwiftFixtureCheck` L55–225), journalisé dans `TRACK1_TEST_SWIFT_CALLS` ; `sourceRoots` L63 et
  `missingRoot` L43 étendus à `Track1Core` ; garde « Bundle et drapeaux » L542–562 étendue à
  `ios/Track1Core/Tests` **sans exemption**.
- Hors scope : `.github/workflows/`, les autres gardes vitest (1.3), le pbxproj.

**Critères d'acceptation**
- [ ] `swift test` est appelé une fois, avec `--package-path …/Track1Core` et `--scratch-path` sous
  la racine DerivedData, **avant** le premier `simctl create` et le premier `xcodebuild`.
- [ ] Un faux `swift` qui échoue fait sortir `check.sh` en erreur sans qu'aucun `simctl create` ni
  `xcodebuild build-for-testing` ne soit appelé ; le trap `cleanup` s'exécute.
- [ ] Un faux `swift` qui ne rend pas la main est tué après `TRACK1_SWIFT_TEST_TIMEOUT_SECONDS`
  (le test le fixe à 1 ou 2 s) et le script sort en erreur avec un message qui nomme le délai.
- [ ] Les 4 actions `xcodebuild` et les 2 `test-without-building` attendus (L411–431, L437–438,
  L496–508, L526) sont inchangés.
- [ ] swift-format lint reçoit les fichiers de `Track1Core/Sources` et `Track1Core/Tests`.
- [ ] Mesure sur une branche jetable avec un test du package volontairement cassé : le step
  « Run native Swift checks » échoue **en moins de 60 s** après son début, à chaud. Valeur reportée
  dans la PR.
- [ ] `ios-check` à chaud sur la PR : durée totale et lignes `[check] …` reportées dans la PR.
- [ ] `npm run check` vert.

**Tests attendus** : vitest, un par critère ci-dessus (ordre, échec, watchdog, comptes inchangés,
racines swift-format, garde Bundle sur un fichier de `Track1Core/Tests` contenant `Bundle.main`).

#### 1.3 Étendre les gardes du dépôt au package

tier/1 · 1 à 2 h · ≈ 150 lignes · blockedBy 1.1 · parallèle avec 1.2

**Portée**
- `test/ios-no-webview.test.ts` : ajouter la racine `ios/Track1Core/Sources` (mêmes motifs).
- `test/native-ci-triggers.test.ts` : assertion explicite que `ios/Track1Core/Package.swift` et un
  fichier de `ios/Track1Core/Sources` sont couverts par `paths` d'`ios-ci.yml` (régression si
  quelqu'un remplace `ios/**` par des globs plus fins). Aucun changement du workflow.
- Nouveau `test/ios-core-package.test.ts` : (a) aucun `import SwiftUI`, `import UIKit`,
  `import Segment` sous `ios/Track1Core/` ; (b) aucun `#if targetEnvironment(simulator)` ni
  `#if os(iOS)` sous `ios/Track1Core/Tests/` (un tel test disparaîtrait sous macOS) ; (c) aucun
  `@testable import Track1Core` sous `ios/Track1Tests/` et `ios/Track1UITests/` (D6) ; (d) le
  manifeste déclare `swift-tools-version: 6.0`, `.iOS(.v17)` et `.macOS(.v14)`.
- Hors scope : `check.sh`, `ios-check.test.ts` (1.2).

**Critères d'acceptation**
- [ ] Chaque garde a un cas positif (fixture ou fichier réel) et un cas négatif.
- [ ] `npm run check` vert sur `main` après 1.1, et rouge si l'on ajoute `import SwiftUI` dans un
  fichier de `Track1Core/Sources` (vérifié par le test lui-même sur une fixture).

**Tests attendus** : les gardes sont les tests.

### Partie 2 — Migration par couche

Format commun aux quatre tâches (D4) : deux commits, `git diff -M --stat` dans la description,
`swift test --package-path ios/Track1Core` vert en local avant de pousser, `ios-check` vert,
comptes de tests reportés dans la PR. Le pbxproj ne reçoit que des **retraits** ; aucun ID nouveau.
Conflit sur une ligne unique de groupe ou de phase : résolution par insertion, jamais par
renumérotation (D5 Figma). Les fichiers Figma arrivés entre-temps restent dans l'app. Chaque PR
est `blockedBy` la précédente.

#### 2.1 Couche 1 — API, configuration, événements analytics

tier/2 · 3 à 4 h · ≈ 2 900 lignes brutes dont ≈ 250 écrites · blockedBy 1.2

**Fichiers déplacés** (sources 906 lignes, tests ≈ 420) :
`API/APIError.swift`, `API/APIModels.swift`, `API/APIClient.swift`, `App/AppConfiguration.swift`,
`Analytics/AnalyticsEvent.swift`, `Analytics/ConsentStore.swift` ; `Track1Tests/API/APIClientTests.swift`.
`Track1Tests/AppConfigurationTests.swift` est **scindé** : les 3 tests de `validate` vont dans
`Tests/Track1CoreTests/AppConfigurationTests.swift` ; les 2 tests `Bundle.main` et `AppRouter` restent
dans l'app (fichier conservé, même nom).

**API publique** : ≈ 185 `public` (dont ≈ 120 dans `APIModels`), `public init` explicites pour
`AnalyticsEnvelope`, `AppConfigurationValues`, `GenerationRequest`, `SearchResponse`, `Sendable`
explicite sur les types valeur, `APIResult.value` public, les `CodingKeys` restent internes.
`createGeneration` devient public (il est utilisé par `APIContractIntegrationTests`).

**`import Track1Core`** dans les 12 fichiers de l'app qui nomment ces types (annexe A, colonne
« consommateurs »), dans les 10 fichiers purs encore dans l'app qui les référencent (import
temporaire, retiré quand ils migrent), et dans les tests restants qui les utilisent.

**Critères d'acceptation**
- [ ] Package : 16 tests (4 + 9 + 3) ; app : 186 + 9 UI ; Preview : 7. Reportés dans la PR.
- [ ] `test/ios-core-package.test.ts` et la garde Bundle passent sans exemption nouvelle.
- [ ] Aucun `@testable import Track1Core` dans `ios/Track1Tests`.

#### 2.2 Couche 2 — persistance, profil, navigation, recommandation

tier/2 · 3 à 4 h · ≈ 4 000 lignes brutes dont ≈ 170 écrites · blockedBy 2.1

**Fichiers déplacés** (sources 820, tests 1 187) : `Persistence/LocalStore.swift`,
`Profile/Profile.swift`, `Profile/ProfileStore.swift`, `Navigation/NavigationContext.swift`,
`Recommendation/Affinity.swift`, `Recommendation/DailyRecommendation.swift`,
`Recommendation/DailyRecommendationStore.swift` ; tests `Profile/ProfileStoreTests.swift`,
`Profile/OnboardingContractTests.swift`, `Recommendation/AffinityTests.swift`,
`Recommendation/DailySelectionTests.swift`, `Recommendation/DailyRecommendationStoreTests.swift`.

**Changement de contenu autorisé, le seul** : `LocalStore.swift` L76 et L107, classe de protection
sous `#if os(iOS)` avec un commentaire daté (D3).

**API publique** : ≈ 86 `public`, `public init` explicite pour `ProfileDraft`, `Sendable` explicite.

**Critères d'acceptation**
- [ ] Package : 64 tests ; app : 138 + 9 ; Preview : 7.
- [ ] Les 53 tests à store passent sous `swift test` macOS deux fois de suite (pas d'état résiduel
  dans le dossier temporaire).
- [ ] Si la review juge la PR trop large, elle est scindée à la frontière `Recommendation/`
  (3 sources + 3 tests) en une PR 2.2b `blockedBy` 2.2 ; rien d'autre ne change.

#### 2.3 Couche 3 — actions d'écoute et modèle de fiche

tier/2 · 2 à 3 h · ≈ 1 900 lignes brutes dont ≈ 90 écrites · blockedBy 2.2

**Fichiers déplacés** (sources 286, tests 635) : `Listening/ListeningActions.swift`,
`Features/Node/NodeViewModel.swift` (ensemble : cycle par les `typealias` `NodeReader`,
`NodeEventRecorder`, `LinksReader`) ; tests `ListeningTests.swift`, `Node/NodeViewModelTests.swift`.

**API publique** : ≈ 32 `public`, dont `public private(set) var` pour `state`, `listening`,
`isOpeningListening`, `listeningFailure` (lus par `NodeListeningTests` et `NodeRelationsTests`, qui
restent dans l'app), `public init` de `NodeViewModel`.

**Critères d'acceptation**
- [ ] Package : 91 tests ; app : 111 + 9 ; Preview : 7.
- [ ] `NodeListeningTests`, `NodeRelationsTests`, `AppRouterNodeTests` passent dans l'app avec
  `import Track1Core` seulement.

#### 2.4 Couche 4 — recherche, aujourd'hui, lecteurs de contenu

tier/2 · 3 h · ≈ 3 200 lignes brutes dont ≈ 90 écrites · blockedBy 2.3

**Fichiers déplacés** (sources 356, tests 1 216) : `App/ContentReaders.swift`,
`Features/Search/SearchViewModel.swift`, `Features/Today/TodayViewModel.swift` ; tests
`API/ContentReadersTests.swift`, `SearchTests.swift`, `Recommendation/TodayViewModelTests.swift`,
`Recommendation/TodayViewModelConcurrencyTests.swift`.

**API publique** : ≈ 30 `public`, `public init` explicite pour `ContentReaders` (construit par
`AppContainer` et `UITestFixtureReaders`), `public private(set)` sur `SearchViewModel` (2) et
`TodayViewModel` (1). Retrait des `import Track1Core` temporaires devenus inutiles.

**Critères d'acceptation**
- [ ] Package : 131 tests ; app : 71 + 9 ; Preview : 7. `ios/Track1/` contient 15 fichiers Swift
  plus ceux ajoutés par le plan Figma entre-temps ; `ios/Track1Core/Sources` en contient 19.
- [ ] Plus aucun fichier de `ios/Track1/` n'importe uniquement Foundation, sauf `AppContainer.swift`
  et `UITestFixtureReaders.swift` (vérifié par grep dans la PR).
- [ ] `TodayViewModelConcurrencyTests` passe trois fois de suite sous `swift test` (TRA-410 l'a
  rendu déterministe sur simulateur ; le vérifier sur macOS).

### Partie 3 — Documentation

#### 3.1 Documenter le package et la boucle locale

tier/1 · 1 h · ≈ 60 lignes · blockedBy 2.4

**Portée**
- `docs/track1-builds.md` : corriger la phrase obsolète « aucune dépendance Swift externe »
  (L30–34, faux depuis Segment) ; section « Package `Track1Core` » : périmètre (ce qui y va, ce qui
  reste dans l'app, D3), `swift test --package-path ios/Track1Core` en local, interdiction maintenue
  de `xcodebuild` et du simulateur en local.
- `CLAUDE.md`, section « Stack réelle », une ligne : la logique iOS pure vit dans
  `ios/Track1Core`, testable par `swift test` en local ; l'app n'est compilée que par `ios-check`.
- `docs/plans/track1-ios-figma.md`, section D5 : plage `03F0–03FF` consommée par ce plan ; tout
  nouveau fichier sans SwiftUI va dans `ios/Track1Core/Sources` avec son test dans
  `ios/Track1Core/Tests`, sans entrée pbxproj.

**Critères d'acceptation**
- [ ] Un agent qui lit `CLAUDE.md` puis `docs/track1-builds.md` sait où mettre un nouveau fichier
  pur et comment le tester en local.

## Risques

| Risque | Garde-fou |
| --- | --- |
| La liaison pbxproj (D2) est invérifiable sans Xcode ; `xcodebuild` peut refuser `L1…03F0` ou `objectVersion = 60`. | 1.1 est une tranche minimale ; `plutil -lint` en local ; repli hérité documenté, appliqué dans la même PR. |
| `public` désactive l'inférence `Sendable` ; en Swift 6 strict, des dizaines d'erreurs peuvent apparaître d'un coup. | `swift build` local montre celles du package ; `Sendable` explicite listé dans chaque tâche ; la couche 1 (types valeur de l'API) essuie l'essentiel. |
| `FileProtectionType` sur macOS : `setAttributes` peut lever et `LocalStore` répondre `.unavailable` → 53 tests rouges. | `#if os(iOS)` décidé d'avance (D3), pas « si ça casse ». |
| Les 23 tests sous `#if targetEnvironment(simulator)` disparaîtraient sans erreur s'ils migraient. | Ils restent ; garde (b) de 1.3 ; comptes de tests exigés dans chaque PR. |
| Conflits pbxproj avec les branches Figma (TRA-383 et suivants) sur les lignes uniques des phases et des groupes. | Quatre fenêtres au lieu de huit ; règle d'insertion D5 ; question 1 : exécuter la Partie 2 avant le démarrage des tâches Figma supprime le risque. |
| TRA-421 et 1.2 modifient les mêmes fichiers. | Séquence imposée : TRA-421 puis 1.2. |
| Une PR de déplacement déclenche l'avertissement « scope review » de `pr-policy` (diff compté sans renommage). | Avertissement, pas blocage ; `git diff -M --stat` dans la description ; 2.2 scindable à une frontière nommée. |
| `swift test` qui ne rend pas la main bloque le runner `ios` 30 min. | Watchdog de 1.2, testé avec un faux `swift`. |
| Mémoire du Mac : `swift test` en local pendant qu'`ios-check` tourne. | `swift test` sans simulateur reste léger ; il tourne **avant** le simulateur dans `check.sh`, jamais en même temps dans un même run. |
| Les tests du package tournent sur macOS, pas sur iOS : une différence de Foundation passerait inaperçue. | Le code est compilé pour iOS par l'app à chaque PR ; la frontière D3 exclut tout ce qui dépend de la plateforme. |
| Le build du package sous `Preview` (second DerivedData) rallonge le build à froid. | Négligeable à chaud ; le cache DerivedData est déjà par schéma. |

## Critères de sortie

- `ios-check` à chaud **≤ 5 min** sur deux runs consécutifs après TRA-421 + Partie 2 ; durées des
  étapes lisibles dans le log (`[check] …`).
- Un test du package cassé fait échouer le job **en moins de 60 s** après le début du step natif.
- `swift test --package-path ios/Track1Core` passe en local en moins de 60 s à chaud : **131 tests**.
- Simulateur : `Track1` = 71 tests unitaires + 9 UI ; `Track1Preview` = 7 tests. Total inchangé :
  131 + 71 + 9 = 211 (198 + 9 + 4 tests de caractérisation).
- `ios/Track1Core/Sources` : 19 fichiers ; `ios/Track1/` : 15 fichiers d'origine.
- Gardes vertes : swift-format sur le package, no-webview, Bundle, `ios-core-package`,
  `native-ci-triggers`. `npm run check` vert.
- Docs à jour (3.1).

## Questions pour Raphael

1. **Ordonnancement face au plan Figma.** Aucune tâche TRA-381 à TRA-409 n'est mergée. Exécuter la
   Partie 2 (quatre PR, séquentielles, ≈ 1 à 2 jours d'agents) **avant** de dispatcher TRA-383 et
   suivants supprime tout conflit pbxproj. Sinon, chaque branche Figma ouverte résout jusqu'à quatre
   conflits d'insertion. Lequel ?
2. **Tickets Figma à amender** pour cibler `ios/Track1Core` : TRA-395 (`NodePageSpec`,
   `NodePageModel`), TRA-401 (`RecentNodesStore`), TRA-402 (`GenreTaxonomy`, `OnboardingFlowModel`),
   et `NodeImageStore` de TRA-367 s'il est sans UI. Oui, ou on les laisse dans l'app et on les
   migrera après ?
3. **`LocalStore` et la protection des fichiers (D3).** Le brief garde « persistance et protection
   des fichiers » sur iOS. Je propose : `LocalStore` dans le package, classe de protection sous
   `#if os(iOS)`, les 53 tests à store sur macOS. Aucun test ne vérifie la protection aujourd'hui ;
   en ajouter un hébergé iOS (≈ 30 lignes, dans 2.2) ou le laisser hors scope ?
4. **`objectVersion` 56 → 60** avec `XCLocalSwiftPackageReference` (D2), ou préférer d'emblée la
   référence dossier héritée sans toucher à la version ?
5. **`swift test` en local** autorisé pour les implémenteurs dès 1.1, y compris pendant qu'un run
   `ios-check` tourne : confirmé ?
6. **Quatre PR de déplacement**, dont 2.2 à ≈ 4 000 lignes brutes (100 % renommages), ou cinq avec
   2.2 scindée d'office ?
7. Les **4 tests de caractérisation** d'`URLValidation` en 1.1 (seul code de test nouveau du plan,
   ≈ 40 lignes) : acceptés comme graine du package ?

## Annexe A — Les 19 fichiers du package, par couche

Chemins relatifs à `ios/Track1/`. « Dépend de » : autres fichiers purs référencés. « Consommateurs » :
fichiers de l'app (hors package) qui nomment ses types et recevront `import Track1Core`.

| Couche | Fichier | Lignes | Dépend de | Consommateurs dans l'app |
| --- | --- | --- | --- | --- |
| 1 (1.1) | `API/URLValidation.swift` | 68 | — | `NodeArticleView` |
| 1 | `API/APIError.swift` | 23 | — | `AppContainer`, `RootView`, `UITestFixtureReaders` |
| 1 | `API/APIModels.swift` | 385 | `URLValidation` | `AppContainer`, `AppRouter`, `RootView`, `UITestFixtureReaders`, `NodeArticleView`, `NodeRelationsView`, `NodeView`, `OnboardingView` |
| 1 | `API/APIClient.swift` | 144 | `APIError`, `APIModels`, `AppConfiguration` | `AppContainer`, `RootView`, `OnboardingView` |
| 1 | `App/AppConfiguration.swift` | 92 | — | `AppContainer`, `RootView`, `AnalyticsClient` |
| 1 | `Analytics/AnalyticsEvent.swift` | 204 | `AppConfiguration` | `AnalyticsClient`, `SegmentAdapter`, `AppRouter`, `OnboardingView`, `SettingsView` |
| 1 | `Analytics/ConsentStore.swift` | 58 | — | `AnalyticsClient`, `PrivacyChoiceView` |
| 2 | `Persistence/LocalStore.swift` | 116 | — | `AppContainer`, `OnboardingView` (`LocalStoreError`) |
| 2 | `Profile/Profile.swift` | 75 | `APIModels` | `RootView`, `OnboardingView`, `SettingsView` |
| 2 | `Profile/ProfileStore.swift` | 231 | `Profile`, `LocalStore`, `APIModels` | `AppContainer`, `RootView`, `OnboardingView`, `SettingsView` |
| 2 | `Navigation/NavigationContext.swift` | 30 | `AnalyticsEvent` | `AppRouter`, `NodeRelationsView`, `NodeView` |
| 2 | `Recommendation/Affinity.swift` | 127 | `APIModels` | — |
| 2 | `Recommendation/DailyRecommendation.swift` | 83 | `APIModels`, `Affinity` | — |
| 2 | `Recommendation/DailyRecommendationStore.swift` | 158 | `DailyRecommendation`, `LocalStore` | — |
| 3 | `Listening/ListeningActions.swift` | 130 | `APIModels`, `AnalyticsEvent`, `URLValidation`, `NavigationContext`, `NodeViewModel` | `NodeListeningView` |
| 3 | `Features/Node/NodeViewModel.swift` | 156 | `APIError`, `APIModels`, `AnalyticsEvent`, `ListeningActions`, `NavigationContext` | `RootView`, `NodeView`, `NodeListeningView`, `NodeRelationsView` |
| 4 | `App/ContentReaders.swift` | 24 | `APIClient`, `APIError`, `APIModels`, `NodeViewModel` | `AppContainer`, `RootView`, `UITestFixtureReaders` |
| 4 | `Features/Search/SearchViewModel.swift` | 148 | `APIError`, `APIModels`, `AnalyticsEvent`, `NavigationContext`, `NodeViewModel` | — (tests seulement) |
| 4 | `Features/Today/TodayViewModel.swift` | 184 | `APIError`, `APIModels`, `AnalyticsEvent`, `Affinity`, `DailyRecommendation*`, `NavigationContext`, `Profile`, `NodeViewModel` | — (tests seulement) |

Total : 2 436 lignes. Restent dans l'app : `App/AppContainer.swift`, `App/UITestFixtureReaders.swift`,
`Analytics/SegmentAdapter.swift`, `Analytics/AnalyticsClient.swift`, `App/AppRouter.swift`,
`App/RootView.swift`, `App/Track1App.swift`, `DesignSystem/Track1Theme.swift` et les 7 vues de
`Features/`.

## Annexe B — Les tests, par destination

Package (131) : `APIClientTests` 9, `AppConfigurationTests` 3 (scindé), `URLValidationTests` 4
(nouveau), `ProfileStoreTests` 7, `OnboardingContractTests` 2, `AffinityTests` 8,
`DailySelectionTests` 12, `DailyRecommendationStoreTests` 19, `ListeningTests` 16,
`NodeViewModelTests` 11, `ContentReadersTests` 1, `SearchTests` 14, `TodayViewModelTests` 18,
`TodayViewModelConcurrencyTests` 7.

App, simulateur (71) : `AnalyticsClientTests` 14 (Segment, `ScenePhase`), `AppConfigurationTests` 2
(`Bundle.main`, `AppRouter`), `UITestFixtureReadersTests` 23 (`#if targetEnvironment(simulator)`),
`APIContractIntegrationTests` 1 (harnais Node de `check.sh`), `AppRouterNodeTests` 3,
`NodeArticleTests` 10, `NodeListeningTests` 10, `NodeRelationsTests` 8 (types définis dans des vues).

UI (9) : inchangés. Preview (7) : inchangés, tous dans la liste « app ».
