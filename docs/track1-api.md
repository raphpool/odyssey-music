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
	"taxonomy": {
		"mode": "editorial",
		"version": 2,
		"families": [
			{ "key": "electronic", "label": "Electronic", "order": 4 },
			{ "key": "rock", "label": "Rock", "order": 9, "slug": "genre:rock" }
		],
		"genres": [
			{
				"id": "Q1001",
				"name": "Drill and Bass",
				"family": "electronic",
				"slugs": ["genre:drill-and-bass", "genre:drill-n-bass"]
			},
			{ "id": "Q1002", "name": "Prog Rock", "family": "rock", "slugs": ["genre:progressive-rock"] }
		],
		"legacySelectionBySlug": {
			"genre:drill-and-bass": ["Q1001"],
			"genre:rock": ["Q1002"]
		}
	},
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

Le catalogue ne contient ni `article`, ni citations, ni URL tierce.
`revision` est le SHA-256 du contenu canonique, trié et sans horodatage volatil.

La réponse 200 porte `ETag: "sha256-…"` et `Cache-Control: public, max-age=60,
stale-while-revalidate=30`. Le client envoie cette valeur dans `If-None-Match`; à
contenu inchangé, le serveur répond `304` sans corps. Les routes mobile ne changent pas
le comportement des anciennes routes du serveur.

### Taxonomie

`taxonomy` est une union discriminée sur `mode`. L'exemple ci-dessus montre le mode
`editorial` ; les identifiants de genre (`Q1001`, `Q1002`) y sont illustratifs.

```
taxonomy:
  | { "mode": "degraded", "available": false }
  | { "mode": "editorial", "version": 2,
      "families": [{ "key", "label", "order", "slug"? }],
      "genres": [{ "id", "name", "family", "slugs": [...] }],
      "legacySelectionBySlug": { "<slug>": ["<id de genre>", …] } }
```

- **`degraded`** : les données de taxonomie ne sont pas disponibles, sans empêcher
  l'exploration des nœuds. `degraded` implique désormais `available: false`. Le serveur
  répond aussi `degraded` quand il n'a pas de taxonomie pour le graphe servi, et quand la
  taxonomie qu'il porte est invalide : la taxonomie est alors dégradée en entier, jamais
  tronquée. Les cas d'invalidité sont : version autre que 2, champ manquant ou mal typé,
  `order` non entier, entrée de `genres[].slugs` ou `families[].slug` (quand il est présent)
  qui n'est pas une identité `genre:*` valide, valeur de `legacySelectionBySlug` qui n'est
  pas un tableau de chaînes. Une famille ou un genre invalide n'est jamais retiré seul de
  sa liste : il dégrade toute la taxonomie.
- **Exception, clés de `legacySelectionBySlug`** : la règle de dégradation totale ne vaut
  pas pour les clés de cette table. Ces clés sont un canal de remédiation pour d'anciens
  slugs (lisibles mais pas toujours canoniques, par exemple `genre:r&b`). Une clé qui n'est
  pas une identité `genre:*` valide ne peut pas être une identité mobile : elle est omise
  de la table émise, sans dégrader la taxonomie ni les autres clés. Seules les clés sont
  écartées ; la valeur d'une clé retenue reste stricte (tableau de chaînes, sinon
  dégradation en entier).
- **Trace d'un rejet** : une taxonomie absente dégrade silencieusement (graphe ancien).
  Une taxonomie présente mais rejetée émet un log `warn` « mobile taxonomy rejected,
  serving degraded mode » avec un seul champ `reason`, au vocabulaire fixe :
  `not_an_object`, `unsupported_version`, `invalid_families`, `invalid_genres`,
  `invalid_legacy_selection`. La raison ne porte jamais de donnée du graphe, qui est non
  fiable. L'omission d'une clé de table non canonique ne produit pas de trace.
- **`editorial`** : la taxonomie éditoriale publiée. `families` porte les familles
  (`key`, `label`, `order` fini, `slug` facultatif : toutes les familles ne sont pas un
  nœud du graphe). `genres` porte les genres publiés (`id`, `name` éditorial, `family` =
  `key` d'une famille, `slugs` = identités `genre:*`, plusieurs possibles).
  `legacySelectionBySlug` associe une identité `genre:*` à des identifiants de genre, pour
  migrer une sélection de slugs. Le `qid` Wikidata n'est jamais transmis, ni aucun champ
  non listé ici.
- L'ordre de `families` et de `genres` est celui de la projection serveur.
- La taxonomie n'est pas filtrée par `identities` (ce paramètre ne concerne que `nodes` et
  `edges`) et elle est couverte par `revision` : l'`ETag` change quand elle change.
- Un client doit traiter tout `mode` inconnu comme `degraded`. Le client iOS décode
  ainsi : un `mode` inconnu ou un payload `editorial` malformé donne `degraded`
  (`available: false`) sans faire échouer le catalogue ; un `mode` absent reste une
  erreur de contrat.

## Contenu localisé d'une fiche (TRA-810)

`GET /mobile/v1/nodes/:id` sert la fiche en anglais. Quand une traduction française est
**courante**, la réponse porte en plus un champ additif `node.l10n.fr` :

```json
{
	"node": {
		"teaser": "…",
		"article": "…",
		"facts": { "origin": "Detroit" },
		"l10n": {
			"fr": { "teaser": "…", "article": "…", "facts": { "origin": "Détroit" } }
		}
	},
	"source": "cache"
}
```

- `teaser`, `article` et `facts` de premier niveau restent **l'anglais**, et `version` reste
  `v1`. Aucune route n'accepte de paramètre de langue : le client choisit.
- **Présence** : `l10n.fr` est présent si et seulement si la traduction stockée a été faite
  à partir du texte anglais actuel de la fiche. Si l'article, le teaser ou un fait traduisible
  anglais a changé depuis, la clé `l10n` est **absente** (jamais `null`, jamais `{}`).
- `facts` ne porte que les clés traduisibles du type de la fiche qui existent aussi dans les
  `facts` anglais ; sans aucune clé, `facts` est omis.
- `source_sha256`, `model` et `translated_at` ne sortent jamais.
- Une fiche lue par redirection (`redirected_from`) porte son `l10n.fr` comme les autres.
- Le catalogue ne change pas : `l10n` n'entre pas dans `revision`.

Règle de repli côté client : afficher le français seulement si la langue de l'appareil est le
français **et** que `l10n.fr` a un `teaser` et un `article` non vides ; sinon, afficher l'anglais
du premier niveau. Un fait absent de `l10n.fr.facts` s'affiche en anglais. Un client qui ignore
`l10n` reste correct.

## Recherche : hits de projet et de morceau (TRA-547)

`GET /mobile/v1/search` renvoie `{q,hits,sources}`. Un hit `project` ou `track` porte, en plus de
`subtitle`, l'**artiste principal** du crédit :

| Champ | Type | Sens |
| --- | --- | --- |
| `subtitle` | string, optionnel | Crédit joint, séparateur « , » (« Sasha, John Digweed »). Affichage seul : ne jamais le découper. |
| `artist` | string, optionnel | Premier artiste crédité, lu dans le crédit structuré de MusicBrainz (« Earth, Wind & Fire » reste un seul artiste). Absent si la source ne donne aucun crédit exploitable, et toujours absent des hits `artist`, `genre` et `label`. |
| `artist_slug` | slug `artist:…` canonique, optionnel | Fiche de cet artiste quand elle est déjà dans le cache. Absent sinon : ne jamais l'inventer. |

Le client qui lance une génération pour un `project` ou un `track` envoie `artist` (jamais `subtitle`) comme
contexte artiste (TRA-477) ; sans `artist`, il n'en envoie pas. `artist_slug` sert à ouvrir la fiche de
l'artiste, pas à construire un slug d'œuvre.

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
90 jours avant toute admission.

## Abonnements APNs anonymes

`POST /mobile/v1/push/apns/subscriptions` enregistre un token APNs du client iOS natif, dans un
JSON strict de 8 KiB maximum avec `Authorization: Bearer <secret>` :

```json
{
	"subscription_id": "f9cdb447-c46d-4a97-b4bc-0f7ad73466bd",
	"device_token": "a1b2c3d4",
	"app_variant": "preview",
	"apns_environment": "sandbox",
	"timezone": "Europe/Paris"
}
```

`subscription_id` est un UUID; `device_token` est hexadécimal, pair, long de 2 à 512 caractères,
normalisé en minuscules. `app_variant` vaut `preview` ou `production`, `apns_environment` vaut
`sandbox` ou `production`; seules `preview/sandbox`, `preview/production` et
`production/production` sont admises. Le fuseau est validé par `Intl`, les champs inconnus sont
refusés, et le secret base64url de 256 bits est haché SHA-256 sans être retourné ou journalisé.

La création retourne `201`, ou `200` pour la même demande et le même secret; une identité
contradictoire retourne `409 conflict`. La réponse contient seulement `subscription_id`, `enabled`,
`timezone` et `activated_local_date`. `PUT /mobile/v1/push/apns/subscriptions/:subscription_id`
accepte strictement `{device_token, app_variant, apns_environment, timezone, enabled}` : `200`,
`404` absent, `401` bearer absent ou incorrect. `DELETE` retourne `204` sans corps et est
idempotent; un mauvais bearer ne donne `401` que pour un abonnement existant.

Le même token désactive seulement l'ancienne inscription de la même paire variante/environnement,
sans révéler son identifiant. Le registre séparé `push-apns-subscriptions.json` possède son propre
verrou et les mêmes écritures atomiques/préservation en cas de corruption que l'Expo; il ne contient
ni goûts, ni analytics, ni état d'envoi. L'absence de credentials APNs ne dégrade ni les lectures
musicales ni les routes Expo.

## Envoi et suivi Expo des rappels

L'envoi est une opération interne du serveur : aucune route mobile ne permet de déclencher,
lister ou relancer un envoi. Le scheduler réserve durablement une notification avant tout appel
réseau. Une réservation contient une date locale et un UUID de notification, mais pas de goût ni
de recommandation. Sans réservation, le transport n'envoie rien.

Le serveur appelle seulement `https://exp.host/--/api/v2/push/send`, par groupes d'au plus 100
messages et avec une seule requête en vol. Chaque message contient le titre « track1 — Ta
découverte du jour », un texte fixe, le canal Android `daily`, le son par défaut et les seules
données `{kind, notification_id, target_local_date, url}` attendues par l'application. Le secret
facultatif `EXPO_ACCESS_TOKEN` est chargé côté serveur : il n'est ni renvoyé, ni journalisé, ni
fourni dans la configuration publique. Un délai de 15 secondes, une erreur réseau, une réponse
invalide, un 429 ou un 5xx rendent la tentative `unknown`; cette date n'est alors jamais renvoyée
automatiquement. Un accusé `accepted` conserve uniquement le ticket Expo nécessaire au suivi;
un rejet immédiat est distinct.

Après 15 minutes, le serveur consulte uniquement `https://exp.host/--/api/v2/push/getReceipts`,
par groupes d'au plus 100 tickets et sans polling concurrent. Un receipt `ok` indique l'acceptation
par APNs ou FCM, pas l'affichage ni la lecture par la personne. Un receipt absent après 24 heures
devient `receipt_unknown`, séparé des erreurs de receipt. `DeviceNotRegistered` désactive le token
seulement si l'abonnement porte toujours le même token que celui de l'envoi : un token renouvelé
reste actif. Les tentatives, tickets et receipts sont stockés atomiquement, purgés après 24 heures
et bornés; les journaux techniques n'incluent jamais de token ou de secret.

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

## Preuves de déploiement P2.7

La recette de déploiement utilise uniquement une révision déjà approuvée et fusionnée dans `main`.
Elle n'utilise jamais un worktree de ticket, ni `--dirty`, ni `--allow-non-main`. `MOBILE_STATE_DIR`
doit rester `/var/lib/track1-mobile` avec les droits du service : le script de déploiement exclut
ce répertoire de la synchronisation de source afin que les demandes soient conservées entre deux
déploiements ou redémarrages.

Après chaque déploiement, exécuter le smoke non destructif suivant depuis la révision effectivement
déployée. `MOBILE_SMOKE_IDENTITY` est obligatoire et doit désigner un genre canonique existant,
choisi avant la recette. `MOBILE_EXPECTED_SHA` est obligatoire et correspond au SHA complet de la
révision déployée. Le script refuse toute URL qui n’est pas le nom DNS HTTPS de l’origine configurée (les
adresses IPv4/IPv6 littérales sont toujours refusées), toute identité non-genre et tout SHA qui ne
correspond pas exactement à `/version`. Cette règle évite de prétendre maintenir localement une
classification exhaustive et instable des plages d’adresses IANA.

```bash
MOBILE_API_URL=https://dropcliffs.com/api/odyssey/mobile/v1 \
MOBILE_SMOKE_IDENTITY=genre:ambient \
MOBILE_EXPECTED_SHA=<sha-main-deploye-sur-40-caracteres> \
bash scripts/verify-e2e.sh --mobile-smoke
```

Le smoke vérifie l’origine DNS HTTPS, catalogue `200` puis `304` avec son ETag, recherche, lecture de fiche,
et `/version`, avec un timeout de connexion de 5 s et un timeout total de 15 s par appel
(surchargeables par les variables `MOBILE_CONNECT_TIMEOUT_SECONDS` et
`MOBILE_REQUEST_TIMEOUT_SECONDS`). Il ne lance pas le crawler historique, ne crée pas de fiche et
ne déclenche aucun appel fournisseur payant. Il ne vérifie volontairement ni image ni liens en
production : même une fiche de genre peut évoluer et faire de cette lecture une frontière de
résolution ou une écriture de sidecar. La couverture media complète reste le test d'intégration
hors réseau qui contrôle ces frontières. Pour la génération et le redémarrage, la preuve de
comportement reste également le test d'intégration local qui simule uniquement le fournisseur ;
une recette publique ne crée une fiche manquante que si elle a été explicitement choisie et
budgétée avant son exécution.

La table suivante est à remplir avec des résultats réellement observés ; elle ne constitue pas une
attestation avant exécution.

| Déploiement | Date UTC | SHA de `/version` | Catalogue/ETag | Lecture/recherche | État registre après redémarrage | Résultat |
| --- | --- | --- | --- | --- | --- | --- |
| Non exécuté dans TRA-297 | — | — | — | — | — | Préparation locale uniquement |

Le SHA retourné par `https://dropcliffs.com/api/odyssey/version` doit être exactement
`MOBILE_EXPECTED_SHA`. Pour attester un redémarrage, créer auparavant une demande explicitement
budgétée, relever son UUID pendant qu'elle est `pending` ou `running`, puis redémarrer. Rejouer le
smoke avec l'UUID observé :

```bash
MOBILE_SMOKE_INTERRUPTED_GENERATION_ID=<uuid-observe-avant-redemarrage> \
MOBILE_API_URL=https://dropcliffs.com/api/odyssey/mobile/v1 \
MOBILE_SMOKE_IDENTITY=genre:ambient \
MOBILE_EXPECTED_SHA=<sha-main-deploye-sur-40-caracteres> \
bash scripts/verify-e2e.sh --mobile-smoke
```

Le smoke lit alors uniquement `GET /mobile/v1/generations/:request_id` et exige le même UUID,
`status: "interrupted"` et `error.retryable: false`. Cette observation prouve que le registre est
lisible après redémarrage et qu'aucun travail actif n'a été repris automatiquement ; elle ne crée
ni ne relance une génération. Consigner cette valeur après chacun des deux déploiements ou
redémarrages. Une différence est un blocage à corriger dans le ticket propriétaire, pas une
correction silencieuse de cette recette.

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
