# Mapping Linear — Track1 iOS natif

Source : `docs/plans/track1-native-ios-linear.md`.
Validation et transcription : 2026-10-05.

## Projet

- Identifiant conservé : P-TRA-4.
- UUID : `1af27c25-2427-4d6c-a93c-a4f431732eca`.
- URL : https://linear.app/workspaceperso/project/track1-mobile-6052a246546f
- Description remplacée par le bloc exact du manifeste ; nom et historique conservés.

## Milestones natifs

Six milestones créés ; les huit milestones historiques sont conservés (14 au total). L’API Linear ne renvoie pas d’URL individuelle de milestone : le lien de consultation ci-dessous ouvre leur projet, et l’UUID identifie chaque milestone sans ambiguïté.

| Partie | Titre exact | ID / UUID | URL de consultation |
| --- | --- | --- | --- |
| 1 | Installer le nouveau track1 sur iPhone | `c7c728fe-2113-45dc-b1fb-6a4705e1025a` | [Projet](https://linear.app/workspaceperso/project/track1-mobile-6052a246546f) |
| 2 | Découvrir et écouter sa recommandation du jour | `01244bad-71bb-4803-a5fa-be78fba00460` | [Projet](https://linear.app/workspaceperso/project/track1-mobile-6052a246546f) |
| 3 | Recevoir le rappel choisi et revenir à Aujourd'hui | `c4b552ee-38d5-426c-a350-0aeda9edd271` | [Projet](https://linear.app/workspaceperso/project/track1-mobile-6052a246546f) |
| 4 | Explorer les contenus et créer une fiche manquante | `5fb223ec-f8bf-4be4-8c0c-6e08a1676353` | [Projet](https://linear.app/workspaceperso/project/track1-mobile-6052a246546f) |
| 5 | Vivre une expérience fidèle au design et mesurable | `76fbdf18-db2d-43bb-89ee-a4a401def76f` | [Projet](https://linear.app/workspaceperso/project/track1-mobile-6052a246546f) |
| 6 | Publier une seule application track1 sur l'App Store | `73ffa5ba-8b39-41a4-b490-0abf6ae87e92` | [Projet](https://linear.app/workspaceperso/project/track1-mobile-6052a246546f) |

## Issues canoniques

28 résultats uniques : 20 créations et 8 réemplois, soit 70 issues dans le projet après transcription. Tiers : 5 tier/1, 9 tier/2, 14 tier/3 ; aucun tier abaissé, aucune estimation ni échéance ajoutée. Les 28 placeholders du plan sont remplacés. P1.1 et P1.2 ont été livrés au dispatcher sans dépendance ; ils ont ensuite été démarrés par les agents d’implémentation (In Progress observé lors du contrôle final). Les 26 autres issues sont Backlog.

| Référence | Issue / URL | UUID | Action | Tier | Milestone | Dépendances de démarrage |
| --- | --- | --- | --- | --- | --- | --- |
| P1.1 | [TRA-353](https://linear.app/workspaceperso/issue/TRA-353/figer-le-passage-dexpo-au-client-ios-natif) | `8c944c68-1a4e-445c-816c-22f3a1d9f3ca` | Création | tier/1 | 1 | Aucune |
| P1.2 | [TRA-327](https://linear.app/workspaceperso/issue/TRA-327/figer-le-handoff-des-seize-ecrans-et-de-leurs-mouvements) | `cc06b014-7d22-41cf-aade-fe7f0c8d3a51` | Réemploi | tier/1 | 1 | Aucune |
| P1.3 | [TRA-335](https://linear.app/workspaceperso/issue/TRA-335/ouvrir-les-trois-entrees-dans-une-application-swiftui) | `c3368834-498f-4299-b494-15491c7c710c` | Création | tier/3 | 1 | TRA-353, TRA-327 |
| P1.4 | [TRA-336](https://linear.app/workspaceperso/issue/TRA-336/verifier-le-client-swift-a-chaque-changement) | `03c65129-78b7-4cc8-a0ca-963865af2738` | Création | tier/3 | 1 | TRA-335 |
| P1.5 | [TRA-337](https://linear.app/workspaceperso/issue/TRA-337/installer-et-archiver-un-build-ios-signe) | `9f47a100-bcfa-4843-b090-559bc621fd04` | Création | tier/3 | 1 | TRA-335 |
| P2.1 | [TRA-338](https://linear.app/workspaceperso/issue/TRA-338/lire-les-contrats-musicaux-existants-depuis-swift) | `357562f4-46d6-49a5-b914-ec3c91b2ca32` | Création | tier/2 | 2 | TRA-335 |
| P2.2 | [TRA-339](https://linear.app/workspaceperso/issue/TRA-339/respecter-le-choix-de-mesure-avec-segment-natif) | `56ca232a-e4b0-4f3e-a0c8-0f8b80921be7` | Création | tier/3 | 2 | TRA-335, TRA-327 |
| P2.3 | [TRA-340](https://linear.app/workspaceperso/issue/TRA-340/choisir-et-gerer-ses-gouts-uniquement-sur-liphone) | `a15d9904-83c0-401c-9519-afd822a91f74` | Création | tier/3 | 2 | TRA-338, TRA-339 |
| P2.4 | [TRA-341](https://linear.app/workspaceperso/issue/TRA-341/lire-une-fiche-et-parcourir-ses-relations) | `02f728d7-5c44-462a-a378-06769b2d77c7` | Création | tier/2 | 2 | TRA-338, TRA-339 |
| P2.5 | [TRA-342](https://linear.app/workspaceperso/issue/TRA-342/ouvrir-spotify-ou-apple-music-depuis-une-fiche) | `346fa7ba-4c5c-4113-9013-134be64a5bf0` | Création | tier/2 | 2 | TRA-341 |
| P2.6 | [TRA-343](https://linear.app/workspaceperso/issue/TRA-343/retrouver-une-decouverte-stable-chaque-jour) | `e2a063c1-c63e-4009-8380-f144481a721a` | Création | tier/2 | 2 | TRA-340, TRA-341, TRA-342 |
| P3.1 | [TRA-344](https://linear.app/workspaceperso/issue/TRA-344/enregistrer-separement-les-abonnements-apns-anonymes) | `29acceda-3610-4a35-bb05-e19d85710d0c` | Création | tier/3 | 3 | TRA-353 |
| P3.2 | [TRA-345](https://linear.app/workspaceperso/issue/TRA-345/acheminer-le-rappel-quotidien-directement-par-apple) | `9f5668c0-2f22-40c5-9b07-1966d5b85667` | Création | tier/3 | 3 | TRA-344 |
| P3.3 | [TRA-346](https://linear.app/workspaceperso/issue/TRA-346/choisir-les-rappels-et-ouvrir-la-decouverte-depuis-ios) | `80214dce-f4d2-4948-b8cd-4f6210100596` | Création | tier/3 | 3 | TRA-337, TRA-343, TRA-344, TRA-345 |
| P4.1 | [TRA-347](https://linear.app/workspaceperso/issue/TRA-347/presenter-les-particularites-des-cinq-types-de-fiches) | `a60e6f62-480b-4e14-b2c4-880405d7cc7b` | Création | tier/2 | 4 | TRA-341 |
| P4.2 | [TRA-348](https://linear.app/workspaceperso/issue/TRA-348/rechercher-les-cinq-types-de-contenus) | `c7956aec-46cd-46b6-8b46-31aa3fb32441` | Création | tier/2 | 4 | TRA-338, TRA-339, TRA-341 |
| P4.3 | [TRA-349](https://linear.app/workspaceperso/issue/TRA-349/creer-une-fiche-sur-demande-et-reprendre-son-suivi) | `d7d1a574-3653-44c2-bf38-d7fc113e980a` | Création | tier/2 | 4 | TRA-348, TRA-341 |
| P4.4 | [TRA-350](https://linear.app/workspaceperso/issue/TRA-350/relire-les-contenus-hors-ligne-et-effacer-leurs-traces-locales) | `bad544a1-59d6-434e-9e52-340b147a19ad` | Création | tier/3 | 4 | TRA-340, TRA-343, TRA-348, TRA-349 |
| P4.5 | [TRA-351](https://linear.app/workspaceperso/issue/TRA-351/retrouver-la-bonne-fiche-depuis-un-lien-track1) | `698c7511-61e9-487d-9317-c1a083b3acdb` | Création | tier/2 | 4 | TRA-341, TRA-346 |
| P5.1 | [TRA-352](https://linear.app/workspaceperso/issue/TRA-352/affiner-les-animations-et-leurs-variantes-accessibles) | `286f9f6d-e238-4171-91ff-c81f6ffc9ee5` | Création | tier/2 | 5 | TRA-343, TRA-346, TRA-347, TRA-348, TRA-349, TRA-350, TRA-351, TRA-327 |
| P5.2 | [TRA-317](https://linear.app/workspaceperso/issue/TRA-317/rendre-la-confidentialite-comprehensible-et-accessible) | `9f970dd6-1304-4daa-9ba0-e6484cd71307` | Réemploi | tier/3 | 5 | TRA-339, TRA-340, TRA-346, TRA-350 |
| P5.3 | [TRA-315](https://linear.app/workspaceperso/issue/TRA-315/verifier-segment-vers-amplitude-et-les-indicateurs-ios) | `7d0f9daa-45b2-4401-8eea-43a366c0898e` | Réemploi | tier/3 | 5 | TRA-337, TRA-339 |
| P5.4 | [TRA-331](https://linear.app/workspaceperso/issue/TRA-331/valider-les-seize-ecrans-et-les-parcours-natifs-integres-sur-iphone) | `a2cc737e-5917-4abf-b927-1d5fed8559db` | Réemploi | tier/1 | 5 | TRA-336, TRA-352, TRA-317, TRA-315 |
| P6.1 | [TRA-318](https://linear.app/workspaceperso/issue/TRA-318/presenter-fidelement-track1-dans-lapp-store) | `7b0a2ef1-d20c-4e41-bedc-4877d3d69d3b` | Réemploi | tier/1 | 6 | TRA-331 |
| P6.2 | [TRA-319](https://linear.app/workspaceperso/issue/TRA-319/distribuer-le-candidat-natif-aux-testeurs-testflight) | `9d58ff65-6515-4ae0-8d0b-bdc9a7480016` | Réemploi | tier/3 | 6 | TRA-331 |
| P6.3 | [TRA-354](https://linear.app/workspaceperso/issue/TRA-354/archiver-le-client-expo-et-fermer-son-chemin-de-distribution) | `4c2cb87e-cb81-4351-8024-e3979e5816da` | Création | tier/3 | 6 | TRA-319 |
| P6.4 | [TRA-320](https://linear.app/workspaceperso/issue/TRA-320/qualifier-le-candidat-testflight-pour-sa-sortie-publique) | `6e35a672-3e77-49e2-affc-bcf2e04ec23d` | Réemploi | tier/1 | 6 | TRA-318, TRA-319, TRA-354 |
| P6.5 | [TRA-321](https://linear.app/workspaceperso/issue/TRA-321/publier-track1-natif-et-verifier-sa-disponibilite) | `12760ae5-2445-42d6-a473-34663b4cf22b` | Réemploi | tier/3 | 6 | TRA-320 |

P5.3 / TRA-315 dépend au démarrage de TRA-337 et TRA-339 uniquement. Les preuves de P3.3 / TRA-346 et P4.3 / TRA-349 restent des conditions de clôture dans son contrat.

## Réconciliation historique effectuée

Les huit réemplois conservent ID/UUID, historique, PR et pièces jointes ; titres, contrats, tiers et milestones natifs sont transcrits. Le commentaire exact de remplacement du manifeste a été ajouté à chaque réemploi. Les anciennes dépendances remplacées par les prérequis natifs ont été retirées ; relations utiles et liens de PR conservés.

| Issue historique | Mutation effective | Successeur(s) |
| --- | --- | --- |
| TRA-290 | Canceled ; description et preuves conservées ; relation et commentaire exact ajoutés | TRA-337 |
| TRA-305 | Canceled ; description et preuves conservées ; relation et commentaire exact ajoutés | TRA-346 |
| TRA-311 | Canceled ; description et preuves conservées ; relation et commentaire exact ajoutés | TRA-351 |
| TRA-328 | Canceled ; description et preuves conservées ; relation et commentaire exact ajoutés | TRA-335, TRA-340, TRA-343 |
| TRA-329 | Canceled ; description et preuves conservées ; relation et commentaire exact ajoutés | TRA-341, TRA-347, TRA-348, TRA-350 |
| TRA-330 | Canceled ; description et preuves conservées ; relation et commentaire exact ajoutés | TRA-352 |
| TRA-306 | Backlog conservé ; bloqué par le successeur ; commentaire exact ajouté | TRA-331 |
| TRA-313 | Backlog conservé ; bloqué par le successeur ; commentaire exact ajouté | TRA-331 |
| TRA-316 | Backlog conservé ; bloqué par le successeur ; commentaire exact ajouté | TRA-315 |
| TRA-322 | Backlog conservé, sans date ; commentaire exact de report Android ajouté ; aucune issue native bloquée | Android natif Java différé |
| TRA-332 | Backlog conservé, sans date ; commentaire exact de report Android ajouté ; aucune issue native bloquée | Android natif Java différé |
| TRA-333 | Backlog conservé, sans date ; commentaire exact de report Android ajouté ; aucune issue native bloquée | Android natif Java différé |
| TRA-334 | Backlog conservé, sans date ; commentaire exact de report Android ajouté ; aucune issue native bloquée | Android natif Java différé |

Les trois suivis TRA-306/313/316 ne sont pas des tickets d’exécution supplémentaires. Linear conserve une seule relation par paire : la relation bloquante requise porte le lien au successeur ; le commentaire exact le rappelle. Ce traitement a été confirmé par le dispatcher.

Dépendances historiques contradictoires retirées des suivis : TRA-306 ← TRA-305/301 ; TRA-313 ← TRA-310/308/311/312/307 ; TRA-316 ← TRA-306/313. Les prérequis utiles TRA-297/304/315 de TRA-306 sont conservés. Les dépendances Android existantes ne bloquent aucune issue native.

Aucune issue Done n’a été rouverte ou réécrite. TRA-323/324 et les autres objets hors liste restent inchangés. Les anciens milestones et le mapping Expo restent intacts ; aucune PR fermée et aucun asset supprimé.

## Contrôle final

- Un résultat unique par Pn.n, titre exact, description complète, tier et milestone vérifiés par relecture des 28 issues.
- Dépendances natives comparées au manifeste ; aucun cycle ni dépendance Android bloquante dans les 28 résultats.
- Descriptions historiques des 13 cibles de réconciliation relues et conservées à l’identique ; statuts attendus vérifiés.
- Linear normalise le Markdown et enrichit automatiquement certains IDs/PR/URLs en liens ; aucun contrat n’a été reformulé.
- Aucun code, fichier de cache, design Figma, commit ou modification hors des deux artefacts autorisés.

