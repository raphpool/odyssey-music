# Phase 2 — Implémentation

**Agent :** `implementer` (sonnet, effort high, worktree isolé) ·
**Fréquence :** 1 fois par ticket · **Sortie :** une PR prête à reviewer.

## Préconditions
- Le ticket existe dans Linear, a des critères d'acceptation et un tier.
- `git status` propre sur la base.
- Si le ticket n'a pas de critères d'acceptation : **stop**, renvoie en phase `plan`.

## Étapes

### 1. Charger le ticket, pas le repo
Via le MCP Linear : récupère l'issue `$target`, passe son statut à
*In Progress*, note le nom de branche que Linear propose
(`raphael/tst-123-slug`). Tu ne lis que les fichiers listés dans la section
Portée du ticket. Pour tout le reste, tu passes par l'agent `Explore`.

### 2. Isoler
```bash
git worktree add ../wt-tst-123 -b raphael/tst-123-slug origin/main
cd ../wt-tst-123
```
Un worktree par ticket permet d'en lancer 2 ou 3 en parallèle sans collision.
L'agent `implementer` a `isolation: worktree`, ça se fait tout seul.

### 3. Test d'abord quand c'est possible
Traduis chaque critère d'acceptation en un test qui échoue. C'est le
mécanisme le moins cher pour éviter le « ça a l'air bon » : le test dit oui
ou non sans consommer de tokens de review.

### 4. Implémenter
- Respecte les conventions du repo (`CLAUDE.md`), pas tes préférences.
- Ne refactore rien qui n'est pas dans la Portée. Si tu vois un problème
  hors-scope : crée un ticket Linear `tier/?` et continue.
- Le hook `Stop` fait tourner typecheck + lint + tests à chaque fin de tour.
  S'il bloque, corrige avant de continuer — c'est gratuit comparé à un
  aller-retour CI.

### 5. Auto-review avant de pousser
```
/code-review high
```
Tourne en subagent, contexte séparé, et attrape la moitié des findings que la
review CI facturerait. Corrige ce qui est réel, ignore le bruit.

### 6. Commit et PR
Commits conventionnels, un commit par unité logique :
```
feat(signup): valider le format d'email côté serveur

Refs TRA-123
```
Puis :
```bash
gh pr create --title "TRA-123 Valider le format d'email au signup" \
  --body-file .github/pull_request_template.md --draft
```
Remplis le template : lien Linear (`Fixes TRA-123` pour fermer à la merge),
critères cochés, ce qui a été testé, ce qui reste hors-scope, tier.
Puis `gh pr ready` → c'est ce passage en ready qui déclenche la review IA.

Pour un `tier/1` uniquement :
```bash
gh pr merge --auto --squash
```
La PR se mergera d'elle-même quand tous les checks requis seront verts.

### 7. Rendre
Retourne : URL de la PR, ticket Linear, résumé du diff (fichiers + lignes),
findings corrigés en auto-review, et ce qui reste à valider.

## Garde-fous durs
- **> 400 lignes de diff ou > 12 fichiers** → arrête-toi, propose un découpage
  en sous-tickets Linear. Une grosse PR coûte plus cher à reviewer qu'à réécrire.
- **`maxTurns: 60` atteint** → tu es en boucle. Arrête, résume l'état, rends la main.
- Jamais de `--no-verify`, jamais de test `.skip`, jamais de `@ts-ignore`
  sans un commentaire qui explique et un ticket de suivi.

## Économie de tokens
- `/clear` entre deux tickets. Pas `/compact` : le résumé se repaie à chaque
  tour suivant et traîne du contexte devenu inutile.
- Un ticket = une session. Une session qui a servi à trois tickets a un
  préfixe illisible et casse le cache.
- Ne relis pas un fichier que tu viens d'éditer pour « vérifier » : l'édition
  aurait échoué si elle n'avait pas matché.
