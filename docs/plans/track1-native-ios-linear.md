# Manifeste Linear — Track1 iOS natif
Statut : validé par Raphael le 2026-10-05. Création des tickets puis démarrage de l'implémentation autorisés. Aucun code d'implémentation ni objet Linear n'a été modifié pour rédiger ce manifeste.

## Projet

- **Nom conservé :** Track1 Mobile.
- **Projet existant :** P-TRA-4 — `1af27c25-2427-4d6c-a93c-a4f431732eca`.
- **URL :** https://linear.app/workspaceperso/project/track1-mobile-6052a246546f
- **Équipe :** Track1 — `5957a8e2-e7a0-4995-8acb-b3820ac19745`.
- **Plan validé :** `docs/plans/track1-native-ios.md`.
- **Périmètre actif du manifeste :** 6 milestones natifs, 28 issues canoniques ; 20 nouvelles issues et 8 issues ouvertes réemployées. Tiers : 5 tier/1, 9 tier/2, 14 tier/3.
- Ne renseigner aucune estimation, aucun point ni date d'échéance. Conserver le projet existant ; ne pas créer de projet concurrent.

### Description

Plan validé le 5 octobre 2026 : `docs/plans/track1-native-ios.md`. Première sortie iOS entièrement native ; Android Java différé jusqu'à décision fondée sur la traction iOS ; site web inchangé.

Track1 doit donner envie de découvrir une œuvre musicale chaque jour, puis de l'écouter dans son service habituel. Le contenu et les services nécessaires existent déjà, mais l'application mobile n'a pas encore atteint l'expérience iPhone et la qualité de présentation attendues pour sa première sortie publique.

Le travail engagé sous React Native et Expo a permis de préciser les parcours, les règles de recommandation, les interfaces serveur et la mesure d'usage. La nouvelle direction produit demande une application entièrement native, avec une interface et des animations particulièrement soignées. Continuer à développer les deux clients en parallèle disperserait l'effort et rendrait ambiguë la version destinée aux utilisateurs.

Le défi est de transformer ces acquis en une seule application iOS officielle, sans recommencer le backend, dégrader le site ou repousser la première sortie à la réalisation d'Android. Le design system et les seize écrans Figma donnent désormais une référence commune pour l'expérience à livrer.

1. Une personne installe track1 depuis l'App Store, choisit ses goûts sans créer de compte et retrouve chaque jour une recommandation expliquée et stable pendant la journée.
2. Elle explore les fiches et leurs relations, recherche dans les cinq types de contenus et déclenche elle-même la création d'une fiche manquante ; les contenus déjà consultés restent utiles en cas de coupure réseau.
3. Elle ouvre Spotify ou Apple Music depuis une fiche et peut recevoir un rappel quotidien facultatif. Le refus des notifications ou de la mesure d'usage n'empêche aucun parcours musical.
4. L'expérience iPhone suit les seize écrans Figma, avec des transitions fluides, des états d'attente et d'erreur compréhensibles et des variantes accessibles vérifiées sur appareil.
5. L'équipe dispose d'une seule version mobile officielle et mesure de manière fiable la découverte, l'ouverture d'un service d'écoute et le retour quotidien des utilisateurs iOS ayant accepté la mesure.

Track1 devient une application iPhone avec trois entrées : **Aujourd'hui**, **Recherche** et **Réglages**. La personne choisit d'abord si elle accepte la mesure d'usage, puis ses genres musicaux. L'application conserve ces goûts sur le téléphone et reprend les règles déjà définies pour choisir une découverte quotidienne parmi les contenus existants. Chaque découverte conduit à une fiche culturelle, à ses relations et à un service d'écoute externe.

Les contenus et leur création continuent à venir du backend existant. La consultation reste gratuite en appels au modèle : seule une action explicite de création peut déclencher une génération. Les attentes, les erreurs et le manque de crédits sont visibles ; fermer puis rouvrir l'application permet de retrouver le suivi sans payer une deuxième création involontaire.

Après la première découverte, une invitation permet d'activer un rappel à **9 h dans le fuseau du téléphone**. Le message reste générique : « Une découverte musicale t'attend. Ouvre track1 pour la découvrir. ». Il ouvre Aujourd'hui ; les goûts ne sont pas envoyés au serveur pour fabriquer la notification. La mesure d'usage reste un choix séparé, modifiable dans les réglages.

La livraison avance par six résultats : installer le nouveau client, réaliser le parcours quotidien, recevoir son rappel, explorer librement, valider l'expérience finale, puis publier. Les éléments Figma sont utilisés dès la construction de chaque parcours ; une repasse transverse affine ensuite les animations et vérifie les seize écrans ensemble. Les notifications et la mesure sont présentes dans la première bêta utile, avant l'élargissement TestFlight et la publication.

Les travaux backend et les règles produit restent la base du projet. Le client Expo est gelé comme référence, puis retiré du dépôt actif lorsque son remplacement est vérifié. Les anciens plans conservent leur valeur historique ; le nouveau plan devient la source active après validation. Android ne bloque aucun résultat iOS.

## Instructions exactes de transcription et de réconciliation

### Sources, accès et statuts

Le dispatcher a relu Linear le 5 octobre 2026 après reconnexion : 50 issues dans le projet ; TRA-290 In Progress ; TRA-327 à TRA-331 Backlog ; TRA-305, TRA-306, TRA-311, TRA-313, TRA-315 à TRA-322 Backlog ; TRA-332 à TRA-334 Backlog ; TRA-312, TRA-325, TRA-326 Done. Tous les autres acquis du périmètre historique sont Done. Ces observations ont été transmises au planner ; aucune écriture Linear n'a été faite par lui. Le ticket-writer relit chaque cible juste avant mutation pour éviter une course avec un travail terminé entre-temps.

Le mapping d'identifiants/UUID historique est `docs/plans/track1-mobile-linear-map.md`. Les descriptions anciennes sont conservées dans `docs/plans/track1-mobile-linear.md`. Base Git actuelle : `85a5b8e07fa103c8a884cac50de56868c3ea805b` ; TRA-312 / PR #303 y livre le cache RN, avec `mobile/src/cache/catalog.ts`, `mobile/src/cache/nodes.ts`, `mobile/test/offline-cache.test.ts`, `mobile/test/offline-journey.test.tsx`. Xcode 26.4, Swift 6.3 et simulateur iOS 26.4 constatés sur la machine. Aucun réaudit général ni nouvelle architecture requis.

### Projet et milestones

1. Mettre à jour la description du projet existant avec le bloc « Description » ci-dessus ; garder son ID, son nom, ses ressources/historiques, ses membres et ses liens de PR.
2. Créer les six milestones natifs aux titres et descriptions exacts ci-dessous, dans cet ordre. Si un milestone natif portant exactement ce titre existe déjà à la reprise, réutiliser son ID ; ne pas le dupliquer.
3. Les anciens milestones restent historiques : ne pas les supprimer, les recycler avec une autre signification ni réécrire leurs descriptions. Les issues Done y restent attachées. Le projet peut donc afficher les six milestones actifs en plus de ses milestones historiques ; « six » désigne le périmètre natif, pas une suppression d'historique.
4. Déplacer uniquement les huit issues ouvertes réemployées dans leur milestone natif. L'ancien milestone Android reste différé ; aucun milestone ou ticket Java n'est créé.

### Identités des 28 issues actives

| Référence | Action définitive |
| --- | --- |
| P1.1 | Créer une issue native |
| P1.2 | Réemployer TRA-327 |
| P1.3, P1.4, P1.5 | Créer trois issues natives |
| P2.1 à P2.6 | Créer six issues natives |
| P3.1 à P3.3 | Créer trois issues natives ; ne pas rouvrir TRA-302 à TRA-304 |
| P4.1 à P4.5 | Créer cinq issues natives |
| P5.1 | Créer une issue native |
| P5.2 | Réemployer TRA-317 |
| P5.3 | Réemployer TRA-315 |
| P5.4 | Réemployer TRA-331 |
| P6.1 | Réemployer TRA-318 |
| P6.2 | Réemployer TRA-319 |
| P6.3 | Créer une issue native |
| P6.4 | Réemployer TRA-320 |
| P6.5 | Réemployer TRA-321 |

Pour chaque réemploi : copier le nouveau titre, la description complète, le milestone et les dépendances ci-dessous, conserver l'ID/UUID, l'historique, les PR et pièces jointes. Ajouter le commentaire exact : « Plan iOS natif validé le 2026-10-05 : contrat remplacé par `<référence>` du manifeste `docs/plans/track1-native-ios-linear.md`. L'ancien contrat reste dans `docs/plans/track1-mobile-linear.md`. Les preuves Expo historiques ne prouvent pas le fonctionnement Swift. » Remplacer seulement `<référence>` par Pn.n.

Les statuts Backlog des réemplois restent Backlog pendant la transcription. Les créations sont Backlog. Ne pas assigner ou passer In Progress avant dispatch de l'implémentation. Appliquer le tier indiqué ; si une issue réemployée porte déjà un tier supérieur, le conserver et le signaler, jamais l'abaisser.

Les issues nouvelles portent leur référence Pn.n et le chemin du manifeste dans la description. À la reprise après erreur, rechercher cette paire et le titre exact dans le projet avant de créer ; réutiliser le résultat unique. Si plusieurs cibles correspondent, arrêter la seule mutation ambiguë et rapporter leurs IDs ; ne rien supprimer pour dédoublonner.

Si une cible prévue pour réemploi est désormais Done, ne pas la modifier : créer son remplacement natif avec la même description, noter son ID historique comme relation `related`. Si un état autre que ceux observés modifie un travail en cours, préserver ce travail et rapporter le changement avant de réécrire son contrat. Un problème d'accès n'autorise ni création supposée ni implémentation sans ticket réel.

### Traitement des issues historiques hors des 28 canoniques

**Done : aucune mutation de statut, de titre, de description, de milestone ou de preuve.** Cela protège notamment TRA-285/286, TRA-287 à TRA-289, TRA-291 à TRA-304 hors TRA-290, TRA-307 à TRA-310, TRA-312/314/325/326, et tout autre acquis terminé. Ne pas recréer les endpoints backend ni les contrôles CI déjà livrés.

**Annulations limitées aux travaux Expo ouverts devenus caducs :**

| Ancienne issue | État observé | Traitement et remplaçant |
| --- | --- | --- |
| TRA-290 | In Progress | Canceled ; P1.5 remplace EAS/signature Expo. Préserver la PR, branche et assets ; ne pas supprimer ou fermer une PR par simple transcription Linear. |
| TRA-305 | Backlog | Canceled ; P3.3 remplace le client de notifications Expo. |
| TRA-311 | Backlog | Canceled ; P4.5 remplace l'intégration des liens profonds Expo. |
| TRA-328 | Backlog | Canceled ; intégration Swift couverte par P1.3, P2.3 et P2.6. |
| TRA-329 | Backlog | Canceled ; intégration Swift couverte par P2.4, P4.1, P4.2 et P4.4. |
| TRA-330 | Backlog | Canceled ; P5.1 remplace les animations Expo. |

Avant chacune, relire l'état : si Done, ne rien changer et garder seulement la relation historique depuis le nouveau ticket ; si une nouvelle modification native non prévue apparaît, rapporter ce conflit plutôt que l'annuler. Utiliser l'état annulé de l'équipe (type canceled, nom Canceled ; jamais Done). Conserver description et pièces jointes. Ajouter `related` vers les successeurs et ce commentaire exact, avec les références remplacées par les IDs résolus : « Remplacé par le plan iOS natif validé le 2026-10-05. Le travail Expo restant est annulé ; les livrables et preuves historiques sont conservés. Successeur(s) : <IDs>. Aucun résultat Swift n'est déclaré livré par cette annulation. »

**Obligations utiles consolidées, sans fausse clôture :** TRA-306 et TRA-313 restent Backlog, reliés et bloqués par P5.4 ; TRA-316 reste Backlog, relié et bloqué par P5.3. Conserver leurs corps et ajouter ce commentaire exact : « Le résultat reste requis et sera prouvé par <ID successeur> dans le client Swift. Ne pas lancer une deuxième implémentation ou recette indépendante. Clôture de cet ancien suivi seulement après vérification des preuves du successeur ; son statut n'est pas avancé pendant la transcription. » Ces trois suivis ne sont pas des tickets d'exécution supplémentaires au périmètre de 28. Les dépendances historiques contradictoires vers Expo/Android sont retirées pour ces suivis seulement.

**Android différé :** TRA-322/332/333/334 restent Backlog, sans date, sans agent d'implémentation lancé et sans relation bloquante vers une issue native. Conserver leurs descriptions historiques, ajouter : « Différé après la sortie iOS et une décision fondée sur sa traction. La future application Android sera native Java ; les instructions Expo de ce ticket sont historiques et ne doivent pas être exécutées. Un nouveau brief devra les remplacer avant toute reprise. » Ce manifeste n'autorise aucune réalisation Android.

**Hors liste :** TRA-323/324 ou toute autre issue non explicitement visée restent inchangés. Un titre proche ne suffit pas à élargir les annulations. Les anciennes issues backend ouvertes inattendues restent conservées et leur divergence est rapportée, pas convertie en travail natif à refaire.

### Relations, règles d'exécution et artefacts

Créer/résoudre d'abord les six milestones et les 28 issues, puis appliquer les dépendances de démarrage par titre exact. Les sections « Preuves avant clôture » ne retardent pas le début de P5.3 : ce sont des critères de clôture. Retirer seulement les anciennes dépendances contradictoires des issues réemployées ; aucune dépendance Android ne bloque la sortie iOS. Garder les relations utiles et les PR existantes.

Mettre à jour les 28 placeholders du plan avec les vrais IDs et créer `docs/plans/track1-native-ios-linear-map.md` contenant IDs/UUID/URLs des milestones/issues, réemplois/créations et mutations historiques réellement effectuées. Conserver le mapping Expo sans le remplacer. Contrôler un résultat canonique unique par Pn.n, son tier et ses liens ; ne pas confondre 28 résultats avec 28 créations.

Chaque ticket = une branche = une PR, tests inclus. Préserver les modifications des autres agents. Le volume est un signal de réexamen, pas un plafond : ajouts/suppressions écrits (tests et scaffold inclus) séparés des artefacts générés avec provenance ; réexamen documenté au-delà de 1 000 lignes écrites ou 20 fichiers. Tous les gates et la review approfondie tier/3 du SHA final restent obligatoires. Aucun code, cache musical, site ou objet externe hors portée ne doit être modifié. L'autorisation de poursuivre jusqu'à publication déjà acquise demeure ; aucun nouvel accord n'est requis par simple tier.

Tous les chemins Swift ci-dessous sont des créations prévues ou des fichiers livrés par un prérequis ; la racine du dépôt est vérifiée. Les chemins TypeScript/Expo sont des références réelles sur le commit cité, même si absents du checkout documentaire. Les détails de compte ou secrets non accessibles sont des prérequis opérationnels à constater, pas des valeurs à inventer. Aucune estimation.


## Milestone 1 — Installer le nouveau track1 sur iPhone

### Description

- **Objectif produit :** disposer d'une seule application iPhone cible, installable et reproductible, sur laquelle construire et vérifier la nouvelle expérience.
- **Solution :** fixer la transition depuis Expo, conserver les écrans Figma comme référence et préparer une application native avec les trois entrées prévues, les couleurs et composants communs, puis la distribuer en interne.
- **Logiques ajoutées ou modifiées :** identité de l'application, première ouverture, navigation, séparation des environnements internes et publics, installation et vérification des changements avant diffusion.
- **Résultat observable :** un testeur installe le client natif sur iPhone et retrouve Aujourd'hui, Recherche et Réglages ; le backend reste vérifiable et aucun nouveau build Expo n'est présenté comme version officielle.

### Issue — Figer le passage d'Expo au client iOS natif

- **Référence :** P1.1
- **Tier :** tier/1
- **Identité Linear :** créer une issue native.
- **Dépendances :** Aucune.

#### Description

##### Contexte

Le client Expo a fixé les parcours mais le client officiel devient Swift. Cette tâche rend la bascule vérifiable et conserve les travaux livrés sans les réécrire. Plan validé : `docs/plans/track1-native-ios.md`, P1.1. Source de transcription : `docs/plans/track1-native-ios-linear.md`.

##### Portée

Modifier `README.md` et `docs/track1-builds.md` ; créer `docs/track1-native-transition.md`. Les plans sont actuellement locaux et non versionnés dans `origin/main` : le worktree isolé ne les reçoit donc pas automatiquement. Transporter puis ajouter à la PR les six fichiers suivants, depuis le checkout documentaire `/Users/raphaeldoulonne/Documents/odyssey-music`, lu sans aucune écriture, vers les mêmes chemins relatifs du worktree du ticket :

- `docs/plans/track1-mobile.md` — plan historique ; copie intégrale puis bandeau de remplacement seulement.
- `docs/plans/track1-mobile-linear.md` — manifeste historique ; copie intégrale puis bandeau de remplacement seulement.
- `docs/plans/track1-mobile-linear-map.md` — mapping historique ; copie intégrale puis bandeau de remplacement seulement.
- `docs/plans/track1-native-ios.md` — plan validé, dans sa version avec les identifiants Linear reportés par le ticket-writer.
- `docs/plans/track1-native-ios-linear.md` — présent manifeste validé, incluant la précision de transport de P1.1.
- `docs/plans/track1-native-ios-linear-map.md` — mapping natif définitif produit par le ticket-writer ; attendu après la fin de la transcription, actuellement pas encore présent lors de cette précision.

Lire les PR associées pour le rapport de transition. Hors scope : code, suppressions, activation/désactivation de services, modifications Linear, Android, toute écriture dans le checkout documentaire partagé ou ajout d'autres fichiers locaux non versionnés. Ne pas déplacer les originaux, ne pas faire de `git add` global et ne pas transporter les changements de skills/configuration de la session.

##### Contrat

Le rapport contient, pour chaque famille TRA-285 à TRA-334 dans le périmètre connu, ID, état observé/date, PR/SHA, livrable conservé, cible native et traitement. Inclure TRA-325/326 sans inventer leur livraison. Base distante : `85a5b8e07fa103c8a884cac50de56868c3ea805b` ; TRA-312/PR #303 et ses caches sont vérifiés. Consigner bundles Apple, fiche App Store Connect, builds distribués et assets utiles de la branche TRA-290. Un seul client cible : `ios/`. Pas de migration des données des builds Expo internes ; une sortie Expo publique découverte bloque la bascule des données et remonte un arbitrage de scope, sans empêcher le reste de l'inventaire.

Avant le transport, vérifier que le ticket-writer a terminé le mapping natif et le report des 28 identifiants dans le plan ; l'inventaire des cinq autres documents peut avancer en attendant. Le mapping est un prérequis documentaire de clôture, pas un nouveau ticket ni un motif de demander une nouvelle validation du plan. Ne pas fabriquer un mapping incomplet. Consigner dans `docs/track1-native-transition.md` la source absolue, la date de capture et le SHA-256 de chaque source lue. Copier avec `apply_patch` uniquement dans le worktree isolé. Les trois copies natives sont identiques octet pour octet aux sources définitives ; pour chacun des trois fichiers historiques, conserver intégralement tous les octets sources après ce seul préfixe, suivi d'une ligne vide : `> Historique — remplacé pour l'exécution par [le plan iOS natif](track1-native-ios.md), validé le 2026-10-05. Corps historique conservé à l'identique.` Ne normaliser ni les retours à la ligne, ni les anciennes dates, ni les anciens statuts. Si les sources changent pendant la capture, reprendre leur copie depuis la version stabilisée par le ticket-writer, sans modifier ses fichiers. Si un chemin cible a entre-temps été livré par une autre PR, comparer avant de modifier et préserver son contenu utile ; aucun écrasement aveugle.

##### Critères d'acceptation

- [ ] Chaque famille et ses PR sont reliées à une destination ou marquées non vérifiées ; aucun Done n'est présenté comme à refaire côté backend.
- [ ] Une seule application officielle est nommée, les builds Expo sont identifiés comme historiques, et l'archive Git future est définie avant suppression.
- [ ] Le caractère interne des builds existants est prouvé ou l'absence de preuve explicitée ; le traitement des données locales est lisible par un testeur.
- [ ] Les six artefacts figurent dans le diff et sont suivis par Git dans le worktree ; les trois copies natives correspondent aux sources définitives, et les trois corps historiques restent identiques après retrait du seul bandeau prévu.
- [ ] Les hashes de provenance, les 28 correspondances de tickets et les liens locaux/Linear sont vérifiés depuis le worktree et le candidat PR ; aucun lien nécessaire ne pointe uniquement vers un fichier local absent de la PR.
- [ ] Le checkout documentaire partagé et ses originaux sont intacts ; aucun changement utilisateur, skill, configuration ou document hors portée n'est embarqué.

##### Tests attendus

Contrôle documentaire ligne par ligne du mapping contre Git/PR et lecture Linear disponible ; vérifier la présence des six fichiers dans le diff et l'index Git. Comparer les SHA-256 des copies natives aux sources capturées et les trois corps historiques aux sources après retrait du préfixe exact ; toute divergence échoue au contrôle. Vérifier les liens relatifs depuis le worktree, les IDs du mapping natif et l'absence de modification du checkout source. Aucun test applicatif nouveau.

##### Tier de risque

tier/1 — contrôles du périmètre et gates requis conservés.

##### Notes d'implémentation

Aucune estimation. Une PR documentaire propre à ce ticket. Le checkout local peut être en retard : lire les objets Git et travailler dans le worktree isolé du ticket, sans réinitialiser ni écrire dans le dossier partagé. Le transport des artefacts validés complète matériellement les liens et bandeaux déjà prévus ; il ne change ni l'architecture ni les résultats validés. Ces copies de documents restent du volume écrit versionné, pas du code généré à exclure artificiellement : si leur ajout dépasse le seuil de réexamen, consigner que la PR livre une transition documentaire cohérente avec conservation historique, preuves de comparaison et retour arrière par revert ; ne pas scinder les sources nécessaires pour contourner la taille. Une seule branche/PR pour ce ticket ; préserver les modifications des autres intervenants. Aucun changement du site, Android ou dépendance non prévue. Les noms du code sont en anglais et la documentation en français.

### Issue — Figer le handoff des seize écrans et de leurs mouvements

- **Référence :** P1.2
- **Tier :** tier/1
- **Identité Linear :** réemployer TRA-327.
- **Dépendances :** Aucune.

#### Description

##### Contexte

Les seize écrans iOS existent dans Figma ; les développeurs ont besoin de leurs références et des adaptations natives figées. Le résultat est le handoff utilisé par tous les tickets Swift, sans nouvelle conception des parcours. Plan validé : `docs/plans/track1-native-ios.md`, P1.2. Source de transcription : `docs/plans/track1-native-ios-linear.md`.

##### Portée

Créer `docs/track1-design.md`, `docs/design/track1/manifest.json` et les exports dans `docs/design/track1/`. Parent `docs/` vérifié. Lire uniquement le fichier Figma `phudxrQNlzQJafXLma4FyX`, matrice `28:3`, page `28:2`, patterns `30:2`, barre `30:72`, review `37:16`. Hors scope : écriture de code ou modification du fichier Figma, nouvelles fonctionnalités, refonte du site.

##### Contrat

URL : https://www.figma.com/design/phudxrQNlzQJafXLma4FyX/Track1-Design-System?node-id=28-3. Inventaire exact : consentement 31:2 ; goûts 31:27 ; invitation push 31:69 ; Aujourd'hui 32:35 ; recherche 32:69 ; réglages 32:136 ; artiste 34:144 ; album 34:197 ; titre 34:246 ; genre 34:294 ; label 34:338 ; génération 35:260 ; chargement 35:275 ; hors ligne 35:286 ; erreur génération 35:308 ; profil absent 35:326. Documenter tokens sémantiques clair/sombre, police système, SF Symbols nommés, espacements, assets/provenance/droits, états et navigation. iOS 26+ : matériaux natifs ; iOS 17/18 : repli standard. Mouvements absents du design : navigation/sheet natives, micro-interaction 150 ms, fondu d'état 200 ms ; Reduce Motion : fondu 100 ms ou immédiat, sans boucle décorative. Remplacer dans le handoff les étapes fictives de génération par les vrais états serveur, autoriser recherche locale hors ligne et nommer l'erreur de crédits seulement sur code réel.

##### Critères d'acceptation

- [ ] 16/16 écrans possèdent node ID, export daté, thème et état ; toutes les références restent accessibles depuis le manifeste d'assets.
- [ ] Chaque composant/animation précise déclencheur, état final, interruption, durée/courbe et variante accessible ; les replis iOS 17 sont explicites.
- [ ] Aucun fait musical de démonstration ou progression fictive n'est transformé en règle produit.
- [ ] Les exports et leur provenance sont vérifiés ; les adaptations nécessaires sont écrites sans refaire les écrans ni demander une validation de design déjà accordée.

##### Tests attendus

Vérification documentaire des 16 IDs/exports, liens et correspondance des états ; inspection des contrastes, cibles 44 pt et possibilités d'agrandissement. Pas de code de test applicatif.

##### Tier de risque

tier/1 — contrôles du périmètre et gates requis conservés.

##### Notes d'implémentation

Parallélisable avec P1.1. L'accès Figma est une frontière opérationnelle : si l'export n'est pas accessible, conserver les IDs et qualifier précisément la preuve manquante, sans inventer les couleurs ni les assets. Une seule branche/PR pour ce ticket ; préserver les modifications des autres intervenants. Aucun changement du site, Android ou dépendance non prévue. Les noms du code sont en anglais et la documentation en français.

### Issue — Ouvrir les trois entrées dans une application SwiftUI

- **Référence :** P1.3
- **Tier :** tier/3
- **Identité Linear :** créer une issue native.
- **Dépendances :** P1.1 — Figer le passage d'Expo au client iOS natif ; P1.2 — Figer le handoff des seize écrans et de leurs mouvements.

#### Description

##### Contexte

La nouvelle application doit s'ouvrir nativement avec les trois entrées prévues. Le socle fournit navigation, configuration et composants de marque réutilisables, sans runtime React Native. Plan validé : `docs/plans/track1-native-ios.md`, P1.3. Source de transcription : `docs/plans/track1-native-ios-linear.md`.

##### Portée

Créer `ios/Track1.xcodeproj/project.pbxproj`, ses schémas partagés, `ios/.xcode-version`, `ios/Track1/App/Track1App.swift`, `AppContainer.swift`, `AppConfiguration.swift`, `AppRouter.swift`, `RootView.swift`, `ios/Track1/DesignSystem/`, `ios/Track1/Resources/`, `ios/Configurations/`, `ios/Track1Tests/AppConfigurationTests.swift`, `ios/Track1UITests/NavigationTests.swift`. Lire `mobile/app/_layout.tsx`, `mobile/app/(tabs)/_layout.tsx`, `mobile/src/config.ts`, `mobile/test/navigation.test.tsx` et `docs/track1-design.md`. Tous les chemins iOS sont nouveaux. Hors scope : API musicale, analytics, signature privée, fonctionnalités Android/web.

##### Contrat

SwiftUI, Swift 6 avec concurrence stricte, Xcode 26.4/Swift 6.3 constatés localement, minimum iOS 17, cible iPhone. Projet et schémas `Track1` et `Track1Preview` partagés. AppContainer compose les services, sans framework d'injection ; AppRouter conserve une pile distincte par onglet Aujourd'hui/Recherche/Réglages. AppConfiguration contient `environment` development/preview/production, `apiBaseURL` HTTPS sans credentials/query/fragment et chemin finissant `/mobile/v1`, et une write key Segment publique facultative ; configuration invalide = écran explicite, jamais crash ou appel fournisseur. Bundles réels issus du rapport P1.1, pas d'identité inventée. Tokens Figma centralisés, police système/Dynamic Type/SF Symbols, matériaux standard avant iOS 26. Répertoires ressources/Tests intégrés au projet dès création.

##### Critères d'acceptation

- [ ] Le build simulateur iOS 26.4 compile depuis un clone propre avec les deux schémas et le minimum iOS 17.
- [ ] Les trois onglets, leurs retours et leurs piles restent cohérents après changements d'onglet ; aucun écran de développement n'est présenté comme fonctionnalité terminée.
- [ ] Valeurs absentes, URL unsafe et environnement inconnu ouvrent l'état de configuration invalide ; la clé Segment absente ne bloque pas l'app.
- [ ] Clair/sombre, texte agrandi et éléments accessibles sont présents ; aucun JS, secret fournisseur ou SDK non prévu dans le bundle.

##### Tests attendus

XCTest : configuration valide/invalide et état de navigation. XCUITest : ouverture, bascule des trois onglets, retour, thème et agrandissement. Build avec cible iOS 17 ; la preuve d'exécution sur iOS 17 reste exigée par la recette finale.

##### Tier de risque

tier/3 — review approfondie automatisée du SHA final et gates requis conservés.

##### Notes d'implémentation

UIKit seulement comme pont système local si nécessaire, pas de deuxième architecture. Dépendances tierces : aucune dans ce ticket. Une branche/PR ; code scaffold et tests comptés comme écrit, assets générés séparément. Adapter aux changements des autres tickets sans les annuler. Une seule branche/PR pour ce ticket ; préserver les modifications des autres intervenants. Aucun changement du site, Android ou dépendance non prévue. Les noms du code sont en anglais et la documentation en français.

### Issue — Vérifier le client Swift à chaque changement

- **Référence :** P1.4
- **Tier :** tier/3
- **Identité Linear :** créer une issue native.
- **Dépendances :** P1.3 — Ouvrir les trois entrées dans une application SwiftUI.

#### Description

##### Contexte

Le nouveau client doit être vérifié automatiquement comme le backend. Cette tâche rend les erreurs Swift visibles avant fusion sans retirer les contrôles existants. Plan validé : `docs/plans/track1-native-ios.md`, P1.4. Source de transcription : `docs/plans/track1-native-ios-linear.md`.

##### Portée

Créer `.github/workflows/ios-ci.yml`, `ios/scripts/check.sh` et la configuration de format native ; compléter `docs/track1-builds.md`. Modifier `scripts/ci/pr-policy.ts` et `test/ci-policy.test.ts` uniquement pour classifier les artefacts générés Swift effectivement identifiés. Ancrages existants : `.github/workflows/ci.yml`, `.github/workflows/mobile-ci.yml`, `.github/workflows/review-gate.yml`. Hors scope : suppression d'un workflow/gate, secrets de signature dans les PR, réécriture de TRA-285, fonctionnalités.

##### Contrat

Le script local et la CI utilisent le Xcode épinglé par `ios/.xcode-version` et exécutent résolution SPM verrouillée, contrôle de format avec l'outil Swift fourni, build strict, XCTest et XCUITest des schémas partagés sur simulateur. Le job macOS publie résultats/xcresult sans données privées. Les PR externes n'ont aucun secret de signature. `npm run check`, review-gate et classification des risques continuent indépendamment. La CI de taille déjà livrée signale le réexamen au-delà de 1 000 lignes écrites/20 fichiers, sans échec sur volume seul ; le projet Xcode maintenu et tests sont écrits, un Package.resolved produit par SPM est généré avec provenance.

##### Critères d'acceptation

- [ ] Un clone propre passe le même contrôle local et CI ; la version de Xcode utilisée est visible et identique à celle épinglée.
- [ ] Une erreur Swift ou un test volontairement cassé fait échouer le job dans une preuve non fusionnée ; aucun bypass n'est ajouté.
- [ ] Les tests/backend/review/tier existants sont toujours exécutés ; le contrôle Expo reste provisoirement disponible.
- [ ] Tout ajout à la classification écrit/généré est couvert par test positif/négatif, sans classifier tout `ios/` comme généré.

##### Tests attendus

Tests `test/ci-policy.test.ts` si modifié ; exécution du script natif et du workflow sur PR, preuve d'échec contrôlé puis retour au vert ; `npm run check` selon le périmètre. Les tests des fonctionnalités futures rejoignent les suites dès leur livraison.

##### Tier de risque

tier/3 — review approfondie automatisée du SHA final et gates requis conservés.

##### Notes d'implémentation

tier/3 : CI et gouvernance de merge. Revue profonde du SHA final, aucun gate désactivé. Parallélisable avec signature P1.5 ; coordonner l'écriture du rapport builds. Une seule branche/PR pour ce ticket ; préserver les modifications des autres intervenants. Aucun changement du site, Android ou dépendance non prévue. Les noms du code sont en anglais et la documentation en français.

### Issue — Installer et archiver un build iOS signé

- **Référence :** P1.5
- **Tier :** tier/3
- **Identité Linear :** créer une issue native.
- **Dépendances :** P1.3 — Ouvrir les trois entrées dans une application SwiftUI.

#### Description

##### Contexte

Un simulateur ne prouve ni l'installation signée ni les capacités push. Cette tâche établit la distribution interne native et la chaîne de signature Apple réutilisée jusqu'à l'App Store. Plan validé : `docs/plans/track1-native-ios.md`, P1.5. Source de transcription : `docs/plans/track1-native-ios-linear.md`.

##### Portée

Modifier `ios/Track1.xcodeproj/project.pbxproj`, les schémas et `ios/Configurations/` ; créer `ios/Track1/Resources/Track1.entitlements`, compléter `docs/track1-builds.md`, créer `docs/track1-native-release.md`. Lire l'inventaire `docs/track1-native-transition.md` et les configurations de TRA-290 identifiées par ce rapport. Hors scope : nouveaux bundles Apple concurrents, publication publique, SDK Expo, stockage de secrets dans Git.

##### Contrat

Réutiliser bundle production et fiche App Store Connect existants ; preview distinct selon inventaire. Signature gérée via Apple et secrets CI dédiés, jamais `.p8`, clé privée ou certificat exporté dans le dépôt. Le schéma preview local utilise APNs sandbox ; une archive TestFlight utilise APNs production. L'environnement analytics est indépendant du transport APNs : TestFlight interne reste preview. Consigner les Team ID et bundles publics, profils, entitlements attendus, procédure de renouvellement, build/version/SHA et appareil. Les credentials réels sont un prérequis opérationnel ; leur absence ne vaut pas installation réussie.

##### Critères d'acceptation

- [ ] Une archive native est produite avec les paramètres reproductibles consignés et installée sur iPhone réel.
- [ ] Les trois onglets s'ouvrent sur ce build ; bundle, équipe et profil de provisioning correspondent.
- [ ] L'archive contient l'entitlement APNs approprié, aucune clé fournisseur/Apple privée ni configuration EAS.
- [ ] Le chemin de distribution et de renouvellement est vérifiable ; une configuration manquante échoue explicitement sans modifier les secrets existants.

##### Tests attendus

Build/archive signés, inspection des entitlements et recherche de secrets dans l'archive/logs, installation physique et smoke de navigation. La réception réelle APNs sera ajoutée par P3.3.

##### Tier de risque

tier/3 — review approfondie automatisée du SHA final et gates requis conservés.

##### Notes d'implémentation

tier/3 signature/secrets. La publication du produit est autorisée dans le projet mais ce ticket ne publie pas. Aucun accord supplémentaire du seul fait du tier ; respecter les accès réellement disponibles. Une seule branche/PR pour ce ticket ; préserver les modifications des autres intervenants. Aucun changement du site, Android ou dépendance non prévue. Les noms du code sont en anglais et la documentation en français.

## Milestone 2 — Découvrir et écouter sa recommandation du jour

### Description

- **Objectif produit :** rendre utilisable la promesse principale : une découverte musicale personnelle chaque jour, accessible sans compte et reliée à l'écoute.
- **Solution :** relier le client aux contenus existants, recueillir les choix de mesure et les genres, puis afficher une recommandation expliquée dont la fiche conduit vers Spotify ou Apple Music.
- **Logiques ajoutées ou modifiées :** validation des contenus reçus, consentement, conservation des goûts, sélection quotidienne, continuité de navigation, distinction entre ouverture d'un service et lecture effective.
- **Résultat observable :** sur iPhone, une personne termine son choix de goûts, retrouve la même découverte après redémarrage, lit sa fiche et ouvre son service d'écoute, y compris si elle refuse la mesure.

### Issue — Lire les contrats musicaux existants depuis Swift

- **Référence :** P2.1
- **Tier :** tier/2
- **Identité Linear :** créer une issue native.
- **Dépendances :** P1.3 — Ouvrir les trois entrées dans une application SwiftUI.

#### Description

##### Contexte

Swift doit consommer les mêmes données musicales que le client déjà livré, avec des erreurs compréhensibles. La façade backend ne doit pas être réécrite pour changer de langage client. Plan validé : `docs/plans/track1-native-ios.md`, P2.1. Source de transcription : `docs/plans/track1-native-ios-linear.md`.

##### Portée

Créer `ios/Track1/API/APIClient.swift`, `APIModels.swift`, `APIError.swift`, `URLValidation.swift` et `ios/Track1Tests/API/`. Lire `docs/track1-api.md`, `src/mobile/contracts.ts`, `mobile/src/api/contracts.ts`, `mobile/src/api/client.ts`, `mobile/test/api-client.test.ts`, `test/fixtures/mobile-contracts.json`. Raccorder AppContainer. Hors scope : nouvelles routes serveur, schéma musical, persistance offline complète, POST automatique.

##### Contrat

API async URLSession, résultats typés succès/erreur et annulation identifiable. Endpoints existants : GET catalog (ETag/304), nodes/:slug, image, links, search ; POST generations et GET generations/:request_id. Identité canonique `type:slug`, cinq types artist/project/track/genre/label. Catalogue : version v1, revision sha256, taxonomy, nodes(identity/type/name/teaser), edges(source/target/type). Fiche : node(id/type/name/teaser/article/citations/facts/edges/materialized_at), source cache, redirected_from facultatif. Image et liens peuvent être nuls. Rechercher : q/hits/sources ; hit source cache exige slug. Génération : request_id/status/created_at/updated_at, node_id au succès, error(code/message/retryable) au besoin. Codable ne remplace pas validation d'identité/type/UUID/date/URL. HTTPS public sans credentials/port custom ; hôtes Spotify exact `open.spotify.com`, Apple `music.apple.com` ; images/citations respectent les contraintes de `mobile/src/api/contracts.ts`, y compris hôtes privés et redirections suivies par le client.

##### Critères d'acceptation

- [ ] Les fixtures JSON backend sont décodées par Swift et les incompatibilités d'identité/type, URLs dangereuses et champs requis absents sont rejetées.
- [ ] 304 n'est exploité qu'avec une représentation connue ; null/missing facultatif reste distinct de réponse invalide.
- [ ] Timeout, hors réseau, HTTP/code serveur, erreur de décodage et annulation sont distingués ; une réponse périmée ne réécrit pas l'écran.
- [ ] Aucun GET n'appelle le modèle et aucune erreur POST ne déclenche une seconde demande ; contrat vérifié contre le serveur possédé.

##### Tests attendus

XCTest sur fixtures valides/invalides et frontière URLSession via URLProtocol ; intégration avec instance du vrai serveur sur données de test, sans mock de ses services. Reprendre les cas `mobile/test/api-client.test.ts` ; CI XCTest automatique.

##### Tier de risque

tier/2 — review IA et gates requis conservés.

##### Notes d'implémentation

Aucune dépendance tierce ; fournir des méthodes nommées et modèles stables utilisables par profil, fiches et génération. Les endpoints Zod/TypeScript restent propriétaires de la projection serveur ; ne pas éditer cache/ ou web/data.json. Une seule branche/PR pour ce ticket ; préserver les modifications des autres intervenants. Aucun changement du site, Android ou dépendance non prévue. Les noms du code sont en anglais et la documentation en français.

### Issue — Respecter le choix de mesure avec Segment natif

- **Référence :** P2.2
- **Tier :** tier/3
- **Identité Linear :** créer une issue native.
- **Dépendances :** P1.3 — Ouvrir les trois entrées dans une application SwiftUI ; P1.2 — Figer le handoff des seize écrans et de leurs mouvements.

#### Description

##### Contexte

Le client natif mesure uniquement les personnes qui ont choisi la mesure. Ce socle fournit le consentement et les événements typés avant que les parcours ne soient instrumentés. Plan validé : `docs/plans/track1-native-ios.md`, P2.2. Source de transcription : `docs/plans/track1-native-ios-linear.md`.

##### Portée

Créer `ios/Track1/Analytics/AnalyticsClient.swift`, `AnalyticsEvent.swift`, `ConsentStore.swift`, `SegmentAdapter.swift`, `ios/Track1/Features/Privacy/PrivacyChoiceView.swift`, `ios/Track1Tests/Analytics/`, `ios/Track1UITests/ConsentTests.swift`. Modifier AppContainer/RootView et `docs/track1-tracking-plan.md` ; ajouter uniquement `segmentio/analytics-swift` via SPM et version exacte verrouillée dans `ios/Track1.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`. Références : `mobile/src/analytics/contracts.ts`, `client.ts`, `consent.ts`, `storage.ts`, `mobile/test/analytics.test.ts`, `mobile/test/consent.test.tsx`. Hors scope : SDK Amplitude, identifiant publicitaire, comptes ou configuration de destinations.

##### Contrat

Choix persistant unknown/granted/denied, présenté avant genres et modifiable en Réglages. Aucun SDK initialisé, événement/file ou télémétrie réseau avant granted. Enveloppe exacte : event_id UUID→Segment messageId, schema_version=1, platform=ios, app_version, build_number chaîne, environment development/preview/production, source app/onboarding/settings/home/search/relation/notification/deeplink, occurred_at UTC, anonymousId aléatoire séparé du profil/push ; userId absent. Taxonomie v1 : app_opened, onboarding_started, onboarding_completed, preferences_updated, daily_recommendation_viewed, daily_recommendation_opened, notification_permission_result, notification_opened, node_viewed, relation_opened, search_submitted, search_result_opened, generation_requested, generation_completed, generation_failed, external_listening_opened et external_listening_failed. Propriétés exactes du tracking plan et des contrats RN, sans nom ajouté. Couper lifecycle/telemetry automatiques, filtrer context/device IDFV et tout IDFA ; aucune recherche brute/goûts/token/secret/erreur brute. Retrait : suspendre envois, vider file et identité ; accord suivant crée une autre identité, aucun rattrapage. Absence write key : mode collecte indisponible sans bloquer le produit. Figma consentement 31:2, réglages32:136.

##### Critères d'acceptation

- [ ] Unknown/denied ne produisent aucun trafic Segment ni stockage d'événements ; les parcours restent accessibles.
- [ ] Accord initialise une seule fois le SDK avec le bon environnement, schéma typé et allowlist ; aucun SDK Amplitude.
- [ ] Retrait pendant une émission/flush stoppe les nouvelles émissions et purge la file ; réouverture/accord tardif ne réexpédient pas l'historique.
- [ ] Toutes les propriétés interdites sont rejetées avant enqueue ; lifecycle app_opened dédupliqué sur vraie transition foreground, pas sur recomposition.

##### Tests attendus

XCTest : validation des17 contrats/enveloppe, état de consentement, files/identité et concurrence retrait. XCUITest : accord/refus/modification sans blocage. Interception réseau réelle de l'adaptateur SDK pour unknown/refus/retrait ; frontière Segment seule substituée dans tests déterministes.

##### Tier de risque

tier/3 — review approfondie automatisée du SHA final et gates requis conservés.

##### Notes d'implémentation

tier/3 données personnelles/dépendance native. Choisir une release stable compatible Swift 6.3/iOS 17 et verrouiller sa version/révision réellement résolue, pas une branche flottante. Chaque ticket de feature ajoute ensuite son propre événement et test. Consentement notifications indépendant. Une seule branche/PR pour ce ticket ; préserver les modifications des autres intervenants. Aucun changement du site, Android ou dépendance non prévue. Les noms du code sont en anglais et la documentation en français.

### Issue — Choisir et gérer ses goûts uniquement sur l'iPhone

- **Référence :** P2.3
- **Tier :** tier/3
- **Identité Linear :** créer une issue native.
- **Dépendances :** P2.1 — Lire les contrats musicaux existants depuis Swift ; P2.2 — Respecter le choix de mesure avec Segment natif.

#### Description

##### Contexte

La recommandation doit partir de goûts conservés seulement sur l'iPhone. L'onboarding et les réglages forment une seule unité vérifiable avec la persistance et son effacement. Plan validé : `docs/plans/track1-native-ios.md`, P2.3. Source de transcription : `docs/plans/track1-native-ios-linear.md`.

##### Portée

Créer `ios/Track1/Profile/Profile.swift`, `ProfileStore.swift`, `ios/Track1/Persistence/LocalStore.swift`, `ios/Track1/Features/Onboarding/OnboardingView.swift`, `ios/Track1/Features/Settings/SettingsView.swift`, tests profil/onboarding. Références `mobile/src/profile/model.ts`, `mobile/src/profile/store.ts`, `mobile/test/profile.test.ts`, `mobile/test/onboarding.test.tsx`. Raccorder AppContainer/RootView ; lire Figma 31:27, 32:136, 35:326 et handoff. Hors scope : compte, migration AsyncStorage, envoi des goûts, stockage cloud.

##### Contrat

Profil version1 : local_id UUID aléatoire, genre_ids identités genre, revision entier positif, onboarding_completed booléen, flow_id UUID ; brouillon distinct jusqu'à validation. Trois genres minimum ; si un/deux disponibles, sélectionner tous ; zéro genre : retry ou accès Recherche sans profil. JSON atomique sérialisé dans Application Support, protection iOS et exclusion backup ; pas de fichiers musicaux en Keychain. Modification confirmée augmente revision ; annulation ne modifie pas le profil. Effacement invalide les opérations en vol et supprime profil/brouillon, puis les données des modules enregistrés au fil de leur livraison. Choix analytics/push distincts. Événements après accord : onboarding_started(flow_id) une fois par flux visible ; onboarding_completed(flow_id,genres_count) après écriture ; preferences_updated(genres_count,action updated/cleared).

##### Critères d'acceptation

- [ ] Seuil3 et exceptions0/1/2 passent ; accès à l'onglet Recherche sans profil ne simule pas encore la recherche future.
- [ ] Brouillon/profil survivent à la relance ; écriture échouée ne marque pas l'onboarding terminé ; corruption n'entraîne pas de crash.
- [ ] Modifier/annuler/effacer donnent le résultat attendu, une réponse tardive ne recrée jamais un profil effacé.
- [ ] Aucun nom/email/genre_ids ne quitte l'app ; événements uniques et sans goût, y compris après reprise et refus.

##### Tests attendus

XCTest stockage réel temporaire : versions, corruption, panne d'écriture, effacement concurrent. XCUITest sélection/retour/reprise/modification/seuil et refus analytics. Cas repris des tests profil/onboarding RN.

##### Tier de risque

tier/3 — review approfondie automatisée du SHA final et gates requis conservés.

##### Notes d'implémentation

tier/3 données locales. Créer un acteur de stockage simple réutilisable ; pas SwiftData/CoreData ni nouveau framework. Texte et nommage code anglais ; tickets/docs français. Une seule branche/PR pour ce ticket ; préserver les modifications des autres intervenants. Aucun changement du site, Android ou dépendance non prévue. Les noms du code sont en anglais et la documentation en français.

### Issue — Lire une fiche et parcourir ses relations

- **Référence :** P2.4
- **Tier :** tier/2
- **Identité Linear :** créer une issue native.
- **Dépendances :** P2.1 — Lire les contrats musicaux existants depuis Swift ; P2.2 — Respecter le choix de mesure avec Segment natif.

#### Description

##### Contexte

La fiche culturelle est le point de départ commun à la recommandation et à l'exploration. Elle doit déjà afficher les cinq types sans créer de contenu à la lecture. Plan validé : `docs/plans/track1-native-ios.md`, P2.4. Source de transcription : `docs/plans/track1-native-ios-linear.md`.

##### Portée

Créer `ios/Track1/Features/Node/NodeView.swift`, `NodeViewModel.swift`, `NodeArticleView.swift`, `NodeRelationsView.swift`, `NodeImageView.swift`, `ios/Track1/Navigation/NavigationContext.swift`, tests Node et navigation ; adapter AppRouter. Références `mobile/app/node/[slug].tsx`, `mobile/src/components/NodeArticle.tsx`, `NodeImage.tsx`, `NodeRelations.tsx`, `mobile/src/navigation/context.ts`, `mobile/test/node-screen.test.tsx`, `mobile/test/node-relations.test.tsx`. Hors scope : enrichissement serveur, HTML exécuté, streaming, création implicite.

##### Contrat

Destination = identité canonique + contexte(source,recommendation_id?,notification_id?). Tronc commun : titre/type/article/citations/image ou remplacement/relations. Alias remplacé par identité canonique tout en gardant retour/contexte. Relation existante ouvre la fiche ; absente affiche l'état à créer, la génération ne sera branchée qu'en P4.3. Article rendu comme texte natif/paragraphes/listes, pas de WebView exécutant du contenu tiers. Sources HTTPS sûres. node_viewed(node_id,node_type,source,contexte) une fois par entrée visible réussie ; relation_opened(from_node_id,node_id,node_type,relation_kind,contexte) une fois par geste. Contexte suit les relations et s'efface au prochain départ indépendant d'onglet.

##### Critères d'acceptation

- [ ] Cinq types, données partielles, image nulle/erreur, article/sources et relations sont lisibles ; aucun GET génératif.
- [ ] Alias/404/panne sont distingués, retour attendu conservé, relation absente sans création.
- [ ] Une requête annulée ou une vue quittée ne produit pas de navigation ni écriture tardive ; sources hostiles bloquées.
- [ ] Événements au bon moment, contexte conservé et recompositions sans doublon ; navigation accessible et texte agrandissable.

##### Tests attendus

XCTest modèles/aliases/URLs/événements ; XCUITest fiche→relation→retour, absent/panne/image, changement d'onglet ; fixtures des5 types et cas des tests RN. Frontières réseau substituées, vrais routeur et modèles natifs testés.

##### Tier de risque

tier/2 — review IA et gates requis conservés.

##### Notes d'implémentation

Aucune librairie de rendu HTML. Les particularités des cinq types sont P4.1 ; ne pas bloquer ce ticket sur elles ni remplir les champs manquants avec le contenu Figma. Une seule branche/PR pour ce ticket ; préserver les modifications des autres intervenants. Aucun changement du site, Android ou dépendance non prévue. Les noms du code sont en anglais et la documentation en français.

### Issue — Ouvrir Spotify ou Apple Music depuis une fiche

- **Référence :** P2.5
- **Tier :** tier/2
- **Identité Linear :** créer une issue native.
- **Dépendances :** P2.4 — Lire une fiche et parcourir ses relations.

#### Description

##### Contexte

La découverte mène à une écoute dans le service habituel de la personne. L'application ne mesure que l'ouverture du service et n'embarque aucun lecteur. Plan validé : `docs/plans/track1-native-ios.md`, P2.5. Source de transcription : `docs/plans/track1-native-ios-linear.md`.

##### Portée

Créer `ios/Track1/Listening/ListeningActions.swift`, `ios/Track1Tests/ListeningTests.swift`, compléter NodeView et ses tests UI. Références `mobile/src/listening/actions.ts`, `mobile/test/listening-actions.test.ts`, `src/mobile/media.ts`. Hors scope : SDK Spotify/Apple Music, connexion, streaming, nouveau résolveur serveur.

##### Contrat

Pour artist/project/track : lien exact HTTPS `open.spotify.com` ou `music.apple.com` retourné par /links prioritaire ; sinon URL de recherche officielle construite à partir du nom et artiste connus avec encodage et libellé « Rechercher sur… ». Sans information suffisante, bouton indisponible explicite. Aucun bouton d'écoute pour genre/label. Validation URL initiale : hôte exact, sans credentials/port arbitraire, schéma HTTPS. iOS ouvre application du service ou son site. external_listening_opened seulement après retour OS accepté : node_id,node_type,provider spotify/apple_music,link_kind exact/search, contexte facultatif. Refus URL = external_listening_failed error_code unsafe_url ; échec OS = open_failed. La navigation ultérieure chez le service n'est pas contrôlée par track1.

##### Critères d'acceptation

- [ ] Exact, fallback encodé, lien absent et genres/labels donnent l'action correcte.
- [ ] Hôte trompeur, credentials, schéma dangereux et port non autorisé sont bloqués avant appel OS.
- [ ] Succès/échec OS produisent UI et événement cohérents, sans affirmer audio_played ni doubler un geste.
- [ ] Le parcours fonctionne sur iPhone avec et sans application du fournisseur ; retour dans track1 conservé.

##### Tests attendus

XCTest frontière ouverture OS sur nominal/hostile/fallback/échec, événements/contexte ; essai physique pour les deux fournisseurs et présence/absence de l'app.

##### Tier de risque

tier/2 — review IA et gates requis conservés.

##### Notes d'implémentation

Pas de nouvelle dépendance. L'ouverture est effectuée par l'API système native ; ne pas ajouter un lecteur ou une WebView de service. Une seule branche/PR pour ce ticket ; préserver les modifications des autres intervenants. Aucun changement du site, Android ou dépendance non prévue. Les noms du code sont en anglais et la documentation en français.

### Issue — Retrouver une découverte stable chaque jour

- **Référence :** P2.6
- **Tier :** tier/2
- **Identité Linear :** créer une issue native.
- **Dépendances :** P2.3 — Choisir et gérer ses goûts uniquement sur l'iPhone ; P2.4 — Lire une fiche et parcourir ses relations ; P2.5 — Ouvrir Spotify ou Apple Music depuis une fiche.

#### Description

##### Contexte

La promesse quotidienne doit rester reconnaissable après redémarrage ou mise à jour des contenus. La sélection reprend la logique existante et ne consomme pas un appel IA. Plan validé : `docs/plans/track1-native-ios.md`, P2.6. Source de transcription : `docs/plans/track1-native-ios-linear.md`.

##### Portée

Créer `ios/Track1/Recommendation/Affinity.swift`, `DailyRecommendationStore.swift`, `DailyRecommendation.swift`, `ios/Track1/Features/Today/TodayView.swift`, `TodayViewModel.swift`, tests Affinity/Daily/Today ; utiliser LocalStore. Références `mobile/src/recommendation/affinity.ts`, `daily.ts`, `mobile/test/affinity.test.ts`, `daily.test.ts`, `today.test.tsx` ; Figma 32:35, 35:275, 35:326. Hors scope : nouveau scoring, profil serveur, bouton autre recommandation.

##### Contrat

Scores +3 genre direct, +1 genre proche, +4 œuvre repère, +3 artiste repère ; trier score puis identité, limiter à 60 ; candidats artist/project/track. Exclure les 40 dernières identités quand possible, sinon recommencer cycle ; index = FNV-1a32 UTF8 de local_id:dateLocale modulo candidats éligibles. Persisté avant affichage : recommendation_id UUID, local_date YYYY-MM-DD, profile_revision, node_id/type/name/teaser/reasons et marqueur d'impression. Même date/révision = même sélection malgré refresh/restart ; révision goûts changeante = recalcul explicite, date déjà visitée de l'historique réutilisée. daily_recommendation_viewed une fois par sélection vraiment affichée ; opened par geste Découvrir avec mêmes identifiants/date ; transmettre contexte à la fiche.

##### Critères d'acceptation

- [ ] Jeux déterministes identiques à RN : scores, ordre, Unicode/hash,60/40 et retour de date/fuseau.
- [ ] La proposition survit au redémarrage ; refresh catalogue ne la remplace pas, modification des goûts la recalcule.
- [ ] Catalogue vide/profil absent/écriture échouée expliqués ; aucune fiche non persistée présentée comme découverte stable.
- [ ] Fiche et écoute accessibles ; affichages répétés ne doublent pas l'impression, aucun appel modèle.

##### Tests attendus

XCTest parité scoring/hash/sélection et stockage réel temporaire, horloge injectée ; XCUITest lancement/restart/modification goûts/fiche/événements et états vides.

##### Tier de risque

tier/2 — review IA et gates requis conservés.

##### Notes d'implémentation

Conserver les scénarios existants ; fonctions pures pour calcul, aucun partage de runtime JS. Le cache offline complet arrive P4.4 ; cet état ne doit pas déclencher de génération. Une seule branche/PR pour ce ticket ; préserver les modifications des autres intervenants. Aucun changement du site, Android ou dépendance non prévue. Les noms du code sont en anglais et la documentation en français.

## Milestone 3 — Recevoir le rappel choisi et revenir à Aujourd'hui

### Description

- **Objectif produit :** aider la personne à revenir chaque jour, avec un rappel qu'elle contrôle et qui ne divulgue pas ses goûts.
- **Solution :** reprendre la planification serveur existante, acheminer les notifications directement par Apple et gérer leur autorisation, leur désactivation et leur ouverture dans le client natif.
- **Logiques ajoutées ou modifiées :** inscription anonyme, fuseau et changement de jeton, rappel à 9 h, traitement des erreurs Apple, prévention des doublons, destination à l'ouverture et retrait du choix.
- **Résultat observable :** la première bêta quotidienne reçoit une vraie notification sur iPhone et ouvre Aujourd'hui à chaud ou à froid ; refuser ou couper les rappels laisse la découverte accessible.

### Issue — Enregistrer séparément les abonnements APNs anonymes

- **Référence :** P3.1
- **Tier :** tier/3
- **Identité Linear :** créer une issue native.
- **Dépendances :** P1.1 — Figer le passage d'Expo au client iOS natif.

#### Description

##### Contexte

Le registre existant accepte seulement des tokens Expo. Le client Swift doit inscrire des tokens Apple sans altérer les abonnements historiques ni collecter les goûts. Plan validé : `docs/plans/track1-native-ios.md`, P3.1. Source de transcription : `docs/plans/track1-native-ios-linear.md`.

##### Portée

Modifier `src/mobile/push-store.ts`, `src/mobile/push-routes.ts`, `src/mobile/router.ts`, `docs/track1-api.md`, `test/mobile/push-store.test.ts`, `test/mobile/push-routes.test.ts`. Nouveau registre runtime `push-apns-subscriptions.json` dans MOBILE_STATE_DIR, hors Git. Hors scope : schéma musical, remplacement destructif du registre Expo, envoi de notifications, auth utilisateur.

##### Contrat

Routes additives `/mobile/v1/push/apns/subscriptions` POST et `/:subscription_id` PUT/DELETE. POST strict ≤8 Kio : subscription_id UUID, device_token chaîne hexadécimale de longueur paire 2 à 512 normalisée minuscule, app_variant preview/production, apns_environment sandbox/production, timezone IANA ; PUT mêmes champs hors ID + enabled booléen. Accepter preview/sandbox, preview/production, production/production seulement. Bearer secret aléatoire de 256 bits, encodé en base64url sur 43 caractères, stocké haché SHA256. Réponse subscription_id/enabled/timezone/activated_local_date. POST 201 ou 200 si même demande/secret ; 409 conflit ; PUT 200,404 absent,401 secret invalide ; DELETE 204 idempotent,401 si existant sans bon secret. Un token partagé dans même variante/environnement désactive ancienne inscription sans dévoiler son ID. Nouveau registre atomique/verrouillé, corruption préservée ; absence de credentials d'envoi ne casse pas lectures musicales.

##### Critères d'acceptation

- [ ] Contrats validés, champs inconnus/format/fuseau/combinaisons refusés ; secret jamais renvoyé/journalisé.
- [ ] POST identique idempotent, mise à jour/retrait protégés, tokens remplacés sans désactiver une autre variante/environnement.
- [ ] Crash/écriture concurrente/corruption préservent les garanties du store ; indisponibilité limitée aux rappels.
- [ ] Registre et routes Expo inchangés, test de compatibilité backend vert ; aucun goût ou identifiant analytics conservé.

##### Tests attendus

Vitest routes réelles avec store temporaire, cas authorization/idempotence/tokencollision/env ; tests atomiques et corruption du store ; npm run check et tests mobile existants.

##### Tier de risque

tier/3 — review approfondie automatisée du SHA final et gates requis conservés.

##### Notes d'implémentation

tier/3 contrat public/données/secret. Réutiliser les invariants du store possédé sans dupliquer une migration de cache musical. Revue approfondie SHA final ; pas de nouvelle dépendance. Une seule branche/PR pour ce ticket ; préserver les modifications des autres intervenants. Aucun changement du site, Android ou dépendance non prévue. Les noms du code sont en anglais et la documentation en français.

### Issue — Acheminer le rappel quotidien directement par Apple

- **Référence :** P3.2
- **Tier :** tier/3
- **Identité Linear :** créer une issue native.
- **Dépendances :** P3.1 — Enregistrer séparément les abonnements APNs anonymes.

#### Description

##### Contexte

Les abonnements natifs doivent recevoir le rappel quotidien via Apple. La planification et les protections existantes sont conservées, le protocole Expo est remplacé pour le nouveau transport. Plan validé : `docs/plans/track1-native-ios.md`, P3.2. Source de transcription : `docs/plans/track1-native-ios-linear.md`.

##### Portée

Créer `src/mobile/apns-sender.ts`, `test/mobile/apns-sender.test.ts` ; modifier `src/mobile/push-schedule.ts`, `src/server.ts`, `src/config.ts`, `src/env.ts`, `deploy/deploy-server.sh`, `test/mobile/push-schedule.test.ts`, `docs/track1-builds.md`. Lire `src/mobile/push-sender.ts`, `push-receipts.ts`. Hors scope : SDK push tiers, push personnalisé, FCM, modification du site, suppression des routes Expo.

##### Contrat

HTTP/2 Node standard, JWT ES256 via crypto ; secrets APNS_KEY_ID/APNS_TEAM_ID/APNS_PRIVATE_KEY_PATH côté serveur, subjects fixes APNS_TOPIC_PREVIEW/APNS_TOPIC_PRODUCTION issus des bundles vérifiés. Feature switch MOBILE_APNS_PUSH_ENABLED séparé de MOBILE_PUSH_ENABLED Expo. Hôtes Apple sandbox/production selon inscription ; JWT mis en cache ≤50 min. Notification alert : titre « track1 — Ta découverte du jour », corps « Une découverte musicale t'attend. Ouvre track1 pour la découvrir. », données kind daily/notification_id/target_local_date/url track1://today ; topic imposé serveur, expiration10h locale, collapse ID opaque abonnement/date. Examen chaque minute,9h≤heure<10h, dès lendemain activation ; date réservée durablement avant envoi, aucun renvoi du jour après résultat ambigu. Purge90 jours inactifs même transport désactivé. Unregistered/token invalide désactive seulement le token/version envoyé ; credential/topic/429/5xx conservés comme erreurs opérationnelles, sans purge globale. Pas de reçus Expo simulés pour Apple.

##### Critères d'acceptation

- [ ] Signature/host/topic/headers/payload corrects ; aucun secret/token brut dans logs.
- [ ] Fuseaux, DST, lendemain activation, fenêtre9–10h, redémarrage et ambiguïté n'entraînent pas de répétition applicative.
- [ ] 410/invalidtoken n'invalide pas un token renouvelé ; panne provider laisse l'app et les inscriptions accessibles.
- [ ] Activation/désactivation APNs réversible, purge inactive toujours exécutée ; Expo coupé globalement avant bêta native officielle.

##### Tests attendus

Vitest frontière HTTP/2/Apple substituée, crypto réelle sur clé test, erreurs/tokens ; vrai scheduler/store sur horloge contrôlée et restart ; smoke déploiement lectureAPI, contrôles secrets. Recette réception physique en P3.3.

##### Tier de risque

tier/3 — review approfondie automatisée du SHA final et gates requis conservés.

##### Notes d'implémentation

tier/3 déploiement/secrets. Envoi accepté par Apple ≠ réception. Aucun retry aveugle, pas de dépendance npm ajoutée. Consigner rollback de configuration sans remettre Expo comme second client officiel. Une seule branche/PR pour ce ticket ; préserver les modifications des autres intervenants. Aucun changement du site, Android ou dépendance non prévue. Les noms du code sont en anglais et la documentation en français.

### Issue — Choisir les rappels et ouvrir la découverte depuis iOS

- **Référence :** P3.3
- **Tier :** tier/3
- **Identité Linear :** créer une issue native.
- **Dépendances :** P1.5 — Installer et archiver un build iOS signé ; P2.6 — Retrouver une découverte stable chaque jour ; P3.1 — Enregistrer séparément les abonnements APNs anonymes ; P3.2 — Acheminer le rappel quotidien directement par Apple.

#### Description

##### Contexte

Après sa première découverte, la personne choisit son rappel et peut revenir à Aujourd'hui depuis une notification. Ce choix est indépendant de la mesure et des goûts. Plan validé : `docs/plans/track1-native-ios.md`, P3.3. Source de transcription : `docs/plans/track1-native-ios-linear.md`.

##### Portée

Créer `ios/Track1/Notifications/NotificationCoordinator.swift`, `PushSubscriptionStore.swift`, `APNsSubscriptionClient.swift`, tests notifications ; modifier App/Settings/Navigation et entitlements si nécessaire. Références `src/mobile/push-routes.ts`, `src/mobile/push-schedule.ts`, `docs/track1-api.md`, `docs/track1-tracking-plan.md`, Figma 31:69 et 32:136. Hors scope : notifications silencieuses, calendrier configurable, rappels locaux parallèles, nouveaux événements.

##### Contrat

Invitation après première carte affichée ; permission système uniquement sur action, pas de relance intrusive après refus. UNUserNotificationCenter + enregistrement APNs ; les octets token sont encodés en hex sans supposer longueur fixe. subscription_id UUID + secret de 256 bits Keychain non synchronisé ; token/env/variant/fuseau au contrat APNs. Réconcilier permission système, token et fuseau au foreground ; retrait offline conservé en action pending, UI n'annonce pas suppression serveur tant que non acquittée. Événement notification_permission_result, propriété status granted/denied/undetermined seulement après accord analytics. Payload daily validé, notification ancienne ouvre jour courant ; conserver intention après onboarding ; notification_opened(notification_id,target_local_date) une fois par ouverture, jamais à simple réception. Secret/token n'entrent pas dans événements.

##### Critères d'acceptation

- [ ] Refus des push laisse recommandation/écoute accessibles et n'active pas d'abonnement.
- [ ] Token/fuseau changés, permission révoquée dans iOS, retrait offline/retry et reactivation lendemain se synchronisent correctement.
- [ ] Notification réelle reçue sur iPhone signé, ouverte chaud/arrière-plan/à froid et après onboarding vers Aujourd'hui.
- [ ] Callback répété ne duplique ni navigation ni événement ; environnement APNs TestFlight production vérifié.

##### Tests attendus

XCTest frontières notification/Keychain/API, store réel temporaire et scénarios concurrentiels ; XCUITest invitation/réglages/intention ; recette physique datée avec appareil/build, vrais envois et refus analytics.

##### Tier de risque

tier/3 — review approfondie automatisée du SHA final et gates requis conservés.

##### Notes d'implémentation

tier/3 secret et permission. Pas de preuve push déduite d'un test simulateur. Keychain indisponible = état explicite, ne pas inscrire un abonnement irrécupérable. Une seule branche/PR pour ce ticket ; préserver les modifications des autres intervenants. Aucun changement du site, Android ou dépendance non prévue. Les noms du code sont en anglais et la documentation en français.

## Milestone 4 — Explorer les contenus et créer une fiche manquante

### Description

- **Objectif produit :** prolonger la découverte au-delà de la recommandation et garder une exploration utile malgré les interruptions ordinaires du téléphone.
- **Solution :** afficher les particularités de chaque fiche, proposer la recherche, rendre la création explicite et conserver les contenus consultés ainsi que les destinations de navigation.
- **Logiques ajoutées ou modifiées :** détails par type, recherche locale/en ligne, résultats disponibles ou à créer, suivi d'une génération, reprise après fermeture, liens directs, conservation et effacement des données musicales locales.
- **Résultat observable :** une personne trouve un sujet, ouvre ou crée sa fiche, suit ses relations et relit des contenus conservés hors ligne, sans création implicite ni coût répété après une interruption.

### Issue — Présenter les particularités des cinq types de fiches

- **Référence :** P4.1
- **Tier :** tier/2
- **Identité Linear :** créer une issue native.
- **Dépendances :** P2.4 — Lire une fiche et parcourir ses relations.

#### Description

##### Contexte

Les cinq familles de contenus ne racontent pas la même chose. Le client affiche leurs particularités à partir des données réellement disponibles, avec la présentation Figma. Plan validé : `docs/plans/track1-native-ios.md`, P4.1. Source de transcription : `docs/plans/track1-native-ios-linear.md`.

##### Portée

Créer dans `ios/Track1/Features/Node/` `ArtistDetailsView.swift`, `ProjectDetailsView.swift`, `TrackDetailsView.swift`, `GenreDetailsView.swift`, `LabelDetailsView.swift` ; raccorder NodeView et tests `ios/Track1Tests/NodeDetailsTests.swift`. Références complètes `mobile/src/components/ArtistDetails.tsx`, `ProjectDetails.tsx`, `TrackDetails.tsx`, `GenreDetails.tsx`, `LabelDetails.tsx`, `mobile/test/work-details.test.tsx`, `mobile/test/genre-label-details.test.tsx`. Hors scope : nouveau schéma, faits fabriqués, lecteur.

##### Contrat

Données = facts/edges validés du Node API. Artiste : biographie/genres/discographie ; projet : artistes, album/EP/single si connu sinon « projet » ; titre : artistes/projets reliés ; genre : origines, voisins et repères ; label : contexte/catalogue/repères. Sections vides absentes, ordre et libellés alignés sur les cas RN existants et le handoff. Chaque relation conserve navigation/context du socle. Figma 34:144, 34:197, 34:246, 34:294, 34:338 ; aucun contenu d'exemple hardcodé.

##### Critères d'acceptation

- [ ] Les5 types s'affichent avec données complètes/partielles/absentes, sans crash ou bloc vide.
- [ ] Inconnu reste inconnu ; album/EP/single/projet correctement nommés sans forcer un exemple Figma.
- [ ] Les relations ouvrent la bonne fiche et reviennent correctement, sans ajouter d'événement aux simples recompositions.
- [ ] Texte à taille d'accessibilité, ordre VoiceOver et cibles44 pt restent utilisables.

##### Tests attendus

XCTest projection/sections selon5fixtures et valeurs inconnues ; XCUITest fiches/relations et texte agrandi. Réutiliser scénarios work-details/genre-label-details.

##### Tier de risque

tier/2 — review IA et gates requis conservés.

##### Notes d'implémentation

tier/2 présentation avec état. Une PR cohérente sur les cinq projections ; réexaminer la taille si>1 000 lignes sans retirer les tests. Aucun modèle serveur modifié. Une seule branche/PR pour ce ticket ; préserver les modifications des autres intervenants. Aucun changement du site, Android ou dépendance non prévue. Les noms du code sont en anglais et la documentation en français.

### Issue — Rechercher les cinq types de contenus

- **Référence :** P4.2
- **Tier :** tier/2
- **Identité Linear :** créer une issue native.
- **Dépendances :** P2.1 — Lire les contrats musicaux existants depuis Swift ; P2.2 — Respecter le choix de mesure avec Segment natif ; P2.4 — Lire une fiche et parcourir ses relations.

#### Description

##### Contexte

La recherche permet d'explorer librement sans attendre la recommandation. Un résultat absent doit proposer sa création sans la lancer automatiquement. Plan validé : `docs/plans/track1-native-ios.md`, P4.2. Source de transcription : `docs/plans/track1-native-ios-linear.md`.

##### Portée

Créer `ios/Track1/Features/Search/SearchView.swift`, `SearchViewModel.swift`, `SearchResultsView.swift`, `ios/Track1Tests/SearchTests.swift`, tests UI ; références `src/mobile/search.ts`, `mobile/src/components/SearchResults.tsx`, `mobile/test/search.test.tsx`, `test/mobile/search.test.ts`, Figma 32:69. Hors scope : nouvelle API recherche, génération implicite, stockage analytics du texte.

##### Contrat

GET search q de 2 à 120 caractères après trim, debounce 300 ms, filtres all/artist/project/track/genre/label ; limite par défaut de 8, maximum de 25 côtéAPI. Une requête logique possède un identifiant ; changement de saisie/filtre ou sortie annule/ignore l'ancienne réponse. Hits source cache avec slug = disponibles ; catalogue absent = proposition explicite de créer. search_submitted(filter) une fois par requête réellement appliquée ; search_result_opened(node_type,availability cached/missing,results_count,node_id? public). Aucun q dans événements. P4.4 branchera la recherche locale persistée.

##### Critères d'acceptation

- [ ] Saisie invalide n'envoie pas, temporisation/filtre/retry donnent les résultats attendus.
- [ ] Réponse obsolète jamais substituée à la nouvelle ; vide/panne/changement de filtre lisibles.
- [ ] Résultat disponible ouvre Node ; absent présente création sans POST.
- [ ] Événements exacts sans query, aucun doublon après recomposition et refus analytics respecté.

##### Tests attendus

XCTest horloge et sessions réseau contrôlées pour temporisation, courses et annulation et événements ; XCUITest clavier,filtres,vide,erreur,ouverture ; cas des testsRN et route serveur conservés.

##### Tier de risque

tier/2 — review IA et gates requis conservés.

##### Notes d'implémentation

tier/2. Conserver les cinq filtres même si la capture illustrative n'en montre que trois. Ne pas retarder l'UI derrière une animation. Une seule branche/PR pour ce ticket ; préserver les modifications des autres intervenants. Aucun changement du site, Android ou dépendance non prévue. Les noms du code sont en anglais et la documentation en français.

### Issue — Créer une fiche sur demande et reprendre son suivi

- **Référence :** P4.3
- **Tier :** tier/2
- **Identité Linear :** créer une issue native.
- **Dépendances :** P4.2 — Rechercher les cinq types de contenus ; P2.4 — Lire une fiche et parcourir ses relations.

#### Description

##### Contexte

La personne peut demander une fiche manquante sans risquer plusieurs générations au double appui ou après une coupure. Le suivi continue côté serveur quand l'écran est quitté. Plan validé : `docs/plans/track1-native-ios.md`, P4.3. Source de transcription : `docs/plans/track1-native-ios-linear.md`.

##### Portée

Créer `ios/Track1/Generation/GenerationStore.swift`, `GenerationCoordinator.swift`, `ios/Track1/Features/Generation/GenerationView.swift`, tests ; raccorder Search/Node. Références `src/mobile/generation-routes.ts`, `generation-service.ts`, `generation-store.ts`, `mobile/src/generation/request.ts`, `store.ts`, `status.tsx`, `mobile/test/generation.test.tsx`, `test/mobile/generation.test.ts`. Hors scope : nouveau endpoint, progressions inventées, nouvelle génération automatique.

##### Contrat

Persister request_id UUID et type/name/slug?/mbid?/qid?/disambiguator? avant POST generations ; un double geste actif réutilise la demande. Succès 200 immédiat ou 202 suivi : GET generations/:id toutes les 2 secondes au premier plan seulement, même UUID après relance. États queued/running/succeeded/failed/interrupted, expiration 410 ; succeeded exige node_id canonique ; erreur publique code/message/retryable. Une ambiguïté réseau ne justifie jamais un nouveau POST. Une nouvelle création après terminal exige un nouveau geste. Le serveur garde ses limites de 2 traitements actifs et 10 demandes en attente et sa rétention 24 h. Événements : generation_requested(request_id,node_type) après écriture durable ; generation_completed(request_id,node_id,node_type) ; generation_failed(request_id,node_type,error_code failed/interrupted/expired). Le terminal est dédupliqué durablement. Afficher les codes réels de quota/saturation/panne, jamais « étape 2/3 ».

##### Critères d'acceptation

- [ ] Double appui et relance ne créent pas deux demandes ; une erreur d'écriture interdit le POST.
- [ ] Succès 200/202, tous les états,410,429,quota et panne réseau sont distingués ; une panne de suivi seule n'émet pas un échec terminal.
- [ ] Le background arrête le polling et le retour reprend le même UUID ; quitter l'écran ne prétend pas annuler le serveur.
- [ ] Le succès ouvre la fiche canonique et rafraîchit le catalogue ; événements uniques, tâches annulables pour l'effacement local.

##### Tests attendus

XCTest sur le vrai store, horloge et transport externe contrôlés : double appui, relance, réponse ambiguë, terminal unique. XCUITest recherche→demande→suivi→fiche et erreurs. Conserver les tests de contrat du serveur.

##### Tier de risque

tier/2 — review IA et gates requis conservés.

##### Notes d'implémentation

tier/2 client seulement. UUID durable avant le POST, identité de mesure distincte. Figma 35:260 et 35:308 ; utiliser les états réels du serveur. Une seule branche/PR pour ce ticket ; préserver les modifications des autres intervenants. Aucun changement du site, Android ou dépendance non prévue. Les noms du code sont en anglais et la documentation en français.

### Issue — Relire les contenus hors ligne et effacer leurs traces locales

- **Référence :** P4.4
- **Tier :** tier/3
- **Identité Linear :** créer une issue native.
- **Dépendances :** P2.3 — Choisir et gérer ses goûts uniquement sur l'iPhone ; P2.6 — Retrouver une découverte stable chaque jour ; P4.2 — Rechercher les cinq types de contenus ; P4.3 — Créer une fiche sur demande et reprendre son suivi.

#### Description

##### Contexte

Une coupure réseau ne doit pas retirer les contenus déjà vus. L'effacement des données musicales doit aussi empêcher leur retour par une requête qui se termine tard. Plan validé : `docs/plans/track1-native-ios.md`, P4.4. Source de transcription : `docs/plans/track1-native-ios-linear.md`.

##### Portée

Créer `ios/Track1/Persistence/CatalogCache.swift`, `NodeCache.swift`, `MusicalDataReset.swift`, tests offline/reset ; raccorder API/Profile/Today/Search/Node/Generation et Settings. Références vérifiées `mobile/src/cache/catalog.ts`, `nodes.ts`, `mobile/test/offline-cache.test.ts`, `offline-journey.test.tsx`, `mobile/src/profile/store.ts`, `mobile/src/generation/store.ts`. Hors scope : suppression du cache serveur, changement consentement analytics/push, téléchargement audio.

##### Contrat

Catalogue JSON versionné avec ETag/checkedAt, revalidation au premier plan au plus toutes les 6 h et après génération ; transaction sérialisée empêchant un 304 tardif d'écraser un rafraîchissement. 50 fiches maximum, éviction LRU, touchedAt/checkedAt/aliases, fraîcheur 24 h et protection de la fiche du jour dans le quota. Données anciennes affichées avec date ; revalidation sans vider la vue. Images associées bornées et effaçables. Hors réseau : recherche dans le catalogue local, lecture des fiches conservées, génération indisponible. Absence/corruption de cache = reprise explicite. L'action « Effacer mon profil musical et les contenus conservés » supprime goûts, brouillon, recommandations, historique, fiches, catalogue, images et demandes. Invalider les opérations en vol avant la purge pour interdire leurs écritures et événements tardifs. Ne pas prétendre annuler une génération serveur ; préserver et expliquer les choix push/analytics séparés.

##### Critères d'acceptation

- [ ] Lecture hors ligne après fermeture et recherche locale fonctionnent ; limites, fraîcheur, alias et protection quotidienne respectés.
- [ ] Panne, corruption et absence de cache sont explicites, sans boucle de création ; la revalidation garde le contenu affiché.
- [ ] L'effacement persiste après relance et réponse tardive ; aucune image, fiche ou demande ne revient.
- [ ] Les rafraîchissements concurrents ne perdent pas les données récentes ; les choix de consentement restent distincts.

##### Tests attendus

XCTest sur stockage temporaire : éviction, fraîcheur,304 concurrent, corruption, purge pendant requête. XCUITest mode avion→relance→recherche locale→effacement→reconnexion. Porter les scénarios TRA-312 livrés dans 85a5b8e.

##### Tier de risque

tier/3 — review approfondie automatisée du SHA final et gates requis conservés.

##### Notes d'implémentation

tier/3 données personnelles. Aucun pont AsyncStorage : fichiers natifs et parité des scénarios React Native. Aucun traitement des données du site. Une seule branche/PR pour ce ticket ; préserver les modifications des autres intervenants. Aucun changement du site, Android ou dépendance non prévue. Les noms du code sont en anglais et la documentation en français.

### Issue — Retrouver la bonne fiche depuis un lien track1

- **Référence :** P4.5
- **Tier :** tier/2
- **Identité Linear :** créer une issue native.
- **Dépendances :** P2.4 — Lire une fiche et parcourir ses relations ; P3.3 — Choisir les rappels et ouvrir la découverte depuis iOS.

#### Description

##### Contexte

Les liens track1 doivent retrouver une fiche ou Aujourd'hui sans perdre l'intention pendant l'onboarding. Les destinations inconnues ne doivent déclencher aucun effet payant. Plan validé : `docs/plans/track1-native-ios.md`, P4.5. Source de transcription : `docs/plans/track1-native-ios-linear.md`.

##### Portée

Créer `ios/Track1/Navigation/DeepLinkRouter.swift` et ses tests ; modifier AppRouter, Info.plist et la déclaration du schéma URL du projet. Références `mobile/src/navigation/context.ts`, `mobile/test/navigation.test.tsx`, `docs/track1-api.md`. Hors scope : Universal Links, association de domaine, Android et nouveaux schémas.

##### Contrat

Autoriser uniquement track1://today et track1://node/<identité canonique encodée>. Décoder une fois, valider type:slug comme l'API ; refuser credentials, segments ajoutés, query/fragment non prévus. Conserver une intention pending pendant consentement/onboarding ; la dernière action explicite remplace la précédente. Notification = contexte notification de P3.3 ; lien externe = source deeplink. Alias résolu par l'API,404 explicite sans POST. Retour vers la pile attendue ; prochain départ indépendant d'onglet efface l'attribution.

##### Critères d'acceptation

- [ ] Ouvertures à chaud/froid des deux formats, après onboarding et alias, atteignent la destination attendue.
- [ ] Lien malformé, double encodage, schéma inconnu ou hostile refusés sans crash, génération ou route audio.
- [ ] Deux intentions pendant le bootstrap aboutissent à la dernière ; callbacks répétés sans double navigation.
- [ ] Contexte des fiches, notifications et onglets ainsi que retours respectent le contrat.

##### Tests attendus

XCTest sur table d'URLs valides/invalides et arbitrage des intentions. XCUITest ouverture externe à froid/chaud/onboarding, alias,404,retour ; contrôle physique par lien valide.

##### Tier de risque

tier/2 — review IA et gates requis conservés.

##### Notes d'implémentation

tier/2 navigation. Déclarer seulement le schéma custom ; aucun fichier web d'association de domaine. Une seule branche/PR pour ce ticket ; préserver les modifications des autres intervenants. Aucun changement du site, Android ou dépendance non prévue. Les noms du code sont en anglais et la documentation en français.

## Milestone 5 — Vivre une expérience fidèle au design et mesurable

### Description

- **Objectif produit :** obtenir l'expérience iPhone finale et savoir que ses usages sont mesurés correctement avant d'inviter plus largement.
- **Solution :** affiner les transitions sur les parcours terminés, rendre les choix de confidentialité consultables, vérifier l'arrivée des événements dans les analyses puis éprouver les seize écrans et les parcours intégrés sur appareil.
- **Logiques ajoutées ou modifiées :** animations et interruptions, accessibilité, information sur les données, consentement effectif, attribution des événements, séparation des environnements et mesure du retour quotidien.
- **Résultat observable :** le candidat natif suit la référence Figma, fonctionne avec VoiceOver, texte agrandi et mouvements réduits, et fournit des analyses iOS vérifiées sans enregistrer les usages refusés.

### Issue — Affiner les animations et leurs variantes accessibles

- **Référence :** P5.1
- **Tier :** tier/2
- **Identité Linear :** créer une issue native.
- **Dépendances :** P2.6 — Retrouver une découverte stable chaque jour ; P3.3 — Choisir les rappels et ouvrir la découverte depuis iOS ; P4.1 — Présenter les particularités des cinq types de fiches ; P4.2 — Rechercher les cinq types de contenus ; P4.3 — Créer une fiche sur demande et reprendre son suivi ; P4.4 — Relire les contenus hors ligne et effacer leurs traces locales ; P4.5 — Retrouver la bonne fiche depuis un lien track1 ; P1.2 — Figer le handoff des seize écrans et de leurs mouvements.

#### Description

##### Contexte

Les parcours sont livrés avec le design ; cette repasse coordonne leurs mouvements et leur comportement accessible. Une transition ne doit jamais bloquer une action ni répéter un événement. Plan validé : `docs/plans/track1-native-ios.md`, P5.1. Source de transcription : `docs/plans/track1-native-ios-linear.md`.

##### Portée

Modifier `ios/Track1/DesignSystem/` et les vues Today/Onboarding/Privacy/Settings/Node/Search/Generation/Notifications ; compléter tests UI et `docs/track1-design.md`. Hors scope : nouvelles fonctionnalités, framework d'animation, redesign ou API serveur.

##### Contrat

Appliquer la matrice versionnée du handoff : entrée, sélection, sheet, navigation, chargement et résultat. Navigation/sheet système ; mouvement manquant : micro-interaction de 150 ms, fondu de 200 ms ; Reduce Motion : fondu de 100 ms ou immédiat. Variantes Reduce Transparency et Dynamic Type. Animations annulables à retour, changement d'onglet et background ; état métier indépendant de fin d'animation. Matériaux Liquid Glass iOS 26+, standard iOS 17/18. Cibles≥44 pt, focus VoiceOver conservé et état terminal annoncé sans répétition. Pas de double action ou analytics à chaque recomposition.

##### Critères d'acceptation

- [ ] Chaque ligne de la matrice possède une réalisation normale/réduite et une preuve vidéo.
- [ ] Double appui, retour, changement d'onglet et background en transition ne bloquent aucune action ni ne doublent les événements.
- [ ] Aucune animation de chargement persiste après état terminal ; toutes les commandes essentielles restent accessibles.
- [ ] Trace Instruments sur iPhone réel : aucun blocage main thread >100 ms imputable aux transitions ; VoiceOver et transparence réduite utilisables.

##### Tests attendus

XCTest états/interruption et déduplication ; XCUITest gestes répétés/Reduce Motion ; captures vidéo et trace Instruments datées avec modèle/iOS/build. Vérifier les16 écrans et les tests fonctionnels affectés.

##### Tier de risque

tier/2 — review IA et gates requis conservés.

##### Notes d'implémentation

tier/2, pas de dépendance supplémentaire. Les durées sont des paramètres UX, pas des estimations. En cas d'effet impossible sous iOS 17, employer le repli déjà défini, pas relever le minimum. Une seule branche/PR pour ce ticket ; préserver les modifications des autres intervenants. Aucun changement du site, Android ou dépendance non prévue. Les noms du code sont en anglais et la documentation en français.

### Issue — Rendre la confidentialité compréhensible et accessible

- **Référence :** P5.2
- **Tier :** tier/3
- **Identité Linear :** réemployer TRA-317.
- **Dépendances :** P2.2 — Respecter le choix de mesure avec Segment natif ; P2.3 — Choisir et gérer ses goûts uniquement sur l'iPhone ; P3.3 — Choisir les rappels et ouvrir la découverte depuis iOS ; P4.4 — Relire les contenus hors ligne et effacer leurs traces locales.

#### Description

##### Contexte

La personne et Apple doivent comprendre quelles données existent, où elles restent et comment arrêter la collecte. La politique publique doit correspondre au comportement natif testé. Plan validé : `docs/plans/track1-native-ios.md`, P5.2. Source de transcription : `docs/plans/track1-native-ios-linear.md`.

##### Portée

Créer `docs/track1-privacy.md`, `src/mobile/privacy.ts`, `test/mobile/privacy.test.ts`, `ios/Track1/Features/Privacy/PrivacyPolicyView.swift` et tests ; modifier `src/mobile/router.ts`, les liens consentement/réglages et `ios/Track1/Resources/PrivacyInfo.xcprivacy`. Hors scope : fichiers/interface web, avis juridique inventé, tracking supplémentaire, suppression rétroactive automatisée chez les fournisseurs.

##### Contrat

Servir GET /mobile/v1/privacy en HTML statique échappé, UTF-8, accessible sans compte en HTTPS ; contenu versionné dans docs, liens sûrs. Décrire profil et fichiers locaux exclus du backup, génération serveur, abonnement APNs secret haché/token/fuseau/rétention90 jours, consentement Segment→Amplitude, propriétés et durée réellement configurée, retrait/file purgée et différence avec effacement antérieur. Contact et responsable issus des comptes réels, aucune valeur factice. Privacy manifest et déclarations App Store reflètent SDK/APIs réellement utilisés ; aucun ID publicitaire, compte ou lecture audio suggéré. Les réglages permettent de lire la politique et de changer séparément mesure/rappel/profil.

##### Critères d'acceptation

- [ ] URL publique répond200 sans cookie ni login, est ouvrable depuis choix initial/réglages et utilisable dans App Store Connect.
- [ ] Toutes les catégories/durées/destinataires/contact sont réconciliés avec l'app et les comptes réels ; aucune promesse d'effacement non réalisée.
- [ ] Manifeste de confidentialité et déclarations Apple cohérents avec la version du SDK Segment et les APIs effectivement appelées.
- [ ] Aucun fichier web ni ancienne route modifié ; données tierces ou texte ne peuvent injecter du HTML.

##### Tests attendus

Vitest route réelle et contenu/échappement/liens, smoke HTTPS public ; XCTest/XCUITest accès depuis consentement et réglages ; inspection du manifeste embarqué et revue des déclarations contre traces réseau.

##### Tier de risque

tier/3 — review approfondie automatisée du SHA final et gates requis conservés.

##### Notes d'implémentation

tier/3 confidentialité/contrat public. Si contact réel ou accès fournisseur manque, consigner ce prérequis opérationnel au lieu de publier un placeholder. Les exigences Apple applicables sont revérifiées à la soumission. Une seule branche/PR pour ce ticket ; préserver les modifications des autres intervenants. Aucun changement du site, Android ou dépendance non prévue. Les noms du code sont en anglais et la documentation en français.

### Issue — Vérifier Segment vers Amplitude et les indicateurs iOS

- **Référence :** P5.3
- **Tier :** tier/3
- **Identité Linear :** réemployer TRA-315.
- **Dépendances :** P1.5 — Installer et archiver un build iOS signé ; P2.2 — Respecter le choix de mesure avec Segment natif.
- **Preuves avant clôture :** P3.3 — Choisir les rappels et ouvrir la découverte depuis iOS ; P4.3 — Créer une fiche sur demande et reprendre son suivi.

#### Description

##### Contexte

La présence de méthodes track ne prouve pas la mesure du produit. Il faut vérifier la chaîne native jusqu'aux analyses et exclure la population de test des résultats de lancement. Plan validé : `docs/plans/track1-native-ios.md`, P5.3. Source de transcription : `docs/plans/track1-native-ios-linear.md`.

##### Portée

Modifier `docs/track1-tracking-plan.md`, créer `ios/Track1Tests/Analytics/AnalyticsJourneyTests.swift` ; configurer les sources Apple Segment et destination Amplitude Actions des environnements autorisés. Hors scope : second SDK, événements supplémentaires, relance de collecte refusée, objectif de rétention inventé.

##### Contrat

Sources développement/preview distinctes de production, Amplitude Actions cloud mode seul ; anonymousId aléatoire→device_id, messageId→insert_id et occurred_at→timestamp. Propriétés exactes du contrat v1,17 événements de app_opened à external_listening_failed ; utilisateur identifié absent. Rapports : onboarding_completed par flux/onboarding_started, daily_recommendation_viewed→node_viewed→external_listening_opened via recommendation_id, rétention J1/J7 par jour local défini et population consentante, parcours notification_opened, générations completed/failed/requested. Filtrer iOS/environment/version et exclure les données internes. Les tests peuvent simuler dates J1/J7 ; aucun délai réel n'est un prérequis. Les noms et liens exacts des sources/destinations/dashboards réels sont consignés.

##### Critères d'acceptation

- [ ] Les17 événements issus du binaire natif arrivent une seule fois dans Segment et Amplitude avec propriétés autorisées et bonne identité.
- [ ] Refus, retrait et accord tardif n'expédient aucun événement interdit ou rétroactif ; traces réseau et destinations concordent.
- [ ] Jeu de recette connu reproduit les comptes attendus pour chaque indicateur ; population publique ne contient pas de testeurs preview.
- [ ] Les rapports distinguent ouverture de service/lecture audio et acceptation APNs/réception ; aucun taux ouvert/reçu non mesuré.

##### Tests attendus

Tests de parcours XCTest avec collecteur externe contrôlé ; émissions de recette réelles Segment/Amplitude, captures d'événements expurgées des secrets et calculs comparés au jeu attendu. P3.3 et P4.3 doivent être livrés avant clôture complète.

##### Tier de risque

tier/3 — review approfondie automatisée du SHA final et gates requis conservés.

##### Notes d'implémentation

tier/3 données/configuration externe. Démarrage après P1.5/P2.2, parallélisable aux features ; attente des preuves push/génération uniquement pour clôture. Write keys publiques, admin keys hors dépôt. Ne jamais simuler une preuve d'accès absent. Une seule branche/PR pour ce ticket ; préserver les modifications des autres intervenants. Aucun changement du site, Android ou dépendance non prévue. Les noms du code sont en anglais et la documentation en français.

### Issue — Valider les seize écrans et les parcours natifs intégrés sur iPhone

- **Référence :** P5.4
- **Tier :** tier/1
- **Identité Linear :** réemployer TRA-331.
- **Dépendances :** P1.4 — Vérifier le client Swift à chaque changement ; P5.1 — Affiner les animations et leurs variantes accessibles ; P5.2 — Rendre la confidentialité compréhensible et accessible ; P5.3 — Vérifier Segment vers Amplitude et les indicateurs iOS.

#### Description

##### Contexte

La recette transverse prouve que le client final réalise les parcours et le design ensemble. Une preuve React Native ou une compilation ne certifie pas l'expérience iPhone native. Plan validé : `docs/plans/track1-native-ios.md`, P5.4. Source de transcription : `docs/plans/track1-native-ios-linear.md`.

##### Portée

Créer `docs/track1-native-qa.md`, compléter `docs/track1-native-release.md` et `ios/Track1UITests/` (DailyJourneyTests, ExplorationTests, ResilienceTests, AccessibilityTests). Référence `docs/track1-design.md`, exports `docs/design/track1/manifest.json`, tracking plan. Hors scope : refonte ou correction métier sans ticket responsable, Android, nouveaux critères de fonctionnalité.

##### Contrat

Matrice16 écrans × états du handoff, clair/sombre, petit/grand iPhone ; iOS 17 et stable courant, version exacte/appareil/build/SHA/preuve/résultat. Tester vraie archive sur au moins un iPhone physique, performance sur le plus ancien compatible disponible, et exécution iOS 17 sur runtime/appareil compatible. Scénarios : goûts→jour→push→fiche→relation→service,5 types, recherche, génération/expiration/quota, offline, effacement pendant requête, liens invalides, refus/retrait analytics, permission push et ouverture chaud/froid/background. Accessibilité : VoiceOver, taille de texte maximale, Reduce Motion/Transparency ; tous boutons atteignables. Défaut bloquant = crash, perte de données, collecte interdite, parcours essentiel inaccessible ou écart visuel non justifié aux références.

##### Critères d'acceptation

- [ ] 16/16 écrans possèdent capture du candidat et comparaison aux exports ; variantes/écarts explicités sans preuve manquante critique.
- [ ] Tous les scénarios intégrés passent ; chaque échec corrigé possède test de non-régression et nouvelle preuve du build affecté.
- [ ] VoiceOver, texte agrandi, mouvement/transparence réduits utilisables, aucun bouton principal masqué ou chevauché.
- [ ] Les preuves design, événements et push désignent le même candidat ; aucune recette Android requise ni test RN assimilé à Swift.

##### Tests attendus

XCUITest transverse avec frontières externes contrôlées pour fautes ; recette physique APNs/liens/analytics, vidéos et trace performance. Pas de nouveau test miroir de l'implémentation. Le rapport distingue réussi/échoué/non exécuté.

##### Tier de risque

tier/1 — contrôles du périmètre et gates requis conservés.

##### Notes d'implémentation

tier/1 tant que rapport/tests seuls. Une correction de feature repasse par le ticket propriétaire et son tier ; ne pas cacher du code fonctionnel sous un ticket de recette. Aucun gate vert sans résultat. Une seule branche/PR pour ce ticket ; préserver les modifications des autres intervenants. Aucun changement du site, Android ou dépendance non prévue. Les noms du code sont en anglais et la documentation en français.

## Milestone 6 — Publier une seule application track1 sur l'App Store

### Description

- **Objectif produit :** rendre track1 installable par ses premiers utilisateurs iOS, avec une version officielle claire et une sortie dont les vérifications sont traçables.
- **Solution :** préparer la présentation publique à partir du vrai build, distribuer le candidat dans TestFlight, archiver le client remplacé et soumettre la version validée jusqu'à sa disponibilité publique.
- **Logiques ajoutées ou modifiées :** bêta élargie, déclarations de données et droits sur les assets, compatibilité de mise à jour, choix du candidat, suivi de la review Apple et fin de la distribution Expo.
- **Résultat observable :** une fiche App Store publique permet d'installer track1 natif ; l'ancien client est archivé, les preuves de recette et de mesure renvoient à la version publiée, et aucune validation Android n'a retardé cette sortie.

### Issue — Présenter fidèlement track1 dans l'App Store

- **Référence :** P6.1
- **Tier :** tier/1
- **Identité Linear :** réemployer TRA-318.
- **Dépendances :** P5.4 — Valider les seize écrans et les parcours natifs intégrés sur iPhone.

#### Description

##### Contexte

La fiche App Store doit montrer l'expérience réellement livrée et la promesse quotidienne. Les captures définitives suivent la validation de l'interface native. Plan validé : `docs/plans/track1-native-ios.md`, P6.1. Source de transcription : `docs/plans/track1-native-ios-linear.md`.

##### Portée

Créer `ios/Store/ios-metadata.md`, captures/iconographie dans `ios/Store/` et compléter `docs/track1-native-release.md`. Références : handoff/exports validés et `docs/track1-privacy.md`. Hors scope : site web, marketing Android, screenshots inventés, soumission du binaire.

##### Contrat

Métadonnées françaises pour track1 : découverte du jour, profil local sans compte, exploration/génération explicite et écoute externe ; aucune promesse de streaming. Captures réelles du candidat P5.4 selon formats exigés à la soumission, version/build/provenance conservés. Icône et assets issus des références approuvées, droits vérifiés. Liens support/confidentialité publics réels et classification d'âge conformes aux contenus et services ; aucun contact fictif.

##### Critères d'acceptation

- [ ] Textes et captures correspondent aux fonctionnalités et au candidat exact, sans écran d'une ancienne version Expo.
- [ ] Formats/dimensions/champs store requis sont vérifiés au moment de préparer la soumission.
- [ ] Droits et provenance des images/polices/copies consignés ; support et confidentialité s'ouvrent sans compte.
- [ ] La présentation rend claire l'écoute externe et n'annonce aucun compte/lecteur/fonction Android absent.

##### Tests attendus

Contrôle documentaire complet des champs, dimensions d'images et comparaison au binaire ; vérification HTTPS des liens et de la provenance. Aucun code/test applicatif ajouté.

##### Tier de risque

tier/1 — contrôles du périmètre et gates requis conservés.

##### Notes d'implémentation

tier/1 contenu. Parallélisable avec P6.2. Les données d'App Store Connect sont les références réelles de contact/éditeur. Une seule branche/PR pour ce ticket ; préserver les modifications des autres intervenants. Aucun changement du site, Android ou dépendance non prévue. Les noms du code sont en anglais et la documentation en français.

### Issue — Distribuer le candidat natif aux testeurs TestFlight

- **Référence :** P6.2
- **Tier :** tier/3
- **Identité Linear :** réemployer TRA-319.
- **Dépendances :** P5.4 — Valider les seize écrans et les parcours natifs intégrés sur iPhone.

#### Description

##### Contexte

Le candidat final doit être installé par les testeurs via le même canal signé qui mène à l'App Store. Cette preuve qualifie notamment le transport push de l'archive. Plan validé : `docs/plans/track1-native-ios.md`, P6.2. Source de transcription : `docs/plans/track1-native-ios-linear.md`.

##### Portée

Utiliser `ios/Track1.xcodeproj`, schémas et configurations signées ; modifier seulement `docs/track1-native-release.md` et, si nécessaire pour distribution, `docs/track1-builds.md`. App Store Connect/TestFlight dans la fiche existante. Hors scope : build Expo parallèle, nouvelle fiche produit concurrente, publication publique.

##### Contrat

Candidat = SHA/version/build qualifiés P5.4, même bundle production réel, archivage par chaîne native. TestFlight emploie APNs production ; environnement de mesure preview jusqu'au candidat public. Consigner archive, groupe autorisé, date, appareils et résultats. Une mise à jour depuis dernier build natif interne conserve les données prévues ; les anciens builds Expo internes redemandent goûts/consentement conformément à la transition. Ne pas inviter de nouveaux destinataires externes hors du groupe déjà autorisé.

##### Critères d'acceptation

- [ ] Build natif visible et installable par le groupe TestFlight autorisé, preuves de fresh install et update.
- [ ] Push APNs production reçu depuis l'archive distribuée, ouvert chaud/froid ; bonne destination analytics et politique accessible.
- [ ] 16 écrans validés présents ; version/build/SHA et contrôles de signature consignés.
- [ ] Aucun build Expo simultanément présenté comme candidat officiel ; données non migrées des builds internes clairement documentées.

##### Tests attendus

Installation physique depuis TestFlight, update/premier démarrage, smoke parcours, push réel et traces analytics preview ; inspection des entitlements de l'archive.

##### Tier de risque

tier/3 — review approfondie automatisée du SHA final et gates requis conservés.

##### Notes d'implémentation

tier/3 distribution/signature. Aucun nouvel accord de publication ou de recette demandé du seul fait du tier ; droits et groupes existants uniquement. Les preuves de simulateur ne remplacent pas l'installation TestFlight. Une seule branche/PR pour ce ticket ; préserver les modifications des autres intervenants. Aucun changement du site, Android ou dépendance non prévue. Les noms du code sont en anglais et la documentation en français.

### Issue — Archiver le client Expo et fermer son chemin de distribution

- **Référence :** P6.3
- **Tier :** tier/3
- **Identité Linear :** créer une issue native.
- **Dépendances :** P6.2 — Distribuer le candidat natif aux testeurs TestFlight.

#### Description

##### Contexte

Le client Swift a une preuve TestFlight ; le chemin Expo peut être retiré du dépôt actif. L'archive doit rester récupérable et les abonnements historiques expirer correctement. Plan validé : `docs/plans/track1-native-ios.md`, P6.3. Source de transcription : `docs/plans/track1-native-ios-linear.md`.

##### Portée

Retirer `mobile/` et `.github/workflows/mobile-ci.yml` après archive ; modifier `README.md`, `docs/track1-builds.md`, `docs/track1-native-transition.md` et bandeaux historiques. Ancrages serveur `src/mobile/push-sender.ts`, `push-receipts.ts`, `push-schedule.ts` pour vérifier envoi coupé/rétention ; tests existants conservés. Hors scope : suppression de cache musical, données utilisateur serveur en masse, anciens tickets/PR, routes de retrait Expo encore utiles, changement de produit.

##### Contrat

Avant retrait : tag ou commit archive immuable avec SHA, branches non fusionnées référencées, tentative de lecture/restauration dans un dossier temporaire. Copier les fixtures/scénarios encore utilisés par les tests Swift dans leurs destinations indépendantes avant suppression ; aucune importation active depuis mobile/. Désactiver/suspendre diffusion EAS et envois Expo, sans effacer comptes/projet EAS ou secrets hors besoin. Garder désinscription et purge après 90 jours inactive même transport coupé ; ne pas supprimer les registres à la main. Workflow Swift/backend/review toujours obligatoire ; retirer toute exigence de check Expo obsolète seulement après remplacement effectif par le gate natif.

##### Critères d'acceptation

- [ ] Archive et références non fusionnées lisibles avant suppression ; documentation de récupération vérifiée.
- [ ] Dépôt actif ne contient plus de client Expo, de dépendance de build natif vers mobile/ ou de distribution Expo active.
- [ ] Les gates Swift/backend/review restent actifs, le retrait du vieux job ne bloque ni ne court-circuite une PR.
- [ ] Aucun envoi Expo ; retrait ancien abonnement et expiration90 jours continuent ; aucune donnée musicale supprimée.

##### Tests attendus

Test lecture d'archive ; recherche de références dépendantes ; CI native/backend verte ; tests de rétention/retrait Expo et fonctionnement APNs. Vérifier paramètres externes de distribution sans purger les comptes.

##### Tier de risque

tier/3 — review approfondie automatisée du SHA final et gates requis conservés.

##### Notes d'implémentation

tier/3 suppression/CI. Une PR d'archivage cohérente peut dépasser1 000 lignes : décompter suppression/écrit/généré et justifier sans retirer les tests. L'archive est une référence, pas un second client officiel. Une seule branche/PR pour ce ticket ; préserver les modifications des autres intervenants. Aucun changement du site, Android ou dépendance non prévue. Les noms du code sont en anglais et la documentation en français.

### Issue — Qualifier le candidat TestFlight pour sa sortie publique

- **Référence :** P6.4
- **Tier :** tier/1
- **Identité Linear :** réemployer TRA-320.
- **Dépendances :** P6.1 — Présenter fidèlement track1 dans l'App Store ; P6.2 — Distribuer le candidat natif aux testeurs TestFlight ; P6.3 — Archiver le client Expo et fermer son chemin de distribution.

#### Description

##### Contexte

Le go/no-go doit porter sur le candidat distribué et des preuves complètes. La sortie ne dépend ni d'une validation Android ni d'une nouvelle validation humaine déjà accordée. Plan validé : `docs/plans/track1-native-ios.md`, P6.4. Source de transcription : `docs/plans/track1-native-ios-linear.md`.

##### Portée

Créer `docs/track1-native-release-readiness.md`, compléter `docs/track1-native-qa.md`, `docs/track1-native-release.md`. Lire les déclarations App Store, metadata, tracking plan et preuves TestFlight. Hors scope : nouveau produit, publication avant preuves, transformation d'un inconnu en réussite.

##### Contrat

Matrice candidat exact SHA/version/build, installation/upgrade, daily/fiche/relations/écoute, recherche/génération, offline/reset, push réel/refus/retrait, analytics accord/refus/retrait, confidentialité, droits, entitlements, SDK de dépôt Apple et manifests requis. Statut par contrôle réussi/échoué/non exécuté et lien preuve. Go = aucun échec/inconnu critique ; correction binaire = nouvelle archive + revalidation des contrôles affectés. Vérifier les exigences Apple courantes par source officielle, notamment SDK accepté, âge et privacy ; ne pas supposer que la règle lue en octobre reste valable indéfiniment.

##### Critères d'acceptation

- [ ] Le tableau couvre tous les contrôles et référence le même build TestFlight ; aucune preuve Expo ou ancien binaire extrapolée.
- [ ] Aucun crash/blocage, génération involontaire, collecte refusée ou défaut essentiel dans le smoke final.
- [ ] SDK, droits, URLs, accès Apple/Segment/Amplitude et exploitation APNs sont réellement prêts ; absence d'accès marquée no-go.
- [ ] Verdict opérationnel go/no-go consigné avec motifs ; Android absent des dépendances.

##### Tests attendus

Smoke physique sur candidat, interception réseau consentement, essais push/liens/génération contrôlée, revue documentaire et des exigences Apple. Réutiliser les preuves encore valides en précisant leur SHA.

##### Tier de risque

tier/1 — contrôles du périmètre et gates requis conservés.

##### Notes d'implémentation

tier/1 rapport/recette seule. L'autorisation de publier déjà acquise est conservée ; pas de nouvelle permission par soumission. Une correction fonctionnelle garde son ticket/tier. Une seule branche/PR pour ce ticket ; préserver les modifications des autres intervenants. Aucun changement du site, Android ou dépendance non prévue. Les noms du code sont en anglais et la documentation en français.

### Issue — Publier track1 natif et vérifier sa disponibilité

- **Référence :** P6.5
- **Tier :** tier/3
- **Identité Linear :** réemployer TRA-321.
- **Dépendances :** P6.4 — Qualifier le candidat TestFlight pour sa sortie publique.

#### Description

##### Contexte

Le projet est terminé quand la version native est disponible et installable publiquement. Une soumission ou une review Apple positive sans mise à disposition ne suffit pas. Plan validé : `docs/plans/track1-native-ios.md`, P6.5. Source de transcription : `docs/plans/track1-native-ios-linear.md`.

##### Portée

Soumettre le candidat autorisé dans App Store Connect et compléter `docs/track1-native-release.md`. Utiliser `ios/Store/`, archive/signature et readiness validées. Hors scope : Android, campagne marketing, extension de fonctionnalités pour contourner une review, écriture du site.

##### Contrat

Réutiliser la fiche Apple et le bundle track1 existants ; version/build/SHA exactement qualifiés. Suivre review, corrections administratives dans le scope, publication et propagation. Nouveau binaire requis = revenir aux contrôles affectés avant resoumission. Toute demande Apple impliquant compte/streaming/fonction hors brief est arbitrage de scope, pas réalisation implicite. Vérifier environnement analytics public production et APNs production depuis installation App Store. Consigner lien public, statut disponible, date, build et preuves. L'autorisation de Raphael d'aller jusqu'à publication est acquise.

##### Critères d'acceptation

- [ ] La fiche publique existe, la version native est installable et version/build correspondent au candidat qualifié.
- [ ] Smoke public : profil→recommandation→fiche→service externe, lecture/recherche et génération contrôlée possibles ; pas de régression essentielle.
- [ ] Push réel et événements consentis arrivent dans les environnements publics ; refus n'envoie rien.
- [ ] Rapport final contient URL/version/SHA/preuves et confirme Expo archivé ; soumission seule ne marque pas Done.

##### Tests attendus

Installation depuis App Store sur iPhone réel, smoke produit, notification réelle et traces analytics production expurgées ; vérification de l'URL publique et statut Apple. Toute correction conserve son test de régression.

##### Tier de risque

tier/3 — review approfondie automatisée du SHA final et gates requis conservés.

##### Notes d'implémentation

tier/3 publication/signature. Aucun email/message promotionnel autorisé par ce ticket ; interactions nécessaires avec le processus App Store seulement. Android attend un brief distinct après traction iOS. Une seule branche/PR pour ce ticket ; préserver les modifications des autres intervenants. Aucun changement du site, Android ou dépendance non prévue. Les noms du code sont en anglais et la documentation en français.
