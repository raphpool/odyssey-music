# track1 v1 — app iOS, de la maquette Figma « v1 » à une build TestFlight

Plan rédigé le 2026-11-16 (phase `plan` de `/delivery-process`), **validé par Raphael le même
jour** avec les arbitrages consignés en fin de document (relayés par le dispatcher). Les tickets
Linear existent (TRA-703 à TRA-747) dans le projet
[track1 v1 — TestFlight](https://linear.app/workspaceperso/project/track1-v1-testflight-ffcff837bd1b).

Source de vérité design : Figma `phudxrQNlzQJafXLma4FyX`, section `362:4977` (« v1 »), relue le
2026-11-16 après les retouches de Raphael (note `362:5001` vidée, barre `374:1852` ajoutée).
Priorités : notifications = **P1**, tout le reste = **P0**. Le partage avec lien est sorti du plan
(`docs/plans/track1-partage.md`). Objectif : une build **TestFlight** que Raphael teste lui-même,
puis qu'il ouvre à ses amis, **sans avoir à intervenir d'ici là** au-delà des prérequis listés.

## Problème

L'app iOS native (`ios/`) montre aujourd'hui : consentement → Welcome → sélection des genres →
onglet Aujourd'hui dont la racine est une **fiche de nœud avec arêtes**, un onglet Genres en lecture
seule, une **recherche** en feuille. Elle n'est distribuée nulle part : `ios/scripts/archive.sh`
produit une IPA ad hoc sur le Mac de Raphael et aucune build TestFlight n'a jamais été envoyée.

La section Figma « v1 » rescope le produit (note `362:4978`) : on enlève la recherche et les fiches
avec arêtes, on ajoute la création de profil dans l'onboarding, l'accueil devient une carte du
jour et la lecture un « lecteur » phrase par phrase.

Côté livraison, trois faits changent la donne :

1. Le dépôt est **public** : les runners hébergés par GitHub sont gratuits, et tout workflow
   `pull_request` resté sur un runner auto-hébergé exécute le code d'un fork sur une machine de
   Raphael.
2. Les runners auto-hébergés sont **probablement éteints** (derniers runs le 2026-10-24/25) : tant
   que les workflows les ciblent, les checks requis (`typecheck`, `lint`, `test`, `diff-size`,
   `review-gate`) restent en file et **aucune PR ne peut être mergée**.
3. Le `review-gate` exige pour le tier/3 un statut `codex-deep-review` publié par le compte de
   `.github/review-gate-authors.txt`, donc depuis le Mac de Raphael, alors que le pilotage se fait
   depuis le cloud.

### Inventaire de la section Figma `362:4977`

| Node | Écran | Couvert par |
| --- | --- | --- |
| `362:4978` | Note « Rescope » (plus de recherche, plus de fiches à arêtes, profil dans l'onboarding) | 3.4, 3.5, 5.9, 5.10, 5.11, Partie 4 |
| `316:4853` | 1.1 Welcome | 3.2, 4.7 |
| `362:1766` | Pseudo, champ vide (clavier ouvert, placeholder) | 4.4 |
| `362:2894` | Pseudo, champ rempli | 4.4 |
| `362:3008` | Disque de profil, rien de choisi | 4.2, 4.5 |
| `362:3145` | Disque de profil, un disque choisi | 4.5 |
| `316:5066` | Sélection des genres | 4.8 |
| `317:5142` | Opt-in notifications | Partie 7 (P1) |
| `324:1788` | Accueil du jour | 5.1, 5.2, 5.5, 5.6, 5.9 |
| `362:1611` | Accueil, variante ARTIST — calque masqué | Hors scope |
| `338:2461` | Lecteur | 5.3, 5.4, 5.7, 5.8, 5.9 |
| `318:6513` | Splash | 3.2, 3.3 |
| `318:6781` | Onglet Genres = profil, avec la barre « Sauvegarder » `374:1852` | Partie 6 |
| `324:1792` | Barre d'onglets à deux onglets | 3.4 |

## Non-buts

- Sortie publique App Store, fiche App Store, captures.
- **Partage avec lien** : reporté, voir `docs/plans/track1-partage.md`. Le lecteur est livré sans
  bouton partager.
- **Profils créés avant la v1** : ignorés. Aucune migration, aucune lecture des anciens fichiers ;
  au premier lancement de la v1 tout le monde repasse par l'onboarding.
- Android, le client Expo `mobile/`, le pipeline de génération, `cache/`, `web/`.
- Compte ou profil côté serveur : pseudo, disque et genres restent sur l'iPhone, hors analytics.
- Transport APNs serveur (`src/mobile/apns-sender.ts`) : laissé en place, inactif, non modifié.
- Recherche côté serveur (`src/mobile/search.ts`) : inchangée.
- Écran de consentement et Réglages : hors maquette, conservés tels quels.
- Workflows `deploy.yml`, `pull-cache.yml`, `sync-genre-cache.yml`, `top-up-genres.yml` : ils ne
  partent que sur `push` `main` ou `workflow_dispatch` et restent sur les runners auto-hébergés.
- Review Codex dans GitHub Actions : elle reste locale et facultative.
- `.claude/skills/delivery-process/references/tiers.md` : non modifié (voir D6).
- iPad, mode clair, catalogue de chaînes localisé, relèvement de la cible iOS 17.

## Décisions d'archi

### D1 — Deux onglets ; le lecteur est une destination poussée dans la pile d'Aujourd'hui

`AppTab` garde `today` et `genres`. `AppRoute.node` devient
`AppRoute.player(identity: NodeIdentity, context: NavigationContext)` : le lecteur prend une
identité de nœud et réutilise `NodeViewModel` (chargement, événements de vue, ouverture Apple Music
/ Spotify). La barre d'onglets reste visible sous le lecteur, comme dans `338:2461`.

**Rejeté :** `fullScreenCover` (masque la barre d'onglets que la maquette montre) ; garder
`NodeView` atteignable (la note Rescope l'exclut).

### D2 — Profil v3 : pseudo, disque et date de création obligatoires, aucun héritage

`Profile` passe en version 3 dans `profile.v3.json` avec `display_name`, `disc`, `created_at`
**obligatoires**. `ProfileStore` ne lit plus `profile.v2.json` ni `profile.v1.json` : sans fichier
v3, le profil est `.missing` et l'onboarding s'affiche. À la création du profil, les anciens
fichiers et l'historique des recommandations sont effacés.

**Rejeté :** champs optionnels en version 2 (c'était le premier jet du plan : il imposait un cas
« profil sans pseudo » dans chaque écran, écarté par l'arbitrage Q12) ; migration v2 → v3 (code et
tests pour une poignée d'installations de développement) ; compte serveur (hors brief).

### D3 — Lecteur : phrases et focus calculés dans `Track1Core`, accroche par un `ScrollTargetBehavior` maison

`ArticleSentences.split` (Foundation, `.bySentences`, plus nettoyage) donne un paragraphe par
phrase. `PlayerScroll` calcule, à partir des cadres mesurés, la phrase au centre et le décalage
d'accroche. La phrase au centre passe de 20 à 22 pt et de `#8D7A6D` à `#F6E9D8` (`338:2480`).
Le texte ne défile que sous le doigt.

**Rejeté :** `.scrollTargetBehavior(.viewAligned)` (aligne en haut sur iOS 17, la cible de
déploiement) ; expression régulière sur `. ` (casse sur « U.K. », « feat. ») ; `UICollectionView`
(non testable par `swift test`).

### D4 — Notifications (P1) : notifications locales planifiées sur l'appareil

Le choix du jour est calculé sur l'iPhone et la maquette `317:5226` nomme l'œuvre : seul
l'appareil peut l'écrire. À chaque chargement d'Aujourd'hui, l'app calcule et **persiste** les
choix des 7 jours suivants, puis programme une notification locale par jour à 09:00. Le jour venu
elle sert le choix persisté. Pas de capacité Push, pas de jeton, pas de clé APNs.

**Rejeté :** client APNs de TRA-346 (texte générique côté serveur, clé APNs à déployer,
entitlement, recette physique) ; Notification Service Extension (nouvelle cible, App Group).
Arbitrage Q1 : le choix APNs du 2026-10-05 est renversé. Limite assumée : sans ouverture de l'app
pendant 7 jours, les rappels s'arrêtent.

### D5 — CI sur runners hébergés ; TestFlight par un workflow que l'agent déclenche

- `ci`, `mobile-ci`, `review-gate`, `ai-review`, `claude` passent sur `ubuntu-latest`, `ios-ci`
  sur un runner macOS hébergé. Les noms de jobs ne changent pas : la protection de `main`
  (`typecheck`, `lint`, `test`, `diff-size`, `review-gate`) reste valide.
- `ios-testflight.yml` : `workflow_dispatch` seulement, garde `main`, Environment GitHub
  `testflight` **sans relecteur requis, restreint aux déploiements depuis `main`**. L'agent lance
  lui-même les envois. Signature manuelle (certificat Apple Distribution et profil App Store dans
  un trousseau temporaire), envoi par `xcodebuild -exportArchive` avec une clé d'API App Store
  Connect.
- Configuration `Production`, schéma `Track1`, bundle `com.dropcliffs.track1`. L'URL d'API est une
  variable de l'Environment, jamais écrite dans un `.xcconfig`.
- Deux groupes TestFlight : **interne** (Raphael, distribution automatique, sans revue Apple) et
  **externe** (amis, lien public, après revue bêta). Raphael teste sur le groupe interne avant
  d'ouvrir le groupe externe.

**Rejeté :** filtrer les forks en gardant les runners du Mac (file d'attente inchangée, runners
éteints) ; signature automatique « cloud » (crée des certificats par API depuis des machines
jetables, jamais vérifié ici) ; `fastlane` (dépendance pour trois commandes) ; variante `Preview`
sur TestFlight (seconde fiche App Store Connect à jeter) ; déclenchement sur `push` ou sur tag.

### D6 — Délégation du merge tier/3 à l'agent pour ce projet (2026-11-16)

Arbitrage de Raphael du 2026-11-16, relayé par le dispatcher : pour **les PR de ce plan, jusqu'à la
build TestFlight v1 (tâche 2.7)**, l'agent merge lui-même les PR tier/3, sans relecture humaine,
quand quatre conditions sont réunies : CI verte, review Claude (`review` d'`ai-review.yml`), **review
profonde Claude exécutée dans GitHub Actions** (job `deep-review`, tâche 1.2), et
`/code-review ultra` sans finding bloquant. `tiers.md` reste la règle par défaut hors de ce
périmètre et n'est pas modifié.

Trois garde-fous fixent la portée :

- **Activation par un acte de Raphael.** La délégation ne prend effet qu'une fois 1.2 mergée par
  Raphael lui-même : c'est la politique lue sur `main` qui fait accepter la review profonde par le
  `review-gate`. Avant, le gate exige `codex-deep-review` comme aujourd'hui.
- **Le gate ne se juge pas lui-même.** Une PR qui touche la machinerie de review
  (`gateIntegrityPath` : `ai-review.yml`, `review-gate.yml`, `.github/review-gate-authors.txt`,
  `scripts/ci/review-gate-policy*`, `scripts/ci/review-reuse*`, `REVIEW.md` à la racine,
  `.codex/scripts/publish-review-status.sh`) n'est jamais satisfaite par la review profonde
  d'Actions : seul `codex-deep-review` d'un compte autorisé compte. Sans cela, une PR pourrait
  neutraliser le job qui la juge, puisque les workflows `pull_request` s'exécutent dans la version
  de la PR.
- **Le statut vient du workflow.** La review profonde n'est reconnue que si son check-run est le
  job `deep-review` d'un run `pull_request` d'`ai-review.yml` sur ce SHA, pour cette PR, contre la
  branche par défaut : les mêmes preuves que pour `review` (TRA-520, TRA-526, TRA-529).

**Rejeté :** garder la relecture humaine de chaque tier/3 (bloque la livraison tant que Raphael
n'est pas disponible, contre son objectif) ; abaisser les tiers des tickets (interdit à un agent,
et faux : le risque ne change pas) ; publier `codex-deep-review` depuis Actions (le statut est lié
à un compte humain par construction, TRA-527).

Conséquence : **Raphael relit et merge deux PR, 1.1 et 1.2**, en une séance. Une seule PR était
demandée ; ce n'est pas possible sans casser une règle : 1.2 ne peut pas valider sa CI tant que
les workflows ciblent des runners éteints (il lui faut 1.1), et les deux réunies dépassent les 200
lignes d'une PR tier/3. Les deux touchent la machinerie du gate, donc aucune ne peut être confiée
à l'agent.

## Review et merge pendant ce projet

| Cas | Ce que demande le `review-gate` | Qui merge |
| --- | --- | --- |
| tier/1, tier/2 | `review` Claude en succès (un `codex-review` reste facultatif ; s'il est en échec, il bloque) | auto-merge |
| 1.1 et 1.2 | `codex-deep-review` publié par le compte de `.github/review-gate-authors.txt` (`.codex/scripts/publish-review-status.sh <pr> pass <sha> "<texte>" deep <url>`), ou merge administrateur (la protection ne s'applique pas aux administrateurs) | Raphael |
| tier/3 après 1.2, hors machinerie du gate | `review` + `deep-review` (Actions) en succès | l'agent, après `/code-review ultra` |
| tier/3 touchant `gateIntegrityPath` | `codex-deep-review` d'un compte autorisé | Raphael |

Le pilotage depuis le cloud n'a donc besoin du Mac pour aucune tâche après 1.2. Une review Codex
locale reste possible depuis une sous-session sur le Mac ; elle n'est requise nulle part.

## Découpage

Sept parties, chacune mergeable et déployable seule. Points : 1 ≈ 1–2 h, 2 ≈ 2–4 h, 3 ≈ une
demi-journée. Une tâche = un ticket = une PR. Le contrat complet de chaque tâche (signatures,
critères, tests, mesures) est dans son ticket Linear ; les mesures Figma font foi dans l'annexe A.

Conventions des tâches iOS :

- Logique sans SwiftUI → `ios/Track1Core/Sources/Track1Core/…`, test dans
  `ios/Track1Core/Tests/Track1CoreTests/…`, vérifiée par `swift test --package-path ios/Track1Core`.
- Fichier d'app ou de test d'app → entrée dans `ios/Track1.xcodeproj/project.pbxproj`. **Plage
  d'identifiants réservée : `0430–04BF`**, attribuée par tâche ; aucun nouveau groupe.
- L'app n'est compilée que par `ios-check` : pas de `xcodebuild` local.
- **Au pixel près (arbitrage Q6).** La référence est le node de l'écran, pas la note de spec :
  chaque mesure citée dans le ticket devient une constante nommée et testée.
- Interface en français (Q4). Police « Inter » du Figma = Roboto dans l'app.
- Lecture du Figma par le MCP (`get_design_context`, `get_screenshot` avec
  `enableBase64Response`) : `www.figma.com` est refusé par le proxy du cloud (R10).

### Partie 1 — CI et review sans le Mac (P0)

À attaquer en tout premier : rien d'autre ne peut merger avant 1.1.

- [ ] TRA-703 **1.1 — Basculer les workflows de PR sur des runners hébergés** — P0, tier/3, 2 pts.
  **Relue et mergée par Raphael.** `ci.yml` (6 jobs), `mobile-ci.yml`, `review-gate.yml`,
  `ai-review.yml`, `claude.yml` → `ubuntu-latest` ; `ai-review` limité aux PR du dépôt, `claude`
  aux auteurs `OWNER`/`MEMBER`/`COLLABORATOR` ; gardes `test/ci-policy.test.ts`,
  `test/ci-integrity-job.test.ts`, `test/native-ci-triggers.test.ts`. La PR valide sa propre CI.
- [ ] TRA-704 **1.2 — Faire accepter par le `review-gate` une review profonde Claude exécutée dans
  Actions** — P0, tier/3, 3 pts. Dépend de 1.1. **Relue et mergée par Raphael ; active D6.** Job
  `deep-review` dans `ai-review.yml`, sélection dans `review-gate.yml`, règle et
  `gateIntegrityPath` dans `scripts/ci/review-gate-policy.ts`, tests.
- [ ] TRA-705 **1.3 — Faire tourner `ios-check` sur un runner macOS hébergé** — P0, tier/3, 2 pts.
  Dépend de 1.2. Première PR tier/3 mergée par l'agent. `ios-ci.yml`, garde
  `test/native-ci-triggers.test.ts`. Règle d'arrêt si le Xcode épinglé manque (R2).
- [ ] TRA-706 **1.4 — Documenter la CI hébergée et le circuit de review** — P0, tier/1, 1 pt.
  Dépend de 1.2. `docs/track1-builds.md`.

### Partie 2 — Build TestFlight depuis GitHub Actions (P0)

Ne dépend d'aucune tâche d'app : la première build part avec l'app actuelle pour éprouver la
chaîne.

- [ ] TRA-707 **2.1 — Déclarer la conformité export et le manifeste de confidentialité** — P0,
  tier/3, 1 pt. Dépend de 1.2. `Info.plist`, `PrivacyInfo.xcprivacy` (pbxproj `04B0`),
  `test/ios-privacy-manifest.test.ts`.
- [ ] TRA-708 **2.2 — Extraire les validations communes d'`archive.sh`** — P0, tier/2, 1 pt. Dépend
  de 1.1. `ios/scripts/release-common.sh`.
- [ ] TRA-718 **2.3 — Script d'archive et d'envoi App Store Connect** — P0, tier/3, 2 pts. Dépend de
  1.2, 2.2. `ios/scripts/testflight.sh`, `ExportOptions-AppStore.plist`,
  `test/ios-testflight.test.ts`.
- [ ] TRA-729 **2.4 — Workflow `ios-testflight`** — P0, tier/3, 2 pts. Dépend de 1.3, 2.3.
  Environment `testflight` sans relecteur, restreint à `main`.
- [ ] TRA-709 **2.5 — Mode d'emploi TestFlight** — P0, tier/1, 1 pt. Dépend de 1.1.
  `docs/track1-testflight.md`.
- [ ] TRA-734 **2.6 — Première build TestFlight au groupe interne** — P0, tier/1, 1 pt. Dépend de
  2.1, 2.4 et des prérequis. L'agent lance le workflow ; Raphael reçoit la build sans revue Apple.
- [ ] TRA-741 **2.7 — Build v1 au groupe interne, puis ouverture du groupe externe** — P0, tier/1,
  1 pt. Dépend de 2.6, 3.4, 4.6, 5.9, 6.4. Clôt la délégation D6.

### Partie 3 — Coquille v1 : jetons, splash, deux onglets (P0)

- [ ] TRA-710 **3.1 — DS · Jetons de couleur et rôles typographiques de la v1** — P0, tier/1, 1 pt.
  Dépend de 1.1. Un seul ticket pour que les tâches parallèles ne se disputent pas
  `Track1Tokens.swift` et `Track1Typography.swift`.
- [ ] TRA-711 **3.2 — DS · Marque d'app `AppMark`** — P0, tier/1, 1 pt. Dépend de 1.1. pbxproj
  `0430`, `0431`.
- [ ] TRA-719 **3.3 — Splash pendant les chargements du lancement** — P0, tier/1, 2 pts. Dépend de
  3.1, 3.2. Figma `318:6513`. pbxproj `0432`, `0433`.
- [ ] TRA-720 **3.4 — Passer à deux onglets et retirer l'entrée de la recherche** — P0, tier/2,
  3 pts. Dépend de 3.1. Figma `324:1792`. `Track1TabBar`, `AppRouter`, `RootView`, tests UI.
- [ ] TRA-738 **3.5 — Supprimer le code de recherche devenu mort** — P0 après TestFlight, tier/2,
  2 pts. Dépend de 3.4. Suppression seule.

### Partie 4 — Onboarding v1 : créer son profil (P0)

Welcome → pseudo → disque → genres → Aujourd'hui.

- [ ] TRA-712 **4.1 — Core · Profil v3 : pseudo, disque, date de création** — P0, tier/3, 2 pts.
  Dépend de 1.2. `Profile.swift`, `ProfileStore.swift`, `ProfileIdentity.swift`.
- [ ] TRA-721 **4.2 — DS · Disques de profil** — P0, tier/1, 2 pts. Dépend de 4.1. Six imagesets,
  `ProfileDiscImage` (pbxproj `0440`, `0441`).
- [ ] TRA-722 **4.3 — Core · Ordre et verrous des étapes d'onboarding** — P0, tier/2, 1 pt. Dépend
  de 4.1. `OnboardingSteps.swift`.
- [ ] TRA-723 **4.4 — Écran pseudo** — P0, tier/2, 2 pts. Dépend de 3.1, 4.1. Figma `362:1766`,
  `362:2894`. pbxproj `0442`, `0443`.
- [ ] TRA-730 **4.5 — Écran de choix du disque** — P0, tier/2, 3 pts. Dépend de 3.1, 4.2. Figma
  `362:3008`, `362:3145`. pbxproj `0444`, `0445`.
- [ ] TRA-735 **4.6 — Brancher pseudo et disque dans le parcours** — P0, tier/2, 3 pts. Dépend de
  4.3, 4.4, 4.5. `OnboardingFlowView`, tests UI.
- [ ] TRA-724 **4.7 — Welcome au pixel près** — P0, tier/1, 2 pts. Dépend de 3.1, 3.2. Figma
  `316:4853`. Logotype vectoriel, `Roboto-Medium`, boucle du fond à 30 s.
- [ ] TRA-725 **4.8 — Sélection des genres au pixel près** — P0, tier/1, 2 pts. Dépend de 3.1.
  Figma `316:5066`. `GenresStepView`, `GenreAccordionCard`, `SubgenreChip`, `BottomActionBar`.

### Partie 5 — Aujourd'hui v1 : accueil du jour et lecteur (P0)

- [ ] TRA-713 **5.1 — Core · Ne recommander que des projets et des morceaux** — P0, tier/2, 1 pt.
  Dépend de 1.1. `Affinity.swift`, `TodayViewModel.swift`.
- [ ] TRA-714 **5.2 — Core · Modèle de l'accueil `TodayHome`** — P0, tier/2, 1 pt. Dépend de 1.1.
- [ ] TRA-715 **5.3 — Core · Découper l'article en phrases** — P0, tier/2, 2 pts. Dépend de 1.1.
  `ArticleSentences.swift`.
- [ ] TRA-716 **5.4 — Core · Géométrie du lecteur `PlayerScroll`** — P0, tier/2, 2 pts. Dépend de 1.1.
- [ ] TRA-726 **5.5 — DS · Badge de type : carré pour un projet, hexagone pour un morceau** — P0,
  tier/1, 1 pt. Dépend de 3.1. Figma `362:5098`, `362:5105`.
- [ ] TRA-727 **5.6 — DS · `DateBadge`, `GenrePillRow`, `DiscoverButton`** — P0, tier/1, 2 pts.
  Dépend de 3.1. Figma `324:1818`, `324:1820`, `324:1813`. pbxproj `0450`–`0453`.
- [ ] TRA-728 **5.7 — DS · Barre collante du lecteur `PlayerNowBar`** — P0, tier/1, 2 pts. Dépend
  de 3.1. Figma `338:2493`. pbxproj `0454`, `0455`.
- [ ] TRA-731 **5.8 — Écran lecteur `PlayerView` (non branché)** — P0, tier/2, 3 pts. Dépend de
  5.3, 5.4, 5.7. Figma `338:2461`. pbxproj `0456`, `0457`.
- [ ] TRA-736 **5.9 — Accueil du jour et route vers le lecteur (bascule)** — P0, tier/2, 3 pts.
  Dépend de 3.4, 5.1, 5.2, 5.5, 5.6, 5.8. Figma `324:1788`. pbxproj `0458`, `0459`.
- [ ] TRA-742 **5.10 — Supprimer les anciennes fiches, côté app** — P0 après TestFlight, tier/2,
  2 pts. Dépend de 5.9. Suppression seule.
- [ ] TRA-745 **5.11 — Supprimer les anciennes fiches, côté `Track1Core`** — P0 après TestFlight,
  tier/2, 2 pts. Dépend de 5.10. Suppression seule.

### Partie 6 — Onglet Genres v1 : profil et genres éditables (P0)

- [ ] TRA-717 **6.1 — Core · Ancienneté du profil `ProfileTenure`** — P0, tier/1, 1 pt. Dépend de 1.1.
- [ ] TRA-732 **6.2 — Extraire la liste de sélection partagée `GenreSelectionList`** — P0, tier/2,
  2 pts. Dépend de 4.8. pbxproj `0470`.
- [ ] TRA-733 **6.3 — DS · En-tête de profil `ProfileHeader`** — P0, tier/1, 1 pt. Dépend de 3.1,
  4.2. Figma `318:6911`, `318:7031`. pbxproj `0471`, `0472`.
- [ ] TRA-737 **6.4 — Onglet Genres v1 avec la barre « Sauvegarder »** — P0, tier/2, 3 pts. Dépend
  de 4.6, 6.1, 6.2, 6.3. Figma `318:6781`, `374:1852`.

### Partie 7 — Rappel quotidien (P1)

- [ ] TRA-739 **7.1 — Core · Planifier les choix des jours à venir `ReminderPlan`** — P1, tier/2,
  2 pts. Dépend de 5.1.
- [ ] TRA-743 **7.2 — Core · Persister les choix planifiés et les servir le jour venu** — P1,
  tier/2, 2 pts. Dépend de 7.1.
- [ ] TRA-744 **7.3 — Programmer les notifications locales `ReminderScheduler`** — P1, tier/2,
  2 pts. Dépend de 7.1. pbxproj `0480`, `0481`.
- [ ] TRA-740 **7.4 — DS · `DeviceOutline` et `NotificationPreview`** — P1, tier/1, 2 pts. Dépend de
  3.1, 3.2. Figma `317:5225`, `317:5226`. pbxproj `0482`–`0484`.
- [ ] TRA-746 **7.5 — Écran d'opt-in et étape d'onboarding** — P1, tier/2, 3 pts. Dépend de 4.6,
  7.3, 7.4. Figma `317:5142`. pbxproj `0485`, `0486`.
- [ ] TRA-747 **7.6 — Programmer les rappels après chaque chargement et ouvrir Aujourd'hui au
  toucher** — P1, tier/2, 2 pts. Dépend de 5.9, 7.2, 7.3.

## Vue d'ensemble

| Partie | Tâches | Priorité |
| --- | --- | --- |
| 1 — CI et review sans le Mac | 4 | P0 |
| 2 — TestFlight | 7 | P0 |
| 3 — Coquille v1 | 5 | P0 |
| 4 — Onboarding profil | 8 | P0 |
| 5 — Accueil et lecteur | 11 | P0 |
| 6 — Onglet Genres | 4 | P0 |
| 7 — Rappel quotidien | 6 | P1 |

Total : **39 P0** (dont 3 suppressions à faire après TestFlight) et **6 P1**.

Vagues (une tâche part dès que ses bloqueurs sont mergés) :

- **Vague 0, Raphael :** 1.1 → 1.2.
- **Vague A :** 1.3 · 1.4 · 2.1 · 2.2 · 2.5 · 3.1 · 3.2 · 4.1 · 5.1 · 5.2 · 5.3 · 5.4 · 6.1.
- **Vague B :** 2.3 · 3.3 · 3.4 · 4.2 · 4.3 · 4.4 · 4.7 · 4.8 · 5.5 · 5.6 · 5.7.
- **Vague C :** 2.4 · 4.5 · 5.8 · 6.2 · 6.3.
- **Vague D :** 2.6 (première build, groupe interne) · 4.6 · 5.9.
- **Vague E :** 6.4. **Vague F :** 2.7 (build v1).
- **Après TestFlight :** 3.5 · 5.10 · 5.11. **P1 :** 7.1 · 7.4, puis 7.2 · 7.3, puis 7.5 · 7.6.

Chemins critiques : pipeline 1.1 → 1.2 → 1.3 → 2.4 → 2.6 ; app 4.1 → 4.2 → 4.5 → 4.6 → 6.4 → 2.7
et 5.3/5.4/5.7 → 5.8 → 5.9 → 2.7. Pas plus de trois PR touchant le pbxproj ouvertes à la fois.

## Prérequis à fournir par Raphael

1. **Relire et merger 1.1 puis 1.2** (deux PR courtes, une séance).
2. Côté Apple : programme développeur actif et Team ID ; identifiant d'app
   `com.dropcliffs.track1` et fiche App Store Connect ; certificat Apple Distribution (`.p12` et
   mot de passe) ; profil de provisionnement App Store et son nom ; clé d'API App Store Connect
   (rôle App Manager : Key ID, Issuer ID, `.p8`).
3. Dans App Store Connect : un groupe **interne** en distribution automatique dont il est membre,
   un groupe **externe** (vide), les informations de test (description bêta, e-mail de retour).
4. Dans GitHub : l'Environment `testflight`, **sans relecteur requis, branches de déploiement
   limitées à `main`**, avec les secrets `IOS_DIST_CERT_P12_BASE64`, `IOS_DIST_CERT_PASSWORD`,
   `IOS_APPSTORE_PROFILE_BASE64`, `ASC_API_KEY_P8_BASE64`, `ASC_API_KEY_ID`, `ASC_API_ISSUER_ID`
   et les variables `TRACK1_TEAM_ID`, `TRACK1_API_BASE_URL` (finit par `/mobile/v1`),
   `TRACK1_APPSTORE_PROFILE_NAME`.
5. Réglage du dépôt : Actions → approbation requise pour tous les contributeurs externes.
6. Après avoir testé la build v1 du groupe interne : ajouter la build au groupe externe (revue
   bêta d'Apple) et partager le lien public.

Selon les cas : les cinq PNG de disques si l'export par le MCP échoue (4.2) ; `Roboto-Medium.ttf`
si Google Fonts n'est pas joignable depuis l'environnement d'implémentation (4.7).

## Risques

- **R1 — Aucune PR ne peut merger tant que 1.1 n'est pas sur `main`.** Les checks requis des
  autres PR restent en file sur des runners éteints. La PR 1.1, elle, exécute ses workflows dans
  sa propre version (`pull_request` lit les fichiers de la PR) : ses checks tournent sur runners
  hébergés. Ce qui la bloque est le `review-gate` : le fichier de workflow vient de la PR, mais la
  politique et la liste des auteurs sont lues sur `main`, et `.github/` classe la PR en tier/3,
  donc le gate attend `codex-deep-review`. Garde-fou : 1.1 est l'une des deux PR que Raphael merge
  (statut publié depuis son compte, ou merge administrateur) ; toutes les autres tâches sont
  bloquées par elle dans Linear.
- **R2 — Le Xcode épinglé (`Xcode 26.4 (17E192)`) peut manquer sur l'image macOS hébergée.**
  Garde-fou : règle d'arrêt de 1.3 ; `ios-check` n'est pas un check requis, donc les tâches d'app
  ne sont pas bloquées ; le workflow TestFlight suit le runner retenu par 1.3.
- **R3 — `ios-check` lent ou instable à froid.** Délai porté à 45 min, mesure sur deux runs, même
  repli que R2.
- **R4 — Secrets de signature sans relecteur requis.** Ils reposent sur trois protections :
  l'Environment n'accepte que `main`, le workflow n'a que `workflow_dispatch`, et toute PR sous
  `.github/` passe la review profonde. Les secrets ne transitent que par `env`, le trousseau
  temporaire est détruit en `always()`.
- **R5 — Délégation D6 mal bornée.** Garde-fous : activation par le merge de 1.2 par Raphael,
  exception `gateIntegrityPath`, preuve d'origine du check-run, fin de la délégation à 2.7.
- **R6 — Première validation App Store Connect jamais passée.** Une build part tôt (2.6) avec
  l'app actuelle ; chaque rejet devient un ticket court.
- **R7 — Retrait de la recherche et des fiches : tests UI et gardes vitest cassés.** Bascule (3.4,
  5.9) et suppression (3.5, 5.10, 5.11) sont séparées ; `test/ios-node-page-spec.test.ts` reste.
- **R8 — Découpage en phrases médiocre sur de vrais articles.** Tests sur deux articles réels de
  `cache/`.
- **R9 — Le « feeling » du lecteur n'est pas testable automatiquement.** Paramètres fixés dans le
  ticket ; Raphael juge sur la build interne ; un réglage est un ticket tier/1.
- **R10 — `www.figma.com` refusé par le proxy du cloud.** Les URLs d'assets du MCP ne se
  téléchargent pas. Captures en base64 par le MCP ; à défaut, export par Raphael ou ajout de
  l'hôte à l'environnement.
- **R11 — La notification annonce une œuvre que l'app ne montre pas.** Choix planifiés persistés
  et servis tels quels (7.2).
- **R12 — Conflits de `project.pbxproj` et des fichiers de jetons.** Identifiants attribués par
  tâche, jetons et rôles regroupés en 3.1.
- **R13 — Texte français plus long que la maquette anglaise** (Welcome : la tagline est contrainte
  à la largeur du logotype, 136 pt). Elle passe sur trois lignes ; à juger sur la build interne.

## Critères de sortie

P0 :

- Aucun job déclenché par `pull_request` ou `issue_comment` ne tourne sur un runner auto-hébergé
  (ou, si la règle d'arrêt de 1.3 a joué, seul `ios-check`, limité aux PR du dépôt).
- Une PR tier/3 hors machinerie du gate a été mergée par l'agent avec `review` et `deep-review`
  verts (1.3 en est la preuve).
- Le workflow `ios-testflight`, lancé par l'agent, a produit une build que Raphael a installée
  depuis le groupe interne.
- Sur la build v1 : Welcome → pseudo → disque → genres → accueil du jour ; « Découvrir » ouvre le
  lecteur ; la phrase centrale est mise en avant ; Apple Music et Spotify s'ouvrent ; l'onglet
  Genres montre disque, pseudo, genres modifiables, « Sauvegarder » et l'ancienneté ; ni recherche
  ni fiche à arêtes ne sont atteignables. Chaque écran correspond à son node Figma.
- `npm run check`, `swift test --package-path ios/Track1Core` et `ios-check` verts sur `main`.

P1 : l'écran d'opt-in ouvre la modale système ; le lendemain à 09:00 une notification nomme
l'œuvre que l'app montre ce jour-là.

## Arbitrages du gate (2026-11-16, relayés par le dispatcher)

- **Q1** Notifications locales : oui, le choix APNs du 2026-10-05 est renversé (D4).
- **Q2** Testeurs externes, à condition que Raphael teste d'abord : groupe interne puis groupe
  externe (D5, 2.6, 2.7).
- **Q3** La review Codex reste locale ; voir « Review et merge pendant ce projet ».
- **Q4** Interface en français.
- **Q5** Consentement et Réglages conservés ; l'accès aux Réglages reste dans l'onglet Genres.
- **Q6** Au pixel près sur les nodes des écrans, pas sur les notes de spec.
- **Q7** La note `362:5001` est vidée ; l'écran pseudo vide est dû : clavier ouvert à l'apparition,
  champ actif, placeholder qui disparaît à la première lettre.
- **Q8** Pas de domaine : le partage sort du plan.
- **Q9** Les genres de l'accueil sont ceux du nœud recommandé.
- **Q10** Onglet Genres : bouton collant « Sauvegarder » avec fondu (`374:1852`), pas
  d'enregistrement automatique.
- **Q11** Pas de bouton partager dans le lecteur.
- **Q12** Profils existants ignorés (D2).
- **Délégation tier/3** (D6), **Environment `testflight` sans relecteur** (D5), **runners
  auto-hébergés présumés éteints** (R1).

Points laissés au jugement de Raphael sur la build interne, avec le défaut appliqué :

- Couleur du badge PROJECT : la carte `324:1806` porte `#A85D8A` sans variable ; la note
  `362:5098` lie `theme.color.node.project` `#E6A23A`, et c'est la seule source pour TRACK
  (`#F0642D`). Défaut : les variables.
- Écran pseudo : la maquette garde une barre « Continuer » sous le clavier. Défaut : elle est
  rendue telle quelle, recouverte par le clavier, active quand le pseudo est valide.
- L'annotation de `374:1852` (« Tap → native iOS notification permission alert ») vient du
  composant copié. Défaut : ignorée, le bouton enregistre.

## Annexe A — Mesures lues dans le Figma (2026-11-16)

Cadres 393 × 852 (onboarding) et 393 × 844 (onglets). `y` = distance au haut du cadre, en points.
Couleurs liées : `text.primary` `#F6E9D8`, `text.secondary` `#C8B6A3`, `text.tertiary` `#8D7A6D`,
`text.inverse` `#0B0706`, `text.disabled` `#5B4A41`, `background.base` `#120C0A`,
`background.elevated` `#1A110E`, `action.primary` `#F6E9D8`, `action.disabled` `#241713`,
`icon.primary` `#F6E9D8`, `icon.secondary` `#C8B6A3`, `node.project` `#E6A23A`, `node.track`
`#F0642D`. Styles : `Title/1` JetBrains Mono Bold 28/34, `Title/2` 22/28, `Title/3` 20/25,
`Mono/Item` Regular 18/22, `Mono/Section` Bold 15/20, `Mono/Tag` Regular 13/16, `Mono/Micro` Medium
11/14, `Body/Medium` Inter Regular 15/22, `Body/Small` 13/18, `Label/Large` Inter SemiBold 17/22,
`Label/Medium` 15/20.

**Éléments communs**

- Fond des écrans d'onboarding (`362:1766`, `362:3008`) : dégradé vertical `#3D3429` à 0 % →
  `#1A110E` à 33,099 %. Onglet Genres (`318:6781`) : même dégradé, arrêt à 30,746 %.
- Fond de l'accueil et du lecteur (`324:1790`, `338:2463`) : teinte de la pochette en trois bandes
  à 0 %, 5 %, 10 %, puis `background.elevated` à 15 % (exemple : `rgb(74,85,82)`, `rgb(68,66,58)`,
  `rgb(50,42,34)`).
- Bouton primaire (`16:20`) : hauteur 52, rayon complet, fond `action.primary`, libellé
  `Label/Large` `text.inverse`, marge horizontale 24. Désactivé : fond `action.disabled` à 42 %
  d'opacité, libellé `text.disabled`.
- Barre d'action basse : marges haut 24, bas 32, côtés 16, écart 8. Avec fondu : dégradé vertical
  `rgba(26,17,14,0)` à 22,821 % → `#1A110E` à 44,103 %. Compteur au-dessus du bouton : JetBrains
  Mono Medium 16/20, `text.secondary`.
- Barre d'onglets (`324:1792`) : 393 × 95 en bas, dégradé `rgba(18,12,10,0)` → `#120C0A`, marges
  haut 12, bas 21, côtés 25. Pilule : fond `rgba(255,255,255,0.15)`, marge 4, rayon complet, ni
  bordure ni flou. Onglet 96 × 54, rayon complet ; onglet actif : fond `rgba(0,0,0,0.2)`. Icônes
  20 × 20 : maison `324:1795`, note `324:1798`.

**Welcome `316:4853`** — fond `background.base` et fond animé `175:66`. Bloc central `362:4932` :
colonne centrée dans la zone y 62–744, écart 24. Marque 122,88 × 122,88, rayon 26,88, fond
`#1A110E`. Bloc texte `316:4855` : écart 16, marge horizontale 24 ; logotype vectoriel « track1 »
`318:6607` 136,03 × 29,6 ; tagline Inter Medium 20, interligne naturel, `text.secondary`, centrée,
contrainte à la largeur du logotype. Barre d'action à y 744, sans fondu, bouton « Démarrer ».

**Pseudo `362:1766` (vide), `362:2894` (rempli)** — titre `362:1781` à y 164, centré, `Mono/Item`,
`text.primary`. Champ à y 344, centré, Inter Regular 34, interligne naturel (41) : placeholder
« Slim Shady » en `text.tertiary` (`362:2893`), texte saisi en `text.primary` (`362:2906`). Barre
d'action à y 744 avec « Continuer » désactivé (`362:1809`), sous le clavier système (y 520, 332 de
haut).

**Disque `362:3008` (vide), `362:3145` (choisi)** — bloc titres à y 164, écart 12 : titre
`Mono/Item` `text.primary`, sous-titre `Mono/Section` `text.secondary`, centrés. Emplacement
`362:3127` : 143,84 × 143,84 à y 264,89, centré, rayon 31,465, fond dégradé vertical teinte à 10 %
→ même teinte à 0 % (arrêt 151,15 %) ; disque 122,14 en retrait de 9,31. Grille `362:3119` à
(43 ; 506), largeur 306, écart 22 : tuiles 85,618, rayon 18,729, même dégradé ; disque 72,7 en
retrait de 5,54, bordure 0,519, ombre `0 1,385 2,423 −0,346 rgba(19,33,42,0.28)`. Teintes des
tuiles : iridescent `246,233,216` · bleu `214,219,248` · menthe `214,248,237` · corail
`248,230,214` · violet `243,214,248` · sarcelle `214,240,248`. Tuile ou emplacement vide : teinte
`214,219,248`, disque uni `#6F6F6F`, ouverture centrale 5,69 (tuile) ou 9,55 (emplacement). Barre
d'action à y 744, « Continuer ». Disques à exporter : `318:7015`, `322:3663`, `322:3679`,
`322:3695`, `322:3711`, `322:3727`.

**Sélection des genres `316:5066`** — en-tête `316:5074` à y 78 : marges côtés 24, bas 16, écart
8 ; titre `Title/1` `text.primary` ; sous-titre `Body/Medium` `text.secondary`. Liste : marges
côtés 16, haut 12, écart 12. Carte : fond `#2A241D`, rayon 20, marges gauche 24, droite 16,
verticales 11. En-tête de carte : titre `Mono/Item` et compteur `Mono/Tag` en `text.primary`,
écart 8 ; chevron 20. Carte repliée (70 de haut) : seconde ligne `Body/Small` `text.secondary` à 8.
Corps déplié : marges verticales 12, écart 4 ; rangée « Tous » avec 8 dessous. Puce : bordure 2
`rgba(246,233,216,0.1)`, rayon complet, marges 12 et 8, texte `Mono/Tag` `text.primary` ; puce
« Tous » avec icône 16 à 8 ; puces en lignes, écart 8 ; puce cochée : bordure 2 `#F6E9D8`. Barre
d'action `362:5074` à y 657 (195 de haut), avec fondu, compteur « Total : 1 genre », « Continuer ».

**Opt-in `317:5142`** — en-tête à y 78, marges côtés 24, bas 16 : titre `Title/1` sur 345 de
large ; sous-titre `Body/Medium` `text.secondary`, 8 sous le titre. Scène `317:5224` 345 × 520 à y
248. Contour `317:5225` à (35 ; 99), 275 × 584,97 : corps `#C8B6A3` rayon 44,51, lunette `#241713`
rayon 40,54, écran `#1A110E` rayon 35,77, îlot `#302019` 82,66 × 23,05. Aperçu `317:5226` à
(9 ; 249), largeur 327 : marge 12, écart 12, rayon 12, fond dégradé `rgba(246,233,216,0.1)` →
transparent (115,85 %) ; icône 36 rayon 7,875 ; titre `Label/Medium` `text.primary` ; corps
`Body/Small` `text.secondary`. Barre d'action à y 657, « Continuer ».

**Accueil `324:1788`** — bloc haut `324:1817` à y 72, écart 16, centré. Tuile de date `324:1818` :
largeur 53, marge 10, rayon 16, bordure 1 `rgba(246,233,216,0.08)`, fond dégradé
`rgba(246,233,216,0.1)` → transparent ; deux lignes `Title/3` centrées. Pilules `324:1820` : écart
8 ; pilule marges 8 et 4, rayon complet, même bordure et même fond ; texte `Body/Small`
`text.primary`. Bloc principal `324:1804` à y 222, écart 12, centré : pochette 308,808 carrée,
ombre `0 0 18,982 7,593 rgba(18,18,18,0.25)` ; badge : carré 11,368 × 12 à 8 du libellé JetBrains
Mono Bold 14/25 ; titre `Title/2` centré ; sous-titre `Body/Medium` `text.secondary`, 6 sous le
titre ; bouton `324:1813` : fond `action.primary`, rayon complet, marges gauche 12, droite 16,
verticales 12, icône 20 à 4 du libellé JetBrains Mono Medium 15/20 `text.inverse`.

**Lecteur `338:2461`** — colonne `338:2492` centrée, largeur 309, y 42, écart 56, Inter Regular,
interligne 34. Phrase au centre `338:2480` : 22 pt, `text.primary`. Autres phrases : 20 pt,
`#8D7A6D` ; celle du haut se fond vers le transparent à 5,637 % de sa hauteur, celle du bas à
89,869 %. En-tête `338:2558` à (24 ; 56), 345 × 40 : retour `338:2559` et partage `338:2561`, 40 ×
40. Barre `338:2493` centrée à y 694, hauteur 50 : fond `rgba(255,255,255,0.15)`, rayon complet,
marges côtés 20, verticales 4, écart 16 ; pochette 30,881 ; titre JetBrains Mono Bold 16/24 et
artiste `Body/Small`, tous deux `text.primary` ; par service, logo 17,6 et flèche sortante 18,7 à
4,4. Barre d'onglets à y 749.

**Splash `318:6513`** — marque `362:4944` 184,32 × 184,32 à (104,34 ; 330), rayon 40,32.

**Onglet Genres `318:6781`** — colonne `318:6796` à y 78, écart 16, centrée. Avatar `318:6911` 89 ×
89 : anneau `#F6E9D8` de 3,296, rayon 19,469 ; tuile intérieure 85,618, rayon 18,729, dégradé
`rgba(246,233,216,0.1)` → transparent ; disque 72,7. Nom `318:7031` : `Title/3` `text.primary`.
Liste `318:6919` : marges côtés 16, verticales 12, écart 12 ; titre de section `Mono/Item`
`text.primary` ; cartes identiques à `316:5066`. Pied `318:7039` : deux lignes `Mono/Micro`
`text.tertiary`, écart 2, logotype « track1 » 40,81 × 8,88 à 4 du texte. Barre `374:1852` : 393 ×
151 à y 581, même fondu que la barre d'action, marges haut 24, côtés 16, bas 0 ; bouton
« Sauvegarder » de 52 à y 680, soit 17 au-dessus du cadre de la barre d'onglets.
