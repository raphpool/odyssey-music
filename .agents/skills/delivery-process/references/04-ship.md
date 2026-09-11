# Phase 4 — Ship

**Agent :** `ticket-writer` (modèle hérité, effort low) · **Principe :** cette phase est de la
plomberie. Elle ne demande aucun jugement, donc elle tourne sur le modèle
adapté aux tâches mécaniques ; aucun modèle spécifique n'est imposé ici.

## Merge
| Tier | Condition | Commande |
|---|---|---|
| tier/1 | CI + `ai-review` verts | auto-merge posé à la création de la PR |
| tier/2 | CI + `ai-review` verts | auto-merge, Raphael notifié |
| tier/3 | CI + `ai-review` + review profonde Sol/high + OK humain | `gh pr merge --squash` manuel |

Branch protection sur `main` (déjà configurée) : checks requis `typecheck`,
`lint`, `test`, `diff-size` — GitHub publie les contextes sous le nom du job,
sans préfixe `ci /`. Pas de `build` : ce repo n'a rien à compiler. `review`
(le job de `ai-review`) s'ajoute aux checks requis une fois le secret
`CLAUDE_CODE_OAUTH_TOKEN` posé, sinon il échoue et bloque toutes les PR.
Historique linéaire, pas de merge commit, suppression de branche automatique.

## Après la merge
1. Linear passe l'issue en *Done* tout seul (magic word `Fixes TRA-123`
   dans la PR). Vérifie, ne le fais pas à la main.
2. Nettoie le worktree : `git worktree remove ../wt-tst-123`.
3. Si la partie (milestone) est complète, note-le dans le plan.

## Changelog / release notes
Linear **Releases** rattache chaque issue à son déploiement et génère les
notes depuis les issues incluses. Le changelog n'est donc pas à écrire :
il est la conséquence de tickets bien titrés. D'où la règle : le titre d'un
ticket est écrit pour être lu par un utilisateur, pas par un dev.

Pour une release manuelle :
```bash
gh pr list --state merged --search "merged:>=<date>" --json title,number
```
puis fais générer les notes groupées par partie, en français, orientées
bénéfice utilisateur. Modèle hérité, effort low : c'est de la reformulation.

## Économie de tokens
Ne monte pas l'effort au-delà de low. Si tu te retrouves à raisonner
en phase ship, c'est qu'un problème de la phase 2 ou 3 a fuité jusqu'ici.
