> Historique — remplacé pour l'exécution par [le plan iOS natif](track1-native-ios.md), validé le 2026-10-05. Corps historique conservé à l'identique.

# Manifeste Linear — Track1 mobile
Statut : validé par Raphael le 2026-09-30 — amendement iOS-first du plan proposé le 2026-09-28. Validation initiale du 2026-09-25 et autorisation d'enchaîner jusqu'à publication conservées.

## Projet
- **Nom :** Track1 mobile
- **Plan :** docs/plans/track1-mobile.md
- **Projet existant :** P-TRA-4 — `1af27c25-2427-4d6c-a93c-a4f431732eca`
- **URL :** https://linear.app/workspaceperso/project/track1-mobile-6052a246546f
- **Équipe :** Track1 — `5957a8e2-e7a0-4995-8acb-b3820ac19745`
- **Périmètre définitif :** 8 milestones et 46 issues, dont 38 existantes TRA-285 à TRA-322 et 8 nouvelles TRA-?. Aucun projet parallèle ni identifiant inventé.
- Aucun champ d'estimation, point ou date d'échéance à renseigner.

### Description
Plan validé : `docs/plans/track1-mobile.md`.

Odyssey permet déjà de découvrir la culture musicale en reliant artistes, œuvres, genres et labels. Son usage actuel passe par une page web. Pour une personne qui veut découvrir quelque chose à écouter chaque jour, il manque une expérience installée sur son téléphone, un rappel quotidien et une continuité simple entre recommandation, découverte et écoute dans son service habituel.

Les contenus et une partie des règles de recommandation existent. Le problème est de les rendre accessibles dans un usage mobile régulier, sans demander la création d'un compte ni dégrader le site qui fonctionne déjà. Il faut aussi pouvoir comprendre, dès le lancement, si les personnes découvrent effectivement des œuvres et reviennent.

Le premier build iOS a désormais été installé sur un iPhone et ses trois onglets ont été vérifiés. Un APK Android a été construit, sans validation sur téléphone Android. Les critères communs aux deux plateformes empêchent aujourd'hui de terminer certains tickets malgré les preuves iOS disponibles. L'interface et ses animations doivent également être définies puis harmonisées avant d'inviter davantage de testeurs et de préparer la présentation publique.

1. Une personne peut installer **track1 depuis l'App Store**, choisir ses goûts et obtenir une recommandation expliquée sans créer de compte ; l'attente de validation Android ne retarde pas cette première sortie.
2. Elle retrouve une découverte du jour à chaque visite et peut recevoir un rappel, sans que le refus des notifications empêche l'usage.
3. Elle peut passer d'une recommandation à une fiche, suivre ses relations musicales, rechercher un autre sujet et faire créer une fiche absente.
4. Elle peut ouvrir Spotify ou Apple Music pour écouter ; une panne réseau ou l'épuisement des crédits de génération laisse les contenus déjà disponibles consultables.
5. Les premiers utilisateurs iOS découvrent une interface et des animations cohérentes avec un design validé ; l'équipe mesure leur parcours jusqu'à l'ouverture d'un service d'écoute et leur retour quotidien, avec des événements vérifiés avant publication.

track1 devient une application dédiée à la découverte musicale, avec trois entrées : **Aujourd'hui**, **Recherche** et **Réglages**. Au premier lancement, la personne choisit des genres. L'application garde ces goûts sur le téléphone et les utilise pour sélectionner chaque jour un artiste, un projet musical ou un morceau déjà présent dans Odyssey. Une courte explication relie la proposition à ses goûts.

La fiche permet de lire le contexte culturel, voir une image, suivre les relations vers d'autres fiches et ouvrir son service d'écoute. La recherche couvre les cinq types de contenus. Quand un résultat ou une relation n'a pas encore de fiche, une action explicite permet de la générer ; l'application affiche son avancement puis le résultat, ou une indisponibilité compréhensible.

Après avoir vu sa première recommandation, la personne peut activer un rappel quotidien. Décision validée : **9 h dans le fuseau du téléphone**, avec le texte « Une découverte musicale t'attend. Ouvre track1 pour la découvrir. ». Le rappel ouvre Aujourd'hui ; la recommandation est calculée ou retrouvée sur le téléphone. Le serveur ne conserve donc pas les goûts pour préparer les notifications.

Les parties 1 à 5 conservent les fondations, l'accès aux contenus, le parcours quotidien, l'exploration et la mesure déjà prévus. Leurs validations physiques portent désormais sur iOS pour la première sortie. La partie 6 fixe le design puis applique l'interface et les animations aux parcours existants ; sa validation précède les captures, l'élargissement TestFlight et la publication App Store de la partie 7. La partie 8 garde les contrôles et la publication Android à reprendre plus tard, sans dépendance bloquante vers la sortie iOS.

**La mesure et les push restent présents dès le parcours initial** ; la refonte ne les repousse pas. La partie 5 commence avec les fondations et chaque parcours est instrumenté dans sa tâche. Les builds internes iOS peuvent continuer à servir aux développeurs et au travail de design avant la refonte ; l'élargissement de la bêta attend l'interface finale. Le code et la configuration Android restent maintenus et compilables, sans confondre compilation et fonctionnement vérifié sur un appareil.

## Règles de transcription et de reprise

Ce manifeste remplace la source de transcription du 25 septembre pour les contrats ci-dessous. La validation explicite du 30 septembre est acquise ; les mentions « à valider » encore présentes dans le bandeau et le gate historique du plan décrivent l'étape antérieure, pas une nouvelle attente. Le design lui-même reste à définir et faire approuver dans P6.1. Aucune mutation Linear n'a été effectuée pour produire ce document.

Conserver le projet, les IDs/UUID des 38 issues et des six milestones existants. Réordonner l'ancien milestone 6 en partie 7 et le renommer exactement comme ci-dessous ; créer uniquement les milestones des parties 6 et 8. Déplacer TRA-322 dans la partie 8, sans le recréer. Créer uniquement P6.1–P6.5 et P8.1–P8.3, qui restent TRA-? dans ce manifeste jusqu'à attribution réelle. Les tiers et dépendances ci-dessous sont définitifs ; remplacer les anciennes relations contradictoires, notamment le lien TRA-322→TRA-320, par les relations listées.

Relire les statuts Linear réels avant transcription et les conserver : aucun état de workflow n'est prescrit ni déduit de cases du plan. Les artefacts attestent TRA-312/TRA-314 livrés, TRA-325 (tests push, PR #304) et TRA-326 (purge liée à la confidentialité, PR #305) livrés, et TRA-290 encore en cours avec iPhone vérifié/APK construit lors du relevé du 28 septembre. Ce sont des observations persistées, pas une lecture actuelle de Linear. TRA-325/TRA-326 restent hors des 46 tâches et ne sont ni recréés ni rouverts. Ne pas rouvrir les tickets terminés du seul fait de l'amendement ; conserver leurs PR, validations et preuves. Les nouveaux contrats décrivent le résultat conservé et les critères restant à vérifier, pas une réécriture rétroactive de leurs résultats.

Pour chaque ticket amendé, conserver la trace de son ancien périmètre et du transfert Android dans l'historique ; aucune preuve iOS ou compilation ne devient une réussite Android. Les preuves distinguent iOS réussi/échoué/non exécuté et Android « différé — non exécuté » tant que la recette concernée n'a pas eu lieu. La partie 8 est différée jusqu'à décision explicite de reprise, sans imposer un nom de statut Linear, une date ou un blocage des parties 1 à 7. Une divergence factuelle avec une livraison terminée doit être signalée au planner, sans fabriquer de statut ni réécrire les preuves.

### Chemins et acquis

La cartographie et les contrats persistés sont conservés. Les chemins mobiles du plan ont été vérifiés dans les objets Git `7bff0f5d3e9b69d6c9822da0387b6734cb482d1d` (main) et `ca57d01cc6035d1a035ee49fed393f6ee1a8ab56` (branche TRA-290) ; leurs noms ont été recontrôlés pour ce manifeste sans nouvelle exploration du code. Le checkout documentaire n'a pas de dossier mobile/, mais ces chemins existent dans les révisions citées. Le scaffold, la navigation et la CI mobile déjà livrés sont réutilisés ; leur CI JavaScript/TypeScript ne prouve pas un build natif.

Les portées héritées décrivent les livrables de leurs contrats : conserver et compléter l'existant, ne créer un fichier que s'il est réellement absent et prévu. Les dossiers de design, recette, store et rapports nouveaux sont explicitement créés sous les parents vérifiés `docs/`, `mobile/`, `mobile/src/` et `mobile/test/`. Les chemins de tests et services détaillés dans les tickets sont les ancrages pour la reprise ; aucun renommage ou refactor n'est requis pour reproduire un découpage initial si le comportement est déjà livré autrement.

### Ordre d'attaque et travail parallèle

Préserver les acquis des parties 1 à 5 ; terminer les verrous iOS et les contrôles de mesure ; valider puis intégrer le design ; valider l'interface finale P6.5 ; produire captures et TestFlight élargi ; consigner le go iOS ; publier l'App Store. Aucune tâche des parties 1 à 7 ne dépend d'une tâche Android de partie 8. Les parties se déploient après leurs prérequis sur builds internes, sans changement incompatible du web.

P1.1 et P5.1 sont les deux départs sans dépendance s'ils ne sont pas déjà livrés. P1.3/P1.4, les modules P2.2/P2.3/P2.4/P2.6 après leurs prérequis, P3.1/P3.2, P3.3/P3.4, P3.8 avec P3.6–P3.7, P4.1/P4.2/P4.3 et P4.5/P4.4 sont parallélisables selon les dépendances explicites. P5.3 avance en parallèle des features. P6.1 peut avancer avec les verrous fonctionnels après P1.3 ; P7.1 se prépare en parallèle de la refonte. Après P6.5, P7.2 est parallélisable avec P7.3 et la fin de P7.1, sous leurs propres prérequis. Séquencer les raccordements à src/server.ts, aux routes mobiles et les écritures d'un même rapport ; les worktrees n'autorisent pas à écraser les modifications d'un autre ticket.

Un ticket = une branche = une PR cohérente, tests inclus. La règle commune de `.agents/skills/delivery-process/references/diff-size.md` s'applique : volumes écrit/généré séparés et provenance, tests/scaffold comptés, réexamen au-delà de 1 000 lignes écrites ou 20 fichiers, sans arrêt dû au seul volume. Aucun test ou gate retiré. Tous les tiers conservent leurs contrôles ; tier/3 exige review ordinaire et preuve profonde Sol/high du SHA final dans le check requis review-gate, puis auto-merge sans accord humain.

L'autorisation de publication du 25 septembre reste acquise : les go/no-go sont opérationnels, fondés sur le candidat et les preuves. Aucun nouvel accord par soumission ni validation personnelle du build n'est présumé. Le handoff design approuvé et la décision de réactivation Android sont les seules décisions produit encore propres à leurs étapes ; tout accès ou information réelle manquante est consigné comme tel.

### Transfert des critères Android

| Critères de l'ancien contrat | Destination conservant l'obligation |
| --- | --- |
| TRA-290 : installation et navigation physiques Android | P8.1 ; TRA-290 conserve iPhone et compilation APK |
| TRA-305/TRA-306 : permissions, vrai push et parcours quotidien Android | P8.1 ; tests partagés et preuves iOS restent dans leurs tickets |
| TRA-311/TRA-313 : liens profonds, exploration, retour système, TalkBack et accessibilité Android | P8.1 |
| TRA-315/TRA-316 : émission Segment/Amplitude, identités, consentements et indicateurs Android | P8.1 |
| TRA-317 : déclarations Google Play et contrôle Android des liens de confidentialité | P8.2 |
| TRA-318 : textes et captures Google Play | P8.2 |
| TRA-319 : accès/signature/piste de test et distribution Android | P8.2 |
| TRA-320 : résilience, preuves du candidat et décision de publication Android | P8.3 |
| TRA-322 : publication Google Play | Même TRA-322 en P8.4, dépendant de P8.3 |

## Milestone 1 — Installer et ouvrir track1 sur son téléphone
- **Identifiant Linear conservé :** `8102d49c-3665-4b40-a720-d25380bb3bde`.

### Description
- **Objectif produit :** disposer d'une application track1 installable et vérifiée sur iPhone pour poursuivre les validations produit.
- **Solution :** conserver l'application et ses trois entrées de navigation, finaliser sa distribution interne iOS et garder la capacité de construire Android.
- **Logiques ajoutées ou modifiées :** ouverture initiale, navigation, choix de l'environnement de test ou de production, séparation des versions internes et publiques ; preuves d'installation séparées par plateforme.
- **Résultat observable :** un testeur installe track1 sur iPhone et navigue entre Aujourd'hui, Recherche et Réglages ; un artefact Android se compile et sa validation sur appareil reste explicitement différée ; les vérifications du backend passent.

### Issue — Aligner les règles CI de taille et de merge
- **Référence plan :** P1.1
- **Identifiant :** TRA-285
- **UUID conservé :** `f77a4109-ff1e-44a9-af00-5ed422b3b16a`
- **Tier :** tier/3
- **Dépendances :** aucune
#### Description

## Contexte
Le contrôle de taille et le désarmement systématique de l'auto-merge doivent être alignés sur les règles validées. La review de PR #278 a révélé une contradiction : retirer `--disable-auto` sans gate technique de review approfondie permettrait à une PR sensible initialement tier/1 de fusionner avant sa review tier/3. Ce ticket corrige aussi cette course, sans changer les niveaux de review ni demander d'accord humain.
Plan : docs/plans/track1-mobile.md, partie 1. Correctif de contrat TRA-285 du 2026-09-26, dans l'autorisation générale déjà donnée.

## Portée
Modifier `.github/workflows/ci.yml`, `.github/workflows/review-gate.yml`, `.github/pull_request_template.md`, `.codex/scripts/publish-review-status.sh` et `test/review-status-script.test.ts` (existants vérifiés sur origin/main). Conserver/compléter `scripts/ci/pr-policy.ts` et `test/ci-policy.test.ts` déjà créés dans PR #278 ; compléter `scripts/ci/review-gate-policy.ts` et `test/review-gate-policy.test.ts` vérifiés sur main pour le verdict combiné. Le calcul de risque est partagé avec tier-guard, pas réimplémenté avec une liste divergente. Le gate doit être testé par son vrai point d'entrée, identifié par nom de step ou module, jamais par extraction du premier `run: |` (qui isole HOME).
Pas de changement mobile, fournisseur IA, modèle, secret, `.github/workflows/ai-review.yml`, `.github/workflows/claude.yml`, déploiement ou skills ; ne pas importer les modifications utilisateur locales. Aucune modification de protection nécessaire : main exige déjà le check `review-gate` produit par GitHub Actions (app_id 15368). Vérifier cette exigence réelle avant livraison et préserver tous les autres checks, strict=true et les paramètres existants ; ne pas les remplacer par de simples consignes.

## Contrat
Le calcul reçoit les entrées du diff merge-base→HEAD avec chemin, ajouts, suppressions et indicateur binaire. Il restitue séparément `writtenLines`, `writtenFiles`, `generatedLines`, `generatedFiles`, `binaryFiles`, la liste des chemins/provenances et `requiresScopeReview`. Les lignes écrites comptent ajouts ET suppressions, tests et code scaffold inclus. `requiresScopeReview` vaut vrai seulement si writtenLines > 1000 OU writtenFiles > 20 ; le job produit alors un avertissement et un résumé, pas un échec dû à la seule taille. Un échec de lecture/calcul reste un échec CI.

Classification générée explicite : tout fichier nommé exactement `package-lock.json` à la racine ou imbriqué, provenance npm ; `web/data.json` issu de `scripts/build-graph-json.ts` ; `data/genre-qid-map.json` issu de `scripts/build-genre-qid-map.ts` ; nœuds `cache/nodes/**/*.json` issus du pipeline ; snapshots identifiés comme tels et régénérés par le test runner. Les autres fichiers, notamment TS/TSX/JS, tests, `data/genre-catalog.json` et `data/genre-taxonomy.json`, restent écrits. Les binaires sont listés séparément et ne sont pas déclarés générés sur leur seule extension : leur provenance figure dans la PR. Aucun motif générique `mobile/**` ou `assets/**` n'exempte du code.

**Classement avant tout succès.** Dans `review-gate`, calculer le tier effectif comme le maximum du risque des fichiers du diff immuable merge-base(base SHA, head SHA)→head SHA et des labels courants relus par API. Employer exactement les règles de chemins sensibles de tier-guard, tous les fichiers/pagination compris. Une PR touchant un chemin sensible est tier/3 immédiatement, même encore étiquetée tier/1 et même si tier-guard n'a pas démarré. Erreur API, diff incomplet ou classement indéterminable = gate non vert. Le gate ne dépend pas de la réception d'un événement `labeled` produit par GITHUB_TOKEN : cet événement ne redéclenche pas de workflow.

**Check requis unique, verdict combiné.** Garder le nom `review-gate` et sa provenance GitHub Actions. Sa condition de succès devient : politique actuelle de review ordinaire satisfaite **ET**, si tier effectif 3, attestation `codex-deep-review=success` valide sur le même head SHA. Pour tiers 1/2, la politique ordinaire reste inchangée. Conserver la priorité des BLOCK explicites : `codex-review=failure` ou finding Claude bloquant restent bloquants, même avec deep=success. Un succès ordinaire `review` ou `codex-review` n'est jamais une preuve de review profonde ; inversement le statut profond ne remplace pas la review ordinaire. Pas de job profond conditionnellement skipped/neutral utilisé comme preuve : son exigence entre dans le verdict du check déjà requis.

**Attestation profonde distincte.** Étendre le publisher existant, sans casser son invocation actuelle : `publish-review-status.sh <pr> <pending|pass|block> <reviewed-sha> [description] [standard|deep] [evidence-url]` ; mode absent = standard/`codex-review`, mode deep = `codex-deep-review`. Le publisher refuse un SHA différent du head courant et un verdict inconnu. Pour un verdict profond terminal, exiger un lien vers un rapport de review GitHub de cette PR ; le rapport identifie le SHA complet, `gpt-5.6-sol`, effort `high`, profondeur tier/3, verdict pass|block et findings/résumé. Publier pending avant cette review en lecture seule, puis le verdict réel ; ne jamais fabriquer pass à partir des labels, du template ou d'une review ordinaire.
Le gate vérifie le contexte exact, le dernier état de ce contexte pour le SHA courant, la provenance autorisée et la preuve associée : compte authentifié `raphpool` déjà utilisé par le publisher local, rapport publié par ce même compte sur la PR et métadonnées concordantes. Le compte transporte le résultat IA, il n'ajoute pas une approbation humaine. Source inconnue, rapport absent/incohérent, ancien SHA, pending/failure/error/cancelled ou absence du statut ne satisfont pas la condition. Aucune nouvelle clé de modèle ni exécution Sol sur GitHub ; la review locale autorisée reste le producteur. Les lectures supplémentaires sont accordées au minimum nécessaire, sans nouveau droit d'écriture au job gate.

**Événements et réévaluation.** Ajouter `opened`, `labeled` et `unlabeled` externes aux événements du gate, garder `synchronize`, `ready_for_review`, `reopened`, groupe de concurrence unique par PR et annulation des anciens runs. Préserver le traitement draft et vérifier qu'une PR devenue prête reçoit une exécution non skipped du head courant. Juste avant succès, relire head et classement ; si le head a changé, le run ancien ne peut certifier le nouveau SHA. Le publisher standard conserve son comportement ; le mode deep relance le dernier run pull_request `review-gate` terminé non vert du même SHA, après publication, sans relancer un run d'un autre SHA. Un timeout reste bloquant et peut être relancé, jamais converti en pass faute de fournisseur.
Cas distinct : une escalade purement manuelle après un gate déjà vert ne peut pas être rendue atomique par un simple événement de label. Avant de poursuivre un tel reclassement, suspendre l'auto-merge, obtenir une nouvelle exécution bloquante du gate pour la review requise et vérifier son état, puis seulement réarmer après review ; si la PR est déjà fusionnée, signaler cet état au lieu de prétendre la protéger. Cette précaution ne remplace pas le calcul du diff, qui ferme la course automatique de #278. Le désarmement reste donc autorisé à titre de suspension exceptionnelle d'un reclassement tardif, pas comme gate permanent de tous les tier/3.

**Auto-merge et template.** Tier-guard conserve l'escalade et retire les labels tier/1 et tier/2 pour les chemins sensibles ; il ne désactive plus systématiquement l'auto-merge et n'arme jamais un merge. Son commentaire désigne la condition technique précédente, sans demande humaine. Le template prévoit CA/tests, écrit/généré/provenance, justification de dépassement, tier, SHA/verdict et lien de preuve profonde le cas échéant. Attendre la classification et les checks reste la discipline opératoire, mais n'est plus la protection contre l'armement prématuré. Commande après checks verts : `gh pr merge <PR> --auto --squash --match-head-commit <SHA-validé>`, jamais `--admin`.

## Critères d'acceptation
- [ ] Seuils 1000 lignes/20 fichiers versus 1001/21, écrit/généré dont lockfile mobile, provenance, binaires et chemins avec espaces suivent le contrat ; aucun échec dû au seul volume.
- [ ] Scénario de régression exact : auto-merge déjà armé, label initial tier/1, diff sensible, review ordinaire positive et tier-guard retardé ; review-gate reste non vert tant que la review profonde du head n'est pas validée, puis devient vert lorsque les deux conditions passent.
- [ ] Deep manquant/pending/block/error, mauvais auteur/rapport/SHA ou changement de head bloquent ; deep pass ne masque aucun BLOCK ordinaire. Tiers 1/2 sans chemin sensible conservent leur auto-merge sans review profonde supplémentaire.
- [ ] Entrée ouverte directement prête, passage draft→ready, labels externes contradictoires, absence d'événement labeled automatique, pagination, erreur API, concurrence et rerun du SHA attesté sont couverts sans succès skipped/neutral indu.
- [ ] La protection main exige toujours typecheck/lint/test/diff-size/review-gate, avec source Actions pour review-gate ; aucun contrôle, politique de permission ou protection existante n'est affaibli. Un template ou commentaire seul ne débloque jamais tier/3.
- [ ] Tier-guard n'effectue plus de désarmement systématique ni d'armement anticipé ; preuve et procédure de suspension d'une reclassification tardive explicites, aucune approbation humaine de merge, aucun --admin.

## Tests attendus
Vitest `test/ci-policy.test.ts` : seuils, fichiers/provenance, règles de risque et diff complet. `test/review-gate-policy.test.ts` : table des verdicts ordinaires/profonds, tiers et labels, scénario auto-merge armé avant tier-guard, pending/absence/BLOCK/ancien SHA/provenance/rapport erronés, API incomplète et changement de head avant succès. Faire passer de vrais résultats du calcul de risque au vrai évaluateur du gate ; mocker seulement GitHub, pas le classement possédé.
Étendre `test/review-status-script.test.ts` : compatibilité de l'ancien CLI, contexte standard/deep, métadonnées/lien requis, refus d'un SHA périmé, états GitHub exacts et rerun seulement du gate terminé non vert sur le bon SHA. Vérifier syntaxe YAML/shell, triggers et step réellement exécuté ; `npm run check` en mode test run. Recette sur la PR : noter protection requise réelle, SHA, preuve Sol/high, états combinés et absence de possibilité de fusion avant les conditions ; ne pas créer/fusionner une PR volontairement non reviewée pour démontrer le scénario.

## Tier de risque
tier/3 — CI et review-gate requis verts, attestation Sol/high profonde du SHA final vérifiée par ce gate, auto-merge sans accord humain.

## Notes d'implémentation
Poursuivre TRA-285 et PR #278, sans nouveau ticket ni nouvelle validation produit. L'ancienne interdiction de modifier review-gate.yml est levée uniquement pour ce verrou ; taille et gates font partie du même alignement déjà demandé. Préserver runners [self-hosted, macOS, ARM64], isolation HOME, drafts, concurrence, protections et workflow IA existants. Worktree isolé depuis main à jour ; workflows identiques vérifiés sur origin/main local 07998bed et main distant 7770b96d le 2026-09-26.
Transition : tant que ce verrou n'est pas actif/vert, garder PR #278 désarmée ; publier la vraie review profonde du SHA final puis relancer son gate si nécessaire. Le désarmement seul n'est pas une preuve de livraison. Ne retirer aucun test pour respecter l'ancien volume ; appliquer la politique de dimensionnement approuvée et justifier un périmètre cohérent si nécessaire.
Références de comportement GitHub : [checks requis sur le dernier SHA et skipped/neutral](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks), [événements produits par GITHUB_TOKEN](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow). Ces contraintes motivent l'évaluation avant succès, pas un nouveau gate humain.
Contrat du ticket existant TRA-285 : reprendre le code et les tests déjà livrés, conserver son statut réel, sa PR et ses preuves ; cet amendement n'ordonne ni recréation ni réouverture d'une tâche terminée.

### Issue — Installer un socle mobile reproductible et vérifiable
- **Référence plan :** P1.2
- **Identifiant :** TRA-287
- **UUID conservé :** `800298de-0a19-443b-bfac-99eadb223528`
- **Tier :** tier/3
- **Dépendances :** Aligner les règles CI de taille et de merge (TRA-285, P1.1)
#### Description

## Contexte
track1 doit disposer d'une base Expo installable sans convertir le dépôt backend en workspace. Ce ticket livre le sous-projet, ses contrôles et la configuration publique que les écrans consommeront.
Plan : docs/plans/track1-mobile.md, partie 1.

## Portée
Livrables à conserver/compléter ; créer uniquement les éléments encore absents : `mobile/package.json`, `mobile/package-lock.json`, `mobile/tsconfig.json`, `mobile/biome.json`, `mobile/jest.config.cjs`, `mobile/src/config.ts`, `mobile/.env.example`, `mobile/app/_layout.tsx`, `mobile/app/index.tsx`, `mobile/test/config.test.ts` et `mobile/test/bootstrap.test.tsx`. Modifier `.gitignore`, `biome.json` et `tsconfig.json` racine seulement si nécessaire pour isoler les fichiers générés/tests mobiles. Parents vérifiés dans la cartographie persistée ; le socle existe désormais sur main. Conserver ses fichiers, dépendances et tests livrés ; les chemins listés décrivent les livrables du contrat initial et non un ordre de recréation. Hors-scope : workspace npm racine, upgrade Node backend, fonctionnalités, signature et SDK analytics.

## Contrat
Sous-projet npm indépendant, Expo SDK 57, React Native 0.86, React compatible SDK et Expo Router ; Node 22 >=22.13 uniquement pour mobile. TypeScript strict, noUncheckedIndexedAccess et exactOptionalPropertyTypes. `npm --prefix mobile run check` enchaîne lint, typecheck et tests Jest non interactifs ; commandes individuelles lint/typecheck/test disponibles. Test renderer avec jest-expo et Testing Library React Native, Biome aligné tabs/doubles quotes/110. Entrée Expo Router `expo-router/entry`, écran bootstrap minimal sans réseau ni collecte.

Dépendances autorisées : Expo/React/React Native/Expo Router et leurs dépendances natives de navigation recommandées par SDK57, expo-dev-client/image/linking/crypto/secure-store/notifications/device/constants/localization, AsyncStorage, zod et outils TypeScript/Biome/Jest/Testing Library. Résoudre les patches compatibles via Expo et verrouiller le lockfile ; pas de canary, dépendance audio ou Amplitude.

`readPublicConfig` renvoie un résultat typé succès ou erreur de configuration, jamais un crash : `EXPO_PUBLIC_APP_ENV` development|preview|production ; `EXPO_PUBLIC_API_BASE_URL` URL HTTPS sans identifiants, query ni fragment, chemin finissant `/mobile/v1` ; `EXPO_PUBLIC_SEGMENT_WRITE_KEY` facultative ; `EXPO_PUBLIC_EAS_PROJECT_ID` facultative jusqu'aux builds signés. Normaliser slash final. API de production configurée https://dropcliffs.com/api/odyssey/mobile/v1. Pas de secret fournisseur dans les variables publiques. Ignorer `.env` réel, `.expo`, node_modules et projets natifs générés ; exemple sans valeur secrète.

## Critères d'acceptation
- [ ] Installation par `npm --prefix mobile ci`, expo install --check, lint, typecheck et Jest passent avec le lockfile livré.
- [ ] Configuration valide normalisée ; URL non HTTPS/malveillante, environnement inconnu ou valeur requise manquante donnent une erreur typée testée ; clé Segment absente autorisée.
- [ ] Le bootstrap rend un écran natif minimal ; tests de rendu et de logique fonctionnent sans appeler une API externe.
- [ ] Les contrôles backend d'origine passent encore et aucun secret ni projet natif généré n'est committé.

## Tests attendus
Tests unitaires de configuration nominale, manquante, hostile et facultative ; rendu bootstrap avec vrai composant. `npm run check` backend en mode test run et `npm --prefix mobile run check` ; mocker uniquement les frontières natives nécessaires à Jest. Vérifier le résultat Expo doctor sans masquer ses erreurs.

## Tier de risque
tier/3 — CI et review-gate requis verts ; ce gate exige l'attestation Sol/high profonde du SHA final en plus de la review ordinaire. Auto-merge après classification, sans accord humain.

## Notes d'implémentation
Isoler les dépendances : ne pas importer src/ serveur dans Metro. Le code du bootstrap et ses tests restent au décompte écrit ; joindre provenance npm du lockfile. P1.1 doit être fusionné ; conserver les changements utilisateur hors worktree.
Contrat du ticket existant TRA-287 : reprendre le code et les tests déjà livrés, conserver son statut réel, sa PR et ses preuves ; cet amendement n'ordonne ni recréation ni réouverture d'une tâche terminée.

### Issue — Ouvrir les trois entrées de navigation
- **Référence plan :** P1.3
- **Identifiant :** TRA-288
- **UUID conservé :** `46bb0a54-ceec-449f-b0ea-5a4f1098f7ff`
- **Tier :** tier/2
- **Dépendances :** Installer un socle mobile reproductible et vérifiable (TRA-287, P1.2)
#### Description

## Contexte
Les prochaines features ont besoin d'une navigation native stable et d'une destination explicite quand la configuration est absente. Ce ticket livre les trois entrées produit, sans simuler des données musicales.
Plan : docs/plans/track1-mobile.md, partie 1.

## Portée
Modifier `mobile/app/_layout.tsx` et `mobile/app/index.tsx` livrés par le socle. Créer `mobile/app/(tabs)/_layout.tsx`, `mobile/app/(tabs)/index.tsx`, `mobile/app/(tabs)/search.tsx`, `mobile/app/(tabs)/settings.tsx`, `mobile/src/components/ConfigurationError.tsx`, `mobile/test/navigation.test.tsx`. Hors-scope : onboarding métier, API, push, analytics, style du site.

## Contrat
Navigation Expo Router : racine vers onglet Aujourd'hui ; onglets Aujourd'hui/Recherche/Réglages aux routes index/search/settings. Préparer une Stack pour les futures routes `/node/[slug]` et `/onboarding` sans implémenter leurs features. Si readPublicConfig échoue, afficher ConfigurationError avec cause publique et instruction de configuration, sans lancer réseau/collecte. Les écrans utilisent texte natif, safe areas et labels accessibles. Les onglets ne perdent pas leur état par simple changement ; retour Android suit l'historique natif et ne boucle pas.

## Critères d'acceptation
- [ ] Les trois onglets sont accessibles et libellés en français ; ouverture initiale sur Aujourd'hui.
- [ ] Changer d'onglet et revenir conserve l'état local d'un écran de test ; retour Android suit la pile attendue.
- [ ] Configuration invalide affiche un état explicite et ne tente aucun appel API.
- [ ] Les écrans restent utilisables avec grand texte et labels de lecteur d'écran ; aucune commande audio.

## Tests attendus
Rendu/navigation Expo Router avec vrais layouts ; configuration nominale/invalide ; interaction onglets/retour Android simulé à la frontière native. Exécuter mobile check ; smoke local natif lorsque disponible, sans attendre les comptes de signature de P1.5.

## Tier de risque
tier/2 — CI et review-gate verts, review IA selon le processus, auto-merge après classification du tier.

## Notes d'implémentation
Navigation déjà présente sur main : conserver sa livraison et ses tests, sans recréer les routes. La preuve physique Android relève de P8.1 ; le test partagé du retour Android reste requis. Ne pas ajouter d'écran produit supplémentaire. Les routes profondes complètes seront traitées en P4.5. Utiliser les dépendances de P1.2.
Contrat du ticket existant TRA-288 : reprendre le code et les tests déjà livrés, conserver son statut réel, sa PR et ses preuves ; cet amendement n'ordonne ni recréation ni réouverture d'une tâche terminée.

### Issue — Vérifier le mobile à chaque PR
- **Référence plan :** P1.4
- **Identifiant :** TRA-289
- **UUID conservé :** `11c56bfe-028f-4094-8d8d-2c77ae9ebf28`
- **Tier :** tier/3
- **Dépendances :** Installer un socle mobile reproductible et vérifiable (TRA-287, P1.2)
#### Description

## Contexte
Les changements mobiles doivent être vérifiés automatiquement avant fusion, indépendamment du backend. Le runner existant est un macOS ARM64 partagé dont la configuration personnelle doit rester protégée.
Plan : docs/plans/track1-mobile.md, partie 1.

## Portée
Livrables à conserver/compléter ; créer uniquement les éléments encore absents : `.github/workflows/mobile-ci.yml`. Référence en lecture seule : `.github/workflows/ci.yml` à jour sur origin/main et `mobile/package.json`. Hors-scope : remplacement des jobs backend, changement de runner, gestion de secrets, builds payants EAS et règles de branche.

## Contrat
Workflow mobile sur pull_request opened/synchronize/reopened/ready_for_review et push main, concurrence par ref ; PR draft sans exécution. Runner `[self-hosted, macOS, ARM64]`, isolation du HOME dans un répertoire de job temporaire comme le workflow existant. Node22 >=22.13, cache npm keyed sur mobile/package-lock.json, `npm ci` depuis mobile, puis lint/typecheck/test non interactifs. Le job final a un nom stable `mobile-check` et un exit non nul si une de ces vérifications échoue. Ne pas lancer tests live, push ou accès comptes. Garder le job présent pour toutes les PR prêtes afin de ne pas créer un check requis absent selon le filtre de chemins.

## Critères d'acceptation
- [ ] Une PR prête exécute mobile-check sous Node22 avec le lockfile mobile ; une PR draft reste exclue jusqu'à ready_for_review.
- [ ] Une erreur de test, type ou lint fait échouer mobile-check ; aucun continue-on-error ne la masque.
- [ ] Les jobs backend Node20 et leur configuration restent identiques ; les écritures de configuration du job restent isolées du compte du runner.
- [ ] Aucun secret d'application ni authentification aux stores n'est requis par cette CI.

## Tests attendus
Validation syntaxique YAML ; exécuter les mêmes commandes localement ; exercice de la PR réelle avec checks et vérification du runner/Node dans les logs. Vérifier la configuration draft et l'absence de permissions inutiles sans ajouter de dépendance de test YAML au produit.

## Tier de risque
tier/3 — CI et review-gate requis verts ; ce gate exige l'attestation Sol/high profonde du SHA final en plus de la review ordinaire. Auto-merge après classification, sans accord humain.

## Notes d'implémentation
La review tier/3 s'effectue sur le SHA final après tier-guard. L'agent attend ensuite CI/review-gate et utilise --match-head-commit. Ne pas toucher review-gate ou sa politique de modèle.
Contrat du ticket existant TRA-289 : reprendre le code et les tests déjà livrés, conserver son statut réel, sa PR et ses preuves ; cet amendement n'ordonne ni recréation ni réouverture d'une tâche terminée.

### Issue — Distribuer un build iOS de développement et conserver la compilation Android
- **Référence plan :** P1.5
- **Identifiant :** TRA-290
- **UUID conservé :** `e2a2648f-8ed7-4395-b4a3-5c57df6a9d1d`
- **Tier :** tier/3
- **Dépendances :** Ouvrir les trois entrées de navigation (TRA-288, P1.3) ; Vérifier le mobile à chaque PR (TRA-289, P1.4)
#### Description

## Contexte
Le build iOS déjà installé doit devenir un socle interne traçable pour terminer track1. L'APK construit prouve la compilation Android ; l'installation et les tests physiques Android restent différés dans P8.1, sans retarder le chemin iOS.
Plan : docs/plans/track1-mobile.md, partie 1. Même ticket TRA-290 et branche existante, sans recréation.

## Portée
Finaliser `mobile/app.config.ts`, `mobile/eas.json`, `mobile/package.json`, `mobile/scripts/eas-build.mjs`, `mobile/scripts/eas-build.test.mjs` et `docs/track1-builds.md`. Ces configurations et le script ont été vérifiés sur la branche TRA-290 au SHA ca57d01cc6035d1a035ee49fed393f6ee1a8ab56 ; le document existe sur main. Conserver les assets déjà utilisés sous `mobile/assets/`. Accès Expo/Apple autorisés, sans secret dans Git. Hors-scope : publication publique, réception de push, appareil Android et Play Console.

## Contrat
Nom public track1 et schéma `track1://`. Reprendre les identifiants d'application et le projectId Expo réels déjà vérifiés dans TRA-290 ; la proposition initiale était `com.dropcliffs.track1` avec suffixe `.preview` pour les builds internes distincts, elle n'autorise pas à recréer ou substituer une identité existante. Consigner les valeurs publiques effectivement utilisées et leur propriétaire.
Profils EAS development (developmentClient, distribution interne), preview (binaire interne sans dev client), production (store) distincts, avec API/configuration publiques de l'environnement correspondant. Expo SDK57/React Native0.86 et patches verrouillés conservés ; iOS minimum16.4 et Android minimum24 selon la compatibilité retenue. Plugins SecureStore/Notifications et canal quotidien prévus, aucune dépendance audio. Production .ipa/.aab préparée ; aucun projet natif généré ni credential versionné.

Le script de build et ses commandes restent reproductibles et testés ; configuration résolue sans exposer les secrets. Documenter profils, commandes, build IDs/liens, plateforme, appareil/OS quand testé, version/build/SHA, date et résultat. Installation iPhone et navigation des trois onglets déjà prouvées : réutiliser la preuve si son SHA et les changements depuis ce SHA la rendent toujours applicable, sinon rejouer les contrôles affectés. Conserver le lien/SHA de l'APK réussi comme preuve de compilation seulement. Inscrire explicitement « Android physique : différé — non exécuté, repris dans P8.1 ». Une CI JS/TypeScript verte ne vaut pas compilation native. Une régression Android connue liée à cette branche doit être corrigée ici.

## Critères d'acceptation
- [ ] Profils development/preview/production, configuration publique résolue et identifiants réels cohérents ; les scripts et leur test existant passent.
- [ ] Le build iOS s'installe sur iPhone physique et les trois onglets fonctionnent, avec appareil/OS/version/SHA/date/preuve consignés ou justification documentée de réutilisation de la preuve acquise.
- [ ] L'APK Android compilé dispose d'un lien, d'une version et d'un SHA ; la preuve est pertinente pour le code retenu ou renouvelée après modification native qui l'invalide. L'installation Android reste explicitement non exécutée et transférée à P8.1.
- [ ] Aucun secret fournisseur, clé privée, projet natif généré ou fichier de credentials n'est committé ; aucune publication publique ni exigence Play Console ajoutée.
- [ ] Le contrat amendé est vérifié et la branche fusionnée avant clôture ; l'ancien critère physique Android n'est jamais annoncé réussi.

## Tests attendus
Exécuter mobile check, Expo doctor et test du script EAS existant ; vérifier les profils/résolutions sans imprimer de secret. Installation et navigation réelles iPhone, plus conservation ou renouvellement justifié de la preuve APK. Renseigner séparément les résultats iOS et Android ; aucune simulation ne remplace une preuve appareil.

## Tier de risque
tier/3 — configuration native et signature ; CI et review-gate requis verts, review ordinaire et attestation Sol/high profonde du SHA final, auto-merge après classification sans accord humain.

## Notes d'implémentation
Préserver l'historique du ticket et de sa branche. Le plan persisté signalait TRA-290 In Progress avec iPhone vérifié et APK construit ; relire son état réel avant transcription, ne pas lui attribuer un statut nouveau depuis ce texte. Les configurations n'étaient pas fusionnées lors de cette observation. La compilation finale Android sera également contrôlée en P6.5 ; sa recette physique relève de P8.1. Aucun upgrade SDK, compte ou identifiant inventé.

## Milestone 2 — Retrouver les contenus Odyssey depuis track1
- **Identifiant Linear conservé :** `eafe21af-b3ab-431d-b35b-50430311af01`.

### Description
- **Objectif produit :** donner à track1 un accès fiable aux contenus, à la recherche et à la création de fiches déjà proposés par Odyssey.
- **Solution :** ajouter une porte d'accès dédiée au mobile, réutilisant les services existants et présentant des réponses cohérentes. Consulter un contenu existant ne demande pas sa régénération.
- **Logiques ajoutées ou modifiées :** lecture et identité des fiches, recherche dans les contenus connus et le catalogue externe, chargement des images et liens, génération explicite suivie jusqu'à son résultat, erreurs compréhensibles.
- **Résultat observable :** les cinq types de fiches sont récupérables par le mobile ; une génération peut aboutir ou échouer proprement sans bloquer la consultation ; les interfaces utilisées par le web restent compatibles.

### Issue — Fournir le catalogue mobile et fixer le contrat d'accès
- **Référence plan :** P2.1
- **Identifiant :** TRA-291
- **UUID conservé :** `3293b4ca-4920-429e-b86a-d5844ec65448`
- **Tier :** tier/3
- **Dépendances :** Aligner les règles CI de taille et de merge (TRA-285, P1.1)
#### Description

## Contexte
Le mobile a besoin d'un catalogue léger pour les goûts et la recommandation, avec un contrat stable indépendant des routes web. La lecture ne doit jamais lancer une génération ni télécharger tous les articles.
Plan : docs/plans/track1-mobile.md, partie 2.

## Portée
Livrables à conserver/compléter ; créer uniquement les éléments encore absents : `docs/track1-api.md`, `src/mobile/contracts.ts`, `src/mobile/http.ts`, `src/mobile/router.ts`, `src/mobile/catalog.ts`, `test/mobile/catalog.test.ts`, `test/mobile/http.test.ts` et `test/fixtures/mobile-contracts.json`. Raccorder le routeur dans `src/server.ts`. Réutiliser `src/services/graph-service.ts`, `src/graph.ts`, `src/types.ts` et `src/node-spec.ts` en lecture seule. Hors-scope : schéma de nœuds, routes existantes, grille taxonomique web, stockage profil.

## Contrat
Base /mobile/v1, JSON UTF-8. Créer un routeur injectable `createMobileRouter(deps)` traitant uniquement ce préfixe et laissant les anciennes routes intactes ; les futurs tickets ajouteront leurs handlers. Validation des entrées par Zod, erreurs typées aux frontières. Erreur commune `{error:{code,message,retryable}}` : invalid_request400, not_found404, idempotency_conflict409, interrupted409, job_expired410, busy 429 avec Retry-After:30, provider_unavailable503, provider_quota_exhausted503, internal_error500. Messages publics français constants, aucun texte brut d'exception. MIME/body invalide → invalid_request, limite d'écriture8Kio →413 même code. Les identités reçues utilisent un type artist|project|track|genre|label, slug <= 200 au format type:body de `src/slug.ts` et du garde existant materialize (pas de slash, traversal, type incohérent), mbid UUID, qid /^Q[1-9]\d*$/ genre seulement.

GET /catalog → `{schema_version:1,revision,nodes,redirects}` ; `revision` hash SHA256 du contenu normalisé stable, hors timestamp. Catalogue trié par id ; nœud `{id,type,name,teaser,edges}` avec edges uniquement listes genres/subgenres/related_genres/landmark_projects/landmark_tracks/key_artists et références `{slug,type,name,mbid?,qid?,year?,releaseType?}` existantes. Pas d'article, citations, faits volumineux ni contenu web/data.json. Conserver les redirections et filtrages de createGraphService, y compris sa dégradation taxonomique sur origin/main ; ne pas rendre taxonomy requise côté mobile. Réponse ETag fort basé sur revision, Cache-Control private,max-age=0,must-revalidate ; If-None-Match correspondant →304 sans corps.

Fixer dans la doc les autres contrats déjà décidés : GET /nodes/:slug renvoie `{node:VizNode,source:'cache',redirected_from?}` ; image `{slug,image_url:null|string,source}` ; links `{slug,spotify:null|string,apple:null|string,sources,resolvedAt}` ; search conserve `{q,hits:[{source:'cache'|'catalog',type,name,subtitle?,extra?,mbid?,slug?}],sources:{cache,catalog}}`. POST /generations reçoit `{request_id:UUID,type,name,slug?,mbid?,qid?,disambiguator?}` ; suivi identifié par request_id, réponse `{request_id,status,created_at,updated_at,node_id?,error?}`, status queued|running|succeeded|failed|interrupted. Réussi exige node_id canonique, échec/interruption exige erreur publique. POST 202, GET suivi200 ou410. Aucun champ fresh accepté. Le document et les fixtures définissent les formats pour les tickets suivants, sans implémenter encore ces routes.

## Critères d'acceptation
- [ ] Le catalogue reproduit les identités/types/relations utiles du cache courant, sans article/citations ni génération ; alias et cas de taxonomy dégradée fonctionnent.
- [ ] Même contenu produit même revision malgré ordre disque/date ; contenu modifié produit une autre revision ; ETag conditionnel donne304 sans corps.
- [ ] Les nouvelles erreurs sont stables et publiques ; percent-encoding invalide, traversal et query/body invalides ne produisent pas de stack ou secret.
- [ ] Les anciennes routes continuent leur chemin de routage ; les fixtures nominales/invalides et tous les contrats ci-dessus sont documentés.

## Tests attendus
Vitest avec vrais NodeCache/graph-service sur répertoire temporaire, nœuds minimaux validés, alias, taxonomy absente/dégradée, ordre permuté, contenu modifié ; serveur HTTP stdlib monté avec le nouveau routeur pour 200/304/400/404. Aucune API externe sollicitée. npm run check en mode non interactif.

## Tier de risque
tier/3 — CI et review-gate requis verts ; ce gate exige l'attestation Sol/high profonde du SHA final en plus de la review ordinaire. Auto-merge après classification, sans accord humain.

## Notes d'implémentation
Référence serveur actualisée : origin/main 07998be ; conserver taxonomy:'degrade' et les options existantes. Le routeur reste additif. Types exportés nommés, pas de any ; aucun import du code serveur dans Metro. Documenter la sérialisation publique en exemples de données, pas une deuxième architecture.
Contrat du ticket existant TRA-291 : reprendre le code et les tests déjà livrés, conserver son statut réel, sa PR et ses preuves ; cet amendement n'ordonne ni recréation ni réouverture d'une tâche terminée.

### Issue — Lire une fiche, son image et ses liens sans génération implicite
- **Référence plan :** P2.2
- **Identifiant :** TRA-292
- **UUID conservé :** `aac2b1c8-82d8-4590-b9a8-855dca6e4be3`
- **Tier :** tier/3
- **Dépendances :** Fournir le catalogue mobile et fixer le contrat d'accès (TRA-291, P2.1)
#### Description

## Contexte
Lire une fiche sur mobile doit rester possible avec des crédits épuisés, même lorsque la fiche a vieilli. Les résolveurs existants fournissent ensuite image et liens, sans changer le lecteur web.
Plan : docs/plans/track1-mobile.md, partie 2.

## Portée
Livrables à conserver/compléter ; créer uniquement les éléments encore absents : `src/mobile/nodes.ts`, `src/mobile/media.ts`, `test/mobile/nodes.test.ts`, `test/mobile/media.test.ts`. Étendre `src/mobile/router.ts` et son assemblage dans `src/server.ts`. Réutiliser `src/cache.ts`, `src/genre-registry.ts`, `src/graph.ts`, `src/services/image-service.ts`, `src/streaming-links.ts`. Hors-scope : src/schemas.ts, format cache, /node web, /stream et /resolve, modèle.

## Contrat
GET /mobile/v1/nodes/:slug : valider slug, résoudre l'alias avec resolveReadSlug, lire NodeCache puis projeter avec toVizNode ; `{node:VizNode,source:'cache',redirected_from?}`, 404 not_found si absent, aucune vérification TTL déclenchant runJit. VizNode = id/type/name/teaser/article/citations/edges/facts/materialized_at, image_url?/qid? selon contrat existant. L'id renvoyé fait autorité. GET /nodes/:slug/image utilise resolveDisplayImage et renvoie `{slug:canonique,image_url,source}` ; /links utilise resolveStreamingLinks sans force, avec nom et premier artiste connus, et renvoie `{slug,spotify,apple,sources,resolvedAt}`. Genres/labels existants → liens nulls200 ; nœud absent404.

Valider les URL à la sortie de la façade : HTTPS, pas d'identifiants/port arbitraire, hostname normalisé et public (pas localhost/IP privée). Images : pas d'exécution HTML ni proxy d'URL arbitraire ; URL invalide →null. Écoute : hostname exact open.spotify.com ou music.apple.com, avec safeServiceUrl complété par rejet d'identifiants et port non443 ; URL invalide →null. Les enrichissements iTunes existants restent autorisés via le service et sa validation, sans appel au modèle. Erreur fournisseur → erreur publique provider_unavailable503, contenu de fiche indépendant. Cache image/links privé24 h, détail privé sans TTL de génération.

## Critères d'acceptation
- [ ] Une fiche plus vieille que12h se lit sans aucun appel au modèle ; un alias renvoie le bon id/redirected_from ; absent distinct d'une panne.
- [ ] Image directe, fallback iTunes, relation de secours, absence d'image et cycle terminent correctement ; URL hostile supprimée.
- [ ] Liens exacts conservés uniquement pour leurs hôtes autorisés ; genres/labels renvoient null ; aucune route audio appelée.
- [ ] Ancienne route /node et comportement des résolveurs pour le web inchangés ; erreurs publiques sans détail sensible.

## Tests attendus
Vrais cache et services sur fixtures temporaires ; frontières HTTP MusicBrainz/iTunes simulées. Tests ancien nœud avec transport modèle qui échouerait s'il était appelé, alias,404, boucle d'image, URL javascript/http/userinfo/host trompeur/privé et provider indisponible. Tests HTTP du routeur. Suites node-service/image-service/streaming-links existantes et check backend.

## Tier de risque
tier/3 — CI et review-gate requis verts ; ce gate exige l'attestation Sol/high profonde du SHA final en plus de la review ordinaire. Auto-merge après classification, sans accord humain.

## Notes d'implémentation
Ne pas appeler createNodeService.getNode pour la lecture mobile : il peut rafraîchir. Pas de copier-coller de pipeline ni modification manuelle du cache committé. Les citations sont des données, jamais du HTML exécutable.
Contrat du ticket existant TRA-292 : reprendre le code et les tests déjà livrés, conserver son statut réel, sa PR et ses preuves ; cet amendement n'ordonne ni recréation ni réouverture d'une tâche terminée.

### Issue — Exposer la recherche globale au mobile
- **Référence plan :** P2.3
- **Identifiant :** TRA-293
- **UUID conservé :** `07693777-c0ec-4719-a2e0-c1b43036eba2`
- **Tier :** tier/3
- **Dépendances :** Fournir le catalogue mobile et fixer le contrat d'accès (TRA-291, P2.1)
#### Description

## Contexte
La recherche mobile doit retrouver les cinq types musicaux et distinguer une fiche disponible d'un résultat de catalogue à créer. Elle réutilise la recherche existante sans la rendre publique sous un nouveau comportement payant.
Plan : docs/plans/track1-mobile.md, partie 2.

## Portée
Livrables à conserver/compléter ; créer uniquement les éléments encore absents : `src/mobile/search.ts`, `test/mobile/search.test.ts` ; étendre `src/mobile/router.ts` et son assemblage dans `src/server.ts`. Réutiliser `src/services/search-service.ts`, `src/cache-index.ts`, `src/musicbrainz.ts`. Hors-scope : moteur de recherche neuf, modèle, interface mobile, modification du contrat /search web.

## Contrat
GET /mobile/v1/search : q trim de2 à120 caractères, type absent ou enum des5 types, limit entier 1–25, défaut 8 ; refuser valeurs invalides en400 invalid_request. Réponse existante `{q,hits,sources}` avec hits source cache|catalog, type/name, subtitle?/extra?/mbid?/slug?. Une fiche cache exige slug ; les identifiants fournis par la source sont conservés. Genres/labels se recherchent dans le cache : pas d'invention d'un catalogue externe pour eux. Reprendre la déduplication MBID existante ; aucune matérialisation à la recherche. Réponses no-store pour éviter de figer une indisponibilité externe ; fournisseur indisponible503 provider_unavailable et non faux résultat vide200. Recréer/invalider l'index cache mobile après une génération réussie via la fonction d'invalidation du routeur ; ne pas laisser l'index initial masquer une nouvelle fiche.

## Critères d'acceptation
- [ ] Les5 filtres et l'absence de filtre produisent le format prévu, limits respectées et sources/cache disponibles distingués.
- [ ] La recherche ne déclenche aucune génération ; le MBID/slug d'un résultat n'est pas reconstitué par le mobile.
- [ ] Entrées invalides sont400 ; frontière externe défaillante est une erreur explicite sans mise en cache publique de faux vide.
- [ ] Après invalidation, une fiche nouvellement écrite apparaît dans la recherche cache.

## Tests attendus
Vrai cache-index/search-service et cache temporaire, frontière HTTP MusicBrainz simulée ; tests filtres5types,mbid doublon, q limites, limit invalide, panne externe et cache modifié. Intégration HTTP /mobile/v1/search, suite backend existante.

## Tier de risque
tier/3 — CI et review-gate requis verts ; ce gate exige l'attestation Sol/high profonde du SHA final en plus de la review ordinaire. Auto-merge après classification, sans accord humain.

## Notes d'implémentation
Si MusicBrainz masque déjà certaines pannes dans son résultat, documenter et propager seulement les erreurs disponibles sans refactor général ; ne pas inventer un total exhaustif de résultats. Le choix de5types ne crée pas de nouveau fournisseur genre/label.
Contrat du ticket existant TRA-293 : reprendre le code et les tests déjà livrés, conserver son statut réel, sa PR et ses preuves ; cet amendement n'ordonne ni recréation ni réouverture d'une tâche terminée.

### Issue — Conserver les demandes de génération malgré les redémarrages
- **Référence plan :** P2.4
- **Identifiant :** TRA-294
- **UUID conservé :** `583d4422-c205-4a89-9768-c176a8e0de65`
- **Tier :** tier/3
- **Dépendances :** Fournir le catalogue mobile et fixer le contrat d'accès (TRA-291, P2.1)
#### Description

## Contexte
Une demande de génération peut survivre à la fermeture du mobile, mais doit être reconnue comme interrompue si le serveur redémarre. Son état doit également survivre aux déploiements sans entrer dans le cache musical ou Git.
Plan : docs/plans/track1-mobile.md, partie 2.

## Portée
Livrables à conserver/compléter ; créer uniquement les éléments encore absents : `src/mobile/generation-store.ts`, `test/mobile/generation-store.test.ts`. Modifier `src/config.ts`, `.gitignore`, `deploy/deploy-server.sh` et documenter `docs/track1-api.md`. Références existantes : writes atomiques de `src/cache.ts`. Hors-scope : base de données, multi-instance, reprise automatique d'une génération, modification du schéma musical.

## Contrat
MOBILE_STATE_DIR par défaut `.runtime/mobile`, ignoré localement ; production `/var/lib/track1-mobile`, hors arbre rsync. Déploiement crée le répertoire et droits réservés au process service, ne le copie pas en cache ni ne l'efface. Registre atomique `generations.json` version 1, validation à la lecture, opérations sérialisées dans le process. Entrée `{request_id,input,fingerprint,status,created_at,updated_at,node_id?,error?}` ; input musical validé, fingerprint SHA256 d'une sérialisation normalisée d'identité. Fonctions nommées pour createOrGet/read/transition/recover/prune. Même request_id+même fingerprint renvoie l'existant ; même request_id+autre input donne idempotency_conflict409. Transitions queued→running→succeeded|failed ; queued/running au démarrage→interrupted sans appel payant. État terminal immuable.

Conserver au plus 1 000 entrées terminales, expirées après 24 h (UTC, horloge injectée) ; ne jamais évincer une demande active pour ce plafond. Une lecture d'id inconnu/expiré est job_expired410 pour le protocole mobile. En cas de registre invalide/inaccessible, ne pas l'écraser silencieusement : remonter indisponibilité des générations, préserver le fichier et permettre aux routes de lecture de continuer. La file d'attente/exécution vient de P2.5.

## Critères d'acceptation
- [ ] Une écriture interrompue laisse l'ancienne ou la nouvelle version JSON complète ; deux mises à jour simultanées ne s'écrasent pas.
- [ ] Même demande retrouvée après réouverture ; conflit d'identité rejeté ; demandes actives deviennent interrompues sans reprise du pipeline.
- [ ] TTL 24 h/plafond 1 000 purgent seulement les terminaux ; registre corrompu préservé et panne limitée aux écritures/générations.
- [ ] Redéploiement et redémarrage préservent /var/lib/track1-mobile, hors Git et cache musical.

## Tests attendus
Vitest avec système de fichiers temporaire réel, horloge déterministe, relecture après fermeture, concurrence, transitions invalides, corruption et erreurs d'accès. Vérification shell syntaxique du déploiement et recette de deux déploiements sur environnement autorisé ; aucun effacement de données réelles pour simuler une panne.

## Tier de risque
tier/3 — CI et review-gate requis verts ; ce gate exige l'attestation Sol/high profonde du SHA final en plus de la review ordinaire. Auto-merge après classification, sans accord humain.

## Notes d'implémentation
Respecter l'architecture mono-process existante. Pas de secret fournisseur dans ce registre. Les modifications deploy sont tier/3 et conservent les commandes/permissions existantes hors répertoire mobile.
Contrat du ticket existant TRA-294 : reprendre le code et les tests déjà livrés, conserver son statut réel, sa PR et ses preuves ; cet amendement n'ordonne ni recréation ni réouverture d'une tâche terminée.

### Issue — Déclencher et suivre une génération publique de bout en bout côté serveur
- **Référence plan :** P2.5
- **Identifiant :** TRA-295
- **UUID conservé :** `2140381a-c8f0-4e72-8093-38fb35c5a566`
- **Tier :** tier/3
- **Dépendances :** Conserver les demandes de génération malgré les redémarrages (TRA-294, P2.4)
#### Description

## Contexte
Un utilisateur sans compte doit pouvoir créer une fiche manquante et retrouver le résultat malgré une déconnexion. L'application reçoit un suivi immédiat plutôt qu'une requête bloquée pendant l'appel au modèle.
Plan : docs/plans/track1-mobile.md, partie 2.

## Portée
Livrables à conserver/compléter ; créer uniquement les éléments encore absents : `src/mobile/generation-service.ts`, `src/mobile/generation-errors.ts`, `src/mobile/generation-routes.ts`, `test/mobile/generation.test.ts`. Étendre `src/mobile/router.ts` et `src/server.ts`. Réutiliser `src/services/materialize-service.ts` ; y ajouter uniquement l'option interne de réutilisation d'un nœud existant décrite ci-dessous si nécessaire, avec tests `test/materialize-service.test.ts`. Hors-scope : modèle/fournisseur de génération, comptes/quota utilisateur, fraîcheur web, schéma, anti-abus général.

## Contrat
POST /mobile/v1/generations corps strict≤8Kio `{request_id:UUID,type,name,slug?,mbid?,qid?,disambiguator?}` : name trim 1–200, disambiguator trim 1–200 si présent, type/slug cohérents, mbid UUID et qid genre /^Q[1-9]\d*$/. Refuser fresh et champs inconnus. Sauver avant retour202 `{request_id,status,created_at,updated_at,node_id?,error?}` ; Location /mobile/v1/generations/:request_id. GET même ressource renvoie200 et état, ou410 job_expired. Même id+input = même suivi, input différent409.

Deux exécutions simultanées, dix demandes en attente, pas de quota utilisateur ; saturation429 busy Retry-After: 30 sans enregistrer de nouveau travail. Demandes d'une même identité partagent l'exécution existante, sans deuxième appel payant, même avec deux request_id. Vérifier l'identité canonique selon les règles materialize/genre-registry avant génération. Une fiche existante, même ancienne, retourne succeeded avec son vrai slug ; aucun refresh mobile. Option interne `reuseExisting:true` à handleMaterialize, defaultfalse pour conserver le web, permet cette garantie après sa canonicalisation ; identifiants fournis contradictoires avec une fiche existante→400, jamais écraser cette fiche. Pas de fresh. Une génération réussie invalide index mobile/revision du catalogue et retourne node.slug, pas le slug supposé depuis name.

Normaliser quota fournisseur (`RESOURCE_EXHAUSTED`, code 429/quota explicite) en provider_quota_exhausted ; indisponibilité/timeout fournisseur en provider_unavailable ; erreur inconnue en internal_error. Message public constant, retryable false pour quota et interruption, true pour panne passagère ; logs sans clé ou texte de requête sensible. Une erreur n'efface aucun contenu existant. Après redémarrage, registre interrompu ; nouvelle action explicite vérifie d'abord si la fiche a été écrite. Aucun retry automatique de travail interrompu.

## Critères d'acceptation
- [ ] POST répond202 avant achèvement du modèle et GET suit tous les états ; double envoi de même demande et deux demandes de même identité ne coûtent qu'une exécution.
- [ ] Ancienne fiche existante et alias sont réutilisés sans modèle ; résultat final canonique et nouvelle fiche visible dans recherche/catalogue après invalidation.
- [ ] Concurrence/queue respectées, saturation et entrée hostile traitées ; nom/slug/mbid contradictoires n'écrasent pas le cache.
- [ ] Crédits épuisés, panne, redémarrage et erreur inconnue donnent les états publics attendus, sans secret ni boucle de reprise ; web garde son refresh existant.

## Tests attendus
Intégration native HTTP+registre+cache réels avec frontières HTTP du modèle/recherche simulées, pas mocks des services possédés. Horloge/transport contrôlés pour réponse 202 avant fin, doublons concurrents, file saturée, état persistant, quota, interruption et index invalidé. Régression materialize : default garde refresh, reuseExisting réutilise le stale sans appel ; tests d'identité existants maintenus.

## Tier de risque
tier/3 — CI et review-gate requis verts ; ce gate exige l'attestation Sol/high profonde du SHA final en plus de la review ordinaire. Auto-merge après classification, sans accord humain.

## Notes d'implémentation
Ne pas intégrer la PR Gemini→Haiku hors scope : appeler le service existant indépendamment du fournisseur. Pas de suppression d'auth inexistante ni de clé embarquée. Tout appel encore ambigu après déconnexion est suivi par le même id, jamais rejoué comme un nouveau geste.
Contrat du ticket existant TRA-295 : reprendre le code et les tests déjà livrés, conserver son statut réel, sa PR et ses preuves ; cet amendement n'ordonne ni recréation ni réouverture d'une tâche terminée.

### Issue — Donner au mobile un client réseau validé et résilient
- **Référence plan :** P2.6
- **Identifiant :** TRA-296
- **UUID conservé :** `81ff104c-17fd-41a5-bd20-34b0c27ce94d`
- **Tier :** tier/2
- **Dépendances :** Installer un socle mobile reproductible et vérifiable (TRA-287, P1.2) ; Fournir le catalogue mobile et fixer le contrat d'accès (TRA-291, P2.1)
#### Description

## Contexte
Le mobile doit recevoir des données validées et distinguer absence, panne réseau et indisponibilité de génération. Un client unique évite que chaque écran réinvente ces règles.
Plan : docs/plans/track1-mobile.md, partie 2.

## Portée
Livrables à conserver/compléter ; créer uniquement les éléments encore absents : `mobile/src/api/contracts.ts`, `mobile/src/api/client.ts`, `mobile/src/api/errors.ts`, `mobile/test/api-client.test.ts` et fixtures mobiles. Consommer la configuration de `mobile/src/config.ts`. Référence du protocole : `docs/track1-api.md` livré par dépendance. Hors-scope : cache persistant, écrans, imports du serveur dans Metro, nouvelle librairie réseau.

## Contrat
Créer un client fetch injectable avec méthodes getCatalog({etag?,signal?}), getNode(slug), getImage(slug), getLinks(slug), search({q,type?,limit?}), createGeneration(input), getGeneration(request_id). Résultats typés success/notModified/error ; aucune exception réseau non traitée. API base issue de config, paths contrôlés et encodeURIComponent des slugs. GET timeout 15 s, POST accusé15 s et suivi GET15 s, AbortSignal supporté ; jamais retry automatique POST. Une annulation d'écran ne signifie pas échec de la génération.

Valider en Zod toutes les réponses : catalogue `{schema_version:1,revision,nodes:[{id,type,name,teaser,edges}],redirects}` ; fiche `{node:{id,type,name,teaser,article,citations,edges,facts,materialized_at,image_url?,qid?},source:'cache',redirected_from?}` ; image et liens nullables ; search `{q,hits:[{source,type,name,slug?,mbid?,subtitle?,extra?}],sources}` ; suivi `{request_id,status:queued|running|succeeded|failed|interrupted,created_at,updated_at,node_id?,error?}`. Succeeded exige node_id, failed/interrupted une erreur publique. Erreur API `{error:{code,message,retryable}}`, statuts400/404/409/410/413/429/500/503 ; localement network_error, timeout, cancelled, invalid_response. Un304 n'est valide que pour catalogue avec copie déjà possédée ; retourner notModified avec ETag. Header Retry-After est une information d'UI, pas une instruction de relance automatique.

## Critères d'acceptation
- [ ] Chaque réponse nominale est validée et correctement typée ; schéma inconnu/champs incohérents deviennent invalid_response.
- [ ] Timeout, annulation, JSON invalide,404,429/quota503 restent distingués ; un message brut fournisseur n'est jamais rendu.
- [ ] URLs de requête restent sous la base configurée ; slug malveillant ne change ni host ni chemin de route.
- [ ] Une création ne se répète jamais automatiquement ;304 catalogue et Retry-After sont conservés sans déclencher d'action.

## Tests attendus
Jest sur le vrai client avec seule frontière fetch contrôlée : nominal par méthode, schema_version inconnu, ID/type incohérent, states terminaux incomplets,304 avec/sans ETag, timeout/abort, encodage et compteur POST=1. Vérifier fixtures conformes au protocole. Mobile check.

## Tier de risque
tier/2 — CI et review-gate verts, review IA selon le processus, auto-merge après classification du tier.

## Notes d'implémentation
Pas d'axios, React Query ou import de modules Node serveur. Les écrans ne passent jamais de token fournisseur ; seule la collecte Segment a sa write key publique indépendante.
Contrat du ticket existant TRA-296 : reprendre le code et les tests déjà livrés, conserver son statut réel, sa PR et ses preuves ; cet amendement n'ordonne ni recréation ni réouverture d'une tâche terminée.

### Issue — Déployer l'accès mobile sans régression du site
- **Référence plan :** P2.7
- **Identifiant :** TRA-297
- **UUID conservé :** `b0f1104b-f9d4-46a9-bf3d-ebebf2968a7d`
- **Tier :** tier/3
- **Dépendances :** Lire une fiche, son image et ses liens sans génération implicite (TRA-292, P2.2) ; Exposer la recherche globale au mobile (TRA-293, P2.3) ; Conserver les demandes de génération malgré les redémarrages (TRA-294, P2.4) ; Déclencher et suivre une génération publique de bout en bout côté serveur (TRA-295, P2.5) ; Donner au mobile un client réseau validé et résilient (TRA-296, P2.6)
#### Description

## Contexte
Les routes mobile partagent le serveur utilisé par Odyssey web. Cette recette transverse démontre leur fonctionnement déployé et la conservation des anciens contrats, notamment le streaming web.
Plan : docs/plans/track1-mobile.md, partie 2.

## Portée
Livrables à conserver/compléter ; créer uniquement les éléments encore absents : `test/mobile/compatibility.test.ts`, compléter `scripts/verify-e2e.sh` uniquement pour les checks mobiles et `docs/track1-api.md` pour les preuves. Exécuter le déploiement existant `deploy/deploy-server.sh` depuis la révision approuvée. Hors-scope : refactor serveur, modification des pages web, changement de domaine/nginx externe et corrections fonctionnelles silencieuses.

## Contrat
Recette de référence sur fixtures pour GET /health, /data.json, /node/:slug, /search, /image/:slug, /links/:slug, POST /materialize et routage /resolve,/stream ; comparer statuts/enveloppes documentés, ne pas exiger disponibilité d'un service audio tiers en test hors réseau. Recette mobile complète : catalogue200/304, fiche stale sans modèle, alias, recherche5types, media nulls, génération202→terminal, erreur quota, idempotence et redémarrage. Déploiement expose https://dropcliffs.com/api/odyssey/mobile/v1 via le proxy existant ; état /var/lib/track1-mobile conservé. Consigner SHA effectivement déployé via /version, date UTC et résultats. Les appels payants en production sont limités à la création explicite d'une fiche manquante convenue dans la recette, jamais un scan ou fresh généralisé.

## Critères d'acceptation
- [ ] Tests de compatibilité passent pour anciennes et nouvelles routes ; le client mobile consomme les réponses réelles de la façade.
- [ ] Déploiement identifié par son SHA accessible en HTTPS ; lecture, recherche, erreurs et ETag vérifiés publiquement sans secret.
- [ ] Deux déploiements/redémarrage préservent le registre et n'entraînent aucune reprise payante des travaux interrompus.
- [ ] Aucune modification de web/index.html, web/data.json, cache musical manuel ou suppression du streaming ; tout échec fonctionnel est corrigé dans son ticket propriétaire avant clôture.

## Tests attendus
Tests d'intégration hors réseau avec serveurs/cache/routeur réels, seulement fournisseurs externes simulés ; npm run check et mobile check. Smoke HTTPS non destructif après déploiement, preuves du redémarrage et comparaison /version. Pas de test live massif ni de donnée utilisateur effacée.

## Tier de risque
tier/3 — CI et review-gate requis verts ; ce gate exige l'attestation Sol/high profonde du SHA final en plus de la review ordinaire. Auto-merge après classification, sans accord humain.

## Notes d'implémentation
Cette tâche reste distincte car elle vérifie plusieurs composants et le déploiement réel. Ne pas déployer le worktree sale partagé : utiliser la révision issue des PR fusionnées. Les credentials serveur restent sur le serveur.
Contrat du ticket existant TRA-297 : reprendre le code et les tests déjà livrés, conserver son statut réel, sa PR et ses preuves ; cet amendement n'ordonne ni recréation ni réouverture d'une tâche terminée.

## Milestone 3 — Découvrir et écouter une recommandation chaque jour
- **Identifiant Linear conservé :** `e9eb7993-dcae-41cc-870e-a225a1cae6ca`.

### Description
- **Objectif produit :** livrer le parcours qui donne sa raison d'être à track1 : une découverte quotidienne personnalisée, facile à explorer puis à écouter.
- **Solution :** conserver les genres choisis sur le téléphone, reprendre la logique de recommandation d'Odyssey et proposer un rappel quotidien facultatif. Une fiche commune relie la découverte à d'autres contenus et aux services d'écoute.
- **Logiques ajoutées ou modifiées :** choix et modification des goûts, stabilité de la recommandation dans la journée, limitation des répétitions, autorisation et désactivation des rappels, retour dans l'application, lecture d'une fiche et ouverture d'un service externe.
- **Résultat observable :** sur iPhone, une personne passe de son premier choix de goûts à une découverte expliquée, reçoit le rappel si elle l'accepte, ouvre une fiche liée et rejoint Spotify ou Apple Music. Le même parcours fonctionne en ouvrant directement l'application après refus du rappel ; sa recette Android est conservée pour la reprise ultérieure.

### Issue — Choisir, modifier et conserver ses goûts sur le téléphone
- **Référence plan :** P3.1
- **Identifiant :** TRA-298
- **UUID conservé :** `7d9d2bdb-6659-4df7-b684-a3c9d9213905`
- **Tier :** tier/3
- **Dépendances :** Ouvrir les trois entrées de navigation (TRA-288, P1.3) ; Fournir le catalogue mobile et fixer le contrat d'accès (TRA-291, P2.1) ; Donner au mobile un client réseau validé et résilient (TRA-296, P2.6) ; Mesurer les parcours uniquement selon le choix de la personne (TRA-314, P5.2)
#### Description

## Contexte
Une personne doit pouvoir définir ses goûts sans compte, puis les retrouver à chaque ouverture. Le choix de mesure est déjà livré séparément ; ce ticket ajoute le profil musical local et son interface.
Plan : docs/plans/track1-mobile.md, partie 3.

## Portée
Livrables à conserver/compléter ; créer uniquement les éléments encore absents : `mobile/src/profile/model.ts`, `mobile/src/profile/store.ts`, `mobile/src/profile/useProfile.ts`, `mobile/app/onboarding.tsx`, `mobile/test/profile.test.ts`, `mobile/test/onboarding.test.tsx`. Modifier `mobile/app/_layout.tsx` et `mobile/app/(tabs)/settings.tsx` livrés par la navigation. Consommer `mobile/src/api/client.ts` et `mobile/src/analytics/` issus des dépendances. Aucun endpoint profil, nom/email, connexion ou changement web.

## Contrat
Profil AsyncStorage version 1, clé `track1.profile.v1` : `{version:1,local_id:UUID,genre_ids:string[],revision:entier,onboarding_completed:boolean,flow_id:UUID}`. Validation au chargement, genres uniques et identifiants canoniques du catalogue ; identifiant musical indépendant de l'identité analytics et du secret push. Conserver un brouillon de sélection pour reprendre après fermeture. Au moins 3 genres pour terminer ; si seulement 1 ou 2 sont disponibles, les sélectionner tous suffit. Si aucun genre, afficher réessayer et accès Recherche sans profil, sans déclarer l'onboarding terminé. Ne pas supprimer silencieusement une préférence parce que le réseau ou un catalogue incomplet ne la restitue pas.

Une sauvegarde validée écrit le profil avant la navigation et augmente revision si les genres changent. Réglages permet modifier les genres et effacer profil/historique musical avec confirmation ; effacement réinitialise local_id, profil et clés `track1.recommendation.*`, puis retourne au choix des goûts, sans changer consentement analytics ni permission/abonnement push. Un profil corrompu est signalé puis réinitialisable, sans bloquer Recherche. Stockage impossible : rester sur place avec réessayer, pas de faux succès.

Instrumentation via le collecteur consenti : onboarding_started une fois par flow_id à la grille visible, onboarding_completed après écriture une fois par flux avec genres_count ; preferences_updated après modification/effacement avec action updated|cleared et nombre uniquement. Aucun genre ni identifiant de profil envoyé.

## Critères d'acceptation
- [ ] Sélection nominale, seuil3, catalogue1/2/0 et reprise de brouillon répondent aux règles ; la grille garde des labels accessibles et une sélection visible.
- [ ] Après redémarrage les mêmes goûts/local_id sont retrouvés ; changement augmente revision une seule fois et provoque la future invalidation de sélection quotidienne.
- [ ] Corruption et échec de stockage ont une reprise explicite ; effacement retire profil et recommandations mais conserve les deux choix indépendants de notifications et mesure.
- [ ] Événements émis aux seuls moments convenus, sans goûts et sans doublon de rendu ; refus analytics donne zéro événement.

## Tests attendus
Jest avec vrais modèle/store et frontière AsyncStorage simulée : migrations/version inconnue, déduplication, write failure, effacement limité. Tests d'interaction de la grille et réglages avec catalogue fixtures réel, reprise et appels du collecteur contrôlé ; mobile check.

## Tier de risque
tier/3 — CI et review-gate requis verts ; ce gate exige l'attestation Sol/high profonde du SHA final en plus de la review ordinaire. Auto-merge après classification, sans accord humain.

## Notes d'implémentation
Réutiliser les genres présents, pas un catalogue parallèle. Un futur chargement des recommandations compare profile.revision. Ne pas ajouter de synchronisation serveur ou d'import du profil web.
Contrat du ticket existant TRA-298 : reprendre le code et les tests déjà livrés, conserver son statut réel, sa PR et ses preuves ; cet amendement n'ordonne ni recréation ni réouverture d'une tâche terminée.

### Issue — Lire une fiche et explorer ses relations
- **Référence plan :** P3.2
- **Identifiant :** TRA-299
- **UUID conservé :** `f6b4025a-11a4-4f0e-b076-21af05184f16`
- **Tier :** tier/2
- **Dépendances :** Ouvrir les trois entrées de navigation (TRA-288, P1.3) ; Lire une fiche, son image et ses liens sans génération implicite (TRA-292, P2.2) ; Donner au mobile un client réseau validé et résilient (TRA-296, P2.6) ; Mesurer les parcours uniquement selon le choix de la personne (TRA-314, P5.2)
#### Description

## Contexte
Une découverte doit déboucher sur une fiche lisible et permettre de passer à ses relations musicales. Une présentation commune aux cinq types livre ce parcours avant leurs sections spécialisées.
Plan : docs/plans/track1-mobile.md, partie 3.

## Portée
Livrables à conserver/compléter ; créer uniquement les éléments encore absents : `mobile/app/node/[slug].tsx`, `mobile/src/components/NodeArticle.tsx`, `mobile/src/components/NodeRelations.tsx`, `mobile/src/components/NodeImage.tsx`, `mobile/src/navigation/context.ts`, `mobile/test/node-screen.test.tsx`, `mobile/test/node-relations.test.tsx`. Consommer API/config/analytics livrés. Hors-scope : nouveaux champs serveur, graphe animé, écoute (P3.4), génération (P4.4) et variantes détaillées P4.1/P4.2.

## Contrat
La route prend un slug validé ; getNode renvoie `{node:VizNode,source:'cache',redirected_from?}` avec id/type/name/teaser/article/citations/edges/facts/materialized_at et champs image/qid facultatifs. Afficher nom, libellé français du type, teaser, article en texte natif (paragraphes/listes, aucun HTML exécuté) et sources. L'image passe par getImage/expo-image avec remplacement accessible en cas d'absence/erreur. Les citations sont rendues comme texte ; n'ouvrir que leurs URL HTTPS validées sans identifiants/port non standard, jamais javascript/data/file.

NodeRelations accepte edges simples ou tableaux d'EdgeRef `{slug,type,name,mbid?,qid?,year?,releaseType?}` ; une section par relation non vide, appui vers `/node/[slug]` et retour conservant la fiche précédente. Alias remplace l'identité affichée par node.id sans empiler une seconde fiche. Une fiche absente affiche son identité disponible et un état explicite ; l'emplacement de l'action de génération sera raccordé en P4.4, aucune génération automatique. Erreur réseau distincte d'absence, bouton réessayer non payant.

Contexte de navigation public `{source,recommendation_id?,notification_id?}` propagé à la fiche puis aux relations ; un nouveau départ indépendant depuis un onglet le réinitialise. node_viewed une fois par entrée de navigation dont la fiche est chargée et visible ; relation_opened par geste avec from_node_id,node_id,node_type,relation_kind. Pas d'événement de vue pour erreur, placeholder ou simple rerender.

## Critères d'acceptation
- [ ] Les cinq types se lisent depuis les mêmes fixtures sans HTML exécuté ; longs textes, sources et image absente/hostile ont un rendu sûr.
- [ ] Alias conduit à l'identité canonique ; absent et panne sont distincts, réessayer ne déclenche aucun POST génération ni audio.
- [ ] Relations simples/tableaux et cycles de navigation fonctionnent ; retour Android/iOS retrouve la fiche précédente.
- [ ] Attribution et événements ont les identifiants canoniques attendus, aucun doublon sur rerender ni collecte après refus.

## Tests attendus
Jest rendu/interactions avec fixtures des cinq types, articles multiline, citations hostiles, image nulle/erreur, alias,404/503, relations cycliques et retour. Tester les parseurs possédés réellement, mocker seulement réseau/Linking/expo-image frontières natives ; mobile check.

## Tier de risque
tier/2 — CI et review-gate verts, review IA selon le processus, auto-merge après classification du tier.

## Notes d'implémentation
VizNode est le DTO, ne pas importer le code serveur dans Metro. Garder les libellés français hors types techniques. Faits et relations spécialisés restent l'incrément P4. Les assertions de navigation iOS/Android partagées sont conservées ; la recette physique Android appartient à P8.1, sans conditionner la preuve iPhone.
Contrat du ticket existant TRA-299 : reprendre le code et les tests déjà livrés, conserver son statut réel, sa PR et ses preuves ; cet amendement n'ordonne ni recréation ni réouverture d'une tâche terminée.

### Issue — Proposer et retrouver sa découverte du jour
- **Référence plan :** P3.3
- **Identifiant :** TRA-300
- **UUID conservé :** `2ac5e9af-5088-4cc8-bce4-385f210daaeb`
- **Tier :** tier/2
- **Dépendances :** Choisir, modifier et conserver ses goûts sur le téléphone (TRA-298, P3.1) ; Lire une fiche et explorer ses relations (TRA-299, P3.2)
#### Description

## Contexte
Aujourd'hui doit proposer une découverte expliquée, stable toute la journée, sans compte ni accès au modèle. Le refus des notifications ne doit rien retirer à cette promesse.
Plan : docs/plans/track1-mobile.md, partie 3.

## Portée
Livrables à conserver/compléter ; créer uniquement les éléments encore absents : `mobile/src/recommendation/affinity.ts`, `mobile/src/recommendation/daily.ts`, `mobile/test/affinity.test.ts`, `mobile/test/daily.test.ts`, `mobile/test/today.test.tsx`. Modifier `mobile/app/(tabs)/index.tsx`. Lire la logique existante `web/index.html` (scoreAffinity/pickDailyReco/recoReasons) sans la modifier ; réutiliser profil, catalogue, fiche et collecteur.

## Contrat
scoreAffinity considère artist/project/track seulement : +3 pour chaque genre direct sélectionné, +1 pour un genre proche présent dans subgenres/related_genres d'un genre sélectionné, +4 pour landmark_projects/landmark_tracks du genre, +3 pour key_artists. Une contribution de même relation/genre n'est comptée qu'une fois. Exclure les scores nuls, trier score décroissant puis slug croissant et garder 60. Motifs français dérivés des contributions réellement présentes, pas générés par IA.

Choisir avec une fonction déterministe utilisant local_id et date civile locale YYYY-MM-DD (hash FNV-1a 32 UTF-8, index hash modulo nombre de candidats éligibles triés), en excluant les 40 dernières propositions tant qu'un candidat inédit existe. Si tout le groupe a été vu, recommencer un cycle sur ce groupe. Aucun bouton de reroll. Stockage AsyncStorage version 1 sous la clé `track1.recommendation.v1`, effaçable par P3.1. Persister avant présentation `{recommendation_id:UUID,local_date,profile_revision,node_id,node_type,name,teaser,reasons,view_event_id,view_recorded}` ; historique borné à 40 propositions et sélections indexées par date dans ce même horizon. Une date déjà visitée reprend sa sélection tant qu'elle est conservée ; mise à jour du catalogue seule ne change rien. Changement de goûts/revision recalcule explicitement et remplace la sélection de cette date ; effacement profil supprime l'historique. Horloge et tirage sont injectables pour tests, aucune dépendance réseau au calcul.

Aujourd'hui affiche carte, image ou remplacement, raisons et Découvrir vers la fiche avec recommendation_id. Absence de profil propose goûts ; catalogue vide/panne sans cache ou scores nuls donne explication, réessayer/modifier goûts/Recherche. daily_recommendation_viewed une fois par sélection visible persistée, opened à chaque geste ; persister l'indicateur de vue même sans consentement pour ne pas rattraper l'historique après accord tardif. Passage de date détecté à l'ouverture/retour au premier plan.

## Critères d'acceptation
- [ ] Barème, classement, top60, exclusion40 et nouveau cycle sont déterministes et testés ; genres/labels ne sont jamais recommandés.
- [ ] Même jour/redémarrage/catalogue rafraîchi conservent sélection et raisons ; changement de jour/goûts et retour de fuseau suivent le contrat.
- [ ] Carte/fiche restent accessibles après refus des notifications ; profils ou catalogues absents ne provoquent aucun appel modèle ni crash.
- [ ] Vue unique persistée et ouverture par geste sont correctement attribuées ; image indisponible n'empêche pas Découvrir.

## Tests attendus
Tests purs de score avec contributions directes/proches/repères, doublons et égalités ; tests avec horloge et stockage réel abstrait pour 40 dates et plus, fuseaux, redémarrage, nouveau profil et panne d'écriture. Rendu/interactions Aujourd'hui et analytics consentis/non consentis ; mobile check.

## Tier de risque
tier/2 — CI et review-gate verts, review IA selon le processus, auto-merge après classification du tier.

## Notes d'implémentation
Le hash fixe seulement le tirage déterministe autorisé, pas une nouvelle logique de personnalisation. Une défaillance de persistance est visible avec réessayer ; ne pas afficher une sélection prétendument stable qui n'a pas été enregistrée.
Contrat du ticket existant TRA-300 : reprendre le code et les tests déjà livrés, conserver son statut réel, sa PR et ses preuves ; cet amendement n'ordonne ni recréation ni réouverture d'une tâche terminée.

### Issue — Rejoindre Spotify ou Apple Music depuis une fiche
- **Référence plan :** P3.4
- **Identifiant :** TRA-301
- **UUID conservé :** `9c0d86a6-d1da-4ced-8099-8cf77d0ab1ae`
- **Tier :** tier/2
- **Dépendances :** Lire une fiche et explorer ses relations (TRA-299, P3.2)
#### Description

## Contexte
track1 conduit à l'écoute dans le service habituel, sans lecteur intégré. Un lien manquant doit devenir une recherche explicite, pas un bouton présenté à tort comme une œuvre identifiée.
Plan : docs/plans/track1-mobile.md, partie 3.

## Portée
Conserver et compléter `mobile/src/listening/actions.ts`, `mobile/test/listening-actions.test.ts` et leur raccordement dans `mobile/app/node/[slug].tsx`, chemins vérifiés sur main. Le découpage initial links/open/ListeningActions est un historique de conception, pas un ordre de recréer des modules ou de refactorer une livraison existante. Consommer getLinks et Linking ; aucune dépendance audio, auth Spotify/Apple, route YouTube ou modification web.

## Contrat
Pour artist/project/track, deux actions Spotify et Apple Music. Privilégier le lien exact renvoyé par getLinks après revalidation HTTPS, hôte exact open.spotify.com ou music.apple.com, aucun userinfo ni port non standard. Sinon recherche officielle : Spotify `https://open.spotify.com/search/<encodeURIComponent(terme)>`, Apple `https://music.apple.com/search?term=<terme encodé>`. Terme = nom + premier artiste connu des relations (sans dupliquer le nom d'un artiste). Libellé de repli « Rechercher sur Spotify/Apple Music » ; genre/label n'ont pas de boutons d'écoute.

La promesse de Linking.openURL résolue est un succès d'ouverture OS, pas une preuve de lecture. Un échec laisse la fiche en place et affiche un message public avec nouvelle tentative. Une URL hostile n'est jamais ouverte ; le repli sûr reste possible et clairement identifié. Émettre external_listening_opened après succès, failed pour tentative refusée avec error_code unsafe_url|open_failed, provider spotify|apple_music, link_kind exact|search, node_id/type et contexte de parcours. Pas de collecte d'URL brute.

## Critères d'acceptation
- [ ] Liens exacts et replis ont labels et hôtes corrects ; noms Unicode/ponctuation sont encodés sans injection.
- [ ] Genres/labels ne présentent aucune écoute trompeuse ; liens nuls ou fournisseur indisponible laissent une recherche sûre disponible.
- [ ] URL hostile ou échec OS ne quitte pas la fiche sans explication ; aucun appel streaming/audio.
- [ ] Succès/échec sont distincts dans les événements et ne sont jamais décrits comme une lecture audio confirmée.

## Tests attendus
Jest table de validation (sous-domaines trompeurs, userinfo, ports, schémas et caractères encodés), construction des recherches et composants. Intégration frontière Linking succès/échec, attribution depuis reco/relation ; smoke appareil avec service installé puis absent lors de P3.9.

## Tier de risque
tier/2 — CI et review-gate verts, review IA selon le processus, auto-merge après classification du tier.

## Notes d'implémentation
Réutiliser uniquement les deux services validés ; pas de sélection automatique d'un compte ni d'import de bibliothèque musicale.
Contrat du ticket existant TRA-301 : reprendre le code et les tests déjà livrés, conserver son statut réel, sa PR et ses preuves ; cet amendement n'ordonne ni recréation ni réouverture d'une tâche terminée.

### Issue — Gérer les abonnements anonymes aux rappels
- **Référence plan :** P3.5
- **Identifiant :** TRA-302
- **UUID conservé :** `cc5d1c6b-50b4-4dcf-89c3-69f9399a7c20`
- **Tier :** tier/3
- **Dépendances :** Conserver les demandes de génération malgré les redémarrages (TRA-294, P2.4)
#### Description

## Contexte
Les rappels doivent être adressés à une installation volontaire sans créer de compte ni envoyer ses goûts. Le serveur doit pouvoir modifier et supprimer cet abonnement avec un secret réservé au téléphone.
Plan : docs/plans/track1-mobile.md, partie 3.

## Portée
Livrables à conserver/compléter ; créer uniquement les éléments encore absents : `src/mobile/push-store.ts`, `src/mobile/push-routes.ts`, `test/mobile/push-store.test.ts`, `test/mobile/push-routes.test.ts`. Raccorder `src/mobile/router.ts`, compléter `docs/track1-api.md`. Réutiliser MOBILE_STATE_DIR et les primitives atomiques livrées par P2.4. Aucun profil serveur, identifiant analytics, nouveau schéma musical ou envoi Expo dans ce ticket.

## Contrat
Registre atomique version 1 `push-subscriptions.json` dans MOBILE_STATE_DIR, accès réservé au process et mises à jour sérialisées. Entrée minimale : subscription_id UUID, secret_hash SHA256, expo_token, platform ios|android, timezone IANA validé par Intl, enabled, activated_local_date, created_at,last_seen_at,last_reserved_local_date?,last_sent_at?. Ajouter un secret aléatoire client 256 bits (base64url de 43 caractères) transmis uniquement via Authorization Bearer et conservé haché ; comparaison constante, jamais loggé.

Aucune route ne renvoie secret/hash/token. Les succès201/200 retournent uniquement `{subscription_id,enabled,timezone,activated_local_date}` ; DELETE204 sans corps. POST `/mobile/v1/push/subscriptions` : body strict `{subscription_id,expo_token,platform,timezone}`, bearer secret requis ;201 création,200 même abonnement/secret idempotent,409 conflit d'identité. PUT `/push/subscriptions/:id` : même bearer, body `{expo_token,platform,timezone,enabled}` ;200 met à jour last_seen_at, jeton et fuseau. DELETE même route/bearer :204 suppression idempotente, y compris déjà absent ; mauvais secret d'un abonnement existant401 unauthorized générique. PUT absent404 not_found. Ajouter ces codes au contrat mobile, limites8Kio et aucune valeur brute dans les erreurs. Token doit respecter le format Expo reconnu ; aucune adresse de destination arbitraire.

Un nouveau jeton pour la même installation remplace l'ancien. Un token déjà associé à une autre inscription valide désactive l'ancienne pour éviter les doublons sans révéler son identifiant/secret. Réactivation fixe activated_local_date à aujourd'hui : première éligibilité demain dans le fuseau connu. Les abonnements inactifs depuis 90 jours sont supprimés à la maintenance ; ceux invalidés par Expo seront désactivés. Corruption du registre : préserver fichier, push indisponible, lectures musicales intactes.

## Critères d'acceptation
- [ ] Création/réessai identique, changement de jeton/fuseau, désactivation/réactivation et suppression répondent exactement aux statuts définis.
- [ ] Secret faux/manquant ne permet ni lecture ni modification ; pas de token, secret, goûts ou identité de mesure dans logs/réponses publiques.
- [ ] Écriture atomique et relecture après redémarrage conservent les abonnements ; doublon de token n'entraîne pas deux abonnements actifs.
- [ ] IANA/token/body invalides rejetés ; expiration 90 jours et lendemain d'activation sont vérifiés avec horloge contrôlée.

## Tests attendus
Vitest sur fichiers temporaires réels et handlers HTTP : concurrence, corruption, droits, bearer valide/faux, replayPOST, double token, nouvelle timezone, transitions et limites. Mock uniquement Expo absent de ce ticket ; npm run check.

## Tier de risque
tier/3 — CI et review-gate requis verts ; ce gate exige l'attestation Sol/high profonde du SHA final en plus de la review ordinaire. Auto-merge après classification, sans accord humain.

## Notes d'implémentation
Aucun endpoint public de listing d'abonnements. Les secrets restent en mémoire le temps de la validation puis ne sont stockés qu'en hash. Cette autorisation technique n'est pas un compte utilisateur.
Contrat du ticket existant TRA-302 : reprendre le code et les tests déjà livrés, conserver son statut réel, sa PR et ses preuves ; cet amendement n'ordonne ni recréation ni réouverture d'une tâche terminée.

### Issue — Envoyer les rappels et traiter les retours Expo
- **Référence plan :** P3.6
- **Identifiant :** TRA-303
- **UUID conservé :** `678a22e1-2f02-4869-a741-d2c38038d1e2`
- **Tier :** tier/3
- **Dépendances :** Gérer les abonnements anonymes aux rappels (TRA-302, P3.5)
#### Description

## Contexte
Un rappel accepté par Expo ne prouve pas sa réception sur le téléphone. Ce ticket réalise l'envoi et le suivi technique sans répéter aveuglément un envoi au résultat ambigu.
Plan : docs/plans/track1-mobile.md, partie 3.

## Portée
Livrables à conserver/compléter ; créer uniquement les éléments encore absents : `src/mobile/push-sender.ts`, `src/mobile/push-receipts.ts`, `test/mobile/push-sender.test.ts`, `test/mobile/push-receipts.test.ts`. Compléter `src/mobile/push-store.ts`, `src/config.ts`, `src/env.ts` et `docs/track1-api.md` uniquement pour l'envoi. Utiliser fetch Node existant, sans nouvelle dépendance SDK ni modification des fournisseurs musicaux.

## Contrat
Secret optionnel de transport `EXPO_ACCESS_TOKEN` chargé côté serveur seulement ; absence si la sécurité renforcée du projet Expo l'exige = push indisponible explicite, jamais fuite vers app. POST HTTPS hôte fixe exp.host `/--/api/v2/push/send`, puis `/--/api/v2/push/getReceipts`. Payload exact : to token, title « track1 — Ta découverte du jour », body « Une découverte musicale t'attend. Ouvre track1 pour la découvrir. », sound default, channelId daily, data `{kind:'daily',notification_id:UUID,target_local_date:YYYY-MM-DD,url:'track1://today'}`. Aucun contenu de recommandation/goût.

sendReserved reçoit une réservation durable `{subscription_id,notification_id,target_local_date,reserved_at}` déjà créée ; ne jamais envoyer sans elle. Batches ≤ 100 messages, une requête en vol, timeout 15 s ; valider toute réponse fournisseur. Persister statut accepted avec ticket_id, rejected ou unknown. Réponse réseau ambiguë/timeout/5xx ne relance pas l'envoi pour cette date ; quota fournisseur affiche état opérationnel, sans bloquer lectures/app.

Retours accepted à consulter après 15 minutes ; requêtes receipts groupées ≤ 100, polling par tick du scheduler sans overlap ; jusqu'à 24 h de la réservation puis statut receipt_unknown terminal. État reçu ok signifie accepté par APNs/FCM, pas affiché ni lu. DeviceNotRegistered désactive immédiatement le token concerné uniquement s'il est toujours celui de l'envoi ; ne pas désactiver un token renouvelé entretemps. Tickets/retours sont conservés 24 h et bornés avec purge, sans jeton dans logs. Journal technique ne produit pas d'événement utilisateur analytics.

## Critères d'acceptation
- [ ] Le payload contient exclusivement le texte et les identifiants convenus, jamais les goûts ; hôte et auth serveur sont contrôlés.
- [ ] Batch/timeout/format erroné/quota/ambiguïté sont bornés ; aucune répétition automatique du même envoi.
- [ ] Receipt ok, erreur et absence après 24 h ont des états distincts ; un token invalide est désactivé sans toucher son remplaçant.
- [ ] État d'envoi et tickets survivent au redémarrage ; les logs permettent de distinguer tentative, acceptation et receipt sans secret.

## Tests attendus
Vitest avec vraies transitions de store et frontière HTTP Expo simulée : batches0/1/101, succès partiel, timeout après acceptation possible, JSON invalide,429, DeviceNotRegistered ancien/nouveau token,15 minutes/24 h et redémarrage. Pas de vrai envoi dans les tests unitaires.

## Tier de risque
tier/3 — CI et review-gate requis verts ; ce gate exige l'attestation Sol/high profonde du SHA final en plus de la review ordinaire. Auto-merge après classification, sans accord humain.

## Notes d'implémentation
La réservation et l'éligibilité sont livrées par P3.7. Le module reste injectable/inerte sans scheduler ; pas de garantie exactement-une-livraison des réseaux push.
Contrat du ticket existant TRA-303 : reprendre le code et les tests déjà livrés, conserver son statut réel, sa PR et ses preuves ; cet amendement n'ordonne ni recréation ni réouverture d'une tâche terminée.

### Issue — Déclencher les rappels à 9 h locale sur le serveur
- **Référence plan :** P3.7
- **Identifiant :** TRA-304
- **UUID conservé :** `b3b7d5db-0354-4354-a760-281201811189`
- **Tier :** tier/3
- **Dépendances :** Envoyer les rappels et traiter les retours Expo (TRA-303, P3.6)
#### Description

## Contexte
Le rappel doit partir à9h locale même quand l'application est fermée. Un redémarrage ou un retard serveur ne doit pas provoquer une rafale de rappels anciens.
Plan : docs/plans/track1-mobile.md, partie 3.

## Portée
Livrables à conserver/compléter ; créer uniquement les éléments encore absents : `src/mobile/push-schedule.ts`, `test/mobile/push-schedule.test.ts`. Raccorder le démarrage/arrêt dans `src/server.ts`, compléter `src/mobile/push-store.ts`, `deploy/deploy-server.sh` et `docs/track1-builds.md` pour l'exploitation. Aucune tâche OS parallèle, seconde instance, autre service musical ou modification du site.

## Contrat
Un scheduler dans le process serveur existant, tick toutes les 60 secondes, pas de ticks concurrents. Horloge injectable ; calcul date/heure avec timezone IANA stocké. Éligible si enabled, last_seen<90 jours, date locale strictement après activated_local_date, heure locale≥ 09:00 et< 10:00, date non déjà réservée. Réserver atomiquement date+notification_id AVANT appel à sendReserved ; conserver assez d'historique des dates réservées pour ne pas renvoyer une date revisitée lors d'un changement de fuseau (40 dates bornées). Pas de rappel rattrapé après 10 h, ni le jour de l'inscription. Reboot après réservation n'envoie pas à nouveau, même si envoi non confirmé.

Chaque tick récupère aussi les retours éligibles et purge abonnements inactifs/retours expirés. Traitements par lots bornés, céder la main entre lots ; erreurs push isolées des routes musicales. Arrêt serveur nettoie intervalle et termine les écritures atomiques en cours. Activation configurable `MOBILE_PUSH_ENABLED` false par défaut jusqu'à configuration Expo ; production true seulement avec credentials validés. Documenter secret serveur, activation, état technique, reprise après panne et désactivation de rollback ; le déploiement conserve MOBILE_STATE_DIR hors rsync.

## Critères d'acceptation
- [ ] À 08:59, 09:00, 09:59, 10:00, avec changement d'heure et fuseaux IANA, seuls les rappels éligibles partent.
- [ ] Deux ticks, concurrence, reboot avant/après réservation et retour à une date locale déjà visitée n'envoient pas deux fois cette date.
- [ ] Inscription du jour, token désactivé,90 jours d'inactivité et panne au-delà de 10 h n'entraînent pas de rappel indu.
- [ ] Désactivation/arrêt et erreur Expo ne cassent aucune route web/mobile ; tests du backend et persistance après déploiement passent.

## Tests attendus
Vitest horloge simulée et vrai store sur disque temporaire, transitions DST Europe/Paris et changement de fuseau, tick overlapping et récupération de receipts. Intégration démarrage/arrêt du serveur ; vérifier shell deploy et recette serveur documentée sans modifier l'horloge de production.

## Tier de risque
tier/3 — CI et review-gate requis verts ; ce gate exige l'attestation Sol/high profonde du SHA final en plus de la review ordinaire. Auto-merge après classification, sans accord humain.

## Notes d'implémentation
Mono-process assumé : documenter cette limite, ne pas introduire de verrou distribué ni nouvelle infrastructure. Garder les garde-fous du déploiement existant.
Contrat du ticket existant TRA-304 : reprendre le code et les tests déjà livrés, conserver son statut réel, sa PR et ses preuves ; cet amendement n'ordonne ni recréation ni réouverture d'une tâche terminée.

### Issue — Choisir les rappels et retrouver Aujourd'hui depuis une notification
- **Référence plan :** P3.8
- **Identifiant :** TRA-305
- **UUID conservé :** `baca2a4e-e627-45a7-8252-23270af3f0f9`
- **Tier :** tier/3
- **Dépendances :** Distribuer un build iOS de développement et conserver la compilation Android (TRA-290, P1.5) ; Proposer et retrouver sa découverte du jour (TRA-300, P3.3) ; Gérer les abonnements anonymes aux rappels (TRA-302, P3.5)
#### Description

## Contexte
La personne choisit librement les rappels après sa première découverte. Accepter doit inscrire ce téléphone ; refuser doit laisser Aujourd'hui et tous les parcours utilisables.
Plan : docs/plans/track1-mobile.md, partie 3.

## Portée
Livrables à conserver/compléter ; créer uniquement les éléments encore absents : `mobile/src/notifications/client.ts`, `mobile/src/notifications/store.ts`, `mobile/src/notifications/routing.ts`, `mobile/src/components/NotificationInvite.tsx`, `mobile/test/notifications.test.ts`, `mobile/test/notification-routing.test.tsx`. Modifier Aujourd'hui, Réglages, layout, `mobile/app.config.ts`, `mobile/src/api/client.ts` et ses contrats pour les trois routes push. Utiliser expo-notifications/device/constants/localization/secure-store/crypto déjà prévus. Aucun goût transmis, aucun rappel local de substitution.

## Contrat
Invitation non bloquante après première carte quotidienne ; pas de prompt OS à l'installation. Actions Activer/Plus tard, choix durable ; nouvelle demande seulement depuis geste explicite/réglages. Sur Android créer channel daily avant permission ; token Expo avec projectId réel, disponible sur appareil compatible/build natif. Générer et conserver subscription_idUUID + secret 256 bits SecureStore AVANT POST `/push/subscriptions` ; token/fuseau plateforme transmis avec bearer, jamais analytics. Les réponses201/200 validées sont `{subscription_id,enabled,timezone,activated_local_date}`, DELETE204 sans corps ;401 unauthorized arrête la mutation et affiche une reprise de l'inscription, aucun retry aveugle. Réutiliser même ID/secret sur réessai, ne pas créer une inscription orpheline. Au retour au premier plan, permission/fuseau/token vérifiés et PUT si nécessaire, last_seen actualisé au plus une fois par ouverture. Désactivation supprime l'abonnement ; si hors ligne conserver demande de suppression et secret pour réessai au retour, afficher « Désactivation en attente de connexion » et ne pas promettre arrêt immédiat. Secret perdu : ne pas prétendre modifier l'ancien abonnement, nouvelle inscription peut remplacer le même token.

Permission refusée : état clair et lien réglages système si non redemandable ; Today reste normal. `notification_permission_result` uniquement après demande utilisateur, status normalisé granted|denied|undetermined. Payload reçu validé `{kind:'daily',notification_idUUID,target_local_date,url:'track1://today'}` ; ouverture à froid ou au premier plan redirige Aujourd'hui pour la date COURANTE, pas celle du payload. Pas de navigation sur simple réception. Dédupliquer notification_opened par notification_id persisté (40 derniers), attribuer notification_id au parcours ; traverser sans perdre l'intention les choix de mesure/onboarding. Données invalides ignorées sans génération ni crash.

## Critères d'acceptation
- [ ] Invitation après première reco seulement ; refus/retrait/réactivation et permissions système sont testés sans dépendre du consentement analytics.
- [ ] Inscription/réessai/renouvellement utilisent le même secret protégé ; aucun token ou secret ne sort dans logs, événements ou AsyncStorage.
- [ ] Tap à froid/chaud/après arrière-plan sur iPhone ouvre la découverte courante une seule fois ; notification ancienne ou payload hostile n'ouvre pas une destination non autorisée.
- [ ] Hors ligne et refusOS restent des états utilisables ; suppression différée visible et rejouée, recommandations toujours accessibles.

## Tests attendus
Jest avec frontières SecureStore/Notifications/AppState/API simulées et vraie logique de reprise, token rotation, permission denied, timezone, secret loss, POST ack perdu, retrait hors ligne et double callback. Recette iPhone via le build P1.5 : réception réelle puis ouverture à chaud, à froid et après arrière-plan, avec intention conservée avant onboarding et événement unique. La preuve du parcours complet est consignée en P3.9. La recette physique Android est transférée à P8.1 et marquée différée — non exécutée ; les tests partagés Android restent conservés.

## Tier de risque
tier/3 — CI et review-gate requis verts ; ce gate exige l'attestation Sol/high profonde du SHA final en plus de la review ordinaire. Auto-merge après classification, sans accord humain.

## Notes d'implémentation
Conserver la baseline de tests push déjà livrée dans TRA-325 (PR #304) ; ne pas recréer ou rouvrir ce ticket complémentaire. Expo Go n'est pas une preuve de push en production. Accepter les notifications ne constitue jamais un consentement analytics. Aucune clé fournisseur dans config publique.
Contrat du ticket existant TRA-305 : reprendre le code et les tests déjà livrés, conserver son statut réel, sa PR et ses preuves ; cet amendement n'ordonne ni recréation ni réouverture d'une tâche terminée.

### Issue — Vérifier le parcours quotidien complet sur iPhone
- **Référence plan :** P3.9
- **Identifiant :** TRA-306
- **UUID conservé :** `a8c152b1-98fc-4b1b-8e4b-d563796c60f1`
- **Tier :** tier/1
- **Dépendances :** Déployer l'accès mobile sans régression du site (TRA-297, P2.7) ; Rejoindre Spotify ou Apple Music depuis une fiche (TRA-301, P3.4) ; Déclencher les rappels à 9 h locale sur le serveur (TRA-304, P3.7) ; Choisir les rappels et retrouver Aujourd'hui depuis une notification (TRA-305, P3.8) ; Relier Segment à Amplitude et vérifier les environnements iOS (TRA-315, P5.3)
#### Description

## Contexte
Les composants livrés doivent fonctionner ensemble sur un iPhone physique, y compris après refus des notifications. Cette recette vérifie le parcours quotidien et les événements avant d'élargir l'exploration.
Plan : docs/plans/track1-mobile.md, partie 3.

## Portée
Livrables à conserver/compléter ; créer uniquement les éléments encore absents : ou compléter `mobile/e2e/daily-discovery.yaml`, `docs/qa/track1-daily-journey.md` et les tests transverses nécessaires dans `mobile/test/daily-journey.test.tsx` ; créer ou compléter `docs/track1-release.md` comme registre des preuves. Parents mobile/, mobile/test/ et docs/ vérifiés ; docs/qa/ et mobile/e2e/ sont des créations prévues s'ils n'existent pas encore. Exécuter builds/signature P1.5, API P2.7, push serveur et chaîne Segment/Amplitude P5.3. Aucun changement de logique fonctionnelle, web ou compte de production pour forcer un succès.

## Contrat
Matrice avec iOS physique : réussi/échoué/non exécuté, et Android physique : différé — non exécuté, transféré à P8.1. Chaque résultat iOS porte versionOS, modèle, build/SHA, environnement, date et preuve expurgée. Parcours : choix de mesure accepté puis refusé sur autre installation, choix3genres, reco/raisons, fermeture/réouverture stable, notification réellement reçue puis ouverte à chaud, à froid et après arrière-plan→Aujourd'hui→fiche→relation→Spotify/Apple ; mêmes étapes par ouverture directe après refusOS. Vérifier lendemain/localtimezone par horloge injectée dans tests, et vrai envoi depuis environnement de test autorisé sur appareil ; aucun endpoint de test public ajouté pour accélérer le rappel. Recette exacte événement attendus et absence de données interdites, avec identifiants de recette anonymes et sources preview uniquement.

Inclure perte réseau, cache existant, fournisseur en erreur simulée à sa frontière en intégration, token invalide, application du service absente et payload ancien. Consigner chaque anomalie avec reproduction et ticket correctif ; recette ne vaut pas terminée tant qu'un blocage du parcours demeure.

## Critères d'acceptation
- [ ] Preuves de parcours complet sur iPhone physique et d'une notification serveur réellement reçue et ouverte à chaud/froid/après arrière-plan, plus parcours complet après refusOS ; chaque ancien critère Android est identifié dans la matrice comme transféré à P8.1 sans réussite supposée.
- [ ] Recommandation reste stable et aucun streaming intégré/secret/goût envoyé n'est observé.
- [ ] Événements attendus arrivent dans les deux outils preview avec attribution ; scénario non consenti n'envoie aucun événement.
- [ ] Rapport reproductible, versions et anomalies liés ; tous les blocages sont corrigés et la recette rejouée avant clôture.

## Tests attendus
Test transverse avec vrais stores/navigation/collecteur et frontières réseau/native contrôlées ; assertions du funnel et refus. Recette physique comme ci-dessus, `npm run check` et mobile check. Ne jamais déclarer un appareil ou un push validé sur simple simulation. Livrer le flow Maestro `mobile/e2e/daily-discovery.yaml`, exécutable avec `maestro test mobile/e2e/daily-discovery.yaml` et les variables APP_ID/identités de recette documentées. Sélecteurs accessibles stables, aucune attente arbitraire masquant un échec ; consigner séparément les étapes push réel/service externe nécessitant une action appareil. L'outil de recette n'est pas embarqué dans l'app et sa version d'exécution est consignée.

## Tier de risque
tier/1 — CI et review-gate verts, review IA selon le processus, auto-merge après classification du tier.

## Notes d'implémentation
La recette sera repassée sur l'interface finale en P6.5 ; une ancienne preuve reste datée et ne vaut pas preuve d'un nouveau build. Ticket de vérification transverse tier/1 : un correctif de backend/feature découvert reste une PR adaptée à son risque, pas cachée dans ce rapport.
Contrat du ticket existant TRA-306 : reprendre le code et les tests déjà livrés, conserver son statut réel, sa PR et ses preuves ; cet amendement n'ordonne ni recréation ni réouverture d'une tâche terminée.

## Milestone 4 — Explorer tout l'univers musical et créer les fiches manquantes
- **Identifiant Linear conservé :** `ea643ba7-394f-4bdb-9ffb-8fd1b0d3d998`.

### Description
- **Objectif produit :** permettre une exploration libre au-delà de la recommandation et ne pas arrêter la curiosité à une fiche absente.
- **Solution :** compléter chaque type de fiche, ouvrir la recherche globale et rendre la génération accessible depuis un résultat ou une relation. Conserver les contenus consultés et les destinations de navigation pour les interruptions ordinaires du mobile.
- **Logiques ajoutées ou modifiées :** affichage des particularités des artistes, albums, EP, singles, morceaux, genres et labels ; recherche par type ; états de génération ; liens profonds ; relecture hors connexion et reprise après erreur.
- **Résultat observable :** une personne trouve un sujet, ouvre ou génère sa fiche, suit ses relations et peut revenir sur des fiches déjà lues hors connexion, avec une explication claire des actions qui nécessitent le réseau.

### Issue — Compléter les fiches des artistes et de leurs œuvres
- **Référence plan :** P4.1
- **Identifiant :** TRA-307
- **UUID conservé :** `cdb892f3-5f2e-4e55-9277-e1a3cd3a852b`
- **Tier :** tier/2
- **Dépendances :** Lire une fiche et explorer ses relations (TRA-299, P3.2)
#### Description

## Contexte
La fiche commune doit montrer les différences utiles entre un artiste, un projet et un morceau, plutôt que réduire tous les contenus au même article. Les informations existent déjà et ne doivent pas être réinventées.
Plan : docs/plans/track1-mobile.md, partie 4.

## Portée
Livrables à conserver/compléter ; créer uniquement les éléments encore absents : `mobile/src/components/ArtistDetails.tsx`, `mobile/src/components/ProjectDetails.tsx`, `mobile/src/components/TrackDetails.tsx`, `mobile/test/work-details.test.tsx`. Raccorder `mobile/app/node/[slug].tsx` et NodeRelations livrés par P3.2. Références serveur existantes en lecture seule : `src/types.ts`, `src/graph.ts`, `src/node-spec.ts`. Aucun changement de schéma, enrichissement fournisseur ou redesign du site.

## Contrat
Présenter uniquement les facts/edges présents dans VizNode. Artist : origin/active_years et genres,labels,discography,notable_tracks,influences,influenced,collaborators,aliases,members. Project : year/release_type (album/ep/single traduits), puis bpm/musical_key/vocals/samples_notes/inspirations si présents ; artists,label,genres,tracklist,producers,personnel,related_projects. Track : year/duration et mêmes caractéristiques musicales présentes ; artists,project,label,genres,producers,personnel,samples,sampled_by,remix_of,remixed_by. Réutiliser le renderer natif pour faits textuels, NodeRelations pour objets simples/listes. Les sections vides sont omises, aucun zéro/date/artist inventé. Ordre des pistes/relations conservé quand fourni par le cache ; aucune promesse de numéro de piste si absent. En-tête indique clairement album, EP ou single pour les projets renseignés ; sinon Projet.

## Critères d'acceptation
- [ ] Fixtures artist/project/track affichent tous les faits et relations supportés, sans double section avec la fiche commune.
- [ ] Album, EP et single se distinguent sans traiter EP/single comme des types serveur nouveaux.
- [ ] Données partielles, relation simple, listes vides et champs absents ne produisent ni faux faits ni crash.
- [ ] Navigation, retour, écoute externe et événements node_viewed/relation_opened restent conformes, sans nouvel événement.

## Tests attendus
Rendu table-driven des trois types, projet album/ep/single/unknown, morceaux sans projet, relations simples/listes et faits longs ; tests d'interaction vers artistes/œuvres et régression de la fiche commune. Mobile check.

## Tier de risque
tier/2 — CI et review-gate verts, review IA selon le processus, auto-merge après classification du tier.

## Notes d'implémentation
Les noms de champs sont ceux du cache vérifiés ; la projection VizNode peut en omettre certains, ne jamais modifier graph.ts pour combler une absence dans ce ticket. Ne pas réintroduire une visualisation de graphe.
Contrat du ticket existant TRA-307 : reprendre le code et les tests déjà livrés, conserver son statut réel, sa PR et ses preuves ; cet amendement n'ordonne ni recréation ni réouverture d'une tâche terminée.

### Issue — Explorer les particularités des genres et labels
- **Référence plan :** P4.2
- **Identifiant :** TRA-308
- **UUID conservé :** `031a28c7-2916-4f92-b9f7-14b3d0b652f2`
- **Tier :** tier/2
- **Dépendances :** Lire une fiche et explorer ses relations (TRA-299, P3.2)
#### Description

## Contexte
Genres et labels sont des portes d'exploration, pas des œuvres à écouter directement. Leurs fiches doivent montrer leurs repères et liens spécifiques.
Plan : docs/plans/track1-mobile.md, partie 4.

## Portée
Livrables à conserver/compléter ; créer uniquement les éléments encore absents : `mobile/src/components/GenreDetails.tsx`, `mobile/src/components/LabelDetails.tsx`, `mobile/test/genre-label-details.test.tsx` ; raccorder la fiche et ses relations. Lire `src/types.ts`, `src/graph.ts`, `src/node-spec.ts` existants. Aucun schéma, génération, nouvelle taxonomie ou bouton d'écoute pour ces deux types.

## Contrat
Genre : facts era/origin/sonic_markers si exposés ; parent_genres,subgenres,related_genres,key_artists,key_labels,landmark_projects,landmark_tracks. Label : facts founded/location/founders/active_years ; genres,roster,notable_releases. Traduire les sections en français, conserver les EdgeRef canoniques et leur ordre, omettre les absences. Relations ouvrent les mêmes fiches/retours que P3.2 ; ne pas déduire une relation inverse absente ni traiter un cycle comme une erreur. Les particularités de dégradation taxonomique serveur restent invisibles sous forme d'erreurs techniques : le mobile montre le catalogue valide reçu.

## Critères d'acceptation
- [ ] Genre et label affichent leurs repères/rosters et naviguent vers les cinq types ; pas de boutons d'écoute trompeurs.
- [ ] Relations cycliques et tableaux vides sont sûrs ; champs absents ne sont pas remplis par des suppositions.
- [ ] Les mêmes conventions de sources, images, accessibilité, événements et retour que la fiche commune sont préservées.

## Tests attendus
Fixtures genre complet/partiel, label complet/partiel, parent/subgenre cyclique et relation absente ; tests d'interaction et de non-affichage de l'écoute. Mobile check.

## Tier de risque
tier/2 — CI et review-gate verts, review IA selon le processus, auto-merge après classification du tier.

## Notes d'implémentation
Ce ticket et P4.1 sont parallélisables dans leurs composants ; séquencer leur raccordement partagé à node/[slug].tsx.
Contrat du ticket existant TRA-308 : reprendre le code et les tests déjà livrés, conserver son statut réel, sa PR et ses preuves ; cet amendement n'ordonne ni recréation ni réouverture d'une tâche terminée.

### Issue — Rechercher dans tous les types de contenus
- **Référence plan :** P4.3
- **Identifiant :** TRA-309
- **UUID conservé :** `e39245b6-af02-41e3-8418-1ce56f6b7607`
- **Tier :** tier/2
- **Dépendances :** Exposer la recherche globale au mobile (TRA-293, P2.3) ; Donner au mobile un client réseau validé et résilient (TRA-296, P2.6) ; Mesurer les parcours uniquement selon le choix de la personne (TRA-314, P5.2)
#### Description

## Contexte
La recherche permet de quitter la recommandation et trouver un sujet précis dans les cinq familles de contenus. Un résultat externe encore absent doit être clairement distingué d'une fiche disponible.
Plan : docs/plans/track1-mobile.md, partie 4.

## Portée
Livrables à conserver/compléter ; créer uniquement les éléments encore absents : `mobile/src/search/model.ts`, `mobile/src/components/SearchResults.tsx`, `mobile/test/search.test.tsx` ; modifier `mobile/app/(tabs)/search.tsx`. Consommer méthode search du client API et analytics livrés. Aucun POST de génération, catalogue externe pour genres/labels ou nouvelle dépendance.

## Contrat
Champ q trim 2–120 caractères ; filtre all|artist|project|track|genre|label, limit 25. Recherche 300 ms après dernière saisie admissible, annuler l'ancienne requête et ignorer ses retours périmés. Sous 2 caractères : état d'aide sans requête ; champ vide : pas de faux résultat vide. États chargement/résultats/zéro/erreur distincts. Réponse `{q,hits,sources}` : cache avec slug ouvre `/node/[slug]` ; catalog sans fiche affiche « Fiche à créer » et conserve type/name/mbid/extra/subtitle fournis comme identité, sans inventer slug. Action vers l'état de contenu absent ; génération explicite branchée par P4.4.

search_submitted au déclenchement réel de la recherche avec filter seul ; search_result_opened par appui avec node_type,node_id si connu,availability cached|missing,results_count. Jamais q,subtitle ou erreur brute dans analytics. Le nouveau départ depuis Recherche réinitialise l'attribution d'un ancien parcours, sauf navigation interne explicitement issue de ce même parcours.

## Critères d'acceptation
- [ ] Les cinq filtres et all donnent des résultats typés ; cache/externe se distinguent visuellement et ne génèrent rien automatiquement.
- [ ] Debounce, annulation, saisie trop courte/longue et réponses hors ordre ne montrent aucun résultat périmé.
- [ ] Zéro résultat, panne et recherche active ont des états distincts avec nouvelle tentative ; clavier et labels sont accessibles.
- [ ] Événements exacts et sans texte de recherche ; un résultat cache ouvre la fiche canonique et son retour retrouve recherche/filtre.

## Tests attendus
Jest faux timers pour 300 ms et requêtes concurrentes, vraies fonctions de validation/mapping avec réponses cache/catalog des cinq types, erreurs 503 et annulation ; tests de navigation/événements consentis/refusés. Mobile check.

## Tier de risque
tier/2 — CI et review-gate verts, review IA selon le processus, auto-merge après classification du tier.

## Notes d'implémentation
Pas de pagination inventée au-delà du contrat limit 25. Le mode recherche locale hors connexion arrive en P4.6.
Contrat du ticket existant TRA-309 : reprendre le code et les tests déjà livrés, conserver son statut réel, sa PR et ses preuves ; cet amendement n'ordonne ni recréation ni réouverture d'une tâche terminée.

### Issue — Créer une fiche absente et suivre son résultat
- **Référence plan :** P4.4
- **Identifiant :** TRA-310
- **UUID conservé :** `0a6fd1fb-0e5b-4a3f-9b6e-8b9cf58ef6c2`
- **Tier :** tier/2
- **Dépendances :** Déclencher et suivre une génération publique de bout en bout côté serveur (TRA-295, P2.5) ; Lire une fiche et explorer ses relations (TRA-299, P3.2) ; Rechercher dans tous les types de contenus (TRA-309, P4.3)
#### Description

## Contexte
Une personne doit pouvoir faire créer une fiche absente et retrouver sa demande après interruption réseau. La génération est publique et explicite ; le contrôle des coûts reste celui des clés fournisseurs limitées.
Plan : docs/plans/track1-mobile.md, partie 4.

## Portée
Livrables à conserver/compléter ; créer uniquement les éléments encore absents : `mobile/src/generation/store.ts`, `mobile/src/generation/request.ts`, `mobile/src/generation/status.tsx`, `mobile/test/generation.test.tsx`. Raccorder l'état absent de `mobile/app/node/[slug].tsx`, SearchResults et NodeRelations. Consommer POST/GET générations et analytics existants ; aucune limitation par compte, paiement ou retry payant automatique.

## Contrat
Une identité vient d'un résultat/EdgeRef fiable : type,name,slug?,mbid?,qid?,disambiguator? ; seules ces propriétés autorisées vont au serveur, sans extra brut. Action « Créer cette fiche » immédiatement disponible sur contenu absent ; si un deeplink n'apporte qu'un slug sans name, proposer Recherche préremplie à partir du corps lisible, puis sélection de résultat identifié, sans inventer nom canonique/MBID. Avant POST, écrire dans AsyncStorage version 1 `track1.generations.v1` `{request_id:UUID,input,created_at,status,event_flags}` ; une demande active par identité, double appui réutilise le même ID. POST 202 puis GET toutes les 2 secondes seulement au premier plan, requête précédente finie ; arrêter au terminal, hors ligne/arrière-plan/démontage. Reprendre mêmes ID au retour/redémarrage, jamais un nouveau POST automatique.

queued/running affichent attente ; succeeded ouvre node_id canonique, invalide/rafraîchit le catalogue, puis retire la demande active. failed/interrupted/410 expiré affichent erreur publique et bouton de nouvelle action explicite ; cette action vérifie d'abord getNode si slug connu, sinon serveur vérifiera son cache. Après timeout POST avant accusé, afficher statut à confirmer, tenter GET du même ID ;410 dans ce cas reste résultat inconnu, autoriser explicitement réessayer le même POST/ID, pas relancer à l'aveugle. busy 429 garde la saisie et Retry-After: 30, réessai explicite ; quota épuisé explique indisponibilité de création et accès aux contenus existants. Ne pas présenter une perte réseau comme échec terminal.

Événements : generation_requested une fois après persistance avant POST, completed ou failed uniquement à observation terminale avec codes contrôlés ; flags durables pour déduplication/reprise, sans rattrapage après accord tardif. Supprimer les enregistrements terminaux locaux après 24 h et borner à 1 000, sans évincer les actifs.

## Critères d'acceptation
- [ ] Création explicitement déclenchable depuis résultat et relation absents ; lecture/recherche/navigation seules ne génèrent jamais.
- [ ] Double appui, timeout POST, fermeture et retour reprennent le même identifiant sans second appel payant automatique.
- [ ] Succès canonique rafraîchit catalogue/fiche ; quota, busy, panne, interruption et expiration donnent des sorties compréhensibles sans bloquer lecture.
- [ ] Polling seulement au premier plan, annulable et borné ; événements terminal/requête sont dédupliqués après redémarrage et sans données interdites.

## Tests attendus
Tests contrôleur avec vrais store/validateurs API et frontières HTTP/horloge : succès immédiat/cache, queued→running→succeeded, double geste, accusé perdu,410 ambigu,429,quota,terminal failed,background/relaunch, stockage échoué et analytics refusé. Rendu de tous les états et navigation canonique ; mobile check.

## Tier de risque
tier/2 — CI et review-gate verts, review IA selon le processus, auto-merge après classification du tier.

## Notes d'implémentation
Ne pas ajouter fresh, décompte de crédits supposé ou plafond arbitraire d'utilisations. Le serveur est autorité du résultat ; les flags analytics n'envoient jamais des actions survenues sans accord.
Contrat du ticket existant TRA-310 : reprendre le code et les tests déjà livrés, conserver son statut réel, sa PR et ses preuves ; cet amendement n'ordonne ni recréation ni réouverture d'une tâche terminée.

### Issue — Ouvrir directement une fiche depuis un lien track1
- **Référence plan :** P4.5
- **Identifiant :** TRA-311
- **UUID conservé :** `9824355e-287d-4074-8629-5ba373509221`
- **Tier :** tier/2
- **Dépendances :** Lire une fiche et explorer ses relations (TRA-299, P3.2) ; Choisir les rappels et retrouver Aujourd'hui depuis une notification (TRA-305, P3.8)
#### Description

## Contexte
Un lien track1 doit retrouver directement Aujourd'hui ou une fiche, y compris avant la fin du premier lancement. Les liens inconnus ne doivent pas déclencher d'action coûteuse.
Plan : docs/plans/track1-mobile.md, partie 4.

## Portée
Livrables à conserver/compléter ; créer uniquement les éléments encore absents : `mobile/src/navigation/deep-links.ts`, `mobile/test/deep-links.test.tsx`. Raccorder `mobile/app/_layout.tsx`, `mobile/src/notifications/routing.ts` et configuration scheme livrée. Aucun Universal Link/App Link HTTPS, association de domaine, page web ou génération implicite.

## Contrat
Accepter uniquement `track1://today` sans chemin additionnel et `track1://node/<slug encodé>` avec un seul segment décodé une seule fois, slug serveur valide ≤ 200 caractères. Rejeter schéma/hôte inconnu, userinfo/port, query/fragment inattendu, encodage invalide, traversée/slash encodé et type inconnu. Une entrée invalide donne message non bloquant et Aujourd'hui, aucun fetch ni appel payant. Stocker une seule intention en mémoire, la plus récente, jusqu'à readiness navigation/choix analytics/onboarding ; un refus analytics ou accès Recherche sans profil ne doit pas la perdre.

Ouverture à froid/chaud même destination, une seule navigation par même événement OS (dédoublonner initialURL/listener), mais deux gestes ultérieurs restent permis. Node alias suit id canonique ; absent conserve état et action explicite P4.4, aucune création silencieuse. source deeplink dans node_viewed ; notification utilise source notification et son contexte, sans émettre notification_opened pour un lien ordinaire.

## Critères d'acceptation
- [ ] Deux liens valides ouvrent leur cible à froid/chaud sur iPhone, avant/après onboarding et refus analytics ; retour natif correct et tests de navigation partagés conservés.
- [ ] Malformed/traversée/hôtes inconnus ne causent ni fetch dangereux, crash, collecte brute d'URL ou génération.
- [ ] Alias/absent ont les états déjà définis ; double callback OS ne double pas navigation/événement, nouveau geste reconnu.

## Tests attendus
Tests table de parsing hostile/Unicode/encodage et intégration intention→onboarding→route avec vrais layouts ; initialURL+listener, notification versus lien, retour Android. Recette native iPhone des deux destinations track1://today et track1://node/<slug> en P4.7, puis sur l'interface finale en P6.5 ; mobile check. Le retour Android simulé reste couvert, sa preuve physique et les ouvertures Android sont transférées à P8.1, marquées différées — non exécutées.

## Tier de risque
tier/2 — CI et review-gate verts, review IA selon le processus, auto-merge après classification du tier.

## Notes d'implémentation
Le domaine HTTPS n'est pas requis dans cette V1. Ne pas envoyer l'URL brute aux analytics.
Contrat du ticket existant TRA-311 : reprendre le code et les tests déjà livrés, conserver son statut réel, sa PR et ses preuves ; cet amendement n'ordonne ni recréation ni réouverture d'une tâche terminée.

### Issue — Continuer à consulter et reprendre les parcours malgré les pannes
- **Référence plan :** P4.6
- **Identifiant :** TRA-312
- **UUID conservé :** `25f4639a-f063-4008-b55c-480c3d576970`
- **Tier :** tier/2
- **Dépendances :** Lire une fiche et explorer ses relations (TRA-299, P3.2) ; Proposer et retrouver sa découverte du jour (TRA-300, P3.3) ; Rechercher dans tous les types de contenus (TRA-309, P4.3) ; Créer une fiche absente et suivre son résultat (TRA-310, P4.4)
#### Description

## Contexte
La consultation doit continuer quand le réseau disparaît, sans présenter des données locales comme fraîchement téléchargées. Le cache reste borné et ne déclenche aucune génération.
Plan : docs/plans/track1-mobile.md, partie 4.

## Portée
Livrables à conserver/compléter ; créer uniquement les éléments encore absents : `mobile/src/cache/catalog.ts`, `mobile/src/cache/nodes.ts`, `mobile/src/components/RequestState.tsx`, `mobile/test/offline-cache.test.ts`, `mobile/test/offline-journey.test.tsx`. Intégrer dans accès API au catalogue, fiche, Aujourd'hui, recherche et génération existants. Utiliser AsyncStorage et cycle AppState ; aucun service worker, téléchargement audio, nouvelle dépendance réseau ou modification des durées validées.

## Contrat
Caches versionnés séparés du profil/analytics/push ; catalogue validé avec revision/ETag/fetched_at, refresh au premier plan si âge ≥ 6 h et après génération réussie,304 actualise fraîcheur. Fiches `{node,fetched_at,last_accessed_at}` limitées à 50 identités canoniques au total par LRU, celle du jour protégée ; elle occupe une place, pas une 51e. Si fiche présente, afficher immédiatement puis revalider en ligne si âge ≥ 24 h sans retirer la fiche ; nouveau contenu remplace après validation. Alias pointent vers la même entrée. Données invalides ignorées avec état de reprise, écriture échouée ne fait pas disparaître l'écran déjà chargé.

Hors réseau/échec réseau, afficher version locale et date de consultation, image en cache Expo ou placeholder ; Recherche locale filtrée depuis catalogue name et teaser (comparaison insensible casse/accents), limit 25, badge « Résultats enregistrés — recherche externe indisponible ». Aucun catalogue initial : reprise de connexion claire. Génération désactivée hors ligne avec explication, demandes déjà créées conservent leur ID et reprennent seulement GET au retour. Une panne 503 serveur ne doit pas être décrite comme absence de contenu. Revalidation GET n'appelle jamais le modèle. Effacement profil garde les choix mesure/push et remet goût/historique à zéro ; pas de copies du profil dans les caches ; préserver aussi les contrôles de purge liés à la confidentialité déjà livrés dans TRA-326, sans restaurer un cache qu'ils doivent supprimer. RequestState présente explicitement loading/empty/not_found/offline/unavailable et l'action de reprise adaptée, sans confondre absence de fiche, erreur réseau et création indisponible ; l'image absente reste un placeholder distinct.

## Critères d'acceptation
- [ ] Catalogue 6 h/304 et fiches 24 h respectent les seuils exacts ; affichage stale conservé pendant panne/revalidation.
- [ ] 51e fiche évince la moins récente non protégée ; alias ne double pas, fiche du jour reste parmi 50 ; corruption n'empêche pas la reprise.
- [ ] Hors ligne, fiches/reco et recherche locale fonctionnent ; création et recherche externe sont explicitement suspendues, jamais simulées réussies.
- [ ] Reconnexion/génération réussie actualisent le catalogue sans changer la sélection du jour ou relancer un travail payant.

## Tests attendus
Tests vrais stores avec horloge : âge juste avant/au seuil,304,50/51 LRU/pin,alias,JSON corrompu,écritures échouées ; intégration online→offline→restart→online des écrans et suivi ID ; assertions zéro POST implicite et zéro appel au modèle. Mobile check.

## Tier de risque
tier/2 — CI et review-gate verts, review IA selon le processus, auto-merge après classification du tier.

## Notes d'implémentation
TRA-312 est confirmé livré dans les artefacts du plan : conserver code, tests, statut et preuves lors de la transcription. La purge de confidentialité TRA-326 (PR #305) est également livrée et reste couverte ; aucun nouveau travail ni réouverture de ces tickets du seul fait de ce manifeste. Ne pas déduire hors ligne d'un simple résultat vide. Sans bibliothèque de connectivité supplémentaire, les échecs réseau et les reprises explicites/AppState suffisent ; conserver des messages prudents quand la cause est inconnue.

### Issue — Vérifier l'exploration et l'accessibilité sur iPhone
- **Référence plan :** P4.7
- **Identifiant :** TRA-313
- **UUID conservé :** `fcd6e036-ba26-4426-8cab-40db32066fff`
- **Tier :** tier/1
- **Dépendances :** Compléter les fiches des artistes et de leurs œuvres (TRA-307, P4.1) ; Explorer les particularités des genres et labels (TRA-308, P4.2) ; Créer une fiche absente et suivre son résultat (TRA-310, P4.4) ; Ouvrir directement une fiche depuis un lien track1 (TRA-311, P4.5) ; Continuer à consulter et reprendre les parcours malgré les pannes (TRA-312, P4.6)
#### Description

## Contexte
Les cinq types, la recherche, la création et le hors ligne forment un seul usage d'exploration. Cette recette transverse vérifie aussi qu'il reste utilisable avec les aides d'accessibilité natives.
Plan : docs/plans/track1-mobile.md, partie 4.

## Portée
Livrables à conserver/compléter ; créer uniquement les éléments encore absents : ou compléter `mobile/e2e/exploration.yaml`, `docs/qa/track1-exploration.md`, `mobile/test/exploration-journey.test.tsx` et `docs/track1-release.md`. Parents mobile/, mobile/test/ et docs/ vérifiés ; sous-dossiers de recette à créer si absents. Exécuter les fonctionnalités P4.1–P4.6 sur iPhone et API validée. Aucun redesign, correction fonctionnelle cachée, schéma ou cache généré édité à la main.

## Contrat
Matrice cinq types comprenant projets album/EP/single, source cache/externe, relation vers absent, génération réussie/interrompue/quota, deeplink today/node à froid/chaud, alias, cache vide/préchargé puis hors ligne/reconnexion. Vérifier safe areas, grand texte, VoiceOver, labels/boutons/rôle et retour iOS ; pas d'impasse clavier/focus sur recherche. Résultat par scénario iOS avec appareil/version/build/SHA/date et preuve expurgée ; matrice Android explicitement « différé — non exécuté, repris dans P8.1 » pour les parcours, le retour système et TalkBack ; pannes simulées dans les tests aux frontières, pas en épuisant crédits réels. Une génération réelle limitée peut servir de preuve avec clés autorisées, conserver ID, pas les secrets.

## Critères d'acceptation
- [ ] Chaque famille/variante et tous les parcours validés ont une preuve ou test reproductible sur iPhone ; les anciens critères Android sont tracés vers P8.1, sans être déclarés satisfaits.
- [ ] Accessibilité native permet navigation/recherche/actions sans élément invisible ou bloquant, texte agrandi sans perte d'action.
- [ ] Hors ligne/quota/interruptions ne bloquent pas la lecture et ne provoquent aucune création automatique ; deeplinks hostiles rejetés.
- [ ] Anomalies bloquantes corrigées via tickets appropriés puis recette rejouée ; rapport indique chaque version réelle, aucun résultat fabriqué.

## Tests attendus
Test transverse vrais composants/stores/navigation avec API simulée uniquement à la frontière ; recette physique iPhone/VoiceOver, grandes polices, réseau coupé et schemes. Mobile check et npm run check avant rapport final. Flow Maestro exécutable `maestro test mobile/e2e/exploration.yaml`, même configuration documentée que daily-discovery, sélecteurs accessibles et résultats explicites ; VoiceOver et gestes non automatisables consignés comme recette appareil séparée, jamais déclarés couverts par un test qui ne les exerce pas.

## Tier de risque
tier/1 — CI et review-gate verts, review IA selon le processus, auto-merge après classification du tier.

## Notes d'implémentation
Cette recette fonctionnelle sera rejouée sur l'interface finale en P6.5. Tier/1 car recette/documentation/tests uniquement. Les corrections de produit restent dans leurs tickets et tiers adaptés ; conserver les critères non atteints comme anomalies, pas les assouplir.
Contrat du ticket existant TRA-313 : reprendre le code et les tests déjà livrés, conserver son statut réel, sa PR et ses preuves ; cet amendement n'ordonne ni recréation ni réouverture d'une tâche terminée.

## Milestone 5 — Comprendre ce qui donne envie de découvrir et de revenir
- **Identifiant Linear conservé :** `c542e799-f7f2-4711-a1ed-3b69075460cb`.

### Description
- **Objectif produit :** savoir si la recommandation conduit à une découverte, à l'ouverture d'un service d'écoute et au retour dans track1.
- **Solution :** conserver les événements définis avant les parcours, les envoyer par Segment vers Amplitude, puis vérifier les analyses de lancement sur iOS. La personne choisit séparément si elle accepte la mesure d'usage ; la vérification Android aura sa propre preuve à la reprise.
- **Logiques ajoutées ou modifiées :** définition des déclencheurs et propriétés, identité anonyme, choix de mesure et retrait, attribution des ouvertures de rappel, distinction des environnements et prévention des doublons.
- **Résultat observable :** l'équipe suit l'activation, la consultation des recommandations, les ouvertures de services d'écoute et les retours ; elle connaît la population mesurée et ne confond pas clic d'écoute, notification acceptée par un fournisseur et écoute ou réception effective.

### Issue — Définir les événements et les indicateurs track1
- **Référence plan :** P5.1
- **Identifiant :** TRA-286
- **UUID conservé :** `a8f1f2bc-2ae0-4510-94aa-398a5374031d`
- **Tier :** tier/1
- **Dépendances :** aucune
#### Description

## Contexte
track1 doit mesurer dès ses premiers parcours si une découverte mène à une fiche, à l'ouverture d'un service d'écoute et à un retour dans l'app. Le contrat doit précéder l'instrumentation pour que chaque ticket livre ses événements et leurs tests. Cette tâche écrit une définition définitive, sans installer de SDK ni configurer les comptes.
Plan : docs/plans/track1-mobile.md, partie 5.

## Portée
Livrables à conserver/compléter ; créer uniquement les éléments encore absents : `docs/track1-tracking-plan.md` dans `docs/` (parent vérifié). Références existantes en lecture seule : `docs/plans/track1-mobile.md` et `web/index.html` pour le vocabulaire des parcours. Aucun code, événement réel, configuration Segment/Amplitude ni modification du site.

## Contrat
Contrat v1, noms d'événements en snake_case. Enveloppe commune : `event_id` UUID stable pour la tentative logique, `schema_version:1`, `platform:ios|android`, `app_version`, `build_number`, `environment:development|preview|production`, `source:app|onboarding|settings|home|search|relation|notification|deeplink`, date d'occurrence ISO UTC. `anonymousId` est aléatoire, propre à la mesure et persistant après accord ; `userId` absent. `event_id` devient `messageId` Segment puis `insert_id` Amplitude ; propriétés musicales publiques seulement. Les listes de goûts, textes de recherche, email, ID publicitaire, token push, secret d'abonnement et erreurs brutes sont interdits.

Le document reprend exactement ce catalogue et associe à chaque ligne un exemple valide, un exemple rejeté, un test et le ticket propriétaire :

| Événement | Déclencheur / propriétés spécifiques / propriétaire |
| --- | --- |
| `app_opened` | Premier affichage puis vraie transition background→active ; source d'entrée ; P5.2. Pas à chaque rerender. |
| `onboarding_started` | Première grille musicale visible pour un flux, `flow_id` UUID ; P3.1. |
| `onboarding_completed` | Genres validés et écrits, `flow_id`, `genres_count` entier ; une fois par flux ; P3.1. |
| `preferences_updated` | Modification ou effacement validé, `genres_count`, `action:updated\|cleared` ; P3.1. |
| `daily_recommendation_viewed` | Carte réellement affichée, `recommendation_id`, `local_date` YYYY-MM-DD, `node_id`, `node_type` ; une fois par sélection quotidienne persistée ; P3.3. |
| `daily_recommendation_opened` | Appui Découvrir, mêmes identifiants ; une fois par geste ; P3.3. |
| `notification_permission_result` | Résultat d'une demande utilisateur, `status:granted\|denied\|undetermined`, sans token ; P3.8. |
| `notification_opened` | Action d'ouverture, `notification_id`, `target_local_date` ; une fois par notification, pas à la réception ; P3.8. |
| `node_viewed` | Fiche chargée visible, `node_id`, `node_type`, source ; une fois par entrée de navigation ; P3.2. |
| `relation_opened` | Appui relation, `from_node_id`, `node_id`, `node_type`, `relation_kind` ; P3.2. |
| `search_submitted` | Recherche admissible effectivement déclenchée, `filter:all\|artist\|project\|track\|genre\|label` ; une fois par recherche temporisée appliquée, aucun texte ; P4.3. |
| `search_result_opened` | Résultat sélectionné, `node_type`, `node_id` si connu, `availability:cached\|missing`, `results_count` ; P4.3. |
| `generation_requested` | Action explicite et request_id durable avant POST, `request_id`, `node_type` ; une fois par demande logique ; P4.4. |
| `generation_completed` | État réussi observé, `request_id`, `node_id`, `node_type` ; une fois par demande, y compris après reprise ; P4.4. |
| `generation_failed` | État échoué/interrompu/expiré observé, `request_id`, `node_type`, `error_code` contrôlé ; une fois par demande terminale ; P4.4. Une déconnexion de suivi seule n'est pas un échec terminal. |
| `external_listening_opened` | Ouverture OS résolue, `node_id`, `node_type`, `provider:spotify\|apple_music`, `link_kind:exact\|search` ; P3.4. Ce n'est pas une lecture audio confirmée. |
| `external_listening_failed` | Ouverture refusée/échouée, mêmes propriétés et `error_code:unsafe_url\|open_failed` ; P3.4. |

Attribution : conserver `recommendation_id` et `notification_id` dans le contexte du parcours issu de la carte/push, les propager aux fiches, relations et écoute jusqu'au prochain départ indépendant depuis un onglet ; aucun secret. Les appels après rerender et double callback ne dupliquent pas le même événement logique. Aucun événement ni file d'attente avant accord ; refus et retrait n'entravent aucun parcours. Accord tardif sans rattrapage historique. Source interne séparée de production.

Indicateurs : (1) flux distincts completed / started parmi consentants ; (2) sélections distinctes ouvertes / viewed ; (3) sélections viewed ayant un `external_listening_opened` attribué / viewed, pas un taux d'écoute audio ; (4) cohortes d'anonymousId dont le premier `app_opened` mesuré est le jour D en UTC, retour via `app_opened` exactement D+1/D+7, exclure cohortes non encore observables ; (5) chemin depuis notification_opened vers fiche et écoute ; (6) request_id distincts completed/failed rapportés aux demandes mesurées, états encore en cours distincts. Vues de lancement filtrées iOS et production, données internes exclues ; conserver la dimension Android pour des vues propres après recette de reprise P8.1. Aucun objectif chiffré inventé, taux push ouvert/reçu ni durée de session.

## Critères d'acceptation
- [ ] Le document comporte exactement les 17 événements ci-dessus, les propriétés typées/obligatoires/facultatives, les déclencheurs, la déduplication, le propriétaire et les cas de recette.
- [ ] Chaque indicateur dispose d'un numérateur, dénominateur, période, population et exclusions ; clic d'écoute et réception push ne sont pas surinterprétés.
- [ ] Refus/retrait, accord tardif, redémarrage, navigation répétée, double callback de notification et reprise de génération disposent de cas attendus précis.
- [ ] Aucune donnée interdite, estimation ou nouveau KPI hors catalogue n'est introduit ; les noms sont directement utilisables par les tickets de features.

## Tests attendus
Vérification documentaire reproductible : compter 17 noms uniques ; contrôler chaque propriété contre la liste commune et interdite ; rejouer sur papier un flux nominal (started=1, completed=1, viewed=1, opened=1, external_opened=1), une annulation, un double callback et un refus (0 événement). Décrire ces jeux de recette exacts dans le document pour les tests P5.2 et P5.4 ; aucun test réseau ou compte requis ici.

## Tier de risque
tier/1 — CI et review-gate verts, review IA selon le processus, auto-merge après classification du tier.

## Notes d'implémentation
Tier documentaire inchangé. Le choix analytics est présenté avant les goûts et stocké séparément ; le profil musical reste local. Segment est l'unique SDK de collecte ; Amplitude Actions reçoit les événements en cloud mode. Ne pas créer de propriété utilisateur à partir des goûts. Les plateformes et services ont déjà été choisis dans le plan validé, ne pas les remettre en débat.
Contrat du ticket existant TRA-286 : reprendre le code et les tests déjà livrés, conserver son statut réel, sa PR et ses preuves ; cet amendement n'ordonne ni recréation ni réouverture d'une tâche terminée.

### Issue — Mesurer les parcours uniquement selon le choix de la personne
- **Référence plan :** P5.2
- **Identifiant :** TRA-314
- **UUID conservé :** `b1ab18b9-f896-4ff2-b656-772d181ac9ea`
- **Tier :** tier/3
- **Dépendances :** Ouvrir les trois entrées de navigation (TRA-288, P1.3) ; Définir les événements et les indicateurs track1 (TRA-286, P5.1)
#### Description

## Contexte
La mesure doit être disponible dès les premières fonctionnalités sans collecter avant le choix de la personne. Un seul collecteur validé protège les données et garantit le même contrat dans tous les écrans.
Plan : docs/plans/track1-mobile.md, partie 5.

## Portée
Livrables à conserver/compléter ; créer uniquement les éléments encore absents : `mobile/src/analytics/contracts.ts`, `mobile/src/analytics/consent.ts`, `mobile/src/analytics/client.ts`, `mobile/src/analytics/provider.tsx`, `mobile/app/privacy-choice.tsx`, `mobile/test/analytics.test.ts`, `mobile/test/consent.test.tsx`. Raccorder layout et réglages ; modifier `mobile/package.json`/lock pour `@segment/analytics-react-native` et les dépendances natives requises par sa version compatible Expo SDK57. Aucun SDK Amplitude, identify, compte serveur ou instrumentation musicale hors tickets propriétaires.

## Contrat
Choix facultatif Mesure d'usage : Accepter/Refuser de même accessibilité, avant onboarding musical ; explication des événements anonymes et possibilité de revenir dans Réglages. AsyncStorage `track1.analytics-consent.v1` contient version/status unknown|granted|denied et choix daté, indépendant du profil/push. Tant que unknown/denied, ne pas initialiser un client émetteur, aucune file ni requête ; les appels track sont des no-op sans historique. Accord tardif démarre seulement les futurs événements. Réglages permet retrait : bloquer immédiatement tout nouvel envoi, arrêter flush et collecte, vider file persistée, reset identité puis détruire client ; un événement déjà envoyé n'est pas effacé rétroactivement. Tests de course avec flush/AppState obligatoires.

Collecteur nommé `trackEvent(name,properties,context)` où context contient source et, facultativement, event_id UUID déjà persisté, recommendation_id et notification_id. Le collecteur crée event_id seulement si le propriétaire n'en a pas déjà fourni un, puis le conserve dans toute la file de transport. Il retourne un résultat typé accepted|disabled|invalid ; map exhaustive des17 noms définis dans docs/track1-tracking-plan.md. Validation stricte à la sortie : propriétés supplémentaires interdites, champs communs ajoutés par le collecteur, aucune erreur brute. anonymousId aléatoire propre à la mesure après accord, persistant tant qu'accord maintenu, renouvelé après retrait puis réaccord ; userId absent. Désactiver auto-track lifecycle/screen et collectes superflues ; aucun ID publicitaire. event_id UUID stable→Segment messageId, sans nouvel identifiant à chaque retry. Implémenter la voie supportée par le SDK pour garder messageId (plugin/enrichissement au besoin), la vérifier sur payload réel ; aucune hypothèse de déduplication non vérifiée.

app_opened émis une fois pour le premier affichage consenti puis chaque transition réelle background→active, pas un rerender ni un simple inactive système. Si consentement accordé en cours de session, enregistrer seulement l'ouverture mesurée à cet instant, pas les actions précédentes. Source/environment/version/platform déterminés localement. Clé absente : état mesure non configurée visible en développement, aucun crash ou envoi ailleurs ; aucun secret d'administration dans le bundle.

## Critères d'acceptation
- [ ] Refus/inconnu produit zéro appel réseau et zéro queue ; accord tardif ne rejoue pas le passé ; chaque feature reste accessible.
- [ ] Retrait pendant file/flush/AppState arrête les nouveaux envois, purge le persistant et renouvelle l'identité au prochain accord.
- [ ] Les 17 contrats valident leurs exemples, rejettent champs interdits/inconnus et conservent event_id/messageId sur retry.
- [ ] app_opened respecte premier affichage/retour réel et source ; clé absente ou SDK indisponible n'empêche pas le produit.

## Tests attendus
Jest vrais validateurs/gestion de consentement, SDK transport simulé à la frontière :17 cas valides/rejetés, before-consent, retrait concurrent, redémarrage, file hors ligne, consentement tardif, identity reset et AppState. Inspection payload réseau dans build preview pour messageId et absence des propriétés interdites ; mobile check.

## Tier de risque
tier/3 — CI et review-gate requis verts ; ce gate exige l'attestation Sol/high profonde du SHA final en plus de la review ordinaire. Auto-merge après classification, sans accord humain.

## Notes d'implémentation
TRA-314 est confirmé livré dans les artefacts : préserver statut, PR, code, contrat et preuves, sans le recréer ni le rouvrir du fait de la refonte. Conserver les contrats stricts de P5.1, pas un schéma permissif. Refus analytics ne vaut ni refus push ni suppression profil. Source interne uniquement pour les essais ; test de transport sans secret dans le rapport.

### Issue — Relier Segment à Amplitude et vérifier les environnements iOS
- **Référence plan :** P5.3
- **Identifiant :** TRA-315
- **UUID conservé :** `7d0f9daa-45b2-4401-8eea-43a366c0898e`
- **Tier :** tier/3
- **Dépendances :** Distribuer un build iOS de développement et conserver la compilation Android (TRA-290, P1.5) ; Mesurer les parcours uniquement selon le choix de la personne (TRA-314, P5.2)
#### Description

## Contexte
Les événements doivent arriver dans Segment puis Amplitude sans doublons, mélange d'environnements ou installation d'un deuxième SDK. Les comptes et raccordements sont vérifiés avant la recette quotidienne.
Plan : docs/plans/track1-mobile.md, partie 5.

## Portée
Consigner le mapping effectif dans `docs/track1-tracking-plan.md` livré en P5.1 et créer `docs/track1-analytics-setup.md` ; compléter `mobile/.env.example`, `mobile/app.config.ts`, `mobile/eas.json` et `docs/track1-builds.md` livrés. Configurer les projets/sources/destinations dans les comptes Segment/Amplitude autorisés, si accès disponibles. Aucun nouveau SDK, tracking plan, collecte de goûts ou secret admin dans Git.

## Contrat
Deux chaînes isolées : source Segment track1-internal pour development/preview vers projet Amplitude track1-internal ; source track1-production vers projet Amplitude track1-production. Réutiliser un objet existant s'il correspond, sans duplication ; noter IDs/URLs réels, région d'hébergement effective et responsables d'accès. Write keys publiques uniquement dans configuration d'environnement mobile ; secrets Amplitude destination uniquement dans Segment, accès d'administration hors dépôt. Absence d'accès/compte = prérequis explicite à obtenir, jamais identifiant factice ni preuve inventée.

Destination Amplitude Actions cloud mode, événement Segment track→Amplitude event_type=name, event_properties=propriétés validées, device_id=anonymousId, insert_id=messageId, time=date d'occurrence ; user_id absent, ne pas créer de session native ni identify. Conserver platform/app_version/build/environment et attribution. Filtrer l'environnement approprié pour empêcher un payload preview d'arriver en production. Contrôler les mappings et options réellement disponibles dans le compte/SDK au moment de l'exécution, sans affaiblir ce contrat.

Recette consentie via build iOS : un événement identifié apparaît une fois dans Segment Debugger puis Amplitude avec mêmes identifiants et propriétés. Réinjecter le même messageId de recette pour vérifier la déduplication de destination. Refus/retrait donnent aucun nouvel événement. Ne pas envoyer des essais dans les cohortes de production ; distinguer explicitement limitation d'outil ou blocage d'accès d'une intégration livrée.

## Critères d'acceptation
- [ ] IDs et liens réels des deux chaînes sont documentés ; aucun événement interne n'arrive en production et inversement.
- [ ] Un événement issu d'un build iOS conserve messageId→insert_id et anonymousId→device_id ; replay n'ajoute pas de doublon Amplitude. Le mapping conserve platform:ios|android ; la preuve d'émission Android reste différée — non exécutée et transférée à P8.1.
- [ ] Propriétés interdites/userId/secret absents ; aucun SDK Amplitude mobile ; refus/retrait contrôlés en réseau.
- [ ] Configuration reproductible par environnement, preuves expurgées et accès manquants explicités ; aucun secret administratif committé.

## Tests attendus
Recette connecteur réelle sur environnement interne avec IDs de messages vérifiables, doublon et refus ; validation des fichiers config et mobile check. Consigner résultats/versions/mappings et captures sans secrets dans le document ; aucune dépense ou abonnement supplémentaire sans autorisation.

## Tier de risque
tier/3 — CI et review-gate requis verts ; ce gate exige l'attestation Sol/high profonde du SHA final en plus de la review ordinaire. Auto-merge après classification, sans accord humain.

## Notes d'implémentation
La compatibilité de la propriété plateforme ne vaut pas émission réelle Android : cette recette physique et ses traces Segment/Amplitude relèvent de P8.1, sans bloquer iOS. La write key Segment n'est pas une clé d'administration mais reste liée au bon environnement. Si une exigence de sécurité bloque la configuration, signaler le prérequis, ne pas substituer un deuxième collecteur.
Contrat du ticket existant TRA-315 : reprendre le code et les tests déjà livrés, conserver son statut réel, sa PR et ses preuves ; cet amendement n'ordonne ni recréation ni réouverture d'une tâche terminée.

### Issue — Rendre les indicateurs du lancement iOS fiables et consultables
- **Référence plan :** P5.4
- **Identifiant :** TRA-316
- **UUID conservé :** `b5791e36-409b-4d04-aa7c-4809d15cf125`
- **Tier :** tier/1
- **Dépendances :** Vérifier le parcours quotidien complet sur iPhone (TRA-306, P3.9) ; Vérifier l'exploration et l'accessibilité sur iPhone (TRA-313, P4.7) ; Relier Segment à Amplitude et vérifier les environnements iOS (TRA-315, P5.3)
#### Description

## Contexte
La présence d'événements ne suffit pas à garantir des indicateurs fiables. Le lancement doit disposer de mesures lisibles dont les limites sont explicites.
Plan : docs/plans/track1-mobile.md, partie 5.

## Portée
Livrables à conserver/compléter ; créer uniquement les éléments encore absents : `mobile/test/analytics-journeys.test.ts`, `docs/qa/track1-analytics.md` et `docs/track1-launch-metrics.md`. Reporter liens/traces dans `docs/track1-tracking-plan.md`. Configurer les vues du projet Amplitude déjà raccordé, sans modifier les événements/features. Utiliser tracking plan, recettes P3.9/P4.7 et chaîne P5.3. Aucun nouvel objectif chiffré, mesure de durée de session ou taux push reçu/ouvert.

## Contrat
Vérifier les 17 événements sur iOS et leurs champs/identités/déduplications. Scénarios consentis nominal, refus, retrait, accord tardif, redémarrage, double callback notification et génération reprise ; inscrire IDs anonymes de recette et résultat attendu/observé sans goûts/recherche. Matrice de couverture associe chaque événement à son scénario, ticket propriétaire, preuve Segment et preuve Amplitude.

Créer un tableau de bord de lancement production avec liens réels, filtre iOS explicite et exclusion des environnements internes ; conserver la dimension plateforme pour les vues Android séparées après P8.1 : achèvement flux distincts completed/started ; sélections reco ouvertes/viewed ; sélections viewed ayant external_listening_opened attribué/viewed ; cohortes anonymousId premier app_opened UTC jourD et retour exactement D+1/D+7, exclure cohortes immatures ; funnel notification_opened→node_viewed→external_listening_opened ; générations request_id distincts demandées/réussies/échouées, en cours séparées. Chaque vue indique période/population/dénominateur/exclusions. Si une vue native ne permet pas un calcul exact distinct/attribution, utiliser une requête/export documenté du même projet plutôt qu'un ratio trompeur. Aucune valeur de départ ou rétention future inventée ; zéro donnée reste « non mesurable » selon le dénominateur.

## Critères d'acceptation
- [ ] 17/17 événements iOS couverts par preuves dans Segment et Amplitude, sans champs interdits ni doublons logiques ; les preuves Android sont transférées à P8.1 et marquées différées — non exécutées.
- [ ] Refus/retrait/tardif respectent le contrat ; événements de recette ne contaminent pas production.
- [ ] Les six familles d'indicateurs du lancement iOS sont consultables via liens/requêtes réels, filtre iOS/production explicite, environnements internes exclus, formules exactes et limites lisibles.
- [ ] Clic d'écoute non décrit comme écoute confirmée, receipt Expo non décrit comme lecture push ; cohortes immatures/dénominateur 0 traités correctement.

## Tests attendus
Jeu déterministe de recette connu avec numérateurs/dénominateurs attendus, puis comparaison avec sorties des outils ; échantillon payload et replay d'identifiant. Vérification des liens/accessibilité des vues et table de couverture. Correctifs fonctionnels éventuels dans tickets propriétaires. Le fichier `mobile/test/analytics-journeys.test.ts` rejoue le jeu déterministe avec vrais collecteur, contrats et logique de déduplication, transport externe simulé, puis assertions exactes d'événements et de refus ; les preuves SaaS complètent ce test sans le remplacer.

## Tier de risque
tier/1 — CI et review-gate verts, review IA selon le processus, auto-merge après classification du tier.

## Notes d'implémentation
La refonte revalidera ces événements et leur déduplication en P6.5 ; aucune animation ne crée de nouvel événement produit. Tier/1 pour configuration analytique/documentation de vérification, pas nouveau traitement personnel. Aucun rattrapage des personnes qui n'ont pas consenti.
Contrat du ticket existant TRA-316 : reprendre le code et les tests déjà livrés, conserver son statut réel, sa PR et ses preuves ; cet amendement n'ordonne ni recréation ni réouverture d'une tâche terminée.

## Milestone 6 — Découvrir track1 avec une interface et des animations cohérentes
- **Identifiant Linear :** à créer, aucun identifiant attribué dans ce manifeste.

### Description
- **Objectif produit :** donner aux premiers utilisateurs iOS une expérience visuelle cohérente, lisible et agréable avant d'élargir les tests et de présenter track1 sur l'App Store.
- **Solution :** faire valider une référence de design utilisable par l'équipe, appliquer cette référence aux parcours existants, puis ajouter les animations décrites et vérifier l'ensemble sur iPhone.
- **Logiques ajoutées ou modifiées :** hiérarchie visuelle, présentation des choix et des contenus, états d'attente et d'erreur, retours d'action, transitions et comportement lorsque la réduction des animations est activée. Les règles de recommandation, de génération, de consentement et de rappel restent celles des parcours livrés.
- **Résultat observable :** chaque écran et état du périmètre correspond à une référence approuvée ; les parcours restent accessibles et mesurés correctement, avec une preuve sur iPhone. Les captures et la bêta élargie peuvent alors montrer l'expérience destinée à être publiée.

### Issue — Définir et faire valider le design des parcours et de leurs animations
- **Référence plan :** P6.1
- **Identifiant :** TRA-?
- **Tier :** tier/1
- **Dépendances :** Ouvrir les trois entrées de navigation (TRA-288, P1.3)
#### Description

## Contexte
Les premiers utilisateurs iOS doivent découvrir une interface et des animations cohérentes avant l'élargissement TestFlight et les captures publiques. Les artefacts vérifiés ne contiennent encore aucun handoff mobile approuvé : ce ticket livre les décisions et références nécessaires, sans coder les écrans ni inventer des choix à la place de Raphael.
Plan : docs/plans/track1-mobile.md, partie 6.

## Portée
Créer `docs/track1-design.md` ; créer `docs/design/track1/` pour les exports fournis, dans le parent `docs/` vérifié. Références existantes en lecture seule : `mobile/app/_layout.tsx`, `mobile/app/(tabs)/_layout.tsx`, `mobile/app/privacy-choice.tsx`, `mobile/app/onboarding.tsx`, `mobile/app/(tabs)/index.tsx`, `mobile/app/(tabs)/search.tsx`, `mobile/app/(tabs)/settings.tsx`, `mobile/app/node/[slug].tsx`, `mobile/src/generation/status.tsx` et `mobile/src/components/`. Hors-scope : code mobile, nouvelle fonctionnalité, changement de recommandation/consentement/push, choix imposé de Figma ou installation MCP, redesign web.

## Contrat
Le document devient le handoff versionné de référence : numéro de version, date, source consultable, approbation datée de Raphael et périmètre approuvé. Des liens Figma sont facultatifs ; un lien inaccessible ne suffit jamais. Des exports lisibles et une description locale rendent les règles utilisables sans compte ni plugin particulier.

Matrice exhaustive des écrans : choix de mesure avant goûts, choix/modification des genres, Aujourd'hui, fiche artiste/projet/morceau/genre/label (projet album/EP/single), listes de relations, recherche et filtres, génération, Réglages. Pour chaque écran, couvrir ses états réellement possibles : initial, vide, chargement, contenu complet/partiel, erreur, hors réseau, refus ou retrait de permission/mesure lorsque concernés. Une case non applicable porte une justification ; une case applicable a une référence et une décision finale, jamais un placeholder.

Pour chaque référence, spécifier composition, hiérarchie et texte exacts, valeurs de couleurs/typographies/espacements/dimensions et règles d'adaptation, safe areas, grand texte, rôles/libellés/ordre VoiceOver, retours arrière, focus et actions. Lister les assets autorisés avec fichier, source, licence/droits d'usage, variante et provenance ; aucun achat ou droit supposé. Les règles fonctionnelles restent celles livrées : trois onglets, profil local, découverte du jour stable, création explicite, écoute externe, choix de mesure et de push indépendants.

Matrice des animations : identifiant, écran/état de départ et d'arrivée, déclencheur, éléments animés, durée, courbe, ordre, interruption, répétition, sortie d'écran/arrière-plan et variante en réduction des mouvements. Fixer les critères de comparaison, tolérances éventuelles, critères de fluidité mesurables et iPhone/OS de référence avant recette ; aucune valeur visuelle ou de performance n'est choisie dans les tickets d'intégration. S'appuyer sur Expo Router et les API natives déjà disponibles. Si le besoin exige une nouvelle bibliothèque, consigner ce point comme blocage de portée à résoudre avant intégration ; sa présence transitive ne vaut pas autorisation d'import.

## Critères d'acceptation
- [ ] Le handoff est versionné, ses exports/références s'ouvrent et l'approbation datée de Raphael est consignée pour la version exacte ; une proposition non validée ne clôture pas le ticket.
- [ ] La matrice couvre chaque écran et état cité ; chaque case possède sa référence finale ou sa justification de non-applicabilité, sans placeholder ni choix visuel à deviner.
- [ ] Textes, valeurs visuelles, comportements de navigation et accessibilité sont spécifiés ; chaque asset a source, provenance et droits d'usage vérifiables.
- [ ] Chaque animation a tous les paramètres du contrat, ses cas d'interruption et sa variante accessible ; les critères de comparaison/fluidité et appareils de référence sont fixés.
- [ ] Le handoff n'ajoute aucune fonctionnalité, n'altère aucune règle métier/consentement et reste lisible sans imposer Figma/MCP ; tout besoin de dépendance non prévue est résolu dans une portée amendée avant intégration.

## Tests attendus
Vérification documentaire : croiser l'inventaire des routes/composants avec la matrice ; contrôler chaque case, chaque paramètre d'animation et chaque asset. Ouvrir les exports et références avec les accès de l'implémenteur, vérifier la traçabilité version→approbation. Aucune nouvelle suite de code nécessaire ; les décisions et contrôles sont enregistrés dans le handoff.

## Tier de risque
tier/1 — documentation, contenu et recette ; CI et review-gate verts, review IA et auto-merge après classification, sans gate humain de merge.

## Notes d'implémentation
Définition parallélisable avec les verrous fonctionnels après P1.3/TRA-288. L'accès aux décisions ou designs de Raphael est une entrée réelle : signaler ce qui manque, sans inventer la palette, les maquettes ou les courbes. Cette validation de design est distincte de la validation du plan du 30 septembre 2026 et n'est pas un gate humain de merge.

### Issue — Appliquer le design au premier lancement et à la découverte du jour
- **Référence plan :** P6.2
- **Identifiant :** TRA-?
- **Tier :** tier/2
- **Dépendances :** Définir et faire valider le design des parcours et de leurs animations (TRA-?, P6.1) ; Proposer et retrouver sa découverte du jour (TRA-300, P3.3) ; Choisir les rappels et retrouver Aujourd'hui depuis une notification (TRA-305, P3.8) ; Mesurer les parcours uniquement selon le choix de la personne (TRA-314, P5.2)
#### Description

## Contexte
Le premier lancement et Aujourd'hui doivent appliquer le design approuvé tout en conservant les choix indépendants de mesure et de notifications. Ce ticket livre un parcours d'entrée cohérent, fondé sur les fonctionnalités déjà testées.
Plan : docs/plans/track1-mobile.md, partie 6.

## Portée
Modifier les chemins existants vérifiés : `mobile/app/_layout.tsx`, `mobile/app/(tabs)/_layout.tsx`, `mobile/app/privacy-choice.tsx`, `mobile/app/onboarding.tsx`, `mobile/app/(tabs)/index.tsx`. Créer `mobile/src/ui/` dans le parent `mobile/src/` vérifié pour les valeurs et éléments visuels partagés. Étendre `mobile/test/navigation.test.tsx`, `mobile/test/consent.test.tsx`, `mobile/test/onboarding.test.tsx`, `mobile/test/today.test.tsx`. Lire le handoff livré par P6.1 dans `docs/track1-design.md` et ses exports. Hors-scope : backend/web/schéma, stockage du profil, algorithme de recommandation, collecte, permissions et nouvelles dépendances.

## Contrat
Prérequis ferme : P6.1 approuvé ; aucune valeur manquante n'est déduite d'une page web ou d'une bibliothèque. Reprendre les versions/références exactes du handoff et appliquer les écrans et états concernés, y compris configuration invalide, choix inconnu/refusé/accepté de mesure, brouillon de goûts, seuil et erreurs de sauvegarde, absence de genres, Aujourd'hui sans profil/sans catalogue/chargement/contenu/hors réseau/erreur et invitation aux rappels.

Centraliser couleurs, typographie, espacement et primitives réutilisables dans mobile/src/ui/ ; les routes consomment ces éléments et gardent leurs services/contrôleurs existants. Conserver les textes et règles fonctionnelles : mesure avant onboarding musical, Accepter/Refuser accessibles au même niveau, au moins trois genres ou tous ceux disponibles s'il y en a moins, accès Recherche si aucun genre, recommandation stable par date/profil et accès après refus du push. Ni animation nouvelle hors handoff ni nouvelle feature.

Conserver les déclencheurs existants app_opened/onboarding_started/onboarding_completed/preferences_updated/daily_recommendation_viewed/daily_recommendation_opened/notification_permission_result, l'attribution et les identifiants persistés. Refus de collecte = aucune émission ni file ; accord tardif = aucun rattrapage. Le changement visuel ou rerender n'émet aucun événement. Safe areas, labels/rôles/focus et agrandissement du texte suivent le handoff sans masquer une action. Les mouvements seront intégrés en P6.4 ; les états finaux doivent déjà être utilisables sans animation.

## Critères d'acceptation
- [ ] Chaque écran/état du sous-périmètre correspond à la version approuvée du handoff, avec preuve de comparaison référencée et aucun élément visuel improvisé.
- [ ] Les valeurs et éléments visuels communs sont réutilisés depuis mobile/src/ui/ ; aucun style divergent équivalent n'est introduit dans les routes traitées.
- [ ] Choix de mesure, seuil/reprise/erreur des goûts, recommandation et refus de push conservent leurs résultats fonctionnels, sans mutation des règles de collecte ou de stockage.
- [ ] Texte agrandi, VoiceOver, focus, navigation et retours permettent toujours d'atteindre chaque action du parcours.
- [ ] Les tests existants étendus passent ; changement d'onglet, rerender ou retour au premier plan ne dupliquent ni recommandation ni événement, et refus/accord tardif restent couverts.

## Tests attendus
Tests d'interaction des quatre suites existantes : états nominaux, vides, chargement, erreurs et refus ; vrais composants et contrôleurs, frontières natives/réseau seulement simulées. Comparaison visuelle sur iPhone ou build interne aux références de P6.1, contrôle VoiceOver/texte agrandi des écrans touchés, puis mobile check et backend check de non-régression. La recette exhaustive finale relève de P6.5.

## Tier de risque
tier/2 — présentation et interactions natives avec état ; CI et review-gate verts, review IA et auto-merge après classification. Aucun changement de consentement, données personnelles ou configuration native autorisé dans ce périmètre.

## Notes d'implémentation
Prérequis : P6.1, TRA-300/P3.3, TRA-305/P3.8 et TRA-314/P5.2. Préserver les acquis de collecte déjà livrés. Un besoin de modifier consentement, stockage ou recommandation impose un amendement de portée/tier ; ne pas le cacher dans la refonte.

### Issue — Appliquer le design aux fiches, à la recherche et aux réglages
- **Référence plan :** P6.3
- **Identifiant :** TRA-?
- **Tier :** tier/2
- **Dépendances :** Appliquer le design au premier lancement et à la découverte du jour (TRA-?, P6.2) ; Compléter les fiches des artistes et de leurs œuvres (TRA-307, P4.1) ; Explorer les particularités des genres et labels (TRA-308, P4.2) ; Créer une fiche absente et suivre son résultat (TRA-310, P4.4) ; Ouvrir directement une fiche depuis un lien track1 (TRA-311, P4.5) ; Continuer à consulter et reprendre les parcours malgré les pannes (TRA-312, P4.6)
#### Description

## Contexte
La même référence visuelle doit couvrir l'exploration et les réglages, y compris les fiches incomplètes et les pannes. Ce ticket harmonise les parcours déjà livrés avec les éléments partagés de P6.2, en conservant leurs actions.
Plan : docs/plans/track1-mobile.md, partie 6.

## Portée
Modifier les routes vérifiées `mobile/app/node/[slug].tsx`, `mobile/app/(tabs)/search.tsx`, `mobile/app/(tabs)/settings.tsx`, `mobile/src/generation/status.tsx` et les composants existants `mobile/src/components/NodeArticle.tsx`, `mobile/src/components/NodeImage.tsx`, `mobile/src/components/NodeRelations.tsx`, `mobile/src/components/SearchResults.tsx`, `mobile/src/components/ArtistDetails.tsx`, `mobile/src/components/ProjectDetails.tsx`, `mobile/src/components/TrackDetails.tsx`, `mobile/src/components/GenreDetails.tsx`, `mobile/src/components/LabelDetails.tsx`. Réutiliser `mobile/src/ui/` livré par P6.2. Étendre `mobile/test/node-screen.test.tsx`, `mobile/test/search.test.tsx`, `mobile/test/generation.test.tsx`, `mobile/test/work-details.test.tsx`, `mobile/test/genre-label-details.test.tsx` et les tests de consentement/cache existants si leurs réglages sont touchés. Hors-scope : web, schéma musical, API, nouveaux champs ou règles métier, nouvelle dépendance.

## Contrat
Handoff approuvé `docs/track1-design.md` et valeurs partagées P6.2 font autorité. Traiter chaque type de fiche et état prévu : données complètes/partielles, article long, image absente/erreur, sources, relation simple/liste/cycle/absente, alias, contenu absent et réseau indisponible. Projets album/EP/single ou type inconnu affiché Projet ; genres/labels sans action d'écoute trompeuse. Les URL d'écoute et sources gardent leurs validations et les boutons leurs libellés exact/recherche.

Recherche conserve filtres des cinq types, temporisation, annulation des réponses périmées, cache/externe distingués et absence de texte brut dans la mesure. Génération garde le geste explicite, l'identité/request_id persistée avant envoi, suivi au premier plan et reprise du même ID ; états attente/succès/erreur/quota/interruption/expiration/hors réseau restent distincts. La présentation ne lance aucun POST supplémentaire.

Réglages conserve modification/effacement des goûts, refus/retrait de mesure, permission push et désactivation hors ligne en attente. Préserver la purge de confidentialité livrée dans TRA-326 et les choix indépendants ; aucune suppression ou émission nouvelle. Les fiches en cache restent lisibles selon le contrat de cache livré. Chaque action, état et retour conserve son nom/rôle/focus VoiceOver et sa lisibilité en grand texte ; les événements node_viewed/relation_opened/search/generation/external_listening gardent attribution et déduplication.

## Critères d'acceptation
- [ ] Les cinq types de fiches, variantes de projet et états applicables de recherche/génération/réglages ont un rendu conforme au handoff et une couverture de test identifiée.
- [ ] Relations, retour, liens profonds et écoute exacte ou recherche exécutent les mêmes actions sûres ; les genres/labels ne gagnent pas de bouton trompeur.
- [ ] Recherche obsolète, double appui de génération, redémarrage et reprise hors réseau n'entraînent ni donnée périmée affichée à tort ni création implicite/payante supplémentaire.
- [ ] Refus/retrait de mesure, désactivation push différée, effacement du profil et purge de confidentialité TRA-326 conservent leur comportement et leurs tests.
- [ ] États et actions restent accessibles en VoiceOver et texte agrandi ; les événements gardent leurs déclencheurs, identités et absence de doublons.
- [ ] Mobile check et backend check passent, sans changement du web, du schéma ou ajout de dépendance.

## Tests attendus
Étendre les suites existantes listées avec comparaisons de rendu/interaction liées à la matrice design, données partielles, alias, erreurs, hors réseau et consentement. Utiliser les vraies règles de navigation/états et simuler seulement les frontières externes. Comparaisons visuelles des états aux références approuvées, contrôles ciblés iPhone et absence de régression des suites cache/consentement.

## Tier de risque
tier/2 — présentation et interactions natives avec état ; CI et review-gate verts, review IA et auto-merge après classification. Aucun changement de consentement, données personnelles ou configuration native autorisé dans ce périmètre.

## Notes d'implémentation
Prérequis : P6.2, TRA-307/P4.1, TRA-308/P4.2, TRA-310/P4.4, TRA-311/P4.5, TRA-312/P4.6. P6.2 porte déjà P6.1 ; une référence manquante reste un blocage de handoff. TRA-312/TRA-326 livrés ne sont pas recréés. Ce résultat couvre les couches de présentation nécessaires aux cinq types ; au-delà de 1 000 lignes ou 20 fichiers écrits, justifier la cohérence et réexaminer la portée sans supprimer de tests.

### Issue — Appliquer les animations validées avec une variante accessible
- **Référence plan :** P6.4
- **Identifiant :** TRA-?
- **Tier :** tier/2
- **Dépendances :** Appliquer le design au premier lancement et à la découverte du jour (TRA-?, P6.2) ; Appliquer le design aux fiches, à la recherche et aux réglages (TRA-?, P6.3)
#### Description

## Contexte
Les animations doivent rendre les transitions prévues par le design tout en laissant les parcours utilisables lorsqu'elles sont interrompues ou désactivées. Ce ticket applique exclusivement la matrice de mouvement approuvée aux écrans déjà intégrés.
Plan : docs/plans/track1-mobile.md, partie 6.

## Portée
Compléter `mobile/src/ui/` livré par P6.2 et raccorder uniquement les routes/composants existants concernés par la matrice : `mobile/app/_layout.tsx`, `mobile/app/(tabs)/_layout.tsx`, `mobile/app/privacy-choice.tsx`, `mobile/app/onboarding.tsx`, `mobile/app/(tabs)/index.tsx`, `mobile/app/(tabs)/search.tsx`, `mobile/app/(tabs)/settings.tsx`, `mobile/app/node/[slug].tsx` et `mobile/src/generation/status.tsx`. Créer `mobile/test/motion.test.tsx` dans `mobile/test/` vérifié ; compléter les tests d'interaction concernés. Hors-scope : nouvelle bibliothèque, backend, tracking supplémentaire, logique métier, effet non décrit dans le handoff.

## Contrat
Appliquer la version approuvée de la matrice dans `docs/track1-design.md` : chaque identifiant de mouvement conserve déclencheur, éléments, durée, courbe, ordre, règles d'interruption/répétition et variante accessible définis. Centraliser les valeurs/comportements partagés dans mobile/src/ui/ ; utiliser Expo Router et les API React Native déjà disponibles. La présence transitive de Reanimated ne l'autorise pas comme import direct ; aucune nouvelle dépendance ni configuration native n'est prévue.

La réduction des mouvements système active la variante définie par le handoff, y compris si le réglage change pendant l'usage ; une action ne dépend jamais de la fin d'un mouvement décoratif. Double appui, transition inverse, retour arrière, démontage et passage en arrière-plan ne laissent ni écouteur, timer, transition ni focus bloqué. L'état final, le focus accessible et l'action métier restent cohérents après interruption. Une transition répétée n'ajoute aucune navigation, demande de génération ou émission analytics.

Conserver les événements et leur déduplication : une animation ne vaut pas exposition supplémentaire d'une recommandation, entrée de fiche, ouverture de notification ou action d'écoute. Livrer des captures vidéo du build iPhone montrant les mouvements concernés et leurs variantes ; consigner build/SHA, appareil, date et identifiant de référence dans la preuve de PR, reprise ensuite par P6.5.

## Critères d'acceptation
- [ ] Chaque animation livrée correspond à un identifiant et aux paramètres du handoff approuvé ; aucune animation ni dépendance nouvelle hors matrice.
- [ ] Réduction des mouvements activée avant et pendant le parcours applique la variante attendue, en laissant toutes les actions et annonces accessibles.
- [ ] Interruption, répétition, retour arrière, démontage et arrière-plan nettoient leurs ressources et conduisent à un état utilisable sans focus ni action bloqués.
- [ ] Les tests prouvent une navigation/action attendue et aucun doublon de demande ou d'événement malgré double appui, double callback ou rerender.
- [ ] Des vidéos iPhone identifiées démontrent nominal, interruption et variante sans mouvement ; les critères de fluidité et de comparaison fixés dans le handoff sont vérifiés.
- [ ] Mobile check et suites de parcours concernées restent verts ; aucune nouvelle bibliothèque ou modification de consentement/configuration native.

## Tests attendus
Jest dans mobile/test/motion.test.tsx avec horloge et frontière des réglages natifs contrôlées : états initial/final, interruptions, changement de réduction des mouvements, démontage/arrière-plan et réentrance. Tester les contrôleurs possédés réellement et compter actions/événements. Vidéos iPhone sur les appareils/OS du handoff, plus mobile check ; les vidéos ne remplacent pas les assertions de logique.

## Tier de risque
tier/2 — présentation et interactions natives avec état ; CI et review-gate verts, review IA et auto-merge après classification. Aucun changement de consentement, données personnelles ou configuration native autorisé dans ce périmètre.

## Notes d'implémentation
Prérequis : P6.2 et P6.3, donc handoff P6.1 approuvé. Une animation impossible avec les capacités prévues reste à résoudre dans le handoff/portée avant implémentation, sans choisir tacitement une bibliothèque. La recette complète sur l'interface finale relève de P6.5.

### Issue — Valider l'interface finale et ses animations sur iPhone
- **Référence plan :** P6.5
- **Identifiant :** TRA-?
- **Tier :** tier/1
- **Dépendances :** Appliquer les animations validées avec une variante accessible (TRA-?, P6.4) ; Vérifier le parcours quotidien complet sur iPhone (TRA-306, P3.9) ; Vérifier l'exploration et l'accessibilité sur iPhone (TRA-313, P4.7) ; Rendre les indicateurs du lancement iOS fiables et consultables (TRA-316, P5.4)
#### Description

## Contexte
Avant les captures App Store et l'élargissement TestFlight, il faut prouver que le design intégré fonctionne avec les parcours, l'accessibilité et la mesure. Cette recette transverse porte sur un build iPhone précis et conserve séparément la preuve de compilation Android.
Plan : docs/plans/track1-mobile.md, partie 6.

## Portée
Créer `docs/track1-design-qa.md` dans `docs/` vérifié ; compléter `docs/track1-release.md`. Réutiliser `docs/track1-design.md`, `docs/track1-tracking-plan.md`, `docs/track1-builds.md`, `mobile/e2e/daily-discovery.yaml` et `mobile/e2e/exploration.yaml` livrés par les tâches précédentes. Aucune modification de code, signature/credential, schéma, CI ou configuration native dans cette PR tier/1 ; les corrections relèvent de leur ticket propriétaire et risque.

## Contrat
Matrice de recette reprenant chaque écran/état et chaque animation du handoff approuvé. Pour chaque ligne : version de référence, scénario, résultat réussi/échoué/non exécuté, build/SHA, appareil/OS, date et preuve capture/vidéo/trace ; une non-applicabilité doit provenir du handoff. Comparer selon les critères et tolérances approuvés, pas selon une nouvelle appréciation visuelle.

Sur iPhone physique, rejouer premier lancement et goûts, recommandation stable, vraie notification ouverte à chaud/froid/après arrière-plan, fiche et relations, écoute externe, recherche des cinq types, génération/reprise, liens profonds, hors réseau, réglages et choix de mesure/push. Contrôler VoiceOver, texte agrandi et réduction des mouvements, y compris interruptions. Reprendre la couverture des 17 événements et jeux de recette de mesure : attribution, IDs, déduplication, refus/retrait/accord tardif ; animations/rerenders sans perte ou doublon. Référencer les traces du build dans Segment et Amplitude internes.

Produire ou réutiliser avec pertinence démontrée une compilation native Android interne sur le même code candidat, avec artefact/version/SHA/profil et résultat ; JS/TypeScript seul ne suffit pas. Aucun appareil Android, FCM ou Play Console n'est requis pour cette preuve. Les contrôles physiques Android restent « différé — non exécuté, repris dans P8.1 ». Une régression de compilation connue doit être corrigée dans la tâche responsable avant succès de ce gate.

Toute anomalie bloquante (écart à un critère approuvé, action inaccessible, crash, confidentialité, événement manquant/dupliqué) est reliée à une correction puis retestée. Ne pas réécrire les preuves historiques des tickets Done ni les annoncer applicables automatiquement à ce build. Une modification ultérieure du candidat revalide les scénarios, captures ou compilation affectés.

## Critères d'acceptation
- [ ] La matrice design complète a un résultat et une preuve pour chaque ligne applicable, sur la référence approuvée et le build/SHA identifié ; aucun écart bloquant ouvert.
- [ ] VoiceOver, texte agrandi, réduction des mouvements et interruptions sont réellement contrôlés sur iPhone physique, avec preuves distinctes des tests simulés.
- [ ] Les recettes quotidienne et d'exploration repassent sur l'interface finale, avec push réellement reçu, recherche/génération, liens profonds, consentements et ouverture des services d'écoute.
- [ ] Les 17 événements et les cas refus/retrait/accord tardif gardent attribution et déduplication ; aucune perte ni duplication due à la refonte, preuves Segment/Amplitude liées au build.
- [ ] Un artefact Android interne prouve la compilation du même code candidat ; QA/appareil Android restent explicitement non exécutés et différés.
- [ ] docs/track1-release.md référence la décision de conformité, le candidat et les preuves ; captures finales TRA-318/P7.2 et TestFlight élargi TRA-319/P7.3 peuvent utiliser ce résultat.

## Tests attendus
Rejouer mobile check/backend check puis les flows Maestro daily-discovery et exploration sur iPhone avec version de Maestro et variables documentées. Exécuter séparément les gestes non automatisables VoiceOver/push réel/services externes et enregistrer leurs preuves. Vérifier les traces analytics et compiler Android en profil interne sans compte Play ; ne pas masquer un échec sous une ancienne preuve.

## Tier de risque
tier/1 — documentation, contenu et recette ; CI et review-gate verts, review IA et auto-merge après classification, sans gate humain de merge.

## Notes d'implémentation
Prérequis : P6.4, TRA-306/P3.9, TRA-313/P4.7 et TRA-316/P5.4. Le handoff approuvé seul ne valide pas l'app. Ce gate s'applique avant captures définitives et bêta élargie, sans empêcher les builds internes de développement. Aucun nouvel accord de publication n'est demandé ; le go opérationnel App Store demeure dans P7.4.

## Milestone 7 — Mettre track1 entre les mains des premiers utilisateurs iOS
- **Identifiant Linear conservé :** `4860953a-bfb0-4eb4-9f87-a93c69e18241` — ancien milestone 6, à réordonner en partie 7 et renommer

### Description
- **Objectif produit :** publier une première version fiable et compréhensible de track1 sur l'App Store dès que ses critères iOS sont satisfaits.
- **Solution :** présenter l'interface finale, expliquer les données utilisées, distribuer une bêta TestFlight élargie puis publier le build iOS validé.
- **Logiques ajoutées ou modifiées :** passage des tests internes à la bêta puis à la production, gestion des versions et preuves iOS, cohérence des captures et des déclarations de confidentialité avec l'application réellement livrée.
- **Résultat observable :** track1 est téléchargeable depuis l'App Store ; son parcours quotidien, ses push, sa génération et sa mesure ont été vérifiés sur le candidat publié. Aucun prérequis Android ne retarde cette sortie.

### Issue — Publier la politique de confidentialité dans l'app et par URL
- **Référence plan :** P7.1
- **Identifiant :** TRA-317
- **UUID conservé :** `9f970dd6-1304-4daa-9ba0-e6484cd71307`
- **Tier :** tier/3
- **Dépendances :** Choisir les rappels et retrouver Aujourd'hui depuis une notification (TRA-305, P3.8) ; Relier Segment à Amplitude et vérifier les environnements iOS (TRA-315, P5.3)
#### Description

## Contexte
« Sans compte » ne signifie pas qu'aucune donnée ne quitte le téléphone : les push et la mesure facultative doivent être expliqués clairement. L'App Store et la personne doivent accéder à la même politique réelle.
Plan : docs/plans/track1-mobile.md, partie 7.

## Portée
Livrables à conserver/compléter ; créer uniquement les éléments encore absents : `docs/track1-privacy.md`, `src/mobile/privacy.ts`, `test/mobile/privacy.test.ts`, `mobile/app/privacy.tsx`, `mobile/test/privacy-screen.test.tsx`. Raccorder le routeur mobile dans `src/mobile/router.ts`/`src/server.ts`, `mobile/app/(tabs)/settings.tsx` et `mobile/app/privacy-choice.tsx`. Aucun changement de page web existante, CMS, système de compte ou promesse juridique non vérifiée.

## Contrat
Document français indiquant éditeur et contact réels, date/version, profil/genres/historique locaux sans compte, stockage push minimal (ID opaque, hash secret, token, plateforme, fuseau/dates), inactivité 90 jours et retrait, stockage génération24 h, mesure Segment→Amplitude uniquement après accord, propriétés publiques collectées et exclusions, fournisseurs/régions effectifs, finalités et démarches d'accès/effacement. Expliquer que retrait arrête la collecte mais n'efface pas rétroactivement les données reçues, que la désinscription push hors ligne reste en attente et qu'un reset du profil ne modifie pas les deux consentements. Les durées de rétention analytics sont celles réellement configurées dans les comptes : les lire et les documenter, ne pas en inventer ; si non définies, obtenir une valeur approuvée avant publication.

Servir même contenu versionné en HTML statique minimal accessible via GET `/mobile/v1/privacy`, URL publique `https://dropcliffs.com/api/odyssey/mobile/v1/privacy`, status200 content-type text/html;charset=utf-8, échappement du contenu, aucune collecte/cookie/script. Écran natif `/privacy` toujours accessible depuis Réglages et choix analytics, avec URL ouvrable et copie intégrée pour lecture sans réseau. Tous deux affichent version/date identiques. Coordonner les champs App Privacy avec les données et SDK effectifs ; les déclarations Google Play/Data Safety sont transférées à P8.2 ; consulter les exigences officielles applicables à la publication, sans inventer une identité, adresse ou certification.

## Critères d'acceptation
- [ ] URL HTTPS publique200 et écran natif présentent la même politique/version, lisible hors ligne dans l'app.
- [ ] Le texte correspond exactement aux données/protections réelles, distingue profil/push/analytics et n'affirme pas une anonymisation absolue.
- [ ] Éditeur/contact, régions et rétention analytics sont renseignés depuis valeurs réelles vérifiées, aucun placeholder destiné à la publication.
- [ ] Page sans cookie/collecte/script et route additive ne changent pas le site ; liens Réglages/consentement fonctionnent sur iPhone et leurs tests partagés restent couverts ; le contrôle physique Android des liens sera réalisé en P8.2.

## Tests attendus
Vitest handler/corps/échappement et comparaison de version, Jest rendu natif/lien/offline. Revue documentaire croisée avec schémas push/analytics et comptes effectifs, smoke HTTPS déployé ; npm run check et mobile check.

## Tier de risque
tier/3 — CI et review-gate requis verts ; ce gate exige l'attestation Sol/high profonde du SHA final en plus de la review ordinaire. Auto-merge après classification, sans accord humain.

## Notes d'implémentation
Préparer le contenu en parallèle de la refonte ; recontrôler le lien sur l'interface finale dans la bêta iOS. Le contenu final doit être approuvé et sa validation consignée avant publication. Les coordonnées de l'éditeur sont un prérequis externe à demander si absentes, pas un arbitrage à deviner. Ce ticket n'autorise pas l'achat d'un domaine ni la création d'un compte légal.
Contrat du ticket existant TRA-317 : reprendre le code et les tests déjà livrés, conserver son statut réel, sa PR et ses preuves ; cet amendement n'ordonne ni recréation ni réouverture d'une tâche terminée.

### Issue — Préparer la présentation de track1 sur l'App Store
- **Référence plan :** P7.2
- **Identifiant :** TRA-318
- **UUID conservé :** `7b0a2ef1-d20c-4e41-bedc-4877d3d69d3b`
- **Tier :** tier/1
- **Dépendances :** Valider l'interface finale et ses animations sur iPhone (TRA-?, P6.5)
#### Description

## Contexte
La fiche App Store doit présenter la promesse réelle de track1 et aider les reviewers à vérifier ses parcours, sans annoncer un lecteur ou un compte inexistants.
Plan : docs/plans/track1-mobile.md, partie 7.

## Portée
Livrables à conserver/compléter ; créer uniquement les éléments encore absents : `mobile/store/ios/listings.fr.md` et `mobile/store/ios/assets.md`, avec icônes approuvées et captures sous `mobile/store/ios/` ; parent mobile/ vérifié, sous-dossier store/ios/ prévu à créer si absent. Consigner la version, le SHA, les références de design et la provenance dans `docs/track1-release.md`. Capturer exclusivement le build dont l'interface et les animations ont été validées en P6.5 ; réutiliser le handoff approuvé `docs/track1-design.md` et les preuves `docs/track1-design-qa.md`. Pas de nouvelle feature, photographie sous droits non obtenus, génération de cache musical ou soumission publique.

## Contrat
Métadonnées françaises prêtes à copier pour l'App Store : nom track1, résumé/sous-titre et description adaptés aux limites officielles actuelles, catégorie musicale pertinente, mots clés si admis, URL support/confidentialité réelles, notes de review et parcours sans compte. Promesse quotidienne, exploration/recherche/création explicite, liens d'écoute externe et push facultatif ; ne pas promettre audio intégré, exactitude absolue des contenus ou push garanti. Établir les réponses de classification d'âge/contenu d'après contenu effectivement accessible, sans invention.

Captures réelles iOS aux formats requis lors de l'exécution, montrant Aujourd'hui, fiche, recherche et choix utilisateur, sans données/jetons privés, habillage trompeur ou fonctionnalités non livrées. Inventaire de fichiers avec dimensions, appareil/build et provenance/droits des images ; créatifs générés comptés séparément avec outil/source s'il y en a, texte/code scaffold pas exempté. Ne pas créer de nouveau branding hors scope. Les formulaires de confidentialité seront finalisés lors des soumissions à partir de P7.1 et des SDK effectifs.

## Critères d'acceptation
- [ ] Métadonnées aux limites actuelles de l'App Store, contenus cohérents avec les parcours livrés et aucun champ indispensable factice.
- [ ] Captures correspondent au build iOS final validé en P6.5, aux références approuvées du handoff et aux formats requis, sans secret ni fonctionnalité fictive ; fichiers/provenance vérifiables.
- [ ] Instructions reviewer permettent d'essayer sans compte goûts/reco/recherche/génération et refus push/mesure ; URLs réelles accessibles.
- [ ] Points nécessitant confirmation éditeur/classification clairement résolus avant publication, sans réponse légale inventée.

## Tests attendus
Contrôle documentaire des longueurs/formats et liens avec règles officielles Apple au moment de l'exécution ; inspection visuelle des captures aux dimensions finales et comparaison aux appareils. Rapport des checks dans les deux documents et `docs/track1-release.md`, avec SHA/version du candidat.

## Tier de risque
tier/1 — CI et review-gate verts, review IA selon le processus, auto-merge après classification du tier.

## Notes d'implémentation
Ticket de contenu tier/1 ; pas d'achat d'assets, modification de services ou envoi public. Les écrans réels priment sur des maquettes marketing. Les métadonnées, captures et déclarations Google Play relèvent de P8.2 ; aucun accès Google n'est requis ici. Si un changement après P6.5 modifie un écran capturé, renouveler la preuve de conformité et la capture concernées avant soumission.
Contrat du ticket existant TRA-318 : reprendre le code et les tests déjà livrés, conserver son statut réel, sa PR et ses preuves ; cet amendement n'ordonne ni recréation ni réouverture d'une tâche terminée.

### Issue — Distribuer la bêta iOS dans TestFlight
- **Référence plan :** P7.3
- **Identifiant :** TRA-319
- **UUID conservé :** `9d58ff65-6515-4ae0-8d0b-bdc9a7480016`
- **Tier :** tier/3
- **Dépendances :** Valider l'interface finale et ses animations sur iPhone (TRA-?, P6.5) ; Publier la politique de confidentialité dans l'app et par URL (TRA-317, P7.1)
#### Description

## Contexte
La bêta TestFlight élargie doit présenter l'interface finale validée sur iPhone, avec une chaîne de signature et de distribution reproductible. Les builds internes utiles au développement et au design avant ce gate restent couverts par TRA-290 ; la diffusion Android est reprise séparément en P8.2.
Plan : docs/plans/track1-mobile.md, partie 7.

## Portée
Compléter `mobile/app.config.ts`, `mobile/eas.json`, `docs/track1-builds.md` ; créer `docs/track1-release.md` comme registre des builds, groupes et pistes, ainsi que `docs/qa/track1-beta.md` pour les preuves détaillées. Distribuer dans le groupe TestFlight élargi placé dans le périmètre autorisé, avec comptes/signatures Apple vérifiés en P1.5. Dépendances obligatoires : P6.5 (interface finale, événements et preuve de compilation Android du code retenu) et P7.1 (confidentialité accessible). Aucun lancement public, achat, accès Google ou diffusion Android.

## Contrat
Build iOS signé issu d'un SHA propre intégrant le design P6.5, les parcours, la mesure et la confidentialité ; numéros natifs uniques et croissants. Reprendre l'identifiant iOS définitif réel vérifié dans TRA-290 pour TestFlight ; les previews internes distincts ne sont pas soumis comme app publique. Ne pas recréer l'app ou le projet Expo à partir d'un identifiant proposé historiquement. Environnement backend défini et analytics internes isolés ; documenter explicitement qu'une future build production emploiera la chaîne production. Credentials uniquement dans services/stockages autorisés, jamais fichiers versionnés.

Rapport : IDs builds/EAS et liens consoles, SHA, version/build, bundle/package, SDK/OS supportés, canal/environnement et groupe de test existant autorisé ; invitations seulement aux testeurs placés dans le périmètre. Installation depuis TestFlight sur iPhone, lancement sans compte, vraie notification reçue et ouverte, liens de confidentialité et mesure dans le bon environnement vérifiés sur cet artefact signé. Examiner les exigences TestFlight/Apple du compte au moment d'exécuter ; bloquants externes consignés avec étape attendue, aucune durée promise.

## Critères d'acceptation
- [ ] Le groupe TestFlight élargi autorisé dispose d'un build iOS signé installable correspondant au SHA/version documentés et à l'interface finale validée en P6.5.
- [ ] Installation par un testeur autorisé réussie sur iPhone, notification réellement reçue avec les identifiants iOS du candidat, confidentialité accessible et mesure vérifiée dans le bon environnement, sans secret dans le bundle.
- [ ] Identifiants définitifs, numéros uniques, environnements et routage analytics vérifiés ; aucune publication publique accidentelle.
- [ ] Rapport reproductible et comptes/délais externes explicites, pas de bêta déclarée disponible sur simple upload échoué.

## Tests attendus
EAS config/build checks et commandes mobile/backend ; inspection des métadonnées de binaires et absence de secrets fournisseurs ; installation réelle depuis TestFlight avec preuve expurgée de réception du push, du lien de confidentialité et de la chaîne analytics. Recette complète de bêta dans P7.4.

## Tier de risque
tier/3 — CI et review-gate requis verts ; ce gate exige l'attestation Sol/high profonde du SHA final en plus de la review ordinaire. Auto-merge après classification, sans accord humain.

## Notes d'implémentation
Les critères de distribution Android de l'ancien contrat sont transférés à P8.2, sans statut de réussite supposé ni dépendance bloquant ce ticket. Les accès de signature Apple manquants sont un prérequis externe. Ne pas remplacer les comptes autorisés par des comptes personnels inventés, ni réutiliser les versions de preview comme version store finale.
Contrat du ticket existant TRA-319 : reprendre le code et les tests déjà livrés, conserver son statut réel, sa PR et ses preuves ; cet amendement n'ordonne ni recréation ni réouverture d'une tâche terminée.

### Issue — Valider la bêta iOS et décider sa publication
- **Référence plan :** P7.4
- **Identifiant :** TRA-320
- **UUID conservé :** `6e35a672-3e77-49e2-affc-bcf2e04ec23d`
- **Tier :** tier/1
- **Dépendances :** Rendre les indicateurs du lancement iOS fiables et consultables (TRA-316, P5.4) ; Préparer la présentation de track1 sur l'App Store (TRA-318, P7.2) ; Distribuer la bêta iOS dans TestFlight (TRA-319, P7.3)
#### Description

## Contexte
La disponibilité de TestFlight n'est pas une preuve de préparation au lancement iOS. L'autorisation explicite de Raphael d'enchaîner sans nouvel accord est conditionnée aux recettes et aux prérequis réels : ce ticket en consigne la satisfaction avant publication.
Plan : docs/plans/track1-mobile.md, partie 7.

## Portée
Livrables à conserver/compléter ; créer uniquement les éléments encore absents : `mobile/e2e/resilience.yaml`, compléter `docs/track1-release.md` et `docs/qa/track1-beta.md` ; créer `docs/track1-release-readiness.md`. Consolider recettes quotidiennes/exploration/analytics, politique et assets. Aucun correctif de feature ou soumission publique dans cette PR ; anomalies traitées avec leur risque propre.

## Contrat
Check-list finale iOS par appareil/version/build/SHA couvrant goûts/reco stable/changement de jour, cinq types et album/EP/single, relations/recherche/création explicite, génération interrompue/quota, cache hors ligne, deeplinks, écoute exacte/recherche, vraie notification reçue puis ouverte à froid/chaud/après arrière-plan, refus/retrait/token invalide/fuseau, refus analytics/17 événements/indicateurs, confidentialité et absence de secrets. Vérifier compatibilité backend/web/streaming avec recette P2.7. Inclure conformité au handoff P6.1, preuve de recette UI/motion P6.5, VoiceOver, texte agrandi et réduction des mouvements sur le candidat. Vérifier que la preuve de compilation Android interne porte sur le code retenu, la renouveler si une modification native la rend caduque ; cette compilation ne remplace pas une QA Android. Chaque ligne référence une preuve récente du build candidat ou explique pourquoi une preuve inchangée reste applicable ; pas de cases implicites.

Classer les anomalies : bloquant = crash, perte de données, sécurité/confidentialité, parcours essentiel inaccessible ou mesure indispensable fausse ; aucun bloquant ouvert autorisé. Les limitations non bloquantes sont explicites avec suivi, sans abaisser un critère de sortie validé. Consigner version/SHA candidat, résultats, date et décision opérationnelle go/no-go iOS fondée sur ces preuves. Les exigences App Store en vigueur et les prérequis du compte Apple sont vérifiés dans les sources officielles et consignés. La matrice Android reste « différé — non exécuté » avec renvoi à P8.3 pour résilience et décision ; l'absence d'appareil, de QA ou de compte Google ne bloque pas le go iOS. Mentionner l'autorisation explicite de Raphael du 2026-09-25 d'enchaîner sans accord supplémentaire : aucun nouvel accord par ticket ou pour la publication n'est demandé si les critères sont satisfaits et les accès/informations réels disponibles. Ne pas prétendre que Raphael a personnellement testé ou approuvé ce build. Si critère non satisfait, accès/information manquant ou retour store, documenter le vrai blocage, corriger dans le périmètre autorisé puis rejouer les scénarios touchés ; aucune nouvelle décision produit ni achat implicite.

## Critères d'acceptation
- [ ] Tous les critères actifs de sortie iOS ont des preuves applicables au candidat : hors réseau, crédits épuisés, redémarrage pendant génération, token invalide, mesure refusée et liens indisponibles inclus ; aucun blocage ouvert ni scénario obligatoire noté réussi sans exécution. Android reste distinctement différé vers P8.3.
- [ ] Résultats analytics, privacy, quotas et compatibilité web sont inclus, avec SHA/version et anomalies liées.
- [ ] Décision opérationnelle go/no-go datée, preuves et autorisation préalable de Raphael consignées sans inventer de validation humaine du build ; un vrai prérequis manquant reste bloquant.
- [ ] Le build iOS candidat et ses métadonnées sont figés pour la soumission App Store ; toute correction ultérieure invalide les preuves touchées et déclenche leur reprise.

## Tests attendus
Recette physique bêta iPhone complète, revue croisée des rapports et vérification des liens/IDs de preuve ; checks backend/mobile sur SHA candidat. Répéter les scénarios réellement affectés par un fix et noter ceux restés identiques. Exécuter le flow Maestro `mobile/e2e/resilience.yaml` pour les états réseau/reprise/permissions reproductibles avec les variables de recette documentées ; les erreurs fournisseur/quota/redémarrage serveur sont prouvées par les tests d'intégration aux frontières et la recette dédiée, pas par un faux bouton de panne dans une build publique.

## Tier de risque
tier/1 — CI et review-gate verts, review IA selon le processus, auto-merge après classification du tier.

## Notes d'implémentation
Tier/1 documentaire. L'amendement iOS-first validé le 2026-09-30 rend cette décision autonome ; le verdict Android futur appartient à P8.3. L'autorisation d'enchaîner a déjà été donnée le 2026-09-25 ; la préparation de publication reste conditionnée aux preuves réelles, pas à une nouvelle approbation. Ne pas confondre autorisation préalable et résultat d'une recette non exécutée.
Contrat du ticket existant TRA-320 : reprendre le code et les tests déjà livrés, conserver son statut réel, sa PR et ses preuves ; cet amendement n'ordonne ni recréation ni réouverture d'une tâche terminée.

### Issue — Publier track1 sur l'App Store
- **Référence plan :** P7.5
- **Identifiant :** TRA-321
- **UUID conservé :** `12760ae5-2445-42d6-a473-34663b4cf22b`
- **Tier :** tier/3
- **Dépendances :** Valider la bêta iOS et décider sa publication (TRA-320, P7.4)
#### Description

## Contexte
La V1 validée doit devenir installable publiquement sur iPhone avec ses déclarations de confidentialité exactes. Une soumission en attente n'est pas la fin de ce ticket.
Plan : docs/plans/track1-mobile.md, partie 7.

## Portée
Compléter configurations de version iOS si nécessaire dans `mobile/app.config.ts`/`mobile/eas.json` et `docs/track1-builds.md` ; compléter l'état de plateforme dans `docs/track1-release.md` et créer `docs/releases/track1-ios-v1.md`. Effectuer soumission et publication dans App Store Connect de l'app autorisée. Aucun changement web, feature ajoutée pendant review ou achat de compte non autorisé.

## Contrat
Préalable obligatoire : état de préparation go consigné en P7.4 sur version/SHA et accès Apple réels. L'autorisation de Raphael d'enchaîner sans nouvel accord est déjà donnée le 2026-09-25 ; ne pas solliciter un accord par soumission. Build production signé avec l'identifiant iOS définitif réel déjà vérifié dans TRA-290 avec URL API définitive, chaîne Segment production, clés publiques correctes, permissions/push/privacy manifests SDK réellement inclus ; aucune clé fournisseur embarquée. Incrémenter build si reconstruction ; réexécuter smoke des parcours/privacy/analytics sur l'artefact final et vérifier que les fonctionnalités, l'interface et les animations sont conformes à la bêta validée. Un nouveau build après recette revalide les critères affectés, dont les captures et la preuve de compilation Android si la configuration native partagée a changé.

Renseigner métadonnées/captures P7.2, URL privacy P7.1, App Privacy/classification/export compliance selon données et SDK vérifiés et exigences officielles actuelles ; ne pas déclarer « aucune donnée » parce qu'il n'y a pas de compte. Ne pas inventer de réponse légale ou de coordonnées : obtenir la donnée manquante. Soumettre à review, traiter les retours dans le périmètre validé via tickets correctifs si code, publier seulement après acceptation du store et satisfaction des critères consignés en P7.4. Utiliser les territoires/disponibilités du compte validés pour l'app, sans activer des options commerciales non demandées.

Consigner URL App Store réelle, appID, version/build/SHA, dates de review/disponibilité, état et smoke final. Blocage/rejet conserve le ticket ouvert avec motif réel ; pas de disponibilité inventée. Décrire rollback opérationnel autorisé : suspendre disponibilité si nécessaire et préparer build correctif, sans effacer les données musicales ni révoquer des credentials au hasard.

## Critères d'acceptation
- [ ] App publique installable depuis son URL réelle et version attendue ; validation Apple seule sans disponibilité ne suffit pas.
- [ ] Build final pointe vers API/analytics production, aucune fuite de secret et parcours quotidien/notification/écoute smoke-testés sur iPhone.
- [ ] Déclarations confidentialité/âge/permissions et URL politique correspondent au binaire et aux traitements effectifs.
- [ ] Rapport contient version/SHA/liens/état réels, actions de review et reprise possible ; aucun check ou gate de publication contourné.

## Tests attendus
Checks mobile/backend et inspection config finale ; recette App Store installation réelle, Aujourd'hui/fiche/écoute/push/refus analytics et contrôle d'événements production avec session de validation identifiée dans rapport. Vérifier liens et statut public depuis store.

## Tier de risque
tier/3 — CI et review-gate requis verts ; ce gate exige l'attestation Sol/high profonde du SHA final en plus de la review ordinaire. Auto-merge après classification, sans accord humain.

## Notes d'implémentation
Tier/3 livraison publique et signatures, sans gate humain de merge ni nouvel accord de publication ; les preuves et prérequis P7.4 restent obligatoires. Les délais Apple sont externes, aucune date limite promise.
Contrat du ticket existant TRA-321 : reprendre le code et les tests déjà livrés, conserver son statut réel, sa PR et ses preuves ; cet amendement n'ordonne ni recréation ni réouverture d'une tâche terminée.

## Milestone 8 — Ouvrir track1 aux utilisateurs Android lors de la reprise
- **Identifiant Linear :** à créer, aucun identifiant attribué dans ce manifeste.

### Description
- **Objectif produit :** conserver une voie de publication Android complète sans en faire un préalable à l'arrivée de track1 sur iPhone.
- **Solution :** maintenir le code compilable, puis reprendre séparément la validation sur téléphone Android, la préparation Google Play, la bêta et sa publication quand Raphael décide de réactiver ce travail.
- **Logiques ajoutées ou modifiées :** preuves de réception des rappels et de mesure propres à Android, retour système, accessibilité TalkBack, exigences du compte Google et décision de publication Android distincte de celle d'iOS.
- **Résultat observable :** pendant l'attente, aucun critère Android non exécuté n'est marqué réussi ; après reprise et recette complète, la version Android peut être distribuée puis publiée sans remettre en cause la disponibilité iOS.

### Issue — Vérifier les parcours, les push et la mesure sur Android physique
- **Référence plan :** P8.1
- **Identifiant :** TRA-?
- **Tier :** tier/3
- **Dépendances :** Distribuer un build iOS de développement et conserver la compilation Android (TRA-290, P1.5) ; Déployer l'accès mobile sans régression du site (TRA-297, P2.7) ; Déclencher les rappels à 9 h locale sur le serveur (TRA-304, P3.7) ; Appliquer les animations validées avec une variante accessible (TRA-?, P6.4) ; Relier Segment à Amplitude et vérifier les environnements iOS (TRA-315, P5.3)
#### Description

## Contexte
Le code Android reste partagé et compilable, mais une preuve iPhone ou APK ne certifie pas son fonctionnement sur téléphone Android. À la reprise explicitement décidée par Raphael, ce ticket récupère les contrôles physiques reportés de TRA-290, TRA-305, TRA-306, TRA-311, TRA-313, TRA-315 et TRA-316, sans bloquer ni rouvrir la livraison iOS.
Plan : docs/plans/track1-mobile.md, partie 8.

## Portée
Configurer les credentials Expo/FCM Android nécessaires dans les services autorisés ; ajuster `mobile/app.config.ts` et `mobile/eas.json` uniquement si ce raccordement l'exige, fichiers vérifiés sur TRA-290 et livrés par P1.5. Compléter `docs/track1-builds.md`, `docs/track1-design-qa.md`, `docs/track1-release.md`, `docs/track1-tracking-plan.md` et les rapports de recette existants sous `docs/qa/`. Réutiliser `mobile/e2e/daily-discovery.yaml`, `mobile/e2e/exploration.yaml`, `mobile/test/navigation.test.tsx`, `mobile/test/node-screen.test.tsx`, `mobile/test/consent.test.tsx`, les suites de push/liens profonds/cache et `mobile/test/analytics-journeys.test.ts` livrés dans les parties précédentes ; adapter les recettes pour Android si nécessaire. Routes/composants partagés existants : `mobile/app/`, `mobile/src/notifications/`, `mobile/src/navigation/`, `mobile/src/components/`. Parents mobile/ et docs/ vérifiés ; les rapports transverses sont les livrables des parties précédentes. Hors-scope : Play Console, publication, nouveau tracking, nouvelle fonctionnalité, modification du schéma/web.

## Contrat
Travail différé jusqu'à décision explicite de réactivation ; aucun statut Linear ni date inventés. Lire les preuves historiques et reprendre chaque ligne Android restée non exécutée. Matrice Android physique avec modèle/OS, version/build/SHA, environnement, date et preuve expurgée. Garder les preuves iOS distinctes. Reprendre les identifiants réels et la configuration partagée ; credentials FCM/Expo dans leurs services sécurisés, jamais Git, logs ou bundle. L'accès Firebase/FCM nécessaire à une vraie réception est un prérequis de cette tâche ; aucun accès Play Console requis.

Installation du build natif et trois onglets ; premier lancement avec mesure acceptée/refusée, goûts → découverte expliquée/stable → fiche → relation → Spotify/Apple Music, avec app d'écoute installée puis absente. Refus push et ouverture directe restent utilisables. Push réellement reçu depuis le serveur puis ouvert à chaud/froid/après arrière-plan vers Aujourd'hui courant ; notification ancienne, double callback, passage par onboarding, refus/désactivation hors ligne, réactivation, renouvellement du token, changement de fuseau et token invalide contrôlés. Tester la planification 9 h, fenêtre avant10 h et activation le lendemain via horloge injectée en tests, sans changer l'horloge serveur de production. Distinguer acceptation Expo, receipt APNs/FCM et réception observée.

Exploration : cinq types et album/EP/single, champs partiels/images absentes, cycles/alias/relations absentes, recherche cache/externe et filtres, génération explicite avec ID conservé/double geste/interruption/quota, liens track1://today et track1://node/<slug encodé> à froid/chaud après onboarding, rejet des liens hostiles sans génération. Retour système Android, clavier/focus, TalkBack, grand texte et réduction des mouvements suivent le handoff approuvé ; interruption/arrière-plan n'empêchent aucune action. Catalogue/fiches consultées accessibles hors réseau puis reprise, aucun POST payant implicite ; purge de confidentialité déjà livrée préservée.

Mesure Android complète via Segment puis Amplitude Actions cloud mode, SDK Segment seul : app_opened, onboarding_started, onboarding_completed, preferences_updated, daily_recommendation_viewed, daily_recommendation_opened, notification_permission_result, notification_opened, node_viewed, relation_opened, search_submitted, search_result_opened, generation_requested, generation_completed, generation_failed, external_listening_opened, external_listening_failed. Vérifier platform:android, schema_version, version/build/environment/source, anonymousId→device_id et event_id/messageId→insert_id, mêmes identifiants après replay et attribution recommendation_id/notification_id. Aucun userId, genre/profil, texte de recherche, URL brute, jeton/secret push ou erreur fournisseur. Les environnements internes et production restent séparés.

Refus/inconnu = aucune émission/file ; retrait arrête les envois et vide la file ; accord tardif ne rejoue aucun passé ; renouvellement de l'identité après retrait/réaccord. Rerender, redémarrage, double callback et reprise de génération ne dupliquent pas les événements logiques. Relier chaque événement à son scénario et ses traces Segment/Amplitude. Vérifier les six familles d'indicateurs avec filtre Android explicite et internes exclus : completed/started par flux ; reco ouvertes/viewed par sélection ; sélection viewed suivie d'ouverture externe attribuée/viewed ; retour app_opened J1/J7 par anonymousId depuis premier jour UTC en excluant cohortes immatures ; parcours notification_opened→fiche→ouverture externe ; générations demandées/réussies/échouées par request_id, en cours séparées. Fixer période/population/numérateur/dénominateur dans chaque vue ou requête ; dénominateur zéro = non mesurable. Aucun taux push ouvert/reçu ni écoute audio affirmée.

## Critères d'acceptation
- [ ] Décision de reprise consignée ; build Android installé sur téléphone physique, trois onglets et parcours quotidien avec/sans push validés, preuves appareil/version/SHA/date.
- [ ] Credentials Expo/FCM réels configurés sans secret versionné ; vraie notification reçue et ouverte à chaud/froid/arrière-plan, refus/désactivation/token/fuseau et onboarding différé couverts.
- [ ] Les cinq types, recherche/création, liens profonds, cache/reprise et retour système Android passent ; aucun POST implicite ou régression des tests partagés.
- [ ] TalkBack, texte agrandi, réduction des mouvements, clavier/focus et interruptions sont vérifiés contre le handoff approuvé, avec preuves physiques.
- [ ] 17/17 événements Android sont identifiés dans Segment et Amplitude ; mapping d'identité/déduplication, refus/retrait/accord tardif et séparation des environnements satisfont le contrat.
- [ ] Les six familles d'indicateurs Android ont filtres/formules/liens ou requêtes vérifiables et décomptes conformes aux jeux de recette ; aucun faux taux d'écoute/réception.
- [ ] Chaque critère transféré des sept tickets cités possède une preuve Android ou un échec explicite ; tous les blocages sont corrigés avec leur ticket/risque puis rejoués avant clôture, sans modifier les preuves iOS.

## Tests attendus
Exécuter les suites mobiles partagées et les flows Maestro daily-discovery/exploration sur Android ; documenter version de l'outil, sélecteurs et variables APP_ID/recette. Tester aux frontières les pannes/quota/horloges et erreurs de token sans épuiser des crédits ni toucher des données réelles. Recette séparée des gestes non automatisables : push reçu, TalkBack, services d'écoute et retour système. Comparer le jeu déterministe analytics aux traces Segment/Amplitude, replay même messageId et refus réseau. Mobile/backend check ; inspection des configurations sans secrets.

## Tier de risque
tier/3 — configuration native, credentials ou distribution ; CI et review-gate requis verts, review ordinaire et attestation Sol/high profonde du SHA final, auto-merge après classification sans accord humain.

## Notes d'implémentation
Prérequis exacts : TRA-290/P1.5, TRA-297/P2.7, TRA-304/P3.7, P6.4 et TRA-315/P5.3. Les dépendances sont vers le produit partagé ; aucun ticket des parties1–7 ne dépend de celui-ci. Conserver les tests de navigation/relations déjà livrés et la baseline push TRA-325 ainsi que la purge TRA-326. Tier/3 justifié par configuration native/credentials, pas par la seule rédaction du rapport. Play Console relève de P8.2.

### Issue — Préparer Google Play et distribuer la bêta Android
- **Référence plan :** P8.2
- **Identifiant :** TRA-?
- **Tier :** tier/3
- **Dépendances :** Vérifier les parcours, les push et la mesure sur Android physique (TRA-?, P8.1) ; Publier la politique de confidentialité dans l'app et par URL (TRA-317, P7.1)
#### Description

## Contexte
Après validation physique Android, la bêta Google Play doit présenter l'interface finale avec les informations et déclarations correspondant au binaire. Ce ticket récupère la préparation Android de TRA-317, TRA-318 et TRA-319 sans modifier la disponibilité App Store.
Plan : docs/plans/track1-mobile.md, partie 8.

## Portée
Compléter `docs/track1-builds.md`, `docs/track1-release.md` et les preuves détaillées sous `docs/qa/`. Créer `mobile/store/android/listings.fr.md`, `mobile/store/android/assets.md` et les captures sous `mobile/store/android/`, parent `mobile/` vérifié. Ajuster `mobile/app.config.ts`/`mobile/eas.json` seulement pour version/signature/configuration de distribution Android. Consommer `docs/track1-privacy.md`, `docs/track1-design.md`, `docs/track1-design-qa.md` et la politique servie via `src/mobile/privacy.ts`/`src/server.ts` déjà livrées. Configurer la piste de test du compte Google autorisé. Hors-scope : publication publique, nouvel achat/compte, nouveau branding/feature ou modification web.

## Contrat
Travail différé, activé par la reprise explicite Android. Prérequis : P8.1 et TRA-317/P7.1. Vérifier accès Play Console, appartenance de l'app/identifiant définitif réel, signature Play/App integrity, droits de distribution et exigences de test réellement applicables au compte lors de la reprise ; consigner les références officielles et constats, sans inventer durée ou nombre de testeurs. Aucune clé privée ni credential dans Git. Reprendre la configuration Expo partagée, versions natives uniques/croissantes et build propre identifié par SHA.

Préparer les métadonnées françaises Google Play selon limites en vigueur : nom track1, résumé/description, catégorie, URLs support/confidentialité réelles, notes pour review et parcours sans compte. Promesse quotidienne, exploration/recherche/génération explicite, écoute dans un service externe et push facultatif ; pas d'audio intégré ni de garantie de réception. Captures réelles du build à interface finale validée, formats Google en vigueur, source/appareil/dimensions/SHA et droits/provenance des assets consignés. Aucun export iOS présenté comme capture Android.

Data Safety, contenu/âge/public cible et formulaires reposent sur les traitements réels : profil local, abonnement push minimal, stockage des générations, Segment→Amplitude consenti et SDK inclus. Réutiliser la politique de confidentialité/version approuvée ; vérifier le lien public HTTPS et les accès natifs depuis Réglages et choix de mesure, en ligne et copie locale hors réseau. Les régions, rétention et coordonnées sont des données effectives, jamais des réponses supposées.

Distribuer le build signé sur la piste de test autorisée avec groupe de test dans le périmètre donné ; noter IDs EAS/console, package, versionName/versionCode, SHA, backend, environnement analytics et groupe/piste. Installation depuis la piste Google puis démarrage, réception réelle d'un push, consentements, confidentialité et routage des événements vérifiés sur cet artefact signé. Sources analytics de test isolées de la production ; préciser la configuration de la future version publique. Une exigence compte ou un upload en erreur reste un blocage réel, pas une bêta disponible.

## Critères d'acceptation
- [ ] Accès Play Console, identifiant/signature et exigences de test du compte sont vérifiés, documentés et satisfaits pour la piste retenue ; aucun identifiant, secret ou prérequis fictif.
- [ ] Métadonnées et captures Android respectent les exigences Google constatées et montrent le build final validé, avec provenance/droits/dimensions/SHA ; aucun écran iOS ou fonctionnalité absente présenté comme livré.
- [ ] Déclarations Google Play et politique réelle sont cohérentes ; URL HTTPS et liens Réglages/consentement fonctionnent sur Android, copie native accessible hors réseau.
- [ ] Le build signé s'installe depuis la piste Google autorisée et démarre ; notification réellement reçue, choix utilisateur et mesure dans le bon environnement vérifiés sur l'artefact distribué.
- [ ] Registre de release contient version/SHA, liens de piste/build, groupe autorisé et preuves expurgées ; aucun lancement public ni contamination des cohortes de production.
- [ ] Les contraintes externes restantes sont explicites ; aucune réussite de distribution déclarée sur un simple build ou upload.

## Tests attendus
Contrôle documentaire des longueurs/formats/liens contre les exigences Google officielles vérifiées lors de l'exécution ; inspection des captures comparées au téléphone et au handoff. Mobile/backend check, EAS configuration/build et inspection permissions/métadonnées sans exposer credentials. Installation réelle depuis Google Play test, liens privacy et push reçu, traces Segment/Amplitude isolées. Les erreurs fonctionnelles sont corrigées dans leur ticket puis retestées.

## Tier de risque
tier/3 — configuration native, credentials ou distribution ; CI et review-gate requis verts, review ordinaire et attestation Sol/high profonde du SHA final, auto-merge après classification sans accord humain.

## Notes d'implémentation
Ne pas exiger Play Console avant cette tâche. Les accès Firebase/FCM pour recette physique sont déjà traités en P8.1. La décision de publication Android reste distincte en P8.3, puis TRA-322/P8.4 ; aucune soumission publique dans cette PR et aucune réouverture de la sortie iOS.

### Issue — Valider la bêta Android et décider sa publication
- **Référence plan :** P8.3
- **Identifiant :** TRA-?
- **Tier :** tier/1
- **Dépendances :** Préparer Google Play et distribuer la bêta Android (TRA-?, P8.2)
#### Description

## Contexte
La bêta Android doit posséder ses propres preuves de résilience et de préparation à la publication. Le go iOS ne certifie ni Android ni les exigences du compte Google ; ce ticket établit le verdict opérationnel après la reprise déjà décidée.
Plan : docs/plans/track1-mobile.md, partie 8.

## Portée
Exécuter et, si nécessaire, adapter `mobile/e2e/resilience.yaml` ; compléter `docs/track1-release.md`, `docs/track1-release-readiness.md`, les rapports de bêta sous `docs/qa/` et `docs/track1-tracking-plan.md` pour les preuves de mesure. Réutiliser `docs/track1-design-qa.md`, `docs/track1-builds.md`, `docs/track1-privacy.md` et `mobile/store/android/` livrés. Parents mobile/ et docs/ vérifiés ; documents/recettes sont les livrables des parties précédentes. Hors-scope : correction de feature/configuration native, publication, changement de consentement ou de critères de sortie.

## Contrat
Prérequis P8.2 avec build signé installable depuis la piste Google ; travail différé jusqu'à reprise Android. Check-list par appareil/OS/version/build/SHA/date couvrant le même périmètre fonctionnel que TRA-320, exécuté sur Android : goûts/recommandation stable/changement de date, cinq types et album/EP/single, relations/recherche/création explicite, identité de demande préservée, liens profonds, écoute exacte/recherche, cache hors ligne et reprise.

Scénarios de résilience obligatoires : réseau coupé avec/sans cache, crédits fournisseur épuisés, redémarrage durant génération sans reprise payante automatique, token push invalide, refus/retrait/accord tardif de mesure, lien/service d'écoute indisponible. Notifications réellement reçues puis ouvertes à chaud/froid/après arrière-plan, refus/désactivation/changement de fuseau/token, retour Android/TalkBack/texte agrandi/réduction des mouvements, conformité au handoff final et absence de secret. Vérifier les17 événements Android, identités/attribution/déduplication, indicateurs filtrés Android et données internes exclues ; références aux traces P8.1 applicables au candidat. Vérifier compatibilité backend/web/streaming avec les preuves P2.7.

Chaque ligne relie une preuve récente du build candidat ou une justification explicite de pertinence d'une preuve inchangée ; pas de résultat implicite ou de substitution de preuve iOS. Contrôler exigences Google/targetAPI, accès production et tests applicables au compte au moment du go dans la console et les sources officielles. Aucun critère obligatoire non exécuté n'est réussi. Bloquant = crash, perte de données, sécurité/confidentialité, parcours essentiel inaccessible, écart bloquant au handoff ou mesure indispensable fausse ; aucun bloquant ouvert. Limites non bloquantes tracées sans abaisser les critères.

Consigner décision Android go/no-go datée sur candidat/SHA, preuves et autorisation préalable de Raphael du 2026-09-25 d'enchaîner sans accord supplémentaire, conservée par l'amendement validé le 2026-09-30. Ne pas lui attribuer une validation personnelle du build. La réactivation Android autorise la reprise, elle ne crée aucun nouvel accord par soumission. Critère/accès manquant ou retour store : consigner le blocage, corriger dans la portée autorisée puis rejouer les contrôles affectés. Un nouveau candidat invalide les preuves touchées ; aucune conséquence automatique sur les preuves ou la disponibilité iOS.

## Critères d'acceptation
- [ ] Tous les scénarios de résilience cités sont exécutés sur le candidat Android ou prouvés par l'intégration aux frontières concernée, avec appareil/version/SHA/preuve et aucune réussite inventée.
- [ ] Design/accessibilité, consentements, push réel,17 événements/indicateurs Android, confidentialité et compatibilité web sont couverts ; aucun bloquant ouvert.
- [ ] Exigences du compte Google et accès production sont vérifiés dans les sources effectives ; tout prérequis non satisfait produit no-go, sans transformer le go iOS en preuve Android.
- [ ] Décision opérationnelle Android go/no-go, candidat figé et autorisation préalable sont consignés dans le registre de préparation, sans demander ni inventer une nouvelle approbation du build.
- [ ] Toute correction ultérieure entraîne la reprise documentée des scénarios/captures/configurations affectés avant TRA-322/P8.4 ; les preuves iOS historiques restent préservées.

## Tests attendus
Maestro resilience sur Android avec outil et variables documentés, complété de la recette physique Google Play et des étapes non automatisables. Pannes/quota/redémarrage prouvés aux frontières contrôlées, pas par épuisement réel de crédits ou bouton caché dans un build public. Revue des liens/IDs et comparaison des traces analytics au jeu attendu, mobile/backend check sur SHA candidat. Rejouer uniquement les scénarios affectés par une correction avec preuve explicite.

## Tier de risque
tier/1 — documentation, contenu et recette ; CI et review-gate verts, review IA et auto-merge après classification, sans gate humain de merge.

## Notes d'implémentation
Tier/1 pour recette/tests/rapports ; tout correctif découvert garde son ticket et tier propre. Cette tâche reprend les critères Android de TRA-320/P7.4 ; elle ne remplace pas ce ticket iOS et ne dépend pas d'une nouvelle autorisation de publication. Le ticket TRA-322 gardera son ID et dépendra de cette décision Android.

### Issue — Publier track1 sur Google Play
- **Référence plan :** P8.4
- **Identifiant :** TRA-322
- **UUID conservé :** `fb9a66d0-c7ea-4481-af03-c7ef725fa7e8`
- **Tier :** tier/3
- **Dépendances :** Valider la bêta Android et décider sa publication (TRA-?, P8.3)
#### Description

## Contexte
Après décision explicite de reprise Android, la V1 validée sur Android doit devenir installable publiquement avec des déclarations Data Safety cohérentes. TRA-322 est déplacé dans le milestone Android en conservant son ID, son historique et son tier ; il ne bloque aucune partie iOS. Un bundle envoyé sur une piste n'est pas encore une publication terminée.
Plan : docs/plans/track1-mobile.md, partie 8.

## Portée
Compléter configurations version Android si nécessaire dans `mobile/app.config.ts`/`mobile/eas.json` et `docs/track1-builds.md` ; compléter l'état de plateforme dans `docs/track1-release.md` et créer `docs/releases/track1-android-v1.md`. Effectuer soumission et mise à disposition sur Google Play du compte autorisé. Aucun changement web, fonctionnalité hors plan ou achat non autorisé.

## Contrat
Préalables : décision explicite de reprise Android, préparation go Android documentée en P8.3 et accès/signature Google réels. Le go iOS TRA-320/P7.4 ne remplace pas ce verdict Android. Autorisation de Raphael d'enchaîner sans nouvel accord donnée le 2026-09-25 ; aucune approbation supplémentaire par soumission. AAB production avec l'identifiant Android définitif réel vérifié dans la configuration et le compte autorisés, versionCode unique croissant, API et chaîne Segment production ; permissions/SDK conformes aux exigences target API et formulaires en vigueur au moment de soumettre, vérifiées dans documentation officielle et console. Vérifier signature Play/App integrity et credentials push configurés, sans clé privée dans Git. Artefact final smoke-testé et fonctionnellement identique à la bêta ; toute mise à niveau corrective nécessaire passe par ticket/review adapté, pas un contournement.

Métadonnées/captures Google Play P8.2, URL privacy P7.1, Data Safety/classification d'âge/public cible et autres formulaires remplis selon traitements réels, pas selon l'absence de compte. Exigences de test préalable propres au compte vérifiées ; si accès production non encore accordé, documenter ce statut et attendre son issue avant de dire publié. Soumettre, traiter retours dans scope validé, puis rendre disponible publiquement après acceptation du store et satisfaction des critères Android P8.3 sans activer monétisation ou territoires non validés.

Rapport avec URL Google Play, package, versionName/versionCode/SHA, dates/état de review et disponibilité, smoke final, procédure suspendre déploiement ou livrer correctif. Rejet/délai externe garde ticket ouvert. Aucun effacement de cache musical ou changement de secrets partagé comme prétendu rollback.

## Critères d'acceptation
- [ ] App disponible publiquement et installable depuis URL Play réelle avec version attendue, pas seulement présente sur piste de test.
- [ ] API/analytics production, push et parcours quotidiens fonctionnent sur appareil Android ; permissions/refus/privacy exacts.
- [ ] Data Safety et formulaires correspondent aux SDK/données ; prérequis de test/targetAPI du compte satisfaits sans réponse fictive.
- [ ] Rapport de publication complet et reprise documentée ; aucun gate ou contrôle de signature contourné.

## Tests attendus
Checks mobile/backend, inspection AAB/config/permissions sans exposer credentials ; installation réelle Play, smoke Aujourd'hui/fiche/recherche/écoute/push/refus et contrôle de la chaîne analytics production documenté. Vérifier URL et statut public.

## Tier de risque
tier/3 — CI et review-gate requis verts ; ce gate exige l'attestation Sol/high profonde du SHA final en plus de la review ordinaire. Auto-merge après classification, sans accord humain.

## Notes d'implémentation
Travail différé jusqu'à reprise explicite ; aucune date ni état Linear nouveau prescrit. Après le go Android P8.3, séquencer les edits des fichiers config partagés sans altérer la disponibilité iOS. Une soumission ou un refus Google n'annule aucune preuve iOS. Tier/3 avec review finale et auto-merge, sans nouvel accord de publication ; aucune promesse sur le délai Google.
Contrat du ticket existant TRA-322 : reprendre le code et les tests déjà livrés, conserver son statut réel, sa PR et ses preuves ; cet amendement n'ordonne ni recréation ni réouverture d'une tâche terminée.
