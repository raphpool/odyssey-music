# Phase 1 — Planning

**Agent :** `planner` (opus, effort xhigh) · **Fréquence :** 1 fois par *partie*,
jamais par tâche · **Sortie :** un fichier de plan + des tickets Linear autoportants.

## Préconditions
- Un brief existe (objectif produit, contrainte, deadline). Sinon : demande-le.
- Le repo est accessible en lecture.

## Étapes

### 1. Cartographier avant d'écrire
Lance l'agent `Explore` (pas toi) avec une question précise : « où vivent
les X, quelles conventions, quels tests existants sur Y ». Tu récupères une
note d'archi de 20 lignes max. Tu n'ouvres aucun fichier toi-même à ce stade.

### 2. Écrire le plan
Dans `docs/plans/<slug>.md`, en français, dans cet ordre :

```markdown
# <Projet>
## Problème
## Non-buts            # ce qu'on ne fait PAS dans ce projet
## Décisions d'archi   # 3 à 6 décisions, chacune avec son alternative rejetée
## Découpage
### Partie 1 — <nom>   # une partie = un incrément livrable et testable
- [ ] TRA-? <tâche>
## Risques             # ce qui peut casser en prod, et le garde-fou
## Critères de sortie  # comment on sait que le projet est fini
```

Règles de découpage :
- Une **partie** = un incrément qui peut être mergé et déployé sans casser
  l'existant. Si une partie n'est pas déployable seule, elle est mal découpée.
- Une **tâche** = ~1 à 4 h d'implémentation, < 300 lignes de diff attendues,
  un seul type de changement (pas « migration + UI + API » dans un ticket).
- Ordonne les tâches par dépendance. Marque explicitement les tâches
  parallélisables : ce sont elles qui tourneront en worktrees simultanés.

### 3. Gate humain — obligatoire
Présente le plan à Raphael et **arrête-toi**. Aucun ticket n'est créé avant
validation explicite. C'est le seul point du process où on paie un aller-retour
humain, et c'est le moins cher de tous.

### 4. Créer dans Linear
Après validation seulement, via le MCP Linear :
- 1 **Project** Linear = le projet, avec le lien vers `docs/plans/<slug>.md`
- 1 **Project Milestone** = une partie
- 1 **Issue** = une tâche, rattachée à son milestone

Chaque issue est écrite selon `ticket-template.md` et doit être **autoportante** :
un agent qui ne lit que ce ticket doit pouvoir implémenter sans poser de question.
Le test : relis le ticket en te demandant « qu'est-ce qui manque pour coder ça
sans ouvrir le plan ». Ce qui manque, ajoute-le.

Labels obligatoires sur chaque issue : `tier/1`, `tier/2` ou `tier/3`
(voir `tiers.md`), et l'estimate en points.

### 5. Rendre
Retourne : URL du projet Linear, liste des tickets créés avec leur tier,
et l'ordre d'attaque recommandé.

## Économie de tokens
- Un seul run de planning par partie. Ne re-planifie pas à chaque ticket.
- Le plan est le seul document long du process. Tout le reste (tickets, PR)
  y renvoie par lien au lieu de le recopier.
- N'écris jamais de code en phase de planning, même « pour illustrer ».
  Une signature de fonction ou un contrat de type suffit.
