# Track1 — pochettes fiables pour les œuvres recommandées

Plan de la phase `plan` du process de livraison, écrit le 2026-11-21 sur le brief de Raphael (21/11) et sa
mise à jour du même jour (TRA-794). **En attente de validation** : aucun ticket Linear n'est créé, les
identifiants sont des `TRA-?`.

Tous les chemins sont relatifs à la racine du dépôt ; les numéros de ligne et les mesures sont ceux de
`origin/main` au 2026-11-21 (`c2058c97`). Les mesures de couverture ont été faites hors ligne sur
`cache/nodes/` ; aucune source tierce n'a été interrogée (voir R2).

**Rapport avec TRA-794.** TRA-794 « Ne recommander que des œuvres avec pochette » est le palliatif
immédiat, décidé par Raphael et implémenté hors de ce plan : le client vérifie le `/image` de l'œuvre
tirée (état `found`), saute une œuvre sans pochette (10 vérifications au plus par chargement), et le hero
demande le `/image` d'un projet ou d'une track sans `image_url`. Ce plan est la correction durable qui le
remplace : la base est comblée en amont, le catalogue dit lui-même quelle œuvre a une image, et la
vérification cliente est retirée (tâche 3.3). TRA-794 n'est pas replanifiée ici.

## Problème

1. **L'œuvre du jour peut ne pas avoir de pochette.** Sur la première build TestFlight, « Night » (Benga
   & Coki) s'affichait avec l'image de remplacement. Le tirage se fait sur l'iPhone
   (`ios/Track1Core/Sources/Track1Core/Recommendation/Affinity.swift:58-129`, `DailyRecommendation.swift:112-122`)
   à partir du catalogue, et `MobileCatalogNode` (`src/mobile/contracts.ts:8-13`) ne porte que `identity`,
   `type`, `name`, `teaser` : le client tire sans savoir quelle œuvre a une image.
2. **Un tiers des œuvres n'a pas d'`image_url`.** Dans le cache committé :

   | Type | Nœuds | Avec `image_url` | Sans |
   | --- | --- | --- | --- |
   | project | 292 | 186 (173 `caa`, 13 `itunes-verified`) | 106 |
   | track | 239 | 152 (121 `caa`, 31 `itunes-verified`) | 87 |
   | artist | 578 | 387 | 191 |
   | label | 175 | 82 | 93 |
   | genre | 316 | 42 | 274 |

3. **Ce qui manque est structurel, pas un oubli de lot.** Le lot d'images du 18/10
   (`scripts/migrations/2026-10-18-backfill-images.ts`, TRA-489) a déjà passé l'échelle du résolveur sur
   tout le cache. Les 193 œuvres restantes sont celles que l'échelle actuelle ne sait pas traiter :

   | Œuvres sans image | Nombre | Pourquoi l'échelle échoue aujourd'hui |
   | --- | --- | --- |
   | Projets crédités, sans MBID | 41 | pas de MBID donc pas de Cover Art Archive ; le lot n'active pas l'échelon MusicBrainz (`viaMusicBrainz`, réservé à la file) ; iTunes vérifié n'a pas tranché |
   | Projets crédités, avec MBID | 22 | la Cover Art Archive n'a pas de face avant et iTunes vérifié n'a pas tranché |
   | Projets sans crédit (`artists: []`) | 43 | sans artiste, ni MusicBrainz ni iTunes ne peuvent vérifier l'identité |
   | Tracks créditées dont le projet nommé n'a pas de nœud | 34 | l'échelle `track` (`src/images/resolve-image.ts:289-314`) n'a pas d'échelon MusicBrainz : image du projet, CAA par MBID du projet, iTunes |
   | Tracks créditées sans projet | 25 | idem |
   | Tracks créditées dont le projet est en cache sans image | 12 | suivent le sort de leur projet |
   | Tracks sans crédit | 16 | comme les projets sans crédit |

   « Night » est `track:night--dubstep-track-by-benga-and-coki` : `artists: []`, et son projet
   `project:diary-of-an-afro-warrior` n'a pas de nœud. Aucun échelon ne peut s'exécuter.
   Borne haute du gain automatique : 41 + 34 + 25 + 12 = 112 œuvres. Plancher du résidu : 22 + 43 + 16
   = 81 œuvres. **Le lot seul ne peut donc pas tenir « toujours une pochette »** : il élargit le vivier,
   c'est le drapeau du catalogue qui tient la garantie.
4. **L'image trouvée à la demande ne rejoint pas le nœud.** La file d'images
   (`src/images/image-queue.ts`) écrit un sidecar `cache/images/` (ignoré par git), jamais le nœud :
   c'est la décision 3b-D3 de `docs/plans/graph-integrity.md:574-590`, que ce plan ne rouvre pas (D1).
   Le nœud ne reçoit son `image_url` que par deux chemins : à l'écriture (`attachResolvedImage`,
   `src/pipeline.ts:903`, TRA-479) et par le lot (TRA-489).
5. **La production ne reçoit plus rien depuis le 24/10.** Les workflows `deploy`, `sync-genre-cache`
   et `pull-cache` ciblent des runners auto-hébergés éteints et sont désactivés
   (`docs/track1-builds.md:42-54`, `.github/workflows/deploy.yml:28`, `sync-genre-cache.yml:31`). Un merge
   sur `main` ne déploie rien. Deux canaux distincts mènent au serveur, et les deux sont à l'arrêt :
   - le **code** : `deploy/deploy-server.sh`, dont le rsync exclut `cache/` ;
   - les **données** : `deploy/sync-genre-cache.sh --migration <nom> [--apply]`
     (`deploy/sync-genre-cache.sh:38-41`), seul chemin par lequel un lot du dépôt atteint le cache de prod.

   Tout ce que ce plan produit côté serveur (résolveur, drapeau du catalogue, cache comblé) n'atteint
   donc l'app qu'une fois l'un ou l'autre canal rejoué (partie 4, question Q1). Seul le client iOS se
   livre sans déploiement, par TestFlight (`ios-testflight`, runner hébergé `macos-26`).

## Non-buts

- **TRA-794** : ni replanifiée ni modifiée, sauf son retrait final (3.3). La demande de `/image` par le
  hero pour un projet ou une track sans `image_url` reste en place.
- **Rétablir le déploiement** (runners, workflow `deploy`, portage sur runner hébergé) : hors périmètre.
  Le plan le pose comme question et ne contient que les deux actions de mise en production.
- **Curation manuelle du résidu** (indices jugés à la main, sur le modèle de
  `scripts/migrations/2026-10-24-credit-uncredited-releases.hints.json`) et **crédit des 59 œuvres sans
  artiste** : non planifiés. Les œuvres sans crédit relèvent de TRA-485
  (`docs/plans/graph-integrity.md:232`). Le lot étant rejouable, il les reprendra le jour où elles
  auront un crédit (Q4).
- Aucune nouvelle source d'images, aucun changement de `IMAGE_HOST_ALLOWLIST` (`src/images/hosts.ts`),
  aucun hébergement ni proxy d'images.
- Aucun champ de nœud ajouté : `image_url` et `image_source` existent déjà dans `src/types.ts`,
  `src/schemas.ts`, `src/node-spec.ts` et `src/graph.ts`.
- Pas de reprise des `photo_url` / `cover_url` hérités (interdite depuis TRA-594).
- Pas de re-tirage des jours déjà persistés sur l'appareil (au plus `ReminderPlan.horizonDays` = 7 jours).
- Client React Native (`mobile/`) et page web : non modifiés. Le drapeau n'est utilisé côté client que
  pour les projets et les tracks.

## Décisions d'archi

### D1 — La vérité de « a une image » est l'`image_url` du nœud ; la décision 3b-D3 n'est pas rouverte

Le nœud reçoit son image à l'écriture (TRA-479) et par le lot (TRA-489). Le plan renforce ces deux
chemins et n'en crée pas un troisième : la file continue d'écrire des sidecars, jamais des nœuds.
« L'image à l'écriture » est donc, ici, la résolution faite quand le nœud est écrit, rendue aussi
capable pour une track que pour un projet (D2).

- Rejeté — reporter sur le nœud l'image que la file trouve à la demande (`cache.update`) : déjà rejeté
  par 3b-D3 pour trois raisons qui tiennent toujours : cela rouvre l'écriture à la lecture fermée par
  TRA-475, fait diverger la prod et le dépôt (le canal d'union écraserait l'image à la migration
  suivante) et doublonne le lot.
- Rejeté — faire lire les sidecars au catalogue : deux vérités pour une même question, un `revision` de
  catalogue qui change à chaque sidecar écrit, et une fiche (`/nodes/:id`) qui dirait encore « pas
  d'image » pour un nœud que le catalogue dit imagé.

Conséquence assumée : une image connue seulement par un sidecar de prod ne compte pas dans le drapeau
tant que le lot n'est pas passé sur la prod (R4, ordre de D6).

### D2 — L'échelle `track` gagne un échelon MusicBrainz, pour tout appelant, écriture comprise

Nouvelle échelle : image du projet → CAA par le MBID du projet → **MusicBrainz nomme le groupe de
parution, puis CAA** → iTunes vérifié. L'échelon réutilise les fonctions de
`src/images/resolve-work-hint.ts` : `resolveAlbumByMusicBrainz` quand la track nomme un projet, sinon le
chemin « enregistrement » (aujourd'hui privé, à exporter). Il n'est pas conditionné à `viaMusicBrainz` :
la matérialisation d'une track ne cherche jamais le groupe de parution de son projet, l'échelon ne
refait donc aucune recherche que l'écriture vient de faire. Seul le sous-échelon « compilation » reste
derrière `viaMusicBrainz` (file et lot), comme pour les projets. `IMAGE_RULES_VERSION` passe à 4 pour
que les refus `missing` déjà écrits en sidecar soient recalculés.

- Rejeté — appeler `resolveWorkImageByHint` en entier : il finit par un iTunes sans contrôle de l'année,
  que l'échelle des nœuds exige depuis TRA-595.
- Rejeté — conditionner tout l'échelon à `viaMusicBrainz` : l'écriture n'en profiterait pas, et le flux
  continuerait de produire des tracks sans image.
- Rejeté — faire estampiller par le pipeline le MBID du groupe de parution sur l'arête `project` : c'est
  un changement d'identité de nœud, hors du périmètre « images ».

### D3 — Le lot est une nouvelle migration datée, mince, posée sur `runBackfill`

`scripts/migrations/2026-11-21-backfill-missing-images.ts` appelle le `runBackfill` de la migration du
18/10 avec `viaMusicBrainz: true`. Même ordre (project → track → artist → label → genre, donc **tous les
nœuds**), mêmes règles (un nœud imagé n'est jamais retouché, arrêt fermé sur une source indisponible,
écriture après validation Zod, manifeste déterministe), même contrat de canal (`--apply`, `--manifest`,
`--data-dir`). Elle est jouée deux fois : sur le cache du dépôt (2.3), puis sur l'union dépôt + prod par
le canal de données (4.1).

- Rejeté — changer le comportement par défaut de la migration du 18/10 : le canal ne passe aucune
  option, et rejouer l'ancienne migration doit rester sans effet nouveau.
- Rejeté — paralléliser les requêtes du lot : MusicBrainz est tenu à une requête par seconde, et l'arrêt
  fermé repose sur un traitement séquentiel (un nœud qui lit un nœud en échec attend).
- Rejeté — un script de curation dans ce plan : voir Non-buts.

### D4 — Le catalogue porte un booléen `has_image`, pas d'URL

`MobileCatalogNode` gagne `has_image: boolean`, calculé dans la projection du graphe : vrai si
l'`image_url` du nœud passe `safePublicHttpsUrl` (le contrôle que `/nodes/:id` applique déjà,
`src/mobile/nodes.ts:76`), ou, pour une track, si le projet que désigne son arête `project` en porte
une. C'est exactement ce que le hero sait afficher sans rien résoudre
(`ios/Track1Core/Sources/Track1Core/Media/HeroImageSource.swift:50-54`). `version` reste `v1` : le champ est
additif, les clients existants l'ignorent (décodeur iOS par clés, schéma Zod non strict du client RN,
`mobile/src/api/contracts.ts:124-136`).

- Rejeté — mettre `image_url` dans le catalogue : la doc du contrat pose « ni URL tierce »
  (`docs/track1-api.md:83`), le catalogue grossit d'une URL par nœud et une donnée tierce de plus doit
  être validée à un second endroit.
- Rejeté — un endpoint dédié (« quelles identités ont une image ») : une requête de plus à chaque
  tirage, pour une information qui tient dans la réponse déjà lue.

### D5 — Côté iOS, le filtre vit dans `Affinity.rank`, avant la troncature, avec deux replis

- Le serveur publie le drapeau : `rank` ne garde que les candidats `hasImage == true`, puis trie et
  tronque à 60 comme aujourd'hui. Le plan des rappels (`ReminderPlan.plan`) reçoit la même liste et
  hérite du filtre sans changement.
- Aucun candidat n'a de pochette : `rank` rend le classement entier. Une recommandation sans pochette
  vaut mieux qu'un écran vide (Q3).
- Le serveur ne publie pas le drapeau (prod d'avant le déploiement) : `rank` ne filtre pas et la
  vérification de TRA-794 reste seule en charge. Elle n'est sautée que pour un candidat
  `hasImage == true`. Elle n'est retirée (3.3) qu'une fois la prod vérifiée.

- Rejeté — filtrer dans `DailySelection.pick` : après la troncature, le vivier de 60 se vide d'un
  tiers, et `ReminderPlan` devrait dupliquer le filtre.
- Rejeté — rendre `.emptyCatalog` quand aucun candidat n'a de pochette : 61 des 256 genres qui ont des
  œuvres directes n'en ont aujourd'hui aucune avec image dans le dépôt.

### D6 — Mise en production : les données d'abord, le code ensuite, le retrait du palliatif en dernier

Le lot n'écrit que `image_url` et `image_source`, deux champs que le code de prod du 24/10 connaît
déjà : le canal de données peut passer **avant** tout déploiement de code, et il profite tout de suite
à la build TestFlight actuelle et à TRA-794. Le code (drapeau, échelon track) vient ensuite. La tâche
3.3 attend que la prod serve `has_image`.

- Rejeté — déployer le code d'abord : le drapeau refléterait la couverture actuelle de la prod, et le
  vivier se réduirait avant d'être comblé.

## Découpage

`[P]` = parallélisable dans sa vague ; 1 pt ≈ 1,5 h ; chaque tâche < 300 lignes de diff écrit (200 pour
un tier/3), tests compris. Les fichiers de `cache/nodes/` sont comptés « générés » par
`scripts/ci/pr-policy.ts` et n'entrent pas dans ce total. Le tier est le tier pressenti ; un chemin
sensible (`scripts/migrations/`, `data/integrity-thresholds.json`) impose de toute façon tier/3.

### Partie 1 — L'image à l'écriture : une track trouve sa pochette sans projet en cache

Déployable seule : un échelon de plus, qui ne peut que trouver une image là où il n'y en avait pas.
Sert l'écriture, la file et le lot. Sans effet en prod avant le déploiement du code.

- [ ] TRA-? 1.1 [P] Ajouter l'échelon MusicBrainz à l'échelle `track` du résolveur — tier/2, 3 pts

### Partie 2 — Le lot : combler les images manquantes sur tous les nœuds

Déployable seule : le dépôt gagne des images vérifiées ; rien ne change pour un nœud déjà imagé. Menée
en parallèle de la partie 3. Atteint la prod par 4.1.

- [ ] TRA-? 2.1 [P] Donner à `runBackfill` l'option `viaMusicBrainz` et l'arrêt fermé MusicBrainz — tier/3, 2 pts
- [ ] TRA-? 2.2 Créer la migration `2026-11-21-backfill-missing-images` et la faire accepter par le canal — tier/3, 2 pts (après 2.1)
- [ ] TRA-? 2.3 Jouer le lot sur le cache du dépôt et abaisser les plafonds `missing-image` — tier/3, 2 pts (après 1.1 et 2.2 ; exige l'accès réseau, voir R2)

### Partie 3 — Le catalogue dit « a une image », le client s'y fie

Déployable seule : champ additif côté serveur ; côté iOS, comportement inchangé tant que le serveur ne
publie pas le drapeau. Remplace la vérification cliente de TRA-794.

- [ ] TRA-? 3.1 [P] Publier `has_image` sur chaque nœud du catalogue mobile — tier/3, 2 pts
- [ ] TRA-? 3.2 [P] Lire `has_image` côté iOS et ne tirer que des œuvres à pochette — tier/2, 3 pts (après le merge de TRA-794 ; ne dépend pas de 3.1, le contrat est fixé ici)
- [ ] TRA-? 3.3 Retirer la vérification cliente de TRA-794 — tier/2, 1 pt (après 3.2 et 4.2)

### Partie 4 — Mise en production (actions de Raphael, bloquées par Q1)

- [ ] TRA-? 4.1 Passer le lot sur la prod par le canal de données — tier/3, 1 pt (après 2.3)
- [ ] TRA-? 4.2 Déployer le code serveur et vérifier le drapeau en prod — tier/3, 1 pt (après 1.1 et 3.1 ; de préférence après 4.1)

### Ordre d'attaque

1. Vague A, en parallèle (aucun fichier commun) : 1.1, 2.1, 3.1, 3.2.
2. Vague B, en série : 2.2, puis 2.3.
3. Vague C, Raphael : 4.1, puis 4.2.
4. Vague D : 3.3.

Total : 9 tâches, 17 pts. Sans déploiement, on peut merger 1.1, 2.1, 2.2, 2.3, 3.1 et 3.2, et livrer
3.2 par TestFlight ; l'effet visible dans l'app attend 4.1 (pochettes) puis 4.2 (drapeau).

## Risques

- **R1 — Le déploiement reste gelé.** Les parties 1, 2 et 3.1 sont alors sans effet pour l'utilisateur,
  et 3.3 ne peut pas démarrer. Garde-fou : TRA-794 tient le symptôme entre-temps ; 3.2 est inerte tant
  que le drapeau n'est pas publié ; les scripts `deploy/` se lancent aussi à la main depuis un poste
  avec `ssh-agent`. Question Q1.
- **R2 — Le lot a besoin du réseau, que l'environnement cloud des agents refuse.** Constaté le
  2026-11-21 : le proxy de sortie répond 403 pour `musicbrainz.org`, `coverartarchive.org` et
  `itunes.apple.com` ; `www.wikidata.org` n'a pas été testé. Sans ces hôtes, ni l'aperçu ni
  l'application du lot ne tournent, et ce plan n'a pas pu mesurer ce que l'échelle étendue trouvera
  réellement. Garde-fou : 2.3 et 4.1 portent le prérequis en tête de ticket. Question Q2.
- **R3 — Une mauvaise pochette est pire qu'aucune, et un nœud imagé n'est jamais revisité.** Garde-fou :
  aucune règle d'identité n'est assouplie (MusicBrainz tranche, `ambiguous` ne donne rien, iTunes exige
  titre, artiste et année) ; toute URL passe `isAllowedImageUrl` puis le schéma Zod ; un nœud dont une
  source n'a pas répondu va dans `failed`, jamais dans une écriture ; la PR de 2.3 est tier/3, avec
  relecture humaine d'un échantillon de 20 images tirées du manifeste.
- **R4 — Le drapeau réduit le vivier.** Si 4.2 passe avant 4.1, le drapeau reflète la couverture
  actuelle de la prod (environ deux tiers des œuvres) et ignore les images connues des seuls sidecars
  (D1). Garde-fou : ordre de D6 ; repli de D5 quand aucun candidat n'a de pochette ; la PR de 2.3
  publie la couverture par type avant et après.
- **R5 — Le drapeau dit vrai mais l'image ne se charge pas** (Cover Art Archive redirige vers
  `archive.org`, parfois lent ou en erreur). L'image de remplacement reste alors possible. Non couvert
  par ce plan (pas d'hébergement d'images) ; à mesurer après 4.2 avant d'ouvrir un chantier.
- **R6 — Le flux n'a pas de rattrapage automatique.** Un nœud écrit pendant une panne d'une source reste
  sans image jusqu'au prochain passage du lot. Garde-fou : le lot est idempotent et passe par le canal ;
  le rejouer à chaque usage du canal ne coûte que les nœuds sans image.
- **R7 — `IMAGE_RULES_VERSION` 4 invalide d'un coup les refus `missing` des sidecars de prod.** Ils sont
  recalculés à la demande par un worker unique et séquentiel : pas de rafale possible
  (`src/images/image-queue.ts`, en-tête).
- **R8 — Deux requêtes MusicBrainz de plus à l'écriture d'une track.** Elles tiennent dans les 20 s de
  `IMAGE_RESOLVE_TIMEOUT_MS` (`src/pipeline.ts:892`), et un échelon qui échoue ne coûte jamais le nœud.
- **R9 — TRA-794 n'était pas mergée quand ce plan a été écrit.** Les tickets 3.2 et 3.3 décrivent son
  code par son comportement et demandent de le localiser ; si sa forme diffère de la description du
  brief, leurs critères sur « la vérification cliente » sont à relire avant de commencer.
- **R10 — `has_image` change le `revision` du catalogue** : chaque client retélécharge le catalogue une
  fois au déploiement, puis à chaque passage du lot. Effet voulu, coût borné.

## Critères de sortie

- Sur `main` : après 2.3, `npm run check` et `npm run audit:cache` sont verts, les plafonds
  `missing-image` de `data/integrity-thresholds.json` sont abaissés aux valeurs mesurées, un second
  passage du lot n'écrit rien, et chaque projet ou track encore sans `image_url` figure dans la PR avec
  sa raison.
- En prod : `https://dropcliffs.com/api/odyssey/version` rend le SHA de `main` qui contient 1.1 et 3.1 ;
  tous les nœuds de `GET /mobile/v1/catalog` portent `has_image` ; trois œuvres imagées par le lot
  rendent leur `image_url` sur `/mobile/v1/nodes/:id`.
- Dans l'app : avec le drapeau publié, un chargement de l'écran du jour ne fait aucune lecture `/image`
  de vérification (test unitaire), et l'œuvre du jour comme les sept jours planifiés ont
  `has_image: true` dès qu'un candidat à pochette existe pour le profil.
- `track:night--dubstep-track-by-benga-and-coki` : soit le nœud porte une `image_url`, soit le
  catalogue de prod le donne `has_image: false` et il ne peut plus être tiré tant qu'une œuvre à
  pochette est candidate.
- La vérification cliente de TRA-794 n'existe plus dans `ios/` (3.3).

## Questions pour Raphael (gate)

- **Q1 — Déploiement.** Peux-tu lancer à la main, depuis un poste avec `ssh-agent`,
  `bash deploy/sync-genre-cache.sh --migration 2026-11-21-backfill-missing-images --apply` (données)
  puis `bash deploy/deploy-server.sh` (code) ? Si oui, quand ? Si non, il faut d'abord un ticket hors de
  ce plan pour rétablir un moyen de déployer, et les tâches 4.1, 4.2 et 3.3 attendent.
- **Q2 — Qui joue le lot (2.3) ?** Toi, en local, ou un agent après ouverture de `musicbrainz.org`,
  `coverartarchive.org`, `itunes.apple.com` et `www.wikidata.org` dans l'environnement cloud ?
- **Q3 — Repli.** Quand aucune œuvre candidate n'a de pochette, je garde une œuvre sans pochette plutôt
  que l'écran vide (D5). D'accord ?
- **Q4 — Résidu.** Au moins 81 œuvres resteront sans pochette après le lot, dont 59 sans crédit
  (TRA-485). Veux-tu un chantier de curation à la main une fois le manifeste de 2.3 connu ? Il n'est
  pas planifié ici.
- **Q5 — « L'image à l'écriture ».** Je l'ai lue comme la résolution au moment où le nœud est écrit,
  renforcée pour les tracks, sans rouvrir 3b-D3. Si tu voulais que l'image trouvée à la demande soit
  reportée sur le nœud, c'est D1 qu'il faut renverser : dis-le avant la création des tickets.

## Tickets proposés (format `ticket-template.md`, à créer après validation)

### TRA-? (1.1) — Ajouter l'échelon MusicBrainz à l'échelle `track` du résolveur

```markdown
## Contexte
Une track dont le projet n'a pas de nœud, ou qui ne nomme aucun projet, n'obtient presque jamais de
pochette : son échelle n'a que l'image du projet, la Cover Art Archive par le MBID du projet et iTunes.
59 tracks créditées du cache sont dans ce cas. Le résolveur d'indices sait déjà demander à MusicBrainz
le groupe de parution ; cette tâche donne le même échelon à l'échelle des nœuds, qui sert l'écriture
(matérialisation), la file et le lot. Plan : docs/plans/track1-pochettes.md#partie-1, décision D2.

## Portée
Fichiers à modifier :
- `src/images/resolve-image.ts` — échelon `musicbrainz` dans le cas `track` (entre `caa` et `itunes`),
  mise à jour de l'en-tête et de la doc de `ImageDeps.viaMusicBrainz`
- `src/images/resolve-work-hint.ts` — exporter le chemin « enregistrement » (aujourd'hui inline dans
  `resolveWorkImageByHint`, lignes 251-258) sous un nom public ; `resolveWorkImageByHint` l'appelle
- `src/images/image-sidecar.ts` — `IMAGE_RULES_VERSION` 3 → 4, avec le commentaire daté de la convention
- `test/images/resolve-image.test.ts`, `test/images/rules-version.test.ts`, `test/pipeline-image.test.ts`
Hors-scope explicite :
- les échelles `project`, `artist`, `label`, `genre`
- `src/pipeline.ts`, `src/server.ts`, `src/images/image-queue.ts` : aucun changement de câblage
- `src/musicbrainz.ts` : aucune règle d'identité n'est modifiée
- `scripts/migrations/` (tâches 2.1 et 2.2)

## Contrat
Échelle après la tâche : `project-image` → `caa` (MBID du projet) → `musicbrainz` → `itunes`.

    // src/images/resolve-work-hint.ts
    export function resolveRecordingCoverByMusicBrainz(
      track: { title: string; artist: string },
      hint: Pick<WorkImageHint, "slug">,
      deps: WorkHintDeps,
    ): Promise<WorkImageResolution | null>;

Règles de l'échelon `musicbrainz` d'une track :
- artiste = `node.artists[0]?.name`, sinon celui du projet en cache ; absent → `null`, aucune requête ;
- l'arête `project` existe, a un nom, et ni le nœud du projet ni l'arête n'ont de MBID →
  `resolveAlbumByMusicBrainz({ title: projectRef.name, artist, artistMbid }, { slug: node.slug }, …)`,
  avec `compilations: deps.viaMusicBrainz === true` ;
- pas d'arête `project` → `resolveRecordingCoverByMusicBrainz({ title: node.name, artist }, …)` ;
- un MBID de projet connu → l'échelon ne fait rien (l'échelon `caa` vient de répondre) ;
- seul `kind: "found"` donne `{ url, source: "caa" }` ; tout autre verdict rend `null` et l'échelle
  continue vers `itunes` (même convention que `musicBrainzCover`, lignes 214-243) ;
- `unavailable` positionne `deps.outage.musicBrainz`, une panne CAA positionne `deps.outage.coverArt` ;
- `fetch`, `priority` et `signal` de `deps` sont transmis comme le fait `musicBrainzCover` ;
- l'échelon s'exécute pour tout appelant, que `viaMusicBrainz` soit posé ou non.

## Critères d'acceptation
- [ ] Une track créditée dont le projet nommé n'a pas de nœud obtient `{ source: "caa" }` quand
      MusicBrainz nomme un seul groupe de parution et que la CAA a une face avant.
- [ ] Une track créditée sans arête `project` obtient la pochette du groupe de parution de son
      enregistrement.
- [ ] Verdict `ambiguous` : l'échelon rend `null` et l'échelon `itunes` est tout de même tenté.
- [ ] MusicBrainz indisponible : `resolveImage` rend `null` et `deps.outage.musicBrainz === true`.
- [ ] Track sans artiste (ni sur elle, ni sur son projet) : aucune requête MusicBrainz n'est émise.
- [ ] Projet en cache avec `image_url` : aucune requête réseau (le premier échelon gagne, comme avant).
- [ ] Sans `viaMusicBrainz`, la recherche de compilation n'est pas émise ; avec, elle l'est.
- [ ] `IMAGE_RULES_VERSION === 4` et un sidecar `missing` écrit sous la version 3 est lu comme périmé.
- [ ] Une track matérialisée par le pipeline sans nœud de projet reçoit `image_url` et
      `image_source: "caa"` à l'écriture.
- [ ] `npm run check` vert.

## Tests attendus
- unitaire : `test/images/resolve-image.test.ts`, un test par critère d'échelle ci-dessus
- unitaire : `test/images/rules-version.test.ts`, version 4
- intégration : `test/pipeline-image.test.ts`, le cas d'écriture

## Tier de risque
tier/2

## Notes d'implémentation
- Modèle à suivre pour simuler MusicBrainz, la CAA et iTunes : `test/images/kode9-node-path.test.ts`
  et `test/images/helpers.ts` (`routedFetch`). Ne mocke pas `resolve-work-hint.ts` : c'est du code du
  dépôt.
- Ne pas appeler `resolveWorkImageByHint` depuis l'échelle des nœuds : il finit par un iTunes sans
  contrôle de l'année (TRA-595). Décision D2, à ne pas rediscuter.
- L'identité vient de MusicBrainz ; ne jamais écrire sur le nœud le MBID trouvé par cet échelon.
- Toute URL rendue passe déjà par `attempt` puis `isAllowedImageUrl` : garder ce passage.
- Commentaires en anglais, datés quand ils documentent une régression.
```

### TRA-? (2.1) — Donner à `runBackfill` l'option `viaMusicBrainz` et l'arrêt fermé MusicBrainz

```markdown
## Contexte
Le lot d'images du 18/10 appelle le résolveur sans l'échelon MusicBrainz des projets sans MBID : 41
projets crédités du cache n'ont donc jamais été essayés par ce chemin. Cette tâche rend l'option
disponible dans `runBackfill`, sans changer le comportement par défaut de la migration existante.
Plan : docs/plans/track1-pochettes.md#partie-2, décision D3.

## Portée
Fichiers à modifier :
- `scripts/migrations/2026-10-18-backfill-images.ts` — deux options dans `BackfillOptions`
  (lignes 143-155), leur usage dans `runBackfill` (ligne 428, appel du résolveur ligne 550)
- `test/backfill-images.test.ts` — cas nouveaux
Hors-scope explicite :
- le comportement par défaut, le CLI et le manifeste de la migration du 18/10
- `noneReason` et `NONE_REASONS`
- `src/images/` (tâche 1.1), `deploy/`, `cache/`

## Contrat
    export interface BackfillOptions {
      // … champs existants inchangés
      /** Passe `viaMusicBrainz: true` au résolveur. Défaut : false. */
      viaMusicBrainz?: boolean;
      /** Valeur du champ `migration` du manifeste. Défaut : MIGRATION_NAME. */
      migrationName?: string;
    }

Quand `viaMusicBrainz` est vrai, le résolveur reçoit aussi `outage: { musicBrainz: false, coverArt: false }`.
Si l'un des deux drapeaux est levé après la résolution d'un nœud, le nœud est traité comme une source
indisponible : listé dans `failed` avec la raison `source unavailable: <hôte>`, jamais écrit, jamais
dans `none`, ajouté à l'ensemble des nœuds en attente, et il compte dans
`MAX_CONSECUTIVE_UNAVAILABLE`. C'est vrai que le résolveur ait trouvé une image ou non.

## Critères d'acceptation
- [ ] Sans option, le manifeste et les écritures sont identiques octet pour octet à aujourd'hui (les
      tests existants passent sans modification).
- [ ] Avec `viaMusicBrainz: true`, un projet crédité sans MBID que MusicBrainz nomme reçoit
      `image_url` et `image_source: "caa"`.
- [ ] Avec `viaMusicBrainz: true` et MusicBrainz indisponible, le projet est dans `failed`, pas dans
      `none`, rien n'est écrit, le code de sortie est 1.
- [ ] Une track qui lit ce projet attend aussi dans `failed`.
- [ ] `migrationName` remplace le champ `migration` du manifeste.
- [ ] Diff de la PR ≤ 200 lignes, `npm run check` vert.

## Tests attendus
- unitaire : `test/backfill-images.test.ts`, les quatre cas ci-dessus avec `fetch` et horloge injectés
- intégration : aucune

## Tier de risque
tier/3 (chemin `scripts/migrations/`)

## Notes d'implémentation
- MusicBrainz ne passe pas par le `fetch` injecté (il a son propre client) : le `tracker` de
  disponibilité ne le voit pas. C'est `deps.outage` qui porte l'information, d'où ce contrat.
- Règle existante à garder : un nœud qui a déjà une `image_url` n'est jamais retouché.
- Écriture par `atomicWriteJson` après `nodePayloadSchema`, jamais `NodeCache.write`.
- Le fichier est un chemin sensible : PR en review humaine, pas d'auto-merge.
```

### TRA-? (2.2) — Créer la migration `2026-11-21-backfill-missing-images` et la faire accepter par le canal

```markdown
## Contexte
Le canal de données de prod lance une migration par son nom et ne lui passe que `--apply`,
`--manifest` et `--data-dir`. Pour que le lot étendu (échelon MusicBrainz) atteigne la prod, il lui
faut son propre nom de migration. Plan : docs/plans/track1-pochettes.md#partie-2, décision D3.

## Portée
Fichiers à créer :
- `scripts/migrations/2026-11-21-backfill-missing-images.ts` — enveloppe mince de `runBackfill`
- `test/migration-channel-missing-images.test.ts` — sur le modèle de
  `test/migration-channel-images.test.ts`, avec le harnais `test/helpers/migration-channel.ts`
Hors-scope explicite :
- `scripts/migrations/2026-10-18-backfill-images.ts` (déjà modifié par 2.1, ne plus y toucher)
- `deploy/sync-genre-cache.sh` : il accepte tout nom daté dont le fichier existe, rien à y changer
- `cache/` : aucun nœud n'est écrit par cette tâche

## Contrat
    export const MIGRATION_NAME = "2026-11-21-backfill-missing-images";
    export const DEFAULT_MANIFEST_PATH = "out/missing-images.json";

    Usage: tsx scripts/migrations/2026-11-21-backfill-missing-images.ts <cache-dir> [--apply]
           [--types project,track,artist,label,genre] [--manifest <path>] [--resume] [--data-dir <dir>]

Mêmes drapeaux, même forme de manifeste (`ImagesManifest`) et mêmes codes de sortie que la migration du
18/10, dont elle réutilise `parseCliArgs`, `runBackfill` et `formatSummary`. Deux différences
seulement : `viaMusicBrainz: true` et `migration: MIGRATION_NAME` dans le manifeste.

## Critères d'acceptation
- [ ] Le canal accepte la migration en aperçu (nom, script, contrat de manifeste).
- [ ] Le canal lui passe `--apply`, `--manifest` et `--data-dir`, et elle les accepte.
- [ ] Deux passages du canal donnent un manifeste identique octet pour octet.
- [ ] Sans `--apply`, aucun fichier de nœud n'est écrit.
- [ ] Le champ `migration` du manifeste vaut `2026-11-21-backfill-missing-images`.
- [ ] Diff de la PR ≤ 200 lignes, `npm run check` vert.

## Tests attendus
- intégration : `test/migration-channel-missing-images.test.ts`, les quatre premiers critères
- unitaire : aucun de plus (la logique est couverte par 2.1)

## Tier de risque
tier/3 (chemin `scripts/migrations/`)

## Notes d'implémentation
- Précédent d'une migration mince posée sur une autre :
  `scripts/migrations/2026-10-24-credit-uncredited-releases.ts`, qui importe `runBackfill` de
  `2026-10-15-backfill-release-identity.ts`.
- `--data-dir` est accepté et ignoré, comme dans la migration du 18/10.
- Le nom du fichier est fixé par ce plan (les tickets 2.3 et 4.1 le citent) : ne pas le redater.
```

### TRA-? (2.3) — Jouer le lot sur le cache du dépôt et abaisser les plafonds `missing-image`

```markdown
## Contexte
C'est le « gros travail en amont » : passer l'échelle étendue sur tous les nœuds sans image du cache
committé (106 projets, 87 tracks, 191 artistes, 93 labels, 274 genres), puis verrouiller le gain dans
l'audit. Les artistes, labels et genres en profitent par les pochettes dérivées.
Plan : docs/plans/track1-pochettes.md#partie-2.

**Prérequis réseau** : `musicbrainz.org`, `coverartarchive.org`, `itunes.apple.com`,
`www.wikidata.org` doivent répondre. L'environnement cloud des agents les refusait le 2026-11-21 (403
du proxy). Si la première requête est refusée, s'arrêter et le signaler : ne rien contourner.

## Portée
Fichiers modifiés :
- `cache/nodes/**/*.json` — uniquement par le script, avec `--apply`
- `data/integrity-thresholds.json` — plafonds `missing-image` des cinq types (lignes 40-46)
Hors-scope explicite :
- toute édition à la main d'un fichier de `cache/`
- tout fichier de `src/`, `scripts/`, `test/`
- `web/data.json` (généré, non committé)
- les 59 œuvres sans crédit : elles resteront dans `none`, c'est attendu (TRA-485)

## Contrat
Séquence, depuis `main` contenant 1.1, 2.1 et 2.2 :

    npx tsx scripts/migrations/2026-11-21-backfill-missing-images.ts cache --manifest out/missing-images.json
    npx tsx scripts/migrations/2026-11-21-backfill-missing-images.ts cache --apply --resume --manifest out/missing-images.json
    npx tsx scripts/migrations/2026-11-21-backfill-missing-images.ts cache --manifest out/missing-images-2.json
    npm run audit:cache

Le premier passage est l'aperçu, le deuxième écrit, le troisième prouve l'idempotence. Un passage qui
sort en 1 (liste `failed` non vide) est relancé avec `--resume` jusqu'à une sortie 0. Le lot est
séquentiel et dure de l'ordre d'une heure.

Corps de la PR : couverture `before` / `after` par type, `bySource`, nombre de nœuds par raison de
`none`, liste des slugs `project:` et `track:` encore sans image, et 20 images tirées au hasard parmi
les nœuds écrits (slug, nom, artiste, URL) pour la relecture humaine.

## Critères d'acceptation
- [ ] Le deuxième passage sort en 0 et sa liste `failed` est vide.
- [ ] Le troisième passage n'écrit aucun fichier.
- [ ] Pour chaque fichier modifié sous `cache/nodes/`, l'objet JSON avant et après ne diffère que par
      les clés `image_url` et `image_source` (vérifié par un script jetable, résultat collé dans la PR).
- [ ] Toute `image_url` écrite passe `isAllowedImageUrl`.
- [ ] `npm run audit:cache` vert, et chaque plafond `missing-image` est égal à la valeur mesurée après
      le lot (aucun plafond ne monte).
- [ ] `npm run check` vert, dont `test/ci-integrity-job.test.ts`.
- [ ] La PR contient les cinq éléments de corps listés au contrat.

## Tests attendus
- unitaire : aucun (pas de code)
- intégration : les trois passages du lot et l'audit font foi

## Tier de risque
tier/3 (`data/integrity-thresholds.json` ; données committées, une mauvaise image n'est jamais revisitée)

## Notes d'implémentation
- Ne jamais lancer avec `--types` restreint pour la PR finale : l'ordre project → track → artist →
  label → genre est ce qui permet les pochettes dérivées.
- Le manifeste (`out/`) n'est pas committé.
- L'audit compte encore `photo_url` et `cover_url` comme des images (`scripts/audit-cache.ts:105`) :
  les plafonds mesurés seront donc plus bas que le nombre de nœuds sans `image_url`. Ne pas modifier
  l'audit.
- `cache/nodes/` est compté « généré » par `scripts/ci/pr-policy.ts` : la taille de la PR n'est pas un
  motif de découpage.
```

### TRA-? (3.1) — Publier `has_image` sur chaque nœud du catalogue mobile

```markdown
## Contexte
Le tirage de l'œuvre du jour se fait sur l'iPhone à partir du catalogue, qui ne dit pas quelle œuvre a
une image. Le palliatif TRA-794 fait vérifier `/image` par le client, œuvre par œuvre. Cette tâche
donne l'information dans le catalogue lui-même, pour que le client n'ait plus rien à vérifier.
Plan : docs/plans/track1-pochettes.md#partie-3, décision D4.

## Portée
Fichiers à modifier :
- `src/mobile/contracts.ts` — champ `has_image` de `MobileCatalogNode` (lignes 8-13)
- `src/mobile/catalog.ts` — calcul dans `toCatalogProjection` / `toMobileNode` (lignes 89-114, 195-203)
- `docs/track1-api.md` — section « Catalogue disponible » (lignes 30-88) : exemple et règle
- `test/mobile/catalog.test.ts` — cas nouveaux
- `test/mobile/compatibility.test.ts`, `test/helpers/mobile-contract-server.ts` — seulement si un test
  y épingle la forme exacte d'un nœud du catalogue
Hors-scope explicite :
- `src/graph.ts`, `src/schemas.ts`, `src/types.ts`, `src/node-spec.ts` : aucun champ de nœud
- `src/mobile/media.ts`, `src/services/image-service.ts`, les sidecars `cache/images/`
- `ios/` (tâche 3.2), `mobile/`, `web/`

## Contrat
    export interface MobileCatalogNode {
      identity: string;
      type: MobileNodeType;
      name: string;
      teaser: string | null;
      has_image: boolean;
    }

`has_image` est toujours présent, sur les cinq types. Il vaut `true` si et seulement si :
- l'`image_url` du nœud du graphe passe `safePublicHttpsUrl` (`src/mobile/nodes.ts:76`) ; ou
- le nœud est une `track`, son arête `edges.project` désigne un nœud présent dans le graphe, et
  l'`image_url` de ce nœud passe le même contrôle.
Le calcul se fait sur la projection complète, avant le filtre `identities`. `version` reste `"v1"`.
`revision` couvre le champ. Aucune URL n'entre dans le catalogue.

## Critères d'acceptation
- [ ] Nœud avec une `image_url` https publique : `has_image: true`.
- [ ] Nœud sans `image_url` : `has_image: false`.
- [ ] Nœud dont l'`image_url` est en `http://` ou vise un hôte privé : `has_image: false`.
- [ ] Track sans image dont le projet du graphe a une image : `has_image: true`.
- [ ] Track sans image dont l'arête `project` désigne un nœud absent du graphe : `has_image: false`.
- [ ] Avec `identities=track:x` seul, la track garde `has_image: true` même si son projet n'est pas demandé.
- [ ] Le `revision` change quand un nœud gagne une image et ne change pas entre deux appels identiques.
- [ ] `docs/track1-api.md` montre le champ dans l'exemple et énonce la règle ; la phrase « ni URL
      tierce » reste vraie.
- [ ] Diff de la PR ≤ 200 lignes, `npm run check` vert.

## Tests attendus
- unitaire : `test/mobile/catalog.test.ts`, un test par critère de valeur
- intégration : `test/mobile/compatibility.test.ts` continue de passer

## Tier de risque
tier/3 (changement de contrat d'API public, même additif ; seul Raphael peut l'abaisser)

## Notes d'implémentation
- Le graphe est une donnée non fiable dans ce module : lire `image_url` et `edges.project.slug` depuis
  `unknown`, champ par champ, comme le fait déjà `toMobileNode`.
- Ne pas lire les sidecars ni appeler le service d'images : décision D1, à ne pas rediscuter.
- `exactOptionalPropertyTypes` est actif : le champ est requis, pas optionnel.
- Les clients existants ignorent une clé inconnue (décodeur iOS par clés, schéma Zod non strict de
  `mobile/src/api/contracts.ts:124-136`) : pas de version `v2`.
```

### TRA-? (3.2) — Lire `has_image` côté iOS et ne tirer que des œuvres à pochette

```markdown
## Contexte
Le catalogue va publier `has_image` par nœud (ticket 3.1). Le client doit s'en servir pour ne classer
que des œuvres à pochette, et ne plus interroger `/image` œuvre par œuvre comme le fait le palliatif
TRA-794. Tant que le serveur de prod ne publie pas le champ, rien ne doit changer.
Plan : docs/plans/track1-pochettes.md#partie-3, décision D5.

**Précondition** : TRA-794 est mergée sur `main`. Localiser son code par
`git log --grep='TRA-794' --name-only` avant de commencer ; ce ticket a été écrit avant son merge.

## Portée
Fichiers à modifier :
- `ios/Track1Core/Sources/Track1Core/API/APIModels.swift` — `APIKeys` (lignes 3-10), `CatalogNode`
  (lignes 160-173)
- `ios/Track1Core/Sources/Track1Core/Recommendation/Affinity.swift` — `AffinityCandidate`, `rank`
- le fichier où TRA-794 a placé sa vérification `/image` du tirage (à localiser, probablement
  `ios/Track1Core/Sources/Track1Core/Features/Today/TodayViewModel.swift`)
- `ios/Track1Core/Tests/Track1CoreTests/Recommendation/AffinityTests.swift`,
  `ios/Track1Core/Tests/Track1CoreTests/Recommendation/TodayViewModelTests.swift`,
  `ios/Track1Core/Tests/Track1CoreTests/API/APIClientTests.swift`
Hors-scope explicite :
- `DailyRecommendation.swift` (`DailySelection.pick`), `ReminderPlan.swift` : inchangés
- `HeroImageSource.swift` et la demande de `/image` par le hero
- le retrait de la vérification de TRA-794 (ticket 3.3)
- `src/`, `mobile/`

## Contrat
    public struct CatalogNode { … ; public let hasImage: Bool? }        // clé JSON `has_image`
    public struct AffinityCandidate { … ; public let hasImage: Bool? }

- Décodage : clé absente, `null` ou valeur non booléenne → `nil`. Le catalogue ne doit jamais échouer à
  se décoder à cause de ce champ.
- `Affinity.rank`, sur les candidats de score > 0, avant le tri et la troncature à `candidateLimit` :
  - si au moins un candidat a `hasImage != nil` (le serveur publie le drapeau), ne garder que ceux dont
    `hasImage == true` ;
  - si ce filtre ne laisse aucun candidat, garder tous les candidats ;
  - si aucun candidat n'a de valeur (ancien serveur), ne rien filtrer.
- Vérification `/image` de TRA-794 : elle n'est pas faite pour un candidat `hasImage == true`. Elle
  reste inchangée pour tout autre candidat.
- Scores, raisons et ordre relatif des candidats gardés : inchangés.

## Critères d'acceptation
- [ ] Un catalogue sans clé `has_image` se décode, et `rank` rend exactement la liste d'aujourd'hui.
- [ ] Un catalogue dont un nœud a `has_image: "oui"` se décode ; ce nœud a `hasImage == nil`.
- [ ] Drapeau publié, trois candidats dont un `false` : `rank` rend les deux autres, dans l'ordre des scores.
- [ ] Drapeau publié, 70 candidats à pochette et 10 sans, ces derniers mieux notés : `rank` rend 60
      candidats, tous à pochette.
- [ ] Drapeau publié, aucun candidat à pochette : `rank` rend tous les candidats.
- [ ] `TodayViewModel.load` avec un catalogue dont tous les candidats gardés ont `hasImage == true` :
      zéro lecture `/image` sur le lecteur injecté par TRA-794.
- [ ] `TodayViewModel.load` avec un catalogue sans drapeau : mêmes lectures `/image` qu'avant ce ticket.
- [ ] Les sept jours planifiés par `ReminderPlan.plan` sont tous `hasImage == true` quand au moins huit
      candidats à pochette existent.
- [ ] `swift test --package-path ios/Track1Core` vert en local ; `ios-check` vert sur la PR.

## Tests attendus
- unitaire : `AffinityTests.swift` (filtre, replis, troncature), `APIClientTests.swift` (décodage),
  `TodayViewModelTests.swift` (compteur de lectures `/image`, plan des rappels)
- intégration : aucune ; la compilation de l'app est prouvée par `ios-check`

## Tier de risque
tier/2

## Notes d'implémentation
- `AffinityCandidate` est construit à la main dans plusieurs tests : lui donner un `init` explicite
  avec `hasImage: Bool? = nil` pour ne pas réécrire les appels existants.
- Le filtre se place avant `prefix(candidateLimit)` (`Affinity.swift:128`), pas dans
  `DailySelection.pick` : décision D5, à ne pas rediscuter.
- Seul `swift test` tourne en local ; ne pas lancer `ios/scripts/check.sh` (voir `docs/track1-builds.md`).
- Toute valeur du catalogue est une donnée non fiable : pas de `try!`, pas de valeur par défaut `true`.
- Si le code de TRA-794 ne correspond pas à la description du contexte, s'arrêter et le signaler au
  lieu d'adapter le contrat.
```

### TRA-? (3.3) — Retirer la vérification cliente de TRA-794

```markdown
## Contexte
TRA-794 fait vérifier par le client le `/image` de l'œuvre tirée (10 vérifications au plus par
chargement). Depuis que la prod publie `has_image` (ticket 4.2) et que le client le lit (ticket 3.2),
cette vérification ne sert plus : elle coûte des requêtes et un second chemin de décision.
Plan : docs/plans/track1-pochettes.md#partie-3, décision D5.

**Précondition** : le ticket 4.2 est clos, avec la preuve que
`https://dropcliffs.com/api/odyssey/mobile/v1/catalog` porte `has_image` sur tous ses nœuds.

## Portée
Fichiers à modifier :
- les fichiers de `ios/` où TRA-794 a introduit la vérification du tirage et son budget de 10 lectures
  (à lister par `git log --grep='TRA-794' --name-only`), et leurs tests
Hors-scope explicite :
- la demande de `/image` par le hero pour un projet ou une track sans `image_url` (elle reste)
- `Affinity.rank` et le décodage de `has_image` (ticket 3.2)
- `src/`

## Contrat
Après la tâche, `TodayViewModel.load` et `extendPlanIfNeeded` ne lisent plus `/image`. Le tirage ne
dépend que du catalogue. Avec un serveur qui ne publierait pas `has_image`, le tirage redevient celui
d'avant TRA-794 (aucun filtre) : c'est accepté, la prod le publie.

## Critères d'acceptation
- [ ] Aucun appel à `/image` n'est fait pendant `load` ni `extendPlanIfNeeded`, avec ou sans drapeau
      (compteur sur le lecteur d'images injecté dans le test).
- [ ] Le hero d'un projet sans `image_url` demande toujours son propre `/image`.
- [ ] Les tests propres à la vérification de TRA-794 sont supprimés ; aucun autre test n'est modifié.
- [ ] `swift test --package-path ios/Track1Core` vert en local ; `ios-check` vert sur la PR.

## Tests attendus
- unitaire : `TodayViewModelTests.swift`, les deux premiers critères
- intégration : aucune

## Tier de risque
tier/2

## Notes d'implémentation
- Suppression seulement : aucun refactor du tirage au passage.
- Ne pas commencer tant que la précondition n'est pas prouvée dans le ticket 4.2.
```

### TRA-? (4.1) — Passer le lot sur la prod par le canal de données

```markdown
## Contexte
Le cache de prod n'est pas celui du dépôt : `deploy/deploy-server.sh` exclut `cache/`. Les images
trouvées par le lot (ticket 2.3) n'atteignent la prod que par le canal de données, qui rejoue la
migration sur l'union du dépôt et du serveur. Les nœuds n'y gagnent que `image_url` et
`image_source`, que le code de prod du 24/10 connaît : cette action ne dépend d'aucun déploiement de
code. Plan : docs/plans/track1-pochettes.md#partie-4, décision D6.

**Action de Raphael** : elle demande un accès SSH à la prod et le réseau vers MusicBrainz, la Cover
Art Archive, iTunes et Wikidata. Le workflow `sync-genre-cache` est désactivé (runner éteint).

## Portée
Aucun fichier du dépôt n'est modifié.
Hors-scope explicite :
- `deploy/` : aucun changement de script
- tout déploiement de code (ticket 4.2)

## Contrat
Depuis `main` à jour, contenant 2.3 :

    bash deploy/sync-genre-cache.sh --migration 2026-11-21-backfill-missing-images
    bash deploy/sync-genre-cache.sh --migration 2026-11-21-backfill-missing-images --apply

Le premier appel est l'aperçu (manifeste de l'union), le second archive, arrête l'écrivain, transfère,
redémarre et lance le smoke test. Le retour arrière est l'archive que le script imprime.

## Critères d'acceptation
- [ ] L'aperçu sort en 0 et son manifeste a `removed: []` et `renamed: {}`.
- [ ] L'application sort en 0 ; le chemin de l'archive de retour arrière est noté dans le ticket.
- [ ] `GET https://dropcliffs.com/api/odyssey/mobile/v1/nodes/<slug>` rend une `image_url` pour trois
      œuvres que le manifeste de 2.3 liste comme écrites.
- [ ] La couverture `after` du manifeste de prod, par type, est notée dans le ticket.

## Tests attendus
- intégration : le smoke test du script et les trois lectures ci-dessus

## Tier de risque
tier/3 (écriture sur le cache de production)

## Notes d'implémentation
- Si l'aperçu liste des `failed` (source indisponible), relancer plus tard ; ne pas appliquer.
- Le script refuse de s'appliquer si le dépôt a changé pendant la migration : partir d'un arbre propre.
```

### TRA-? (4.2) — Déployer le code serveur et vérifier le drapeau en prod

```markdown
## Contexte
L'échelon track du résolveur (ticket 1.1) et le drapeau `has_image` du catalogue (ticket 3.1) ne
servent à rien tant que la prod tourne sur le code du 24/10. Ce déploiement active le drapeau, donc le
filtre du client (ticket 3.2), et débloque le retrait du palliatif TRA-794 (ticket 3.3).
Plan : docs/plans/track1-pochettes.md#partie-4, décision D6.

**Action de Raphael** : le workflow `deploy` est désactivé (runner éteint) ; le script se lance à la
main avec `ssh-agent`. À faire de préférence après le ticket 4.1, pour que le drapeau reflète le cache
comblé.

## Portée
Aucun fichier du dépôt n'est modifié.
Hors-scope explicite :
- la remise en service des runners ou du workflow `deploy`
- `deploy/` : aucun changement de script

## Contrat
Depuis `main` à jour, contenant 1.1 et 3.1, arbre propre :

    bash deploy/deploy-server.sh

Ce déploiement embarque tout ce qui a été mergé sur `main` depuis le 24/10, pas seulement ce plan.

## Critères d'acceptation
- [ ] `https://dropcliffs.com/api/odyssey/version` rend le SHA de `main` déployé.
- [ ] Tous les nœuds de `GET https://dropcliffs.com/api/odyssey/mobile/v1/catalog` portent un
      `has_image` booléen ; le nombre de projets et de tracks à `true` et à `false` est noté dans le ticket.
- [ ] Le smoke mobile de `docs/track1-api.md` (section du SHA de version, ligne 379) passe.
- [ ] `track:night--dubstep-track-by-benga-and-coki` : la valeur de son `has_image` est notée.
- [ ] Sur une build TestFlight contenant 3.2, l'œuvre du jour d'un profil de test a une pochette.

## Tests attendus
- intégration : les lectures ci-dessus et le smoke mobile

## Tier de risque
tier/3 (déploiement de production)

## Notes d'implémentation
- Relire la liste des commits entre le SHA de prod et `main` avant de lancer : quatre semaines de
  merges partent d'un coup.
- Une fois les critères cochés, le ticket 3.3 peut démarrer.
```
