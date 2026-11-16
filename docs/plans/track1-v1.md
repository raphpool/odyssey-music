# track1 v1 — app iOS, de la maquette Figma « v1 » à une build TestFlight

Plan rédigé le 2026-11-16 (phase `plan` de `/delivery-process`). **Statut : en attente de validation
par Raphael. Aucun ticket Linear n'existe encore.**

Source de vérité design : Figma `phudxrQNlzQJafXLma4FyX`, section `362:4977` (« v1 »).
Priorités du brief : partage avec deeplink = **P2**, notifications = **P1**, tout le reste = **P0**.
Objectif : une build **TestFlight partageable avec des amis**.

Lecture du dépôt : cartographie bornée faite en lecture seule (structure `ios/`, workflows,
`docs/track1-builds.md`, `docs/track1-api.md`). Les chemins cités ci-dessous ont été vérifiés.

## Problème

L'app iOS native (`ios/`) montre aujourd'hui : consentement → Welcome → sélection des genres →
onglet Aujourd'hui dont la racine est une **fiche de nœud avec arêtes**, un onglet Genres en lecture
seule (tuiles + feuille d'édition), une **recherche** en feuille. Elle n'est distribuée nulle part :
`ios/scripts/archive.sh` produit une IPA ad hoc sur le Mac de Raphael, aucune build TestFlight n'a
jamais été envoyée, et toute la CI tourne sur des runners auto-hébergés.

La section Figma « v1 » rescope le produit (note `362:4978`) : **on enlève la recherche et les fiches
de nœud avec arêtes, on ajoute la création de profil dans l'onboarding**, l'accueil devient une
carte du jour, et la lecture devient un « lecteur » de texte phrase par phrase.

Le dépôt `raphpool/odyssey-music` est désormais **public**. Deux conséquences :

1. Les runners hébergés par GitHub sont utilisables sans limite de minutes : la CI n'a plus à
   faire la queue sur un seul Mac (`docs/track1-builds.md` interdit aujourd'hui `xcodebuild` en
   local parce que « ce Mac héberge les deux runners CI »).
2. **Tous les workflows déclenchés par `pull_request` s'exécutent aujourd'hui sur des runners
   auto-hébergés** (`runs-on: [self-hosted, linux]` et `[self-hosted, macOS, ARM64, ios]`). Sur un
   dépôt public, une PR venue d'un fork y exécute `npm ci` et les scripts de la PR. C'est un risque
   ouvert dès maintenant, indépendant de la v1 (voir R1).

### Inventaire de la section Figma `362:4977`

13 écrans (dont 1 masqué) et 13 notes de spec. Chaque ligne est couverte par une tâche.

| Node | Écran | Note de spec (node, texte) | Couvert par |
| --- | --- | --- | --- |
| `362:4978` | Note « Rescope » | « on enlève la search, on enlève les nodes pages telles qu'elles étaient avant avec les arêtes, ajout de création de profil dans l'onboarding » | 3.3, 3.4, 5.9, 5.10, 5.11, Partie 4 |
| `316:4853` | 1.1 Welcome (icône d'app, « track1 », tagline, « Démarrer ») | `362:4993` « accélérer légèrement l'animation du fond, ajouter app icon + polish » | 3.1, 4.7 |
| `362:1766` | Pseudo, champ vide (placeholder « Slim Shady », clavier) | `362:5001` (copie de la note Welcome, voir Q7) | 4.4 |
| `362:2894` | Pseudo, champ rempli (« Raph », touche retour active) | `362:5009` « l'user confirme son pseudo avec la touche entrée » | 4.4 |
| `362:3008` | Disque de profil, rien de choisi (« Continuer » désactivé) | `362:5017` « le disque cliqué glisse et grossit pour se loger dans le slot » | 4.2, 4.5 |
| `362:3145` | Disque de profil, un disque choisi | `362:5025` « un autre clic remplace le disque, l'ancien revient à sa place ; Continuer devient actif » | 4.5 |
| `316:5066` | Sélection des genres (accordéons, « Total : 1 genre ») | `362:5033` « polish UI ; au défilement retour haptique » | 4.8 |
| `317:5142` | Opt-in notifications | `362:5081` « Continuer ouvre la modale native » | Partie 7 (P1) |
| `324:1788` | Accueil du jour (date, genres, pochette, type, titre, « Découvrir ») | `362:5089` (pictos et couleurs par type, plus d'artistes, Découvrir → lecteur) | 5.1, 5.2, 5.5, 5.6, 5.9 |
| `362:1611` | Accueil, variante ARTIST — **calque masqué** | — | Hors scope (« plus d'artistes ») |
| `338:2461` | Lecteur (texte défilant, barre collante, retour, partage) | `362:5111` | 5.3, 5.4, 5.7, 5.8, 5.9 ; partage = Partie 8 (P2) |
| `318:6513` | Splash | `370:1842` « à utiliser s'il reste des éléments à charger » | 3.1, 3.2 |
| `318:6781` | Onglet Genres = profil (disque, pseudo, genres éditables, ancienneté) | `370:1847` « même layout que la sélection de l'onboarding, modifiable ici » | Partie 6 |
| `324:1792` | Barre d'onglets : 2 onglets, 3e masqué, plus de bouton recherche | — | 3.3 |

## Non-buts

- Sortie publique App Store, fiche App Store, captures : ce plan s'arrête à TestFlight.
- Android, le client Expo `mobile/` (gelé), le pipeline de génération, `cache/`, `web/`.
- Compte utilisateur ou profil côté serveur : pseudo, disque et genres **restent sur l'iPhone** et
  ne partent ni vers l'API ni vers l'analytics.
- Activation du transport APNs serveur (`src/mobile/apns-sender.ts`, TRA-344/345) : le code reste
  en place, désactivé, non modifié (voir D4).
- Suppression de la recherche **côté serveur** (`src/mobile/search.ts`, route `/mobile/v1/search`) :
  inchangée.
- Refonte de l'écran de consentement (`PrivacyChoiceView`) et des Réglages (`SettingsView`) : hors
  maquette, conservés tels quels (voir Q5).
- Migration des workflows `deploy.yml`, `pull-cache.yml`, `sync-genre-cache.yml`,
  `top-up-genres.yml` : déclenchés uniquement par `push` sur `main` ou `workflow_dispatch`, ils
  restent sur les runners auto-hébergés.
- Refonte du modèle de confiance de `review-gate` (statuts `codex-review` liés au compte de
  `.github/review-gate-authors.txt`) : voir Q3 et la tâche conditionnelle 1.5.
- iPad, mode clair, catalogue de chaînes localisé, relèvement de la cible iOS 17.

## Décisions d'archi

### D1 — Deux onglets ; le lecteur est une destination poussée dans la pile d'Aujourd'hui

`AppTab` garde `today` et `genres` ; `search` disparaît avec `AppRouter.isSearchPresented`.
`AppRoute.node` est remplacé par `AppRoute.player(identity: NodeIdentity, context: NavigationContext)`.
Le lecteur prend une **identité de nœud**, pas « la recommandation du jour » : le lien entrant du
partage (P2) ouvrira la même destination. La barre d'onglets reste visible sous le lecteur, comme
dans `338:2461`. Le lecteur réutilise `NodeViewModel` (chargement du nœud et des liens, événements
de vue, ouverture Apple Music / Spotify) : aucune seconde couche de données.

**Rejeté :** `fullScreenCover` pour le lecteur (masquerait la barre d'onglets que la maquette
montre, et sortirait la destination de la pile, ce qui complique le lien entrant) ; garder
`NodeView` accessible « derrière » le lecteur (la note Rescope l'exclut).

### D2 — Pseudo, disque et date de création : champs optionnels du `Profile` local, sans changer de version

`Profile` (version 2, `profile.v2.json`) et `ProfileDraft` gagnent `display_name`, `disc` et
(`Profile` seulement) `created_at`, tous optionnels, comme `selection` l'a été. Un fichier existant
sans ces clés continue de se lire comme `.profile`. Aucune donnée ne quitte l'appareil.

**Rejeté :** version 3 avec migration (un profil v2 deviendrait `.unsupportedVersion` sans chemin
de migration, pour trois champs facultatifs) ; un magasin séparé pour l'identité (deux fichiers à
garder cohérents à l'effacement du profil) ; un compte serveur (auth et données personnelles,
hors brief).

### D3 — Lecteur : découpage en phrases et calcul du focus dans `Track1Core`, accroche par un `ScrollTargetBehavior` maison

`ArticleSentences.split` (Foundation, énumération `.bySentences`, plus des règles de nettoyage)
produit un paragraphe par phrase. `PlayerScroll` calcule, à partir des cadres mesurés des
paragraphes, la phrase au centre et le décalage d'accroche. La vue ne fait que mesurer et
dessiner. Le texte ne défile **que** sous le doigt (pas d'auto-défilement).

**Rejeté :** `.scrollTargetBehavior(.viewAligned)` (sur iOS 17 il aligne en haut ; l'ancre au
centre n'existe qu'à partir d'iOS 18, et la cible de déploiement est 17.0) ; découpage par
expression régulière sur `. ` (casse sur « U.K. », « feat. », les décimales) ; une
`UICollectionView` (UIKit dans une app SwiftUI, non testable par `swift test`).

### D4 — Notifications (P1) : notifications **locales** planifiées sur l'appareil, pas le transport APNs serveur

Le choix du jour est calculé sur l'iPhone (`DailySelection.pick`) et le serveur ne connaît ni les
goûts ni le choix. La maquette `317:5226` montre un rappel qui **nomme l'œuvre** (« Aphex Twin,
album Selected Ambient Works 85-92 ») : seul l'appareil peut l'écrire. À chaque chargement
d'Aujourd'hui, l'app calcule et **persiste** les choix des 7 jours suivants, puis programme une
notification locale par jour à 09:00 heure locale. Le jour venu, l'app sert le choix persisté :
ce que dit la notification est ce que montre l'écran. Pas de capacité Push, pas d'entitlement
`aps-environment`, pas de jeton d'appareil, pas de clé APNs à déployer.

**Rejeté :** finir le client APNs prévu par TRA-346 (le serveur n'envoie qu'un texte générique
`DAILY_TITLE` / `DAILY_BODY`, il faut une clé APNs en production, un entitlement, un secret
d'abonnement en trousseau et une recette physique, soit du tier/3 partout pour un résultat moins
fidèle à la maquette) ; une Notification Service Extension qui réécrit le push sur l'appareil
(nouvelle cible, App Group, bien au-delà d'un P1). **Cette décision renverse le choix du
2026-10-05 : elle demande l'accord explicite de Raphael (Q1).** Limite assumée : sans ouverture de
l'app pendant 7 jours, les rappels s'arrêtent jusqu'à la prochaine ouverture.

### D5 — CI : tout ce qui est déclenché par une PR passe sur runners hébergés ; TestFlight par un workflow manuel signé à la main

- Les workflows `pull_request` et `issue_comment` (`ci`, `mobile-ci`, `review-gate`, `ai-review`,
  `claude`, `ios-ci`) passent sur `ubuntu-latest` et sur un runner macOS hébergé. Les noms de jobs
  ne changent pas : la protection de branche (`typecheck`, `lint`, `test`, `diff-size`, `review`)
  reste valide sans réglage.
- TestFlight : un workflow `ios-testflight.yml`, **`workflow_dispatch` seulement, sur `main`
  seulement**, dans un Environment GitHub `testflight` (relecteur requis : Raphael) qui porte les
  secrets. Signature **manuelle** : certificat Apple Distribution (`.p12`) et profil App Store
  importés dans un trousseau temporaire ; envoi par `xcodebuild -exportArchive` avec une clé d'API
  App Store Connect.
- Variante distribuée : configuration `Production`, schéma `Track1`, bundle
  `com.dropcliffs.track1`. L'URL d'API reste fournie au moment de l'archive (variable
  d'Environment), jamais écrite dans un `.xcconfig`.

**Rejeté :** garder les runners auto-hébergés pour les PR en filtrant les forks (ne règle pas la
file d'attente, laisse le Mac exposé à toute erreur de filtre) ; signature automatique « cloud »
avec la seule clé d'API (moins de secrets, mais crée des certificats par API depuis des machines
jetables, comportement jamais vérifié dans ce dépôt, sur le chemin critique) ; `fastlane` (une
dépendance Ruby pour trois commandes `xcodebuild`) ; TestFlight sur la variante `Preview` (une
seconde fiche App Store Connect à jeter ; TRA-319 demandait déjà de garder le bundle de
production) ; déclenchement sur `push` ou sur tag (une build signée ne doit pas partir sans geste
humain).

### D6 — Partage (P2) : lien universel `https` vers une page web servie par le serveur

Le lien partagé est une URL `https://<hôte>/…/s/<type>/<slug>` : sans l'app, elle affiche une page
web avec le contenu du nœud ; avec l'app, iOS l'ouvre dans le lecteur (Associated Domains).
`ShareLink` (dans `Track1Core`) construit et relit l'URL ; une URL entrante est une donnée non
fiable, validée avant usage.

**Rejeté :** schéma `track1://` (illisible sans l'app, non cliquable dans la plupart des
messageries, aucune page de repli alors que la spec demande « une page avec ce contenu ») ; un
service tiers de liens (dépendance et données de partage chez un tiers).

## Découpage

Huit parties, chacune mergeable et déployable seule. `∥` = parallélisable (worktrees simultanés).
Points : 1 ≈ 1–2 h, 2 ≈ 2–4 h, 3 ≈ une demi-journée. Chaque tâche = 1 ticket = 1 PR.

Conventions communes à toutes les tâches iOS :

- Logique sans SwiftUI → `ios/Track1Core/Sources/Track1Core/…`, test dans
  `ios/Track1Core/Tests/Track1CoreTests/…`, vérifiée par `swift test --package-path ios/Track1Core`.
  Aucune entrée pbxproj.
- Fichier d'app ou de test d'app → entrée dans `ios/Track1.xcodeproj/project.pbxproj`, identifiants
  `F1…`/`B1…` de la forme existante. **Plage réservée à ce plan : `0430–04BF`** (dernière plage
  utilisée : `0420–0426`). Chaque tâche reçoit ses identifiants ci-dessous ; aucun nouveau groupe
  pbxproj : les fichiers vont dans des dossiers existants.
- L'app n'est compilée que par `ios-check` : pas de `xcodebuild` local.
- Texte venu du réseau : `Text(verbatim:)`, jamais transformé en lien.
- Police « Inter » du Figma = `Roboto` dans l'app (correspondance en place dans
  `Track1Typography.swift`).
- Lecture du Figma par le MCP uniquement (`get_design_context`, `get_screenshot` avec
  `enableBase64Response`) : `www.figma.com` est refusé par le proxy de l'environnement cloud, les
  URLs d'assets ne se téléchargent pas (R12).

### Partie 1 — CI sur runners hébergés (P0)

Incrément : plus aucun job déclenché par une PR ne tourne sur une machine de Raphael ; les PR iOS
ne font plus la queue derrière un seul Mac. Ordre imposé 1.1 → 1.2 → 1.3 : les trois touchent
`test/native-ci-triggers.test.ts`.

- [ ] TRA-? **1.1 — Faire tourner `ios-check` sur un runner macOS hébergé** — P0, tier/3, 2 pts.
  - Portée : `.github/workflows/ios-ci.yml` (`runs-on` → label macOS hébergé dont l'image fournit
    le Xcode de `ios/.xcode-version`, attendu `macos-26` ; nouvelle étape « Select Xcode » avant
    `ios/scripts/check.sh` ; `timeout-minutes: 45` ; commentaires d'en-tête mis à jour avec la date),
    `test/native-ci-triggers.test.ts` (blocs « ios-check runner label (TRA-411) » et « runner labels
    by workflow (TRA-650) »). Hors scope : `ios/scripts/check.sh`, `ios/.xcode-version`, les autres
    workflows.
  - Contrat : `ios-ci.yml` ne contient plus `self-hosted` ; l'étape « Select Xcode » échoue avec la
    liste des `/Applications/Xcode*.app` présents si la version attendue manque.
  - Critères : le run `ios-check` de la PR elle-même est vert sur le runner hébergé ; `npm run test`
    vert ; déclencheurs et filtre `paths` inchangés (les tests existants du fichier restent verts).
  - Tests : `test/native-ci-triggers.test.ts` réécrit pour le nouveau label.
  - Notes : **règle d'arrêt** — si l'image hébergée n'a pas le Xcode épinglé, ou si deux runs
    consécutifs dépassent 45 min ou échouent au démarrage du simulateur, ne pas toucher
    `.xcode-version` : garder `[self-hosted, macOS, ARM64, ios]`, ajouter
    `github.event.pull_request.head.repo.full_name == github.repository` à la condition du job,
    documenter la mesure dans la PR et le signaler (la tâche 2.4 ciblera alors le même runner).

- [ ] TRA-? **1.2 — Faire tourner les checks Node sur `ubuntu-latest`** — P0, tier/3, 2 pts.
  Dépend de 1.1.
  - Portée : `.github/workflows/ci.yml` (les 6 jobs `typecheck`, `lint`, `test`, `diff-size`,
    `tier-guard`, `integrity`), `.github/workflows/mobile-ci.yml`,
    `.github/workflows/review-gate.yml` ; tests `test/ci-policy.test.ts` (ligne 153),
    `test/ci-integrity-job.test.ts` (ligne 80), `test/native-ci-triggers.test.ts` (ligne 99 :
    table explicite des workflows hébergés et des workflows restés auto-hébergés). Hors scope :
    le contenu des jobs, `deploy.yml`, `pull-cache.yml`, `sync-genre-cache.yml`,
    `top-up-genres.yml`, `test/pull-cache-workflow.test.ts`.
  - Contrat : `runs-on: ubuntu-latest` dans ces trois fichiers ; noms de jobs, déclencheurs,
    permissions et étape « Isolate HOME » inchangés (diff minimal, ≤ 200 lignes).
  - Critères : les checks requis de la PR elle-même passent sur runner hébergé ; le test de table
    échoue si un workflow absent des deux listes apparaît.
  - Tests : les trois fichiers vitest ci-dessus.

- [ ] TRA-? **1.3 — Faire tourner `ai-review` et `claude` sur `ubuntu-latest`, réservés aux comptes du dépôt** — P0, tier/3, 2 pts. Dépend de 1.2.
  - Portée : `.github/workflows/ai-review.yml`, `.github/workflows/claude.yml`,
    `test/native-ci-triggers.test.ts` ; `test/review-reuse.test.ts` et
    `test/review-gate-workflow.test.ts` seulement s'ils épinglent une ligne modifiée.
  - Contrat : `runs-on: ubuntu-latest` ; `ai-review` : condition du job complétée par
    `github.event.pull_request.head.repo.full_name == github.repository` ; `claude` : condition
    complétée par `contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association)`.
  - Critères : la review de la PR elle-même se termine sur runner hébergé et `review-gate` la lit ;
    un test vitest lit les deux conditions dans les fichiers.
  - Notes : une PR de fork n'a alors pas de review Claude, donc `review-gate` reste en attente :
    c'est le comportement voulu (merge par un mainteneur uniquement).

- [ ] TRA-? **1.4 — Documenter la CI hébergée** — P0, tier/1, 1 pt. Dépend de 1.1.
  - Portée : `docs/track1-builds.md` (sections « Contrôles natifs » et « Boucle locale » : où tourne
    `ios-check`, ce qui reste interdit en local et pourquoi). Hors scope : `CLAUDE.md`, `.claude/`.
  - Critères : le document ne dit plus que le Mac héberge les runners des PR ; il nomme les
    workflows restés auto-hébergés.

- [ ] TRA-? **1.5 — (conditionnelle, Q3) Produire la review Codex dans GitHub Actions** — P0 hors
  chemin critique, tier/3, 3 pts. **Bloquée tant que Q3 n'est pas tranchée.**
  - Portée pressentie : nouveau workflow `.github/workflows/codex-review.yml`,
    `.github/workflows/review-gate.yml` (sélection des statuts), `.github/review-gate-authors.txt`,
    `scripts/ci/review-gate-policy.ts` et leurs tests.
  - Contrat à trancher avec Raphael : qui publie `codex-review` (aujourd'hui un compte humain, par
    `.codex/scripts/publish-review-status.sh`), avec quel secret, et comment empêcher une PR de se
    décerner le statut.

### Partie 2 — Build TestFlight depuis GitHub Actions (P0)

Incrément : un clic sur « Run workflow » envoie `main` sur TestFlight. Ne dépend d'aucune tâche
d'app : la première build peut partir avec l'app actuelle, pour éprouver la chaîne et lancer tôt
la revue bêta d'Apple (R5). Prérequis côté Apple : voir « Prérequis à fournir par Raphael ».

- [ ] TRA-? **2.1 — Déclarer la conformité export et le manifeste de confidentialité** — P0, tier/3, 1 pt, ∥.
  - Portée : `ios/Track1/Resources/Info.plist` (`ITSAppUsesNonExemptEncryption` = `false`), créer
    `ios/Track1/Resources/PrivacyInfo.xcprivacy`, l'ajouter à la phase Resources dans
    `ios/Track1.xcodeproj/project.pbxproj` (identifiant `04B0`), créer
    `test/ios-privacy-manifest.test.ts`.
  - Contrat : `NSPrivacyTracking` = `false` ; `NSPrivacyAccessedAPITypes` déclare chaque catégorie
    d'API « required reason » utilisée par `ios/Track1` et `ios/Track1Core/Sources` (au minimum
    `UserDefaults`, raison `CA92.1` : `ConsentStore.swift`, `SegmentAdapter.swift`).
  - Critères : le test vitest échoue si le manifeste manque de la phase Resources, ou si une
    catégorie trouvée par recherche dans les sources (`UserDefaults`, dates de fichier, espace
    disque, temps de démarrage) n'est pas déclarée.
  - Tests : `test/ios-privacy-manifest.test.ts` ; `ios-check` vert.

- [ ] TRA-? **2.2 — Extraire les validations communes d'`archive.sh`** — P0, tier/2, 1 pt, ∥.
  - Portée : créer `ios/scripts/release-common.sh` (fonctions `fail`, `validate_team_id`,
    `validate_api_base_url`, `validate_xcode`, `validate_clean_tree`, `prepare_output_base`
    déplacées telles quelles), `ios/scripts/archive.sh` (les `source`). Hors scope : tout
    changement de comportement.
  - Critères : `test/ios-archive.test.ts` vert sans modification de ses assertions.

- [ ] TRA-? **2.3 — Script d'archive et d'envoi App Store Connect** — P0, tier/3, 2 pts. Dépend de 2.2.
  - Portée : créer `ios/scripts/testflight.sh`, `ios/Configurations/ExportOptions-AppStore.plist`,
    `test/ios-testflight.test.ts` (même harnais à faux `xcodebuild` que `test/ios-archive.test.ts`).
    Hors scope : `Base.xcconfig` (garde `CODE_SIGNING_ALLOWED = NO`), `Production.xcconfig`.
  - Contrat : entrées par variables d'environnement `TRACK1_TEAM_ID`, `TRACK1_API_BASE_URL`,
    `TRACK1_PROFILE_NAME`, `ASC_KEY_PATH`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `TRACK1_UPLOAD` (`0` =
    exporter l'IPA sans l'envoyer, défaut ; `1` = envoyer). Archive : schéma `Track1`,
    configuration `Production`, `CODE_SIGN_STYLE=Manual`, `CODE_SIGN_IDENTITY=Apple Distribution`,
    `PROVISIONING_PROFILE_SPECIFIER=$TRACK1_PROFILE_NAME`, `CURRENT_PROJECT_VERSION` = horodatage
    UTC `YYYYMMDDHHMM` (même règle qu'`archive.sh`). Export : `method` = `app-store-connect`,
    `signingStyle` = `manual`, `destination` = `upload` quand `TRACK1_UPLOAD=1`. Sortie : SHA,
    version, build, URL d'API, sur stdout ; aucune valeur de secret affichée.
  - Critères : refuse une URL qui ne finit pas par `/mobile/v1`, un arbre git non propre, un Xcode
    différent de `ios/.xcode-version`, un `ASC_KEY_PATH` absent ; vérifie après export que l'app
    est signée `com.dropcliffs.track1` par l'équipe attendue et embarque l'URL fournie.
  - Tests : `test/ios-testflight.test.ts` — nominal (arguments exacts des deux appels
    `xcodebuild`), chaque refus, `TRACK1_UPLOAD=0` n'ajoute pas `destination upload`.

- [ ] TRA-? **2.4 — Workflow `ios-testflight`** — P0, tier/3, 2 pts. Dépend de 1.1 et 2.3.
  - Portée : créer `.github/workflows/ios-testflight.yml`, créer
    `test/ios-testflight-workflow.test.ts`, compléter la table de `test/native-ci-triggers.test.ts`.
  - Contrat : déclencheur `workflow_dispatch` seul ; job `testflight` avec
    `if: github.ref == 'refs/heads/main'`, `environment: testflight`, `permissions: contents: read`,
    `concurrency: ios-testflight` sans annulation, même label de runner que `ios-check` après 1.1.
    Étapes : checkout sans credentials persistants, sélection de Xcode, trousseau temporaire +
    import du `.p12`, installation du profil, écriture de la clé `.p8` dans `$RUNNER_TEMP`,
    `ios/scripts/testflight.sh` avec `TRACK1_UPLOAD=1`, nettoyage en `if: always()` (trousseau,
    profil, clé), résumé du job (SHA, version, build). Secrets de l'Environment :
    `IOS_DIST_CERT_P12_BASE64`, `IOS_DIST_CERT_PASSWORD`, `IOS_APPSTORE_PROFILE_BASE64`,
    `ASC_API_KEY_P8_BASE64`, `ASC_API_KEY_ID`, `ASC_API_ISSUER_ID`. Variables de l'Environment :
    `TRACK1_TEAM_ID`, `TRACK1_API_BASE_URL`, `TRACK1_APPSTORE_PROFILE_NAME`.
  - Critères : le test vitest vérifie l'unique déclencheur, la présence de `environment`, la garde
    `main`, l'étape de nettoyage `always()`, et qu'aucun `${{ secrets.* }}` n'apparaît dans un bloc
    `run:` (les secrets passent par `env:`).
  - Tests : `test/ios-testflight-workflow.test.ts`.

- [ ] TRA-? **2.5 — Mode d'emploi TestFlight** — P0, tier/1, 1 pt, ∥.
  - Portée : créer `docs/track1-testflight.md` (création du certificat, du profil, de la clé
    d'API ; noms exacts des secrets et variables ; lancer le workflow ; ajouter des testeurs
    internes et externes ; lire un échec de validation), lien depuis `docs/track1-builds.md`.

- [ ] TRA-? **2.6 — Première build TestFlight et preuve d'installation** — P0, tier/1, 1 pt.
  Dépend de 2.1, 2.4 et des prérequis Apple.
  - Portée : lancer le workflow sur `main`, corriger par tickets séparés toute erreur de validation
    App Store Connect, consigner dans `docs/track1-builds.md` une ligne SHA / version / build /
    date / groupe de testeurs / résultat d'installation.
  - Critères : la build apparaît « prête à tester » dans App Store Connect ; elle est installée
    par TestFlight sur un iPhone et s'ouvre ; si le groupe est externe, elle est soumise à la revue
    bêta le jour même.

### Partie 3 — Coquille v1 : splash, deux onglets, plus de recherche (P0)

Incrément : l'app s'ouvre sur le splash de la maquette, n'a plus que deux onglets, et la recherche
n'est plus atteignable.

- [ ] TRA-? **3.1 — DS · Marque d'app `AppMark`** — P0, tier/1, 1 pt, ∥.
  - Portée : créer `ios/Track1/Resources/Assets.xcassets/Brand/AppMark.imageset` (une image PNG
    composée, 552 px, fond transparent, produite par script à partir des trois calques déjà
    versionnés dans `ios/Track1/Resources/AppIcon.icon/Assets/`, dans l'ordre boîtier, disque,
    étiquette), créer `ios/Track1/DesignSystem/Components/Core/AppMark.swift` (pbxproj `0430`) et
    `ios/Track1Tests/DesignSystem/AppMarkTests.swift` (`0431`).
  - Contrat : `struct AppMark: View { init(size: CGFloat) }` — image carrée décorative
    (`accessibilityHidden`), identifiant `app-mark`. Tailles de la maquette : 184,3 (splash),
    122,9 (Welcome).
  - Critères : l'image existe dans le catalogue sous `Brand/AppMark` ; la vue rend un carré de
    `size` ; la commande de composition figure dans la description de la PR.

- [ ] TRA-? **3.2 — Splash pendant les chargements du lancement** — P0, tier/1, 2 pts. Dépend de 3.1.
  - Portée : créer `ios/Track1/App/SplashView.swift` (`0432`) et
    `ios/Track1Tests/DesignSystem/SplashViewTests.swift` (`0433`) ; `ios/Track1/App/RootView.swift`
    (le `ProgressView()` d'attente du consentement et le fond nu de `Gate.loading` deviennent
    `SplashView`) ; `ios/Track1/Features/Today/RecommendationLoadingView.swift` (le corps
    « chargement » devient `SplashView` ; le délai de 20 s et `Track1StatusView(.loadingTimeout)`
    restent) ; `ios/Track1/Resources/Info.plist` (`UILaunchScreen` : `UIColorName` =
    `LaunchBackground`, `UIImageName` = `Brand/AppMark`) ; créer le colorset
    `Assets.xcassets/LaunchBackground.colorset` (`#120C0A`).
  - Contrat : `struct SplashView: View { init() }` — Figma `318:6513` : `AppMark(size: 184.32)`
    centré sur le fond de l'app, rien d'autre ; identifiant `splash`.
  - Critères : les trois états d'attente rendent `splash` ; le passage en « trop long » après 20 s
    est inchangé (test existant de `RecommendationLoadingView` vert) ; `test/ios-fonts.test.ts`
    et `test/ios-accent-color.test.ts` verts.
  - Tests : unitaires sur `SplashView` et sur le délai ; `TodayFlowTests` vert.

- [ ] TRA-? **3.3 — Passer à deux onglets et retirer l'entrée de la recherche** — P0, tier/2, 3 pts.
  - Portée : `ios/Track1/DesignSystem/Components/Navigation/Track1TabBar.swift` (plus de bouton
    rond : paramètres `search` et `onSearch`, `searchDiameter`, `searchTone` supprimés ; la pilule
    200 × 62 est centrée, Figma `324:1793`), `ios/Track1/App/AppRouter.swift` (`AppTab.search` et
    `isSearchPresented` supprimés), `ios/Track1/App/RootView.swift` (feuille de recherche,
    `chosenResult`, `openChosenResult`, `searchSheet` supprimés ; `exploreSearch` de
    `TodayEntryView` devient `router.select(.genres)`), `Assets.xcassets/Tab/Today.imageset` et
    `Tab/Genres.imageset` (icônes Figma `324:1795` maison et `324:1798` note de musique, SVG
    gabarit), suppression de `Tab/Search.imageset` et de `Track1Icon.Asset.tabSearch`
    (`ios/Track1/DesignSystem/Components/Core/Track1Icon.swift`) ; tests
    `ios/Track1Tests/DesignSystem/Track1TabBarTests.swift`,
    `ios/Track1Tests/DesignSystem/Track1IconTests.swift`,
    `ios/Track1Tests/Node/AppRouterNodeTests.swift`, `ios/Track1UITests/NavigationTests.swift`
    (premier test réécrit pour deux onglets, test de la touche Rechercher supprimé), suppression
    de `ios/Track1UITests/SearchFlowTests.swift` et de son entrée pbxproj. Hors scope : le code de
    recherche lui-même (3.4), `src/`.
  - Contrat : `Track1TabBar(items:selected:safeAreaBottom:onSelect:)` ; `AppTab.allCases == [.today, .genres]`.
  - Critères : aucun élément d'identifiant `tab-search` ; les deux onglets gardent leur pile ;
    `ios-check` vert.
  - Tests : unitaires et UI ci-dessus.

- [ ] TRA-? **3.4 — Supprimer le code de recherche devenu mort** — P0 **après TestFlight**, tier/2,
  2 pts. Dépend de 3.3. Suppression seule (dépasse 300 lignes, uniquement en retraits).
  - Portée : `ios/Track1/Features/Search/SearchSheetView.swift`,
    `ios/Track1/DesignSystem/Components/Navigation/Track1SearchField.swift`,
    `ios/Track1Core/Sources/Track1Core/Features/Search/` (3 fichiers),
    `ios/Track1Core/Tests/Track1CoreTests/SearchTests.swift`, `RecentNodesStoreTests.swift`, les
    références (`AppContainer.recentNodes`, `ContentReaders.search`, `APIClient`, `SettingsView`,
    `GenresTabView`, `UITestFixtureReaders`), entrées pbxproj. Hors scope : `src/mobile/search.ts`.
  - Critères : `swift test`, `ios-check` et `npm run test` verts ; aucun changement visible.

### Partie 4 — Onboarding v1 : créer son profil (P0)

Incrément : Welcome → pseudo → disque → genres → Aujourd'hui. Le profil porte un pseudo et un
disque.

- [ ] TRA-? **4.1 — Core · Pseudo, disque et date de création dans le profil** — P0, tier/3, 2 pts, ∥.
  - Portée : `ios/Track1Core/Sources/Track1Core/Profile/Profile.swift`,
    `ios/Track1Core/Sources/Track1Core/Profile/ProfileStore.swift`, créer
    `ios/Track1Core/Sources/Track1Core/Profile/ProfileIdentity.swift` et
    `ios/Track1Core/Tests/Track1CoreTests/Profile/ProfileIdentityTests.swift` ; compléter
    `ProfileStoreTests.swift`. Hors scope : `Analytics/` (aucun événement ne porte ces champs),
    `GenreSelection.swift`.
  - Contrat :
    - `public enum ProfileDisc: String, Codable, CaseIterable, Sendable { case iridescent, blue, mint, coral, violet, teal }`
      (ordre de la grille Figma, de gauche à droite puis de haut en bas).
    - `public enum PseudoRules { public static let maxLength = 20; public static func normalized(_ raw: String) -> String? }`
      — retire espaces de bord, caractères de contrôle et contrôles bidirectionnels, réduit les
      suites d'espaces, tronque à 20 caractères (graphèmes), `nil` si vide.
    - `Profile` : `displayName: String?` (`display_name`), `disc: ProfileDisc?` (`disc`),
      `createdAt: Date?` (`created_at`, ISO 8601). `ProfileDraft` : `displayName`, `disc`.
      Clés absentes → `nil` ; `nil` → clé non écrite ; `disc` de valeur inconnue → `nil`, pas un
      profil corrompu. `Profile.version` reste 2.
    - `ProfileStore.init(…, now: @escaping @Sendable () -> Date = Date.init)`. `commit` : à la
      première écriture `createdAt = now()` ; ensuite `createdAt` est conservé ; `displayName` et
      `disc` viennent du brouillon s'ils y sont, sinon du profil existant.
  - Critères : un `profile.v2.json` sans les trois clés se lit `.profile` ; aller-retour complet ;
    deuxième `commit` sans pseudo ni disque les conserve ; pseudo non normalisé → `.invalid`.
  - Tests : unitaires nominal, limites (20 graphèmes, emoji, espaces seuls), erreur (disque inconnu).

- [ ] TRA-? **4.2 — DS · Disques de profil** — P0, tier/1, 2 pts. Dépend de 4.1.
  - Portée : créer `Assets.xcassets/Disc/` avec six imagesets `Iridescent`, `Blue`, `Mint`,
    `Coral`, `Violet`, `Teal` (PNG ≥ 432 px, fond transparent ; `Iridescent` = réduction du calque
    `02 CD — iridescence + hub 3.png` déjà versionné ; les cinq autres = export des nodes Figma
    `322:3663`, `322:3679`, `322:3695`, `322:3711`, `322:3727`), créer
    `ios/Track1/DesignSystem/Components/Onboarding/ProfileDiscImage.swift` (`0440`) et
    `ios/Track1Tests/DesignSystem/ProfileDiscImageTests.swift` (`0441`).
  - Contrat : `struct ProfileDiscImage: View { init(disc: ProfileDisc?, size: CGFloat) }` — `nil`
    dessine l'emplacement vide de la maquette (disque gris uni, point central), sans image.
    `static func assetName(for: ProfileDisc) -> String`.
  - Critères : chaque cas de `ProfileDisc` a une image dans le catalogue (test) ; libellé
    d'accessibilité par disque (« Disque bleu », …).
  - Notes : si l'export par le MCP échoue, s'arrêter et demander les cinq PNG à Raphael (R12).

- [ ] TRA-? **4.3 — Core · Ordre et verrous des étapes d'onboarding** — P0, tier/2, 1 pt, ∥.
  - Portée : créer `ios/Track1Core/Sources/Track1Core/Features/Onboarding/OnboardingSteps.swift`
    et `ios/Track1Core/Tests/Track1CoreTests/Profile/OnboardingStepsTests.swift`.
  - Contrat : `public enum OnboardingStepID: Hashable, Sendable { case welcome, pseudo, disc, genres, notifications }` ;
    `public enum OnboardingSteps { static func order(includesNotifications: Bool) -> [OnboardingStepID]; static func next(after: OnboardingStepID, includesNotifications: Bool) -> OnboardingStepID?; static func canLeave(_ step: OnboardingStepID, pseudo: String?, disc: ProfileDisc?, selectedGenres: Int) -> Bool }`.
    Ordre : welcome, pseudo, disc, genres, puis notifications si demandé.
  - Critères : `canLeave(.pseudo)` exige `PseudoRules.normalized != nil` ; `.disc` exige un disque ;
    `.genres` exige ≥ 1 genre ; `next(after:)` de la dernière étape vaut `nil`.

- [ ] TRA-? **4.4 — Écran pseudo** — P0, tier/2, 2 pts. Dépend de 4.1.
  - Portée : créer `ios/Track1/Features/Onboarding/PseudoStepView.swift` (`0442`) et
    `ios/Track1Tests/Profile/PseudoStepViewTests.swift` (`0443`) ;
    `ios/Track1/DesignSystem/Track1Typography.swift` (nouveau rôle `inputLarge` : Roboto Regular
    34/41) et `ios/Track1Tests/DesignSystem/Track1TypographyTests.swift`.
  - Contrat : `struct PseudoStepView: View { init(initial: String?, onSubmit: @escaping (String) -> Void) }`.
    Figma `362:1766` (vide) et `362:2894` (rempli) : titre `monoItem` centré à 164 pt du haut,
    champ centré à 344 pt, clavier ouvert à l'apparition, libellé de la touche retour « continuer »,
    autocorrection coupée, saisie bornée à `PseudoRules.maxLength`. La touche retour n'appelle
    `onSubmit(normalisé)` que si `PseudoRules.normalized` n'est pas `nil`. **Aucun bouton à l'écran.**
    Identifiants `onboarding-pseudo-title`, `onboarding-pseudo-field`.
  - Critères : retour sur champ vide ou espaces → rien ; « Raph  » → `onSubmit("Raph")` ; le champ
    est un en-tête lisible par VoiceOver avec le titre comme libellé.

- [ ] TRA-? **4.5 — Écran de choix du disque** — P0, tier/2, 3 pts. Dépend de 4.2.
  - Portée : créer `ios/Track1/Features/Onboarding/DiscStepView.swift` (`0444`) et
    `ios/Track1Tests/Profile/DiscStepViewTests.swift` (`0445`).
  - Contrat : `struct DiscStepView: View { init(selected: ProfileDisc?, onSelect: @escaping (ProfileDisc) -> Void, onContinue: @escaping () -> Void) }`.
    Figma `362:3008` et `362:3145` : titre à 164 pt, sous-titre à 198 pt, emplacement 143,8 pt
    centré à 264,9 pt, grille 3 × 2 de tuiles 85,6 pt au pas de 107,6 pt à partir de 506 pt,
    `BottomActionBar` « Continuer » désactivée tant que `selected == nil`. Toucher un disque : il
    glisse et grossit jusqu'à l'emplacement (`matchedGeometryEffect`), sa tuile montre
    l'emplacement vide ; toucher un autre : le nouveau prend la place, l'ancien retourne à sa
    tuile. Reduce Motion : fondu, pas de déplacement. Retour haptique de sélection à chaque choix.
    Identifiants `onboarding-disc-<rawValue>`, `onboarding-disc-slot`.
  - Critères : chaque tuile est un bouton avec le trait « sélectionné » ; un second choix remplace
    le premier ; « Continuer » n'appelle `onContinue` qu'avec un disque choisi.

- [ ] TRA-? **4.6 — Brancher pseudo et disque dans le parcours** — P0, tier/2, 3 pts.
  Dépend de 4.3, 4.4, 4.5.
  - Portée : `ios/Track1/Features/Onboarding/OnboardingFlowView.swift` (`Step` suit
    `OnboardingSteps.order(includesNotifications: false)` ; `FirstLaunchOnboardingView` sauve le
    brouillon avec pseudo et disque à chaque étape, pour reprendre après un arrêt de l'app),
    `ios/Track1Core/Sources/Track1Core/Features/Onboarding/GenreSelectionModel.swift`
    (`makeDraft(displayName:disc:)`), `ios/Track1UITests/ProfileFlowTests.swift`,
    `ios/Track1UITests/UITestFlows.swift`. Hors scope : le mode édition (`model.isEditing`),
    traité en Partie 6.
  - Critères : premier lancement = Welcome → pseudo → disque → genres → Aujourd'hui ; le geste
    retour remonte d'une étape en gardant la saisie ; le profil écrit porte pseudo, disque et
    `created_at` ; un relancement en cours de parcours reprend à l'étape atteinte.
  - Tests : `testFirstLaunchChainsTheOnboardingToTodayAndIsNotShownAgain` et
    `testTheBackGestureToWelcomeKeepsTheSelection` réécrits ; test Core de `makeDraft`.

- [ ] TRA-? **4.7 — Welcome v1 : icône d'app et fond plus vif** — P0, tier/1, 1 pt, ∥ après 3.1.
  - Portée : `ios/Track1/Features/Onboarding/WelcomeView.swift` (`AppMark(size: 122.88)` au-dessus
    du nom, espacements de `362:4932`),
    `ios/Track1/DesignSystem/Components/Onboarding/WelcomeBackdrop.swift` (`loopDuration` 45 → 30 s),
    tests `OnboardingComponentsTests.swift` et `BackdropTests.swift`.
  - Critères : la marque précède le nom dans l'ordre de lecture ; `loopDuration == 30` ; Reduce
    Motion inchangé.

- [ ] TRA-? **4.8 — Mettre la sélection des genres au niveau de la maquette** — P0, tier/1, 2 pts, ∥.
  - Portée : `ios/Track1/Features/Onboarding/GenresStepView.swift`,
    `ios/Track1/DesignSystem/Components/Onboarding/GenreAccordionCard.swift`,
    `SubgenreChip.swift`, `ios/Track1/DesignSystem/Components/Navigation/BottomActionBar.swift`,
    leurs tests. Référence : Figma `316:5066` (en-tête `title1` + `bodyMedium`, cartes 361 pt au
    pas de 82 pt, compteur au-dessus du bouton, fondu bas).
  - Critères : chaque constante de mesure des composants touchés égale la valeur lue sur le node
    (liste des écarts corrigés dans la PR) ; le tic haptique au défilement existant
    (`OnboardingScrollTick`, `ScrollTickDetectorTests`) reste vert et inchangé.
  - Notes : la note « polish » ne liste aucun écart ; sans précision de Raphael (Q6), le périmètre
    est l'alignement des mesures, rien d'autre.

### Partie 5 — Aujourd'hui v1 : accueil du jour et lecteur (P0)

Incrément : l'onglet Aujourd'hui montre la carte du jour ; « Découvrir » ouvre le lecteur.
Les fiches avec arêtes ne sont plus atteignables.

- [ ] TRA-? **5.1 — Core · Ne recommander que des projets et des morceaux** — P0, tier/2, 1 pt, ∥.
  - Portée : `ios/Track1Core/Sources/Track1Core/Recommendation/Affinity.swift` (candidats limités
    à `.project` et `.track`),
    `ios/Track1Core/Sources/Track1Core/Features/Today/TodayViewModel.swift` (un choix du jour déjà
    stocké dont `nodeType` n'est ni projet ni morceau est ignoré et recalculé), tests
    `AffinityTests.swift`, `DailySelectionTests.swift`, `TodayViewModelTests.swift`.
  - Critères : aucun artiste dans `Affinity.rank` ; un artiste stocké pour aujourd'hui est remplacé.
  - Notes : la parité avec `mobile/src/recommendation/daily.ts` (client Expo gelé) est rompue
    volontairement ; le dire dans le commentaire, avec la date.

- [ ] TRA-? **5.2 — Core · Modèle de l'accueil `TodayHome`** — P0, tier/2, 1 pt, ∥.
  - Portée : créer `ios/Track1Core/Sources/Track1Core/Features/Today/TodayHome.swift` et
    `ios/Track1Core/Tests/Track1CoreTests/Recommendation/TodayHomeTests.swift`.
  - Contrat : `public struct TodayHome: Equatable, Sendable { public let day: String; public let month: String; public let genres: [String]; public let type: NodeType; public let title: String; public let subtitle: String?; public init(node: NodeDetail, date: Date, timeZone: TimeZone) }`.
    `day` sans zéro initial ; `month` = abréviation française en capitales (JAN, FÉV, MAR, AVR,
    MAI, JUN, JUL, AOÛ, SEP, OCT, NOV, DÉC), quel que soit le réglage de l'appareil ; `genres` =
    noms de `node.edges["genres"]`, nettoyés par la règle de `NodePageHeader` (à rendre interne,
    pas à dupliquer), dédoublonnés, 3 au plus ; `subtitle` = artistes (`edges["artists"]`) puis
    année (`facts["year"]`), séparés par ` · `, `nil` si les deux manquent.
  - Critères : 31 octobre 23:30 UTC à Paris → `1` / `NOV` ; projet sans genre → `[]` ; morceau
    sans année → artistes seuls.

- [ ] TRA-? **5.3 — Core · Découper l'article en phrases** — P0, tier/2, 2 pts, ∥.
  - Portée : créer `ios/Track1Core/Sources/Track1Core/Features/Node/ArticleSentences.swift` et
    `ios/Track1Core/Tests/Track1CoreTests/Node/ArticleSentencesTests.swift`.
  - Contrat : `public enum ArticleSentences { public static func split(_ article: String) -> [String] }`.
    Règles : fins de ligne normalisées ; marqueurs de titre et de liste retirés en début de ligne ;
    balisage en ligne retiré par la règle existante du teaser ; appels de note `[n]` retirés ;
    segmentation Foundation `.bySentences` ; chaque phrase rognée ; les vides sont écartés ; un
    fragment de moins de 25 caractères est rattaché à la phrase précédente.
  - Critères : l'extrait de la maquette (« "Pulse X" by the producer Youngstar… ») donne trois
    phrases ; « U.K. garage », « feat. » et « 2.5 » ne coupent pas ; article vide → `[]`.
  - Tests : unitaires ci-dessus, plus deux articles réels recopiés de `cache/` en constantes de
    test (un projet, un morceau), sans phrase vide ni fragment isolé.

- [ ] TRA-? **5.4 — Core · Géométrie du lecteur `PlayerScroll`** — P0, tier/2, 2 pts, ∥.
  - Portée : créer `ios/Track1Core/Sources/Track1Core/Features/Node/PlayerScroll.swift` et
    `ios/Track1Core/Tests/Track1CoreTests/Node/PlayerScrollTests.swift`.
  - Contrat : `public struct PlayerItemFrame: Equatable, Sendable { public let minY: Double; public let height: Double }` ;
    `public enum PlayerScroll { public static func focusedIndex(offset: Double, viewportHeight: Double, frames: [PlayerItemFrame]) -> Int?; public static func snapOffset(proposed: Double, viewportHeight: Double, frames: [PlayerItemFrame]) -> Double }`.
    Le focus est l'élément dont le milieu est le plus proche du centre de la fenêtre (égalité →
    indice le plus bas). `snapOffset` renvoie le décalage qui centre cet élément, borné à
    l'étendue du contenu ; pour un élément plus haut que 80 % de la fenêtre, il renvoie `proposed`
    tant que le centre reste dans l'élément (lecture libre d'une longue phrase).
  - Critères : liste vide → `nil` / `proposed` ; premier et dernier élément centrables ; cas de
    l'élément long couvert.

- [ ] TRA-? **5.5 — DS · Badge de type : carré pour un projet, hexagone pour un morceau** — P0, tier/1, 1 pt, ∥.
  - Portée : `ios/Track1/DesignSystem/Components/Node/NodeTypeBadge.swift`,
    `ios/Track1Tests/DesignSystem/NodeContentCardTests.swift`.
  - Contrat : `.track` dessine un hexagone régulier 14 × 14 à 4 pt du libellé (Figma `362:5105`,
    polygone `362:5107`) ; les autres types gardent le carré 12 × 12 à 8 pt (Figma `362:5098`) ;
    couleurs `Track1Tokens.colorNode(type)` (`#E6A23A` projet, `#F0642D` morceau, déjà en place).
  - Critères : test sur la forme et l'écart par type ; libellé d'accessibilité inchangé.
  - Notes : la carte `324:1805` dessine PROJECT dans un rose non lié à une variable ; la note de
    spec `362:5098` lie `theme.color.node.project`. La spec gagne.

- [ ] TRA-? **5.6 — DS · Composants de l'accueil : `DateBadge`, `GenrePillRow`, `DiscoverButton`** — P0, tier/1, 2 pts, ∥.
  - Portée : créer dans `ios/Track1/DesignSystem/Components/Node/` `DateBadge.swift` (`0450`),
    `GenrePillRow.swift` (`0451`), `DiscoverButton.swift` (`0452`), et
    `ios/Track1Tests/DesignSystem/TodayComponentsTests.swift` (`0453`).
  - Contrat : `struct DateBadge: View { init(day: String, month: String) }` (Figma `324:1818`,
    tuile 53 × 72) ; `struct GenrePillRow: View { init(genres: [String]) }` (Figma `324:1820`,
    pilules de 28 pt, `bodySmall`, rangée centrée, rien si la liste est vide) ;
    `struct DiscoverButton: View { init(action: @escaping () -> Void) }` (Figma `324:1813`, 133 × 44,
    fond `colorActionPrimary`, icône lecture, libellé « Découvrir », identifiant `today-discover`).
  - Critères : chaque mesure citée est une constante testée ; à la plus grande taille de texte la
    rangée de pilules passe à la ligne sans sortir de l'écran.

- [ ] TRA-? **5.7 — DS · Barre collante du lecteur `PlayerNowBar`** — P0, tier/1, 2 pts, ∥.
  - Portée : créer `ios/Track1/DesignSystem/Components/Node/PlayerNowBar.swift` (`0454`) et
    `ios/Track1Tests/DesignSystem/PlayerNowBarTests.swift` (`0455`).
  - Contrat : `struct PlayerNowBar: View { init(title: String, artist: String?, cover: Image?, actions: [ListeningAction], isOpening: Bool, open: @escaping (ListeningAction) -> Void) }`.
    Figma `338:2493` : pilule de verre 306 × 50 (mêmes jetons que `Track1TabBarStyle`), pochette
    30,9 pt, titre mono gras 16/24 sur une ligne, artiste `bodySmall`, puis un bouton par action
    (logo 17,6 pt et flèche sortante), Apple Music avant Spotify (`StreamingBar.ordered`).
    Identifiants `player-now-bar`, `player-open-<provider>`.
  - Critères : sans action, aucun bouton ; sans artiste, le titre est centré verticalement ; les
    boutons sont désactivés pendant `isOpening` ; libellé d'accessibilité = `ListeningAction.title`.

- [ ] TRA-? **5.8 — Écran lecteur `PlayerView` (non branché)** — P0, tier/2, 3 pts.
  Dépend de 5.3, 5.4, 5.7.
  - Portée : créer `ios/Track1/Features/Node/PlayerView.swift` (`0456`) et
    `ios/Track1Tests/Node/PlayerViewTests.swift` (`0457`) ;
    `ios/Track1/DesignSystem/Track1Typography.swift` (nouveau rôle `reader` : Roboto Regular 22/34)
    et son test. Hors scope : routeur, `TodayView`, bouton partager (Partie 8).
  - Contrat : `struct PlayerView: View { init(model: NodeViewModel, imageStore: NodeImageStore<UIImage>, onBack: @escaping () -> Void) }`.
    Figma `338:2461` : colonne de texte de 309 pt (marge 42), un paragraphe par phrase de
    `ArticleSentences.split(node.article)`, 56 pt entre deux paragraphes ; la phrase au centre
    (`PlayerScroll.focusedIndex`) est en `colorTextPrimary` à l'échelle 1,04, les autres en
    `colorTextTertiary` à l'échelle 1 ; transition `Track1Motion` courte, couleur seule sous
    Reduce Motion ; accroche par un `ScrollTargetBehavior` qui applique `PlayerScroll.snapOffset` ;
    fondus haut et bas par masque ; bouton retour rond 40 pt en haut à gauche (`338:2559`,
    identifiant `player-back`) ; `PlayerNowBar` fixée 8 pt au-dessus de la barre d'onglets.
    Aucun défilement automatique. Article vide : le teaser tient lieu d'unique paragraphe ; sans
    teaser, message `PlayerView.emptyMessage`. Nœud indisponible : `Track1StatusView` avec
    réessai.
  - Critères : le nombre de paragraphes égale `ArticleSentences.split(...).count` ; un seul
    paragraphe porte le trait de focus ; VoiceOver lit les paragraphes dans l'ordre ; les liens
    passent par `NodeViewModel.openListening`.

- [ ] TRA-? **5.9 — Accueil du jour et route vers le lecteur (bascule)** — P0, tier/2, 3 pts.
  Dépend de 3.3, 5.1, 5.2, 5.5, 5.6, 5.8.
  - Portée : créer `ios/Track1/Features/Today/TodayHomeView.swift` (`0458`) et
    `ios/Track1Tests/Node/TodayHomeViewTests.swift` (`0459`) ;
    `ios/Track1/Features/Today/TodayView.swift` (la racine devient `TodayHomeView` ;
    `model.discover()` n'est plus appelé à l'affichage mais au toucher de « Découvrir ») ;
    `ios/Track1/App/AppRouter.swift` (`AppRoute.player(identity:context:)` remplace `.node`) ;
    `ios/Track1/App/RootView.swift` (destination `.player` → `PlayerView`, retour = `router.pop`) ;
    `ios/Track1/App/UITestFixtureReaders.swift` (nœud du jour avec article, genres, année) ;
    `ios/Track1UITests/TodayFlowTests.swift`, `NavigationTests.swift`.
  - Contrat : `struct TodayHomeView: View { init(home: TodayHome, cover: Image?, isOpening: Bool, discover: @escaping () -> Void) }`.
    Figma `324:1788`, de haut en bas : `DateBadge` à 72 pt, `GenrePillRow` à 160 pt, pochette
    carrée 308,8 pt à 222 pt (image chargée par `NodeImageStore`, repli `Track1Artwork`),
    `NodeTypeBadge`, titre `title2` centré, sous-titre `bodyMedium` en `colorTextSecondary`,
    `DiscoverButton`.
  - Critères : l'accueil montre le titre du jour et `today-discover` ; le toucher ouvre le lecteur
    du même nœud ; `player-back` ramène à l'accueil ; l'impression est enregistrée une fois à
    l'affichage, la découverte une fois au toucher ; au relancement le même nœud est montré.
  - Tests : `testTodayShowsTheNodeOfTheDayAndKeepsItThroughNavigationAndRelaunch` réécrit ;
    unitaires de la vue.

- [ ] TRA-? **5.10 — Supprimer les anciennes fiches, côté app** — P0 **après TestFlight**, tier/2,
  2 pts. Dépend de 5.9. Suppression seule.
  - Portée : `ios/Track1/Features/Node/NodeView.swift`, `NodePageView.swift`,
    `NodeArticleView.swift`, et tout composant de `ios/Track1/DesignSystem/Components/` sans
    référence après 5.9 (candidats : `EdgeChip`, `FactRow`, `NodeContentCard`, `NodeHero`,
    `ReleaseCard`, `SectionHeader`, `TeaserCard`, `TrackRow`, `StreamingButton`,
    `CoverTintGradient`, `TopBar`, `Track1ListItem`), leurs tests et entrées pbxproj.
  - Critères : seuls des symboles sans référence sont supprimés ; `ios-check` vert ; aucun
    changement visible ; liste des fichiers supprimés dans la PR.

- [ ] TRA-? **5.11 — Supprimer les anciennes fiches, côté `Track1Core`** — P0 **après TestFlight**,
  tier/2, 2 pts. Dépend de 5.10. Suppression seule.
  - Portée : fichiers de `ios/Track1Core/Sources/Track1Core/Features/Node/`, `Navigation/` et
    `Features/Today/TodayReason.swift` sans référence après 5.10, et leurs tests.
    **Conserver** `NodeViewModel.swift`, `NodePageHeader.swift`, `NodePageSpec.swift` et le garde
    `test/ios-node-page-spec.test.ts`.
  - Critères : `swift test`, `ios-check`, `npm run test` verts.

### Partie 6 — Onglet Genres v1 : profil et genres éditables en place (P0)

Incrément : le second onglet montre le disque, le pseudo, les genres modifiables directement et
l'ancienneté.

- [ ] TRA-? **6.1 — Core · Ancienneté du profil et sélection minimale** — P0, tier/2, 1 pt, ∥ après 4.1.
  - Portée : créer `ios/Track1Core/Sources/Track1Core/Profile/ProfileTenure.swift` et
    `ios/Track1Core/Tests/Track1CoreTests/Profile/ProfileTenureTests.swift` ;
    `ios/Track1Core/Sources/Track1Core/Features/Onboarding/GenreSelectionModel.swift` et
    `GenreSelectionModelTests.swift`.
  - Contrat : `public enum ProfileTenure { public static func days(since: Date, now: Date, calendar: Calendar) -> Int; public static func line(days: Int) -> String }`
    — jours calendaires, le jour de création compte pour 1 ; `GenreSelectionModel.init(…, minimumSelection: Int = 0)` :
    `toggleSubgenre` et `toggleAll` ne font rien s'ils feraient passer la sélection sous le minimum.
  - Critères : création aujourd'hui → 1 ; création hier 23:59, maintenant 00:01 → 2 ; avec
    `minimumSelection: 1`, décocher le dernier genre ne change rien.

- [ ] TRA-? **6.2 — Extraire la liste de sélection partagée `GenreSelectionList`** — P0, tier/2, 2 pts.
  Dépend de 4.8.
  - Portée : créer `ios/Track1/Features/Onboarding/GenreSelectionList.swift` (`0470`) ;
    `ios/Track1/Features/Onboarding/GenresStepView.swift` l'utilise. Aucun changement de
    comportement.
  - Contrat : `struct GenreSelectionList: View { init(model: GenreSelectionModel) }` — les cartes
    accordéon, « Tous », les puces, leurs identifiants et leurs retours haptiques actuels.
  - Critères : `GenresStepLayoutTests` et `ProfileFlowTests` verts sans modification.

- [ ] TRA-? **6.3 — DS · En-tête de profil `ProfileHeader`** — P0, tier/1, 1 pt, ∥ après 4.2.
  - Portée : créer `ios/Track1/DesignSystem/Components/Onboarding/ProfileHeader.swift` (`0471`) et
    `ios/Track1Tests/DesignSystem/ProfileHeaderTests.swift` (`0472`).
  - Contrat : `struct ProfileHeader: View { init(disc: ProfileDisc?, name: String?) }` — Figma
    `318:6911` (disque 85,6 pt dans un anneau de 89 pt) et `318:7031` (nom en `title3`, centré,
    16 pt sous l'anneau) ; sans nom, pas de ligne de texte.

- [ ] TRA-? **6.4 — Onglet Genres v1** — P0, tier/2, 3 pts. Dépend de 4.6, 6.1, 6.2, 6.3.
  - Portée : `ios/Track1/Features/Genres/GenresTabView.swift` (Figma `318:6781` : `ProfileHeader`,
    titre de section, `GenreSelectionList` liée à un `GenreSelectionModel(editing: profile, minimumSelection: 1)`,
    pied `ProfileTenure.line` en `monoMicro`, masqué si `createdAt` est `nil` ; suppression des
    tuiles en lecture seule et de `ProfileEditorSheet`), `ios/Track1/App/RootView.swift`
    (`profileWasSaved` met à jour le profil sans changer d'onglet),
    `ios/Track1/Features/Settings/SettingsView.swift` (la ligne « Goûts musicaux » qui ouvrait
    l'éditeur disparaît), `ios/Track1UITests/ProfileFlowTests.swift`.
  - Contrat : enregistrement automatique 800 ms après le dernier changement, par
    `ProfileStore.commit` ; un échec affiche l'erreur existante avec réessai. Le bouton d'accès aux
    Réglages reste, en haut à droite (hors maquette, Q5).
  - Critères : cocher un genre puis revenir sur Aujourd'hui recalcule le choix du jour (test UI
    existant adapté) ; le dernier genre ne se décoche pas ; un profil sans pseudo ni disque montre
    le disque vide et pas de nom ; les états catalogue indisponible et profil illisible restent
    ceux d'aujourd'hui.

### Partie 7 — Rappel quotidien (P1)

Incrément : l'onboarding propose le rappel ; une notification locale à 09:00 nomme l'œuvre du
jour. Suppose D4 validée (Q1).

- [ ] TRA-? **7.1 — Core · Planifier les choix des jours à venir `ReminderPlan`** — P1, tier/2, 2 pts, ∥.
  - Portée : créer `ios/Track1Core/Sources/Track1Core/Recommendation/ReminderPlan.swift` et
    `ios/Track1Core/Tests/Track1CoreTests/Recommendation/ReminderPlanTests.swift`.
  - Contrat : `public struct PlannedReminder: Equatable, Sendable { public let localDate: String; public let hour: Int; public let title: String; public let body: String; public let recommendation: DailyRecommendation }` ;
    `public enum ReminderPlan { public static let horizonDays = 7; public static let hour = 9; public static func plan(candidates: [AffinityCandidate], history: [DailyRecommendation], profile: Profile, catalog: Catalog, today: String, makeID: () -> UUID) -> [PlannedReminder] }`.
    Pour chacun des 7 jours après `today` : reprendre l'entrée déjà stockée pour ce jour si sa
    révision de profil est la bonne, sinon `DailySelection.pick` avec l'historique augmenté des
    jours déjà planifiés. `title` = « Ta recommandation du jour » ; `body` = « <artistes>, album
    <nom> » ou « <artistes>, morceau <nom> » (artistes lus dans les arêtes `artists` du catalogue ;
    sans artiste : « Album <nom> » / « Morceau <nom> »).
  - Critères : déterministe ; deux jours consécutifs ne répètent pas une œuvre tant qu'il reste
    des candidats non vus ; aucun candidat → `[]`.

- [ ] TRA-? **7.2 — Core · Persister les choix planifiés et les servir le jour venu** — P1, tier/2, 2 pts.
  Dépend de 7.1.
  - Portée : `ios/Track1Core/Sources/Track1Core/Features/Today/TodayViewModel.swift` (après un
    chargement réussi : calcule `ReminderPlan.plan`, l'enregistre par
    `DailyRecommendationStore.save`, l'expose en `public private(set) var upcoming: [PlannedReminder]`),
    `DailyRecommendationStore.swift` seulement si l'ordre ou la limite de 40 entrées l'exige ;
    tests `TodayViewModelTests.swift`, `DailyRecommendationStoreTests.swift`.
  - Critères : un choix planifié pour demain est servi demain même si le catalogue a changé ; un
    changement de révision du profil écarte les choix planifiés et en recalcule ; le choix
    d'aujourd'hui n'est pas modifié par la planification.

- [ ] TRA-? **7.3 — Programmer les notifications locales `ReminderScheduler`** — P1, tier/2, 2 pts, ∥.
  - Portée : créer `ios/Track1/App/ReminderScheduler.swift` (`0480`) et
    `ios/Track1Tests/ReminderSchedulerTests.swift` (`0481`).
  - Contrat : `protocol ReminderCenter: Sendable { func authorization() async -> ReminderAuthorization; func requestAuthorization() async -> Bool; func pendingIdentifiers() async -> [String]; func remove(identifiers: [String]) async; func add(identifier: String, title: String, body: String, date: DateComponents) async }` ;
    `enum ReminderAuthorization { case notDetermined, denied, authorized }` ;
    `struct ReminderScheduler { init(center: ReminderCenter); func replace(with reminders: [PlannedReminder]) async }`.
    Identifiant `daily-<localDate>` ; `replace` retire tous les `daily-*` en attente puis ajoute les
    nouveaux ; ne fait rien sans autorisation. Une implémentation réelle enveloppe
    `UNUserNotificationCenter`.
  - Critères : avec un faux centre, `replace` laisse exactement les identifiants du plan ; refusé
    → aucun ajout.

- [ ] TRA-? **7.4 — DS · `DeviceOutline` et `NotificationPreview`** — P1, tier/1, 2 pts, ∥.
  - Portée : créer dans `ios/Track1/DesignSystem/Components/Onboarding/` `DeviceOutline.swift`
    (`0482`), `NotificationPreview.swift` (`0483`), et
    `ios/Track1Tests/DesignSystem/NotificationComponentsTests.swift` (`0484`).
  - Contrat : Figma `317:5225` (contour d'iPhone 275 × 585, décoratif) et `317:5226` (carte de
    verre 327 × 82 : `AppMark`, titre `labelMedium`, corps `bodySmall` sur deux lignes).
    `struct NotificationPreview: View { init(title: String, body: String) }`.

- [ ] TRA-? **7.5 — Écran d'opt-in et étape d'onboarding** — P1, tier/2, 3 pts. Dépend de 4.6, 7.3, 7.4.
  - Portée : créer `ios/Track1/Features/Onboarding/NotificationOptInView.swift` (`0485`) et son
    test (`0486`) ; `OnboardingFlowView.swift` (`includesNotifications: true`) ;
    `ios/Track1/App/RootView.swift` (présentation unique de l'écran, au lancement, pour un profil
    créé avant cette version quand l'autorisation est `notDetermined`) ;
    `ios/Track1/App/UITestFixtureReaders.swift` (faux centre pour les tests UI) ;
    `ios/Track1UITests/ProfileFlowTests.swift`.
  - Contrat : Figma `317:5142` : titre `title1` « Obtiens ta recommandation quotidienne »,
    sous-titre `bodyMedium`, scène (contour + aperçu), « Continuer ». « Continuer » appelle
    `requestAuthorization()` (la modale système), puis termine l'onboarding **quelle que soit la
    réponse**. L'écran n'est montré qu'une fois (drapeau local).
  - Critères : accepter ou refuser mène à Aujourd'hui ; l'écran ne revient pas au lancement
    suivant ; un profil existant le voit une seule fois.

- [ ] TRA-? **7.6 — Programmer les rappels après chaque chargement et ouvrir Aujourd'hui au toucher** — P1, tier/2, 2 pts. Dépend de 7.2, 7.3.
  - Portée : `ios/Track1/App/AppContainer.swift` (construit le planificateur),
    `ios/Track1/Features/Today/TodayView.swift` (après `model.load`, `scheduler.replace(with: model.upcoming)`),
    `ios/Track1/App/Track1App.swift` (délégué de notifications : un toucher sélectionne l'onglet
    Aujourd'hui et revient à sa racine ; aucune bannière quand l'app est au premier plan).
  - Critères : après un chargement autorisé, 7 notifications `daily-*` sont en attente ; après un
    changement de genres, elles sont remplacées ; test unitaire du routage au toucher.

### Partie 8 — Partage avec lien (P2)

Incrément : le bouton partager du lecteur envoie un lien qui ouvre une page web, ou l'app si elle
est installée. Prérequis : domaine et fichier `apple-app-site-association` (Q8).

- [ ] TRA-? **8.1 — Core · Construire et relire un lien de partage `ShareLink`** — P2, tier/2, 1 pt, ∥.
  - Portée : créer `ios/Track1Core/Sources/Track1Core/Navigation/ShareLink.swift` et son test ;
    `ios/Track1Core/Sources/Track1Core/App/AppConfiguration.swift` (`shareBaseURL`, clé
    `Track1ShareBaseURL`, mêmes règles `https` que l'URL d'API).
  - Contrat : `public enum ShareLink { public static func url(for: NodeIdentity, base: URL) -> URL?; public static func identity(from: URL, base: URL) -> NodeIdentity? }`
    — chemin `/s/<type>/<slug>` ; `nil` hors projets et morceaux, hôte différent, chemin inattendu.
- [ ] TRA-? **8.2 — Serveur · Rendu HTML de la page de partage** — P2, tier/2, 2 pts, ∥.
  - Portée : créer `src/mobile/share-page.ts` et `test/mobile/share-page.test.ts` : fonction pure
    nœud → HTML (titre, artistes, pochette, phrases de l'article, liens d'écoute), tout échappé,
    URLs validées par hôte.
- [ ] TRA-? **8.3 — Serveur · Route publique de la page de partage** — P2, tier/3, 2 pts. Dépend de 8.2.
  - Portée : `src/mobile/router.ts`, `docs/track1-api.md` ; `404` pour un nœud inconnu ou d'un
    autre type.
- [ ] TRA-? **8.4 — Infra · Servir `apple-app-site-association`** — P2, tier/3, 1 pt. Dépend de Q8.
  - Portée : `deploy/` (configuration du serveur frontal) ou route serveur, selon l'hébergement.
- [ ] TRA-? **8.5 — iOS · Capacité Associated Domains** — P2, tier/3, 1 pt. Dépend de 8.4.
  - Portée : créer `ios/Track1/Resources/Track1.entitlements` (`04B1`), `CODE_SIGN_ENTITLEMENTS`
    dans `ios/Configurations/Production.xcconfig`, `Info.plist` (`Track1ShareBaseURL`) ; nouveau
    profil App Store à fournir par Raphael.
- [ ] TRA-? **8.6 — iOS · Bouton partager du lecteur** — P2, tier/2, 1 pt. Dépend de 8.1, 5.8.
  - Portée : `ios/Track1/Features/Node/PlayerView.swift` (Figma `338:2561`, feuille de partage
    système avec l'URL de `ShareLink` et le titre ; identifiant `player-share`).
- [ ] TRA-? **8.7 — iOS · Ouvrir un lien entrant dans le lecteur** — P2, tier/2, 2 pts. Dépend de 8.1, 5.9, 8.5.
  - Portée : `ios/Track1/App/Track1App.swift`, `RootView.swift`, `AppRouter.swift` : URL validée
    par `ShareLink.identity`, onglet Aujourd'hui, `.player` poussé ; pendant l'onboarding le lien
    attend l'arrivée des onglets ; URL refusée → rien.

## Vue d'ensemble

| Partie | Tâches | Priorité | Sur le chemin de la build TestFlight v1 |
| --- | --- | --- | --- |
| 1 — CI hébergée | 4 (+1 conditionnelle) | P0 | 1.1 seulement |
| 2 — TestFlight | 6 | P0 | toutes |
| 3 — Coquille v1 | 4 | P0 | 3.1, 3.2, 3.3 |
| 4 — Onboarding profil | 8 | P0 | toutes |
| 5 — Accueil et lecteur | 11 | P0 | 5.1 à 5.9 |
| 6 — Onglet Genres | 4 | P0 | toutes |
| 7 — Rappel quotidien | 6 | P1 | non |
| 8 — Partage | 7 | P2 | non |

Total : **38 tâches P0** (dont 1 conditionnelle et 3 de suppression à faire après TestFlight),
**6 P1**, **7 P2**.

Ordre d'attaque recommandé :

1. **Vague A, en parallèle dès la validation** : 1.1 · 2.1 · 2.2 · 2.5 · 3.1 · 4.1 · 4.3 · 5.1 ·
   5.2 · 5.3 · 5.4 · 5.5 · 5.6 · 5.7. Les tâches `Track1Core` ne touchent pas le pbxproj et ne se
   gênent pas.
2. **Vague B** : 1.2 → 1.3 → 1.4 (en série) · 2.3 → 2.4 · 3.2 · 3.3 · 4.2 · 4.4 · 4.7 · 4.8 ·
   5.8 · 6.1.
3. **Première build TestFlight (2.6) dès que 2.1 et 2.4 sont mergées**, avec l'app telle qu'elle
   est : elle prouve la chaîne et fait partir la revue bêta.
4. **Vague C** : 4.5 → 4.6 · 5.9 · 6.2 · 6.3 → 6.4.
5. **Build TestFlight v1** : relancer le workflow une fois 3.3, 4.6, 5.9 et 6.4 mergées.
6. Ensuite : 3.4, 5.10, 5.11 (suppressions), puis Partie 7, puis Partie 8.

Chemins critiques : pipeline 1.1 → 2.3 → 2.4 → 2.6 ; app 4.1 → 4.2 → 4.5 → 4.6 → 6.4 et
5.3/5.4/5.7 → 5.8 → 5.9.

## Prérequis à fournir par Raphael

Bloquants pour 2.6 (aucun agent ne peut les produire) :

1. Programme Apple Developer actif et **Team ID**.
2. Identifiant d'app `com.dropcliffs.track1` enregistré (explicite), et **fiche App Store Connect**
   pour ce bundle (nom, langue, SKU). À confirmer : existe-t-elle déjà ?
3. **Certificat Apple Distribution** exporté en `.p12` avec son mot de passe.
4. **Profil de provisionnement App Store** pour `com.dropcliffs.track1`, et son nom exact.
5. **Clé d'API App Store Connect** (rôle App Manager) : Key ID, Issuer ID, fichier `.p8`.
6. Dans GitHub : Environment `testflight` avec Raphael en relecteur requis, les 6 secrets et les 3
   variables nommés en 2.4 (dont l'URL d'API de production, qui doit finir par `/mobile/v1`).
7. TestFlight : informations de test (description bêta, e-mail de retour), et le choix du groupe —
   **interne** (immédiat, mais chaque ami doit être utilisateur App Store Connect de l'équipe) ou
   **externe** avec lien public (revue bêta d'Apple, de l'ordre d'un jour pour la première build).
8. Réglages du dépôt public : Actions → approbation requise pour **tous** les contributeurs
   externes ; vérifier que `CLAUDE_CODE_OAUTH_TOKEN` reste un secret de dépôt.

Non bloquants pour P0 : les cinq PNG de disques si l'export MCP échoue (4.2) ; pour P2, un domaine
dont la racine peut servir `/.well-known/apple-app-site-association`, et un nouveau profil avec
Associated Domains.

## Risques

- **R1 — Dépôt public et runners auto-hébergés (ouvert aujourd'hui).** Une PR de fork exécute son
  code sur les machines de Raphael. Garde-fou : Partie 1 en premier ; en attendant, le réglage
  d'approbation du prérequis 8. Après la Partie 1, seuls des déclencheurs de confiance (`push`
  sur `main`, `workflow_dispatch`) atteignent les runners auto-hébergés.
- **R2 — Le Xcode épinglé (`Xcode 26.4 (17E192)`) peut manquer sur l'image hébergée.** Non
  vérifiable depuis cette session. Garde-fou : règle d'arrêt de 1.1 ; repli sur le runner du Mac
  pour `ios-check` (PR du dépôt seulement) et pour le workflow TestFlight.
- **R3 — `ios-check` plus lent ou instable à froid** (pas de cache DerivedData ni de simulateur
  réutilisé). Garde-fou : délai porté à 45 min, le check n'est pas requis, mesure sur les deux
  premiers runs, même repli que R2.
- **R4 — Secrets de signature.** Garde-fou : Environment protégé, `workflow_dispatch` sur `main`
  uniquement, secrets passés par `env`, trousseau temporaire supprimé en `always()`, test vitest
  sur la forme du workflow.
- **R5 — Première validation App Store Connect jamais passée** (icône, manifeste, orientations,
  revue bêta). Garde-fou : envoyer une build tôt avec l'app actuelle ; chaque rejet devient un
  ticket court.
- **R6 — Suppression de la recherche et des fiches : tests UI et gardes vitest cassés.**
  Garde-fou : la bascule (3.3, 5.9) et la suppression (3.4, 5.10, 5.11) sont des tâches séparées ;
  les suppressions n'enlèvent que des symboles sans référence et gardent
  `test/ios-node-page-spec.test.ts`.
- **R7 — Profils existants illisibles après 4.1.** Garde-fou : champs optionnels, test sur un
  fichier v2 d'avant le changement, disque inconnu toléré.
- **R8 — Découpage en phrases médiocre sur de vrais articles** (balisage, listes, abréviations).
  Garde-fou : tests sur deux articles réels de `cache/` ; règle de rattachement des fragments.
- **R9 — Le choix du jour change pour les installations existantes** (artistes exclus).
  Assumé ; un seul recalcul, couvert par test.
- **R10 — Le « feeling » du lecteur (« snappy et subtil ») n'est pas testable automatiquement.**
  Garde-fou : paramètres de mouvement fixés dans le ticket, validation par Raphael sur la build
  TestFlight ; un réglage ultérieur est un ticket tier/1.
- **R11 — La notification annonce une œuvre que l'app ne montre pas.** Garde-fou : choix
  planifiés persistés et servis tels quels (7.2), tests dédiés.
- **R12 — `www.figma.com` refusé par le proxy de l'environnement cloud** : les URLs d'assets du
  MCP ne se téléchargent pas. Garde-fou : captures en base64 par le MCP ; à défaut, export manuel
  par Raphael, ou ajout de l'hôte à l'environnement.
- **R13 — Conflits de `project.pbxproj` entre worktrees parallèles.** Garde-fou : identifiants
  attribués par tâche dans ce plan, aucun nouveau groupe, pas plus de trois PR touchant le pbxproj
  ouvertes en même temps.

## Critères de sortie

P0 (objectif de la session) :

- Aucun job déclenché par `pull_request` ou `issue_comment` ne tourne sur un runner auto-hébergé
  (ou, si la règle d'arrêt de 1.1 a joué, seul `ios-check`, limité aux PR du dépôt).
- Le workflow `ios-testflight` produit, depuis `main`, une build visible dans TestFlight, installée
  par au moins un testeur autre que Raphael.
- Sur cette build : premier lancement Welcome → pseudo → disque → genres → accueil du jour ;
  « Découvrir » ouvre le lecteur ; la phrase centrale est mise en avant au défilement ; Apple Music
  et Spotify s'ouvrent ; retour à l'accueil ; l'onglet Genres montre disque, pseudo, genres
  modifiables et ancienneté ; ni recherche ni fiche avec arêtes ne sont atteignables.
- `npm run check`, `swift test --package-path ios/Track1Core` et `ios-check` verts sur `main`.

P1 : l'écran d'opt-in ouvre la modale système ; le lendemain à 09:00 une notification nomme
l'œuvre que l'app montre ce jour-là.

P2 : le lien partagé affiche la page web sans l'app et ouvre le lecteur avec l'app.

## Arbitrages demandés à Raphael

Chaque question a un défaut, appliqué par le plan si rien n'est dit.

- **Q1 — Notifications : locales (D4) ou APNs serveur ?** Défaut : locales, contenu nommant
  l'œuvre comme sur la maquette. Renverse le choix du 2026-10-05 ; le code serveur APNs reste en
  place, inactif.
- **Q2 — Testeurs TestFlight : internes ou externes ?** Défaut : groupe externe avec lien public,
  première build soumise à la revue bêta dès 2.6.
- **Q3 — La review Codex doit-elle passer dans GitHub Actions (1.5) ?** Elle est aujourd'hui
  publiée depuis le Mac par un compte humain, et `review-gate` s'appuie sur ce compte. Défaut : elle
  reste locale ; 1.5 n'est pas lancée.
- **Q4 — Langue des textes.** La maquette mélange le français et l'anglais (« What's your
  pseudo ? », « Welcome on Track1 », « Choose your profile disc », « Your genres », « You've been
  digging on track1 for 145 days », « Daily music explorations »). Le dépôt a déjà tranché
  « interface en français » (gate du 2026-10-11). Défaut : français — « C'est quoi ton pseudo ? »,
  « Bienvenue sur track1 », « Choisis ton disque de profil », « Tes genres », « Tu explores
  track1 depuis 145 jours », tagline actuelle conservée.
- **Q5 — Consentement et Réglages, absents de la maquette.** Défaut : l'écran de consentement
  reste avant Welcome ; l'accès aux Réglages reste dans l'onglet Genres, en haut à droite. À
  savoir : aucune clé Segment n'est embarquée aujourd'hui (`Track1SegmentWriteKey` absent de
  `Info.plist`), donc la build TestFlight demandera le consentement sans qu'aucune mesure ne parte.
- **Q6 — « Polish » de Welcome et de la sélection des genres.** Les notes ne listent aucun écart.
  Défaut : alignement des mesures sur les nodes, boucle du fond à 30 s, rien d'autre.
- **Q7 — Note de spec de l'écran pseudo vide (`362:5001`).** C'est une copie de la note Welcome.
  Défaut : ignorée pour cet écran.
- **Q8 — Domaine des liens de partage (P2).** La racine du domaine doit servir le fichier
  d'association. Défaut : aucun ; la Partie 8 attend la réponse.
- **Q9 — Genres affichés sur l'accueil.** La spec dit « les genres de la reco du jour ». Défaut :
  les genres du nœud recommandé (3 au plus), et non les genres cochés dans le profil ; la ligne
  « parce que tu explores … » disparaît avec l'ancienne barre.
- **Q10 — Enregistrement dans l'onglet Genres.** La maquette n'a pas de bouton. Défaut :
  enregistrement automatique, dernier genre non décochable.
- **Q11 — Bouton partager avant la P2.** Défaut : absent du lecteur tant que la Partie 8 n'est
  pas livrée (pas de bouton inerte).
- **Q12 — Profils créés avant la v1 (sans pseudo ni disque).** Défaut : pas de ré-onboarding ;
  disque vide, pas de nom, pas de ligne d'ancienneté.

## Annexe A — Valeurs lues dans le Figma (2026-11-16)

Cadre de référence 393 × 852 (onboarding) ou 393 × 844 (onglets). Positions en points depuis le
haut du cadre.

| Écran | Node | Valeurs |
| --- | --- | --- |
| Welcome | `316:4853` | marque 122,9 à y 282,8 (`362:4910`) ; bloc nom + tagline `316:4855` à y 429,6 ; barre d'action à y 744 |
| Pseudo | `362:2894` | titre `Mono/Item` 18/22 à y 164 ; champ 34/41 à y 344 ; clavier à y 520 |
| Disque | `362:3145` | titre y 164, sous-titre y 198 ; emplacement 143,8 à (125 ; 264,9) ; grille à (43 ; 506), tuiles 85,6, pas 107,6 ; bouton 361 × 52 |
| Genres | `316:5066` | en-tête `Title/1` 28/34 + `Body/Medium` 15/22 à y 78 ; cartes 361 de large, repliée 70, pas 82 ; compteur + bouton dans la barre à y 657 |
| Opt-in | `317:5142` | titre `Title/1` sur 3 lignes à y 78 ; sous-titre y 188 ; contour 275 × 585 ; aperçu 327 × 82 ; barre à y 657 |
| Accueil | `324:1788` | date 53 × 72 à y 72 ; pilules 28 de haut à y 160 ; pochette 308,8 à y 222 ; badge y 542,8 ; titre `Title/2` 22/28 y 579,8 ; sous-titre `Body/Medium` y 613,8 ; bouton 133 × 44 y 647,8 |
| Lecteur | `338:2461` | colonne 309 à x 42 ; texte 22/34 ; 56 entre paragraphes ; retour et partage 40 × 40 à y 56 (x 24 et x 329) ; barre 306,3 × 50 à y 694 ; barre d'onglets à y 749 |
| Splash | `318:6513` | marque 184,3 à y 330, centrée |
| Profil | `318:6781` | anneau 89 à y 78 ; nom `Title/3` 20/25 à y 183 ; titre de section `Mono/Item` à y 236 ; pied `Mono/Micro` 11/14 sur 2 lignes à y 702 |
| Barre d'onglets | `324:1792` | 393 × 95 à y 749 ; pilule 200 × 62 à x 96,5 ; onglets 96 × 54 ; icônes 20 |

Couleurs liées : `theme.color.node.project` `#E6A23A`, `theme.color.node.track` `#F0642D`,
`theme.color.text.primary` `#F6E9D8`, `secondary` `#C8B6A3`, `tertiary` `#8D7A6D`,
`background.base` `#120C0A`, `background.elevated` `#1A110E`, `action.primary` `#F6E9D8`.
