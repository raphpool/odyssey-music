---
name: delivery-process
description: Pilote le cycle de livraison projet → partie → tâche → PR. Dispatche vers la bonne phase (plan, implement, review, ship) avec le bon agent et le bon modèle. À utiliser dès qu'il s'agit de découper un projet en tickets Linear, d'implémenter un ticket, de reviewer une PR ou de préparer une release.
---

# Dispatch de livraison — Codex

Entrée Codex : ce fichier. Entrée Claude indépendante :
`.claude/skills/delivery-process/SKILL.md` depuis la racine du dépôt.
Les agents Codex sont configurés dans `.codex/agents/*.toml`.

Tu es le dispatcher. Tu ne fais **pas** le travail toi-même : tu lis la
référence de la phase, tu délègues à l'agent dédié, tu rapportes le résultat.
Chaque phase tourne dans un contexte isolé — c'est ce qui garde la facture basse.

Phase demandée : `$phase` — cible : `$target`

## Table de routage

| `$phase` | Référence à lire | Agent | Modèle |
|---|---|---|---|
| `plan` | `references/01-plan.md` | `planner` | gpt-6-astra / xhigh |
| `implement` | `references/02-implement.md` | `implementer` ou `implementer-terra` | gpt-5.6-luna / max ou gpt-5.6-terra / high |
| `review` | `references/03-review.md` | `reviewer` | gpt-5.6-sol / high |
| `ship` | `references/04-ship.md` | `ticket-writer` | modèle hérité / low |
| `ci` | `references/05-ci.md` | `implementer` | reprend Luna/max ou Terra/high du ticket |
| vide | — | demande la phase, ne devine pas | — |

## Procédure

1. **Résous la phase.** Si `$phase` est vide ou ambigu, demande-la. Ne lance
   jamais une phase par défaut : une phase `plan` lancée par erreur coûte cher.
2. **Lis la référence de la phase** (`references/…` relatif à ce skill), et
   **uniquement celle-là**. Les autres références ne doivent pas entrer en contexte.
3. **Vérifie les préconditions** listées en tête de la référence. Si une
   précondition manque (ticket introuvable, worktree sale, plan non validé),
   arrête-toi et dis ce qui manque. N'improvise pas de contournement.
4. **Délègue** à l'agent indiqué via `spawn_agent`, sans reprendre l'historique,
   avec le modèle de la table, en lui passant :
   - la cible (`$target`),
   - le contenu de la référence de phase,
   - rien d'autre. Pas d'historique de conversation, pas de fichiers déjà lus.
5. **Rapporte** en 5 lignes maximum : ce qui a été fait, l'URL Linear, l'URL
   de la PR, l'état des gates, la prochaine action attendue de Raphael.

Une implémentation ne se rend pas au moment où la PR est créée : elle passe
immédiatement en phase `ci`. Cette phase ne s'achève qu'avec les checks verts,
un blocage à corriger, ou une validation humaine requise pour un tier/3.

## Règles non négociables

- **1 ticket = 1 branche = 1 PR.** Jamais deux tickets dans une PR, jamais
  deux PR pour un ticket.
- **Un ticket sans critères d'acceptation testables n'est pas implémentable.**
  Renvoie-le en phase `plan` au lieu de deviner.
- **Diff > 400 lignes ou > 12 fichiers** → stop, propose un découpage.
- **Ne jamais désactiver un gate** (test, lint, typecheck, review) pour faire
  passer une PR. Si un gate est faux, c'est un ticket à part.
- **Ne jamais charger le repo entier.** Passe par l'agent `explorer` pour
  localiser, puis lis seulement les fichiers nommés dans le ticket.
