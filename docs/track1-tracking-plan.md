# Plan de tracking track1 — contrat v1

Ce document est le contrat de mesure de track1. Il précède toute instrumentation
et ne demande ni installation de SDK, ni configuration de compte. Les noms sont en
`snake_case` et sont ceux que les tickets de fonctionnalités doivent reprendre.

## Règles communes

### Enveloppe

Chaque événement émis après l'accord de mesure porte les champs obligatoires
suivants :

| Champ | Type / valeurs | Règle |
| --- | --- | --- |
| `event_id` | UUID | Stable pour une tentative logique. Il devient `messageId` dans Segment puis `insert_id` dans Amplitude. |
| `schema_version` | entier, valeur `1` | Version de ce contrat. |
| `platform` | `ios` \| `android` | Plateforme qui a émis l'événement. |
| `app_version` | chaîne | Version de l'application. |
| `build_number` | chaîne | Numéro de build, conservé comme chaîne pour garder sa valeur exacte. |
| `environment` | `development` \| `preview` \| `production` | Les sources internes restent séparées de la production. |
| `source` | `app` \| `onboarding` \| `settings` \| `home` \| `search` \| `relation` \| `notification` \| `deeplink` | Point d'entrée ou de déclenchement du parcours. |
| `occurred_at` | date-heure ISO 8601 UTC | Date d'occurrence, et non date de réception. |
| `anonymousId` | chaîne opaque aléatoire | Identifiant propre à la mesure, persistant après accord. Il n'est jamais dérivé des goûts. |

`userId` est absent. Les propriétés musicales sont publiques uniquement. Les
types de nœud autorisés sont `artist`, `project`, `track`, `genre` et `label`.
Les identifiants de nœuds, de sélection et de notification sont des chaînes
opaques publiques ; les UUID exigés ci-dessous respectent le format UUID.

### Consentement, provenance et attribution

- Aucun événement ni aucune file d'attente ne sont créés avant l'accord de
  mesure. Un refus ou un retrait n'empêche pas les parcours de l'application.
- Un accord tardif ne rattrape aucun historique : seuls les événements éligibles
  après l'accord peuvent être émis. Après retrait, aucun nouvel événement ni
  nouvelle file n'est créé.
- `anonymousId` est aléatoire, réservé à la mesure et conservé après l'accord ;
  aucun identifiant utilisateur n'est ajouté.
- `recommendation_id` et `notification_id` sont conservés dans le contexte du
  parcours issu de la carte ou de la notification. Quand ils sont connus, ils
  sont propagés à la fiche, aux relations et à l'ouverture d'écoute jusqu'au
  prochain départ indépendant depuis un onglet. Ce sont des attributs de
  contexte facultatifs des événements concernés, pas de nouveaux événements.
- Le prochain départ indépendant efface ce contexte. Une notification reçue
  sans action d'ouverture ne crée pas d'événement d'ouverture.

### Données interdites

Ne jamais envoyer ni mettre en file :

- liste de goûts ou profil musical personnel ;
- texte de recherche ;
- adresse email ;
- identifiant publicitaire ;
- token push ;
- secret d'abonnement ;
- erreur brute (seul le code d'erreur contrôlé prévu par le catalogue est permis).

### Réalisation native Segment

Le client iOS n'instancie Segment qu'après un accord `granted`. Il désactive la
collecte automatique du cycle de vie et la télémétrie du SDK ; `app_opened` est
produit par la transition SwiftUI réelle vers le premier plan. Chaque `event_id`
alimente le `messageId` Segment, tandis que l'identifiant anonyme est un UUID
propre à la mesure : aucun `userId`, IDFV ou IDFA n'est transmis. La file est en
mémoire et le retrait désactive le transport, la vide et efface cette identité
avant qu'un accord ultérieur puisse en créer une nouvelle.

## Catalogue des événements

Dans le tableau, les propriétés communes sont celles de l'enveloppe ci-dessus.
Les propriétés marquées « obligatoires » sont présentes dans l'émission valide ;
les propriétés facultatives ne sont présentes que lorsqu'elles sont connues.
Chaque exemple est un fragment spécifique ajouté à une enveloppe valide.

| # / événement | Déclencheur, déduplication et propriétaire | Propriétés spécifiques (type) | Exemple valide | Exemple rejeté | Test de recette |
| --- | --- | --- | --- | --- | --- |
| 1. `app_opened` | Premier affichage puis vraie transition `background` → `active` ; une seule émission par transition logique, jamais à chaque rerender. Propriétaire : P5.2. | Obligatoires : `source` (énumération commune). | `{"source":"home"}` | `{"source":"home","render_count":2}` — un rerender n'est pas une transition. | Ouvrir, rerender trois fois, passer en arrière-plan puis revenir : 2 transitions réelles donnent 2 événements, aucun pour les rerenders. |
| 2. `onboarding_started` | Première grille musicale visible pour un flux ; une fois par `flow_id`. Propriétaire : P3.1. | Obligatoire : `flow_id` (UUID). | `{"flow_id":"550e8400-e29b-41d4-a716-446655440000"}` | `{"flow_id":"not-a-uuid"}` — format invalide. | Afficher la grille, la masquer puis la réafficher dans le même flux : un seul événement. |
| 3. `onboarding_completed` | Genres validés et écrits ; une fois par flux, même après reprise. Propriétaire : P3.1. | Obligatoires : `flow_id` (UUID), `genres_count` (entier ≥ 0). | `{"flow_id":"550e8400-e29b-41d4-a716-446655440000","genres_count":3}` | `{"flow_id":"550e8400-e29b-41d4-a716-446655440000","genres_count":3.5}` — le compteur n'est pas entier. | Valider et écrire les genres, redémarrer puis revoir le succès : un seul événement pour le flux. |
| 4. `preferences_updated` | Modification ou effacement validé ; chaque opération logique validée une fois. Propriétaire : P3.1. | Obligatoires : `genres_count` (entier ≥ 0), `action` (`updated` \| `cleared`). | `{"genres_count":0,"action":"cleared"}` | `{"genres_count":0,"action":"deleted"}` — action hors contrat. | Enregistrer une modification puis un effacement : deux événements valides ; annuler avant validation : aucun événement. |
| 5. `daily_recommendation_viewed` | Carte réellement affichée ; une fois par sélection quotidienne persistée, pas par rerender. Propriétaire : P3.3. | Obligatoires : `recommendation_id` (chaîne), `local_date` (YYYY-MM-DD), `node_id` (chaîne), `node_type` (type de nœud). | `{"recommendation_id":"rec-2026-09-26","local_date":"2026-09-26","node_id":"artist-42","node_type":"artist"}` | `{"recommendation_id":"rec-2026-09-26","local_date":"26/09/2026","node_id":"artist-42","node_type":"artist"}` — date locale mal formée. | Afficher la sélection persistée, rerender et redémarrer : un événement pour cette sélection ; une nouvelle sélection persistée en donne un autre. |
| 6. `daily_recommendation_opened` | Appui « Découvrir » ; une fois par geste logique. Propriétaire : P3.3. | Obligatoires : `recommendation_id` (chaîne), `local_date` (YYYY-MM-DD), `node_id` (chaîne), `node_type` (type de nœud). | `{"recommendation_id":"rec-2026-09-26","local_date":"2026-09-26","node_id":"artist-42","node_type":"artist"}` | `{"recommendation_id":"rec-2026-09-26","local_date":"2026-09-26","node_id":"artist-42"}` — `node_type` manque. | Un appui donne un événement ; le double callback UI du même appui n'en donne pas un second. |
| 7. `notification_permission_result` | Résultat de la demande faite à l'utilisateur ; aucun token. Propriétaire : P3.8. | Obligatoire : `status` (`granted` \| `denied` \| `undetermined`). | `{"status":"denied"}` | `{"status":"denied","push_token":"secret"}` — token interdit. | Après accord de mesure, refuser la permission push : un événement `denied` sans token ; avant accord de mesure : zéro événement. |
| 8. `notification_opened` | Action d'ouverture d'une notification ; une fois par notification, jamais à la réception. Propriétaire : P3.8. | Obligatoires : `notification_id` (chaîne), `target_local_date` (YYYY-MM-DD). | `{"notification_id":"push-42","target_local_date":"2026-09-26"}` | `{"notification_id":"push-42","target_local_date":"2026-09-26","received":true}` — la réception n'est pas une ouverture. | Recevoir puis ouvrir une fois : une ouverture ; recevoir sans ouvrir : zéro ; double callback d'ouverture : une seule. |
| 9. `node_viewed` | Fiche chargée et visible ; une fois par entrée de navigation. Propriétaire : P3.2. | Obligatoires : `node_id` (chaîne), `node_type` (type de nœud), `source` (énumération commune). Facultatifs : `recommendation_id`, `notification_id` (chaînes de contexte). | `{"node_id":"artist-42","node_type":"artist","source":"notification","notification_id":"push-42"}` | `{"node_id":"artist-42","node_type":"artist","source":"notification","email":"a@b.example"}` — donnée interdite. | Entrer deux fois dans la fiche : deux entrées ; rerender dans la même entrée : aucune émission supplémentaire ; le contexte de notification est conservé. |
| 10. `relation_opened` | Appui sur une relation ; une fois par appui logique. Propriétaire : P3.2. | Obligatoires : `from_node_id` (chaîne), `node_id` (chaîne), `node_type` (type de nœud), `relation_kind` (chaîne). Facultatifs : `recommendation_id`, `notification_id` (chaînes de contexte). | `{"from_node_id":"artist-42","node_id":"track-7","node_type":"track","relation_kind":"appears_on","recommendation_id":"rec-2026-09-26"}` | `{"from_node_id":"artist-42","node_id":"track-7","node_type":"track"}` — `relation_kind` manque. | Appuyer deux fois produit deux gestes ; un rerender ou un callback répété pour le même geste ne duplique pas l'événement logique. |
| 11. `search_submitted` | Recherche admissible effectivement déclenchée, après temporisation appliquée ; une fois par recherche appliquée, sans texte. Propriétaire : P4.3. | Obligatoire : `filter` (`all` \| `artist` \| `project` \| `track` \| `genre` \| `label`). | `{"filter":"artist"}` | `{"filter":"artist","query":"texte saisi"}` — texte de recherche interdit. | Saisir puis laisser appliquer une recherche : un événement ; chaque nouvelle recherche temporisée appliquée en donne un ; la valeur saisie n'est jamais envoyée. |
| 12. `search_result_opened` | Résultat sélectionné ; disponibilité indiquée au moment de l'ouverture. Propriétaire : P4.3. | Obligatoires : `node_type` (type de nœud), `availability` (`cached` \| `missing`), `results_count` (entier ≥ 0). Facultatif : `node_id` (chaîne si connu). | `{"node_type":"track","availability":"missing","results_count":1}` | `{"node_type":"track","availability":"cached","results_count":1,"query":"texte saisi"}` — texte interdit. | Sélectionner un résultat connu puis un résultat sans identifiant : deux événements, avec `node_id` seulement pour le premier ; aucun texte n'est conservé. |
| 13. `generation_requested` | Action explicite ; `request_id` durable avant le POST ; une fois par demande logique. Propriétaire : P4.4. | Obligatoires : `request_id` (UUID), `node_type` (type de nœud). | `{"request_id":"550e8400-e29b-41d4-a716-446655440000","node_type":"artist"}` | `{"node_type":"artist"}` — demande sans identifiant durable. | Appuyer une fois crée et persiste `request_id` avant le POST : un événement ; double callback ne crée pas une deuxième demande logique. |
| 14. `generation_completed` | État réussi observé ; une fois par demande, y compris après reprise. Propriétaire : P4.4. | Obligatoires : `request_id` (UUID), `node_id` (chaîne), `node_type` (type de nœud). | `{"request_id":"550e8400-e29b-41d4-a716-446655440000","node_id":"artist-42","node_type":"artist"}` | `{"request_id":"550e8400-e29b-41d4-a716-446655440000","node_type":"artist"}` — nœud produit absent. | Redémarrer pendant la génération puis observer le succès : un seul succès pour le `request_id`, sans nouvelle demande. |
| 15. `generation_failed` | État échoué, interrompu ou expiré observé ; une fois par demande terminale. Une déconnexion de suivi seule n'est pas terminale. Propriétaire : P4.4. | Obligatoires : `request_id` (UUID), `node_type` (type de nœud), `error_code` (`failed` \| `interrupted` \| `expired`). | `{"request_id":"550e8400-e29b-41d4-a716-446655440000","node_type":"artist","error_code":"interrupted"}` | `{"request_id":"550e8400-e29b-41d4-a716-446655440000","node_type":"artist","error":"POST stack trace"}` — erreur brute interdite. | Annuler : `generation_requested` reste à 1 et aucun échec tant qu'aucun état terminal échoué n'est observé ; si l'état terminal est observé, un seul échec avec le code contrôlé correspondant. |
| 16. `external_listening_opened` | Ouverture OS résolue ; ce n'est pas une confirmation de lecture audio. Propriétaire : P3.4. | Obligatoires : `node_id` (chaîne), `node_type` (type de nœud), `provider` (`spotify` \| `apple_music`), `link_kind` (`exact` \| `search`). Facultatifs : `recommendation_id`, `notification_id` (chaînes de contexte). | `{"node_id":"track-7","node_type":"track","provider":"spotify","link_kind":"exact","recommendation_id":"rec-2026-09-26"}` | `{"node_id":"track-7","node_type":"track","provider":"spotify","link_kind":"exact","audio_played":true}` — lecture audio non mesurée. | Après un lien sûr résolu par l'OS, un événement d'ouverture ; aucune conclusion de lecture audio. Le contexte de carte ou de notification est propagé s'il existe. |
| 17. `external_listening_failed` | Ouverture refusée ou échouée ; une fois par tentative d'ouverture terminale. Propriétaire : P3.4. | Obligatoires : `node_id` (chaîne), `node_type` (type de nœud), `provider` (`spotify` \| `apple_music`), `link_kind` (`exact` \| `search`), `error_code` (`unsafe_url` \| `open_failed`). Facultatifs : `recommendation_id`, `notification_id` (chaînes de contexte). | `{"node_id":"track-7","node_type":"track","provider":"apple_music","link_kind":"search","error_code":"open_failed"}` | `{"node_id":"track-7","node_type":"track","provider":"spotify","link_kind":"exact","error_code":"network_timeout"}` — code hors catalogue. | Une URL refusée produit un échec `unsafe_url` ; une ouverture OS échouée produit `open_failed` ; un rerender ou callback répété ne duplique pas la tentative logique. |

## Déduplication et reprises

- `event_id` est créé une seule fois par tentative logique et réutilisé pour
  cette tentative. Les rerenders, callbacks doublés et répétitions de traitement
  d'un même état ne créent pas de nouvel événement.
- Une entrée de navigation réelle, un geste distinct ou une transition réelle
  reste mesurable selon le déclencheur de sa ligne. La répétition visuelle sans
  nouvelle entrée, geste ou transition n'est pas une nouvelle occurrence.
- Les identifiants durables `flow_id`, `request_id`, `recommendation_id` et
  `notification_id` sont restaurés après redémarrage. Une reprise de génération
  rapporte son état terminal avec le même `request_id`, sans recommencer la
  demande ; un suivi momentanément déconnecté n'est pas classé en échec.
- Une notification peut être reçue plusieurs fois côté OS, mais seule l'action
  d'ouverture est mesurée ; le double callback de cette action reste une seule
  tentative logique pour le même `notification_id`.
- Une source interne de développement ou de prévisualisation ne se mélange pas
  aux vues de production.

## Indicateurs contractuels

Les six indicateurs ci-dessous sont calculés sur la période de rapport choisie,
avec bornes explicites en UTC. Les événements invalides, les doublons d'une même
tentative logique et les données sans identifiant requis sont exclus. Les vues
peuvent être ventilées par `platform` (`ios` / `android`) et par production,
sans créer un indicateur supplémentaire.

| # / indicateur | Numérateur | Dénominateur | Période | Population | Exclusions et interprétation |
| --- | --- | --- | --- | --- | --- |
| 1. Complétion des flux d'onboarding | Nombre de `flow_id` distincts ayant `onboarding_completed`. | Nombre de `flow_id` distincts ayant `onboarding_started`. | Période de rapport en UTC, événements de la même période. | Émissions consenties de production avec `flow_id` valide. | Exclure les flux sans début, sans identifiant, pré-consentement, invalides ou doublonnés. Le résultat mesure des flux complétés parmi les flux commencés. |
| 2. Ouverture des sélections quotidiennes | Nombre de `recommendation_id` distincts ayant `daily_recommendation_opened`. | Nombre de `recommendation_id` distincts ayant `daily_recommendation_viewed`. | Période de rapport en UTC. | Sélections quotidiennes consenties et persistées en production. | Exclure les sélections sans identifiant, non vues, invalides ou doublonnées. Un appui mesuré est une ouverture de parcours, pas une écoute audio. |
| 3. Ouverture d'écoute attribuée aux sélections vues | Nombre de `recommendation_id` distincts vus et associés à un `external_listening_opened`. | Nombre de `recommendation_id` distincts ayant `daily_recommendation_viewed`. | Période de rapport en UTC, avec l'attribution conservée jusqu'au départ indépendant. | Sélections vues par des appareils consentants en production. | Exclure les sélections sans identifiant, sans contexte attribuable, invalides ou doublonnées. Le numérateur mesure une ouverture OS attribuée ; il ne mesure pas un taux d'écoute audio. |
| 4. Retour à D+1 et D+7 | Pour chaque échéance, nombre d'`anonymousId` distincts de la cohorte qui ont un `app_opened` exactement à D+1 ou exactement à D+7 en UTC. | Pour chaque échéance, nombre d'`anonymousId` distincts dont le premier `app_opened` mesuré est à D et dont l'échéance est devenue observable. | Cohortes par jour UTC D ; fenêtres D+1 et D+7. | Appareils consentis de production dont le premier `app_opened` mesuré est observé à D. | Exclure les cohortes dont la fenêtre n'est pas encore observable, les identifiants absents/invalides, le pré-consentement, les doublons et les sources internes. Il n'y a pas de durée de session. |
| 5. Chemin depuis une notification ouverte | Deux comptes rapportés pour le même dénominateur : `notification_id` distincts attribués à un `node_viewed`, puis `notification_id` distincts attribués à un `external_listening_opened`. | Nombre de `notification_id` distincts ayant `notification_opened`. | Période de rapport en UTC, attribution jusqu'au prochain départ indépendant. | Notifications ouvertes après accord sur des appareils de production. | Exclure la réception sans ouverture, les notifications sans identifiant, les chemins sans attribution, invalides ou doublonnés. Une ouverture push n'est ni une réception ni une écoute confirmée. |
| 6. États de génération rapportés aux demandes | Trois comptes distincts : `request_id` avec `generation_completed`, `request_id` avec `generation_failed`, et `request_id` encore en cours sans état terminal. | Nombre de `request_id` distincts ayant `generation_requested` dans la population mesurée. | Période de rapport en UTC ; les états observés après reprise sont rattachés à la demande d'origine. | Demandes explicites consenties de production avec `request_id` durable. | Exclure les demandes sans événement de demande, identifiant manquant, doublons, invalides et simples déconnexions de suivi. Les états en cours restent distincts et ne sont pas transformés en échec. |

## Jeux de recette exacts

Ces jeux sont rejouables sur papier ou dans un test local sans réseau, compte ou
 SDK. Dans chaque cas, la mesure est déjà acceptée sauf indication contraire ;
les enveloppes communes sont valides.

### Flux nominal P5.2 / P5.4

1. Commencer un flux et afficher sa première grille : `onboarding_started = 1`.
2. Valider et écrire les genres : `onboarding_completed = 1`.
3. Afficher une sélection quotidienne persistée :
   `daily_recommendation_viewed = 1`.
4. Appuyer sur « Découvrir » : `daily_recommendation_opened = 1`.
5. Résoudre l'ouverture OS du service : `external_listening_opened = 1`.
6. Le même `flow_id` et le même `recommendation_id` sont conservés dans le
   parcours ; aucun token, goût ou texte n'est présent.

### Annulation et reprise de génération

1. Déclencher une demande explicite : `generation_requested = 1`, avec un
   `request_id` durable écrit avant le POST.
2. Annuler avant qu'un état terminal échoué ne soit observé : aucun
   `generation_completed` et aucun `generation_failed` supplémentaire.
3. Redémarrer, reprendre le suivi et observer un succès : un seul
   `generation_completed` pour le même `request_id`.
4. Si l'état terminal observé est interrompu ou expiré, produire un seul
   `generation_failed` avec le code contrôlé correspondant ; une déconnexion de
   suivi seule ne produit aucun échec.

### Double callback et navigation répétée

1. Recevoir une notification sans action : zéro `notification_opened`.
2. Ouvrir cette notification : un `notification_opened`.
3. Rejouer le callback d'ouverture avec le même `notification_id` : zéro
   événement supplémentaire.
4. Entrer une première fois dans la fiche, rerender, puis entrer à nouveau : une
   occurrence par entrée de navigation réelle, aucune pour le rerender.
5. Appuyer sur une relation une fois, puis recevoir le même callback deux fois :
   un seul événement pour le geste logique.

### Refus, retrait et accord tardif

1. Avant l'accord de mesure, refuser : zéro événement et zéro file d'attente ;
   le parcours local continue.
2. Accorder plus tard : aucun historique n'est rattrapé ; le prochain geste
   éligible est le premier événement possible.
3. Retirer ensuite l'accord : zéro nouvel événement et zéro nouvelle file ; le
   parcours reste utilisable.
4. Si l'accord de mesure existait déjà et que l'utilisateur refuse la permission
   push, produire `notification_permission_result` avec `status = denied`, sans
   token push. Ce refus de permission push ne révoque pas l'accord de mesure.

## Vérification documentaire reproductible

Depuis la racine du dépôt, compter les lignes numérotées du catalogue et leurs
noms uniques :

```sh
doc=docs/track1-tracking-plan.md
test "$(awk -F'|' '/^\| [0-9]+\. `/{gsub(/`/, "", $2); print $2}' "$doc" | sort -u | wc -l | tr -d ' ')" -eq 17
```

Puis contrôler, pour chaque ligne du catalogue, que les propriétés de l'exemple
valide sont dans l'enveloppe ou dans la colonne « propriétés spécifiques », que
les propriétés de l'exemple rejeté sont absentes de la colonne valide, et que la
liste « Données interdites » reste inchangée. Rejouer ensuite les quatre jeux de
recette ci-dessus : nominal `1/1/1/1/1`, annulation sans état terminal, double
callback, et refus avant accord avec `0` événement. Ce contrôle est documentaire
et n'appelle aucun réseau ni compte.
