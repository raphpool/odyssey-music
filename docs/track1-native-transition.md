# Transition Expo vers le client iOS natif

État de la capture : **2026-10-05**. Ce rapport est le livrable de TRA-353 (P1.1,
`tier/1`). Il désigne un seul client officiel, conserve les preuves historiques et relie
les résultats Expo aux tâches Swift sans présenter une preuve React Native comme une preuve
native.

## Décision et périmètre

- Client officiel : `ios/`, application SwiftUI du plan natif.
- Client Expo/React Native : gelé comme référence historique. Aucun nouveau parcours n'y
  est développé et aucun build Expo interne n'est public.
- Les profils, caches, demandes de génération et autres données locales des builds Expo ne
  sont pas migrés. Une installation native repart avec son état local propre ; l'archivage
  Git et la fermeture du chemin Expo appartiennent à P6.3 / TRA-354.
- Le backend, le site, les routes existantes, Android et les services de rappel n'ont pas
  été modifiés par cette transition.
- Base distante contrôlée : `origin/main` à
  `85a5b8e07fa103c8a884cac50de56868c3ea805b`. TRA-312 est livré par la PR [#303](https://github.com/raphpool/odyssey-music/pull/303)
  sur ce SHA ; les caches RN sont une référence de comportement pour P4.4, pas une preuve
  de fonctionnement Swift.

## Provenance des six artefacts

Les sources ont été lues sans écriture dans le checkout documentaire
`/Users/raphaeldoulonne/Documents/odyssey-music`. Les trois artefacts natifs ont été capturés
après confirmation du mapping définitif par le ticket-writer. Les trois historiques ont reçu
uniquement le bandeau exact prévu par le ticket, puis une ligne vide ; leur corps reste
identique octet pour octet.

| Fichier | Source absolue | SHA-256 de la source | Contrôle dans cette PR |
| --- | --- | --- | --- |
| `docs/plans/track1-mobile.md` | `/Users/raphaeldoulonne/Documents/odyssey-music/docs/plans/track1-mobile.md` | `048193c10a5ba8191f8afc2b8756cd18d61c345f19e5c892a5a6e1ce8299d79d` | Corps après le bandeau identique |
| `docs/plans/track1-mobile-linear.md` | `/Users/raphaeldoulonne/Documents/odyssey-music/docs/plans/track1-mobile-linear.md` | `8413a12900aa967fe41a75008948cc525769a0db1240c8efcb9eb65c8919738c` | Corps après le bandeau identique |
| `docs/plans/track1-mobile-linear-map.md` | `/Users/raphaeldoulonne/Documents/odyssey-music/docs/plans/track1-mobile-linear-map.md` | `f5d4d200fc9f34c1ad63a9f85383e75e5010fd9666bbd65f85f901e240d23190` | Corps après le bandeau identique |
| `docs/plans/track1-native-ios.md` | `/Users/raphaeldoulonne/Documents/odyssey-music/docs/plans/track1-native-ios.md` | `cef2610e4395236dcd00d9f294256998954ab14d87513e161b5a2771e937fb29` | Copie native identique |
| `docs/plans/track1-native-ios-linear.md` | `/Users/raphaeldoulonne/Documents/odyssey-music/docs/plans/track1-native-ios-linear.md` | `c4574b5f5d3ef7de2798c8eb03a574d3be1d323868be2961e3f19bb6635f1e65` | Copie native identique |
| `docs/plans/track1-native-ios-linear-map.md` | `/Users/raphaeldoulonne/Documents/odyssey-music/docs/plans/track1-native-ios-linear-map.md` | `eae17421745b0c1d14b0fe299e565d07efbdc6ed282e64ba31d93ae6b1689461` | Copie native identique |

Bandeau ajouté aux trois copies historiques (représentation littérale non cliquable) :

    > Historique — remplacé pour l'exécution par [le plan iOS natif](track1-native-ios.md), validé le 2026-10-05. Corps historique conservé à l'identique.

Le mapping natif définitif est également versionné dans
[`track1-native-ios-linear-map.md`](plans/track1-native-ios-linear-map.md) ; il porte les
28 résultats canoniques et les UUID réellement relus dans Linear.

## Correspondance native canonique

Le mapping contient six milestones natifs, 20 créations et 8 réemplois. Les huit milestones
historiques restent conservés. Voici le contrôle compact des 28 résultats ; les UUID, URLs,
tiers et dépendances détaillés sont dans le mapping versionné.

| Réf. | Issue native | UUID | Action | Tier | Milestone |
| --- | --- | --- | --- | --- | --- |
| P1.1 | [TRA-353](https://linear.app/workspaceperso/issue/TRA-353/figer-le-passage-dexpo-au-client-ios-natif) | `8c944c68-1a4e-445c-816c-22f3a1d9f3ca` | Création | 1 | 1 |
| P1.2 | [TRA-327](https://linear.app/workspaceperso/issue/TRA-327/figer-le-handoff-des-seize-ecrans-et-de-leurs-mouvements) | `cc06b014-7d22-41cf-aade-fe7f0c8d3a51` | Réemploi | 1 | 1 |
| P1.3 | [TRA-335](https://linear.app/workspaceperso/issue/TRA-335/ouvrir-les-trois-entrees-dans-une-application-swiftui) | `c3368834-498f-4299-b494-15491c7c710c` | Création | 3 | 1 |
| P1.4 | [TRA-336](https://linear.app/workspaceperso/issue/TRA-336/verifier-le-client-swift-a-chaque-changement) | `03c65129-78b7-4cc8-a0ca-963865af2738` | Création | 3 | 1 |
| P1.5 | [TRA-337](https://linear.app/workspaceperso/issue/TRA-337/installer-et-archiver-un-build-ios-signe) | `9f47a100-bcfa-4843-b090-559bc621fd04` | Création | 3 | 1 |
| P2.1 | [TRA-338](https://linear.app/workspaceperso/issue/TRA-338/lire-les-contrats-musicaux-existants-depuis-swift) | `357562f4-46d6-49a5-b914-ec3c91b2ca32` | Création | 2 | 2 |
| P2.2 | [TRA-339](https://linear.app/workspaceperso/issue/TRA-339/respecter-le-choix-de-mesure-avec-segment-natif) | `56ca232a-e4b0-4f3e-a0c8-0f8b80921be7` | Création | 3 | 2 |
| P2.3 | [TRA-340](https://linear.app/workspaceperso/issue/TRA-340/choisir-et-gerer-ses-gouts-uniquement-sur-liphone) | `a15d9904-83c0-401c-9519-afd822a91f74` | Création | 3 | 2 |
| P2.4 | [TRA-341](https://linear.app/workspaceperso/issue/TRA-341/lire-une-fiche-et-parcourir-ses-relations) | `02f728d7-5c44-462a-a378-06769b2d77c7` | Création | 2 | 2 |
| P2.5 | [TRA-342](https://linear.app/workspaceperso/issue/TRA-342/ouvrir-spotify-ou-apple-music-depuis-une-fiche) | `346fa7ba-4c5c-4113-9013-134be64a5bf0` | Création | 2 | 2 |
| P2.6 | [TRA-343](https://linear.app/workspaceperso/issue/TRA-343/retrouver-une-decouverte-stable-chaque-jour) | `e2a063c1-c63e-4009-8380-f144481a721a` | Création | 2 | 2 |
| P3.1 | [TRA-344](https://linear.app/workspaceperso/issue/TRA-344/enregistrer-separement-les-abonnements-apns-anonymes) | `29acceda-3610-4a35-bb05-e19d85710d0c` | Création | 3 | 3 |
| P3.2 | [TRA-345](https://linear.app/workspaceperso/issue/TRA-345/acheminer-le-rappel-quotidien-directement-par-apple) | `9f5668c0-2f22-40c5-9b07-1966d5b85667` | Création | 3 | 3 |
| P3.3 | [TRA-346](https://linear.app/workspaceperso/issue/TRA-346/choisir-les-rappels-et-ouvrir-la-decouverte-depuis-ios) | `80214dce-f4d2-4948-b8cd-4f6210100596` | Création | 3 | 3 |
| P4.1 | [TRA-347](https://linear.app/workspaceperso/issue/TRA-347/presenter-les-particularites-des-cinq-types-de-fiches) | `a60e6f62-480b-4e14-b2c4-880405d7cc7b` | Création | 2 | 4 |
| P4.2 | [TRA-348](https://linear.app/workspaceperso/issue/TRA-348/rechercher-les-cinq-types-de-contenus) | `c7956aec-46cd-46b6-8b46-31aa3fb32441` | Création | 2 | 4 |
| P4.3 | [TRA-349](https://linear.app/workspaceperso/issue/TRA-349/creer-une-fiche-sur-demande-et-reprendre-son-suivi) | `d7d1a574-3653-44c2-bf38-d7fc113e980a` | Création | 2 | 4 |
| P4.4 | [TRA-350](https://linear.app/workspaceperso/issue/TRA-350/relire-les-contenus-hors-ligne-et-effacer-leurs-traces-locales) | `bad544a1-59d6-434e-9e52-340b147a19ad` | Création | 3 | 4 |
| P4.5 | [TRA-351](https://linear.app/workspaceperso/issue/TRA-351/retrouver-la-bonne-fiche-depuis-un-lien-track1) | `698c7511-61e9-487d-9317-c1a083b3acdb` | Création | 2 | 4 |
| P5.1 | [TRA-352](https://linear.app/workspaceperso/issue/TRA-352/affiner-les-animations-et-leurs-variantes-accessibles) | `286f9f6d-e238-4171-91ff-c81f6ffc9ee5` | Création | 2 | 5 |
| P5.2 | [TRA-317](https://linear.app/workspaceperso/issue/TRA-317/rendre-la-confidentialite-comprehensible-et-accessible) | `9f970dd6-1304-4daa-9ba0-e6484cd71307` | Réemploi | 3 | 5 |
| P5.3 | [TRA-315](https://linear.app/workspaceperso/issue/TRA-315/verifier-segment-vers-amplitude-et-les-indicateurs-ios) | `7d0f9daa-45b2-4401-8eea-43a366c0898e` | Réemploi | 3 | 5 |
| P5.4 | [TRA-331](https://linear.app/workspaceperso/issue/TRA-331/valider-les-seize-ecrans-et-les-parcours-natifs-integres-sur-iphone) | `a2cc737e-5917-4abf-b927-1d5fed8559db` | Réemploi | 1 | 5 |
| P6.1 | [TRA-318](https://linear.app/workspaceperso/issue/TRA-318/presenter-fidelement-track1-dans-lapp-store) | `7b0a2ef1-d20c-4e41-bedc-4877d3d69d3b` | Réemploi | 1 | 6 |
| P6.2 | [TRA-319](https://linear.app/workspaceperso/issue/TRA-319/distribuer-le-candidat-natif-aux-testeurs-testflight) | `9d58ff65-6515-4ae0-8d0b-bdc9a7480016` | Réemploi | 3 | 6 |
| P6.3 | [TRA-354](https://linear.app/workspaceperso/issue/TRA-354/archiver-le-client-expo-et-fermer-son-chemin-de-distribution) | `4c2cb87e-cb81-4351-8024-e3979e5816da` | Création | 3 | 6 |
| P6.4 | [TRA-320](https://linear.app/workspaceperso/issue/TRA-320/qualifier-le-candidat-testflight-pour-sa-sortie-publique) | `6e35a672-3e77-49e2-affc-bcf2e04ec23d` | Réemploi | 1 | 6 |
| P6.5 | [TRA-321](https://linear.app/workspaceperso/issue/TRA-321/publier-track1-natif-et-verifier-sa-disponibilite) | `12760ae5-2445-42d6-a473-34663b4cf22b` | Réemploi | 3 | 6 |

Contrôle Linear final : P1.1/TRA-353 et P1.2/TRA-327 étaient `In Progress` au contrôle du
2026-10-05 ; les 26 autres résultats canoniques étaient `Backlog`. Les six annulations,
les trois consolidations et les quatre reports Android sont détaillés dans le mapping natif.

## Inventaire historique TRA-285 à TRA-334

Les états ci-dessous sont ceux relus dans Linear le 2026-10-05. Un état `Done` conserve son
livrable et sa PR ; la cible native porte uniquement le comportement à réaliser dans Swift.
Un état `Backlog` reste à traiter par son successeur ou demeure un suivi utile ; un état
`Canceled` concerne uniquement un chemin Expo devenu caduc et ne déclare aucun résultat Swift.
`—` signifie qu'aucune PR GitHub correspondante n'a été trouvée lors de la lecture, pas que
le travail est livré.

| Issue | État observé | PR / SHA de preuve | Livrable conservé | Cible native / traitement |
| --- | --- | --- | --- | --- |
| TRA-285 | Done | [#278](https://github.com/raphpool/odyssey-music/pull/278) / `7a65d43c81551b64ec9e5c8e44255f3f64c8ac68` | Règles CI et merge | Règle globale conservée ; P1.4/TRA-336 consomme la gate Swift sans refaire TRA-285. |
| TRA-286 | Done | [#277](https://github.com/raphpool/odyssey-music/pull/277) / `7770b96d51742bb753c3f0a58be46459c26fe03a` | Taxonomie des événements et indicateurs | Contrat repris par P2.2/TRA-339 et P5.3/TRA-315. |
| TRA-287 | Done | [#279](https://github.com/raphpool/odyssey-music/pull/279) / `93c879eead137b917cdd31cb138ffc93258e31db` | Socle Expo reproductible | Référence historique ; P1.3/TRA-335 construit le socle Swift. |
| TRA-288 | Done | [#281](https://github.com/raphpool/odyssey-music/pull/281) / `417ec359899a037d154f131bb0ce5fc6f2238723` | Navigation mobile | Parcours repris par P1.3/TRA-335. |
| TRA-289 | Done | [#286](https://github.com/raphpool/odyssey-music/pull/286) / `7b3e129bfaab66e19f83d57c0446d363256d6914` | CI mobile | P1.4/TRA-336 ajoute la vérification Swift ; workflow Expo conservé jusqu'à TRA-354. |
| TRA-290 | Canceled | Branche et commit Expo conservés : `ca57d01cc6035d1a035ee49fed393f6ee1a8ab56` | Configurations EAS, IPA/APK et assets | Remplacé par P1.5/TRA-337 ; aucune PR fermée ni asset supprimé, preuves dans `docs/track1-builds.md`. |
| TRA-291 | Done | [#280](https://github.com/raphpool/odyssey-music/pull/280) / `ff1b54db73882daa74a25efc6d240c89ec39e7eb` | Catalogue et contrat mobile | Backend conservé ; lecture Swift dans P2.1/TRA-338. |
| TRA-292 | Done | [#284](https://github.com/raphpool/odyssey-music/pull/284) / `cdf36ccded74543e22830f13fdc5933bc3b23d15` | Fiches, images et liens | Contrats repris par P2.1/TRA-338 et P2.4/TRA-341. |
| TRA-293 | Done | [#285](https://github.com/raphpool/odyssey-music/pull/285) / `97796fcbb5cf94bfdc7143d096039e9b5643fa2f` | Recherche mobile | Backend conservé ; recherche native P4.2/TRA-348. |
| TRA-294 | Done | [#282](https://github.com/raphpool/odyssey-music/pull/282) / `ae66f8925ea58be82de1e14dc237edf2fdecaaeb` | Persistance des demandes | Invariants repris par P4.3/TRA-349, sans recréer le service. |
| TRA-295 | Done | [#289](https://github.com/raphpool/odyssey-music/pull/289) / `b6cd3cd3d3f9d8f83ad006e211f459870bf8013c` | Génération mobile publique | Backend conservé ; geste et suivi Swift dans P4.3/TRA-349. |
| TRA-296 | Done | [#283](https://github.com/raphpool/odyssey-music/pull/283) / `719e8e67fb77ee9714cec3d9dd33e44b2194e580` | Client réseau mobile | Contrat consommé par P2.1/TRA-338. |
| TRA-297 | Done | [#294](https://github.com/raphpool/odyssey-music/pull/294) / `0a6f58e32ecb331ebfeb4da9c9e9566a7039d74f` | Déploiement mobile sans régression web | Backend/site conservés ; aucune réécriture native de déploiement. |
| TRA-298 | Done | [#298](https://github.com/raphpool/odyssey-music/pull/298) / `cd957953d7456ba3488096ae672e818be0f263c6` | Goûts locaux | Repris par P2.3/TRA-340, sans migration des données Expo. |
| TRA-299 | Done | [#295](https://github.com/raphpool/odyssey-music/pull/295) / `16b7621477fda1ac73978d773d667e7083327ef3` | Fiche et relations | Repris par P2.4/TRA-341. |
| TRA-300 | Done | [#302](https://github.com/raphpool/odyssey-music/pull/302) / `2b5981d824bd385d2b6b14ea8fd9e3628675bf93` | Découverte du jour | Repris par P2.6/TRA-343. |
| TRA-301 | Done | [#297](https://github.com/raphpool/odyssey-music/pull/297) / `78671ce98de8a6fdb65ae188d676ccd9327d6b93` | Ouverture Spotify/Apple Music | Repris par P2.5/TRA-342 ; une ouverture externe n'est pas une lecture intégrée. |
| TRA-302 | Done | [#288](https://github.com/raphpool/odyssey-music/pull/288) / `9f6eb02fa09991deae6f0efe651b95b884ed880b` | Abonnements push anonymes | Registre serveur conservé ; APNs natif P3.1/TRA-344. |
| TRA-303 | Done | [#291](https://github.com/raphpool/odyssey-music/pull/291) / `1c373a2590564269d36081feaafabf92993eb1eb` | Transport et receipts Expo | Preuves historiques conservées ; transport Apple P3.2/TRA-345. |
| TRA-304 | Done | [#293](https://github.com/raphpool/odyssey-music/pull/293) / `7b6f470637c9d28c0969f781b906406abad54f88` | Scheduler à 9 h locale | Invariants serveur conservés ; envoi APNs P3.2/TRA-345. |
| TRA-305 | Canceled | — | Description et contrat Expo conservés | Remplacé par P3.3/TRA-346 ; aucune réception native déduite. |
| TRA-306 | Backlog | — | Suivi de recette quotidienne | Reste ouvert et bloqué par P5.4/TRA-331 ; pas un ticket d'exécution supplémentaire. |
| TRA-307 | Done | [#300](https://github.com/raphpool/odyssey-music/pull/300) / `9c98685db0e5a61cdb6dcf6279ea71b649595c96` | Détails artistes/œuvres | Portage des cinq types P4.1/TRA-347. |
| TRA-308 | Done | [#301](https://github.com/raphpool/odyssey-music/pull/301) / `c3b35b0e732b8807733e85b6cb437e3d20db6186` | Détails genres/labels | Portage P4.1/TRA-347. |
| TRA-309 | Done | [#296](https://github.com/raphpool/odyssey-music/pull/296) / `4bdf661fb2d9c58c9650800411de421e25a3cc8b` | Recherche tous types | Portage P4.2/TRA-348. |
| TRA-310 | Done | [#299](https://github.com/raphpool/odyssey-music/pull/299) / `225f4ab0f0f3897f8d90c7255a86b9afb6d282e5` | Création et suivi d'une fiche | Portage P4.3/TRA-349. |
| TRA-311 | Canceled | — | Contrat de lien profond Expo conservé | Remplacé par P4.5/TRA-351. |
| TRA-312 | Done | [#303](https://github.com/raphpool/odyssey-music/pull/303) / `85a5b8e07fa103c8a884cac50de56868c3ea805b` | Cache et reprise hors ligne RN | Scénarios repris par P4.4/TRA-350 ; aucune preuve Swift avant sa recette. |
| TRA-313 | Backlog | — | Suivi exploration/accessibilité | Reste ouvert et bloqué par P5.4/TRA-331. |
| TRA-314 | Done | [#287](https://github.com/raphpool/odyssey-music/pull/287) / `7bff0f5d3e9b69d6c9822da0387b6734cb482d1d` | Consentement et lifecycle analytics | Contrat repris par P2.2/TRA-339 puis P5.3/TRA-315. |
| TRA-315 | Backlog | — | Suivi Segment → Amplitude | Réemployé comme P5.3 ; aucun résultat natif annoncé. |
| TRA-316 | Backlog | — | Suivi des indicateurs iOS | Reste ouvert et bloqué par P5.3/TRA-315. |
| TRA-317 | Backlog | — | Objet confidentialité et contrat public | Réemployé comme P5.2 ; description, historique et tier conservés. |
| TRA-318 | Backlog | — | Présentation App Store | Réemployé comme P6.1 ; preuves à refaire sur le build natif. |
| TRA-319 | Backlog | — | Distribution bêta | Réemployé comme P6.2 ; aucun ancien build Expo ajouté à TestFlight. |
| TRA-320 | Backlog | — | Qualification de sortie | Réemployé comme P6.4 ; candidat natif obligatoire. |
| TRA-321 | Backlog | — | Publication App Store | Réemployé comme P6.5 ; aucune publication déduite du plan. |
| TRA-322 | Backlog | — | Publication Google Play | Android différé ; instructions Expo historiques, nouveau brief Java requis. |
| TRA-323 | Done | [#290](https://github.com/raphpool/odyssey-music/pull/290) / `edd9632a1406f2c5bf3e1e02064c949b0e484be0` | Runtime de consentement | Invariants repris par P2.2/TRA-339. |
| TRA-324 | Done | [#292](https://github.com/raphpool/odyssey-music/pull/292) / `435ba18286f855c00b2332a142e76047b6a48992` | UI et contrats de consentement | Parcours natif P2.2/TRA-339 ; aucune nouvelle collecte. |
| TRA-325 | Done | [#304](https://github.com/raphpool/odyssey-music/pull/304) / `14b88b28da00a55126936d5a1a0229887cc3f3bf` | Transitions de livraison Expo | Preuves conservées ; remplacement APNs P3.1–P3.3. |
| TRA-326 | Done | [#305](https://github.com/raphpool/odyssey-music/pull/305) / `df55e9422a9250958c82b96ce88df85878a61e9d` | Effacement du cache local | Scénarios repris par P4.4/TRA-350. |
| TRA-327 | In Progress | — | Handoff Figma en cours, sans PR livrée | Réemployé comme P1.2 ; les preuves Expo ne valident pas Swift. |
| TRA-328 | Canceled | — | Contrat d'intégration Expo conservé | Remplacé par P1.3/TRA-335, P2.3/TRA-340 et P2.6/TRA-343. |
| TRA-329 | Canceled | — | Contrat d'intégration Expo conservé | Remplacé par P2.4/TRA-341, P4.1/TRA-347, P4.2/TRA-348 et P4.4/TRA-350. |
| TRA-330 | Canceled | — | Contrat d'animations Expo conservé | Remplacé par P5.1/TRA-352. |
| TRA-331 | Backlog | — | Recette des seize écrans | Réemployé comme P5.4 ; validation à faire sur iPhone natif. |
| TRA-332 | Backlog | — | Recette Android physique | Android différé, aucune dépendance iOS. |
| TRA-333 | Backlog | — | Bêta Google Play | Android différé, aucun travail Java lancé. |
| TRA-334 | Backlog | — | Décision de publication Android | Android différé jusqu'à une décision fondée sur la traction iOS. |

Les familles TRA-325 et TRA-326 sont donc incluses avec leurs PR réelles ; aucun Done
backend n'est rouvert ou présenté comme à refaire. Les quatre tickets Android restent
explicitement non exécutés.

## Builds, Apple et actifs récupérables

La branche TRA-290 porte le projet EAS `@track1app/track1`, les profils development/preview/
production, les identifiants publics et les assets `mobile/assets/icon.png` et
`mobile/assets/notification-icon.png`. Le build iOS development
`2787eeb9-719a-4400-abf5-96b6961015b9` (IPA lié) a été installé sur iPhone le 2026-09-28 ;
le build Android `2ee0cbc2-31ff-4097-a0c9-319658fcce29` est une preuve de compilation et
son installation physique reste non exécutée. Aucun bundle TestFlight, fiche App Store
Connect ou sortie Expo publique n'a été trouvé ; l'absence est explicitée dans
[`docs/track1-builds.md`](track1-builds.md), sans l'inventer.

Les clés, certificats, profils de signature, tokens EAS et credentials push ne sont pas
dans Git. Le client natif devra utiliser ses propres archives Apple ; les données locales
des builds Expo ne sont pas transférées.

## Contrôles et taille

- Présence attendue : README, `docs/track1-builds.md`, ce rapport et les six plans/mappings,
  soit neuf fichiers écrits dans une seule PR documentaire cohérente.
- Les six artefacts représentent 4 144 lignes de sources historiques/natives, plus le
  bandeau historique ; ils dépassent donc le repère de 1 000 lignes. Ce volume est requis
  pour conserver les plans, mappings, UUID, statuts et preuves sous la même transition
  réversible ; il n'y a aucun fichier généré ni lockfile à exclure.
- Les copies natives sont contrôlées par SHA-256 contre leurs sources ; les corps des copies
  historiques sont contrôlés après retrait du seul bandeau. Les liens relatifs de ce rapport
  et les URLs Linear/GitHub/EAS sont lisibles depuis le worktree.
- Aucun code Swift, code serveur, cache, Android, service ou checkout documentaire partagé
  n'est modifié par cette PR.
