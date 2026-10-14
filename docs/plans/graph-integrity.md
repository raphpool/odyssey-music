# Intégrité du graphe

Statut : validé par Raphael le 2026-10-14 (« go plan and fix all of these »). Gate humain passé ;
tickets créés le 2026-10-14 dans le projet Linear **P-TRA-5 « Intégrité du graphe »**
(https://linear.app/workspaceperso/project/integrite-du-graphe-2158e2d20296) : 8 milestones,
46 issues TRA-448 à TRA-493. Mesures faites sur le cache committé à
`e04bebc` (581 artistes, 294 projets, 243 tracks, 184 labels, 316 genres, 1 618 nœuds,
21 896 arêtes). Script d'audit de référence : `scripts/audit-cache.ts` (Partie 0).

## Problème

L'identité d'un nœud est son nom. `makeSlug(type, name, disambiguator?)` (`src/slug.ts:36`)
produit `track:fitna` ; le suffixe `--` n'est posé que si l'appelant le passe, ce que presque
personne ne fait (`normalizeEdge`, `src/pipeline.ts:1438`, est toujours nu ; 75 slugs
disambigués sur 1 618). Conséquences mesurées :

1. **Mauvaise track au clic.** 85 arêtes `discography` et 26 arêtes `notable_tracks` d'artistes
   pointent vers un nœud existant qui **ne crédite pas** l'artiste source (Rohff → `track:fitna`
   d'Akuma, Apparat → `project:lp5` d'Autechre, Pole → `project:3` d'Aphex Twin…). Deux chemins :
   le crawler dédoublonne la frontier par slug d'arête (`src/crawler.ts:676-713`, clé `e.slug`) et
   le clic JIT du front envoie le nom seul (`web/index.html:2245-2316`, commentaire l.2230-2232)
   ; `handleMaterialize` rattache alors au premier nœud qui porte ce slug
   (`src/services/materialize-service.ts:152-163`, « identity wins »). 53 autres liens vont vers
   un nœud sans aucun artiste.
2. **Albums sans arêtes.** 36 projets, 5 tracks et 3 artistes à zéro arête, tous matérialisés
   en mai 2026 (`project:new-forms` de Roni Size inclus). 92 projets et 38 tracks ont
   `artists: []` : le schéma ne l'interdit pas (`src/schemas.ts:153,172`).
3. **Arêtes inverses manquantes.** `REVERSE_EDGE_PAIRS` (`src/node-spec.ts:120-145`) ne couvre
   que genre↔genre, influences, collaborators, aliases, members, samples, remix. Mesure :
   277/458 liens artiste → label sans l'artiste dans `roster` ; 111/211 liens artiste → projet
   sans l'artiste dans `project.artists` ; 128/309 `label.roster` non reflétés dans
   `artist.labels` ; 246/577 `genre.key_artists` non reflétés dans `artist.genres` ; 41 tracks
   dont le projet existe sans la track dans `tracklist`.
4. **Images.** Couverture : artistes 164/581, projets 79/294, tracks 19/243, labels 0/184,
   genres 0/316. Les genres et labels n'ont **aucun champ image** (`src/types.ts`,
   `src/schemas.ts`). `GET /image/:slug` emprunte une cover iTunes prise sans vérifier ni
   l'artiste ni le titre (`src/itunes.ts:133-151`, `limit=1`) et **l'écrit dans le nœud**
   (`src/services/image-service.ts:41-46`). Le graphe live et mobile ne projette jamais
   `image_url` (`src/graph.ts:218-228`, option `includeImageUrls` réservée au build statique) :
   sur iOS une page projet n'a aucun candidat d'image (`HeroImageSource.swift:32-38`), un genre
   dépend d'un JIT qui échoue le plus souvent.
5. **Descriptions.** La longueur est bonne (médiane ≈ 1 550 caractères) ; le défaut est la
   source unique : 139 artistes et 34 labels (99 projets, 63 tracks, 135 genres) n'ont qu'une
   citation. Cause : avec Wikipédia dans le top 4, le pipeline ne lit **qu'une** page
   (`src/pipeline.ts:769-773`, `PIPELINE_FETCH_TOP_K_WITH_WIKI=1`). Bug annexe : 760 articles et
   8 bios contiennent un `\n` littéral (backslash + n) rendu tel quel (`web/index.html:1902`,
   `white-space: pre-wrap`) ; aucun post-traitement du texte dans `canonicalizeDraft`.
6. **Champs absents.** Pas de `similar_artists`, pas d'album phare ni de titre de référence sur
   l'artiste.

## Non-buts

- Refaire la recommandation, la grille de genres ou la recherche.
- Renommer `photo_url` / `cover_url` : ils restent lus ; le nouveau champ `image_url` les
  recouvre.
- Re-matérialiser massivement le cache par LLM (≈ 10 $ + 1 618 crédits Tavily / 3 236 Firecrawl)
  : tous les backfills sont déterministes (MusicBrainz, Wikidata, Cover Art Archive,
  ListenBrainz) sauf le ré-enrichissement textuel ciblé de la Partie 6.
- Changer la sémantique symétrique de `members` ni ajouter `member_of`.
- Importer dans l'app iOS autre chose que l'affichage des nouveaux champs.
- Résoudre les 13 828 arêtes pendantes (cibles jamais matérialisées) : c'est l'état normal
  de la frontier ; on garantit seulement qu'elles portent un slug scopé.

## Cartographie (acquis vérifiés)

- Cache : `cache/nodes/<type>/<body>.json` (`src/cache.ts:102-105`), `NodeCache`
  `has/get/listSlugs/write/replace`, pas de `delete` (les migrations font `rm`). Les arêtes
  inverses sont posées à l'écriture (`emitReverses`, `src/cache.ts:432-455`) ou mises en attente
  dans `cache/pending-reverses.json` (1 144 clés, 2 cibles existantes : état normal).
- Redirections : `data/genre-redirects.json`, **genre uniquement** (`parseGenreRedirects`,
  `src/genre-registry.ts:64-84`), lues par server, node-service, image-service, mobile/nodes,
  crawler, graph (`redirects` dans data.json), taxonomie.
- Migrations : `tsx scripts/migrations/<fichier>.ts <cache-dir> [--apply]`, dry-run par défaut ;
  helpers de fait dans `scripts/migrations/2026-09-04-merge-genre-duplicates.ts`
  (`rewriteNodeEdges`, `mergeRedirects`, `rewritePendingReverses`, `readCacheNodes`,
  `parseCliArgs`) ; modèle de renommage : `2026-09-10-rename-genre-node.ts`.
- Prod (D5) : serveur `root@46.101.167.241`, cache `/opt/odyssey-music/cache`
  (`ODYSSEY_CACHE_DIR`, `deploy/bootstrap-env.sh:45`), unité systemd `odyssey-server.service`.
  `deploy/deploy-server.sh` exclut `cache/` et rapatrie les nœuds nouveaux **dans le checkout du
  runner seulement** (`--ignore-existing`, l.86-87), jamais committés. Le seul canal repo → prod
  est `deploy/sync-genre-cache.sh` (manuel, union validée, service arrêté, empreinte vérifiée,
  rsync sans `--delete`, suppressions explicites, redirections expédiées). Une migration atteint
  la prod **par ce canal, sur l'union snapshot-prod ∪ dépôt**, jamais par rsync direct.
- CI (`.github/workflows/ci.yml`) : typecheck, lint, test, diff-size, tier-guard. Aucune
  vérification du cache (`scripts/assert-cache.ts` ne tourne que dans `verify-e2e.sh`).
- MusicBrainz : `mbFetch` (`src/musicbrainz.ts:231-281`) a un cache 5 min et des retries, **aucun
  throttle** ; `findReleaseGroupMbidByName` (l.779-791) prend `results[0]` sans vérifier le titre
  (vérifié le 2026-10-14 : « New Forms » renvoie « New Forms² » en premier). Le MBID n'est
  stocké sur aucun nœud (0/1 618) alors que `baseFields.mbid` existe (`src/schemas.ts:86`).
- Sources externes vérifiées le 2026-10-14 : ListenBrainz labs
  `GET https://labs.api.listenbrainz.org/similar-artists/json?artist_mbids=<mbid>&algorithm=…`
  (sans clé, tableau `{artist_mbid, name, score, …}`) ; Cover Art Archive
  `GET https://coverartarchive.org/release-group/<mbid>/front-500` (307 → archive.org, 404 si
  absent, pas de limite documentée) ; Wikidata `wbgetentities` P18 (photo), P154 (logo), P434 /
  P966 (MBID artiste / label) ; MusicBrainz `inc=url-rels` fournit le lien Wikidata d'un artiste
  (Roni Size → Q964002 → P18 `Roni Size.jpg` → `https://commons.wikimedia.org/wiki/Special:FilePath/<fichier>?width=600`
  → 301 vers upload.wikimedia.org). Warp (Q543707) n'a ni P18 ni P154 : un repli par cover
  d'une sortie notable est nécessaire.
- iOS : `NodeDetail` décode `image_url` (`APIModels.swift:112-142`), `GenerationRequest`
  (`APIModels.swift:316-340`) porte `type, name, slug, mbid, qid, disambiguator` ; l'ordre des
  sections est dans `ios/Track1Core/Sources/Track1Core/Features/Node/NodePageSpec.swift`, couplé
  côté serveur par `test/ios-node-page-spec.test.ts`.

## Décisions d'archi

**1. L'identité d'une œuvre est `<titre>--<artiste principal>` ; le MBID est un champ, pas une
partie du slug.** `project:new-forms--roni-size-reprazent`, `track:fitna--rohff`, toujours, même
sans homonyme. L'artiste principal est le **crédit MusicBrainz** quand le MBID est résolu, sinon
l'indication `artist` portée par l'arête, sinon (arête émise depuis un artiste) l'artiste source.
Rejeté — le MBID dans le slug : illisible dans l'URL, et inconnu au moment où le LLM émet
l'arête, donc deux slugs pour une même œuvre selon l'émetteur. Rejeté — disambiguer seulement en
cas de collision : la collision est détectée après coup et « premier arrivé gagne » est
exactement le bug. *Décision nouvelle à confirmer par Raphael : le MBID est stocké dans
`mbid` et n'entre pas dans le slug.*

**2. Une arête d'œuvre sans artiste est abandonnée à la canonicalisation.** Le `responseSchema`
Gemini exige `artist` sur toute référence `project`/`track` ; `normalizeEdge` rejette ce qui
n'en a pas (sauf depuis un nœud artiste, qui fournit le sien). Rejeté — garder l'arête nue et
la résoudre plus tard : c'est le mécanisme actuel qui verrouille les homonymes.

**3. Un lien ne se rattache à un nœud existant que si ce nœud crédite l'artiste source, ou
crédite un groupe dont il est membre.** Personne et groupe sont deux nœuds artiste distincts,
alignés sur MusicBrainz (`artist_kind: "person" | "group"`), reliés par `members`. Roni Size
(personne) garde New Forms dans sa discographie parce qu'il est membre de Roni Size / Reprazent
(relation MB « member of band »). Le slug canonique appris après enrichissement **corrige
l'arête demandeuse en place** (crawler et `/materialize`) ; les renommages de migration passent
par une table de redirections **généralisée à tous les types** (`data/slug-redirects.json`,
même format que la table genre). Rejeté — une table de redirections écrite à l'exécution : elle
serait écrasée par le rsync de `data/` à chaque déploiement.

**4. Les artistes homonymes se distinguent par le MBID : même corps de slug + MBID différent →
suffixe `--<disambiguation MB normalisée>` ; même MBID → fusion.** Le slug artiste reste nominal
(les URL existantes survivent). Rejeté — scoper les artistes par pays ou année : non déterministe
sans source.

**5. Une image par nœud, résolue par une échelle déterministe et stockée dans `image_url` +
`image_source` sur tous les types.** Projet/track : Cover Art Archive par MBID de release-group →
iTunes **vérifié** (artiste + titre, `limit=5`) → cover du projet parent (track). Artiste :
Wikidata P18 via MBID → cover de `landmark_project` (source `derived-cover`, jamais présentée
comme une photo). Label : P154 → P18 → cover d'une sortie notable. Genre : cover du premier
`landmark_projects` imagé, puis `landmark_tracks`. Hôtes autorisés listés dans le code ; `GET
/image` ne fait plus **aucune écriture** ; la projection inclut `image_url` partout (live,
mobile, statique). Rejeté — étendre `photo_url`/`cover_url` aux genres et labels : trois noms pour
un même concept dans le front et iOS ; rejeté — continuer l'emprunt iTunes à la lecture : c'est
la compilation d'Earth, Wind & Fire sur Grandmaster Flash.

**6. `similar_artists` vient de ListenBrainz (labs, par MBID, 10 entrées max), avec repli calculé
depuis le graphe ; jamais du LLM.** Repli : score = 3 × collaborateurs communs + 2 × labels
communs + 1 × genres communs parmi les artistes du cache. Rejeté — Last.fm : clé API et CGU
commerciales ; rejeté — Gemini : coût par nœud et hallucinations d'homonymes.

**7. `landmark_project` et `reference_track` sont deux arêtes singulières de l'artiste, choisies
dans `discography` / `notable_tracks`.** Pour les nouveaux nœuds, le LLM choisit (même appel) ;
`canonicalizeDraft` impose l'appartenance aux listes, sinon premier élément. Pour les 581
existants, backfill déterministe : élément cité par un `landmark_projects` / `landmark_tracks`
de genre, sinon élément imagé, sinon premier. Rejeté — ré-appeler le LLM pour 581 artistes
(≈ 3,5 $ et ré-dérivation des arêtes).

**8. Plus de re-matérialisation automatique à la lecture.** `GET /node/:slug` relance le
pipeline complet pour tout nœud de plus de 12 h (`src/services/node-service.ts:44-61`,
`ODYSSEY_NODE_TTL_MS`) : la prod diverge silencieusement du dépôt, les arêtes sont ré-émises
nues, chaque lecture coûte un appel LLM. Le rafraîchissement n'existe plus qu'en explicite
(`POST /materialize?fresh=1`). *Ajout planner, décision nouvelle.*

**9. L'audit d'intégrité est un script déterministe, exécuté en CI sur `cache/`, avec des seuils
committés qui ne peuvent que baisser.** `data/integrity-thresholds.json` est versionné ; le job
CI refuse toute hausse d'un seuil par rapport à `main`. Rejeté — des tests vitest unitaires par
invariant : ils ne mesurent pas le corpus réel.

**10. Les backfills sont hors ligne, idempotents, dry-run par défaut, limités à 1 req/s vers
MusicBrainz, et atteignent la prod par le canal d'union.** Même convention que
`qid-genre-identity.md` (décision 6). Ordre : identité d'abord (D1), puis images, inverses et
similaires en parallèle (≤ 3 agents).

## Découpage

Chaque tâche = un ticket Linear ; `[P]` = parallélisable avec les autres `[P]` de sa vague.
Les tiers suivent `tiers.md` ; `scripts/migrations/`, `deploy/` et `.github/` s'escaladent en
tier/3 automatiquement.

### Partie 0 — Audit d'intégrité et garde-fous

Livrable seul : mesure le corpus, bloque les régressions, retire les deux comportements qui
corrompent la prod à la lecture. Aucune dépendance.

- [ ] TRA-448 0.1 `[P]` Écrire l'audit d'intégrité du cache (`scripts/audit-cache.ts`, seuils
      committés) — tier/2, 3 pts
- [ ] TRA-461 0.2 Exécuter l'audit en CI avec cliquet des seuils — tier/3, 2 pts (dépend de 0.1)
- [ ] TRA-449 0.3 `[P]` Supprimer la re-matérialisation automatique à la lecture (TTL 12 h) —
      tier/2, 2 pts (ajout planner)
- [ ] TRA-450 0.4 `[P]` Limiter `mbFetch` à 1 requête MusicBrainz par seconde — tier/2, 2 pts
      (ajout planner, prérequis des backfills)

### Partie 1 — Identité des œuvres et des artistes

Livrable en deux temps : le code (1.1 → 1.9) est déployable sans migration, les nouveaux nœuds
naissent scopés ; la migration (1.10 → 1.15) renomme l'existant avec redirections, puis le
schéma se durcit (1.16).

- [ ] TRA-451 1.1 `[P]` Déclarer `EdgeRef.artist`, `artist_kind` et les helpers de slug scopé —
      tier/3, 3 pts
- [ ] TRA-452 1.2 `[P]` Résoudre les crédits MusicBrainz : titre exact, crédit artiste,
      appartenance à un groupe — tier/2, 3 pts
- [ ] TRA-462 1.3 Émettre des slugs scopés dans `normalizeEdge` et exiger `artist` dans le schéma
      Gemini — tier/2, 3 pts (dépend de 1.1)
- [ ] TRA-473 1.4 Poser `mbid`, `artist_kind` et le crédit MusicBrainz à l'enrichissement, recalculer
      le slug canonique — tier/2, 3 pts (dépend de 1.2, 1.3)
- [ ] TRA-476 1.5 `[P]` Propager le contexte artiste dans le crawler et corriger l'arête parente
      (test Rohff → Fitna) — tier/2, 3 pts (dépend de 1.4)
- [ ] TRA-477 1.6 `[P]` Faire porter le contexte artiste par `/materialize` et rattacher selon le
      crédit — tier/2, 3 pts (dépend de 1.4)
- [ ] TRA-481 1.7 `[P]` Envoyer le contexte artiste depuis le front web au clic JIT — tier/2, 2 pts
      (dépend de 1.6)
- [ ] TRA-482 1.8 `[P]` Envoyer le contexte artiste dans les générations iOS — tier/2, 2 pts
      (dépend de 1.6)
- [ ] TRA-453 1.9 `[P]` Généraliser la table de redirections à tous les types de nœuds — tier/2,
      2 pts
- [ ] TRA-463 1.10 Backfill de l'identité des artistes (`mbid`, `artist_kind`, collisions) —
      tier/3, 3 pts (dépend de 1.1, 1.2, 0.4)
- [ ] TRA-474 1.11 Backfill de l'identité des œuvres (`mbid`, crédit `artists`) — tier/3, 3 pts
      (dépend de 1.10)
- [ ] TRA-478 1.12 Migration : scoper les slugs d'œuvres, réécrire ou détacher les arêtes
      entrantes, fusionner les doublons — tier/3, 5 pts (dépend de 1.9, 1.11)
- [ ] TRA-483 1.13 Exécuter la migration d'identité sur le cache du dépôt — tier/3, 2 pts
      (dépend de 1.12, 0.1)
- [ ] TRA-464 1.14 `[P]` Généraliser `deploy/sync-genre-cache.sh` en canal de migration vers la
      prod — tier/3, 3 pts (dépend de 1.9)
- [ ] TRA-484 1.15 Appliquer la migration d'identité au cache de prod — tier/3, 2 pts (dépend de
      1.13, 1.14)
- [ ] TRA-485 1.16 Exiger au moins un artiste sur les projets et les tracks — tier/3, 1 pt
      (dépend de 1.13)

### Partie 2 — Arêtes inverses

- [ ] TRA-454 2.1 `[P]` Étendre `REVERSE_EDGE_PAIRS` aux relations inter-types — tier/2, 2 pts
- [ ] TRA-486 2.2 Migration : backfill des arêtes inverses manquantes — tier/3, 2 pts (dépend de
      2.1, 1.13)
- [ ] TRA-488 2.3 Exécuter le backfill des inverses sur le dépôt et la prod — tier/3, 1 pt
      (dépend de 2.2, 1.15)

### Partie 3 — Images

- [ ] TRA-455 3.1 `[P]` Déclarer `image_url` et `image_source` sur tous les nœuds et les projeter
      partout — tier/3, 2 pts
- [ ] TRA-465 3.2 Résolveur d'images déterministe (Cover Art Archive, Wikidata P18/P154, iTunes
      vérifié) — tier/2, 5 pts (dépend de 3.1, 1.2, 0.4)
- [ ] TRA-475 3.3 `[P]` Servir l'image stockée sans écrire : refonte de `GET /image` — tier/2,
      3 pts (dépend de 3.2)
- [ ] TRA-479 3.4 `[P]` Résoudre l'image à la matérialisation d'un nœud — tier/2, 2 pts (dépend
      de 3.2, 1.4)
- [ ] TRA-489 3.5 Backfill des images sur tout le cache (dépôt + prod) — tier/3, 3 pts (dépend de
      3.3, 1.15)
- [ ] TRA-466 3.6 `[P]` Afficher `image_url` sur le web pour tous les types — tier/2, 2 pts
      (dépend de 3.1)
- [ ] TRA-467 3.7 `[P]` Afficher l'image de chaque nœud dans l'app iOS — tier/2, 2 pts (dépend
      de 3.1)

### Partie 4 — Artistes similaires

- [ ] TRA-456 4.1 `[P]` Déclarer `similar_artists` sur les artistes — tier/3, 2 pts
- [ ] TRA-468 4.2 Client ListenBrainz et repli calculé depuis le graphe — tier/2, 3 pts (dépend
      de 4.1)
- [ ] TRA-490 4.3 `[P]` Backfill `similar_artists` sur les artistes (dépôt + prod) — tier/3, 2 pts
      (dépend de 4.2, 1.15)
- [ ] TRA-480 4.4 `[P]` Attacher `similar_artists` à la matérialisation d'un artiste — tier/2,
      1 pt (dépend de 4.2, 1.4)
- [ ] TRA-469 4.5 `[P]` Afficher les artistes similaires sur le web et dans l'app iOS — tier/2,
      2 pts (dépend de 4.1)

### Partie 5 — Album phare et titre de référence

- [ ] TRA-457 5.1 `[P]` Déclarer `landmark_project` et `reference_track` sur les artistes —
      tier/3, 2 pts
- [ ] TRA-470 5.2 `[P]` Faire choisir l'album phare et le titre de référence par le pipeline —
      tier/2, 2 pts (dépend de 5.1)
- [ ] TRA-491 5.3 `[P]` Backfill déterministe de l'album phare et du titre de référence (dépôt +
      prod) — tier/3, 2 pts (dépend de 5.1, 1.15)
- [ ] TRA-471 5.4 `[P]` Afficher l'album phare et le titre de référence dans l'app iOS — tier/2,
      3 pts (dépend de 5.1)
- [ ] TRA-472 5.5 `[P]` Afficher l'album phare et le titre de référence sur le web — tier/2, 1 pt
      (dépend de 5.1)

### Partie 6 — Descriptions

- [ ] TRA-458 6.1 `[P]` Normaliser les retours à la ligne échappés dans les textes générés —
      tier/2, 1 pt
- [ ] TRA-492 6.2 Migration : déséchapper les `\n` littéraux des 768 nœuds (dépôt + prod) —
      tier/3, 1 pt (dépend de 6.1, 1.15)
- [ ] TRA-459 6.3 `[P]` Garantir au moins deux pages sources dans le corpus de recherche —
      tier/2, 2 pts
- [ ] TRA-487 6.4 Ré-enrichir le texte des artistes et labels à source unique — tier/2, 3 pts
      (dépend de 6.1, 6.3, 1.13)

### Partie 7 — Hygiène du dépôt et de la prod (ajouts planner)

- [ ] TRA-460 7.1 `[P]` Cesser de versionner `web/data.json` — tier/2, 1 pt
- [ ] TRA-493 7.2 Rapatrier les nœuds JIT de prod dans le dépôt par PR — tier/3, 3 pts (dépend
      de 0.1, 1.15)

### Ordre d'attaque et parallélisme (≤ 3 agents)

1. Vague A (3 lanes) : 0.1 + 0.3 + 0.4 ; puis 0.2. En parallèle : 1.1, 1.2, 1.9, 6.1, 6.3, 7.1.
2. Vague B (identité, séquentielle au cœur) : 1.3 → 1.4 → {1.5, 1.6} → {1.7, 1.8} ;
   1.10 → 1.11 → 1.12 → 1.13 → 1.16 ; 1.14 dès 1.9, puis 1.15.
3. Vague C (3 lanes après 1.15) : images 3.1 → 3.2 → {3.3, 3.4} → 3.5 → {3.6, 3.7} ;
   inverses 2.1 → 2.2 → 2.3 ; similaires 4.1 → 4.2 → {4.3, 4.4} → 4.5.
4. Vague D : 5.1 → {5.2, 5.3, 5.4, 5.5} ; 6.2, 6.4 ; 7.2.

Les tickets 3.1, 4.1, 5.1 touchent tous `src/schemas.ts` / `src/types.ts` / `src/node-spec.ts` :
les enchaîner (pas trois PR ouvertes en même temps sur le schéma).

## Ajouts planner (défauts trouvés pendant la cartographie)

| # | Défaut | Preuve | Traité par |
|---|---|---|---|
| A1 | Re-matérialisation complète à la lecture de tout nœud > 12 h | `src/services/node-service.ts:44-61`, `materialize-service.ts:249` ; commentaire interne « 62 such nodes exist in the real cache today » | 0.3 |
| A2 | `image_source` déclaré dans `types.ts:50` mais absent de `schemas.ts` → supprimé par Zod (0 fichier le contient) ; `GET /image` écrit une cover iTunes non vérifiée dans le nœud | `image-service.ts:41-46`, `itunes.ts:133-151` | 3.1, 3.3 |
| A3 | 13 auto-arêtes `members` (artist:cartola, victor-uwaifo, anibal-troilo, namie-amuro, prince-buster…) | audit `self-edges` | 1.3, 1.12 |
| A4 | 6 paires de doublons par nom normalisé : `track:the-model`/`--song-by-kraftwerk`, `track:moire--…` ×2, `track:baby-wants-to-ride--…` ×2, `track:four-violins`/`--1964-drone-piece-by-tony-conrad`, `label:e-g-records`/`eg-records`, `artist:pole`/`pole--stefan-betke` | audit `duplicates` | 1.10, 1.12 |
| A5 | 92 projets et 38 tracks avec `artists: []` (dont les 36 projets sans arête) | audit `empty-artists` | 1.11, 1.16 |
| A6 | `findReleaseGroupMbidByName` prend `results[0]` sans vérifier le titre (« New Forms » → « New Forms² ») | `src/musicbrainz.ts:779-791`, requête MB du 2026-10-14 | 1.2 |
| A7 | Le crawler jette `e.mbid` en construisant l'entrée de frontier | `src/crawler.ts:699-700` | 1.5 |
| A8 | Réciprocité manquante hors D3 : 41 tracks absentes de la `tracklist` de leur projet, 246/577 `key_artists` sans genre côté artiste, 128/309 `roster` sans label côté artiste | audit `reciprocity` | 2.1–2.3 |
| A9 | `web/data.json` committé périmé (généré le 2026-05-21, 1 392 nœuds contre 1 618, 23 slugs fantômes) et jamais lu depuis le dépôt (le front lit l'API puis le fichier déployé) | `git log -- web/data.json`, `scripts/deploy-web.sh:65-68` | 7.1 |
| A10 | Les nœuds JIT de prod ne reviennent jamais dans le dépôt (rapatriement `--ignore-existing` dans le runner, dernier pull manuel `1e6055c` 2026-05-14) | `deploy/deploy-server.sh:86-87` | 7.2 |
| A11 | Aucun throttle MusicBrainz (politique MB : 1 req/s) | `src/musicbrainz.ts:231-281` | 0.4 |
| A12 | La CI ne vérifie jamais le cache | `.github/workflows/ci.yml`, `scripts/assert-cache.ts` hors CI | 0.1, 0.2 |
| A13 | 760 articles + 8 bios avec `\n` littéral ; aucun post-traitement texte | audit `literal-newlines`, `pipeline.ts:1321-1420` | 6.1, 6.2 |
| A14 | Corpus à page unique quand Wikipédia est dans le top 4 → 139 artistes / 34 labels à citation unique | `src/pipeline.ts:769-773` | 6.3, 6.4 |
| A15 | 29 arêtes dont `name` diverge du nom du nœud cible (alias : « Rhythm And Blues » → R&B, « Filmi » → Indian Film Music) | audit `edge-name-drift` | mesuré seulement (métrique informative) |

## Coûts estimés

- LLM : 0 $ pour les Parties 0–5 et 7. Partie 6.4 : 173 nœuds (139 artistes + 34 labels) ×
  ≈ 0,006 $ ≈ 1,1 $ Gemini + 173 recherches Tavily. Rejeté : re-matérialisation complète
  (≈ 10 $ + 1 618 Tavily / 3 236 crédits Firecrawl + ré-dérivation de toutes les arêtes).
- MusicBrainz (1 req/s) : identité artistes ≈ 1 700 appels (recherche + entité + relations),
  œuvres ≈ 1 100, images ≈ 1 200 (url-rels), soit ≈ 70 min au total, en plusieurs runs
  reprenables. Cover Art Archive ≈ 540 appels, Wikidata ≈ 800, ListenBrainz ≈ 580 (1 req/s,
  ≈ 10 min).
- Diff : chaque migration dépasse probablement 200 lignes (script + test) ; la règle
  ≤ 600 lignes de Raphael s'applique, le découpage code / exécution est déjà fait.

## Risques

- **Renommer 537 slugs d'œuvres casse les liens existants** (URL web `?node=`, récents iOS,
  reco du jour stockée sur le téléphone). Garde-fou : table `data/slug-redirects.json` lue par
  tous les chemins de lecture (1.9) et expédiée en prod avec la migration (1.14) ; test de
  `GET /node/<ancien slug>` → `redirected_from`.
- **Résolution MusicBrainz erronée** (homonyme pris pour un autre) → identité fausse écrite en
  masse. Garde-fou : correspondance exacte du titre normalisé **et** du crédit (1.2), score ≥ 90
  pour les artistes, manifeste dry-run relu avant `--apply`, nœuds non résolus laissés intacts et
  comptés par l'audit.
- **Divergence prod / dépôt pendant la migration** (un JIT écrit entre le snapshot et le push).
  Garde-fou : le canal d'union arrête le service et vérifie l'empreinte (existant), et 0.3
  supprime la principale source d'écritures spontanées.
- **Ballonnement des arêtes inverses** (`track.artists → artist.notable_tracks` ajoute une entrée
  par track crédité). Garde-fou : les paires asymétriques sont listées explicitement (pas de
  `artist.genres → genre.key_artists`), et l'audit mesure la taille médiane des listes.
- **Images dérivées présentées comme des photos** (cover d'album sur une fiche artiste).
  Garde-fou : `image_source: "derived-cover"` projeté ; le front et iOS gardent le dégradé de
  type en fond et ne légendent pas la cover comme portrait.
- **Rate limit ou indisponibilité de ListenBrainz labs** (API sans SLA). Garde-fou : repli graphe
  déterministe (4.2), backfill reprenable, aucun appel en lecture.
- **Le durcissement `artists.min(1)` (1.16) casse la lecture des nœuds encore vides.** Garde-fou :
  ordre imposé 1.11 → 1.13 → 1.16 ; l'audit exige `empty-artists = 0` avant 1.16.
- **Trois tickets de schéma concurrents** (3.1, 4.1, 5.1). Garde-fou : enchaînés, jamais
  ouverts en même temps.

## Critères de sortie

- Audit en CI vert avec les seuils finaux : liens d'œuvres vers un homonyme = 0, nœuds sans
  arête = 0, projets/tracks sans artiste = 0, auto-arêtes = 0, doublons = 0, réciprocité
  manquante = 0 pour toutes les paires déclarées, `\n` littéraux = 0, slugs d'œuvres non scopés
  = 0, nœuds sans `image_url` = 0 par type (dérivé compris), artistes sans `similar_artists` = 0,
  artistes sans `landmark_project` = 0 (quand la discographie est non vide), artistes et labels
  à citation unique = 0.
- Rohff → Fitna, Apparat → LP5, Pole → 3, Roni Size → New Forms : le clic (web et iOS) ouvre
  la bonne œuvre ; `project:new-forms--roni-size-reprazent` crédite Roni Size / Reprazent, liste
  ses tracks et son label ; Roni Size est membre du groupe.
- `GET /node/track:fitna` répond avec `redirected_from` vers le slug scopé ; le cache de prod et
  le dépôt passent le même audit avec les mêmes seuils.
- Chaque fiche (web 320 px et desktop, iOS) affiche une image ; genres et labels compris ;
  Grandmaster Flash n'affiche plus une compilation d'Earth, Wind & Fire.
- Les fiches artiste iOS affichent « Album phare », « Titre de référence » et « Artistes
  similaires ».
- Aucune re-matérialisation sans `POST /materialize?fresh=1` explicite ; `GET /image` n'écrit
  plus rien.
