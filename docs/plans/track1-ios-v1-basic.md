# Track1 iOS — V1 native basique (re-planification partielle de P-TRA-4)

Statut : **brouillon à valider par Raphael** (gate humain). Rédigé le 2026-10-10 à partir du brief
validé par Raphael. Aucun ticket Linear n'est créé : le MCP Linear est injoignable, et la création
n'a lieu qu'après validation. Les sous-tickets sont notés `TRA-? (341.1)` ; leur ID réel sera
reporté ici à la création.

Sources : [`track1-native-ios.md`](track1-native-ios.md), contrats complets dans
[`track1-native-ios-linear.md`](track1-native-ios-linear.md) (sections P1.5, P2.4, P2.5, P2.6, P4.2),
mapping [`track1-native-ios-linear-map.md`](track1-native-ios-linear-map.md),
[`../track1-native-transition.md`](../track1-native-transition.md), code `ios/` sur `origin/main`
`8c8ee62`, PR [#317](https://github.com/raphpool/odyssey-music/pull/317) (head `f5734eb`).

## Problème

Raphael veut une première version iOS SwiftUI **installable** qui permette de choisir ses goûts,
retrouver une découverte stable chaque jour, lire une fiche, parcourir ses relations, ouvrir
Spotify ou Apple Music et rechercher les cinq types de contenus. Un Figma va bientôt respécifier
toute l'UX/UI : tout investissement de fidélité visuelle ou d'animation serait jeté.

Sur `main`, le socle existe : application à trois onglets (TRA-335), CI native `ios-check`
(TRA-336, TRA-355, TRA-356), client API typé (TRA-338), analytics soumis au consentement (#314),
goûts locaux (TRA-340). Aucun écran de contenu n'existe : les onglets Aujourd'hui (avec profil) et
Recherche affichent encore un écran d'attente.

La première brique, TRA-341, est bloquée : la PR #317 fait 1 312 lignes sur 17 fichiers (plafond
400 lignes / 12 fichiers) et sa CI est rouge. Le conteneur de travail des agents est Linux sans
Xcode : le Swift n'est compilé et testé que par `ios-check` sur un unique runner macOS
self-hosted. Chaque tâche doit donc être petite pour limiter les allers-retours de CI à l'aveugle.

Ordre imposé par le brief : TRA-341, TRA-342, TRA-343, TRA-348, puis TRA-337 (qui nécessite les
certificats Apple de Raphael). Les critères de chaque ticket sont réduits au strict nécessaire
fonctionnel ; les exigences de sécurité (URL tierces validées, aucune WebView) et de consentement
analytics sont conservées.

## Non-buts

- Sortir de l'hébergement `dropcliffs.com` (serveur, déploiement, identifiants de bundle
  `com.dropcliffs.track1.*`) : souhaité par Raphael, mais c'est un projet séparé à planifier. La V1
  se contente de ne coder aucun hôte en dur côté iOS (D6).

- Fidélité Figma, design system, animations : TRA-347, TRA-352, TRA-317, TRA-331, TRA-315 sont en
  pause jusqu'au Figma. Aucune nouvelle couleur, aucun asset ; `Track1Theme` existant utilisable,
  pas étendu.
- Partie 6 App Store en pause (TRA-318, TRA-319, TRA-354, TRA-320, TRA-321) : pas de TestFlight,
  pas de fiche App Store Connect, pas d'archivage du client Expo.
- Hors V1 : TRA-346 (rappels iOS), TRA-349 (création de fiche sur demande), TRA-350 (hors ligne et
  effacement des traces), TRA-351 (liens track1).
- Aucune création de fiche : un résultat ou une relation sans fiche est seulement signalé, jamais
  de `POST /mobile/v1/generations`.
- Aucun entitlement APNs, aucune notification.
- Aucun envoi Segment réel : `Info.plist` ne déclare pas `Track1SegmentWriteKey`, les événements
  sont produits et filtrés par le consentement mais n'ont pas de transport en V1.
- Aucun changement serveur, site, Android, Expo (`mobile/`), `.github/`, `deploy/`.
- Pas de nettoyage des écrans d'attente (`EntryView`, `EntryStatusView`, `AppRoute.entryStatus`,
  encore utilisés par `AppConfigurationTests`), pas de migration du pbxproj vers des groupes
  synchronisés.
- Particularités par type de fiche (TRA-347) et recherche locale persistée (P4.4) : non.
- Les autres tickets du projet (dont TRA-344 et TRA-345) ne sont pas re-planifiés ici et gardent
  leur contrat.

## Décisions d'archi

### D1 — #317 est découpée ; la branche ne garde que le socle modèle

La branche `codex/tra-341-node-reading` est réduite au modèle de fiche (`NavigationContext`,
`NodeViewModel`, ses tests, ~240 lignes) et devient le premier sous-ticket (341.1). Les vues,
le routeur, l'article, les relations et l'image reviennent dans des sous-tickets dédiés, à partir
du code de #317. Le harnais de test UI de #317 (transport `URLProtocol` dans l'app, audit des
requêtes, hook d'ouverture au lancement) est abandonné (voir D3).
**Rejeté :** corriger #317 en place (1 312 lignes, une seule PR de CI aveugle, toujours hors
plafond) ; la couper en deux moitiés (encore > 400 lignes chacune, et le harnais fragile resterait).

### D2 — Les écrans V1 sont en lecture seule par construction

Les vues et view models ne reçoivent jamais `APIClient`. Ils reçoivent des closures d'un
`ContentReaders` (catalogue, fiche, image, liens, recherche), qui n'a aucun membre d'écriture.
`createGeneration` reste dans `APIClient` mais aucun écran ne peut l'atteindre. Un test vérifie que
`ContentReaders.live` n'émet que des `GET`.
**Rejeté :** passer `APIClient` aux écrans (comme l'onboarding) et compter sur la revue et un audit
réseau en test UI pour détecter un POST. C'est exactement le mécanisme qui a produit le faux
signal de #317.

### D3 — Tests UI : fixtures au niveau des lectures, seulement sur les vrais points d'entrée

La logique est testée en XCTest sur les view models et les fonctions pures, avec les vrais types du
projet ; seule la frontière réseau (closure de lecture ou `URLProtocol` local au fichier de test)
est substituée. Les XCUITest n'existent que pour les deux parcours réels : Aujourd'hui → fiche
(343.6) et Recherche → fiche → relation → retour (348.2). Leurs données viennent d'un
`ContentReaders` de fixtures construit sous `#if targetEnvironment(simulator)` depuis une variable
d'environnement, sur le modèle existant de `TRACK1_PROFILE_CATALOG_JSON`. Aucun compteur, aucun
overlay lu par XCUITest, aucune ouverture d'écran au lancement. Contrepartie acceptée : les vues de
fiche (Parties 1 et 2) ne sont exécutées en UI qu'à partir de 343.6.
**Rejeté :** l'`URLProtocol` de #317 dans la cible app avec compteur d'audit à sentinelle `-1`
mis à jour par `Task {}` non structurée, overlay invisible et ouverture au lancement (fragile,
soupçonné de l'échec CI). Rejeté aussi : pointer l'app vers le harnais HTTP local de `check.sh`,
car il faudrait une base d'API non HTTPS dans l'app.

### D4 — UI SwiftUI système, rien de plus

`NavigationStack`, `ScrollView`, `List`, `Button`, `Link`, `ContentUnavailableView`, `ProgressView`,
`TextField`, `Picker`, avec les polices système (Dynamic Type gratuit). Tout texte venant de l'API
est affiché par `Text(verbatim:)`. Les identifiants d'accessibilité ne sont posés que là où un test
les lit. Toute ouverture externe passe par l'OS (`Link` ou `OpenURLAction`). Aucun import `WebKit`
ni `SafariServices`, ce que garantit un test vitest (341.3).
**Rejeté :** poursuivre `Track1Theme` et les écrans Figma 32:35/35:275/32:69 maintenant : le travail
serait refait après le Figma.

### D5 — Plages d'identifiants pbxproj réservées par tâche

Le pbxproj utilise des références explicites, des IDs numérotés à la main et des groupes ou phases
`Sources` écrits **sur une seule ligne**. Deux branches parallèles qui prennent « le prochain ID
libre » produisent des IDs dupliqués que git peut fusionner sans conflit. Le projet serait alors
corrompu. Chaque tâche reçoit donc une plage. Format : préfixe (`B1` PBXBuildFile, `F1`
PBXFileReference, `A3` PBXGroup) + 18 zéros + suffixe hexadécimal de 4 caractères pris dans la
plage, par exemple `F10000000000000000000100`. Les conflits sur les lignes uniques de groupe ou de
phase se résolvent par insertion, jamais par renumérotation.
**Rejeté :** numérotation séquentielle libre (collision silencieuse) ; migration vers des groupes
synchronisés Xcode 16 (refactor du pbxproj hors scope, invérifiable sans Xcode).

### D6 — Build installable : archive Preview signée localement, URL d'API fournie à l'archivage

Un script versionné (`ios/scripts/archive.sh`) produit sur le Mac de Raphael une archive du schéma
`Track1Preview`, avec signature automatique Xcode (`-allowProvisioningUpdates`, Team ID fourni par
variable d'environnement). L'export est ad hoc (`release-testing`), pour l'iPhone enregistré.
L'URL d'API n'est écrite nulle part dans le dépôt : elle est fournie par la variable
d'environnement obligatoire `TRACK1_API_BASE_URL` au moment de l'archivage, puis passée en réglage
de build. Aujourd'hui, la seule API mobile en service est hébergée sur `dropcliffs.com`
(`https://dropcliffs.com/api/odyssey/mobile/v1`) : c'est la valeur utilisée pour 337.2. Raphael
veut sortir progressivement de cet hébergement historique ; changer d'hôte ne demandera alors
qu'une nouvelle archive, sans modification de code. Les `.xcconfig` gardent leurs domaines `.example` non résolubles, donc
simulateur et CI ne peuvent pas atteindre la production. `Base.xcconfig` garde
`CODE_SIGNING_ALLOWED = NO`. Pas d'entitlement APNs, pas de TestFlight.
**Rejeté :** signature en CI avec secrets (tier/3 `.github`, gestion de secrets, inutile pour un
seul iPhone) ; faire pointer `Preview.xcconfig` sur la production (les XCUITest du schéma Preview
en CI pourraient toucher la prod) ; TestFlight interne (exige une fiche App Store Connect, c'est la
Partie 6 en pause).

## Découpage

### Règles communes à toutes les tâches

- **Branche et PR.** Partir de `origin/main` (≥ `8c8ee62`). 1 sous-ticket = 1 branche = 1 PR. Le
  titre de PR est préfixé de l'ID du sous-ticket. Le corps contient `Fixes TRA-<sous-ticket>` et
  `Refs TRA-<parent>`, **jamais** `Fixes TRA-<parent>`, qui fermerait le parent.
- **Vérification.** Le Swift n'est vérifié que par `ios-check` : respecter `ios/.swift-format`
  (tabulations, 110 colonnes, lint strict sur tous les fichiers Swift). Une tâche qui touche
  `test/` passe aussi `npm run check`.
- **Ajout d'un fichier au pbxproj** (D5). Un `PBXFileReference` `F1…` et un `PBXBuildFile` `B1…`,
  l'ajout de la référence dans son groupe `A3…` (créé dans la plage si absent), puis l'ajout du
  build file dans la phase `Sources` de la cible : app `A20000000000000000000004`, tests
  `A20000000000000000000006`, tests UI `A20000000000000000000007`. Groupes existants utiles :
  `A3…0003` App, `A3…0013` Features, `A3…0002` Track1, `A3…0006` Track1Tests, `A3…0011`
  Track1Tests/API, `A3…0007` Track1UITests. Groupes créés par 341.1 : `A3…0021` Features/Node,
  `A3…0022` Navigation, `A3…0023` Track1Tests/Node.
- **Sécurité.** Aucune URL issue de l'API n'est ouverte ni chargée sans `URLValidation.publicHTTPSURL`
  (ou `URLValidation.providerURL(from:host:)` pour les services d'écoute). Ouverture uniquement par
  l'OS. Jamais `WebKit` ni `SafariServices`.
- **Analytics.** Uniquement les noms existants de `AnalyticsEventName`. Les propriétés doivent
  passer `AnalyticsValidation.accepts`. Transmission exclusivement par un `NodeEventRecorder` branché
  sur `AnalyticsClient.record(_:)`, qui ignore tout événement sans consentement accordé. Aucune
  saisie utilisateur dans les propriétés.
- **Tests.** On ne mocke pas ce qu'on possède : vrais `NodeViewModel`, `AppRouter`, `APIClient`,
  `LocalStore` (répertoire temporaire). Seuls le réseau et l'OS sont substitués.
- **Taille.** Moins de 300 lignes et au plus 8 fichiers par tâche, pbxproj et tests compris
  (tier/3 : 200 lignes maximum).

### Vue d'ensemble

L'ordre de priorité est celui du brief. Les « vagues » indiquent ce qui peut démarrer en
parallèle, dans la limite de 3 PR iOS ouvertes à la fois (risque R1). Aucun tier n'est abaissé
par rapport au parent.

| Tâche | Titre | Parent | Tier | Diff estimé | Fichiers | Dépend de | Vague |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 341.1 | Charger une fiche et son contexte de navigation (PR #317 réduite) | TRA-341 | 2 | ~240 | 4 | — | 0 |
| 341.2 | Ouvrir une fiche minimale depuis le routeur, en lecture seule | TRA-341 | 2 | ~250 | 8 | 341.1 | 1 |
| 341.3 | Afficher l'article et les sources en texte natif | TRA-341 | 2 | ~230 | 5 | 341.2 | 2 |
| 341.4 | Parcourir les relations d'une fiche | TRA-341 | 2 | ~260 | 7 | 341.2 | 2 |
| 341.5 | *(optionnelle)* Afficher l'image d'une fiche sans redirection non sûre | TRA-341 | 2 | ~285 | 7 | 341.2 | 2 |
| 342.1 | Calculer et ouvrir les actions d'écoute | TRA-342 | 2 | ~250 | 3 | 341.1 | 1 |
| 342.2 | Proposer l'écoute depuis une fiche | TRA-342 | 2 | ~210 | 6 | 341.2, 342.1 | 2 |
| 343.1 | Classer les œuvres selon les goûts | TRA-343 | 2 | ~200 | 3 | — | 0 |
| 343.2 | Choisir la découverte du jour de façon déterministe | TRA-343 | 2 | ~190 | 3 | 343.1 | 1 |
| 343.3 | Conserver l'historique des découvertes sur l'iPhone | TRA-343 | 2 | ~190 | 3 | 343.2 | 2 |
| 343.4 | Servir des fixtures de lecture aux tests UI du simulateur | TRA-343 | 2 | ~200 | 4 | 341.2 | 2 |
| 343.5 | Calculer et mémoriser la découverte du jour | TRA-343 | 2 | ~270 | 3 | 343.3 | 3 |
| 343.6 | Afficher la découverte du jour et ouvrir sa fiche | TRA-343 | 2 | ~200 | 5 | 343.5, 343.4 | 4 |
| 348.1 | Rechercher avec temporisation, filtres et réponses ordonnées | TRA-348 | 2 | ~290 | 3 | 341.1 | 1 |
| 348.2 | Afficher la recherche et ouvrir les fiches trouvées | TRA-348 | 2 | ~240 | 6 | 348.1, 343.4, 341.4 | 3 |
| 337.1 | Produire une archive Preview signée par un script reproductible | TRA-337 | 3 | ~190 | 3 | — | 0 |
| 337.2 | Installer la V1 sur l'iPhone de Raphael et consigner la preuve | TRA-337 | 3 | ~90 | 2 | 337.1, Parties 1–4 | 5 |

**Conflits attendus entre tâches parallèles.** 341.3, 341.4, 341.5 et 342.2 modifient toutes
`NodeView.swift`. 341.4, 341.5 et 342.2 modifient aussi `NodeViewModel.swift` et `RootView.swift`.
343.4 et 343.6 modifient `AppContainer.swift`. 343.6 et 348.2 modifient `RootView.swift`. Ce sont
des insertions mécaniques : celui qui merge en second rebase. Recommandation : une seule tâche à
la fois parmi celles qui touchent `NodeView`, dans l'ordre 341.3 → 341.4 → 342.2 → 341.5. Les
tâches sans fichier commun (343.1–343.3, 348.1, 337.1) tournent en parallèle.

Les parents TRA-341, TRA-342, TRA-343, TRA-348 et TRA-337 deviennent des issues conteneurs. Leur
contrat est réduit comme indiqué dans chaque partie, et ils sont fermés quand leurs sous-tickets
requis sont mergés.

### Partie 1 — Lire une fiche et parcourir ses relations (TRA-341)

Incrément technique déployable sans régression : la fiche existe, est testée et routable, mais
aucun point d'entrée utilisateur n'y mène avant la Partie 3 (Aujourd'hui) ou la Partie 4
(Recherche). Les onglets existants restent inchangés.

- [ ] TRA-? (341.1) Charger une fiche et son contexte de navigation — **réutilise la branche
  `codex/tra-341-node-reading` et la PR #317**
- [ ] TRA-? (341.2) Ouvrir une fiche minimale depuis le routeur, en lecture seule
- [ ] TRA-? (341.3) Afficher l'article et les sources en texte natif
- [ ] TRA-? (341.4) Parcourir les relations d'une fiche
- [ ] TRA-? (341.5) *(optionnelle)* Afficher l'image d'une fiche sans suivre de redirection non sûre

**Contrat réduit de TRA-341.**
- *Conservé :* tronc commun des cinq types (titre, type, accroche, article en texte natif,
  sources HTTPS sûres, relations) ; alias remplacé par l'identité canonique avec contexte conservé ;
  404 distinct de la panne ; relation absente sans création ; annulation sans écriture tardive ;
  `node_viewed` une fois par entrée réussie ; `relation_opened` une fois par geste ; contexte
  d'attribution suivi le long des relations et remis à zéro au départ indépendant suivant.
- *Retiré :* XCUITest propres à la fiche (les parcours sont couverts par 343.6 et 348.2, voir D3) ;
  particularités par type (TRA-347) ; tout rendu Figma. L'image devient optionnelle : le
  remplacement « pas d'image » suffit fonctionnellement.

#### Diagnostic de la CI de #317 (head `f5734eb`, run `37930441081`)

- **`ios-check` rouge** à l'étape « Run native Swift checks ». Le journal du job et les xcresult
  (`ios-xcresult-37930441081-1` et `-2`) ne sont pas téléchargeables depuis ce conteneur (stockage
  blob refusé, 403). Le nom exact du test en échec n'est donc pas confirmé ici.
- **Le `POST /mobile/v1/generations` est un faux signal.** Trois raisons :
  1. Aucun code de la branche n'appelle `createGeneration` en dehors de
     `ios/Track1/API/APIClient.swift` (vérifié par `git grep` sur la branche), et `NodeViewModel`
     ne reçoit que deux closures `GET` (`readNode`, `readImage`).
  2. Quand `xcodebuild test-without-building` échoue, `ios/scripts/check.sh` affiche « XCTest
     failed before contract verification; observed proxy requests: » suivi du rapport du harnais
     de contrat. Ce rapport compte `generationPosts: 1` parce que
     `ios/Track1Tests/API/APIContractIntegrationTests.swift`, présent sur `main` depuis TRA-338,
     poste **volontairement** une génération pour vérifier le 503 non relancé. `verify_contract_report`
     exige d'ailleurs `generationPosts === 1`. Le POST observé est la valeur attendue d'un test
     existant, affichée à cause d'un autre échec.
  3. L'audit in-app de #317 (`NodeUITestFixtureRequestAudit`) ne compte que des requêtes
     inattendues, sans méthode ni chemin. Il ne peut donc pas avoir « montré » un POST.
- **Cause probable de l'échec XCUITest.** Le seul fichier XCUITest ajouté,
  `ios/Track1UITests/NodeFlowTests.swift`, dépend du harnais simulateur introduit par la PR :
  - `ios/Track1/App/NodeUITestFixtureTransport.swift` : `URLProtocol` qui intercepte toute la
    session d'API ; compteur à sentinelle `-1` mis à jour par une `Task { @MainActor }` non
    structurée.
  - `NodeUITestFixtureRequestAuditView` dans `RootView.swift` : overlay de texte transparent lu
    comme `staticText`.
  - `consumeUITestStartupNode` (`AppContainer.swift`, `RootView.swift`) : push au lancement après
    `await reloadProfile()`.

  Le corps de la PR indique que les suites complètes avaient passé 62/62 **avant** le correctif de
  redirection d'image. Ce correctif fait recréer à `NodeImageLoader` une `URLSession` à partir de
  la configuration de la session de fixtures. Seuls `NodeImageLoaderTests` ont été rejoués après :
  l'interaction entre le harnais et le nouveau chargeur n'a jamais été validée en suite complète.
  Le découpage supprime ce harnais : il n'y a rien à corriger sur #317. Si 343.6 ou 348.2 échouent
  en UI, lire l'xcresult avant tout correctif.
- **`mobile-check` rouge.** La branche part de `3456c48`, antérieur à `8c8ee62` (#318, Refs
  TRA-357, correctif de `mobile/test/node-screen.test.tsx`). La fusion de `origin/main` le résout.
- **`review` (IA) rouge.** À relancer sur la PR réduite.

#### Répartition du diff actuel de #317

| Fichier de #317 | Lignes | Destination |
| --- | --- | --- |
| `ios/Track1/Navigation/NavigationContext.swift` | 30 | **341.1** tel quel |
| `ios/Track1/Features/Node/NodeViewModel.swift` | 127 | **341.1** : état, `load()`, alias, annulation, `node_viewed`, `NodeAnalytics.nodeViewed` · **341.4** : `relationEventRecorder`, `NodeAnalytics.relationOpened` · **341.5** : `NodeImageState`, `NodeImageReader`, `imageState`, `loadImage(for:)` |
| `ios/Track1Tests/Node/NodeViewModelTests.swift` | 172 | **341.1** : cinq types, alias, 404/panne, annulation, contexte (sans assertions d'image) · **341.3** : `testArticleParsing…`, `testUnsafeCitation…` · **341.4** : `testRelationEvent…` · **341.5** : assertions `imageState` |
| `ios/Track1/App/AppRouter.swift` | +9 | **341.2** |
| `ios/Track1/Features/Node/NodeView.swift` | 86 | **341.2** : états, en-tête texte, `NodePresentation` · **341.3** : insertion article · **341.4** : insertion relations · **341.5** : image d'en-tête |
| `ios/Track1/App/RootView.swift` | +61 | **341.2** : destination `.node` (réécrite sur `ContentReaders`) · **341.4** : closure `openRelation` · *abandonné* : `nodeImageSession`, overlay d'audit, `consumeUITestStartupNode` (~35 lignes) |
| `ios/Track1Tests/Node/AppRouterNodeTests.swift` | 38 | **341.2** : `testNodeRouteKeepsEachTabPathIndependent` · **341.4** : `testRelationRoutePreservesAttributionUntilAnotherIndependentDeparture` |
| `ios/Track1/Features/Node/NodeArticleView.swift` | 125 | **341.3** |
| `ios/Track1/Features/Node/NodeRelationsView.swift` | 93 | **341.4** (regroupement et anti-double-geste extraits en code pur testable) |
| `ios/Track1/Features/Node/NodeImageView.swift` | 119 | **341.5** (chargeur sur configuration éphémère propre, sans `nodeImageSession`) |
| `ios/Track1Tests/Node/NodeImageLoaderTests.swift` | 118 | **341.5**, sans `testPreviousLoaderWouldFetchThePrivateRedirect` |
| `ios/Track1/App/AppContainer.swift` | +20 | *abandonné* (session de fixtures, `nodeImageSession`, nœud de démarrage) ; 341.2 y ajoute `readers` |
| `ios/Track1/App/NodeUITestFixtureTransport.swift` | 153 | *abandonné* (remplacé par 343.4) |
| `ios/Track1Tests/Node/NodeUITestFixtureRequestAuditTests.swift` | 17 | *abandonné* |
| `ios/Track1Tests/Node/NodeUITestFixtureTransportTests.swift` | 34 | *abandonné* |
| `ios/Track1UITests/NodeFlowTests.swift` | 76 | *abandonné* ; scénarios repris par `SearchFlowTests` (348.2) et `TodayFlowTests` (343.6) |
| `ios/Track1.xcodeproj/project.pbxproj` | +45 | **341.1** garde ses 3 fichiers et 3 groupes ; les autres fichiers sont ré-ajoutés par leur tâche avec leur plage |

Environ 370 lignes de #317 sont abandonnées : le harnais, la session d'image partagée et un test de
démonstration.

#### 341.1 — Charger une fiche et son contexte de navigation

- **Linear :** nouveau sous-ticket de TRA-341. **Reprend la branche `codex/tra-341-node-reading`
  et la PR #317.**
- **Tier :** tier/2 · **Diff :** ~240 lignes, 4 fichiers · **Dépend de :** — ·
  **Parallélisable :** oui (vague 0, avec 343.1 et 337.1).
- **Portée :**
  - `ios/Track1/Navigation/NavigationContext.swift` : conservé tel quel.
  - `ios/Track1/Features/Node/NodeViewModel.swift` : version #317 réduite (sans image ni
    relations, voir la répartition).
  - `ios/Track1Tests/Node/NodeViewModelTests.swift` : cas conservés, voir la répartition. Garder
    l'extension `fileprivate` `JSONDecoder.track1` du fichier.
  - `ios/Track1.xcodeproj/project.pbxproj` : ne garder que les entrées de ces 3 fichiers et des
    groupes `A3…0021`, `A3…0022`, `A3…0023`.
  - Tous les autres fichiers de #317 reviennent à leur état sur `main` (supprimés s'ils sont
    nouveaux).
- **Procédure de branche :**
  1. `git merge origin/main` dans la branche. Pas de force-push : `f5734eb` reste consultable comme
     référence pour les tâches suivantes.
  2. Un commit de réduction.
  3. Renommer la PR #317 en « TRA-<341.1> Charger une fiche et son contexte de navigation ».
  4. Corps de PR : `Fixes TRA-<341.1>` et `Refs TRA-341`. Retirer `Fixes TRA-341`. Réécrire la
     section « Critères et tests ».
- **Hors-scope :** toute vue, routeur, `ContentReaders`, image, article, relations.
- **Contrat :**
  - `struct NavigationContext: Hashable, Sendable`, avec :
    - `source: AnalyticsSource`, `recommendationID: UUID?`, `notificationID: UUID?` ;
    - `static func independent(source:) -> NavigationContext` ;
    - `func followingRelation() -> NavigationContext` ;
    - `var attributionProperties: [String: AnalyticsValue]`.
  - `enum NodeViewState: Sendable { case loading, loaded(NodeDetail), missing(NodeIdentity), failed }`.
  - `typealias NodeReader = @Sendable (NodeIdentity) async -> APIResult<NodeResponse>`.
  - `typealias NodeEventRecorder = @MainActor @Sendable (AnalyticsEvent) -> Void`.
  - `@MainActor @Observable final class NodeViewModel`, avec :
    - `init(identity:context:readNode:recordEvent: NodeEventRecorder? = nil)` ;
    - `private(set) var requestedIdentity`, `private(set) var state` ;
    - `let context: NavigationContext` ;
    - `func load() async`.
  - `enum NodeAnalytics { static func nodeViewed(_:context:) -> AnalyticsEvent }`, avec
    `source = context.source`.
- **Critères d'acceptation :**
  - [ ] Pour chacun des 5 types, une réponse avec `teaser` null, `citations` et `edges` vides donne
    `.loaded` avec type et nom attendus. Elle produit exactement un `node_viewed` (`node_id`,
    `node_type`) accepté par `AnalyticsValidation.accepts`, même après un second `load()`.
  - [ ] Alias : la demande de `artist:alias` reçoit `node.id = artist:canonical`. Résultat :
    `requestedIdentity == artist:canonical`, `node_viewed.node_id` canonique, `source` et
    `notification_id` / `recommendation_id` d'entrée conservés.
  - [ ] HTTP 404 → `.missing(identité demandée)`. `.network`, 503, `.notModified` et
    `.invalidResponse` → `.failed`. Aucun événement dans ces cas.
  - [ ] Si la tâche est annulée pendant `readNode`, l'état ne change plus et aucun événement n'est
    émis.
  - [ ] `followingRelation()` donne `source = .relation` et garde les deux identifiants.
    `.independent` n'en a aucun. `attributionProperties` n'émet que les clés présentes, avec les UUID
    en minuscules.
  - [ ] Le diff de la PR contre `origin/main` ne contient que les 4 fichiers de la portée ;
    `ios-check`, `mobile-check` et `test` sont verts.
- **Tests attendus :** `NodeViewModelTests` (XCTest), lecteurs fournis par des closures (frontière
  réseau).
- **pbxproj :** conserver les IDs déjà attribués par #317 :
  - `B1…0032` / `F1…0039` (NavigationContext) ;
  - `B1…0034` / `F1…0041` (NodeViewModel) ;
  - `B1…0038` / `F1…0045` (NodeViewModelTests) ;
  - groupes `A3…0021`, `A3…0022`, `A3…0023`.

  Les autres IDs de #317 ne sont réutilisés par personne.

#### 341.2 — Ouvrir une fiche minimale depuis le routeur, en lecture seule

- **Tier :** tier/2 · **Diff :** ~250 lignes, 8 fichiers · **Dépend de :** 341.1 ·
  **Parallélisable :** oui avec 342.1, 343.1–343.3, 348.1, 337.1.
- **Portée :**
  - `ios/Track1/App/AppRouter.swift` : `case node(identity: NodeIdentity, context: NavigationContext)`
    dans `AppRoute` ; `openNode(_:context:in:)` et `openIndependentNode(_:source:in:)`, repris de #317.
  - `ios/Track1/App/ContentReaders.swift` (nouveau).
  - `ios/Track1/App/AppContainer.swift` : `let readers: ContentReaders?`, valant `.live(apiClient)`
    si la configuration est valide, sinon nil.
  - `ios/Track1/App/RootView.swift` : `readers` passé à `ApplicationTabs`. Dans
    `navigationDestination`, `case .node` rend `NodeView` (titre « Fiche », affichage inline). Sans
    readers, la destination rend `InvalidConfigurationView(error: .missingEnvironment)`.
  - `ios/Track1/Features/Node/NodeView.swift` (nouveau).
  - `ios/Track1Tests/Node/AppRouterNodeTests.swift` (nouveau, premier test de #317).
  - `ios/Track1Tests/API/ContentReadersTests.swift` (nouveau).
  - pbxproj.
- **Hors-scope :** article, sources, relations, image, écoute. Aucun point d'entrée UI vers la fiche.
  `APIClient` n'est pas modifié.
- **Contrat :**
  - `struct ContentReaders: Sendable` :
    - `let catalog: @Sendable () async -> APIResult<Catalog>` ;
    - `let node: NodeReader` ;
    - `let image: @Sendable (NodeIdentity) async -> APIResult<ImageResponse>` ;
    - `let links: @Sendable (NodeIdentity) async -> APIResult<LinksResponse>` ;
    - `let search: @Sendable (_ query: String, _ type: NodeType?) async -> APIResult<SearchResponse>` ;
    - `static func live(_ client: APIClient) -> ContentReaders`.

    Aucun membre d'écriture (D2).
  - `NodeView(model: NodeViewModel)`, avec `.task { await model.load() }`. États :
    - `.loading` : `ProgressView("Chargement de la fiche")`.
    - `.loaded` : type (`NodePresentation.typeName` de #317 : Artiste/Album/Titre/Genre/Label), nom
      et accroche en `Text(verbatim:)`.
    - `.missing` : `ContentUnavailableView` « Fiche indisponible », avec la description « Cette
      fiche n'existe pas encore dans track1. » identifiée `node-missing`.
    - `.failed` : « Impossible de charger cette fiche », description identifiée `node-failed`, et
      bouton « Réessayer » (`node-retry`) qui relance `load()`.

    Les identifiants sont posés sur le texte de description, comme `profile-recovery-message`.
- **Critères d'acceptation :**
  - [ ] `openIndependentNode(id, source: .search, in: .search)` n'empile
    `.node(identity: id, context: .independent(source: .search))` que dans la pile Recherche. Les
    piles Aujourd'hui et Réglages restent vides.
  - [ ] Chaque lecteur de `ContentReaders.live` émet exactement une requête, toujours `GET`, vers :
    - `…/mobile/v1/catalog` ;
    - `…/nodes/artist:x` ;
    - `…/nodes/artist:x/image` ;
    - `…/nodes/artist:x/links` ;
    - `…/search?q=ab&type=genre`.

    L'ensemble des méthodes observées vaut `{GET}`.
  - [ ] `NavigationTests`, `ProfileFlowTests` et `ConsentTests` restent verts sans modification.
  - [ ] Les quatre états de `NodeView` sont vérifiés en UI par `SearchFlowTests` (348.2). Ici, la
    vérification se limite à la compilation, avec un switch exhaustif sur `AppRoute`.
- **Tests attendus :**
  - `AppRouterNodeTests` ;
  - `ContentReadersTests` : `APIClient` réel, base `https://fixture.invalid/mobile/v1/`, et
    `URLProtocol` d'enregistrement privé au fichier de test, qui compare méthode et chemin décodé.
- **pbxproj :** plage `0100–010F`. Groupes : `ContentReaders` → `A3…0003`, `NodeView` → `A3…0021`,
  `AppRouterNodeTests` → `A3…0023`, `ContentReadersTests` → `A3…0011`.

#### 341.3 — Afficher l'article et les sources en texte natif

- **Tier :** tier/2 · **Diff :** ~230 lignes, 5 fichiers · **Dépend de :** 341.2 ·
  **Parallélisable :** oui, avec un conflit attendu sur `NodeView.swift` (voir la vue d'ensemble).
- **Portée :**
  - `ios/Track1/Features/Node/NodeArticleView.swift` (nouveau, repris de #317).
  - `NodeView.swift` : `NodeArticleView(article:citations:)` inséré sous l'en-tête.
  - `ios/Track1Tests/Node/NodeArticleTests.swift` (nouveau).
  - `test/ios-no-webview.test.ts` (nouveau, vitest exécutable sous Linux).
  - pbxproj.
- **Contrat :**
  - `enum NodeArticleBlock: Equatable, Sendable { case paragraph(String), list([String]) }`.
  - `enum NodeArticleParser { static func blocks(from: String) -> [NodeArticleBlock] }`.
  - `NodeArticleView.safeCitationURL(_:) -> URL?`, qui délègue à `URLValidation.publicHTTPSURL`.
  - Rendu : blocs en `Text(verbatim:)`, listes à puces. Une source dont l'URL est sûre devient un
    `Link` (navigateur système) ; sinon c'est un texte non interactif. « Aucune source
    disponible. » si la liste est vide.
- **Critères d'acceptation :**
  - [ ] `"<script>alert(1)</script>"` et `"[lien](https://evil.example)"` restent un seul
    `.paragraph`, au texte identique.
  - [ ] Les préfixes `- `, `* `, `• `, `1. ` et `2) ` donnent `.list`. Une ligne vide sépare les
    blocs. `\r\n` et `\r` sont normalisés. Les lignes consécutives d'un paragraphe sont jointes par
    une espace.
  - [ ] `safeCitationURL` rejette `http://example.com`, `https://u:p@example.com`,
    `https://example.com:8443`, `https://127.0.0.1/` et `https://localhost/`, et accepte
    `https://example.com/a`.
  - [ ] Aucun fichier `ios/Track1/**/*.swift` n'importe `WebKit` ou `SafariServices`, ni ne mentionne
    `WKWebView` ou `SFSafariViewController`.
- **Tests attendus :** `NodeArticleTests` (XCTest) ; `test/ios-no-webview.test.ts` (lecture du
  disque, style de `test/ios-check.test.ts`, Biome).
- **pbxproj :** plage `0110–011F`.

#### 341.4 — Parcourir les relations d'une fiche

- **Tier :** tier/2 · **Diff :** ~260 lignes, 7 fichiers · **Dépend de :** 341.2 ·
  **Parallélisable :** oui, avec des conflits mécaniques.
- **Portée :**
  - `ios/Track1/Features/Node/NodeRelationsView.swift` (nouveau, repris de #317). Le regroupement
    et l'anti-double-geste sont extraits en code pur.
  - `NodeViewModel.swift` : `var relationEventRecorder` et `NodeAnalytics.relationOpened`, repris
    de #317.
  - `NodeView.swift` : section relations et paramètre
    `openRelation: (NodeIdentity, NavigationContext) -> Void`.
  - `RootView.swift` : `openRelation` appelle `router.openNode(relation, context:, in: tab)`.
  - `ios/Track1Tests/Node/NodeRelationsTests.swift` (nouveau).
  - `AppRouterNodeTests.swift` : ajout du second test de #317.
  - pbxproj.
- **Contrat :**
  - `struct NodeRelationGroup: Identifiable { kind: String; relations: [NodeEdge]; label: String }`.
  - `static func groups(from: [String: NodeEdgeValue]) -> [NodeRelationGroup]` : groupes non vides,
    triés par `kind`, avec ces libellés :
    - `artists` → « Artistes », `projects` → « Projets », `tracks` → « Titres » ;
    - `genres` → « Genres », `labels` → « Labels » ;
    - toute autre clé → la clé, avec `_` et `-` remplacés par des espaces.
  - `struct RelationTapGuard { mutating func shouldOpen(key: String, at: Date) -> Bool }` : refuse la
    même clé `kind-slug` à moins de 0,75 s.
  - `NodeAnalytics.relationOpened(from:relation:kind:context:)` : propriétés `from_node_id`,
    `node_id`, `node_type`, `relation_kind`, plus l'attribution ; source `.relation`.
  - Un geste émet `relation_opened`, puis appelle
    `openDestination(relation.slug, context.followingRelation())`.
- **Critères d'acceptation :**
  - [ ] `groups(from:)` omet les groupes vides, garde un ordre stable par clé, traite `.one` comme
    `.many` et produit les libellés exacts.
  - [ ] `relation_opened` contient les 4 clés requises, plus `recommendation_id` / `notification_id`
    seulement s'ils existent. `AnalyticsValidation.accepts` est vrai.
  - [ ] Avec `RelationTapGuard` : même clé à 0,5 s → un seul `true` ; à 0,8 s → deux ; clés
    différentes → deux.
  - [ ] Fiche A → relation B → relation C dans l'onglet Aujourd'hui : `recommendation_id` est
    conservé. `openIndependentNode` dans Recherche repart sans attribution.
  - [ ] Une relation vers une fiche absente mène à `.missing` sans autre requête (341.1), ce qui
    est vérifié en UI par 348.2.
- **Tests attendus :** `NodeRelationsTests` et `AppRouterNodeTests` (XCTest).
- **pbxproj :** plage `0120–012F`.

#### 341.5 — *(optionnelle)* Afficher l'image d'une fiche sans suivre de redirection non sûre

Hors critères de sortie V1. Raphael peut la retirer au gate sans impact sur le reste.

- **Tier :** tier/2 · **Diff :** ~285 lignes, 7 fichiers · **Dépend de :** 341.2 ·
  **Parallélisable :** oui, avec des conflits mécaniques.
- **Portée :**
  - `ios/Track1/Features/Node/NodeImageView.swift` (nouveau, repris de #317).
  - `NodeViewModel.swift` : réintroduire l'état d'image de #317 via un paramètre
    `readImage: NodeImageReader? = nil`. S'il vaut nil, l'image est `.unavailable` et les tests
    341.1 restent inchangés.
  - `NodeView.swift` : image dans l'en-tête.
  - `RootView.swift` : `readImage: readers.image`.
  - `ios/Track1Tests/Node/NodeImageLoaderTests.swift` (nouveau, depuis #317).
  - `NodeViewModelTests.swift` : cas d'image.
  - pbxproj.
- **Contrat :**
  - `NodeImageLoader.load(url: URL, configuration: URLSessionConfiguration = .ephemeral) async -> UIImage?` :
    URL initiale et chaque redirection validées par `publicHTTPSURL`, sinon annulation ; réponse
    non-2xx → nil.
  - Pas de `nodeImageSession` dans `AppContainer`.
- **Critères d'acceptation :**
  - [ ] Redirection vers un hôte privé, en `http` ou avec port explicite : la cible n'est jamais
    demandée et le résultat est nil. Redirection HTTPS publique : l'image est chargée.
  - [ ] `image_url` null et `/image` en échec → `.unavailable`. `/image` avec un autre `slug` →
    `.unavailable`. `/image` réussi → `.available(url)`.
  - [ ] Une réponse `/image` arrivée après annulation ou après changement d'identité ne change pas
    l'état.
- **Tests attendus :** `NodeImageLoaderTests` et `NodeViewModelTests` (XCTest).
- **pbxproj :** plage `0130–013F`.

### Partie 2 — Ouvrir Spotify ou Apple Music depuis une fiche (TRA-342)

Incrément mergeable sans régression : la section d'écoute apparaît sur la fiche, accessible
dès la Partie 3.

- [ ] TRA-? (342.1) Calculer et ouvrir les actions d'écoute
- [ ] TRA-? (342.2) Proposer l'écoute depuis une fiche

**Contrat réduit de TRA-342.**
- *Conservé :*
  - priorité au lien exact de `/links`, sinon recherche officielle encodée ;
  - aucune action pour genre et label ;
  - validation HTTPS, hôte exact, sans identifiants ni port, avant tout appel à l'OS ;
  - ouverture par l'OS uniquement ;
  - `external_listening_opened` après acceptation de l'OS, et `external_listening_failed` avec
    `unsafe_url` ou `open_failed` ;
  - pas de double geste, jamais `audio_played`.
- *Retiré :* l'artiste dans la recherche de secours (nom seul, comme
  `mobile/src/listening/actions.ts`). L'essai physique avec et sans l'application du service passe
  dans le smoke V1 (337.2).

#### 342.1 — Calculer et ouvrir les actions d'écoute

- **Tier :** tier/2 · **Diff :** ~250 lignes, 3 fichiers · **Dépend de :** 341.1 ·
  **Parallélisable :** oui dès 341.1 (aucun fichier commun).
- **Portée :**
  - `ios/Track1/Listening/ListeningActions.swift` (nouveau, nouveau groupe `Listening` sous
    `A3…0002`).
  - `ios/Track1Tests/ListeningTests.swift` (nouveau).
  - pbxproj.
- **Contrat :**
  - `enum ListeningProvider: String, CaseIterable, Sendable { case spotify, appleMusic = "apple_music" }`.
  - `enum ListeningLinkKind: String, Sendable { case exact, search }`.
  - `struct ListeningAction: Equatable, Sendable { provider; url: URL; linkKind; title: String }`.
  - `enum ListeningOutcome: Equatable, Sendable { case opened, unsafeURL, openFailed }`.
  - `enum ListeningActions`, qui expose :
    - `actions(for: NodeType, name: String, links: LinksResponse?) -> [ListeningAction]` ;
    - `searchURL(for: ListeningProvider, name: String) -> URL?` ;
    - `isSafe(_: URL, for: ListeningProvider) -> Bool` ;
    - `@MainActor open(_:node: NodeIdentity, context: NavigationContext, openURL: @MainActor (URL) async -> Bool, recordEvent: NodeEventRecorder?) async -> ListeningOutcome`.
  - Règles de `actions` :
    - genre et label → `[]` ; sinon Spotify puis Apple Music ;
    - lien exact : `links.spotify` / `links.apple`, déjà validés par le décodage ;
    - sinon recherche : `https://open.spotify.com/search/<q>` ou
      `https://music.apple.com/search?term=<q>` ;
    - `<q>` = nom trimé, encodé comme `encodeURIComponent` (seuls `A–Z a–z 0–9 - _ . ! ~ * ' ( )`
      ne sont pas encodés) ;
    - nom vide après trim → pas d'action de recherche.
  - Titres : « Écouter sur Spotify » / « Écouter sur Apple Music » pour un lien exact,
    « Rechercher sur Spotify » / « Rechercher sur Apple Music » pour une recherche.
  - Règles de `open` :
    - URL non sûre → `external_listening_failed` avec `error_code=unsafe_url`, sans appeler
      `openURL` ;
    - `openURL` renvoie true → `external_listening_opened` ;
    - `openURL` renvoie false → `external_listening_failed` avec `open_failed` ;
    - propriétés : `node_id`, `node_type`, `provider`, `link_kind`, plus l'attribution ;
      source `context.source`.
- **Critères d'acceptation :**
  - [ ] `artist` avec liens exacts → 2 actions `exact` portant les URL reçues. Liens nil ou vides →
    2 actions `search`. `genre` et `label` → `[]`.
  - [ ] Encodage de la recherche :
    - « AC/DC » → `…/search/AC%2FDC` ;
    - « Sigur Rós » → `…/search/Sigur%20R%C3%B3s` ;
    - « R&B ? » → `…?term=R%26B%20%3F` ;
    - « Guns N' Roses » → `Guns%20N'%20Roses`.
  - [ ] Pour Spotify, `isSafe` refuse :
    - `http://open.spotify.com/x` ;
    - `https://open.spotify.com.evil.example/x` ;
    - `https://evil.example/open.spotify.com` ;
    - `https://u:p@open.spotify.com/x` ;
    - `https://open.spotify.com:444/x` ;
    - `https://music.apple.com/x`.
  - [ ] URL non sûre : `openURL` n'est jamais appelé, un seul événement `unsafe_url`. OS → false :
    un seul `open_failed`. OS → true : un seul `opened`. Tous les événements passent
    `AnalyticsValidation.accepts`.
- **Tests attendus :** `ListeningTests` (XCTest), avec `openURL` en closure (frontière OS).
  Reprendre les cas de `mobile/test/listening-actions.test.ts`.
- **pbxproj :** plage `0140–014F`.

#### 342.2 — Proposer l'écoute depuis une fiche

- **Tier :** tier/2 · **Diff :** ~210 lignes, 6 fichiers · **Dépend de :** 341.2, 342.1 ·
  **Parallélisable :** oui, avec des conflits mécaniques (`NodeView`, `NodeViewModel`, `RootView`).
- **Portée :**
  - `NodeViewModel.swift` : paramètre
    `readLinks: (@Sendable (NodeIdentity) async -> APIResult<LinksResponse>)? = nil`, propriété
    `listening` et méthode `openListening(_:using:)`.
  - `ios/Track1/Features/Node/NodeListeningView.swift` (nouveau).
  - `NodeView.swift` : section « Écouter » sous l'en-tête.
  - `RootView.swift` : `readLinks: readers.links`.
  - `ios/Track1Tests/Node/NodeListeningTests.swift` (nouveau).
  - pbxproj.
- **Contrat :**
  - `enum ListeningState: Equatable { case hidden, loading, ready([ListeningAction]) }`.
  - Après `.loaded`, pour un type artist, project ou track avec `readLinks` non nil : `.loading`,
    puis `.ready(ListeningActions.actions(…))`. Un échec de `/links` revient à `links: nil`, donc à
    des actions de recherche. Genre et label → `.hidden`, sans appel à `/links`.
  - `openListening(_ action:, using open: @MainActor (URL) async -> Bool) async` : ignoré si une
    ouverture est déjà en cours.
  - Vue : un `Button` par action (`listen-spotify`, `listen-apple_music`), désactivés pendant
    l'ouverture. `OpenURLAction` de l'environnement avec complétion booléenne. En cas d'échec :
    « Impossible d'ouvrir <service>. » (`listen-error`).
- **Critères d'acceptation :**
  - [ ] Artiste avec `/links` exacts → `.ready` avec 2 actions `exact`. `/links` en échec → 2 actions
    `search`. Genre et label → `.hidden`, avec 0 appel `/links`.
  - [ ] Deux `openListening` concurrents → `open` appelé une seule fois, un seul événement.
  - [ ] Une réponse `/links` arrivée après annulation ne change pas l'état.
- **Tests attendus :** `NodeListeningTests` (XCTest, lecteurs en closures).
- **pbxproj :** plage `0150–015F`.

### Partie 3 — Retrouver une découverte stable chaque jour (TRA-343)

Premier incrément visible : avec un profil, l'onglet Aujourd'hui affiche une découverte stable et
ouvre sa fiche, avec l'écoute des Parties 1 et 2.

- [ ] TRA-? (343.1) Classer les œuvres selon les goûts
- [ ] TRA-? (343.2) Choisir la découverte du jour de façon déterministe
- [ ] TRA-? (343.3) Conserver l'historique des découvertes sur l'iPhone
- [ ] TRA-? (343.4) Servir des fixtures de lecture aux tests UI du simulateur
- [ ] TRA-? (343.5) Calculer et mémoriser la découverte du jour
- [ ] TRA-? (343.6) Afficher la découverte du jour et ouvrir sa fiche

**Contrat réduit de TRA-343.**
- *Conservé :*
  - scoring identique au client RN (+3 direct, +1 proche, +4 et +3 repères, limite 60) ;
  - exclusion des 40 dernières identités et FNV-1a 32 UTF-8 ;
  - sélection persistée avant affichage, identique pour une même date et une même révision ;
    recalcul à la modification des goûts ;
  - états vide et indisponible expliqués ;
  - `daily_recommendation_viewed` une fois par sélection, `daily_recommendation_opened` par geste ;
  - aucun appel au modèle.
- *Retiré :* Figma 32:35/35:275/35:326 ; XCUITest de modification des goûts (couverte en XCTest) ;
  `view_event_id` du RN (inutile sans transport Segment).
- *Ajouté (décision V1) :* une découverte du jour déjà persistée s'affiche **sans relire le
  catalogue**. Une panne réseau ne masque donc pas une découverte déjà choisie, alors que le RN
  exigeait le catalogue.

#### 343.1 — Classer les œuvres selon les goûts

- **Tier :** tier/2 · **Diff :** ~200 lignes, 3 fichiers · **Dépend de :** — ·
  **Parallélisable :** oui, dès maintenant.
- **Portée :**
  - `ios/Track1/Recommendation/Affinity.swift` (nouveau, nouveau groupe `Recommendation` sous
    `A3…0002`).
  - `ios/Track1Tests/Recommendation/AffinityTests.swift` (nouveau groupe sous `A3…0006`).
  - pbxproj.
- **Contrat :**
  - `struct AffinityCandidate: Equatable, Sendable { identity: NodeIdentity; type: NodeType; name: String; teaser: String?; score: Int; reasons: [String] }`.
  - `enum Affinity { static func rank(catalog: Catalog, genreIDs: [NodeIdentity]) -> [AffinityCandidate] }`.
  - Port exact de `mobile/src/recommendation/affinity.ts` :
    - **Genres sélectionnés :** les identités dédoublonnées présentes dans le catalogue avec le type
      genre.
    - **Genres proches :** les cibles genre des arêtes `subgenres` / `related_genres` qui partent
      d'un genre sélectionné.
    - **Arêtes partant d'un genre sélectionné :**

      | Arête | Points | Raison |
      | --- | --- | --- |
      | `key_artists` | +3 | « Artiste clé d’<genre> » |
      | `landmark_projects` | +4 | « Projet repère d’<genre> » |
      | `landmark_tracks` | +4 | « Morceau repère d’<genre> » |

    - **Arêtes `genres` d'une œuvre :** vers un genre sélectionné, +3 « Lié à <genre> » ; vers un
      genre proche, +1 par triplet (sélectionné, relation, proche) avec « Proche de <sélectionné> ».
    - Une contribution identique n'est comptée qu'une fois.
    - Ne sont classées que les œuvres artist, project ou track du catalogue, avec un score > 0.
    - Raisons dédoublonnées, triées selon la locale `fr`.
    - Tri par score décroissant, puis par identité croissante (ordre des octets UTF-8), puis
      troncature aux 60 premières.
- **Critères d'acceptation :**
  - [ ] Chaque cas de `mobile/test/affinity.test.ts` donne les mêmes scores, raisons et ordre.
  - [ ] Une arête vers une identité inconnue, non-genre ou non recommandable est ignorée.
  - [ ] Avec 61 candidats ou plus, 60 sont renvoyés. Une sélection vide renvoie `[]`.
- **Tests attendus :** `AffinityTests` (XCTest pur).
- **pbxproj :** plage `0160–016F`.

#### 343.2 — Choisir la découverte du jour de façon déterministe

- **Tier :** tier/2 · **Diff :** ~190 lignes, 3 fichiers · **Dépend de :** 343.1 ·
  **Parallélisable :** oui.
- **Portée :**
  - `ios/Track1/Recommendation/DailyRecommendation.swift` (nouveau).
  - `ios/Track1Tests/Recommendation/DailySelectionTests.swift` (nouveau).
  - pbxproj.
- **Contrat :**
  - `struct DailyRecommendation: Codable, Equatable, Sendable`, avec :
    - `recommendationID: UUID`, `localDate: String`, `profileRevision: Int` ;
    - `nodeID: NodeIdentity`, `nodeType: NodeType`, `name: String`, `teaser: String?`,
      `reasons: [String]` ;
    - `var viewRecorded: Bool`.

    Clés JSON en snake_case, comme le RN.
  - `enum DailySelection`, qui expose :
    - `fnv1a32(_: String) -> UInt32`, sur les octets UTF-8 ;
    - `localDate(for: Date, timeZone: TimeZone) -> String`, au format `yyyy-MM-dd`, calendrier
      grégorien, locale POSIX ;
    - `pick(candidates:history:localID: UUID, localDate:) -> AffinityCandidate?`.
  - Règle de `pick` :
    1. Les identités vues sont celles de l'historique hors date courante.
    2. Les éligibles sont les candidats non vus, ou tous les candidats si aucun n'est non vu.
    3. Index = `fnv1a32("<localID en minuscules>:<localDate>") % éligibles.count`.
    4. nil s'il n'y a aucun candidat.
- **Critères d'acceptation :**
  - [ ] `fnv1a32("") == 0x811c9dc5`, `fnv1a32("a") == 0xe40c292c`,
    `fnv1a32("00000000-0000-4000-8000-000000000000:2026-10-10") == 0x0e4f82cb`,
    `fnv1a32("Sigur Rós") == 0x3471c54a`.
  - [ ] `localDate(2026-10-10T23:30:00Z, Europe/Paris) == "2026-10-11"` ;
    `America/Los_Angeles` → `"2026-10-10"`.
  - [ ] Les cas de sélection de `mobile/test/daily.test.ts` (déjà vus exclus, recyclage, indexation
    dans le groupe éligible) choisissent la même œuvre.
  - [ ] Un aller-retour JSON conserve exactement les clés snake_case.
- **Tests attendus :** `DailySelectionTests` (XCTest pur).
- **pbxproj :** plage `0170–017F`.

#### 343.3 — Conserver l'historique des découvertes sur l'iPhone

- **Tier :** tier/2 · **Diff :** ~190 lignes, 3 fichiers · **Dépend de :** 343.2 ·
  **Parallélisable :** oui avec les Parties 1, 2 et 4.
- **Portée :**
  - `ios/Track1/Recommendation/DailyRecommendationStore.swift` (nouveau).
  - `ios/Track1Tests/Recommendation/DailyRecommendationStoreTests.swift` (nouveau).
  - pbxproj.
- **Contrat :**
  - `actor DailyRecommendationStore`, avec :
    - `init(localStore: LocalStore, resetBeforeUse: Bool = false)` ;
    - `func history() async -> [DailyRecommendation]` ;
    - `func save(_: [DailyRecommendation]) async -> Result<Void, LocalStoreError>` ;
    - `func markViewed(_: UUID) async -> Result<Void, LocalStoreError>`.
  - Fichier `daily-recommendation.v1.json` géré par `LocalStore`, au format
    `{"version":1,"history":[…]}`.
  - `save` garde les 40 dernières entrées.
  - Fichier absent, illisible, corrompu ou de version ≠ 1 → historique vide, écrasé à la
    sauvegarde suivante (donnée dérivée : un blocage n'aurait aucune issue pour l'utilisateur).
  - `resetBeforeUse` supprime le fichier au premier accès, comme `ProfileStore`.
- **Critères d'acceptation :**
  - [ ] Sauver, puis relire avec un nouvel acteur sur le même répertoire → historique identique.
  - [ ] 41 entrées sauvées → 40 relues, la plus ancienne retirée.
  - [ ] JSON corrompu ou `version: 2` → `[]`, et la sauvegarde suivante réussit.
  - [ ] Avec `LocalStore(failNextWriteNamed: "daily-recommendation.v1.json")`, l'écriture renvoie
    `.failure(.unavailable)` et l'historique précédent reste intact.
  - [ ] `markViewed` ne modifie que l'entrée visée. `resetBeforeUse` vide l'historique.
- **Tests attendus :** `DailyRecommendationStoreTests`, avec un `LocalStore` réel sur un
  répertoire temporaire.
- **pbxproj :** plage `0180–018F`.

#### 343.4 — Servir des fixtures de lecture aux tests UI du simulateur

- **Tier :** tier/2 · **Diff :** ~200 lignes, 4 fichiers · **Dépend de :** 341.2 ·
  **Parallélisable :** oui (seul fichier commun : `AppContainer.swift` avec 343.6).
- **Portée :**
  - `ios/Track1/App/UITestFixtureReaders.swift` (nouveau, entièrement sous
    `#if targetEnvironment(simulator)`).
  - `AppContainer.swift`, branche simulateur :
    `readers = UITestFixtureReaders.make(environment: processInfo.environment) ?? .live(apiClient)`.
  - `ios/Track1Tests/UITestFixtureReadersTests.swift` (nouveau, groupe `A3…0006`).
  - pbxproj.
- **Contrat :**
  - `enum UITestFixtureReaders { static func make(environment: [String: String]) -> ContentReaders? }`.
  - Actif si `TRACK1_UI_TEST_FIXTURES_JSON` **ou** `TRACK1_PROFILE_CATALOG_JSON` est présent ;
    sinon nil.
  - Schéma de `TRACK1_UI_TEST_FIXTURES_JSON` :

    ```
    { "nodes":       { "<identité>": <corps JSON de GET /nodes/{id}> },
      "unavailable": ["<identité>"],
      "links":       { "<identité>": <corps JSON de GET /nodes/{id}/links> },
      "search":      { "<requête trimée en minuscules>": <corps JSON de GET /search> } }
    ```

  - Réponses :

    | Lecteur | Cas | Réponse |
    | --- | --- | --- |
    | `catalog` | `TRACK1_PROFILE_CATALOG_JSON` présent | décodage de ce JSON |
    | `catalog` | sinon | `.failure(.network)` |
    | `node` | identité connue | `.success` |
    | `node` | identité dans `unavailable` | `.failure(.http(status: 503, code: "node_unavailable", retryable: true, retryAfterSeconds: nil))` |
    | `node` | identité inconnue | `.failure(.http(status: 404, code: "not_found", retryable: false, retryAfterSeconds: nil))` |
    | `image` | toujours | `.failure(.http(status: 503, code: "image_unavailable", retryable: true, retryAfterSeconds: nil))` |
    | `links` | identité connue | `.success` |
    | `links` | sinon | `.failure(.network)` |
    | `search` | requête connue | `.success`, hits filtrés par `type` si fourni |
    | `search` | requête inconnue | `.success` avec 0 hit |
    | tous | JSON malformé | `.failure(.invalidResponse)`, sans crash |

- **Critères d'acceptation :**
  - [ ] Sans aucune des deux variables, `make` renvoie nil.
  - [ ] Chaque ligne du tableau de réponses est vérifiée.
  - [ ] Aucun `URLProtocol`, aucune `Task {}` non structurée, aucun état global, aucune vue ni
    argument de lancement n'est ajouté (revue, voir D3).
  - [ ] Les tests UI existants restent verts.
- **Tests attendus :** `UITestFixtureReadersTests` (XCTest).
- **pbxproj :** plage `0190–019F`.

#### 343.5 — Calculer et mémoriser la découverte du jour

- **Tier :** tier/2 · **Diff :** ~270 lignes, 3 fichiers · **Dépend de :** 343.3 (et 341.1 pour
  `NavigationContext`) · **Parallélisable :** oui avec les Parties 1, 2 et 4.
- **Portée :**
  - `ios/Track1/Features/Today/TodayViewModel.swift` (nouveau, groupe `Today` sous `A3…0013`).
  - `ios/Track1Tests/Recommendation/TodayViewModelTests.swift` (nouveau).
  - pbxproj.
- **Contrat :**
  - `enum TodayState: Equatable { case loading, recommendation(DailyRecommendation), emptyCatalog, unavailable }`.
  - `@MainActor @Observable final class TodayViewModel`, avec :
    - `init(readCatalog: @escaping @Sendable () async -> APIResult<Catalog>, store: DailyRecommendationStore, now: @escaping () -> Date = { .now }, timeZone: @escaping () -> TimeZone = { .current }, makeID: @escaping () -> UUID = UUID.init, recordEvent: NodeEventRecorder? = nil)` ;
    - `private(set) var state: TodayState` ;
    - `func load(for profile: Profile) async` ;
    - `func recordImpressionIfNeeded() async` ;
    - `func discover() async -> (identity: NodeIdentity, context: NavigationContext)?`.
  - Étapes de `load` :
    1. Calculer la date locale.
    2. Lire l'historique.
    3. Si l'entrée de la date a `profileRevision == profile.revision`, la montrer sans lire le
       catalogue.
    4. Sinon, lire le catalogue. En cas d'échec → `.unavailable`.
    5. Classer avec `Affinity.rank`. Aucun candidat → `.emptyCatalog`.
    6. Choisir avec `DailySelection.pick`, sur `profile.localID` et `profile.genreIDs`.
    7. Construire une nouvelle `DailyRecommendation` avec `viewRecorded: false`.
    8. Sauver l'historique sans la date courante, plus la nouvelle entrée. Échec → `.unavailable`,
       rien n'est exposé.
    9. En cas de succès → `.recommendation`.
  - `recordImpressionIfNeeded` : si `!viewRecorded`, émet `daily_recommendation_viewed` puis
    appelle `markViewed`. Le marqueur est posé même si l'analytics est refusée : pas de rattrapage
    après un consentement ultérieur.
  - `discover` : émet `daily_recommendation_opened` à chaque appel et renvoie
    `(nodeID, NavigationContext(source: .home, recommendationID:))`.
  - Propriétés des événements : `recommendation_id` (minuscules), `local_date`, `node_id`,
    `node_type` ; source `.home`.
- **Critères d'acceptation :**
  - [ ] Même date et même révision : deux `load` sur des instances recréées (VM et store, même
    répertoire) donnent le même `recommendationID`, avec une seule lecture du catalogue.
  - [ ] Catalogue en échec : `.unavailable` sans entrée du jour, `.recommendation` avec.
  - [ ] Révision changée le même jour → nouvel ID, et une seule entrée pour la date dans
    l'historique.
  - [ ] Aucun candidat → `.emptyCatalog`. Écriture en échec → `.unavailable`, aucune recommandation
    exposée.
  - [ ] `recordImpressionIfNeeded` appelé 2 fois, puis après redémarrage → un seul `viewed`.
    `discover` appelé 2 fois → 2 `opened`. Tout est accepté par `AnalyticsValidation.accepts`.
  - [ ] Horloge `2026-10-10T23:30Z` et fuseau Europe/Paris → `localDate == "2026-10-11"`.
- **Tests attendus :** `TodayViewModelTests` (XCTest), avec un store réel sur répertoire temporaire,
  le catalogue en closure, et horloge, fuseau et ID injectés. Reprendre les cas pertinents de
  `mobile/test/daily.test.ts` et `mobile/test/today.test.tsx`.
- **pbxproj :** plage `01A0–01AF`.

#### 343.6 — Afficher la découverte du jour et ouvrir sa fiche

- **Tier :** tier/2 · **Diff :** ~200 lignes, 5 fichiers · **Dépend de :** 343.5, 343.4 (et
  341.2) · **Parallélisable :** oui avec 348.x (conflit mécanique sur `RootView.swift`).
- **Portée :**
  - `ios/Track1/Features/Today/TodayView.swift` (nouveau).
  - `RootView.swift` : dans `TodayEntryView`, le cas `.profile(let profile)` rend `TodayView` ; le
    bouton « Découvrir » appelle `router.openNode(identity, context:, in: .today)`.
  - `AppContainer.swift` : `dailyRecommendationStore` partageant le `LocalStore` existant. Sur
    simulateur, l'argument `-track1-reset-daily-recommendation` donne `resetBeforeUse: true`.
  - `ios/Track1UITests/TodayFlowTests.swift` (nouveau).
  - pbxproj.
- **Contrat de la vue :** `.task(id: profile.revision) { await model.load(for: profile) }`. États :
  - **chargement** ;
  - **recommandation** : type, nom (`today-recommendation-name`), accroche, raisons, bouton
    « Découvrir » (`today-discover`) ; impression enregistrée à l'apparition ;
  - **`.emptyCatalog`** : « Aucune découverte pour ces goûts » et bouton « Explorer la recherche » ;
  - **`.unavailable`** : « Découverte indisponible » et bouton « Réessayer » (`today-retry`).
- **Critères d'acceptation :**
  - [ ] XCUITest, premier parcours :
    1. Consentement refusé.
    2. Onboarding avec 3 genres du catalogue fixture, qui relie des artistes aux genres par des
       arêtes `genres`.
    3. Aujourd'hui affiche `today-recommendation-name`.
    4. « Découvrir » ouvre la fiche du même nom, puis retour.
    5. Relance sans arguments de réinitialisation → même nom.
  - [ ] XCUITest : un catalogue fixture sans œuvre liée affiche « Aucune découverte pour ces
    goûts ».
  - [ ] `NavigationTests`, `ProfileFlowTests` et `ConsentTests` restent verts.
- **Tests attendus :** `TodayFlowTests` (XCUITest, fixtures de 343.4 et
  `TRACK1_PROFILE_CATALOG_JSON`).
- **pbxproj :** plage `01B0–01BF`.

### Partie 4 — Rechercher les cinq types de contenus (TRA-348)

Incrément visible : l'onglet Recherche remplace son écran d'attente et ouvre les fiches. C'est le
seul parcours UI de bout en bout fiche → relation → retour.

- [ ] TRA-? (348.1) Rechercher avec temporisation, filtres et réponses ordonnées
- [ ] TRA-? (348.2) Afficher la recherche et ouvrir les fiches trouvées

**Contrat réduit de TRA-348.**
- *Conservé :*
  - `q` de 2 à 120 caractères après trim, temporisation de 300 ms ;
  - filtres all, artist, project, track, genre et label ;
  - annulation ou abandon des réponses obsolètes ;
  - un hit de cache ouvre la fiche, un hit absent est signalé sans POST ;
  - `search_submitted` et `search_result_opened` exacts, sans la saisie ;
  - consentement respecté.
- *Retiré :* proposition de création (TRA-349, hors V1) ; Figma 32:69 ; recherche locale P4.4 ;
  `SearchResultsView.swift` séparé (une seule vue suffit).

#### 348.1 — Rechercher avec temporisation, filtres et réponses ordonnées

- **Tier :** tier/2 · **Diff :** ~290 lignes, 3 fichiers · **Dépend de :** 341.1 ·
  **Parallélisable :** oui dès 341.1.
- **Portée :**
  - `ios/Track1/Features/Search/SearchViewModel.swift` (nouveau, groupe `Search` sous `A3…0013`).
  - `ios/Track1Tests/SearchTests.swift` (nouveau).
  - pbxproj.
- **Contrat :**
  - `enum SearchFilter: String, CaseIterable, Sendable { case all, artist, project, track, genre, label; var nodeType: NodeType? }`.
  - `enum SearchPhase: Equatable, Sendable { case idle, tooShort, tooLong, loading, results, empty, failed }`.
  - `enum SearchOpening { case node(NodeIdentity, NavigationContext), missing(name: String, type: NodeType) }`.
  - `@MainActor @Observable final class SearchViewModel`, avec :
    - `init(search: @escaping @Sendable (String, NodeType?) async -> APIResult<SearchResponse>, sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }, recordEvent: NodeEventRecorder? = nil)` ;
    - `var query: String` et `var filter: SearchFilter`, dont chaque modification replanifie la
      recherche ;
    - `private(set) var phase`, `private(set) var hits: [SearchHit]` ;
    - `func retry()` ;
    - `func open(_: SearchHit) -> SearchOpening`.
  - Règles de recherche :
    - Chaque modification annule la tâche en attente, puis attend `sleep(300 ms)`.
    - Requête = saisie trimée, longueur mesurée en `utf16.count`, comme le serveur.
    - Vide → `.idle` ; 1 caractère → `.tooShort` ; plus de 120 → `.tooLong`. Aucun appel dans ces
      trois cas.
    - Sinon : `.loading`, `search_submitted {filter}`, puis l'appel.
    - Une réponse n'est appliquée que si elle porte le dernier numéro de requête émis.
    - Hits → `.results` ; aucun hit → `.empty` ; échec → `.failed`.
    - `retry` relance immédiatement la dernière requête valide.
  - Règles de `open` (aucune requête réseau) :
    - hit `source == "cache"` avec `slug` → `.node(slug, .independent(source: .search))` et
      `search_result_opened {node_type, availability: "cached", results_count, node_id}` ;
    - sinon → `.missing` et `search_result_opened {node_type, availability: "missing", results_count}`.
- **Critères d'acceptation :**
  - [ ] `""`, `" a "` et 121 caractères → aucun appel, phases respectives `.idle`, `.tooShort`,
    `.tooLong`. `" ab "` → appel avec `"ab"`.
  - [ ] « ab », « abc », « abcd » saisis avant l'échéance → un seul appel (« abcd ») et un seul
    `search_submitted`.
  - [ ] La réponse de « abc » arrivée après celle de « abcd » n'est jamais appliquée.
  - [ ] Un changement de filtre relance l'appel avec `type` ; `.all` → `type` nil.
  - [ ] Échec → `.failed`, puis `retry` → nouvel appel et `.results`.
  - [ ] `open` donne le résultat attendu pour un hit de cache et un hit de catalogue, avec
    l'événement exact. Aucune valeur de propriété n'est égale à la saisie.
    `AnalyticsValidation.accepts` est vrai.
- **Tests attendus :** `SearchTests` (XCTest). `sleep` est contrôlé par le test (suspendu jusqu'à
  libération) et `search` est une closure à réponses différées. Reprendre les cas de
  `mobile/test/search.test.tsx` ; la route serveur `test/mobile/search.test.ts` n'est pas modifiée.
- **pbxproj :** plage `01C0–01CF`.

#### 348.2 — Afficher la recherche et ouvrir les fiches trouvées

- **Tier :** tier/2 · **Diff :** ~240 lignes, 6 fichiers · **Dépend de :** 348.1, 343.4, 341.4 ·
  **Parallélisable :** oui avec 343.6 (conflit mécanique sur `RootView.swift`).
- **Portée :**
  - `ios/Track1/Features/Search/SearchView.swift` (nouveau).
  - `RootView.swift` : l'onglet Recherche rend `SearchView` à la place de `EntryView`. `.node`
    appelle `router.openNode(…, in: .search)` ; `.missing` affiche un message.
  - `ios/Track1UITests/SearchFlowTests.swift` (nouveau).
  - `ios/Track1UITests/NavigationTests.swift` : remplacer les assertions `entry-status-search`,
    `entry-status-description-search` et « Cette entrée est prête… » côté Recherche par un parcours
    sur fixture.
  - `ios/Track1UITests/ProfileFlowTests.swift` : `entry-status-search` devient `search-field`.
  - pbxproj.
- **Contrat de la vue :**
  - `TextField` « Rechercher » (`search-field`), sans `.searchable`.
  - `Picker` en style menu (`search-filter`), libellés Tout / Artistes / Albums / Titres / Genres /
    Labels.
  - `List` de `Button` affichant nom, type et sous-titre.
  - Messages par phase :
    - `.idle` : « Saisissez au moins 2 caractères. » ;
    - `.tooLong` : « Recherche limitée à 120 caractères. » ;
    - `.empty` : « Aucun résultat » ;
    - `.failed` : « Recherche indisponible » et bouton « Réessayer » (`search-retry`).
  - `.missing` : message en ligne « <nom> n'a pas encore de fiche dans track1. »
    (`search-missing-message`), sans navigation ni requête.
- **Critères d'acceptation (XCUITest sur fixtures) :**
  - [ ] Requête de fixture → résultat → fiche (nom visible) → relation → fiche liée → retour →
    fiche d'origine.
  - [ ] Un hit de catalogue sans fiche affiche `search-missing-message`, sans navigation.
  - [ ] Un hit de cache dont l'identité est dans `unavailable` affiche `node-failed` et
    `node-retry`. Une relation vers une identité absente des fixtures affiche `node-missing`.
  - [ ] `NavigationTests` adapté : la pile Recherche (fiche ouverte) survit à un changement
    d'onglet. En mode sombre avec taille XXXL, `search-field` est présent.
  - [ ] `ProfileFlowTests` et `ConsentTests` restent verts.
- **Tests attendus :** `SearchFlowTests` et les deux fichiers XCUITest adaptés.
- **pbxproj :** plage `01D0–01DF`.

### Partie 5 — Installer et archiver un build iOS signé (TRA-337)

Incrément indépendant du code applicatif. 337.1 peut être mergée dès maintenant ; 337.2 clôt la V1.

- [ ] TRA-? (337.1) Produire une archive Preview signée par un script reproductible
- [ ] TRA-? (337.2) Installer la V1 sur l'iPhone de Raphael et consigner la preuve

**Contrat réduit de TRA-337.**
- *Conservé :*
  - archive native signée et reproductible, installée sur un iPhone réel ;
  - bundle, équipe et profil vérifiés ;
  - aucune clé privée ni certificat dans le dépôt ;
  - échec explicite si la configuration manque ;
  - chemin de renouvellement documenté.
- *Retiré :* entitlement APNs (pas de rappel en V1) ; secrets et signature en CI ;
  TestFlight / App Store Connect (Partie 6) ; modification du pbxproj, des schémas et des
  `.xcconfig`.

#### 337.1 — Produire une archive Preview signée par un script reproductible

- **Tier :** tier/3 (moins de 200 lignes) · **Diff :** ~190 lignes, 3 fichiers · **Dépend de :** — ·
  **Parallélisable :** oui, dès maintenant.
- **Portée :**
  - `ios/scripts/archive.sh` (nouveau).
  - `ios/Configurations/ExportOptions-Preview.plist` (nouveau).
  - `test/ios-archive.test.ts` (nouveau, vitest, outils substitués sur `PATH` comme dans
    `test/ios-check.test.ts`).
- **Hors-scope :** `project.pbxproj`, `.xcconfig`, schémas, entitlements, `ios/scripts/check.sh`,
  `.github/`, secrets.
- **Contrat :** `TRACK1_TEAM_ID=<Team ID> TRACK1_API_BASE_URL=<URL https> ios/scripts/archive.sh [répertoire de sortie]`. Étapes :
  1. **Contrôles préalables.** Avant tout `xcodebuild archive`, le script sort en code ≠ 0 avec un
     message explicite dans trois cas :
     - le Xcode actif diffère de `ios/.xcode-version` ;
     - `TRACK1_TEAM_ID` est absent ou ne respecte pas `^[A-Z0-9]{10}$` ;
     - `TRACK1_API_BASE_URL` est absente, n'est pas en `https://`, contient des identifiants ou un
       port explicite, ou se termine par `.example` ;
     - l'arbre git a des modifications non commitées.
  2. **Archive.**
     `xcodebuild archive -project ios/Track1.xcodeproj -scheme Track1Preview -configuration Preview -destination generic/platform=iOS -allowProvisioningUpdates CODE_SIGNING_ALLOWED=YES CODE_SIGNING_REQUIRED=YES CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM=$TRACK1_TEAM_ID TRACK1_API_BASE_URL=$TRACK1_API_BASE_URL CURRENT_PROJECT_VERSION=<AAAAMMJJHHMM UTC>`.
  3. **Export.** Copie de `ExportOptions-Preview.plist` (`method = release-testing`,
     `signingStyle = automatic`), avec `teamID` injecté par `plutil`, puis
     `xcodebuild -exportArchive`.
  4. **Vérification.** `codesign -d` sur l'`.app` exportée : l'identifiant doit être
     `com.dropcliffs.track1.preview` et l'équipe `TRACK1_TEAM_ID`, sinon échec.
  5. **Affichage.** SHA git, version, build, URL d'API utilisée et chemin de l'IPA.

  Les outils sont appelés via `PATH` (`xcodebuild`, `plutil`, `codesign`, `git`). Le script ne lit
  ni n'écrit aucun secret. Sa sortie par défaut va dans un répertoire temporaire, hors du dépôt.
- **Critères d'acceptation :**
  - [ ] Team ID absent ou invalide, URL d'API absente ou non conforme, Xcode différent ou arbre sale : code ≠ 0, message explicite, et
    `xcodebuild archive` jamais appelé.
  - [ ] Cas nominal : la commande d'archive contient exactement le schéma, la configuration,
    `-allowProvisioningUpdates`, `DEVELOPMENT_TEAM` et la valeur de `TRACK1_API_BASE_URL` ; aucun hôte n'est écrit en dur dans le
    script. L'export reçoit un plist
    avec `teamID` et `method = release-testing`.
  - [ ] Un `codesign` qui rapporte une autre équipe ou un autre identifiant provoque un échec.
  - [ ] `ios/scripts/check.sh` et `.github/workflows/ios-ci.yml` sont inchangés : la CI reste sans
    signature.
- **Tests attendus :** `test/ios-archive.test.ts`, exécutable sous Linux par `npm run test`.

#### 337.2 — Installer la V1 sur l'iPhone de Raphael et consigner la preuve

- **Tier :** tier/3 · **Diff :** ~90 lignes, 2 fichiers · **Dépend de :** 337.1 et de toutes les
  tâches requises des Parties 1 à 4 · **Parallélisable :** non (dernière tâche).
- **Prérequis opérationnels (Raphael) :** compte Apple Developer connecté dans Xcode sur le Mac,
  iPhone enregistré dans l'équipe, Team ID.
- **Portée :**
  - `docs/track1-native-release.md` (nouveau).
  - `docs/track1-builds.md` : section « Build installable V1 » qui renvoie au nouveau document.
- **Contenu attendu de `docs/track1-native-release.md` :**
  - prérequis et commande ;
  - installation (Xcode > Devices and Simulators, ou Apple Configurator) ;
  - renouvellement : profils gérés par `-allowProvisioningUpdates`, expiration ad hoc, ajout d'un
    appareil = enregistrement puis nouvelle archive ;
  - absences volontaires de la V1 : APNs, TestFlight, clé Segment ;
  - tableau de preuve rempli avec les valeurs observées : date UTC, SHA de `main`, version et build,
    bundle, Team ID, modèle d'iPhone et version d'iOS, résultat de chaque étape du smoke V1 (voir
    les critères de sortie).
- **Critères d'acceptation :**
  - [ ] Le tableau ne contient que des valeurs réellement observées, pour un SHA de `main`
    postérieur au merge de 348.2.
  - [ ] Chaque étape du smoke est « OK », ou un ticket de bug est ouvert pour chaque étape en échec.
  - [ ] La PR n'ajoute aucun `.p8`, `.p12`, `.mobileprovision` ni bloc `PRIVATE KEY`.
- **Tests attendus :** la preuve manuelle consignée. L'agent rédige, Raphael exécute et remplit ;
  la PR n'est mergée qu'avec les valeurs.

## Risques

- **R1 — CI aveugle et runner unique.** Il n'y a qu'un runner macOS self-hosted : deux schémas,
  tests unitaires et UI à chaque push. Garde-fous : tâches de moins de 300 lignes ; 3 PR iOS ouvertes
  au plus ; XCUITest limités à 343.6 et 348.2 ; logique couverte en XCTest pur ; tests de scripts
  exécutables sous Linux (vitest).
- **R2 — pbxproj corrompu par des tâches parallèles.** Garde-fous : plages d'ID réservées (D5),
  réconciliation des lignes uniques par insertion, et `ios-check` qui compile chaque PR. Si deux
  PR modifient le même groupe, celle qui merge en second rebase avant de demander sa relecture.
- **R3 — Vues exécutées tard.** Les vues de fiche ne sont exécutées en UI qu'à 343.6. Garde-fous :
  logique dans les VM testées ; vues triviales en composants système ; 348.2 couvre aussi la fiche
  si la Partie 3 glisse.
- **R4 — Cause de l'échec XCUITest de #317 non confirmée.** Garde-fous : harnais supprimé ; motifs
  suspects interdits par 343.4 ; en cas d'échec UI, lire l'xcresult (`ios-xcresult-<run>-<attempt>`)
  avant tout correctif, et ne pas réessayer à l'aveugle.
- **R5 — L'iPhone parle à l'API de production (aujourd'hui sur `dropcliffs.com`).** Garde-fous : lecture seule par
  construction (D2), aucun POST possible. `/image` et `/links` peuvent déclencher des résolveurs
  côté serveur, sans génération LLM ; le volume est négligeable pour un seul appareil.
- **R6 — Signature.** Elle dépend du compte de Raphael ; les profils ad hoc expirent et un nouvel
  appareil impose une nouvelle archive. Garde-fous : échec explicite du script, procédure de
  renouvellement documentée (337.2).
- **R7 — Mesure invisible en V1.** Sans clé Segment, les événements sont calculés et filtrés par le
  consentement mais jamais envoyés. C'est accepté : la vérification Amplitude reste TRA-315, en
  pause.
- **R8 — Travail jeté par le Figma.** Garde-fous : vues minimales ; logique dans les VM et les
  fonctions pures, réutilisables ; identifiants d'accessibilité limités aux tests.
- **R9 — Fiche invisible pour l'utilisateur avant la Partie 3.** C'est accepté pour respecter
  l'ordre du brief : aucune régression, les onglets existants sont inchangés.

## Critères de sortie

1. Sur `main` : 341.1–341.4, 342.1–342.2, 343.1–343.6, 348.1–348.2 et 337.1–337.2 mergées (341.5
   si elle est conservée au gate). `ios-check`, `test`, `lint` et `typecheck` sont verts après le
   dernier merge.
2. Smoke V1 consigné dans `docs/track1-native-release.md`, sur une archive Preview de `main`
   installée sur l'iPhone de Raphael :
   1. Premier lancement : le choix analytics s'affiche ; après un refus, l'app reste utilisable.
   2. Onboarding avec 3 genres : Aujourd'hui affiche une découverte avec ses raisons.
   3. « Découvrir » ouvre la fiche. L'article est lisible, une source s'ouvre dans Safari, une
      relation s'ouvre, puis le retour fonctionne.
   4. Spotify et Apple Music s'ouvrent dans l'application installée, ou sur le site sinon ; le
      retour dans track1 conserve la fiche.
   5. Recherche « ambient » avec le filtre Genres : la fiche s'ouvre. Un résultat sans fiche est
      signalé, sans création.
   6. Fermer et relancer le même jour redonne la même découverte ; modifier les goûts en donne une
      nouvelle.
3. Aucun écran ne peut émettre `POST /mobile/v1/generations` : `ContentReaders` n'a aucun membre
   d'écriture, et `git grep createGeneration ios/Track1` ne trouve rien hors de
   `ios/Track1/API/APIClient.swift`.
4. Les parents TRA-341, TRA-342, TRA-343, TRA-348 et TRA-337 sont fermés avec leur contrat réduit.
   Les tickets en pause ou hors V1 ne sont pas modifiés.
