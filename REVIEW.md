# Instructions de review

## Ce que « bloquant » signifie ici
Réserve le bloquant aux findings qui casseraient la production, feraient
fuiter des données ou empêcheraient un rollback : logique incorrecte, cas
limite non géré sur un chemin critique, requête de données non scopée à
l'utilisateur, PII dans les logs ou les messages d'erreur, migration non
rétrocompatible, secret en dur, authz manquante.

Style, nommage, structure, suggestions de refacto : `nit` au maximum.

## Barre de preuve
Un finding bloquant doit citer `fichier:ligne` et décrire un scénario
d'échec concret : entrée → comportement obtenu → comportement attendu.
Une déduction tirée d'un nom de fonction ou de variable n'est pas une preuve.
Dans le doute, classe en `nit`.

## Plafond de nits
5 nits maximum par review. Au-delà, donne un compte agrégé dans le résumé
(« plus 7 items similaires »). Si tout est `nit`, commence le résumé par
« Aucun finding bloquant ».

## Ne rapporte pas
- Ce que la CI tranche déjà : formatage, lint, erreurs de types
- Fichiers générés, lockfiles, snapshots de test, `**/*.gen.ts`
- Code de test qui viole volontairement une règle de production
- Absence de test sur un fichier de config ou de types

## À vérifier systématiquement
- Chaque critère d'acceptation du ticket lié a au moins un test
- Tout nouvel accès données est scopé à l'utilisateur courant
- Toute nouvelle route valide ses entrées à la frontière
- Les migrations sont rétrocompatibles avec la version déployée

## Re-review
À partir de la deuxième review de la même PR : findings bloquants uniquement,
plus aucun nit. Une PR qui arrive à sa troisième review est mal découpée —
dis-le dans le résumé au lieu d'ajouter des findings.

## Forme du résumé
Commence par un décompte d'une ligne : `2 bloquants, 4 nits`. Puis les
bloquants, puis les nits. Français.
