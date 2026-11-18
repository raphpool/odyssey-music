# Track1 — builds natifs et exploitation des rappels

État capturé le **2026-10-05** pour TRA-353. La cible officielle est désormais le client
iOS natif sous `ios/`, dont le projet et les archives sont livrés par les tâches natives
suivantes. Le client Expo/React Native sous `mobile/` est gelé comme référence historique.
Il n'existe pas de build Expo public ou de preuve TestFlight/App Store Connect dans les
éléments vérifiés ci-dessous.

## Cible officielle iOS

- Un seul client officiel : `ios/` (SwiftUI, minimum iOS 17 dans le plan natif).
- Les builds EAS ci-dessous sont des artefacts de développement internes. Ils ne prouvent
  ni le fonctionnement Swift ni une sortie publique.
- Les profils, caches et demandes locales des testeurs Expo ne sont pas migrés vers le
  client natif. Une réinitialisation locale est attendue à l'installation native ; aucun
  transfert de données n'est ajouté par TRA-353.
- L'archivage et la fermeture du chemin Expo sont une étape ultérieure et contrôlée
  (P6.3 / TRA-354). Jusqu'à sa vérification, conserver les sources et les scénarios utiles,
  sans présenter Expo comme une deuxième application officielle.

## Contrôles natifs (TRA-336)

Depuis la racine du dépôt, `ios/scripts/check.sh` vérifie que le Xcode sélectionné correspond
exactement à `ios/.xcode-version`, applique le lint `swift-format` strict configuré pour des
tabulations d'une unité et 110 colonnes, résout les paquets Swift, puis compile et teste
séquentiellement `Track1` et `Track1Preview` sur un simulateur temporaire dédié. Le build et
les tests refusent la signature (`CODE_SIGNING_ALLOWED=NO`). Les résultats et DerivedData restent
hors des sources ; la CI conserve seulement les bundles `xcresult` comme artefacts.

Le projet déclare une dépendance Swift externe : Segment (`analytics-swift` 1.10.0, avec ses
dépendances `jsonsafeencoding-swift` et Sovran), intégrée via SPM. Le verrou généré par SPM est
donc présent et versionné à
`ios/Track1.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved` ; il est utilisé
par la résolution et son absence échoue explicitement.

Le workflow `ios-ci` exécute exactement ce script sur le runner hébergé `macos-26`, avec un HOME
isolé et sans secret de signature. Son job s'appelle `ios-check`. Il ne tourne pas sur une PR en
draft. Les contrôles backend, review, tier et Expo restent exécutés par leurs workflows existants.

### Où tournent les checks (TRA-703, TRA-705, TRA-729)

Depuis le 2026-11-16, le Mac de Raphael n'héberge plus aucun runner de PR. Les workflows qui
tournent sur des runners hébergés GitHub :

| Workflow | Runner | Ticket |
| --- | --- | --- |
| `ci`, `mobile-ci`, `review-gate`, `ai-review`, `claude` | `ubuntu-latest` | TRA-703 |
| `enable-workflows` | `ubuntu-latest` | TRA-784 |
| `ios-ci` | `macos-26` | TRA-705 |
| `ios-testflight` | `macos-26` | TRA-729 |

Les workflows `deploy`, `pull-cache`, `sync-genre-cache` et `top-up-genres` restent auto-hébergés.
Ils sont désactivés. Aucun ne se déclenche sur une PR. Comme `deploy` est désactivé, un merge sur
`main` ne déploie rien.

Les six workflows de PR avaient été désactivés à la main le 2026-11-01. Aucun check ne tournait
donc sur les PR. Le workflow `enable-workflows` les a réactivés le 2026-11-17 (TRA-784).

Xcode est épinglé dans `ios/.xcode-version` à `Xcode 26.4.1 (17E202)` (TRA-787). C'est la seule
version 26.4 disponible sur l'image hébergée. Si l'image change, l'étape `Select Xcode` de `ios-ci`
échoue et liste les versions installées.

Quand des tests échouent, `ios/scripts/check.sh` imprime chaque échec du `.xcresult` en annotation
`::error::<test>: <message>` (TRA-788). Le `.xcresult` reste en artefact. Un agent cloud ne peut pas
le télécharger : le proxy refuse le stockage blob. Il lit donc les annotations du run. GitHub n'affiche que les 10 premières annotations d'erreur
par étape : avec plus de 10 échecs, la liste est tronquée.

### Architectures simulateur (TRA-355)

Pour les builds locaux ordinaires, les configurations de projet `Development` et `Preview`
limitent la compilation au simulateur concret avec
`ONLY_ACTIVE_ARCH[sdk=iphonesimulator*]=YES`. Ce réglage est au niveau projet : l'application,
`Track1Tests` et `Track1UITests` l'héritent sans figer `ARCHS`, sans exclure d'architecture et sans
modifier `Production`, `iphoneos`, les archives ou la signature.

Le contrôle automatisé garde volontairement les deux architectures du simulateur. Pour chaque
action `build` et `test` des schémas `Track1` et `Track1Preview`, `ios/scripts/check.sh` transmet
`ONLY_ACTIVE_ARCH=NO` sur la ligne de commande, pour l'ensemble du graphe Xcode et des paquets
SPM. Reproduire le contrôle complet depuis la racine avec :

```sh
ios/scripts/check.sh
```

Pour qualifier le comportement local avec un simulateur concret, utiliser des DerivedData séparés
et ne pas ajouter d'override d'architecture :

```sh
xcodebuild -project ios/Track1.xcodeproj -scheme Track1 -configuration Development \
  -destination "platform=iOS Simulator,id=<simulateur-id>" -derivedDataPath /tmp/track1-development build
xcodebuild -project ios/Track1.xcodeproj -scheme Track1 -configuration Development \
  -destination "platform=iOS Simulator,id=<simulateur-id>" -derivedDataPath /tmp/track1-development build-for-testing
xcodebuild -project ios/Track1.xcodeproj -scheme Track1Preview -configuration Preview \
  -destination "platform=iOS Simulator,id=<simulateur-id>" -derivedDataPath /tmp/track1-preview build
xcodebuild -project ios/Track1.xcodeproj -scheme Track1Preview -configuration Preview \
  -destination "platform=iOS Simulator,id=<simulateur-id>" -derivedDataPath /tmp/track1-preview build-for-testing
```

Les preuves physiques consignent séparément le SHA du correctif, le commit et les hashes du
candidat SPM, les journaux/xcresult et l'inspection des slices arm64 et x86_64 des produits
simulator (application, Segment/Analytics, Sovran et JSONSafeEncoding). Elles ne présentent pas
l'exécution arm64 d'un simulateur comme une exécution x86_64 et ne réemploient pas une preuve
Development pour Preview.

## Package `Track1Core` (TRA-422)

`ios/Track1Core` est un package SwiftPM local qui porte la logique iOS pure : 19 fichiers
Foundation (API, configuration, événements analytics, persistance, profil, navigation,
recommandation, actions d'écoute, modèle de fiche, recherche, accueil du jour, lecteurs de
contenu). Il se teste sur l'hôte macOS, sans simulateur.

- **Où créer un fichier.** Tout nouveau fichier sans SwiftUI va dans
  `ios/Track1Core/Sources/Track1Core/…`, son test dans `ios/Track1Core/Tests/Track1CoreTests/…`.
  Aucune entrée pbxproj : le package n'a pas de plage d'IDs.
- **Ce qui reste dans l'app, et pourquoi.** Tout ce qui dépend de la plateforme ou d'une
  bibliothèque d'interface : `Bundle.main` (version et build lus dans l'Info.plist de l'app), les
  blocs `#if targetEnvironment(simulator)` (fixtures UI-test), Segment (dépendance de l'app
  seulement) et SwiftUI/UIKit. Le package n'importe aucun de ces modules, et ses tests n'utilisent
  ni `#if os(iOS)` ni `targetEnvironment(simulator)`.
- **Parité iOS.** `LocalStore` demande la protection de fichiers sous `#if os(iOS)` (inexistante
  sur macOS). `LocalStorePlatformTests`, dans `Track1Tests`, vérifie côté app que cette protection
  est bien demandée.
- **Visibilité.** L'app consomme l'API publique du package : jamais de
  `@testable import Track1Core` depuis l'app ou ses tests (une garde vitest,
  `test/ios-core-package.test.ts`, l'impose).

### Boucle locale

```sh
swift test --package-path ios/Track1Core
```

Cette commande est la seule exécution Swift autorisée en local. `xcodebuild`, le simulateur et
`ios/scripts/check.sh` complet restent interdits en local. Ils tournent dans `ios-check`, sur le
runner hébergé `macos-26`. Pour savoir si l'app compile, pousser la PR et lire ce check.

### Place dans `check.sh`

`ios/scripts/check.sh` enchaîne `lint`, `package-tests`, `resolve`, `simulator-boot`, puis
`build-<schéma>` et `tests-<schéma>` pour `Track1` et `Track1Preview`. Les tests du package
passent **avant** le simulateur : un test de logique cassé fait échouer la CI en une vingtaine de
secondes au lieu de plusieurs minutes. Chaque étape affiche `[check] <étape>: <n>s`. Le simulateur
`track1-ci-pool` est créé une fois par machine et réutilisé d'un run à l'autre (TRA-421) ; le cache
DerivedData vit dans le tool cache du runner (TRA-420).

### Typecheck de l'app sans `xcodebuild`

Pour vérifier qu'un changement de l'app compile sans lancer `xcodebuild` :

1. Construire le package pour le simulateur :
   `swift build --package-path ios/Track1Core --sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" --triple arm64-apple-ios17.0-simulator`.
   Les modules sont produits sous `ios/Track1Core/.build/arm64-apple-ios-simulator/debug/Modules`.
2. Copier `ios/Track1` et `ios/Track1Tests` dans un dossier temporaire, hors du dépôt, en retirant
   les lignes `@testable import Track1` (app et tests forment alors un seul module).
3. Lancer `swiftc -typecheck` sur ces copies avec `-swift-version 6 -D SEGMENT_CDN_STANDARD`,
   `-I` vers le dossier `Modules` du package et vers celui de `Segment.swiftmodule`, et
   `-F`/`-I` vers le dossier `Developer` de la plateforme iphonesimulator pour XCTest.

Limite : comme app et tests sont typecheckés comme un seul module, les erreurs d'isolation
Swift 6 entre cibles (« sending value of non-Sendable type ») n'apparaissent que dans `ios-check`.

## Circuit de review

La source de vérité est `scripts/ci/review-gate-policy.ts`. Elle définit `sensitivePath` et
`gateIntegrityPath`. Ce document ne recopie pas leurs motifs : les lire dans le fichier.

`sensitivePath` classe une PR en tier 3, comme le label `tier/3`. `gateIntegrityPath` désigne les
fichiers de la machinerie du gate elle-même (TRA-704). Une PR qui en modifie un ne peut pas être validée par le `deep-review`
d'Actions. Elle a toujours besoin d'un `codex-deep-review`.

| Tier de la PR | Review exigée | Qui merge |
| --- | --- | --- |
| 1 et 2 | `review` Claude | Process de livraison habituel (`/delivery-process`) |
| 3, hors `gateIntegrityPath` | `review` et `deep-review` dans Actions | L'agent, après `/code-review ultra` |
| 3, touchant `gateIntegrityPath` | `codex-deep-review` d'un compte de `.github/review-gate-authors.txt` | Raphael |

Le 2026-11-16, Raphael a délégué à l'agent le merge des PR tier 3 hors `gateIntegrityPath`.
Cette délégation vaut pour ce projet, jusqu'à la build TestFlight v1.

Le 2026-11-17, Raphael a demandé que l'agent merge toutes les PR sans attendre son autorisation.
Cela a conduit à des merges administrateur. Ils ont d'abord eu lieu sans CI, tant que les
workflows étaient désactivés. Ils ont ensuite eu lieu sur `ios-check` vert.

Cette décision est consignée ici comme historique. Le tableau ci-dessus reste la règle du circuit.

## Envoi TestFlight (TRA-709)

Les prérequis Apple et GitHub, le lancement du workflow `ios-testflight`, l'ouverture du groupe
externe et la lecture des échecs sont décrits dans [`docs/track1-testflight.md`](track1-testflight.md).

## Artefacts Expo historiques de TRA-290

Source de configuration et de preuves : branche
`rdoulonne/tra-290-distribuer-des-builds-natifs-de-developpement-sur-les-deux`, commit
`ca57d01cc6035d1a035ee49fed393f6ee1a8ab56`. Le projet EAS est `@track1app/track1`
(`4635ac06-d13d-43ac-98fa-593fa4cd4252`), propriété de l'organisation `track1app`.
Les identifiants publics vérifiés sont `com.dropcliffs.track1` en production,
`com.dropcliffs.track1.development` en développement et
`com.dropcliffs.track1.preview` en prévisualisation. Expo SDK 57, iOS 16.4 minimum et
Android API 24 minimum étaient configurés ; SecureStore et Notifications étaient les seuls
plugins natifs déclarés, sans permission audio.

| SHA du code | Profil | Plateforme | Version / build | Artefact vérifié | Résultat observé |
| --- | --- | --- | --- | --- | --- |
| `5c452d8e7ec5bfe2cf5a79d2d41ca8acf30fe406` | development | iOS | `1.0.0 (1)` | [Build EAS](https://expo.dev/accounts/track1app/projects/track1/builds/2787eeb9-719a-4400-abf5-96b6961015b9) · [IPA](https://expo.dev/artifacts/eas/az2QmmUHb49ev2AIxrrZRxoZPSwg0u2D_oKIbZeKVKs.ipa) | Build `2787eeb9-719a-4400-abf5-96b6961015b9` terminé le 2026-09-28 ; installation iPhone et ouverture des trois onglets validées via Metro tunnel avec les variables publiques requises. |
| `88acd880e0d8ffcf9bd8b924b4f4c91c6ae6271f` | development | Android | `1.0.0 (1)` | [Build EAS](https://expo.dev/accounts/track1app/projects/track1/builds/2ee0cbc2-31ff-4097-a0c9-319658fcce29) · [APK](https://expo.dev/artifacts/eas/0-Bq5K9ciOV1p0cvATVU2D8MSRLTSteraRA00KTi7o4.apk) | Build `2ee0cbc2-31ff-4097-a0c9-319658fcce29` terminé le 2026-09-27 ; installation et vérification des trois onglets sur appareil Android non exécutées. |

Les assets réutilisables de cette branche sont `mobile/assets/icon.png` et
`mobile/assets/notification-icon.png`, introduits par `88acd88`. Aucun certificat, clé
privée, credential ou fichier de signature n'est versionné. La fiche App Store Connect,
un bundle TestFlight distribué ou une URL de sortie publique n'ont pas été trouvés dans la
preuve accessible : ces éléments restent à établir dans les tickets natifs de publication,
sans transformer leur absence en réussite.

## Rappels et transport historique

Les rappels Expo restent désactivés par défaut et ne constituent pas le transport du client
officiel. Le serveur ne démarre le scheduler historique que si `MOBILE_PUSH_ENABLED=true` et
`EXPO_ACCESS_TOKEN` sont tous deux présents dans `/etc/odyssey-music.env`. Ces valeurs sont
des secrets serveur : elles ne vont jamais dans le projet Expo, dans une réponse HTTP ou dans
les journaux. TRA-353 ne les active ni ne les désactive.

Le registre `MOBILE_STATE_DIR` est `/var/lib/track1-mobile` en production. Il est créé avec
des droits `0700` et exclu du rsync de déploiement : le remplacer viderait les réservations
et ferait perdre la preuve qu'une date locale a déjà été traitée. Le service reste
mono-process ; ne pas lancer une seconde unité serveur ni un cron parallèle.

Le scheduler s'exécute chaque minute et réserve avant tout appel Expo. Il n'envoie qu'entre
09:00 inclus et 10:00 exclu dans le fuseau de chaque téléphone ; il ne rattrape jamais une
date après 10:00. Au redémarrage, une réservation durable n'est pas rejouée. Les tickets et
receipts sont purgés après 24 heures ; l'historique borné de 40 dates reste avec l'abonnement
pour prévenir un doublon lors d'un changement de fuseau. Le transport APNs natif et sa
recette sont définis séparément dans P3.

Pour arrêter les nouveaux rappels historiques sans toucher aux lectures musicales ni aux
abonnements, retirer `MOBILE_PUSH_ENABLED=true` (ou mettre `false`) dans
`/etc/odyssey-music.env`, puis redémarrer `odyssey-server.service`. Conserver
`MOBILE_STATE_DIR` : le supprimer est une perte de l'historique de déduplication et exige une
décision opérationnelle explicite.

## Transport APNs natif (TRA-345)

Le rappel du client iOS officiel utilise APNs directement, sans reçu Expo simulé. Il reste
désactivé tant que `MOBILE_APNS_PUSH_ENABLED=true` n'est pas défini dans
`/etc/odyssey-music.env`. Son activation requiert uniquement sur le serveur `APNS_KEY_ID`,
`APNS_TEAM_ID`, `APNS_PRIVATE_KEY_PATH`, `APNS_TOPIC_PREVIEW` et
`APNS_TOPIC_PRODUCTION`. La clé privée est un fichier absolu lisible par le service ; elle, les
jetons des appareils et les valeurs de ces variables ne vont ni dans Git, ni dans l'unité
systemd, ni dans les journaux.

Le déploiement refuse une activation APNs partielle et vérifie que la clé est lisible avant le
redémarrage. Le health check HTTP confirme seulement que le serveur est joignable ; une
acceptation APNs ne prouve pas la réception sur un iPhone. Cette recette physique est réservée à
P3.3. Pour suspendre APNs, remettre `MOBILE_APNS_PUSH_ENABLED=false` puis redémarrer le service :
conserver `MOBILE_STATE_DIR`, car son registre conserve les réservations et sa purge à 90 jours
reste exécutée. Ne pas réactiver Expo comme second transport du client officiel lors d'un rollback.

Ce rollback de configuration est compatible avec le même binaire. Un retour binaire vers une
version antérieure à TRA-345 après écriture du registre APNs enrichi n'est pas une procédure
supportée : cette version ne connaît pas les réservations ni leur version de jeton. Si un tel
retour devient nécessaire, sauvegarder puis restaurer le registre de façon cohérente avec le
binaire choisi ; ne jamais l'effacer pour contourner une erreur, ni renvoyer aveuglément les dates
réservées.
