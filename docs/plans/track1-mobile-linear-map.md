> Historique — remplacé pour l'exécution par [le plan iOS natif](track1-native-ios.md), validé le 2026-10-05. Corps historique conservé à l'identique.

# Mapping Linear — Track1 mobile

Source : `docs/plans/track1-mobile-linear.md`.
Validation du plan : 2026-09-30.

## Projet

- Identifiant : P-TRA-4
- UUID : `1af27c25-2427-4d6c-a93c-a4f431732eca`
- URL : https://linear.app/workspaceperso/project/track1-mobile-6052a246546f

## Milestones

| Partie | Titre | ID |
| --- | --- | --- |
| 1 | Installer et ouvrir track1 sur son téléphone | `8102d49c-3665-4b40-a720-d25380bb3bde` |
| 2 | Retrouver les contenus Odyssey depuis track1 | `eafe21af-b3ab-431d-b35b-50430311af01` |
| 3 | Découvrir et écouter une recommandation chaque jour | `e9eb7993-dcae-41cc-870e-a225a1cae6ca` |
| 4 | Explorer tout l'univers musical et créer les fiches manquantes | `ea643ba7-394f-4bdb-9ffb-8fd1b0d3d998` |
| 5 | Comprendre ce qui donne envie de découvrir et de revenir | `c542e799-f7f2-4711-a1ed-3b69075460cb` |
| 6 | Découvrir track1 avec une interface et des animations cohérentes | `b04185ce-fabe-47ed-b6b4-94bbb599595f` |
| 7 | Mettre track1 entre les mains des premiers utilisateurs iOS | `4860953a-bfb0-4eb4-9f87-a93c69e18241` |
| 8 | Ouvrir track1 aux utilisateurs Android lors de la reprise | `5412a730-89cf-4691-ab8e-fadfe1582942` |

## Issues

Transcription iOS-first terminée et vérifiée le 2026-09-30 : 46 issues de périmètre, dont les 38 issues conservées TRA-285 à TRA-322 et les 8 nouvelles TRA-327 à TRA-334, sans doublon dans le projet. Titres, équipe, projet, milestones, tiers et dépendances contrôlés contre le manifeste. Aucun champ d'estimation ni date d'échéance renseigné. P1.1 et P5.1 n'ont aucune dépendance.

Les 46 identifiants sont reportés dans le plan ; aucune tâche ne conserve de placeholder TRA-?. Les statuts existants ont été préservés. Aucun commit effectué.

| Référence | Issue | UUID | Tier | Milestone |
| --- | --- | --- | --- | --- |
| P1.1 | [TRA-285](https://linear.app/workspaceperso/issue/TRA-285/aligner-les-regles-ci-de-taille-et-de-merge) | `f77a4109-ff1e-44a9-af00-5ed422b3b16a` | tier/3 | 1 |
| P1.2 | [TRA-287](https://linear.app/workspaceperso/issue/TRA-287/installer-un-socle-mobile-reproductible-et-verifiable) | `800298de-0a19-443b-bfac-99eadb223528` | tier/3 | 1 |
| P1.3 | [TRA-288](https://linear.app/workspaceperso/issue/TRA-288/ouvrir-les-trois-entrees-de-navigation) | `46bb0a54-ceec-449f-b0ea-5a4f1098f7ff` | tier/2 | 1 |
| P1.4 | [TRA-289](https://linear.app/workspaceperso/issue/TRA-289/verifier-le-mobile-a-chaque-pr) | `11c56bfe-028f-4094-8d8d-2c77ae9ebf28` | tier/3 | 1 |
| P1.5 | [TRA-290](https://linear.app/workspaceperso/issue/TRA-290/distribuer-des-builds-natifs-de-developpement-sur-les-deux-plateformes) | `e2a2648f-8ed7-4395-b4a3-5c57df6a9d1d` | tier/3 | 1 |
| P2.1 | [TRA-291](https://linear.app/workspaceperso/issue/TRA-291/fournir-le-catalogue-mobile-et-fixer-le-contrat-dacces) | `3293b4ca-4920-429e-b86a-d5844ec65448` | tier/3 | 2 |
| P2.2 | [TRA-292](https://linear.app/workspaceperso/issue/TRA-292/lire-une-fiche-son-image-et-ses-liens-sans-generation-implicite) | `aac2b1c8-82d8-4590-b9a8-855dca6e4be3` | tier/3 | 2 |
| P2.3 | [TRA-293](https://linear.app/workspaceperso/issue/TRA-293/exposer-la-recherche-globale-au-mobile) | `07693777-c0ec-4719-a2e0-c1b43036eba2` | tier/3 | 2 |
| P2.4 | [TRA-294](https://linear.app/workspaceperso/issue/TRA-294/conserver-les-demandes-de-generation-malgre-les-redemarrages) | `583d4422-c205-4a89-9768-c176a8e0de65` | tier/3 | 2 |
| P2.5 | [TRA-295](https://linear.app/workspaceperso/issue/TRA-295/declencher-et-suivre-une-generation-publique-de-bout-en-bout-cote) | `2140381a-c8f0-4e72-8093-38fb35c5a566` | tier/3 | 2 |
| P2.6 | [TRA-296](https://linear.app/workspaceperso/issue/TRA-296/donner-au-mobile-un-client-reseau-valide-et-resilient) | `81ff104c-17fd-41a5-bd20-34b0c27ce94d` | tier/2 | 2 |
| P2.7 | [TRA-297](https://linear.app/workspaceperso/issue/TRA-297/deployer-lacces-mobile-sans-regression-du-site) | `b0f1104b-f9d4-46a9-bf3d-ebebf2968a7d` | tier/3 | 2 |
| P3.1 | [TRA-298](https://linear.app/workspaceperso/issue/TRA-298/choisir-modifier-et-conserver-ses-gouts-sur-le-telephone) | `7d9d2bdb-6659-4df7-b684-a3c9d9213905` | tier/3 | 3 |
| P3.2 | [TRA-299](https://linear.app/workspaceperso/issue/TRA-299/lire-une-fiche-et-explorer-ses-relations) | `f6b4025a-11a4-4f0e-b076-21af05184f16` | tier/2 | 3 |
| P3.3 | [TRA-300](https://linear.app/workspaceperso/issue/TRA-300/proposer-et-retrouver-sa-decouverte-du-jour) | `2ac5e9af-5088-4cc8-bce4-385f210daaeb` | tier/2 | 3 |
| P3.4 | [TRA-301](https://linear.app/workspaceperso/issue/TRA-301/rejoindre-spotify-ou-apple-music-depuis-une-fiche) | `9c0d86a6-d1da-4ced-8099-8cf77d0ab1ae` | tier/2 | 3 |
| P3.5 | [TRA-302](https://linear.app/workspaceperso/issue/TRA-302/gerer-les-abonnements-anonymes-aux-rappels) | `cc5d1c6b-50b4-4dcf-89c3-69f9399a7c20` | tier/3 | 3 |
| P3.6 | [TRA-303](https://linear.app/workspaceperso/issue/TRA-303/envoyer-les-rappels-et-traiter-les-retours-expo) | `678a22e1-2f02-4869-a741-d2c38038d1e2` | tier/3 | 3 |
| P3.7 | [TRA-304](https://linear.app/workspaceperso/issue/TRA-304/declencher-les-rappels-a-9-h-locale-sur-le-serveur) | `b3b7d5db-0354-4354-a760-281201811189` | tier/3 | 3 |
| P3.8 | [TRA-305](https://linear.app/workspaceperso/issue/TRA-305/choisir-les-rappels-et-retrouver-aujourdhui-depuis-une-notification) | `baca2a4e-e627-45a7-8252-23270af3f0f9` | tier/3 | 3 |
| P3.9 | [TRA-306](https://linear.app/workspaceperso/issue/TRA-306/verifier-le-parcours-quotidien-complet-sur-appareils) | `a8c152b1-98fc-4b1b-8e4b-d563796c60f1` | tier/1 | 3 |
| P4.1 | [TRA-307](https://linear.app/workspaceperso/issue/TRA-307/completer-les-fiches-des-artistes-et-de-leurs-oeuvres) | `cdb892f3-5f2e-4e55-9277-e1a3cd3a852b` | tier/2 | 4 |
| P4.2 | [TRA-308](https://linear.app/workspaceperso/issue/TRA-308/explorer-les-particularites-des-genres-et-labels) | `031a28c7-2916-4f92-b9f7-14b3d0b652f2` | tier/2 | 4 |
| P4.3 | [TRA-309](https://linear.app/workspaceperso/issue/TRA-309/rechercher-dans-tous-les-types-de-contenus) | `e39245b6-af02-41e3-8418-1ce56f6b7607` | tier/2 | 4 |
| P4.4 | [TRA-310](https://linear.app/workspaceperso/issue/TRA-310/creer-une-fiche-absente-et-suivre-son-resultat) | `0a6fd1fb-0e5b-4a3f-9b6e-8b9cf58ef6c2` | tier/2 | 4 |
| P4.5 | [TRA-311](https://linear.app/workspaceperso/issue/TRA-311/ouvrir-directement-une-fiche-depuis-un-lien-track1) | `9824355e-287d-4074-8629-5ba373509221` | tier/2 | 4 |
| P4.6 | [TRA-312](https://linear.app/workspaceperso/issue/TRA-312/continuer-a-consulter-et-reprendre-les-parcours-malgre-les-pannes) | `25f4639a-f063-4008-b55c-480c3d576970` | tier/2 | 4 |
| P4.7 | [TRA-313](https://linear.app/workspaceperso/issue/TRA-313/verifier-lexploration-et-laccessibilite-sur-les-deux-plateformes) | `fcd6e036-ba26-4426-8cab-40db32066fff` | tier/1 | 4 |
| P5.1 | [TRA-286](https://linear.app/workspaceperso/issue/TRA-286/definir-les-evenements-et-les-indicateurs-track1) | `a8f1f2bc-2ae0-4510-94aa-398a5374031d` | tier/1 | 5 |
| P5.2 | [TRA-314](https://linear.app/workspaceperso/issue/TRA-314/mesurer-les-parcours-uniquement-selon-le-choix-de-la-personne) | `b1ab18b9-f896-4ff2-b656-772d181ac9ea` | tier/3 | 5 |
| P5.3 | [TRA-315](https://linear.app/workspaceperso/issue/TRA-315/relier-segment-a-amplitude-pour-les-environnements-separes) | `7d0f9daa-45b2-4401-8eea-43a366c0898e` | tier/3 | 5 |
| P5.4 | [TRA-316](https://linear.app/workspaceperso/issue/TRA-316/rendre-les-indicateurs-de-lancement-fiables-et-consultables) | `b5791e36-409b-4d04-aa7c-4809d15cf125` | tier/1 | 5 |
| P6.1 | [TRA-327](https://linear.app/workspaceperso/issue/TRA-327/definir-et-faire-valider-le-design-des-parcours-et-de-leurs-animations) | `cc06b014-7d22-41cf-aade-fe7f0c8d3a51` | tier/1 | 6 |
| P6.2 | [TRA-328](https://linear.app/workspaceperso/issue/TRA-328/appliquer-le-design-au-premier-lancement-et-a-la-decouverte-du-jour) | `23a34df6-c8fa-4ed4-aace-5abac479cb85` | tier/2 | 6 |
| P6.3 | [TRA-329](https://linear.app/workspaceperso/issue/TRA-329/appliquer-le-design-aux-fiches-a-la-recherche-et-aux-reglages) | `01e9a9dd-0141-4a34-b213-984ff6a361fc` | tier/2 | 6 |
| P6.4 | [TRA-330](https://linear.app/workspaceperso/issue/TRA-330/appliquer-les-animations-validees-avec-une-variante-accessible) | `a00d0078-b321-43f3-a9c6-287f82c21262` | tier/2 | 6 |
| P6.5 | [TRA-331](https://linear.app/workspaceperso/issue/TRA-331/valider-linterface-finale-et-ses-animations-sur-iphone) | `a2cc737e-5917-4abf-b927-1d5fed8559db` | tier/1 | 6 |
| P7.1 | [TRA-317](https://linear.app/workspaceperso/issue/TRA-317/publier-la-politique-de-confidentialite-dans-lapp-et-par-url) | `9f970dd6-1304-4daa-9ba0-e6484cd71307` | tier/3 | 7 |
| P7.2 | [TRA-318](https://linear.app/workspaceperso/issue/TRA-318/preparer-la-presentation-de-track1-sur-lapp-store) | `7b0a2ef1-d20c-4e41-bedc-4877d3d69d3b` | tier/1 | 7 |
| P7.3 | [TRA-319](https://linear.app/workspaceperso/issue/TRA-319/distribuer-la-beta-ios-dans-testflight) | `9d58ff65-6515-4ae0-8d0b-bdc9a7480016` | tier/3 | 7 |
| P7.4 | [TRA-320](https://linear.app/workspaceperso/issue/TRA-320/valider-la-beta-ios-et-decider-sa-publication) | `6e35a672-3e77-49e2-affc-bcf2e04ec23d` | tier/1 | 7 |
| P7.5 | [TRA-321](https://linear.app/workspaceperso/issue/TRA-321/publier-track1-sur-lapp-store) | `12760ae5-2445-42d6-a473-34663b4cf22b` | tier/3 | 7 |
| P8.1 | [TRA-332](https://linear.app/workspaceperso/issue/TRA-332/verifier-les-parcours-les-push-et-la-mesure-sur-android-physique) | `71e62746-fcd9-4289-bd60-ff6f2c2b0a7a` | tier/3 | 8 |
| P8.2 | [TRA-333](https://linear.app/workspaceperso/issue/TRA-333/preparer-google-play-et-distribuer-la-beta-android) | `a2ea670a-f570-47cd-8912-843474228a09` | tier/3 | 8 |
| P8.3 | [TRA-334](https://linear.app/workspaceperso/issue/TRA-334/valider-la-beta-android-et-decider-sa-publication) | `3ca3afc6-145b-4a65-ab97-89b42385f39f` | tier/1 | 8 |
| P8.4 | [TRA-322](https://linear.app/workspaceperso/issue/TRA-322/publier-track1-sur-google-play) | `fb9a66d0-c7ea-4481-af03-c7ef725fa7e8` | tier/3 | 8 |

Historique : création P1.1 refusée le 2026-09-25, HTTP 400, requestId `a40ba8e5d8386f24` : « You've exceeded the free issue limit for this workspace. Please upgrade or contact sales@linear.app for a free trial. » Aucun ticket partiel n'avait été créé.
