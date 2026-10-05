> Historique — remplacé pour l'exécution par [le plan iOS natif](track1-native-ios.md), validé le 2026-10-05. Corps historique conservé à l'identique.

# Track1 mobile

Statut : **amendement iOS-first du 28 septembre 2026 à valider par Raphael**. Le plan initial a été validé le 25 septembre et transcrit le 26 septembre dans le projet [Track1 Mobile — P-TRA-4](https://linear.app/workspaceperso/project/track1-mobile-6052a246546f). La direction iOS-first est acquise ; le découpage détaillé ci-dessous et le passage par la refonte restent à valider. Aucune deadline ni estimation de charge. `docs/plans/track1-mobile-linear.md` et `docs/plans/track1-mobile-linear-map.md` conservent la transcription précédente ; ils ne sont pas mis à jour à ce stade. Aucun objet Linear modifié.

## Problème

Odyssey permet déjà de découvrir la culture musicale en reliant artistes, œuvres, genres et labels. Son usage actuel passe par une page web. Pour une personne qui veut découvrir quelque chose à écouter chaque jour, il manque une expérience installée sur son téléphone, un rappel quotidien et une continuité simple entre recommandation, découverte et écoute dans son service habituel.

Les contenus et une partie des règles de recommandation existent. Le problème est de les rendre accessibles dans un usage mobile régulier, sans demander la création d'un compte ni dégrader le site qui fonctionne déjà. Il faut aussi pouvoir comprendre, dès le lancement, si les personnes découvrent effectivement des œuvres et reviennent.

Le premier build iOS a désormais été installé sur un iPhone et ses trois onglets ont été vérifiés. Un APK Android a été construit, sans validation sur téléphone Android. Les critères communs aux deux plateformes empêchent aujourd'hui de terminer certains tickets malgré les preuves iOS disponibles. L'interface et ses animations doivent également être définies puis harmonisées avant d'inviter davantage de testeurs et de préparer la présentation publique.

## Objectifs

1. Une personne peut installer **track1 depuis l'App Store**, choisir ses goûts et obtenir une recommandation expliquée sans créer de compte ; l'attente de validation Android ne retarde pas cette première sortie.
2. Elle retrouve une découverte du jour à chaque visite et peut recevoir un rappel, sans que le refus des notifications empêche l'usage.
3. Elle peut passer d'une recommandation à une fiche, suivre ses relations musicales, rechercher un autre sujet et faire créer une fiche absente.
4. Elle peut ouvrir Spotify ou Apple Music pour écouter ; une panne réseau ou l'épuisement des crédits de génération laisse les contenus déjà disponibles consultables.
5. Les premiers utilisateurs iOS découvrent une interface et des animations cohérentes avec un design validé ; l'équipe mesure leur parcours jusqu'à l'ouverture d'un service d'écoute et leur retour quotidien, avec des événements vérifiés avant publication.

## Non-buts

- Compte serveur, connexion sociale, synchronisation du profil entre appareils, import du profil web.
- Lecture audio intégrée dans l'application, téléchargement audio, playlist ou connexion aux comptes Spotify/Apple Music.
- Modification de l'interface du site, suppression de son lecteur ou migration de ses données.
- Nouveau modèle de recommandation par IA, entraînement, fil social, favoris ou notation des recommandations.
- Refonte générale du backend, déplacement de la base musicale vers une nouvelle base de données, infrastructure anti-abus ou facturation utilisateurs.
- Graphe animé en deux dimensions : la navigation mobile suit les relations sous forme de listes et de cartes.
- Validation physique Android, recette TalkBack, test des push Android, Play Console et publication Google Play dans la première sortie : ces travaux restent conservés en partie 8, en attente de reprise explicite.
- Installation ou choix imposé d'un workflow Figma/MCP, invention de maquettes absentes, ajout de nouvelles fonctionnalités au prétexte de la refonte.

## Solution haut niveau

track1 devient une application dédiée à la découverte musicale, avec trois entrées : **Aujourd'hui**, **Recherche** et **Réglages**. Au premier lancement, la personne choisit des genres. L'application garde ces goûts sur le téléphone et les utilise pour sélectionner chaque jour un artiste, un projet musical ou un morceau déjà présent dans Odyssey. Une courte explication relie la proposition à ses goûts.

La fiche permet de lire le contexte culturel, voir une image, suivre les relations vers d'autres fiches et ouvrir son service d'écoute. La recherche couvre les cinq types de contenus. Quand un résultat ou une relation n'a pas encore de fiche, une action explicite permet de la générer ; l'application affiche son avancement puis le résultat, ou une indisponibilité compréhensible.

Après avoir vu sa première recommandation, la personne peut activer un rappel quotidien. Décision validée : **9 h dans le fuseau du téléphone**, avec le texte « Une découverte musicale t'attend. Ouvre track1 pour la découvrir. ». Le rappel ouvre Aujourd'hui ; la recommandation est calculée ou retrouvée sur le téléphone. Le serveur ne conserve donc pas les goûts pour préparer les notifications.

Les parties 1 à 5 conservent les fondations, l'accès aux contenus, le parcours quotidien, l'exploration et la mesure déjà prévus. Leurs validations physiques portent désormais sur iOS pour la première sortie. La partie 6 fixe le design puis applique l'interface et les animations aux parcours existants ; sa validation précède les captures, l'élargissement TestFlight et la publication App Store de la partie 7. La partie 8 garde les contrôles et la publication Android à reprendre plus tard, sans dépendance bloquante vers la sortie iOS.

**La mesure et les push restent présents dès le parcours initial** ; la refonte ne les repousse pas. La partie 5 commence avec les fondations et chaque parcours est instrumenté dans sa tâche. Les builds internes iOS peuvent continuer à servir aux développeurs et au travail de design avant la refonte ; l'élargissement de la bêta attend l'interface finale. Le code et la configuration Android restent maintenus et compilables, sans confondre compilation et fonctionnement vérifié sur un appareil.

## Découpage

### Mode de lecture et ordre de livraison

Les références `P1.1`, etc. servent à ordonner ce plan ; les **38 identifiants TRA-285 à TRA-322 sont conservés**. La refonte ajoute cinq tâches et la reprise Android trois tâches, soit **46 tâches planifiées dans le même projet**. Les huit nouvelles tâches portent les identifiants TRA-327 à TRA-334. L'ancienne partie 6 devient la partie 7 pour iOS ; TRA-322 rejoint la partie 8. Les identifiants des milestones existants sont conservés lors de leur renommage ou réordonnancement ; deux milestones sont ajoutés, sans recréer le projet. L'annexe conserve la correspondance historique et explique ces déplacements.

Les descriptions suivantes fixent les résultats, preuves, tiers et dépendances du plan. Elles ne remplacent pas encore les contrats Linear : **la validation de cet amendement précède leur transcription**. Une case cochée représente uniquement un acquis confirmé dans cette session ; les autres cases ne prétendent pas refléter le statut Linear actuel. Le futur ticket-writer relit les statuts, conserve les tickets terminés, leurs PR et leurs preuves, puis applique seulement les changements de périmètre ou de dépendance validés.

L'autorisation d'enchaîner jusqu'à publication sans nouvel accord, donnée le 25 septembre et consignée dans le manifeste existant, est conservée. Le go/no-go de chaque plateforme est une décision opérationnelle fondée sur les preuves et les accès réels, pas une nouvelle demande d'approbation du build à Raphael. L'amendement du plan exige sa validation ; le design encore absent exige un handoff approuvé. La reprise Android reste une décision de réactivation du travail différé.

**Un ticket = une branche = une PR portant un comportement cohérent**, avec les couches directement nécessaires et tous ses tests. Pour une feature mobile, 300–800 lignes écrites, ajouts et suppressions tests inclus, est un repère : ni minimum à atteindre ni plafond. Pour le backend partagé, les données, les secrets et la CI/déploiement, viser des changements plus ciblés, généralement 200–400 lignes. Au-delà de 1 000 lignes ou de 20 fichiers écrits, réexaminer et justifier le périmètre ; ne pas arrêter automatiquement. Les niveaux de risque et les reviews automatisées sont conservés ; `tier/3` n'impose plus un plafond de 200 lignes ni une validation humaine du merge. Une review approfondie de la version exacte à fusionner et tous les contrôles requis au vert restent obligatoires avant l'auto-merge. TRA-285 rend cette exigence opposable dans le check GitHub requis `review-gate` : une review ordinaire positive ne suffit pas pour tier/3, même avec auto-merge armé avant classification.

Lockfiles, fichiers générés et assets sont comptés séparément, avec leur provenance. Le code de scaffold et les tests restent du code écrit à reviewer ; aucune réduction des tests ne sert à respecter un seuil. **Cette règle est déjà autorisée par Raphael** et consignée dans [la référence commune de dimensionnement](../../.agents/skills/delivery-process/references/diff-size.md). Les tâches sont définies par leur périmètre, leurs critères d'acceptation et leurs dépendances, sans estimation de durée ou de charge.

La cartographie initiale est conservée ; une vérification ciblée des chemins mobiles porte sur `origin/main` au SHA `7bff0f5d3e9b69d6c9822da0387b6734cb482d1d`, et sur la branche TRA-290 au SHA `ca57d01cc6035d1a035ee49fed393f6ee1a8ab56`. Le checkout documentaire courant ne contient pas `mobile/` ; les chemins mobiles ont été vérifiés dans ces objets Git. `mobile/`, ses routes, composants et tests existent déjà sur main. Les mentions de création héritées des tâches initiales décrivent leur livrable, pas un ordre de recréer l'existant. Chaque reprise utilise le code livré et complète ses tests. Les nouveaux fichiers de design, de recette ou de store sont explicitement signalés comme à créer dans des parents vérifiés.

Acquis à préserver : le socle, la navigation et la CI JS/TypeScript sont sur main ; cette CI ne prouve pas un build natif EAS. TRA-312 et TRA-314 sont confirmés Done. Les améliorations complémentaires TRA-325 (tests push, PR #304) et TRA-326 (purge du cache liée à la confidentialité, PR #305) sont confirmées livrées, hors des 38 tickets initiaux : aucune recréation ni réouverture prévue. TRA-290 est encore In Progress : iPhone et navigation validés, APK construit, installation Android non exécutée. Ses configurations natives ne sont pas encore fusionnées. Tous les autres statuts seront relus avant transcription.

Ordre de livraison : **acquis des parties 1 à 5 préservés → terminer les verrous iOS et les contrôles de mesure → refonte validée → captures et TestFlight élargi → décision de publication iOS → App Store**. La définition du design P6.1 peut avancer en parallèle des verrous fonctionnels ; elle ne retarde pas les développements indépendants. P1.1 reste un préalable s'il n'est pas déjà livré. Les dépendances explicites autorisent les worktrees parallèles ; les modifications d'un même fichier, notamment `src/server.ts` ou une route mobile, sont intégrées dans leur ordre de dépendance. Chaque partie peut être déployée après ses prérequis, sur des builds internes avant la sortie publique. **Aucune tâche des parties 1 à 7 ne dépend d'une tâche Android de la partie 8.**

Chaque matrice de recette distingue `iOS : réussi / échoué / non exécuté` et `Android : différé — non exécuté`, avec version, appareil, date et preuve quand le test existe. Transférer un critère Android en partie 8 conserve son obligation future ; cela ne le transforme jamais en réussite. Une régression de compilation Android connue doit être corrigée dans la tâche responsable : l'absence d'appareil, de QA ou de compte Google n'est pas un blocage iOS. Un build Android interne du candidat retenu prouve la compilation, sans test physique ni passage par Play Console.

### Partie 1 — Installer et ouvrir track1 sur son téléphone

#### Description du milestone Linear

- **Objectif produit :** disposer d'une application track1 installable et vérifiée sur iPhone pour poursuivre les validations produit.
- **Solution :** conserver l'application et ses trois entrées de navigation, finaliser sa distribution interne iOS et garder la capacité de construire Android.
- **Logiques ajoutées ou modifiées :** ouverture initiale, navigation, choix de l'environnement de test ou de production, séparation des versions internes et publiques ; preuves d'installation séparées par plateforme.
- **Résultat observable :** un testeur installe track1 sur iPhone et navigue entre Aujourd'hui, Recherche et Réglages ; un artefact Android se compile et sa validation sur appareil reste explicitement différée ; les vérifications du backend passent.

#### Tâches

Ancrages vérifiés : `package.json`, `package-lock.json`, `tsconfig.json`, `biome.json`, `vitest.config.ts`, `.gitignore`, `.github/workflows/ci.yml`, `.github/workflows/review-gate.yml`, `.codex/scripts/publish-review-status.sh`, `test/review-status-script.test.ts`. Sous-projet existant sur main : `mobile/package.json`, `mobile/package-lock.json`, `mobile/src/config.ts`, `mobile/app/_layout.tsx`, `mobile/app/(tabs)/_layout.tsx`, `mobile/test/navigation.test.tsx`. `mobile/app.config.ts` et `mobile/eas.json` existent sur TRA-290 seulement ; `docs/track1-builds.md` existe sur main et doit recevoir les ajouts de cette branche.

- [ ] TRA-285 **P1.1 — Aligner les règles CI de taille et de merge** — `tier/3`. Modifier les jobs `diff-size` et `tier-guard`, `.github/workflows/review-gate.yml`, le publisher `.codex/scripts/publish-review-status.sh`, leurs tests et `.github/pull_request_template.md`. Volume écrit/généré séparé, lockfile mobile inclus ; tests et scaffold comptés, réexamen au-delà de 1 000 lignes/20 fichiers sans échec dû au seul volume. Le check GitHub déjà requis `review-gate` calcule le risque depuis le diff avant tout succès et exige, pour tier/3, la review ordinaire **et** une attestation distincte `codex-deep-review` de Sol/high sur le SHA final. Preuve : PR sensible encore tier/1, auto-merge préarmé et tier-guard retardé ne franchissent pas le gate sans preuve profonde ; ancien SHA, absence ou BLOCK restent bloquants. Tier-guard ne désarme plus systématiquement l'auto-merge ; tous tiers fusionnent après leurs contrôles, sans accord humain ni `--admin`. Protection existante et workflow IA inchangés ; aucune nouvelle protection requise. **Dépendances : aucune.** Correction du contrat après review de PR #278 le 26 septembre 2026, dans l'autorisation existante et sans nouveau ticket. Transition et suspension avant reclassement manuel tardif décrites dans le manifeste.
- [ ] TRA-287 **P1.2 — Installer un socle mobile reproductible et vérifiable** — `tier/3`. Créer `mobile/package.json`, lockfile, TypeScript strict, tests et commandes de vérification, `mobile/src/config.ts` et configurations publiques par environnement ; adapter les exclusions nécessaires à la racine. Preuve : installation reproductible, rendu natif et logique testés, configuration absente identifiable, aucun secret fournisseur embarqué, backend toujours vérifiable. **Dépendances : P1.1.**
- [ ] TRA-288 **P1.3 — Ouvrir les trois entrées de navigation** — `tier/2`. Livrable déjà présent sur main : `mobile/app/` avec Aujourd'hui, Recherche et Réglages, ainsi que l'état de configuration invalide. Preuve conservée : changement d'onglet, destination de retour et erreur de configuration couverts par les tests de navigation ; la recette physique Android reste dans P8.1. **Dépendances : P1.2.** Le statut Linear sera relu, sans recréer la navigation.
- [ ] TRA-289 **P1.4 — Vérifier le mobile à chaque PR** — `tier/3`. Créer `.github/workflows/mobile-ci.yml`, sans remplacer la CI backend. Preuve : une erreur mobile fait échouer le job mobile et les jobs existants restent actifs. **Dépendances : P1.2.** Parallèle à P1.3.
- [ ] TRA-290 **P1.5 — Distribuer un build iOS de développement et conserver la compilation Android** — `tier/3`. Finaliser la branche existante et ses modifications de `mobile/app.config.ts`, `mobile/eas.json`, `mobile/package.json`, `mobile/scripts/eas-build.mjs`, son test et `docs/track1-builds.md`. Preuve : profils développement/preview/production distincts, identifiants réels, installation iPhone et trois onglets vérifiés avec versions consignées ; build APK réussi conservé comme preuve de compilation. **Dépendances : P1.3, P1.4.** Le test physique Android est transféré à P8.1, avec la mention « différé — non exécuté ». La preuve iOS déjà acquise est réutilisée si son SHA reste pertinent ; clôture seulement après contrat amendé, vérification des autres critères et fusion, sans déclarer l'ancien critère Android satisfait.

Déploiement autonome : builds internes seulement ; aucun changement des parcours web.

### Partie 2 — Retrouver les contenus Odyssey depuis track1

#### Description du milestone Linear

- **Objectif produit :** donner à track1 un accès fiable aux contenus, à la recherche et à la création de fiches déjà proposés par Odyssey.
- **Solution :** ajouter une porte d'accès dédiée au mobile, réutilisant les services existants et présentant des réponses cohérentes. Consulter un contenu existant ne demande pas sa régénération.
- **Logiques ajoutées ou modifiées :** lecture et identité des fiches, recherche dans les contenus connus et le catalogue externe, chargement des images et liens, génération explicite suivie jusqu'à son résultat, erreurs compréhensibles.
- **Résultat observable :** les cinq types de fiches sont récupérables par le mobile ; une génération peut aboutir ou échouer proprement sans bloquer la consultation ; les interfaces utilisées par le web restent compatibles.

#### Tâches

Ancrages vérifiés : `src/server.ts`, `src/graph.ts`, `src/cache.ts`, `src/genre-registry.ts`, `src/errors.ts`, `src/services/graph-service.ts`, `src/services/node-service.ts`, `src/services/search-service.ts`, `src/services/materialize-service.ts`, `src/services/image-service.ts`, `src/streaming-links.ts`, `src/config.ts`, `src/env.ts`, `deploy/deploy-server.sh` ; tests existants `test/graph.test.ts`, `test/node-service.test.ts`, `test/materialize-service.test.ts`, `test/image-service.test.ts`, `test/streaming-links.test.ts`.

- [ ] TRA-291 **P2.1 — Fournir le catalogue mobile et fixer le contrat d'accès** — `tier/3`. Créer `docs/track1-api.md`, `src/mobile/catalog.ts` et sa route dans `src/server.ts`. Preuve : contrats, erreurs et cas de validation fixés ; cinq types, relations utiles et redirections conservés ; articles exclus, contenu inchangé reconnu par sa révision. **Dépendances : P1.1.** Parallèle au socle mobile.
- [ ] TRA-292 **P2.2 — Lire une fiche, son image et ses liens sans génération implicite** — `tier/3`. Créer `src/mobile/nodes.ts`, `src/mobile/media.ts` et leurs routes en réutilisant cache et résolveurs. Preuve : lecture d'une fiche ancienne sans modèle, alias canonique, absence distincte d'une panne, URL vérifiées, image/liens nulls normaux et aucune route audio appelée. **Dépendances : P2.1.**
- [ ] TRA-293 **P2.3 — Exposer la recherche globale au mobile** — `tier/3`. Créer `src/mobile/search.ts` et sa route autour du service existant. Preuve : filtre des cinq types, résultat disponible distingué du résultat à créer, entrée invalide rejetée. **Dépendances : P2.1.** Module parallélisable avec P2.2 ; raccordement serveur séquencé.
- [ ] TRA-294 **P2.4 — Conserver les demandes de génération malgré les redémarrages** — `tier/3`. Créer `src/mobile/generation-store.ts`, déclarer `MOBILE_STATE_DIR` dans `src/config.ts`, son exclusion dans `.gitignore` et sa persistance dans `deploy/deploy-server.sh`. Preuve : écriture atomique hors cache, identifiant retrouvé, demande interrompue reconnue, redéploiement sans perte ni ajout à Git. **Dépendances : P2.1.** Parallèle aux routes de lecture.
- [ ] TRA-295 **P2.5 — Déclencher et suivre une génération publique de bout en bout côté serveur** — `tier/3`. Créer `src/mobile/generation-service.ts`, `src/mobile/generation-errors.ts`, `src/mobile/generation-routes.ts` et le raccordement serveur. Preuve : accusé immédiat, cache consulté avant appel payant, doublon idempotent, capacité bornée, résultat canonique, erreurs de crédits/fournisseur sans fuite sensible et aucune reprise payante automatique après redémarrage. **Dépendances : P2.4.** La persistance et son déploiement restent séparés pour cibler cette PR sur le comportement de génération.
- [ ] TRA-296 **P2.6 — Donner au mobile un client réseau validé et résilient** — `tier/2`. Créer `mobile/src/api/` avec validation et traduction des réponses. Preuve : données invalides refusées, requêtes annulables, erreurs distinctes et aucune relance automatique d'une création. **Dépendances : P1.2, P2.1.** Parallèle aux routes serveur.
- [ ] TRA-297 **P2.7 — Déployer l'accès mobile sans régression du site** — `tier/3`. Ajouter la recette transverse `test/mobile/compatibility.test.ts`, compléter `scripts/verify-e2e.sh` si nécessaire et consigner le déploiement dans `docs/track1-api.md`. Preuve : anciennes lectures, recherche, génération et routage audio compatibles ; routes mobiles, HTTPS, erreurs et persistance vérifiés sur le serveur. **Dépendances : P2.2, P2.3, P2.4, P2.5, P2.6.**

Déploiement autonome : routes supplémentaires sur le serveur existant ; lecture web et streaming web maintenus. Les secrets du modèle et des fournisseurs restent sur le serveur.

### Partie 3 — Découvrir et écouter une recommandation chaque jour

#### Description du milestone Linear

- **Objectif produit :** livrer le parcours qui donne sa raison d'être à track1 : une découverte quotidienne personnalisée, facile à explorer puis à écouter.
- **Solution :** conserver les genres choisis sur le téléphone, reprendre la logique de recommandation d'Odyssey et proposer un rappel quotidien facultatif. Une fiche commune relie la découverte à d'autres contenus et aux services d'écoute.
- **Logiques ajoutées ou modifiées :** choix et modification des goûts, stabilité de la recommandation dans la journée, limitation des répétitions, autorisation et désactivation des rappels, retour dans l'application, lecture d'une fiche et ouverture d'un service externe.
- **Résultat observable :** sur iPhone, une personne passe de son premier choix de goûts à une découverte expliquée, reçoit le rappel si elle l'accepte, ouvre une fiche liée et rejoint Spotify ou Apple Music. Le même parcours fonctionne en ouvrant directement l'application après refus du rappel ; sa recette Android est conservée pour la reprise ultérieure.

#### Tâches

Ancrages vérifiés : logique des goûts et de recommandation dans `web/index.html` autour de `Profile`, `scoreAffinity`, `pickDailyReco` et `recoReasons` ; elle sert de référence sans modification du web. Serveur : `src/server.ts`, `src/config.ts`, `src/env.ts`, `deploy/deploy-server.sh`. Nouvelles implémentations dans `mobile/src/profile/`, `mobile/src/recommendation/`, `mobile/src/notifications/`, `mobile/src/components/` et `src/mobile/`.

- [ ] TRA-298 **P3.1 — Choisir, modifier et conserver ses goûts sur le téléphone** — `tier/3`. Créer `mobile/src/profile/`, `mobile/app/onboarding.tsx` et la section goûts des réglages. Preuve : seuil de sélection, reprise, persistance versionnée, corruption et effacement couverts ; aucun nom/email ni envoi des goûts, événement d'achèvement conforme. **Dépendances : P1.3, P2.1, P2.6, P5.2.** Profil et écran forment une seule unité fonctionnelle.
- [ ] TRA-299 **P3.2 — Lire une fiche et explorer ses relations** — `tier/2`. Créer `mobile/app/node/[slug].tsx`, la présentation native commune et `mobile/src/components/NodeRelations.tsx`. Preuve : nom/type/article/sources lisibles pour les cinq types, alias et absence gérés, navigation vers une relation et retour à la fiche précédente. **Dépendances : P1.3, P2.2, P2.6, P5.2.** Parallèle à P3.1.
- [ ] TRA-300 **P3.3 — Proposer et retrouver sa découverte du jour** — `tier/2`. Créer `mobile/src/recommendation/affinity.ts`, `daily.ts` et l'écran `mobile/app/(tabs)/index.tsx`. Preuve : scores et raisons conformes à la décision 3, stabilité après redémarrage, historique, changement de jour/goûts, catalogue vide, image de secours, ouverture de fiche et événements ; aucun besoin d'autoriser les notifications. **Dépendances : P3.1, P3.2.**
- [ ] TRA-301 **P3.4 — Rejoindre Spotify ou Apple Music depuis une fiche** — `tier/2`. Créer `mobile/src/listening/` et les actions de fiche. Preuve : lien exact privilégié, recherche de secours annoncée, URL hostile bloquée, échec visible et événement distinct d'une écoute réelle. **Dépendances : P3.2.** Parallèle à P3.3.
- [ ] TRA-302 **P3.5 — Gérer les abonnements anonymes aux rappels** — `tier/3`. Créer `src/mobile/push-store.ts` et `push-routes.ts`. Preuve : état minimal hors Git, inscription anonyme, fuseau validé, modification protégée par secret, remplacement/expiration du jeton et désinscription idempotente ; aucun goût collecté. **Dépendances : P2.4.** Parallèle aux parcours mobiles.
- [ ] TRA-303 **P3.6 — Envoyer les rappels et traiter les retours Expo** — `tier/3`. Créer `src/mobile/push-sender.ts` et `push-receipts.ts`. Preuve : message fixé, secret serveur, envoi borné, résultat ambigu sans répétition aveugle, retour consulté et jeton invalide désactivé ; acceptation fournisseur distinguée de réception téléphone. **Dépendances : P3.5.**
- [ ] TRA-304 **P3.7 — Déclencher les rappels à 9 h locale sur le serveur** — `tier/3`. Créer `src/mobile/push-schedule.ts`, raccorder le traitement à `src/server.ts` et documenter activation/déploiement dans `deploy/deploy-server.sh` et `docs/track1-builds.md`. Preuve : fenêtre d'envoi, inscription en journée, changement d'heure, unicité par date, arrêt propre et redémarrage sans réenvoi couverts. **Dépendances : P3.6.**
- [ ] TRA-305 **P3.8 — Choisir les rappels et retrouver Aujourd'hui depuis une notification** — `tier/3`. Compléter `mobile/src/notifications/` et `mobile/app/(tabs)/settings.tsx`, en conservant la baseline de tests push livrée. Preuve iOS : permission après première découverte, refus sans blocage, changement de token/fuseau et désactivation synchronisés ; ouverture à chaud, en arrière-plan ou à froid, onboarding différé et événement unique. Tests partagés conservés ; réception physique Android vérifiée dans P8.1. **Dépendances : P1.5, P3.3, P3.5.** Parallèle à P3.6–P3.7.
- [ ] TRA-306 **P3.9 — Vérifier le parcours quotidien complet sur iPhone** — `tier/1`. Ajouter ou compléter `mobile/e2e/daily-discovery.yaml` et consigner la recette dans `docs/track1-release.md` à créer. Preuve : goûts → recommandation → push réellement reçu → fiche → relation → service externe, variante rappel refusé et événements attendus sur iPhone physique ; ouverture à chaud, à froid et après arrière-plan. **Dépendances : P2.7, P3.4, P3.7, P3.8, P5.3.** Recette transverse conservée ; toute preuve Android exigée par l'ancien contrat est reprise dans P8.1 et reste non exécutée.

Déploiement autonome : première bêta utile, avec les cinq fiches en présentation commune. La partie suivante enrichit leurs détails et ouvre la recherche complète dans l'interface. Une désactivation du rappel côté serveur préserve Aujourd'hui.

### Partie 4 — Explorer tout l'univers musical et créer les fiches manquantes

#### Description du milestone Linear

- **Objectif produit :** permettre une exploration libre au-delà de la recommandation et ne pas arrêter la curiosité à une fiche absente.
- **Solution :** compléter chaque type de fiche, ouvrir la recherche globale et rendre la génération accessible depuis un résultat ou une relation. Conserver les contenus consultés et les destinations de navigation pour les interruptions ordinaires du mobile.
- **Logiques ajoutées ou modifiées :** affichage des particularités des artistes, albums, EP, singles, morceaux, genres et labels ; recherche par type ; états de génération ; liens profonds ; relecture hors connexion et reprise après erreur.
- **Résultat observable :** une personne trouve un sujet, ouvre ou génère sa fiche, suit ses relations et peut revenir sur des fiches déjà lues hors connexion, avec une explication claire des actions qui nécessitent le réseau.

#### Tâches

Ancrages vérifiés : `src/types.ts`, `src/node-spec.ts` et `src/graph.ts` définissent les cinq types, faits, relations et redirections ; `web/index.html` constitue la référence fonctionnelle. Les créations restent dans `mobile/src/`, `mobile/app/` et `mobile/test/` ; aucun changement du schéma musical n'est prévu.

- [ ] TRA-307 **P4.1 — Compléter les fiches des artistes et de leurs œuvres** — `tier/2`. Créer `mobile/src/components/ArtistDetails.tsx`, `ProjectDetails.tsx` et `TrackDetails.tsx`. Preuve : biographie, genres, discographie, artistes et œuvres associées ; albums/EP/singles selon les données, nature inconnue affichée « projet », aucun bloc vide ni lecture intégrée. **Dépendances : P3.2.**
- [ ] TRA-308 **P4.2 — Explorer les particularités des genres et labels** — `tier/2`. Créer `mobile/src/components/GenreDetails.tsx` et `LabelDetails.tsx`. Preuve : origines/contexte, genres liés, artistes et œuvres repères navigables selon les données présentes ; redirections conservées. **Dépendances : P3.2.** Parallèle à P4.1.
- [ ] TRA-309 **P4.3 — Rechercher dans tous les types de contenus** — `tier/2`. Remplir `mobile/app/(tabs)/search.tsx`. Preuve : saisie temporisée, filtres, réponses obsolètes annulées, résultat vide et provenance explicites ; événement sans texte brut de recherche. **Dépendances : P2.3, P2.6, P5.2.** Parallèle aux fiches.
- [ ] TRA-310 **P4.4 — Créer une fiche absente et suivre son résultat** — `tier/2`. Créer `mobile/src/generation/request.ts`, `status.tsx` et les actions de recherche/relation. Preuve : geste explicite, identité musicale et identifiant de demande conservés avant envoi, état en cours puis résultat canonique, reprise après fermeture, crédit épuisé/interruption expliqués et double appui sans deuxième demande payante. **Dépendances : P2.5, P3.2, P4.3.**
- [ ] TRA-311 **P4.5 — Ouvrir directement une fiche depuis un lien track1** — `tier/2`. Créer ou compléter `mobile/src/navigation/deep-links.ts` sous le parent mobile vérifié et ses tests. Preuve iOS : destinations autorisées à chaud/froid, alias résolu, destination conservée après onboarding et lien invalide sans génération implicite ; contrats et tests de navigation partagés conservés. **Dépendances : P3.2, P3.8.** Parallèle à P4.4 ; exécution physique Android dans P8.1.
- [x] TRA-312 **P4.6 — Continuer à consulter et reprendre les parcours malgré les pannes** — `tier/2`. Livré ; conserver son code, ses tests et ses preuves de cache/reprise. Portée initiale : `mobile/src/cache/`, présentation des états de requête et raccordements aux parcours. Preuve : catalogue et dernières fiches relus hors réseau, taille bornée, corruption ignorée, goûts préservés, absence/panne/génération indisponible/image absente distinguées et reprise explicite sans boucle de création. **Dépendances : P3.2, P3.3, P4.3, P4.4.** La purge liée à la confidentialité livrée dans TRA-326 est également conservée.
- [ ] TRA-313 **P4.7 — Vérifier l'exploration et l'accessibilité sur iPhone** — `tier/1`. Ajouter ou compléter `mobile/e2e/exploration.yaml` et la recette dans `docs/track1-release.md`. Preuve iOS : cinq types, recherche, création, liens profonds, retour vers la destination attendue, VoiceOver et agrandissement du texte. **Dépendances : P4.1, P4.2, P4.4, P4.5, P4.6.** Retour système Android, TalkBack et exécution Android des parcours sont transférés à P8.1. Cette première recette fonctionnelle sera réexécutée sur l'interface finale dans P6.5.

Déploiement autonome : extension de la bêta ; les nouvelles fiches générées passent toujours par le pipeline et la validation existants. Une panne de génération ne retire pas la recommandation ou les fiches disponibles.

### Partie 5 — Comprendre ce qui donne envie de découvrir et de revenir

#### Description du milestone Linear

- **Objectif produit :** savoir si la recommandation conduit à une découverte, à l'ouverture d'un service d'écoute et au retour dans track1.
- **Solution :** conserver les événements définis avant les parcours, les envoyer par Segment vers Amplitude, puis vérifier les analyses de lancement sur iOS. La personne choisit séparément si elle accepte la mesure d'usage ; la vérification Android aura sa propre preuve à la reprise.
- **Logiques ajoutées ou modifiées :** définition des déclencheurs et propriétés, identité anonyme, choix de mesure et retrait, attribution des ouvertures de rappel, distinction des environnements et prévention des doublons.
- **Résultat observable :** l'équipe suit l'activation, la consultation des recommandations, les ouvertures de services d'écoute et les retours ; elle connaît la population mesurée et ne confond pas clic d'écoute, notification acceptée par un fournisseur et écoute ou réception effective.

#### Tâches

Ancrages vérifiés sur main : `docs/track1-tracking-plan.md`, `mobile/src/analytics/provider.tsx`, `mobile/app/privacy-choice.tsx`, `mobile/test/analytics.test.ts` et `mobile/test/consent.test.tsx`. Cette partie conserve son démarrage avec les fondations ; le socle de collecte livré est réutilisé.

- [ ] TRA-286 **P5.1 — Définir les événements et les indicateurs track1** — `tier/1`. Créer `docs/track1-tracking-plan.md` selon la décision 6. Preuve : déclencheur, propriétés, déduplication, propriétaire et cas de recette pour chaque événement ; dénominateur défini pour chaque indicateur. **Dépendances : aucune.** Parallèle à P1.1.
- [x] TRA-314 **P5.2 — Mesurer les parcours uniquement selon le choix de la personne** — `tier/3`. Livré ; conserver le contrat typé, l'adaptateur Segment et le choix de mesure dans `mobile/src/analytics/`, `mobile/app/privacy-choice.tsx` et les réglages. Le choix reste indépendant du profil musical et disponible avant son onboarding. Preuve conservée : événement autorisé unique, propriété interdite filtrée, aucune émission avant accord, refus/retrait stoppant les envois et vidant la file, identité distincte du secret push, absence de configuration sans impact produit. **Dépendances : P1.3, P5.1.**
- [ ] TRA-315 **P5.3 — Relier Segment à Amplitude et vérifier les environnements iOS** — `tier/3`. Configurer sources/destination et consigner le mapping dans `docs/track1-tracking-plan.md`. Preuve : événements issus d'un build iOS dans la bonne destination interne ou production, `anonymousId` et `messageId` mappés, aucun double envoi direct. Le contrat conserve la propriété plateforme et sa compatibilité Android ; l'émission réelle Android est contrôlée dans P8.1. **Dépendances : P1.5, P5.2.** Accès aux comptes requis ; parallèle aux features.
- [ ] TRA-316 **P5.4 — Rendre les indicateurs du lancement iOS fiables et consultables** — `tier/1`. Ajouter `mobile/test/analytics-journeys.test.ts`, configurer les vues Amplitude et consigner liens/traces dans `docs/track1-tracking-plan.md`. Preuve iOS : tous les parcours produisent les événements attendus, refus respecté, décomptes vérifiés sur jeux de recette, environnements internes exclus et limites d'interprétation visibles ; filtre iOS explicite dans les indicateurs de lancement. **Dépendances : P3.9, P4.7, P5.3.** Les preuves de mesure Android rejoignent P8.1 ; la refonte revalide l'absence de doublons ou de pertes dans P6.5.

Déploiement autonome : le socle fonctionne même avec la collecte désactivée ; les événements sont livrés et testés au fil des features. La clôture de cette partie certifie la mesure avant publication.

### Partie 6 — Découvrir track1 avec une interface et des animations cohérentes

#### Description du milestone Linear

- **Objectif produit :** donner aux premiers utilisateurs iOS une expérience visuelle cohérente, lisible et agréable avant d'élargir les tests et de présenter track1 sur l'App Store.
- **Solution :** faire valider une référence de design utilisable par l'équipe, appliquer cette référence aux parcours existants, puis ajouter les animations décrites et vérifier l'ensemble sur iPhone.
- **Logiques ajoutées ou modifiées :** hiérarchie visuelle, présentation des choix et des contenus, états d'attente et d'erreur, retours d'action, transitions et comportement lorsque la réduction des animations est activée. Les règles de recommandation, de génération, de consentement et de rappel restent celles des parcours livrés.
- **Résultat observable :** chaque écran et état du périmètre correspond à une référence approuvée ; les parcours restent accessibles et mesurés correctement, avec une preuve sur iPhone. Les captures et la bêta élargie peuvent alors montrer l'expérience destinée à être publiée.

#### Tâches

Ancrages vérifiés sur main : `mobile/app/_layout.tsx`, `mobile/app/(tabs)/_layout.tsx`, `mobile/app/(tabs)/index.tsx`, `mobile/app/(tabs)/search.tsx`, `mobile/app/(tabs)/settings.tsx`, `mobile/app/onboarding.tsx`, `mobile/app/privacy-choice.tsx`, `mobile/app/node/[slug].tsx`, `mobile/src/generation/status.tsx`, `mobile/src/components/NodeArticle.tsx`, `NodeImage.tsx`, `NodeRelations.tsx`, `SearchResults.tsx`, `ArtistDetails.tsx`, `ProjectDetails.tsx`, `TrackDetails.tsx`, `GenreDetails.tsx` et `LabelDetails.tsx` (tous sous `mobile/src/components/`). Les styles sont aujourd'hui dans les routes et composants. Tests existants : `mobile/test/today.test.tsx`, `onboarding.test.tsx`, `consent.test.tsx`, `navigation.test.tsx`, `node-screen.test.tsx`, `search.test.tsx`, `generation.test.tsx`, `work-details.test.tsx` et `genre-label-details.test.tsx` (tous sous `mobile/test/`).

**Prérequis design absent au 28 septembre :** aucune spécification mobile UI/motion ni référence Figma n'a été trouvée dans l'inventaire vérifié. Raphael explore encore le workflow Figma/MCP. P6.1 organise la définition et le handoff ; il ne peut être clos avant validation de Raphael. P6.2 à P6.4 restent bloquées par ce livrable et ne peuvent pas compléter les choix visuels manquants. Les fichiers web ne servent pas de maquette mobile implicite.

- [ ] TRA-327 **P6.1 — Définir et faire valider le design des parcours et de leurs animations** — `tier/1`, tâche de définition/handoff, sans implémentation. Créer `docs/track1-design.md` et, si des exports sont fournis, `docs/design/track1/` sous `docs/` vérifié. Livrable : références versionnées consultables par l'implémenteur, liste exhaustive écrans/états, styles et assets autorisés, textes, règles de navigation, matrice des animations et réduction des mouvements, critères de comparaison et validation datée de Raphael. Chaque animation précise déclencheur, éléments concernés, durée, courbe, interruption et variante sans mouvement ; chaque asset indique sa source et ses droits d'usage. Les parcours couvrent choix de mesure, goûts, Aujourd'hui, fiches des cinq types, relations, recherche, génération, réglages et états vides/chargement/erreur/hors réseau. **Preuve :** aucune case de cette matrice sans référence ou décision explicite ; aucun placeholder visuel ou paramètre à deviner. Un lien Figma inaccessible seul ne clôture pas le handoff : des exports et une description versionnée rendent les spécifications lisibles. **Dépendances : P1.3.** Définition parallélisable avec les tâches fonctionnelles ; l'accès aux décisions/design de Raphael est l'entrée nécessaire, sans imposer Figma ou MCP.
- [ ] TRA-328 **P6.2 — Appliquer le design au premier lancement et à la découverte du jour** — `tier/2`, bloquée par P6.1. Modifier les routes de navigation, `mobile/app/privacy-choice.tsx`, `mobile/app/onboarding.tsx` et `mobile/app/(tabs)/index.tsx` ; créer `mobile/src/ui/` pour les valeurs et éléments visuels partagés, parent `mobile/src/` vérifié. Étendre les tests existants de navigation, consentement, onboarding et Aujourd'hui. **Preuve :** écrans/états conformes au handoff, valeurs partagées réutilisées, texte agrandi et lecture VoiceOver conservés, refus de collecte/push toujours utilisables, recommandation et événements inchangés. **Dépendances : P6.1, P3.3, P3.8, P5.2.** Aucun changement des règles de collecte, stockage ou recommandation ; un besoin de les modifier impose un amendement de portée et du tier.
- [ ] TRA-329 **P6.3 — Appliquer le design aux fiches, à la recherche et aux réglages** — `tier/2`, bloquée par P6.1. Modifier les routes fiche/recherche/réglages et les composants existants nommés ci-dessus, ainsi que `mobile/src/generation/status.tsx`. Réutiliser les éléments partagés introduits par P6.2 ; étendre les tests de fiche, recherche, génération et détails par type. **Preuve :** chaque type et chaque état de la matrice validée possède une représentation testée ; liens d'écoute, relation, génération explicite, reprise hors réseau et réglages conservent leurs actions et annonces accessibles. Le refus/retrait de mesure et la purge déjà livrée restent couverts. **Dépendances : P6.2, P4.1, P4.2, P4.4, P4.5, P4.6.** Aucun travail sur le web ou sur le schéma musical.
- [ ] TRA-330 **P6.4 — Appliquer les animations validées avec une variante accessible** — `tier/2`, bloquée par P6.1. Compléter les éléments partagés dans `mobile/src/ui/` et leurs raccordements aux routes existantes ; créer `mobile/test/motion.test.tsx`. **Preuve :** seules les animations de la matrice validée sont présentes ; leur interruption ou répétition ne bloque aucune action et ne produit ni double navigation ni double événement. La réduction des mouvements applique la variante prévue ; démontage, retour arrière et passage en arrière-plan nettoient les transitions. Tests des états, interruptions et variantes, plus captures vidéo sur iPhone. **Dépendances : P6.2, P6.3.** Utiliser les capacités natives et de navigation déjà disponibles ; aucune nouvelle bibliothèque n'est autorisée par ce ticket.
- [ ] TRA-331 **P6.5 — Valider l'interface finale et ses animations sur iPhone** — `tier/1`. Créer `docs/track1-design-qa.md` avec les références approuvées, le build testé et les preuves ; réutiliser les recettes `mobile/e2e/daily-discovery.yaml` et `mobile/e2e/exploration.yaml`, puis tracer le résultat dans `docs/track1-release.md`. **Preuve :** matrice design entièrement contrôlée, écarts bloquants résolus, VoiceOver, texte agrandi et réduction des mouvements vérifiés sur iPhone physique ; parcours quotidien, recherche, génération, liens profonds, consentements et événements repassent sur ce build. Une compilation Android interne sur le même code fournit une preuve de compatibilité, distincte de la QA Android non exécutée. **Dépendances : P6.4, P3.9, P4.7, P5.4.** Cette recette transverse est le gate explicite avant captures définitives et TestFlight élargi. Un test en échec entraîne une correction avec preuve, sans effacer les validations historiques des tickets Done.

Déploiement autonome : chaque intégration peut rejoindre les builds internes sans modifier les contrats métier ou serveur ; la fin de partie fournit l'expérience de référence pour la diffusion iOS. Le handoff documentaire seul ne vaut pas validation de l'application.

### Partie 7 — Mettre track1 entre les mains des premiers utilisateurs iOS

#### Description du milestone Linear

- **Objectif produit :** publier une première version fiable et compréhensible de track1 sur l'App Store dès que ses critères iOS sont satisfaits.
- **Solution :** présenter l'interface finale, expliquer les données utilisées, distribuer une bêta TestFlight élargie puis publier le build iOS validé.
- **Logiques ajoutées ou modifiées :** passage des tests internes à la bêta puis à la production, gestion des versions et preuves iOS, cohérence des captures et des déclarations de confidentialité avec l'application réellement livrée.
- **Résultat observable :** track1 est téléchargeable depuis l'App Store ; son parcours quotidien, ses push, sa génération et sa mesure ont été vérifiés sur le candidat publié. Aucun prérequis Android ne retarde cette sortie.

#### Tâches

Ancrages vérifiés : `docs/`, `src/server.ts`, `mobile/app/(tabs)/settings.tsx` et `docs/track1-builds.md`. Livrables à créer s'ils ne sont pas déjà livrés par une tâche précédente : `docs/track1-privacy.md`, `docs/track1-release.md`, `mobile/store/ios/` et `mobile/e2e/`, dans les parents `docs/` et `mobile/` vérifiés. Les cinq tickets existants gardent leur ID, leur tier et leur historique ; leurs anciennes références P6.1–P6.5 deviennent P7.1–P7.5.

- [ ] TRA-317 **P7.1 — Publier la politique de confidentialité dans l'app et par URL** — `tier/3`. Créer `docs/track1-privacy.md`, la route mobile dédiée dans `src/server.ts` et le lien des réglages. Preuve : données/services/choix/durées/contact réels, cohérence avec profil local/push/analytics et déclarations App Store, contenu approuvé accessible sans compte en HTTPS, site inchangé. **Dépendances : P3.8, P5.3.** Les contenus peuvent être préparés en parallèle de la refonte ; le lien final est recontrôlé dans la bêta. Les déclarations Google Play restent dans P8.2.
- [ ] TRA-318 **P7.2 — Préparer la présentation de track1 sur l'App Store** — `tier/1`. Créer `mobile/store/ios/` avec textes, icônes approuvées et captures réelles du build validé en P6.5 ; consigner la provenance et la version dans `docs/track1-release.md`. Preuve : présentation de la découverte quotidienne et de l'écoute externe conforme au produit, captures couvrant les formats requis au moment de la soumission et reproduisant l'interface finale. **Dépendances : P6.5.** Parallèle à P7.1 et P7.3 ; préparation Google Play transférée à P8.2.
- [ ] TRA-319 **P7.3 — Distribuer la bêta iOS dans TestFlight** — `tier/3`. Consigner le build, son SHA, le groupe TestFlight élargi et les résultats dans `docs/track1-release.md`. Preuve : installation signée, démarrage et push réellement reçu avec les identifiants iOS du candidat ; interface finale présente, confidentialité accessible et mesure vérifiée dans le bon environnement. **Dépendances : P6.5, P7.1.** Aucun compte Google ni test Android requis ; la distribution Android de l'ancien contrat rejoint P8.2. Les builds internes nécessaires avant P6.5 restent couverts par TRA-290.
- [ ] TRA-320 **P7.4 — Valider la bêta iOS et décider sa publication** — `tier/1`. Ajouter ou compléter `mobile/e2e/resilience.yaml`, `docs/track1-release.md` et le registre de préparation `docs/track1-release-readiness.md` prévu au manifeste initial. Preuve sur le candidat iOS : hors réseau, crédits épuisés, redémarrage pendant génération, token invalide, mesure refusée et liens indisponibles testés ; versions/appareils/preuves, mesure et exigences App Store vérifiées, aucun échec bloquant, décision opérationnelle go/no-go et autorisation préalable de Raphael consignées. Aucun nouvel accord par publication ni validation personnelle du build supposée. Un échec appelle une correction traçable sans convertir une preuve ancienne en preuve du nouveau build. **Dépendances : P5.4, P7.2, P7.3.** Matrice Android marquée différée et transférée à P8.3 ; absence de preuve Android sans effet sur cette décision iOS.
- [ ] TRA-321 **P7.5 — Publier track1 sur l'App Store** — `tier/3`. Soumettre le build iOS validé et suivre son statut dans `docs/track1-release.md`. Preuve : fiche publique, version installable et lien de sortie consignés ; une soumission seule ne clôture pas la tâche. **Dépendances : P7.4.** Accès Apple requis. Toute nouvelle version imposée après la bêta revalide les contrôles affectés avant soumission.

Déploiement autonome : TestFlight puis App Store, avec backend compatible et possibilité de maintenir les versions de test pendant la review Apple. La sortie iOS est déclarée livrée quand ses critères sont remplis, même si les tickets Android restent ouverts en attente.

### Partie 8 — Ouvrir track1 aux utilisateurs Android lors de la reprise

#### Description du milestone Linear

- **Objectif produit :** conserver une voie de publication Android complète sans en faire un préalable à l'arrivée de track1 sur iPhone.
- **Solution :** maintenir le code compilable, puis reprendre séparément la validation sur téléphone Android, la préparation Google Play, la bêta et sa publication quand Raphael décide de réactiver ce travail.
- **Logiques ajoutées ou modifiées :** preuves de réception des rappels et de mesure propres à Android, retour système, accessibilité TalkBack, exigences du compte Google et décision de publication Android distincte de celle d'iOS.
- **Résultat observable :** pendant l'attente, aucun critère Android non exécuté n'est marqué réussi ; après reprise et recette complète, la version Android peut être distribuée puis publiée sans remettre en cause la disponibilité iOS.

#### Tâches

**État prévu : en attente de reprise explicite, non bloquant pour les parties 1 à 7.** Aucune date inventée. Les huit nouvelles tâches du plan, y compris ces trois tâches de reprise, seront transcrites seulement après validation ; TRA-322 sera déplacé, pas recréé. Ancrages vérifiés : routes et tests mobiles des parties 1 et 6, `docs/track1-builds.md`, `docs/track1-tracking-plan.md`. Recettes et documents `mobile/e2e/`, `docs/track1-release.md` et `docs/track1-design-qa.md` seront produits par les parties précédentes ; `mobile/store/android/` est à créer dans `mobile/` vérifié.

- [ ] TRA-332 **P8.1 — Vérifier les parcours, les push et la mesure sur Android physique** — `tier/3`, en attente. Préparer les credentials Android nécessaires au push réel dans les services autorisés, ajuster `mobile/app.config.ts`/`mobile/eas.json` si nécessaire, puis réutiliser les recettes quotidiennes et d'exploration. Documenter les preuves dans `docs/track1-builds.md`, `docs/track1-design-qa.md`, `docs/track1-release.md` et `docs/track1-tracking-plan.md`. Preuve : credentials Expo/FCM réellement configurés sans secret versionné, installation et navigation, goûts → recommandation → écoute, réception réelle du push à chaud/froid/arrière-plan, refus et désactivation, changement de fuseau/token, cinq types, recherche/génération, liens profonds, retour système, TalkBack, texte agrandi, réduction des mouvements, cache et reprise ; 17 événements Android dans Segment et Amplitude, identités/déduplication, refus/retrait/accord tardif et indicateurs filtrés Android contrôlés. **Dépendances : P1.5, P2.7, P3.7, P6.4, P5.3.** Tier/3 pour la configuration native et les credentials, pas pour le seul rapport de recette. Reprend les critères physiques Android de TRA-290, TRA-305, TRA-306, TRA-311, TRA-313, TRA-315 et TRA-316, en conservant aussi les tests partagés de navigation/relations déjà livrés ; une compilation ou une preuve iOS ne les satisfait pas. L'accès Firebase/FCM éventuellement nécessaire appartient à cette reprise, sans imposer Play Console avant P8.2.
- [ ] TRA-333 **P8.2 — Préparer Google Play et distribuer la bêta Android** — `tier/3`, en attente. Compléter `docs/track1-builds.md`, `docs/track1-release.md` et créer `mobile/store/android/`. Preuve : accès Play Console et signature réels, exigences de test applicables au compte vérifiées à la reprise, textes/captures de la version finale, déclarations de données cohérentes, liens de confidentialité depuis réglages/consentement fonctionnels, build de test installable depuis la piste retenue et push reçu sur cet artefact signé. **Dépendances : P8.1, P7.1.** Reprend les éléments Android de TRA-317, TRA-318 et TRA-319 ; aucun besoin d'accès Play Console en amont de cette tâche.
- [ ] TRA-334 **P8.3 — Valider la bêta Android et décider sa publication** — `tier/1`, en attente. Exécuter `mobile/e2e/resilience.yaml` sur le candidat Android, compléter `docs/track1-release.md`, `docs/track1-release-readiness.md` et les preuves de mesure. Preuve : mêmes scénarios de résilience que TRA-320 exécutés sur Android, conformité design/accessibilité et fonctionnement des consentements conservés, aucun échec bloquant, exigences Google vérifiées, décision opérationnelle go/no-go et autorisation préalable consignées. **Dépendances : P8.2.** Reprend la partie Android de TRA-320 ; le verdict iOS ne vaut pas verdict Android, et la reprise ne crée pas de nouvel accord à demander par soumission.
- [ ] TRA-322 **P8.4 — Publier track1 sur Google Play** — `tier/3`, en attente ; ancienne référence P6.6. Soumettre le build Android validé et suivre son statut dans `docs/track1-release.md`. Preuve : fiche publique et version installable, exigences du compte satisfaites, version et lien consignés. **Dépendances : P8.3**, en remplacement de l'ancienne dépendance commune TRA-320. Une soumission seule ne clôture pas la tâche.

Déploiement autonome : après réactivation, la bêta et la publication Android utilisent le produit partagé déjà livré. Un refus Google ou un test Android en échec bloque uniquement cette partie ; il ne retire aucune validation iOS et ne rouvre pas sa sortie.

## Lexique

- **Projet musical** : album, EP ou single, distinct d'un morceau ; c'est le type `project` déjà utilisé par Odyssey.
- **Nœud** : fiche d'un artiste, projet, morceau, genre ou label dans le graphe musical.
- **API** : accès réseau que l'application utilise pour demander des données ou une génération au serveur.
- **Push** : notification envoyée par le serveur via les services d'Apple ou de Google, même lorsque track1 n'est pas ouverte.
- **Lien profond** : lien qui ouvre directement une destination de l'application.
- **Segment / Amplitude** : Segment reçoit les événements d'usage définis par le projet ; Amplitude permet de les analyser.
- **Tier** : niveau de risque qui fixe les exigences de review ; tier/3 exige une preuve de review IA approfondie du SHA final vérifiée dans le check GitHub requis, puis un merge automatique après tous les contrôles, sans accord humain.
- **Handoff design** : dossier versionné qui décrit les écrans, leurs états, les assets et les animations approuvés, avec assez de précision pour les intégrer sans inventer les choix visuels.
- **TestFlight** : canal Apple de distribution des versions de test iOS avant leur publication sur l'App Store.
- **UI / motion** : présentation de l'interface et animations entre ses états ; le plan les traite comme des comportements accessibles à spécifier et à vérifier.

## Décisions techniques

Les six décisions du plan initial sont conservées. La décision 1 précise l'ordre de sortie et la décision 5 encadre la refonte ; les autres contrats produit restent inchangés.

### 1. Un sous-projet Expo partagé, avec une première sortie iOS autonome

**Choix retenu :** conserver `mobile/` avec son propre `package.json` et lockfile npm, TypeScript strict, Expo Router et Expo SDK 57 / React Native 0.86. La CI mobile utilise Node 22, version minimale 22.13 ; le backend garde sa configuration Node 20. Versions de patch compatibles verrouillées à l'initialisation, sans versions canary. Les projets natifs générés `ios/` et `android/` ne sont pas committés. Vérification mobile : Biome, TypeScript, Jest avec `jest-expo` et Testing Library React Native ; recettes sur appareils avec Maestro, sans remplacer Vitest côté serveur.

**Ordre de publication tranché : iOS d'abord.** Garder une seule application Expo et les configurations des deux plateformes. La capacité à construire Android est maintenue : build APK existant conservé dans TRA-290, puis compilation native interne du candidat final dans P6.5, à renouveler si une modification native affecte ce candidat. Aucun compte Play Console ni appareil Android n'est nécessaire pour ces preuves. Les contrôles JS/TypeScript seuls ne sont pas présentés comme une preuve de compilation native. Les tests physiques Android, ses credentials de publication et sa QA restent en partie 8, sans dépendance vers les gates iOS. Les éventuelles corrections de code partagé conservent leurs tests sur les deux configurations ; une adaptation iOS ne supprime pas une branche Android pour faire passer les contrôles.

**Alternative rejetée pour le lancement :** conserver une décision de sortie unique iOS/Android. Elle ferait attendre l'iPhone pour un appareil ou un compte Google sans apporter de preuve supplémentaire sur iOS. Un fork de code iOS séparé est également rejeté : il compliquerait la reprise Android. La fin du lancement iOS est enregistrée séparément ; les tâches Android restent ouvertes, en attente, avec leurs critères non exécutés.

Dépendances prévues dès P1.2 : socle Expo/React/React Native/Expo Router et ses dépendances natives de navigation, `expo-dev-client`, `expo-image`, `expo-linking`, `expo-crypto`, `expo-secure-store`, `expo-notifications`, `expo-device`, `expo-constants`, `expo-localization`, `@react-native-async-storage/async-storage`, `zod` et les outils de tests. P5.2 ajoute `@segment/analytics-react-native`, `@segment/sovran-react-native`, `react-native-get-random-values`. Pas de SDK audio, de SDK Spotify/Apple Music ou de SDK Amplitude embarqué. Le serveur utilise ses dépendances existantes et `fetch` pour Expo.

Nom public : **track1**. Proposition d'identifiants du plan initial : `com.dropcliffs.track1`, suffixe `.preview` pour la distribution interne distincte ; schéma `track1://`. Les identifiants réels déjà vérifiés dans TRA-290 sont repris sans recréer d'app ni de projet Expo. L'appartenance et la disponibilité sont vérifiées avant signature. Expo/Apple sont nécessaires au chemin iOS ; les accès Google Play et credentials propres à la distribution Android sont des prérequis de P8.2, pas du lancement iOS. Aucun identifiant de compte ou secret n'est inventé dans le dépôt.

**Alternative rejetée :** convertir la racine en monorepo à workspaces et migrer le backend en même temps. Cela ajouterait du travail sans bénéfice produit demandé et augmenterait le risque sur le déploiement existant. Expo Go seul est également insuffisant pour valider les intégrations natives retenues. [Matrice Expo actuelle](https://docs.expo.dev/versions/latest/), [compatibilité Segment React Native](https://www.twilio.com/docs/segment/connections/sources/catalog/libraries/mobile/react-native).

**Dimensionnement déjà autorisé :** les lockfiles npm, y compris `mobile/package-lock.json`, fichiers générés et assets sont décomptés séparément avec chemins et provenance ; les dépendances restent examinées et leur installation vérifiée. Le code de scaffold maintenu et les tests écrits restent comptés. Les repères 300–800 lignes pour les features mobiles et 200–400 pour les changements sensibles guident le découpage ; dépasser 1 000 lignes ou 20 fichiers écrits entraîne un réexamen documenté, pas un arrêt automatique. Les reviews approfondies automatisées `tier/3` sont conservées, sans gate humain de merge. **La CI actuelle garde son ancien comportement tant que P1.1 n'est pas livré** : modifier les consignes ne change pas les checks. TRA-285 rend la review profonde obligatoire dans `review-gate` déjà requis : risque du diff immuable avant tout succès, review ordinaire conservée et preuve Sol/high distincte du même SHA. Supprimer le désarmement systématique ne rend donc pas la classification tardive contournable. L'interdiction de toucher `review-gate.yml` est levée pour ce seul verrou ; protections, modèles et workflow IA restent inchangés. Garder PR #278 désarmée pendant la transition avant preuve du verrou. Une escalade purement manuelle après gate vert nécessite d'abord de suspendre l'auto-merge puis de vérifier une nouvelle exécution bloquante ; un simple événement de label n'est pas atomique. Aucun test supprimé pour tenir un volume, aucun `--admin` ni nouvel accord humain.

### 2. Une façade mobile additive, et une génération publique explicite

**Choix proposé :** ajouter `/mobile/v1` sous l'API existante, soit la base configurée `https://dropcliffs.com/api/odyssey/mobile/v1`. Le contrat mobile réutilise les identités, faits, relations, redirections et résolveurs existants ; il ne modifie ni `src/schemas.ts`, ni les formats des nœuds sur disque, ni les anciennes routes.

Contrats à figer dans P2.1 :

| Accès mobile | Comportement retenu |
| --- | --- |
| `GET /catalog` | Métadonnées des cinq types et relations nécessaires aux goûts/recommandations, sans articles ni citations ; révision stable et `ETag` pour éviter de retransférer un contenu inchangé. |
| `GET /nodes/:slug` | Fiche projetée à partir du cache, identité canonique et alias éventuel ; `404` si absente ; aucune génération ou actualisation par le modèle. |
| `GET /search?q=&type=&limit=` | Réutilisation de la recherche existante : 2 à 120 caractères, types contrôlés, limite 8 par défaut et 25 maximum ; distinction disponible/à créer. |
| `GET /nodes/:slug/image` et `/links` | Réutilisation des services d'images et liens ; valeurs nulles normales ; aucune exposition des routes de streaming dans le client mobile. |
| `POST /generations` | Identifiant UUID de demande et identité musicale existante (`type`, `name`, puis `slug`, `mbid`, `qid`, `disambiguator` si connus) ; retour `202` avec identifiant de suivi. Un doublon reprend la demande existante. |
| `GET /generations/:id` | État en attente, en cours, réussi avec slug canonique, échoué ou interrompu ; `410` pour un suivi expiré. |

La génération reste accessible à tous, sans compte et sans quota utilisateur. Garde-fous limités à la stabilité : entrée validée, corps borné à 8 Kio, deux générations simultanées et dix demandes en attente maximum ; saturation en `429` avec nouvelle tentative explicite. Le résultat disponible en cache est renvoyé avant tout appel payant. Le mobile ne propose pas `fresh=1`. Un cache déjà ancien reste consultable ; les actualisations existantes du web continuent de fonctionner.

Un petit registre de demandes est conservé hors Git et hors `cache/`, via `MOBILE_STATE_DIR` : `/var/lib/track1-mobile` en production, `.runtime/mobile` ignoré localement. Il garde les états terminaux 24 h, avec 1 000 entrées terminales maximum. Un redémarrage marque les demandes inachevées comme interrompues, sans relancer leur coût ; une nouvelle action vérifie d'abord si la fiche a finalement été écrite. L'app conserve l'identifiant avant l'envoi, suit l'état toutes les 2 secondes uniquement au premier plan et reprend ce même suivi au retour.

Les erreurs mobiles comportent un code stable et un message public : entrée invalide, absent, occupé, fournisseur indisponible, crédits/quota fournisseur épuisés, interrompu, erreur interne. Les limites de crédits ne sont pas estimées par l'application : les erreurs du fournisseur sont normalisées et les fiches existantes restent consultables. Aucun texte brut d'erreur fournisseur ou secret n'est renvoyé. Le choix assumé de clés à crédits limités reste le contrôle du coût ; aucune refonte anti-abus n'est ajoutée.

**Alternative rejetée :** brancher le mobile directement sur toutes les routes actuelles. `GET /node/:slug` peut aujourd'hui actualiser une fiche de plus de 12 h avec un appel au modèle, et `/materialize` attend la fin de la génération sur la connexion HTTP. Une façade additive évite ces effets et les attentes fragiles sur réseau mobile, sans changer le comportement web.

### 3. Reprendre la recommandation existante, calculée sur le téléphone

**Choix proposé :** goûts limités aux genres, comme la logique web réutilisable. Au moins trois genres pour terminer l'onboarding ; si le catalogue en propose moins, tous les genres disponibles suffisent ; si aucun n'est disponible, proposer de réessayer ou d'accéder à Recherche sans profil. Aucun nom, email ou compte. Les réglages permettent de modifier les genres et d'effacer les données locales ; la permission push et la mesure sont deux choix indépendants.

La recommandation porte sur les artistes, projets et morceaux existants, jamais sur les genres ou labels. Reprise des scores web : +3 par genre direct, +1 par genre proche (`subgenres`/`related_genres`), +4 pour une œuvre repère du genre sélectionné, +3 pour un artiste repère. Trier par score puis slug ; retenir les 60 premiers. Un tirage déterministe utilisant un identifiant aléatoire local et la date locale parcourt ce groupe, en excluant les 40 dernières propositions quand possible. Si toutes ont été vues, commencer un nouveau cycle ; sans candidat, expliquer l'absence et proposer de modifier les genres ou de rechercher. Aucun appel au modèle pour choisir une recommandation.

La proposition et sa courte explication sont persistées au premier affichage du jour. Une actualisation du catalogue ne la remplace pas ; un changement de goûts la recalcule explicitement. Le prochain jour est la date civile locale du téléphone. En cas de changement de fuseau, une date déjà visitée reprend sa sélection, et les dates consultées sont conservées avec l'historique. Pas de bouton « une autre » dans cette V1 : la promesse reste une découverte du jour. Les goûts et l'historique ne sont pas envoyés au serveur.

Le catalogue est un export léger construit depuis le cache serveur actuel, pas une copie du fichier web généré. La cartographie a trouvé environ 1 384 fichiers de nœuds et un bundle web d'environ 6,2 Mio, plus ancien que le cache : retirer les articles de la synchronisation initiale évite de télécharger cette masse pour calculer une affinité.

**Alternative rejetée :** recommander côté serveur avec un profil persistant, ou générer une nouvelle œuvre personnalisée par IA chaque jour. Ces options ajoutent comptes ou stockage de goûts, coût et indisponibilités, alors que la logique et les contenus nécessaires existent déjà.

### 4. De vraies notifications push, génériques et facultatives

**Choix proposé :** `expo-notifications` sur le téléphone et Expo Push Service depuis le serveur. Proposition produit : invitation après le premier affichage de recommandation, 9 h locale, titre « track1 — Ta découverte du jour », corps fixé dans la solution haut niveau, sans nom d'artiste ni goût dans le message. Le payload ouvre Aujourd'hui et contient un identifiant de notification et la date cible ; une notification ancienne ouvre la recommandation du jour courant. Aucun calcul en arrière-plan sur le téléphone n'est requis.

Un abonnement anonyme contient uniquement un identifiant opaque, un secret d'abonnement haché côté serveur, le jeton Expo, la plateforme, le fuseau IANA, l'état d'activation et les dates techniques d'envoi/activité. Le secret est conservé dans SecureStore ; il autorise mise à jour et désinscription, sans devenir un compte. Les goûts restent locaux. L'inscription prend effet le lendemain ; le fuseau et le jeton sont remis à jour à l'ouverture de l'app. Après un voyage sans réouverture, le dernier fuseau connu reste utilisé. Un abonnement inactif depuis 90 jours est supprimé ; un token déclaré invalide est désactivé immédiatement.

Le process serveur existant examine les rappels chaque minute. Fenêtre d'envoi : 9 h à 10 h locale, puis abandon du rappel de ce jour. Réserver durablement la date avant l'envoi prévient les doublons applicatifs après un redémarrage ; un résultat réseau ambigu n'est pas réenvoyé. Les retours Expo sont consultés après environ 15 minutes ; absence de retour bornée à 24 h. L'objectif est un rappel utile, pas une garantie d'exactement une livraison : Apple, Google et Expo peuvent retarder, omettre ou dupliquer une notification. La recommandation reste disponible depuis l'app. [Fonctionnement et retours Expo Push](https://docs.expo.dev/push-notifications/sending-notifications/).

**Alternative rejetée :** un simple rappel local, qui ne réalise pas la demande de push serveur dès la V1 ; et une intégration directe séparée APNs/FCM, plus lourde pour ce besoin. Un push personnalisé avec le nom de la découverte imposerait de partager les goûts ou de préparer la recommandation ailleurs que sur le téléphone.

### 5. Une interface native refondue à partir d'un design validé, sans changer les parcours

**Choix proposé :** navigation Expo Router, fiches natives et relations en listes/cartes. Les articles sont rendus en texte natif lisible avec paragraphes et listes ; aucun HTML tiers n'est exécuté. Les différences des cinq types viennent des faits et relations existants, sans enrichissement du schéma. Images chargées avec `expo-image`, remplacement visuel si absent ou en erreur.

**Refonte tranchée :** séparer la définition/handoff P6.1 de l'intégration P6.2–P6.4, puis imposer P6.5 avant les captures finales, TestFlight élargi et la soumission. `docs/track1-design.md` est la source versionnée des règles approuvées et de leurs références, quel que soit l'outil choisi par Raphael pour produire le design. L'accès Figma/MCP peut faciliter la lecture mais n'est pas une dépendance d'exécution obligatoire ; les références exportées et leurs descriptions doivent suffire. À ce stade, palette, typographies, compositions, durées et courbes d'animation restent **absentes et bloquantes pour l'intégration** : ce plan n'invente aucune de leurs valeurs.

Centraliser les valeurs visuelles et comportements de mouvement dans `mobile/src/ui/` au fil de P6.2/P6.4 ; les parcours continuent à appeler les services et contrôles existants. Utiliser Expo Router et les API natives de React Native déjà disponibles pour les animations décrites. Reanimated apparaît dans le lockfile mais n'est pas une dépendance directe déclarée : sa présence indirecte n'autorise pas son import. Si un design exige une nouvelle bibliothèque, son besoin, sa version et son tier doivent être ajoutés à la portée avant implémentation ; aucun ajout de dépendance tacite. Les critères de fluidité et le jeu d'appareils de référence sont fixés dans le handoff avant recette, sans annoncer un objectif de performance non défini.

**Alternative rejetée pour le design :** laisser chaque implémenteur déduire l'apparence d'une capture, d'un fichier web ou d'une bibliothèque choisie par défaut ; cela produit des écarts impossibles à arbitrer sans nouvelle interprétation. Réaliser les captures publiques ou élargir TestFlight avant cette refonte est également rejeté : les testeurs et la présentation du store doivent porter sur l'expérience destinée à sortir. Les builds internes restent disponibles pour construire et vérifier le design.

Écoute : URL HTTPS exacte du résolveur privilégiée, seulement vers les hôtes Spotify/Apple Music autorisés. À défaut, recherche officielle préremplie depuis le nom et l'artiste connus, clairement libellée « Rechercher sur… ». Pour genres et labels, pas de bouton d'écoute trompeur. Le système ouvre l'app du service si disponible, sinon son site ; un échec est montré et ne constitue pas une écoute mesurée.

Liens profonds V1 : `track1://today` et `track1://node/<slug encodé>`. Slug et destination validés, navigation différée après onboarding, retour d'un alias vers sa fiche canonique. Une fiche absente ouvre un état explicite, jamais une génération silencieuse. Les Universal Links/App Links HTTPS ne sont pas requis en V1 : ils impliquent une association de domaine hors de ce dépôt et ne sont pas nécessaires au parcours push retenu.

Stockage local : profil et recommandation persistés dès la partie 3 ; catalogue rafraîchi au premier plan au plus toutes les 6 h, et après une génération réussie. La partie 4 ajoute les 50 dernières fiches consultées, en protégeant celle du jour ; fraîcheur de lecture 24 h, revalidation en ligne sans retirer une fiche déjà affichée. Hors réseau, présenter la version locale et sa date ; recherche locale dans le catalogue, génération indisponible et recherche externe explicitement suspendue. L'absence de cache initial affiche une reprise réseau. L'effacement du profil remet à zéro goûts et historique. Les réglages de push et de mesure restent séparés : une désinscription push hors réseau est conservée comme action à réessayer, sans annoncer une suppression serveur déjà faite.

**Alternative rejetée :** embarquer le site dans une WebView ou construire une visualisation graphique complète du réseau. Le premier conserve les contraintes du web et son lecteur ; la seconde ajoute une interaction non demandée. La liste de relations réalise l'exploration sur petit écran avec une navigation testable et accessible.

### 6. Segment vers Amplitude, conçu avant les features

**Choix proposé :** une seule collecte mobile via Segment React Native, destination **Amplitude Actions en cloud mode**, environnements internes et production séparés. Aucun SDK Amplitude supplémentaire. Le contrat d'événements est écrit dans P5.1 avant les écrans ; les tickets de features ajoutent leurs appels et vérifient leurs déclencheurs dans leurs propres tests. [Intégration Segment–Amplitude](https://www.amplitude.com/docs/data/source-catalog/segment).

Le choix de mesure est distinct du push, désactivé tant qu'aucun accord n'a été donné. Refuser laisse toutes les fonctionnalités accessibles. Utiliser un `anonymousId` aléatoire propre à la mesure, sans `identify` de compte, ID publicitaire, email, jeton push, texte de recherche ou profil de genres. Désactiver la collecte automatique superflue et filtrer les propriétés avant envoi. Un retrait arrête les envois et vide la file ; il ne prétend pas effacer rétroactivement les données déjà reçues. La politique explique ce point et le contact pour une demande d'effacement. Les write keys de collecte Segment sont une configuration publique d'application ; les clés du modèle, secrets push et clés d'administration restent côté serveur ou dans les comptes concernés.

Événements prévus : `app_opened`, `onboarding_started`, `onboarding_completed`, `preferences_updated`, `daily_recommendation_viewed`, `daily_recommendation_opened`, `notification_permission_result`, `notification_opened`, `node_viewed`, `relation_opened`, `search_submitted`, `search_result_opened`, `generation_requested`, `generation_completed`, `generation_failed`, `external_listening_opened` et `external_listening_failed`. Définir l'accord de mesure avant l'onboarding musical pour mesurer ce parcours chez les personnes consentantes, sans événement rétroactif en cas d'accord tardif.

Propriétés communes : version du schéma d'événement, plateforme, version/build, environnement, identifiant d'événement et origine du parcours. Ajouter seulement les propriétés utiles : identifiant/type public de fiche, identifiant de recommandation/date locale, fournisseur d'écoute, statut/code d'erreur, identifiant de génération ou notification, nombre de goûts/résultats, filtre de recherche. Jamais le secret d'abonnement. Une impression de recommandation est émise une fois par sélection quotidienne effectivement affichée ; une ouverture de notification une fois par identifiant ; un état terminal de génération une fois par demande. `messageId` est conservé vers `insert_id` Amplitude. Refus de mesure : pas de file préconstituée à envoyer plus tard.

Indicateurs de lancement : achèvement de l'onboarding parmi les débuts mesurés ; ouverture d'une fiche et d'un service d'écoute après exposition à la recommandation ; retour à J1/J7 parmi les personnes mesurées ; parcours issus des ouvertures de notification ; succès/échec des générations observées. La population de lancement est explicitement iOS en production ; les données internes sont exclues, et Android n'entre dans sa propre lecture qu'après sa recette. La refonte garde les déclencheurs et la déduplication ; ses animations ne créent aucun événement produit supplémentaire. Le clic d'écoute ne prouve pas une lecture audio. Sans remontée individuelle d'envoi liée à l'identité analytics, ne pas calculer un taux « ouvert/reçu » des push ; les logs techniques d'envoi restent séparés. Pas d'objectif chiffré de rétention inventé : la V1 établit la mesure de départ. Pas d'analyse de durée de session native dans ce périmètre.

**Alternative rejetée :** installer simultanément deux SDK de collecte, ou instrumenter tout le produit après les features. Le premier risque les doublons et des identités divergentes ; le second rend les parcours difficiles à reconstruire et retarde la vérification de leur valeur.

## Risques

| Risque concret | Garde-fou et limite assumée |
| --- | --- |
| Les crédits sont épuisés par des générations publiques. | Risque accepté dans le brief ; clés à crédits limités, pas de génération implicite mobile, concurrence bornée, erreur propre et lecture du cache maintenue. Pas de promesse d'absence d'abus. |
| Une génération continue après perte réseau ou fermeture de l'app. | Demande persistée avant envoi, suivi asynchrone, reprise du même identifiant et vérification du cache ; pas de relance payante automatique. |
| Le serveur redéploie ou perd son état mobile. | État hors répertoire synchronisé et hors cache musical, écritures atomiques, recette de redémarrage. Le MVP conserve l'exploitation mono-instance existante ; le multi-serveur nécessiterait un autre stockage. |
| Le catalogue offre peu de choix pour certains goûts. | Reprendre les règles explicables, borner les répétitions, prévoir le cas vide et offrir recherche/changement de genres ; aucune génération de qualité musicale supposée. |
| Une notification arrive tard, deux fois ou pas du tout. | Fenêtre bornée, état d'envoi durable, invalidation des jetons, lien vers Aujourd'hui courant ; disponibilité du produit indépendante du push. |
| Le profil « sans compte » est compris comme « aucune donnée ne quitte le téléphone ». | Explication distincte du profil local, des jetons/fuseaux nécessaires aux push et de la mesure facultative ; aucun goût stocké au serveur. |
| Une nouvelle route affecte le site ou son lecteur. | Routes additives, tests de compatibilité, aucun changement de `web/index.html`, `web/data.json` ou des routes audio existantes. |
| Les informations ou URL musicales externes sont inexactes. | Validation des types et hôtes, sources visibles, images facultatives, recherche d'écoute de secours annoncée ; pas de confiance implicite dans les réponses tierces. |
| Une identité de store, une clé de signature ou un accès manque. | P1.5 vérifie Expo/Apple et la construction Android ; P5.3 vérifie Segment/Amplitude ; P7.1 réclame les coordonnées réelles de l'éditeur. Les accès Google Play restent requis en P8.2 seulement. Aucun identifiant factice destiné à la production. |
| La review Apple ou les exigences du compte empêchent une publication immédiate. | Contrôle des règles applicables à la soumission, bêta et décision de publication distinctes ; la première sortie est clôturée à disponibilité réelle sur l'App Store. La publication Google possède son propre gate. |
| Des critères Android supprimés des tickets iOS sont oubliés ou annoncés réussis. | Correspondance explicite vers P8.1–P8.4, conservation de l'ancien contrat dans l'historique, états de preuve par plateforme et interdiction de clore Android sur une compilation ou un test iOS. Aucun lien de dépendance de P8 vers la sortie iOS. |
| Une dépendance ou adaptation iOS casse la future compilation Android. | Code Expo partagé, configurations conservées et build Android interne du candidat final ; correction des régressions de compilation dans leur tâche d'origine. Aucun compte Play Console requis pour maintenir cette capacité. |
| Les spécifications de design restent absentes ou inaccessibles dans Figma. | P6.1 produit un handoff versionné et approuvé ; P6.2–P6.4 restent bloquées, et les tâches fonctionnelles indépendantes continuent. Aucun style, asset ou mouvement inventé pour débloquer l'intégration. |
| La refonte modifie le consentement, la navigation ou la mesure, ou rend le produit moins accessible. | Tests des comportements existants conservés, matrice des états et animations, variantes de réduction des mouvements, VoiceOver/texte agrandi sur iPhone et recette transverse après intégration. Pas de nouvel événement dû au seul mouvement de l'interface. |
| Les captures ou les tests de bêta décrivent un build antérieur à la refonte. | P6.5 est un prérequis de TRA-318 et TRA-319 ; SHA/version et références design consignés. Une modification ultérieure revalide les critères et captures concernés avant la soumission. |
| Un auto-merge armé avant tier-guard fusionne une PR sensible sans review profonde. | TRA-285 calcule le risque depuis le diff dans le check `review-gate` déjà requis, puis exige review ordinaire ET preuve Sol/high profonde du SHA final pour tier/3. Absence, erreur ou SHA périmé bloquent ; le label tardif n'est pas la source du risque automatique. Suspension pendant la transition et avant reclassification manuelle tardive ; aucun gate humain ajouté. |

## Critères de sortie

### Première sortie iOS — critère actif de livraison

- track1 est installable depuis l'App Store sur les versions iOS supportées et vérifiées ; lien, version et SHA publiés sont consignés. Une soumission ou une présence TestFlight seule ne suffit pas.
- Le parcours goûts → recommandation → fiche → relation → Spotify/Apple Music est vérifié sur iPhone physique, avec et sans notifications autorisées.
- La recommandation est expliquée et stable dans la journée, ne fait pas d'appel au modèle, et respecte les règles d'historique et de cas vide documentées.
- Les cinq types de fiches, albums/EP/singles compris, la recherche globale, la génération explicite et les liens profonds fonctionnent ; une absence de données a un état testable.
- Un push réellement reçu sur iPhone ouvre Aujourd'hui à froid, à chaud et après arrière-plan ; refus, désactivation, changement de fuseau et token invalide sont vérifiés. Un reçu fournisseur ne prouve pas une réception effective.
- Le profil reste local ; aucun secret fournisseur n'est présent dans le bundle. Données push et mesure correspondent à la politique publiée et aux déclarations App Store.
- Catalogue et fiches consultées restent relisibles sans réseau ; crédits épuisés, génération interrompue et URL d'écoute indisponible n'empêchent pas de consulter les contenus disponibles.
- Le tracking plan est implémenté dans Segment et Amplitude ; chaque événement attendu est vérifié sur le candidat iOS, les refus de collecte sont respectés et les indicateurs de lancement iOS sont consultables sans données internes.
- Le handoff UI/motion est approuvé et versionné. Chaque écran et état demandé est intégré, ses animations et leurs variantes accessibles sont vérifiées, et les parcours fonctionnels ainsi que leurs événements passent encore. Les preuves de VoiceOver, texte agrandi et réduction des mouvements couvrent l'interface finale.
- Les captures App Store, la bêta TestFlight élargie et la soumission portent sur l'interface validée après refonte ; leurs builds et preuves sont traçables. Aucun livrable de design manquant n'est remplacé par une hypothèse d'implémentation.
- Android reste compilable sur le code retenu, avec preuve d'un build interne. Tous ses contrôles physiques non exécutés, sa QA, Play Console et sa publication sont conservés en partie 8, marqués différés et sans dépendance bloquant iOS.
- Les vérifications backend et mobile passent ; les contrats web et son streaming restent compatibles. Aucun fichier de cache musical ni `web/data.json` n'a été édité manuellement. Le check requis `review-gate` bloque techniquement tier/3 sans preuve profonde du SHA final, y compris auto-merge préarmé et label initial tier/1.
- Raphael a validé cet amendement avant transcription. Les règles de dimensionnement restent celles déjà autorisées ; résultats de bêta et décision de publication iOS sont consignés avant la sortie publique. Les tickets Done et leurs preuves n'ont pas été recréés ou réouverts du seul fait du replanning.

### Android — sortie différée, après réactivation

Les critères Android restent ceux de P8.1–P8.4 : installation physique, parcours et accessibilité, push reçu, mesure, résilience, bêta Google Play et publication réelle sont vérifiés sur Android. Aucun de ces résultats n'est attesté au 28 septembre par les seules preuves iOS. La livraison iOS peut être annoncée terminée avec cette partie ouverte ; le projet conserve la trace de son périmètre Android en attente et n'est pas présenté comme intégralement publié sur les deux plateformes.

## Annexe — Application de l'amendement au projet existant

Après validation, le manifeste détaillera les changements ci-dessous ; le ticket-writer relira l'état courant de Linear et appliquera ces changements aux objets existants, sans modifier rétroactivement les preuves. Un écart avec un ticket déjà terminé doit être documenté, jamais transformé silencieusement en nouvelle obligation de sa PR.

| Élément existant | Destination après validation | Effet sur la première sortie |
| --- | --- | --- |
| Milestones des parties 1 à 5 | Mêmes IDs, descriptions et critères de plateforme amendés | Les contrats fonctionnels et les acquis restent conservés. |
| Ancien milestone 6, ID `4860953a-bfb0-4eb4-9f87-a93c69e18241` | Partie 7 « Mettre track1 entre les mains des premiers utilisateurs iOS » | Même milestone réordonné et renommé ; aucun projet parallèle. |
| TRA-290 / P1.5 | Même ticket, contrat iOS + compilation Android ; test physique vers P8.1 | Sortie de In Progress possible seulement après vérification du contrat révisé et fusion. |
| TRA-305, TRA-306, TRA-311 et TRA-313 | Mêmes tickets et tiers, preuve appareil iOS ; contrôles Android vers P8.1 | Les push et liens profonds restent dans la première sortie. |
| TRA-315 et TRA-316 | Mêmes tickets et tiers, preuves de collecte et indicateurs iOS ; Android vers P8.1 | Segment et Amplitude restent requis avant diffusion. |
| TRA-317 / ancien P6.1 | P7.1 ; déclarations Google Play reportées dans P8.2 | Confidentialité et lien public requis pour iOS. |
| TRA-318 / ancien P6.2 | P7.2 App Store, dépend de P6.5 ; actifs Google Play vers P8.2 | Captures finales après refonte. |
| TRA-319 / ancien P6.3 | P7.3 TestFlight, dépend de P6.5 et P7.1 ; bêta Android vers P8.2 | Aucune distribution Google nécessaire à TestFlight. |
| TRA-320 / ancien P6.4 | P7.4 décision iOS ; résilience et décision Android vers P8.3 | La validation iOS ne dépend que de ses propres preuves. |
| TRA-321 / ancien P6.5 | P7.5, toujours après TRA-320 amendé | App Store constitue la première livraison publique. |
| TRA-322 / ancien P6.6 | P8.4, nouveau milestone Android en attente ; dépend de P8.3 | Même ID, nouvel ordre de reprise, aucun blocage iOS. |
| Refonte UI/motion | Nouveau milestone partie 6, cinq nouvelles tâches P6.1–P6.5 | Définition séparée de l'intégration, validation avant captures/bêta. |
| Contrôles et préparation Android reportés | Nouveau milestone partie 8 ; trois nouvelles tâches P8.1–P8.3 plus TRA-322 conservé | Aucun critère perdu, ni réussite Android supposée. |

Historique : validation du premier plan le 25 septembre 2026 ; transcription de 38 tickets le 26 septembre ; amendement proposé le 28 septembre. Les tâches complémentaires TRA-325 et TRA-326 demeurent hors de ce décompte et conservent leurs livraisons. À ce stade, seuls ce plan et sa proposition de séquencement changent ; le manifeste et le mapping existants restent des documents historiques à réviser après validation explicite.

## Annexe historique — Correspondance du découpage validé le 25 septembre

Cette table conserve la trace du passage des 63 tâches initiales aux 38 tâches validées le 25 septembre. Ses références P6 désignent l'ancienne partie publication ; la table d'amendement ci-dessus donne leur destination actuelle. Elle ne constitue pas une instruction de remettre une validation bi-plateforme sur le chemin iOS. Toutes les anciennes tâches étaient couvertes une fois ; aucune diminution de tier n'est introduite par l'amendement.

| Ancien | Nouveau | Regroupement ou maintien |
| --- | --- | --- |
| Nouveau préalable | P1.1 | Aligner la CI avant les features. |
| P1.1, P1.2, P1.4 | P1.2 | Socle, dépendances, tests et configurations publiques. |
| P1.3 | P1.3 | Navigation. |
| P1.6 | P1.4 | Vérifications automatiques mobile. |
| P1.5, P1.7 | P1.5 | Builds signés avec preuve d'installation comme critère. |
| P2.1, P2.2 | P2.1 | Contrat d'accès et première lecture du catalogue. |
| P2.3, P2.5 | P2.2 | Fiche et résolveurs nécessaires à sa consultation. |
| P2.4 | P2.3 | Recherche serveur. |
| P2.6, P2.8 | P2.4 | État des générations et persistance au déploiement. |
| P2.7, P2.9 | P2.5 | Exécution, erreurs et suivi public de génération. |
| P2.10 | P2.6 | Client réseau mobile. |
| P2.11, P2.12 | P2.7 | Recette transverse de compatibilité et déploiement API. |
| P3.1, P3.2 | P3.1 | Profil local et écrans de choix/modification. |
| P3.6, P3.7 | P3.2 | Fiche commune et navigation par relations. |
| P3.3, P3.4, P3.5 | P3.3 | Affinité, stabilité quotidienne et affichage. |
| P3.8 | P3.4 | Écoute externe. |
| P3.9, P3.10 | P3.5 | Stockage et gestion des abonnements push. |
| P3.12, P3.13 | P3.6 | Envoi Expo et contrôle de ses retours. |
| P3.11, P3.16 | P3.7 | Planification locale et activation serveur. |
| P3.14, P3.15 | P3.8 | Choix des rappels et ouverture depuis une notification. |
| P3.17 | P3.9 | Recette transverse du parcours quotidien. |
| P4.1, P4.2, P4.3 | P4.1 | Particularités des artistes, projets et morceaux. |
| P4.4, P4.5 | P4.2 | Particularités des genres et labels. |
| P4.6 | P4.3 | Recherche mobile. |
| P4.7, P4.8 | P4.4 | Demande et suivi de création d'une fiche. |
| P4.9 | P4.5 | Liens profonds. |
| P4.10, P4.11 | P4.6 | Consultation hors réseau et reprise après erreur. |
| P4.12 | P4.7 | Recette transverse d'exploration/accessibilité. |
| P5.1 | P5.1 | Tracking plan défini en amont. |
| P5.2, P5.3 | P5.2 | Collecte Segment et choix utilisateur effectif. |
| P5.4 | P5.3 | Destination Amplitude et séparation des environnements. |
| P5.5, P5.6 | P5.4 | Indicateurs avec vérification transverse des événements. |
| P6.1, P6.2 | P6.1 | Politique de confidentialité rédigée et accessible. |
| P6.3 | P6.2 | Présentation dans les stores. |
| P6.4, P6.5 | P6.3 | Distribution de la même bêta sur les deux plateformes. |
| P6.6, P6.7 | P6.4 | Recette transverse de résilience et décision de publication. |
| P6.8 | P6.5 | Publication App Store, clôturée à disponibilité réelle. |
| P6.9 | P6.6 | Publication Google Play, clôturée à disponibilité réelle. |

Le rapprochement historique couvre 63 anciennes tâches dans 37 tâches révisées ; le préalable CI portait le total à 38. L'amendement du 28 septembre conserve ces 38 identifiants et ajoute cinq tâches de refonte et trois de reprise Android, soit 46 tâches planifiées. Les contrats de recommandation, profil local, écoute externe, génération, push et mesure sont conservés.

Gate de cette révision : **faire valider le plan amendé**, puis reprendre la même session de planner pour mettre à jour le manifeste complet. La validation du 25 septembre ne vaut pas validation automatique de ce nouvel ordonnancement détaillé ni du design encore absent. Aucune mutation Linear avant ce gate.
