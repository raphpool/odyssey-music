# Gabarit de ticket Linear

Un ticket qui ne remplit pas ces sections n'est pas implémentable. Le titre
est une action au présent : « Ajouter la validation d'email au signup ».

```markdown
## Contexte
2 à 4 phrases. Pourquoi cette tâche existe, quel comportement utilisateur
change. Lien vers le plan : docs/plans/<slug>.md#partie-N

## Portée
Fichiers à créer/modifier (chemins réels, vérifiés) :
- `src/…` — <ce qui change>
Hors-scope explicite :
- <ce que l'agent ne doit PAS toucher, même si ça semble lié>

## Contrat
Signatures, types, schéma d'API, forme des données. Le contrat exact que le
reste du code peut supposer après cette tâche.

## Critères d'acceptation
- [ ] <observable, testable, vérifiable sans jugement humain>
- [ ] <…>

## Tests attendus
- unitaire : <cas nominal, cas limite, cas d'erreur>
- intégration : <si la tâche touche une frontière>

## Tier de risque
tier/1 | tier/2 | tier/3 — voir tiers.md

## Notes d'implémentation
Pièges connus, conventions du repo à respecter, décision déjà tranchée
qu'il ne faut pas rediscuter.
```

## Ce qui rend un ticket cher à implémenter
- « Améliorer les perfs de la liste » → pas de critère mesurable.
- « Refacto + nouvelle feature » → deux tickets.
- « Comme sur la page profil » → l'agent doit chercher ; nomme le fichier.
- Aucune mention des tests → l'agent en écrit au hasard ou pas du tout.
