# Tiers de risque

Le tier décide de qui valide et de comment ça merge. Il est posé au planning
et ne peut être **abaissé** que par Raphael, jamais par un agent.

## tier/1 — auto-merge
Copy, contenu, styles isolés, ajout de test, doc, dépendance patch,
composant purement présentationnel sans état.
- Gates : CI verte + review IA sans finding bloquant
- Merge : automatique (`gh pr merge --auto --squash`)
- Review humaine : non

## tier/2 — merge après review IA, coup d'œil humain
Nouveau composant avec état, endpoint sans effet de bord irréversible,
refacto couvert par des tests existants, changement de logique métier local.
- Gates : CI verte + review IA sans finding bloquant
- Merge : automatique, mais Raphael est notifié et peut revert
- Review humaine : lecture du résumé de PR, pas du diff ligne à ligne

## tier/3 — review humaine obligatoire
Auth, paiement, données personnelles, migration de schéma, suppression de
données, changement de contrat d'API public, config CI/CD, secrets,
dépendance majeure, tout ce qui touche `infra/`.
- Gates : CI verte + review IA + `/code-review ultra` + relecture humaine du diff
- Merge : manuel, jamais d'auto-merge
- Une PR tier/3 ne dépasse pas 200 lignes de diff. Sinon on découpe.

## Exception : PR de cache qui n'ajoute que des `l10n` (TRA-841)
Une PR `tier/3` dont **chaque** fichier modifié est sous `cache/nodes/**` et ne
diffère de sa base que par des blocs `l10n` ajoutés (JSON parsé et comparé, aucune
autre locale ni aucun autre champ touché) est classée risque 2 : la deep-review IA
ne tourne pas, la review ordinaire et les checks requis suffisent pour le gate.
Le contrôle est `isL10nOnlyAddition` dans `scripts/ci/review-gate-policy.ts`, lu
depuis la branche par défaut ; au moindre doute il répond non et la deep-review
reste exigée. Une suppression, une fusion, une réécriture, un fichier ajouté ou
tout fichier hors `cache/nodes/` la garde, comme toute PR qui touche le gate.

Le label reste `tier/3` : l'approbation de Raphael sur le contenu est une étape de
procédure, écrite dans la PR (case non cochée dans les critères d'acceptation).
Elle ne devient pas un check, et le merge attend son OK.

## Escalade automatique
Une PR passe en tier/3 quoi qu'ait dit le ticket si un chemin de son diff
correspond à `sensitivePath`.

**Source de vérité : `sensitivePath` dans `scripts/ci/review-gate-policy.ts`.**
Le job `tier-guard` de `.github/workflows/ci.yml` en applique le même motif
(écrit en `grep -E`) ; `test/ci-integrity-job.test.ts` échoue si les deux
divergent. Ce fichier ne recopie pas la liste : lis le motif, c'est lui qui
fait foi, et tu n'as rien à mettre à jour ici quand il change.

À titre indicatif seulement, `sensitivePath` couvre aujourd'hui :
- les dossiers `auth/`, `payment/`, `payments/`, `migrations/`, `infra/`
  et `deploy/`, à n'importe quelle profondeur ;
- `.github/`, plus les scripts qui exécutent ou protègent la CI et la
  livraison (`scripts/deploy-*`, `scripts/ci/review-gate-policy*`,
  `scripts/ci/threshold-ratchet.ts`, `scripts/audit-cache.ts`,
  `.codex/scripts/publish-review-status.sh`) ;
- `data/integrity-thresholds.json` ;
- les fichiers `*.sql` et tout chemin contenant `secrets`.

Ce qui n'escalade **pas** : `package.json` et le lockfile. Une dépendance
majeure reste un tier/3 *décidé au planning* (voir ci-dessus), pas détecté par
la CI : si le ticket en ajoute une, c'est au planner de poser `tier/3`.
