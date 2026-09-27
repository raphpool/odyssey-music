# Contrat API mobile track1

## Principes d'accès

L'application utilise exclusivement une URL HTTPS se terminant par `/mobile/v1`.
Les routes historiques du serveur Odyssey ne sont pas un contrat mobile et ne doivent
pas être appelées par l'application. Le catalogue est public en lecture : aucun secret
fournisseur ne peut être embarqué dans l'application. La création publique de fiche reste
limitée côté serveur (idempotence, déduplication, file bornée et crédits fournisseur), jamais
par une clé livrée au client.

Toutes les erreurs de la surface mobile ont cette forme :

```json
{
	"error": {
		"code": "invalid_request",
		"message": "description exploitable par le client"
	}
}
```

Les codes actuellement exposés sont `invalid_request` (400), `idempotency_conflict` (409),
`unauthorized` (401), `not_found` (404), `method_not_allowed` (405), `conflict` et
`idempotency_conflict` (409), `job_expired` (410), `busy` (429), `catalog_unavailable` et
`internal_error` (500), `push_unavailable`, `provider_quota_exhausted` et `provider_unavailable` (503).
Une erreur ne contient jamais un message interne, un chemin de cache, un token de notification,
un secret ou une erreur brute d'un fournisseur.

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

## Registre persistant des générations

Le serveur prépare le registre v1 des demandes de génération dans `MOBILE_STATE_DIR`.
En production, le service impose `/var/lib/track1-mobile`, hors de `/opt/odyssey-music`
et des synchronisations de déploiement, avec des droits `0700` pour le compte du service.
En local, la valeur par défaut est `./mobile-state/`, ignorée par Git.

Une demande associe une identité locale, une clé d'idempotence et une requête JSON
normalisée. Une répétition identique retourne le même registre ; la même clé avec une
requête différente produit un conflit. Les écritures sont sérialisées et atomiques. Au
redémarrage, toute demande `running` devient `interrupted` : le registre ne relance
jamais un appel fournisseur potentiellement payant. Les états terminaux sont immuables,
sont conservés 24 heures, et le registre refuse de créer de nouvelles demandes une fois
ses 1 000 états terminaux non expirés atteints plutôt que d'évincer un travail actif.

Un registre corrompu ou inaccessible est préservé et fait échouer l'opération : il n'est
jamais remplacé automatiquement par un registre vide.

## Abonnements anonymes aux rappels

`POST /mobile/v1/push/subscriptions` accepte uniquement le corps JSON suivant, de 8 KiB
maximum, et un en-tête `Authorization: Bearer <secret>` :

```json
{
	"subscription_id": "f9cdb447-c46d-4a97-b4bc-0f7ad73466bd",
	"expo_token": "ExpoPushToken[…]",
	"platform": "ios",
	"timezone": "Europe/Paris"
}
```

Le `subscription_id` est un UUID, le token doit être un token Expo reconnu, `platform` vaut
`ios` ou `android` et le fuseau est validé par `Intl`. Le secret est une valeur base64url de
256 bits (43 caractères), générée et conservée uniquement par l'application. Le serveur le
hache avec SHA-256 et ne le renvoie ni ne le journalise. Les champs inconnus sont refusés.

Une création retourne `201`, un même abonnement avec le même secret et les mêmes valeurs
retourne `200`, et une création contradictoire retourne `409 conflict`. Dans les deux cas de
succès, la réponse ne contient que :

```json
{
	"subscription_id": "f9cdb447-c46d-4a97-b4bc-0f7ad73466bd",
	"enabled": true,
	"timezone": "Europe/Paris",
	"activated_local_date": "2026-09-26"
}
```

`PUT /mobile/v1/push/subscriptions/:subscription_id` demande le même bearer et le corps
strict `{expo_token, platform, timezone, enabled}`. Il retourne la même réponse 200 et
actualise la dernière activité. Une réactivation fixe `activated_local_date` à aujourd'hui dans
le fuseau alors connu, afin que le premier rappel ne puisse être éligible que le lendemain.
`PUT` sur un abonnement absent retourne `404`; un bearer absent ou incorrect pour un abonnement
existant retourne toujours `401 unauthorized` sans révéler de détail.

`DELETE /mobile/v1/push/subscriptions/:subscription_id` demande le bearer pour un abonnement
existant et retourne `204` sans corps. Il est idempotent lorsque l'abonnement n'existe déjà
plus. Un token associé à une autre inscription active désactive celle-ci avant d'activer la
nouvelle, sans exposer son identifiant. Le registre v1 `push-subscriptions.json` est sérialisé,
atomiquement écrit avec des droits réservés au process dans `MOBILE_STATE_DIR` : le contenu
temporaire et le répertoire sont synchronisés avant que l'opération soit confirmée. L'écriture
vérifie juste avant le remplacement que le fichier et son répertoire sont toujours ceux lus;
une création, disparition ou substitution concurrente est préservée, sans écrasement. Une
corruption, disparition ou substitution du registre rend seulement le push indisponible. Le
registre prend un verrou exclusif durable pendant chaque lecture ou écriture. Après un crash, un
verrou restant bloque volontairement le push jusqu'à intervention opérationnelle : il n'est jamais
supprimé automatiquement. `MOBILE_STATE_DIR` est `0700`, détenu par le process du service, et tout
écrivain légitime doit honorer ce verrou ; un acteur malveillant du même UID échappe aux garanties
des chemins POSIX et est hors du modèle de menace. Le registre accepte au plus 1 000 abonnements;
à saturation, seules les nouvelles
créations répondent `503 push_unavailable` tandis que réessai identique, mise à jour et
suppression restent possibles. La maintenance supprime les abonnements sans activité depuis
90 jours avant toute admission. Ce ticket n'envoie aucun push Expo.

## Générations publiques suivies

`POST /mobile/v1/generations` accepte un JSON strict de 8 KiB maximum. `request_id` et `mbid`
sont des UUID ; `type` vaut `artist`, `project`, `track`, `genre` ou `label`, `name` et
`disambiguator` sont trimés et bornés à 1–200 caractères, `slug` est canonique et du même type,
et `qid` suit `Q[1-9]\d*`. Les champs inconnus, `fresh` ou des identifiants contradictoires avec
une fiche existante sont refusés avec `400 invalid_request`.

Une demande qui doit réellement être matérialisée est durable avant le `202`, plate et suivable dans `Location:
/mobile/v1/generations/:request_id` :

```json
{
	"request_id": "f9cdb447-c46d-4a97-b4bc-0f7ad73466bd",
	"status": "queued",
	"created_at": "2026-09-27T00:00:00.000Z",
	"updated_at": "2026-09-27T00:00:00.000Z"
}
```

`GET /mobile/v1/generations/:request_id` retourne cette forme avec `running`, `succeeded`,
`failed` ou `interrupted`. Un succès porte toujours `node_id` (le slug canonique réellement
écrit) ; un échec terminal porte `{error:{code,message,retryable}}`. Une demande identique avec
le même `request_id` retourne le même suivi ; une entrée différente retourne
`409 idempotency_conflict`. Les travaux de même identité partagent une matérialisation. Deux
matérialisations et dix demandes en attente sont admises ; la saturation retourne `429 busy` et
`Retry-After: 30` sans écrire une nouvelle demande.

Avant le cache fast-path, le serveur vérifie durablement le couple `request_id` + requête : une
réutilisation avec une entrée différente retourne `409 idempotency_conflict`, même après un
redémarrage. Une fiche compatible déjà présente répond immédiatement `succeeded` avec son
`node_id` canonique ; son résultat d'idempotence est conservé 24 h dans un registre séparé, borné
à 2 048 entrées. Il ne crée pas de suivi, ne consomme aucune place de file ou de capacité de jobs
et n'appelle jamais le modèle. Cette réponse immédiate est un `200` sans `Location`; seul un
travail durable accepté répond `202` et peut ensuite être lu par
`GET /mobile/v1/generations/:request_id`. Lorsque ce registre dédié est plein, le serveur répond
`429 busy` avec `Retry-After: 30`, sans appeler un fournisseur.

Il n'y a aucune reprise automatique : au redémarrage, les travaux `pending` et `running`
deviennent `interrupted` (`retryable:false`). Crédits épuisés devient
`provider_quota_exhausted` (`retryable:false`), panne/délai devient `provider_unavailable`
(`retryable:true`) et le reste `internal_error` sans détail fournisseur. Une fiche déjà présente,
même ancienne, est réutilisée sans refresh ni appel modèle ; le refresh de la route web historique
reste inchangé. Chaque succès invalide l'index de recherche mobile.

## Contrats réservés, non implémentés

Les routes ci-dessous sont documentées pour permettre aux clients d'anticiper les
interfaces. Elles retournent actuellement `404 not_found` et ne déclenchent aucune
génération, écriture ou notification.

- `GET /mobile/v1/daily-recommendation` retournera une recommandation quotidienne
  stable pour l'identité locale ou authentifiée, avec sa provenance de catalogue.
- `PUT /mobile/v1/push-tokens/{token}` enregistrera ou renouvellera un token de push
  validé pour une identité utilisateur, afin de livrer la recommandation quotidienne.
- `POST /mobile/v1/events` recevra ultérieurement les événements produit validés par
  le plan de tracking, sans remplacer les SDK d'analytics du client.
