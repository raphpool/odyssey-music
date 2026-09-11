# Phase 3 — Review

**Agent Codex :** `reviewer` (gpt-5.6-sol, effort high, lecture seule) ·
**Principe :** 4 couches, de la moins chère à la plus chère. Une couche ne
tourne que si la précédente est verte.

## Couche 0 — déterministe, 0 token
CI : `typecheck`, `lint`, `test`, taille du diff et seuils configurés.
Pas de build pour ce dépôt.
Tout ce qu'un outil peut trancher ne doit jamais être tranché par un modèle.
Si un finding de review IA revient trois fois, il devient une règle de lint.

## Couche 1 — auto-review locale, avant push
Délégation au reviewer Sol/high (voir phase 2, étape 5).
Contexte déjà chaud, cache prompt actif → c'est la review la moins chère du
process. Elle attrape les erreurs que l'agent vient de faire.

## Couche 2 — review CI sur la PR
Workflow `.github/workflows/ai-review.yml`, déclenché sur
`ready_for_review` et `synchronize`. Modèle Opus, effort xhigh, lecture seule.
Cette CI Claude est indépendante du reviewer local Sol/high. Le nom du check
GitHub est `review`.
Il produit :
- des commentaires inline sur les lignes concernées,
- un fichier `review.json` `{ verdict: "pass" | "block", findings: [...] }`,
- un check `review` qui échoue si `verdict == "block"`.

C'est ce check qui conditionne l'auto-merge. Sévérités :
- **block** — bug qui casserait la prod, fuite de données, régression,
  cas limite non géré sur un chemin critique
- **nit** — style, nommage, simplification. N'a jamais bloqué une merge.
- **pre-existing** — signalé, jamais bloquant, devient un ticket Linear.

Calibrage : `REVIEW.md` à la racine du repo. C'est le seul endroit où on
ajuste ce qui est bloquant — pas dans le prompt du workflow.

## Couche 3 — humain et review profonde
Uniquement `tier/3`, ou quand la couche 2 a bloqué deux fois de suite.
Review profonde par `reviewer` sur Sol/high, puis corrections par l'implémenteur.
Puis relecture humaine du diff par Raphael. Sur tier/3 on ne délègue pas
le jugement final.

## Boucle de correction
- Finding **nit** : ne repousse rien. Ils s'accumulent dans un ticket
  « nettoyage » hebdo, batché, sur un modèle cheap.
- Finding **block** petit : commente `@claude corrige le finding sur
  src/x.ts:42` sur la PR. Le workflow `claude.yml` pousse le fix.
- Finding **block** structurel : retour en session locale. Ne laisse pas un
  agent CI réécrire une architecture dans une boucle de commentaires.
- **Maximum 2 tours de review automatique par PR.** Au 3e, la PR est mal
  découpée : ferme-la, redécoupe le ticket.

## Économie de tokens
- Déclencheur sur `ready_for_review`, pas sur chaque push. Un draft ne se
  review pas.
- `--max-turns` dans `claude_args` pour couper les runs qui partent en boucle.
- `REVIEW.md` liste les chemins à ignorer (généré, lockfiles, snapshots) :
  la review ne paie pas la lecture de ce que le lint couvre déjà.
- Le coût d'une review est proportionnel à la taille du diff. La vraie
  optimisation de review, c'est la petite PR.
