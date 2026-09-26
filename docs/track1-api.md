# Contrat API mobile track1

## Principes d'accès

L'application utilise exclusivement une URL HTTPS se terminant par `/mobile/v1`.
Les routes historiques du serveur Odyssey ne sont pas un contrat mobile et ne doivent
pas être appelées par l'application. Le catalogue est public en lecture : aucun secret
fournisseur ne peut être embarqué dans l'application. Les futures opérations qui créent
une recommandation, une génération ou un abonnement de notifications seront associées à
une identité utilisateur côté serveur et à des crédits contrôlés côté serveur.

Toutes les erreurs de la surface mobile ont cette forme :

```json
{
	"error": {
		"code": "invalid_request",
		"message": "description exploitable par le client"
	}
}
```

Les codes actuellement exposés sont `invalid_request` (400), `not_found` (404),
`method_not_allowed` (405) et `catalog_unavailable` (500). Une erreur ne contient
jamais un message interne, un chemin de cache ou une erreur d'un fournisseur.

## Catalogue disponible

`GET /mobile/v1/catalog` retourne le catalogue mobile. Il accepte facultativement
`identities`, une liste séparée par des virgules d'au plus 20 identités uniques. Une
identité suit exactement `type:slug`, avec `type` parmi `artist`, `project`, `track`,
`genre` et `label`, et un slug ASCII minuscule séparé par des tirets. Un suffixe de
désambiguïsation canonique `--suffixe` est aussi accepté. Le paramètre décodé ne peut
pas dépasser 8 KiB. Une identité invalide, répétée ou hors limite produit
`400 invalid_request` avant toute lecture du catalogue.

```json
{
	"version": "v1",
	"revision": "sha256:…",
	"taxonomy": { "mode": "degraded", "available": true },
	"nodes": [
		{
			"identity": "artist:massive-attack",
			"type": "artist",
			"name": "Massive Attack",
			"teaser": "Bristol collective."
		}
	],
	"edges": [
		{
			"source": "artist:massive-attack",
			"target": "project:blue-lines",
			"type": "discography"
		}
	]
}
```

Le catalogue ne contient ni `article`, ni citations, ni URL tierce. La taxonomie est
toujours produite selon la stratégie dégradée : `available: false` indique que les
données de taxonomie ne sont pas disponibles, sans empêcher l'exploration des nœuds.
`revision` est le SHA-256 du contenu canonique, trié et sans horodatage volatil.

La réponse 200 porte `ETag: "sha256-…"` et `Cache-Control: public, max-age=60,
stale-while-revalidate=30`. Le client envoie cette valeur dans `If-None-Match`; à
contenu inchangé, le serveur répond `304` sans corps. Les routes mobile ne changent pas
le comportement des anciennes routes du serveur.

## Contrats réservés, non implémentés

Les routes ci-dessous sont documentées pour permettre aux clients d'anticiper les
interfaces. Elles retournent actuellement `404 not_found` et ne déclenchent aucune
génération, écriture ou notification.

- `GET /mobile/v1/daily-recommendation` retournera une recommandation quotidienne
  stable pour l'identité locale ou authentifiée, avec sa provenance de catalogue.
- `POST /mobile/v1/generations` demandera une génération explicitement déclenchée par
  l'utilisateur. Le serveur vérifiera une identité utilisateur et un crédit avant de
  contacter un fournisseur ; aucune clé fournisseur ne transitera dans le client.
- `PUT /mobile/v1/push-tokens/{token}` enregistrera ou renouvellera un token de push
  validé pour une identité utilisateur, afin de livrer la recommandation quotidienne.
- `POST /mobile/v1/events` recevra ultérieurement les événements produit validés par
  le plan de tracking, sans remplacer les SDK d'analytics du client.
