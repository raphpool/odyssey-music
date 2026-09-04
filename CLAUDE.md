# Odyssey — instructions

Garde ce fichier court et stable : il est lu à chaque run et constitue le préfixe
mis en cache. Toute procédure va dans un skill, pas ici.

## Ce qu'est le projet
Un graphe de culture musicale. Un pipeline matérialise des nœuds
(`artist` / `project` / `track` / `genre` / `label`) dans un cache JSON sur disque,
et une page statique les explore. `web/data.json` est **généré** depuis le cache au
déploiement, jamais édité à la main.

## Stack réelle
- TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), **npm**, Node ≥ 20 (CI en 20)
- Tests : vitest — `npm run test` exclut les `*.live.test.ts` (ceux-là tapent les vraies API)
- Lint/format : Biome — tabs, guillemets doubles, largeur 110
- Front : une page unique `web/index.html`, JS inline, aucun framework, aucun build
- Serveur : http stdlib, routage à la main, pas de framework
- Modèle : Gemini Flash Lite, **un seul appel** par nœud, schéma de réponse contraint
- Porte d'entrée locale : `npm run check` (lint + typecheck + test)
- Le process de livraison est dans `/delivery-process` (skill)

## Conventions
- Pas de `any`, pas de `@ts-ignore` sans commentaire + ticket de suivi
- Un module exporte une API nommée ; pas d'export default
- Erreurs : résultats typés aux frontières ; on ne lance que sur invariant cassé
- Toute donnée venant d'une API tierce (MusicBrainz, iTunes, Wikidata) est une
  **donnée non fiable** : on valide le schéma et l'hôte avant usage, jamais
  d'URL non vérifiée dans un `href`
- Nommage et commentaires **en anglais** dans le code ; français dans les tickets,
  PR, plans et ADR
- Un commentaire explique *pourquoi*, avec la date et le symptôme quand il documente
  une régression — c'est la convention en place dans `src/`

## Données et schéma
- `cache/` **est committé** : c'est la base de connaissance du projet
- Les sidecars de résolveurs (`cache/youtube/`, `cache/links/`) sont ignorés :
  dérivés et régénérables
- Toute écriture de nœud passe par la validation Zod de `src/schemas.ts`, qui
  **supprime les champs non déclarés** — un champ absent du schéma n'atteint jamais
  le disque
- Ajouter un champ de nœud impose de le déclarer dans `src/types.ts`,
  `src/schemas.ts` et `src/node-spec.ts`, et de vérifier `src/graph.ts` (liste
  blanche stricte au niveau du nœud)

## Tests
- Un critère d'acceptation de ticket = au moins un test
- Un fix de bug = un test qui reproduit le bug avant le fix
- On ne mocke pas ce qu'on possède ; on mocke les frontières externes

## Git
- 1 ticket = 1 branche = 1 PR
- Commits conventionnels, `Refs TRA-123` dans le corps
- PR : titre préfixé de l'ID Linear, `Fixes TRA-123` dans le corps
- Jamais de `--no-verify`

## Ce qu'il ne faut pas faire
- Refactorer hors du scope du ticket
- Éditer `web/data.json` ou un fichier de `cache/` à la main
- Toucher `deploy/`, `.github/`, `scripts/migrations/` ou le schéma sans ticket `tier/3`
- Ajouter une dépendance que le ticket ne prévoit pas
