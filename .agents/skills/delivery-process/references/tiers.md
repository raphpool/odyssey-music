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
- Gates : CI verte + review IA + review profonde Sol/high + relecture humaine du diff
- Merge : manuel, jamais d'auto-merge
- Une PR tier/3 ne dépasse pas 200 lignes de diff. Sinon on découpe.

## Escalade automatique
Une PR passe en tier/3 quoi qu'ait dit le ticket si elle touche :
`**/auth/**`, `**/payment*/**`, `**/migrations/**`, `.github/**`,
`**/*.sql`, `**/secrets*`, `infra/**`, `package.json` (deps majeures).
Le workflow CI applique cette règle : ne la duplique pas à la main.
