# Intégrité du graphe

Statut : validé par Raphael le 2026-10-14 (« go plan and fix all of these »). Gate humain passé ;
tickets créés le 2026-10-14 dans le projet Linear **P-TRA-5 « Intégrité du graphe »**
(https://linear.app/workspaceperso/project/integrite-du-graphe-2158e2d20296) : 8 milestones,
46 issues TRA-448 à TRA-493. Mesures faites sur le cache committé à
`e04bebc` (581 artistes, 294 projets, 243 tracks, 184 labels, 316 genres, 1 618 nœuds,
21 896 arêtes). Script d'audit de référence : `scripts/audit-cache.ts` (Partie 0).
Addendum du 2026-10-16 : « Partie 3b — Pochettes à la demande » en fin de document, validée par
Raphael le 2026-10-16 (« ok plan »).

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
- [ ] TRA-509 1.18 Activer les slugs d'œuvres scopés en prod (bascule du drapeau) — tier/3, 1 pt
      (dépend de tout ce qui précède : voir « Bascule du drapeau (TRA-509) » ci-dessous)

#### Bascule du drapeau (TRA-509)

Tout le comportement « slug d'identité » de la Partie 1 (slugs d'œuvres `<titre>--<artiste>`,
translittération `ø æ œ ł ß đ þ`, contexte artiste de `/materialize`) est derrière
`ODYSSEY_SCOPED_RELEASE_SLUGS` (`src/flags.ts`, **désactivé par défaut**). Chaque merge sur `main`
déploie en prod : la bascule est donc le seul incrément qui change le comportement de la prod, et
elle ne doit être mergée qu'une fois les deux caches migrés.

**Mécanisme retenu.** `Environment=ODYSSEY_SCOPED_RELEASE_SLUGS=1` dans l'unité systemd
`odyssey-server.service`, telle que la génère `deploy/deploy-server.sh`. Pourquoi pas
`deploy/bootstrap-env.sh` : il n'est joué qu'à la main, au provisioning ou à un changement de clé, et
un déploiement ne réécrit jamais `/etc/odyssey-music.env` (les clés d'API vivent sur un seul hôte et
ne transitent pas par la CI). Une variable posée là n'atteindrait le service qu'au prochain bootstrap manuel. L'unité,
elle, est réécrite, suivie de `daemon-reload` et `restart`, à **chaque** déploiement : le merge de la
PR TRA-509 suffit. Conséquence à connaître : systemd donne priorité à `EnvironmentFile=` sur
`Environment=`, donc une ligne `ODYSSEY_SCOPED_RELEASE_SLUGS=...` écrite dans
`/etc/odyssey-music.env` l'emporte sur l'unité. Le déploiement lit l'environnement du processus en cours
(`/proc/<MainPID>/environ`), affiche la valeur réellement reçue (`-> ODYSSEY_SCOPED_RELEASE_SLUGS=1 in
the running service (unit: 1)`) et émet un `WARN` (sans échouer : un coupe-feu volontaire ne doit pas
bloquer les déploiements) quand elle diffère de celle de l'unité ou que le service n'est pas levé.
L'écart est aussi publié en annotation GitHub (`::warning title=... mismatch::`, sur la sortie
standard relayée par ssh) pour apparaître dans le résumé du run. Test :
`test/scoped-slugs-deploy-flag.test.ts` (exécute ce bloc contre un `systemctl` et un `/proc` factices).
Ce test ne dépend pas de la valeur commitée : il exige une seule ligne `Environment=ODYSSEY_SCOPED_RELEASE_SLUGS=0|1`
dans le script courant, en tire deux copies (forcée à `1`, forcée à `0`) et rejoue les mêmes
vérifications sur chacune. Il reste donc vert que le script porte `1` (livré par TRA-509) ou `0`
(commit de rollback) : `deploy.yml` lance `npm run test` **avant** `Deploy server`, un test qui exigerait
l'une des valeurs arrêterait le rollback au lieu de le déployer. Preuve : la ligne passée vraiment à `0`
dans une copie, `vitest run test/scoped-slugs-deploy-flag.test.ts` donne 17 tests verts (voir la PR). La
valeur livrée (1) est documentée ici, pas assertée.

**Défaut de `src/config.ts` / `src/flags.ts` : inchangé (désactivé).** Le critère « tous les tests et
l'audit passent avec le drapeau à 1 » n'est pas la bonne mesure : le défaut s'applique à *tous* les
processus qui fabriquent des slugs (crawler local, workflows `top-up-genres`, migrations de
`deploy/sync-genre-cache.sh`, qui fixe volontairement le drapeau à 0 pour les backfills d'artistes et
d'œuvres, puis à 1 pour la seule étape de scoping). Le basculer ici ferait écrire des slugs scopés à
un crawl local sur un cache qui ne l'est pas encore. La prod est le seul environnement à activer.

**Prérequis avant de passer la PR de « brouillon » à « prête » (aucun garde-fou de code ne les
vérifie : le merge déploie le drapeau à 1, sans condition) :**

- tous les `blockedBy` de TRA-509 mergés (TRA-477, 481, 482, 462, 473, 476, 563, 538, 546, 547,
  558, 483, 484) ;
- `npm run audit:cache -- cache` vert, `unscoped-release-slugs` au niveau attendu après TRA-483 (avant
  la migration du dépôt : 463) ;
- TRA-484 appliqué et vérifié : un échantillon de nœuds scopés se lit via `GET /node/<slug scopé>`
  et un ancien slug répond avec `redirected_from`.

**Après merge (à vérifier, `API=https://dropcliffs.com/api/odyssey`)** :

```bash
API=https://dropcliffs.com/api/odyssey

# 1. Le déploiement du merge est bien en ligne (sha_short = celui du merge de la PR TRA-509).
curl -fsS "$API/version" | jq '{sha_short, deployed_at}'

# 2. Lecture : un nœud migré par son slug scopé, et par son ancien slug (redirection).
curl -fsS "$API/node/project:<titre>--<artiste>" | jq '{slug: .node.slug, artists: .node.artists}'
curl -fsS "$API/node/project:<titre>"            | jq '{slug: .node.slug, redirected_from}'

# 3. JIT d'un artiste de test (absent du cache : GET /node/artist:<slug> répond 404 avant).
curl -fsS -X POST "$API/materialize" -H 'Content-Type: application/json' \
  -d '{"type":"artist","name":"<ARTISTE_TEST>"}' \
  | jq -r '.node.slug, (.node.discography[] | .slug)' | head
# -> les œuvres de la discographie portent un slug scopé (<titre>--<artiste>).

# 4. Clic sur une de ses œuvres, comme le front (body de materializeBody, web/index.html).
curl -fsS -X POST "$API/materialize" -H 'Content-Type: application/json' \
  -d '{"type":"project","name":"<TITRE>","artist":"<ARTISTE_TEST>","slug":"project:<titre>--<artiste>",
       "source":{"slug":"artist:<artiste>","field":"discography"}}' | jq '.node.slug'
# -> le slug scopé de l'arête, inchangé.

# 5. Aucun doublon non scopé : le slug nu n'a PAS été créé.
curl -s -o /dev/null -w '%{http_code}\n' "$API/node/project:<titre>"   # attendu : 404 (nœud neuf)
curl -fsS "$API/node/project:<titre>--<artiste>" | jq '.node.slug'      # attendu : 200, slug scopé
```

Pour une œuvre déjà migrée, l'étape 5 se lit autrement : `GET /node/project:<titre>` répond 200 avec
`redirected_from` et `node.slug` scopé (la redirection, pas un second nœud). Contrôle de fond côté
cache de prod, sans écrire : l'audit sur une copie du cache de prod (`unscoped-release-slugs` et
`duplicate-names` ne montent pas par rapport au niveau d'avant la bascule).

**Rollback** (testé : le test du drapeau passe avec l'unité à `0`, donc `npm run test` reste vert et
`deploy.yml` atteint `Deploy server`). Remettre la valeur à `0` dans l'unité (`Environment=ODYSSEY_SCOPED_RELEASE_SLUGS=0` dans
`deploy/deploy-server.sh`), merger et laisser `deploy.yml` redéployer. On ne touche **à aucun nœud
migré** : les anciens slugs restent lisibles via `data/slug-redirects.json` (lue par tous les chemins de
lecture, TRA-453), et les nœuds scopés restent lisibles sous leur slug. Drapeau à 0, le serveur
revient aux slugs que `main` émettait avant la bascule (voir `src/flags.ts`) ; les
nœuds écrits entre la bascule et le rollback gardent leur slug scopé et ne sont pas réécrits. Le
rollback garantit la **lecture**, pas l'absence de nouveaux doublons : cache migré et drapeau à 0, un
JIT d'œuvre sans contexte artiste (`artist` est ignoré drapeau éteint) peut écrire un slug nu à côté du
slug scopé, le cas que décrit `src/flags.ts`. Après un rollback, relancer `npm run audit:cache` sur une
copie du cache de prod : si `duplicate-names` ou `unscoped-release-slugs` montent, ouvrir un ticket de
nettoyage (fusion par la migration d'identité, idempotente), sans éditer le cache à la main. Coupe-feu sans déploiement (si `deploy.yml` est bloqué) : écrire
`ODYSSEY_SCOPED_RELEASE_SLUGS=0` dans `/etc/odyssey-music.env` puis `systemctl restart
odyssey-server.service` (l'`EnvironmentFile=` l'emporte sur l'unité) ; à retirer ensuite, car un
`bootstrap-env.sh` ultérieur réécrit ce fichier en entier.

**Hors périmètre de ce ticket (suivi).** Les processus qui ne sont pas le serveur ne reçoivent pas le
drapeau : `npm run crawl` en local, et le workflow `top-up-genres` (`.github/`, tier/3, suivi dans
TRA-572). Tant qu'ils ne l'ont pas, ils continuent d'écrire des slugs non scopés / non
translittérés, ce que l'audit signale. Voir `src/flags.ts` : « every process that mints slugs must
have it ».

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
- Suite proposée le 2026-10-16 : **Partie 3b — Pochettes à la demande** (section dédiée en fin de
  document, 9 tâches 3b.1 → 3b.9, validée le 2026-10-16).

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

## Partie 3b — Pochettes à la demande

Statut : **validé par Raphael le 2026-10-16 (« ok plan »)**, les quatre questions ouvertes tranchées
(voir « Décisions validées par Raphael » en fin de partie) ; tickets créés le 2026-10-16 dans le
milestone « Partie 3b — Pochettes à la demande » de P-TRA-5 : TRA-578 à TRA-586 (3b.1 → 3b.9).
Brief : option A (le serveur trouve la pochette d'une œuvre même sans fiche, avec la vérification
MusicBrainz du reste du projet) + « à chaque fiche, même les existantes, lorsqu'elles s'ouvrent, on
va chercher la pochette de tous les albums présents ». Cartographie faite sur `origin/main` à
`7ef31bf7` ; les numéros de ligne s'y réfèrent.

### Problème

Sur une fiche artiste (Squarepusher, web et iOS), les vignettes de discographie (*Feed Me Weird
Things*, *Go Plastic*, *Ufabulum*) restent des dégradés. Chaîne vérifiée :

1. **L'image n'est calculée qu'à la matérialisation.** `attachResolvedImage` (`src/pipeline.ts:849-898`)
   appelle `resolveImage(node, deps)` (`src/images/resolve-image.ts:136`), puis `cache.write`.
   `GET /image/:slug` (`src/server.ts:277-296`) est en lecture seule depuis TRA-475 : `image_url`
   stocké → anciens champs → arêtes (`related:`) → `no-match`. Un slug **sans nœud** répond 200
   `{image_url: null, source: "not-cached"}` avec `Cache-Control: public, max-age=86400` ; la route
   mobile `GET /mobile/v1/nodes/:slug/image` (`src/mobile/media.ts:56-66`, `src/mobile/router.ts:90-124`)
   répond 404.
2. **Mesure** sur le cache d'`origin/main` : 9 411 slugs d'œuvres distincts référencés par des arêtes
   pour 533 nœuds projet/track, soit ≈ 94 % des slugs référencés sans nœud (le « 60 % » du brief compte
   par arête). 8 351 de ces slugs sont encore **nus** (sans `--`) : la migration TRA-483 n'est pas
   appliquée au dépôt à `7ef31bf7`.
3. **Les clients mémorisent l'échec.** iOS garde `.unavailable` pour la session
   (`ios/Track1Core/Sources/Track1Core/Media/NodeImageStore.swift:32-36, 94-102`) ; le web garde la
   promesse `null` dans `imageJitPromises` pour la page (`web/index.html:245-260`). Une réponse « pas
   encore » est donc aujourd'hui un échec définitif.
4. **Le résolveur exige un `NodePayload` complet.** Aucune fonction ne rend titre + artiste depuis un
   slug (`scopeOf`, `src/slug.ts:207`, ne rend qu'un corps normalisé). En revanche l'arête affichée porte
   déjà `name`, `type`, `mbid?`, `releaseType?`, `artist?` (`EdgeRef`, `src/types.ts:23-33`), et la
   fiche source connaît son propre artiste.
5. **La file MusicBrainz est FIFO stricte** (`reserveSlotDelayMs`, `src/musicbrainz.ts:302-311`),
   1 req/s, sans priorité, partagée avec `/materialize` et la recherche live (TRA-450, TRA-573).

### Non-buts

- Écrire un nœud pour une œuvre non matérialisée, ou écrire un nœud existant depuis le chemin de
  lecture : la matérialisation (TRA-479) et le backfill (TRA-489) restent les seuls à poser `image_url`
  sur un nœud.
- Trouver l'image d'un **artiste, label ou genre sans nœud** (arêtes `members`, `collaborators`,
  `roster`, `key_artists`…) : il faudrait une résolution d'identité d'artiste à la demande ; le dégradé
  reste.
- Corriger le rattachement d'une fiche homonyme existante (`project:3` d'Aphex Twin affiché depuis
  Pole) : c'est la Partie 1.
- Changer l'échelle du résolveur d'images, la liste d'hôtes, ou l'UI d'attente (spinner, légende) : le
  dégradé de type reste l'état d'attente.
- Précharger le cache entier : seule une fiche **ouverte** déclenche des résolutions.

### Décisions d'archi

**3b-D1. L'identité d'une œuvre sans nœud vient de l'arête affichée, jamais du slug ni du client.**
La fiche ouverte fournit, pour chaque arête `project`/`track` de ses listes d'œuvres (`discography`,
`notable_tracks`, `tracklist`, `landmark_projects`, `landmark_tracks`, `notable_releases`, `project`),
un **indice** `{slug, type, title: edge.name, artist, mbid?, releaseType?}` où `artist` = `edge.artist`,
sinon l'artiste de la fiche source (fiche artiste : son nom ; projet/track : `artists[0].name`), sinon
pas d'indice (arête ignorée). Rejeté — reconstruire titre et artiste depuis le slug : perte
d'information (ponctuation, casse, « 3 »), et 8 351 slugs nus n'ont pas d'artiste. Rejeté — laisser le
client envoyer titre et artiste en paramètres : une pochette fausse pourrait être posée sous
n'importe quel slug (empoisonnement du cache) ; le serveur ne lit que ses propres nœuds.

**3b-D2. Résolution « sûreté avant taux », identique au pipeline : MusicBrainz tranche l'identité,
puis Cover Art Archive, puis iTunes vérifié.** `resolveWorkImageByHint(hint)` : si `hint.mbid` est
présent → `coverArtUrl(mbid)` (`src/images/coverart.ts:21`, vérifie 307/404) ; sinon
`resolveReleaseGroupDetailed(title, artist, { releaseType })` (`src/musicbrainz.ts:1330`, règle
single/album de TRA-560 ; track : `resolveRecordingDetailed`, release-group lu dans la réponse de
recherche) → `coverArtUrl` → repli `lookupVerifiedAlbumArt(title, artist)` (`src/itunes.ts:153`).
`ambiguous` → pas d'image (négatif 7 j) ; `no-match` → négatif 7 j ; `unavailable` → négatif court
(1 h). Au plus 2 appels MusicBrainz par œuvre ; toute URL passe `isAllowedImageUrl`
(`src/images/hosts.ts:24`). Rejeté — iTunes seul, sans MusicBrainz : c'est l'emprunt sans crédit que
TRA-475 a retiré (Earth, Wind & Fire sur Grandmaster Flash). Rejeté — Gemini : coût et homonymes.

**3b-D3. Stockage : un sidecar dérivé `cache/images/`, ignoré par git, dont la clé est l'identité
scopée ; le serveur n'écrit jamais un nœud à la lecture.** Entrée
`{key, state: "found" | "missing" | "unavailable" | "conflict", url?, source?, mbid?, reason?,
hint: {title, artist}, resolvedAt}` dans `cache/images/<type>-<body>.json` (convention de
`cache/links/`, `src/streaming-links.ts:84`), écriture atomique (`atomicWriteJson`,
`src/cache.ts:674`), schéma Zod à la lecture, fichier corrompu supprimé (modèle `readValidatedSidecar`,
`src/youtube.ts`). La clé est `makeScopedSlug(type, title, artist)` (`src/slug.ts:162`) calculée depuis
l'indice, quel que soit le drapeau `ODYSSEY_SCOPED_RELEASE_SLUGS` : un slug nu (`project:3`) n'est qu'un
**alias** résolu en mémoire via la fiche qui l'a affiché ; deux indices d'artistes différents pour un
même slug nu → `conflict`, aucune image servie pour le nu (les clés scopées restent servies chacune à
sa fiche). Un nœud existant sans `image_url` passe par le même sidecar (clé = son slug, résolution
par `resolveImage(node)`). Rejeté — poser `image_url` sur le nœud existant par `cache.update`
(verrou TRA-535) : rouvre l'écriture à la lecture que TRA-475 a fermée, fait diverger prod et dépôt
(le `rsync` du canal d'union écraserait l'image à la prochaine migration) et doublonne TRA-489, qui
reste le chemin qui pose l'image sur les nœuds. Rejeté — clé = slug demandé : la migration d'identité
(TRA-478/483) renommera 8 351 clés, et un même slug nu servirait la pochette d'un homonyme. Rejeté —
un nœud « squelette » : il entrerait dans `data.json`, la recherche et l'audit.

**3b-D4. Résolution en arrière-plan par un worker séquentiel, avec une priorité `background` dans
la file MusicBrainz.** L'ouverture d'une fiche appelle `warm(node)` : synchrone, en mémoire,
O(arêtes) — un job `node` si la fiche n'a pas d'`image_url`, un job `hint` par œuvre affichée,
dédupliqués par clé, file bornée à 5 000 entrées. Un seul worker consomme la file (concurrence 1,
20 s au plus par job comme `IMAGE_RESOLVE_TIMEOUT_MS`, `src/pipeline.ts:846`, coupe-circuit de 60 s
après 3 `unavailable` consécutifs) et écrit le sidecar. `mbFetch` gagne une priorité : une requête
`background` ne réserve un créneau que lorsqu'aucune requête interactive n'attend ; l'option
`priority` est plombée explicitement dans `WorkResolveOptions` (`src/musicbrainz.ts:1111`),
`ImageDeps` (`resolve-image.ts`) et `fetchWikidataUrlRelMb` (`src/musicbrainz.ts:628`). Rejeté —
résoudre dans la requête `/image` : 30 à 60 s de latence par fiche et affamement de `/materialize`.
Rejeté — `AsyncLocalStorage` pour porter la priorité : implicite, invisible à la lecture des
signatures. Rejeté — une seconde file MusicBrainz : double le débit au-delà de la politique MB.

**3b-D5. Contrat de réponse à trois états ; seule une image trouvée est cachable.**
`found` → 200 `{slug, image_url, source}`, `Cache-Control` inchangé (`public, max-age=86400` web,
`private, max-age=86400` mobile). `pending` (job en file ou en cours) → **202**
`{slug, image_url: null, source: "pending", retry_after_seconds: 5}` + `Retry-After: 5` +
`Cache-Control: no-store`. `none` (`missing`, `conflict`, `no-match`, ou slug sans nœud et sans
contexte → `source: "no-context"`) → 200 `image_url: null`, `Cache-Control: no-store`. La route mobile
cesse de répondre 404 pour un slug sans nœud : même contrat. Le web passe `?from=<slug de la fiche>`
à `GET /image/:slug` (il ne lit pas `/node/:slug` à l'ouverture d'une fiche : `web/index.html:467` ne
sert qu'à la recherche) ; le serveur charge `from` **dans son propre cache** et appelle `warm`. iOS ne
passe rien : `GET /mobile/v1/nodes/:slug` chauffe la fiche avant d'émettre sa réponse, et le routeur
mobile refuse déjà tout paramètre de requête (`src/mobile/router.ts:100-103`). Compatibilité : un client
ancien voit `image_url: null` → le dégradé d'aujourd'hui ; un `null` public encore en cache HTTP expire
en ≤ 24 h. Rejeté — 200 avec `source: "pending"` seul : les caches HTTP et `imageJitPromises` le
gardent. Rejeté — 404 pour `pending` : iOS le mémorise comme échec définitif, et `APIClient.request`
(`APIClient.swift:105`) ne décode pas le corps d'une erreur.

**3b-D6. Relance bornée côté client, et l'attente n'est jamais mémorisée.** Même budget web et iOS :
relance après `retry_after_seconds` (borné à 2…30 s, 5 s par défaut), 6 tentatives au plus (≈ 60 s
par œuvre), annulée quand la vue disparaît (annulation de `Task` iOS ; `isConnected` et fil d'Ariane
web). `pending` n'entre ni dans `resolutions` ni dans `imageJitPromises` : seuls `found`, `none` et une
erreur réseau y entrent ; un budget épuisé n'est pas mémorisé non plus (la prochaine apparition de la
vue relance un budget). Les demandes concurrentes d'une même clé partagent une tâche (existant,
`resolutionsInFlight`). Rejeté — notification serveur (SSE) : une surface de plus pour gagner quelques
secondes. Rejeté — relance illimitée : tempête de requêtes quand le serveur est à l'arrêt, exactement
ce que le commentaire de `NodeImageStore` interdit.

**3b-D7. Un interrupteur d'arrêt, actif par défaut.** `ODYSSEY_ON_DEMAND_IMAGES=0`, lu à l'appel
dans `src/flags.ts` (même modèle que `scopedReleaseSlugsEnabled`), désactive `warm`, le worker et la
lecture du sidecar : `/image` retrouve exactement le comportement de `7ef31bf7`. Rejeté — drapeau
éteint par défaut et ticket `deploy/` pour l'allumer : un tier/3 de plus pour un comportement borné et
réversible à chaud.

### Découpage

`[P]` = parallélisable dans sa vague ; 1 pt ≈ 1,5 h ; chaque tâche < 300 lignes de diff (tests
compris) et un seul type de changement. Dépendances externes déjà livrées : TRA-452/560 (résolveurs),
TRA-465 (images), TRA-450/573 (file MB), TRA-475/479 (lecture seule, image à la matérialisation).
Aucun ticket ne touche le schéma, `deploy/`, `.github/` ni `scripts/migrations/`.

- [ ] TRA-578 3b.1 `[P]` Résoudre la pochette d'une œuvre sans nœud depuis un indice
      (`src/images/resolve-work-hint.ts`) — tier/2, 3 pts
- [ ] TRA-579 3b.2 `[P]` Priorité `background` dans la file MusicBrainz (`src/musicbrainz.ts`) — tier/2, 2 pts
- [ ] TRA-580 3b.3 `[P]` Sidecar `cache/images/` : lecture validée, écriture atomique, cache négatif à TTL
      (`src/images/image-sidecar.ts`, `.gitignore`) — tier/2, 2 pts
- [ ] TRA-581 3b.4 File de résolution en arrière-plan : worker séquentiel, alias slug nu → clé scopée,
      conflits, coupe-circuit (`src/images/image-queue.ts`) — tier/2, 3 pts (dépend de 3b.1, 3b.2, 3b.3)
- [ ] TRA-582 3b.5 `image-service` : états `found`/`pending`/`none`, `warm(node)`, contexte `from`, drapeau
      `ODYSSEY_ON_DEMAND_IMAGES` (`src/services/image-service.ts`, `src/flags.ts`) — tier/2, 3 pts
      (dépend de 3b.4)
- [ ] TRA-583 3b.6 `[P]` Routes web : 202 + `Retry-After` + `no-store` sur `GET /image/:slug[?from=]`, chauffe
      sur `GET /node/:slug`, compteurs dans `/health` (`src/server.ts`) — tier/2, 2 pts (dépend de 3b.5)
- [ ] TRA-584 3b.7 `[P]` Routes mobile : même contrat sur `/mobile/v1/nodes/:slug/image`, chauffe sur
      `/mobile/v1/nodes/:slug` (`src/mobile/media.ts`, `src/mobile/router.ts`) — tier/2, 2 pts (dépend
      de 3b.5)
- [ ] TRA-585 3b.8 `[P]` Web : `?from=`, relance bornée sur `pending`, attente jamais mémorisée
      (`web/index.html`) — tier/2, 2 pts (dépend de 3b.6)
- [ ] TRA-586 3b.9 `[P]` iOS : `ImageResponse.retryAfterSeconds`, relance bornée et annulable dans
      `NodeImageStore` (`ios/Track1Core`) — tier/2, 3 pts (dépend de 3b.7)

**Vagues** : A = {3b.1, 3b.2, 3b.3} (3 lanes) → B = 3b.4 → C = 3b.5 → D = {3b.6, 3b.7} →
E = {3b.8, 3b.9}. Chaque vague est déployable seule : A à C sont du code mort tant que D ne le câble
pas ; D change le serveur sans casser les clients actuels (D5) ; E apporte le gain visible. 3b.1 et
3b.2 touchent tous deux `WorkResolveOptions` : 3b.2 ajoute `priority`, 3b.1 ne fait que la consommer,
l'ordre de merge est libre. La Partie 3b est indépendante de 3.5 (TRA-489) et peut tourner sur une
lane pendant la vague C du plan principal.

#### Contenu attendu par tâche

**3b.1 (TRA-578) — Résolveur par indice.** Nouveau `src/images/resolve-work-hint.ts` + `test/images/resolve-work-hint.test.ts`.
Signature : `resolveWorkImageByHint(hint: WorkImageHint, deps?: { fetch?: typeof fetch; priority?: MbPriority }): Promise<WorkImageResolution>`
avec `WorkImageHint = { slug: Slug; type: "project" | "track"; title: string; artist: string; mbid?: string; releaseType?: string }`
et `WorkImageResolution = { kind: "found"; url: string; source: ImageSource; mbid?: string } | { kind: "missing"; reason: "ambiguous" | "no-match" } | { kind: "unavailable" }`
(`source` reprend les valeurs d'`ImageSource`, `src/types.ts:40-49`, utilisées par `resolveImage` pour
CAA et iTunes). Aucune I/O disque. Critères : `mbid` fourni → CAA sans appel MB ; sans `mbid` → un appel
MB, crédit vérifié par `pickByTitleAndCredit` ; `ambiguous` → `missing/ambiguous` sans appel CAA ni
iTunes ; MB indisponible → `unavailable` ; CAA 404 → repli iTunes vérifié ; URL hors liste → rejetée ;
track → recording puis release-group de la réponse de recherche, sinon `no-match` ; compteur d'appels
MB ≤ 2 dans chaque test.

**3b.2 (TRA-579) — Priorité MB.** `src/musicbrainz.ts` : `export type MbPriority = "interactive" | "background"` ;
`priority?: MbPriority` sur `WorkResolveOptions` et sur `fetchWikidataUrlRelMb` ; `mbFetch` la reçoit
(valeur par défaut `interactive`, aucun appelant existant ne change). Règle : une réservation
`background` n'est faite que lorsqu'aucune réservation interactive n'est en attente ; les retries
gardent la priorité de leur première tentative. Critères (`test/musicbrainz.test.ts`, bloc « mbFetch
request spacing ») : à départ simultané, deux interactives puis une background obtiennent les créneaux
0 s, 1 s, 2 s ; une background émise pendant une rafale de 5 interactives part en dernier ; sans
interactive, les background sont espacées de 1 s ; les 130 tests existants restent verts.

**3b.3 (TRA-580) — Sidecar.** Nouveau `src/images/image-sidecar.ts` + test, et `cache/images/` ajouté à
`.gitignore` à côté de `cache/youtube/` et `cache/links/` (l.25-26). API : `imageSidecarPath(cacheDir, key)`,
`readImageSidecar(cacheDir, key, now?): Promise<ImageSidecarEntry | null>` (entrée périmée → `null`),
`writeImageSidecar(cacheDir, entry): Promise<void>`. TTL : `found` sans expiration, `missing` et
`conflict` 7 j (`MISS_TTL_MS` de `streaming-links.ts:42`), `unavailable` 1 h. Critères : aller-retour ;
fichier corrompu → supprimé et `null` ; expiration par horloge injectée ; la clé ne produit jamais un
chemin hors du dossier (`..`, `/`) ; `git status` reste propre après une écriture.

**3b.4 (TRA-581) — File et worker.** Nouveau `src/images/image-queue.ts` + test. API :
`createImageQueue(deps: { cacheDir; cache: NodeCache; resolveNode: typeof resolveImage; resolveHint: typeof resolveWorkImageByHint; now?; log })`
→ `{ enqueueNode(node): void; enqueueHint(hint): void; stateOf(key): "pending" | "idle"; aliasOf(bareSlug): Slug | "conflict" | null; stats(); stop(): Promise<void> }`.
Comportement : boucle séquentielle démarrée au premier job ; relit le sidecar avant de résoudre (frais →
saute) ; timeout 20 s ; écrit l'entrée ; journal structuré par job (`image job`, `{key, kind, outcome, ms}`) ;
coupe-circuit 60 s après 3 `unavailable` consécutifs ; file bornée 5 000 (au-delà : refus compté dans
`dropped`) ; alias `Map<Slug, Slug | "conflict">` borné 20 000 ; dédup par clé. Critères : FIFO ; dédup ;
conflit sur un nu vu depuis deux artistes ; coupe-circuit puis reprise ; pas de résolution si le sidecar
est frais ; `stop()` termine le job en cours et n'en démarre pas d'autre.

**3b.5 (TRA-582) — Service.** `src/services/image-service.ts`, `src/flags.ts` (`onDemandImagesEnabled()`),
`test/image-service.test.ts`. `DisplayImage` gagne `state: "found" | "pending" | "none"` et
`retry_after_seconds?`. `resolveDisplayImage(slug, opts?: { from?: Slug })` : `image_url` du nœud →
sidecar (clé = slug du nœud, ou slug scopé demandé, ou `aliasOf(slug)`) → marche `related:` existante
→ `pending` si `stateOf` l'est → chauffe de `from` s'il est fourni et en cache (puis `pending`) →
`none` (`no-context`). `warm(node)` : indices selon D1, `enqueueNode` si pas d'`image_url`, mémo des
fiches chauffées (10 min) pour ne pas relire le nœud à chaque carte. Drapeau éteint → ni sidecar, ni
`warm`, ni `pending`. Critères : les 12 tests existants verts ; fiche artiste à 3 œuvres → 3 indices
portant l'artiste source ; arête sans artiste sur une fiche genre → ignorée ; `from` inconnu → ignoré ;
slug nu sans contexte → `none/no-context` ; drapeau à `0` → aucune lecture de `cache/images/`.

**3b.6 (TRA-583) — Routes web.** `src/server.ts` : handler `/image` → statut et en-têtes selon `state` (D5),
`?from=` décodé par `decodeSlugParam` (`server.ts:363`) et refusé à 400 s'il est malformé ; `/node/:slug`
appelle `imageService.warm(result.node)` avant `json(res, 200, …)` ; `/health` (`server.ts:239`) expose
`images: queue.stats()` ; le worker est créé au démarrage et arrêté là où le serveur ferme ses
ressources. Critères : `test/server-slug-traversal.test.ts` (4) verts ; nouveau
`test/server-image-contract.test.ts` : 202 + `Retry-After: 5` + `no-store` ; `found` garde
`public, max-age=86400` ; `none` est `no-store` ; `from` malformé → 400 ; `GET /node` déclenche `warm`
(espion) ; drapeau à `0` → réponses identiques à `7ef31bf7`.

**3b.7 (TRA-584) — Routes mobile.** `src/mobile/media.ts` : `image(slug)` ne rend plus `null` quand le nœud
manque mais le résultat du service (toujours filtré par `safePublicHttpsUrl`), expose `state` et
`retry_after_seconds` ; `warm(node)` ajouté à `MobileMedia`. `src/mobile/router.ts` : la lecture de la
fiche (`resource` indéfini) appelle `media.warm` avant la réponse ; `image` répond 202 + `Retry-After`
+ `no-store` pour `pending`, `no-store` pour `none`, `private, max-age=86400` seulement pour `found`.
Critères : `test/mobile/media.test.ts` (5) et `test/mobile/compatibility.test.ts` (1) adaptés ; cas
202 ; slug sans nœud → 200 `none` et non 404 ; `nodes.test.ts` vert ; le contrat iOS
(`test/ios-node-page-spec.test.ts`) inchangé.

**3b.8 (TRA-585) — Web.** `web/index.html` : `jitResolveImage(slug)` ajoute `?from=<crumbs[crumbs.length-1]>`,
traite 202 / `source: "pending"` par relance (`retry_after_seconds` borné 2…30 s, 6 tentatives, arrêt si
la carte n'est plus connectée ou si la fiche a changé), ne stocke dans `imageJitPromises` qu'un
résultat final ; `paintCardWhenReady` et `jitResolveHero` gardent leur interface. Critères (jsdom,
modèle `test/web-hero-image.test.ts`) dans un nouveau `test/web-image-pending.test.ts` : 202 puis 200 →
carte peinte ; 6 × 202 → dégradé conservé et aucune promesse `null` mémorisée ; `from` présent dans
l'URL appelée ; navigation vers une autre fiche → plus de relance ; Biome vert.

**3b.9 (TRA-586) — iOS.** `ios/Track1Core/Sources/Track1Core/API/APIModels.swift` : `ImageResponse` gagne
`retryAfterSeconds: Int?` (clé `retry_after_seconds`). `NodeImageStore.swift` : une réponse
`source == "pending"` n'est pas mémorisée ; relance après `retryAfterSeconds` (borné 2…30 s, 5 s par
défaut), 6 tentatives, `Task.isCancelled` vérifié entre deux, puis `nil` sans mémorisation ; les appels
concurrents partagent la tâche. Critères (`swift test`, `Tests/Track1CoreTests/Media/NodeImageStoreTests.swift`,
5 tests existants verts) : `pending` puis `found` → image rendue et un seul chargement ; 6 × `pending` →
`nil`, et l'appel suivant relance ; annulation de la `Task` → aucune relance ; `none` → `.unavailable`
pour la session (inchangé) ; `APIClientTests.testReadsImageLinksSearchAndGenerationResponses` décode
le nouveau champ ; `ios-check` vert.

### Risques et garde-fous

- **Affamement de `/materialize` ou de la recherche live par les pochettes.** Garde-fous : priorité
  `background` (3b.2), concurrence 1, file bornée, coupe-circuit ; test d'ordre dans
  `musicbrainz.test.ts` ; compteurs `images.{pending, resolved, missing, dropped, paused}` dans `/health`.
- **Fausse pochette (homonyme).** Garde-fous : identité par arête (D1), crédit MusicBrainz exact et
  `ambiguous → none` (D2), clé scopée et `conflict` sur un slug nu (D3) ; `isAllowedImageUrl` sur toute
  URL.
- **Tempête de relances.** Garde-fous : `Retry-After`, 6 tentatives, tâche partagée par clé côté
  client, `no-store` ; côté serveur, dédup par clé et file bornée.
- **Caches HTTP intermédiaires.** Les `null` publics de 24 h déjà émis expirent seuls ; dès 3b.6, tout
  `image_url: null` est `no-store`. Les 24 h de transition sont acceptées.
- **Croissance du sidecar en prod.** ≤ 9 411 fichiers ≈ 3 Mo, régénérables ; `rm -rf cache/images` est
  toujours sûr ; le dossier est ignoré, aucun canal ne le ramène dans le dépôt.
- **Migration d'identité (TRA-478/483) pendant ou après 3b.** La clé scopée ne dépend pas du slug de
  l'arête ; les alias sont recalculés à chaque `warm`. Un nœud créé pour une œuvre déjà dans le sidecar
  gagne (`image_url` lu en premier) ; l'entrée orpheline est inerte.
- **Ancienne app iOS face au nouveau contrat.** 202 + `null` = dégradé, comme aujourd'hui ; le gain
  arrive avec 3b.9. Aucun changement du contrat `NodePageSpec`.
- **iTunes en repli.** Un appel par œuvre au plus, seulement après MusicBrainz et CAA ; une erreur
  compte comme `unavailable` (1 h), pas comme `missing`.

### Critères de sortie

- Squarepusher (iOS, web 320 px et desktop) : *Feed Me Weird Things*, *Go Plastic*, *Ufabulum*
  affichent leur pochette ≤ 60 s après la première ouverture, sans fiche créée
  (`cache/nodes/project/` inchangé), et dès l'ouverture suivante.
- Pendant la chauffe d'une fiche de 30 œuvres, un `POST /materialize` obtient son premier créneau
  MusicBrainz en < 2 s (test d'ordre 3b.2) ; la file ne dépasse pas 1 req/s au total.
- `GET /image/<slug sans nœud>?from=<fiche>` : 202 + `Retry-After` puis 200 `found` ;
  `Cache-Control: no-store` sur tout `image_url: null` ; `/mobile/v1/nodes/<slug sans nœud>/image` ne
  répond plus 404.
- `project:3` affiché depuis deux artistes : aucune image sur le slug nu, une par clé scopée.
- `ODYSSEY_ON_DEMAND_IMAGES=0` : réponses et écritures identiques à `7ef31bf7`.
- Après une session de navigation : `git status` propre, aucun nœud écrit, `cache/images/` peuplé.

### Décisions validées par Raphael, 2026-10-16

Réponses aux quatre questions ouvertes du plan, dans le sens des recommandations :

1. **Sidecar seul (D3).** Une pochette trouvée à la demande pour un nœud existant n'entre pas dans le
   dépôt ; le serveur n'écrit jamais un nœud à la lecture. TRA-489 (backfill) couvre la pose de
   `image_url` sur les nœuds existants.
2. **Œuvres seulement.** Les artistes, labels et genres sans nœud gardent le dégradé ; aucune
   résolution d'identité d'artiste à la demande.
3. **Drapeau actif par défaut (D7)** dès le merge de 3b.6 et 3b.7, sans ticket `deploy/` ; le kill
   switch est `ODYSSEY_ON_DEMAND_IMAGES=0`.
4. **Budget de relance (D6)** d'environ 60 s par œuvre (6 tentatives, 2…30 s), dégradé de type sans
   indicateur d'attente.

## Journal des décisions — 2026-10-16 (livraison de nuit et de jour)

Arbitrages pris par le dispatcher sous la délégation de Raphael (« tu valides toi-même les tiers 3 et tu fais les trade-offs nécessaires »), puis avec ses feux verts explicites (mise en prod, plan 3b). Règle directrice : **sûreté avant taux**.

### Identité et migration
- **Arêtes inverses (TRA-486, #484)** : le backfill est limité aux 4 directions sûres (crédit ou appartenance → liste côté artiste ou label). Aucun crédit, parent ou genre n'est écrit sur une œuvre depuis la liste d'un autre nœud : la version complète créait de faux crédits (Moderat « II » + 2 Unlimited, CANDIACE + Juan Atkins). Le runtime applique la même règle (TRA-563, #486). Les paires écartées sont dans TRA-564.
- **Résolveur d'œuvres (TRA-560, #485)** : quand des candidats ont des types primaires ou secondaires différents, la date ne départage plus. Sans type sur le nœud, le résultat est `ambiguous`. Coût accepté : Windowlicker et Are You Experienced perdent leur identité.
- **Compilations (TRA-571, #488)** : une œuvre Various Artists, ou sans mbid avec au moins 3 crédits, n'est pas scopée. À 2 crédits, l'œuvre reste scopée sur `artists[0]`, ce qui garde Fitna d'Akuma détachée de Rohff.
- **Œuvres sans crédit (TRA-558)** : 88 restent nues. Le drapeau ne sert jamais un homonyme ; au pire, il crée un doublon correctement crédité.
- **Exclusions d'identité (TRA-574, #491)** : `data/identity-exclusions.json` liste 6 artistes jamais résolus automatiquement (voices-of-life, andy-turner, tyla, johnny-reid, alfred-d-orsay, bossa-nova). Leur mbid stocké faux est retiré.
- **Canal de migration (TRA-568, #487 ; TRA-573, #490 ; TRA-576, #492)** : il fait passer les 3 migrations d'identité, rejoue la preview à l'apply, ne réessaie MusicBrainz 6 fois qu'en migration (3 en live), et n'émet aucune redirection vers un slug sans nœud.
- **Album repère et titre de référence, règle v2 (TRA-601, décision du dispatcher du 2026-10-17, réversible par Raphael)** : **pas de compilation multi-artistes comme album repère d'un artiste** (œuvre en cache qui crédite 3 artistes ou plus, sans scope sur l'artiste : raison `compilation`). Trade-off accepté : un artiste dont la seule sortie connue est une compilation reste sans album repère, plutôt que de recevoir celui d'un autre (*Artificial Intelligence* pour Aphex Twin, *Kind of Blue* pour Coltrane). La règle v1 (#520, jamais appliquée) est remplacée en place : titre cité dans l'article (+50), album avant single (+20), année la plus ancienne au départage, et une œuvre portant le nom d'un artiste du cache ne reçoit aucun signal.
- **Album repère et titre de référence, règle v3 (TRA-601, décision du dispatcher du 2026-10-17, réversible par Raphael)** : le balayage des 976 choix du run dépôt (#528) a trouvé 13 mauvais choix ; un choix écrit étant définitif, la règle est resserrée avant le run. (1) **Sorties non canoniques exclues** (raison `non-canonical`, deux champs) : remix, mix, `anthology` / `anthologie`, `greatest hits`, `bootleg`, `the (very) best of` en tête de titre, bande originale entre parenthèses ou en fin de titre. Les disques live restent éligibles (*Live at the Apollo*, *Live at the Paradise Garage*) ; faux positif accepté : *The Best of Two Worlds* (João Gilberto). (2) **Option unique sans appui** : pas de choix quand la seule entrée éligible a un score de 0 et qu'elle est rétrogradée « nom d'artiste », ou, pour l'album repère seulement, que c'est un single (`soleUnsupported` dans le manifeste) ; une entrée unique légitime reste choisie. (3) **Disque éponyme vérifié** (en cache et crédite l'artiste) : plus rétrogradé ; il l'est toujours pour le nom d'un autre artiste ou s'il n'est pas vérifiable.
- **Prod (TRA-484)** : appliquée le 2026-10-16, après 4 previews refusées sans dégât (fail-closed). Les 216 redirections prod-only ont d'abord été committées (#493). Le drapeau des slugs scopés est allumé (TRA-509, #489), et Rohff → Fitna est vérifié en JIT.

### Textes et images
- **`\n` littéraux (TRA-492)** : supprimés dans le dépôt (756 nœuds) et en prod. Les `\"` sont traités à part (TRA-577).
- **Images (TRA-489)** : le run v4 a été appliqué au dépôt et en prod (847 nœuds dans le dépôt). Trois runs avaient été refusés par la review d'échantillons :
  - le repli **legacy** (`photo_url`/`cover_url` du LLM) est **supprimé** : il n'était pas vérifiable et 2 sur 20 étaient faux (#502) ;
  - iTunes exige le **crédit exact**, refuse Various Artists, exige l'égalité du titre et l'**année à ±1**, et refuse une égalité ambiguë (TRA-589, #503 ; TRA-595, #512) ;
  - une image **dérivée** n'est empruntée qu'à une œuvre **réciproque**, qui déclare le label, crédite l'artiste ou porte le genre (TRA-591, #506). Les membres de groupe n'empruntent plus la pochette du groupe ;
  - **décision de Raphael, 2026-10-17 (TRA-597)** : la règle est **assouplie pour les genres uniquement**. Une œuvre est acceptée si elle porte le genre, son **parent direct** (`parent_genres`) ou un **sous-genre direct** (`subgenres`), après la table de redirections. Un seul niveau : ni grand-parent, ni genre « related ». **Exact avant voisin** : une œuvre portant le genre lui-même et ayant une image l'emporte sur toute œuvre parent / sous-genre, quel que soit l'ordre des listes (projets puis pistes) ; l'ordre est conservé dans chaque catégorie. **Labels et artistes restent stricts.** Les relations viennent des arêtes du nœud genre (la taxonomie éditoriale n'a que des familles). Mesure hors réseau sur le cache de main : 47 → 54 genres avec une œuvre réciproque (+7, loin des ~30 estimés).
- **Affichage** : `GET /image` (TRA-592, #507) et la projection (TRA-594, #509) ne servent plus jamais `photo_url`/`cover_url`. La pochette d'Earth, Wind & Fire de Grandmaster Flash a disparu, remplacée par sa photo Wikidata.

### Pochettes à la demande (partie 3b)
Livrées : TRA-578 à TRA-586 (#497, #499, #500, #504, #505, #508, #510, #513, #515), plus TRA-596 (#516) pour les cartes web sans nœud. Le drapeau `ODYSSEY_ON_DEMAND_IMAGES` est actif. Le web et iOS relancent sur 202 sans mémoriser l'attente.

### Ouvert
- ~~Décision de Raphael attendue : réciprocité assouplie pour les genres~~ : **prise le 2026-10-17** (TRA-597), voir « Textes et images ».
- Tickets ouverts :
  - TRA-488 : arêtes inverses en prod (le script refuse `--data-dir`, à rendre compatible avec le canal) ;
  - TRA-564 : paires gardées ;
  - TRA-565 : purge des pending dangereux ;
  - TRA-570 et TRA-561 : crédits et tracklists d'homonymes ;
  - TRA-593 : réciprocité côté clients ;
  - TRA-577 : `\"` ;
  - TRA-569 : `remix_of` ;
  - TRA-572 : outils sans drapeau, à garder gelés.
- Infra : TRA-540 (sécurité des runners), à traiter par Raphael.

## Partie 8 — Discographies : identifiants MusicBrainz et complétion des maigres

Statut : **validé par Raphael le 2026-10-18** (« ok plan validé implémente »), les trois questions ouvertes tranchées dans le sens des recommandations (voir fin de partie) ; tickets créés le 2026-10-18 : TRA-613 à TRA-616 (8.1 → 8.4, milestone « Partie 8a — Politique et prévention »), TRA-617 à TRA-621 (8.5 → 8.9, « Partie 8b — Backfill des discographies »), TRA-622 (8.10, « Partie 8c — Mesure des pochettes »). Cartographie
faite sur `main` à `a31a4d9e` ; les numéros de ligne s'y réfèrent. Brief : donner aux arêtes de
`discography` le mbid de leur release group (la pochette vient alors directement du Cover Art Archive,
sans rapprochement par titre : fix racine de TRA-612), compléter les discographies maigres depuis
MusicBrainz, faire de même à la génération, mesurer avant/après, plafonner les listes des prolifiques.

### Problème

1. **Deux générations de discographies cohabitent.** Depuis `c17f4e92` (2026-05-19), `enrichNode`
   (`src/pipeline.ts:1278-1336`) **remplace** la liste du LLM par les release groups MusicBrainz dès que
   l'artiste a un mbid : Album / EP / Single sans type secondaire, tous les albums puis EP et singles les
   plus récents jusqu'à 80, tri par `firstReleaseDate` décroissante, arêtes scopées avec `mbid`, `year`,
   `releaseType`. Les artistes générés avant, ou sans mbid au moment de la génération, gardent la liste
   Gemini (2 à 10 titres, `minItems/maxItems` du schéma `pipeline.ts:434-439`) : sans mbid, sans année,
   sans type. Rien ne pose un mbid sur ces entrées ni ne les complète ensuite.
2. **Mesure « avant » sur le cache du dépôt** (`scratchpad/measure-disco.mjs`, 2026-10-18) :
   - 578 artistes, **497 avec mbid**, 81 sans (dont Aphex Twin et Burial) ;
   - 5 854 arêtes `discography`, **4 640 avec mbid (79,3 %)**, 4 585 avec `year` (chaîne), 4 643 avec
     `releaseType` ; 1 211 sans type ;
   - **196 artistes à moins de 3 entrées** (100 à 0, 38 à 1, 58 à 2), dont **164 ont un mbid** (81 à 0
     entrée) : la cible du backfill. 297 artistes avec mbid ont au moins une entrée sans mbid ; 119 ont
     une liste entièrement MusicBrainz ; 4 sont mixtes ;
   - tri : 141 listes triées par année décroissante (toutes celles de MusicBrainz), 0 croissante ou
     désordonnée, 437 sans deux années comparables ;
   - taille : 44 listes de plus de 40 entrées, **16 exactement à 80** (le plafond) ; chez ces 44, médiane
     de 9 albums, les singles dominent (A$AP Rocky : 5 albums, 75 singles ; Kendrick Lamar : 9 / 70) ;
   - qualité produit : 218 titres portant remix / edit / mix / bootleg / mashup / megamix / sampler, la
     plupart **avec mbid** (« Control Your Body (Hardwell edit) », « Megamix », « The Remix Album ») :
     le filtre des types secondaires ne suffit pas, MusicBrainz les type Single ou Album sans secondaire ;
     93 titres en double chez 66 artistes (Miles Davis : « Birth of the Cool » deux fois) ;
   - témoins : Daft Punk 47 entrées toutes MusicBrainz (5 albums, 5 EP, 37 singles, en tête « Veridis
     Quo » 2024, « Discovery (Sample Bandit Bootlegs) ») ; Björk 5, Coltrane 5, Lennon 7, Miles Davis 4,
     Zappa 4, The Beatles 3, toutes LLM sans mbid ni année ; Burial 0 et sans mbid ; **Kode9 et Prince
     absents du dépôt** (Kode9 n'existe qu'en prod, JIT ; `artist:prince-buster` n'est pas Prince).
3. **Sans mbid, la pochette dépend du rapprochement par titre** (`resolveWorkImageByHint`,
   `src/images/resolve-work-hint.ts:220`) : un titre MusicBrainz différent (« Sine of the Dub / Stalker »)
   ou une compilation suffisent à perdre l'image (TRA-612, #538, #539). Avec `edge.mbid`, le chemin est
   `coverArtUrl(mbid)` directement, sans appel MusicBrainz.
4. **Les `project` sont des nœuds à la demande.** 294 nœuds projet pour 5 854 arêtes ; un nœud naît sur
   clic (`POST /materialize`, `web/index.html:2413-2444`), par le crawler ou `scripts/top-up-dangling.ts`,
   jamais à la lecture (`src/services/node-service.ts:34-39`). Écrire une discographie d'artiste n'émet
   **aucune** inverse vers `project.artists` (paire filtrée, TRA-563, `src/reverse-edges.ts:53-71`) ; seule
   l'écriture d'un projet avec `artists:[A]` ajoute le projet à `A.discography` (`src/cache.ts:585-636`).

### Non-buts

- Résoudre l'identité des 81 artistes sans mbid (Aphex Twin, Burial) : c'est la Partie 1 (TRA-463) et
  ses exclusions (TRA-574) ; ils ne sont pas touchés.
- Créer des nœuds `project` pour les arêtes ajoutées, ou des arêtes inverses : voir 8-D4.
- Supprimer, dédoublonner ou réordonner autrement que par année une entrée existante (les 93 doublons
  restent) ; tronquer les 44 listes existantes de plus de 40 entrées (question ouverte 1).
- `notable_tracks`, les compilations Various Artists, les œuvres en crédit secondaire (l'artiste n'est
  pas le premier crédit), la règle double face A de TRA-612 pour poser une identité.
- Changer l'affichage web ou iOS des discographies (`projectCarouselHtml`, `web/index.html:2454-2461`,
  affiche tout, dans l'ordre reçu).
- Rapatrier les nœuds JIT de prod dans le dépôt (Partie 7).

### Décisions d'archi

**8-D1. Une seule politique de sélection, pure et partagée, dans `src/discography-policy.ts` ; le
pipeline et la migration l'appellent.** Entrée : les release groups MusicBrainz de l'artiste **avec
leurs crédits** ; sortie : les arêtes retenues, dans l'ordre. Règles, dans cet ordre : (1) type primaire
Album / EP / Single et aucun type secondaire (existant) ; (2) **premier crédit = mbid de l'artiste**, au
plus 2 crédits, jamais Various Artists (`89ad4ac3-39f7-470e-963a-56509c546377`) — même règle que les
compilations de TRA-571 ; (3) **titre canonique** : exclu si le titre normalisé contient `remix(es)`,
`megamix`, `mashup` / `mash-up`, `bootleg`, `sampler`, `karaoke`, `greatest hits`, `anthology`, commence
par `the (very) best of`, ou finit par une parenthèse / un crochet contenant `edit`, `mix`, `dub`,
`version`, `instrumental`, `acapella`, `remix` ; (4) **plafond 40, albums d'abord** : tous les albums par
année décroissante jusqu'au plafond, puis les EP, puis les singles, chacun du plus récent au plus ancien ;
(5) ordre final par `year` décroissante (comparaison de `firstReleaseDate`, égalité départagée par le
titre), **les entrées sans date en dernier**. Rejeté — garder 80 et « tous les albums » sans plafond
(existant) : 75 singles noient 5 albums chez A$AP Rocky, c'est la leçon produit du 2026-10-17. Rejeté —
plafond par type (20 albums + 10 EP + 10 singles) : un artiste à 30 albums (Zappa, Stones) perdrait des
albums au profit de singles. Rejeté — filtrer les titres par Gemini : coût et non-déterminisme.

**8-D2. `fetchArtistDiscographyMb` rend les crédits et distingue la panne du vide.** Nouvelle
signature : `fetchArtistDiscographyMb(artistMbid, opts?: { limit?: number; priority?: MbPriority })
: Promise<{ releases: MbReleaseGroupSummary[]; unavailable: boolean }>` ; `MbReleaseGroupSummary`
gagne `artistCredits: { mbid: string; name: string }[]` (paramètre `inc=artist-credits` du browse,
`/release-group?artist=<mbid>&type=…`). Réponse validée à la main comme `parseReleaseGroups`
(`src/musicbrainz.ts:124-176`) ; une page en échec rend `unavailable: true` au lieu d'une liste
silencieusement tronquée (`.catch(() => null)`, l.590 et 603). Pagination inchangée (100 par page, 4
pages par type), espacement 1 s de la file existante (`MB_MIN_INTERVAL_MS`, `src/config.ts:47`),
User-Agent de `musicBrainzConfig` sans aucune donnée personnelle ajoutée. Rejeté — un second appel
`lookup` par release group pour lire les crédits : 400 requêtes de plus par artiste prolifique.

**8-D3. Le backfill est additif et exact : il ajoute, il pose, il ne retire jamais.** Pour chaque
artiste avec mbid (hors `data/identity-exclusions.json`) : (a) **pose** `mbid` sur une entrée sans mbid
dont le titre normalisé (`normalizeTitleBody`, `src/slug.ts:119-131`) est égal à celui d'**un seul**
release group crédité à l'artiste (tous types confondus, y compris Live / Compilation : « Live at the
BBC » reçoit son mbid) ; deux candidats de types primaires différents et une entrée sans `releaseType` →
`ambiguous`, rien n'est posé (règle TRA-560) ; une entrée avec `year` dont l'année diffère de plus de ±1
→ `year-mismatch`, rien n'est posé ; `year` et `releaseType` sont **complétés seulement s'ils sont
absents** ; `name` et `slug` ne changent jamais ; (b) **ajoute** les release groups retenus par 8-D1 qui
ne correspondent à aucune entrée existante (par mbid, puis par titre normalisé), dans l'ordre de
priorité de 8-D1, tant que la liste reste ≤ 40 ; une liste déjà à 40 ou plus ne reçoit rien ; (c) le
slug d'une entrée ajoutée est `makeScopedSlug("project", title, pickScopeArtistName([node.name]))`
(`src/slug.ts:162`, comme le pipeline l.1313-1315), **rattaché à un nœud projet existant** d'abord par
mbid (index `mbid → slug` des `cache/nodes/project/`), sinon par `resolveReadSlug` sur le slug calculé
(redirections de `data/slug-redirects.json`) ; (d) la liste est re-triée selon 8-D1 (5) **seulement si
elle a changé** ; une liste intacte est octet pour octet identique. Garde-fou d'identité sans requête
supplémentaire : si aucun release group de l'artiste n'a pour premier crédit un nom normalisé égal au
`name` du nœud (ou à l'un des crédits si le nœud est un groupe), l'artiste est **sauté** (`name-mismatch`)
et listé dans le manifeste. Rejeté — remplacer les listes LLM par la liste MusicBrainz comme le fait le
pipeline : un backfill ne doit jamais effacer une entrée que Raphael a pu valider (règle de la Partie 1).
Rejeté — rapprocher par double face A : identité approximative, réservée aux pochettes (TRA-612).

**8-D4. Les entrées ajoutées sont des arêtes seules : ni nœud `project`, ni arête inverse, ni
`pending-reverses.json`.** Le graphe est « arêtes d'abord » (294 nœuds pour 5 854 arêtes) ; la pochette
d'une arête vient de son mbid sans nœud (3b-D1/D2) ; un nœud par entrée ajoutée coûterait un appel
Gemini chacun et entrerait dans `data.json`, la recherche et l'audit (3b-D3 l'a déjà rejeté). L'écriture
passe par `nodePayloadSchema.safeParse` + `onlyAddsSchemaDefaults` + `atomicWriteJson`, jamais
`NodeCache.write` (modèle `2026-10-19-backfill-landmark-highlights.ts:140, 844-855`). Les nœuds projet
existants ne sont pas touchés : quand un projet existe et crédite l'artiste, l'inverse
`project.artists → artist.discography` est déjà posée (`cache.ts:585-636`). Rejeté — nœuds squelettes
(3b-D3). Rejeté — pré-matérialiser par `scripts/top-up-dangling.ts` : hors scope, coût LLM.

**8-D5. À la génération, MusicBrainz continue de remplacer la liste du LLM, avec la politique 8-D1 ;
le plafond passe de 80 à 40.** Le brouillon Gemini n'est pas une donnée existante : il contient des
doublons et des titres de remplissage (TRA-601, `PLACEHOLDER_TITLES`). Seul le filtre change : crédits
(8-D2), titres non canoniques, plafond. Sans mbid, ou MusicBrainz indisponible, ou aucun release group
retenu, la liste Gemini reste (existant, l.1294 et 1332) ; `enforceArtistChoices` (l.1944) garde
`landmark_project` dans la liste. Rejeté — fusionner comme le backfill : réintroduit les doublons du LLM
dans chaque nouvelle fiche.

**8-D6. Mesure : deux métriques d'audit cliquetées, et un script de pochettes en lecture seule.**
`scripts/audit-cache.ts` gagne `discography-edge-without-mbid` (1 214 aujourd'hui) et
`artist-discography-under-3` (196), plafonds posés à ces valeurs dans `data/integrity-thresholds.json`
puis abaissés par la PR de cache (cliquet `scripts/ci/threshold-ratchet.ts`). Le taux de pochettes n'est
mesurable qu'avec le sidecar `cache/images/` (ignoré par git, 3b-D3) ou en HTTP : nouveau
`scripts/measure-discography-covers.ts`, (a) mode hors ligne sur un dossier de cache contenant `nodes/`
et `images/` — par arête de discographie : `found` / `missing` / `unavailable` / `absent` (clé = slug
scopé de l'arête, ou `image_url` du nœud projet s'il existe), agrégé par artiste et au total ; (b) mode
HTTP `--base <url> --artists <slugs>` qui appelle `GET /node/:slug` puis `GET /image/<slug>?from=<artist>`
pour chaque arête, relance sur 202 (6 × `retry_after_seconds`, comme le web), et compte les 200 `found`.
Mesure prod « avant » : rsync en lecture seule de `/opt/odyssey-music/cache/{nodes,images}` vers le
scratchpad du runner + mode (a), et mode (b) sur les 10 témoins ; « après » : les mêmes, 24 h après le
run (le temps que la file de fond résolve). Rejeté — un compteur dans `/health` : il n'est pas par
artiste et ne survit pas au redémarrage.

**8-D7. Run dépôt puis run prod par le canal, avec une mesure à blanc produit obligatoire.** La PR du
script joint le manifeste du dry-run sur le cache du dépôt **et** un tableau pour 10 témoins nommés :
Daft Punk, Aphex Twin (sans mbid : attendu « sauté »), John Lennon, John Coltrane, The Beatles, Burial
(sans mbid : « sauté »), Miles Davis, Björk, Frank Zappa (prolifique : vérifie le plafond ; remplace
Prince, absent du dépôt), et **Kode9 lu dans le manifeste de la preview du canal** (il n'existe qu'en
prod). Pour chacun : entrées avant / après, mbid posés, ajouts (titre, type, année), ambiguïtés, quasi-doublons (`nearDuplicates`), et unjugement produit (compilation prise pour une œuvre ? single parasite ? album manquant ?). Le run prod
n'est lancé qu'après ce tableau. Même convention que D10 : dry-run par défaut, manifeste déterministe,
`--resume`, 1 req/s.

### Découpage

`[P]` = parallélisable dans sa vague ; 1 pt ≈ 1,5 h ; chaque tâche < 300 lignes de diff (tests compris),
un seul type de changement, ≤ 600 lignes par PR sinon OK de Raphael. Rappels pour chaque ticket :
MusicBrainz à 1 req/s (file existante, ne pas la contourner), aucune donnée personnelle dans les
en-têtes ; tests `env -u GEMINI_API_KEY npx vitest run <fichiers> --maxWorkers=2` ; jamais `--no-verify` ;
jamais d'édition de `cache/` à la main ; `scripts/migrations/` et le schéma = `tier/3`.

#### Partie 8a — Politique partagée et prévention à la génération (déployable seule)

- [ ] TRA-613 8.1 `[P]` Politique de sélection pure (`src/discography-policy.ts`, `test/discography-policy.test.ts`)
      — tier/2, 3 pts
- [ ] TRA-614 8.2 `[P]` `fetchArtistDiscographyMb` : crédits, validation, `unavailable`
      (`src/musicbrainz.ts`, `test/musicbrainz.test.ts`, `test/helpers/pipeline-mocks.ts`) — tier/2, 2 pts
- [ ] TRA-615 8.3 Pipeline : l'override utilise la politique, plafond 40 (`src/pipeline.ts`,
      `test/pipeline-e2e.test.ts`) — tier/2, 2 pts (dépend de 8.1, 8.2)
- [ ] TRA-616 8.4 `[P]` Audit : deux métriques cliquetées (`scripts/audit-cache.ts`,
      `data/integrity-thresholds.json`, `test/audit-cache.test.ts`) — tier/3 (sensitivePath), 1 pt

#### Partie 8b — Backfill des discographies (dépend de 8a)

- [ ] TRA-617 8.5 `[P]` Fusion pure `mergeDiscography` (`src/discography-policy.ts`,
      `test/discography-merge.test.ts`) — tier/2, 3 pts (dépend de 8.1)
- [ ] TRA-618 8.6 Migration `scripts/migrations/2026-10-21-backfill-discography-mbid.ts` : CLI, manifeste,
      `--resume`, `--only` (`test/backfill-discography-mbid.test.ts`) — tier/3, 3 pts (dépend de 8.2, 8.5)
- [ ] TRA-619 8.7 `[P]` Test du canal (`test/migration-channel-discography-mbid.test.ts`) — tier/3, 1 pt
      (dépend de 8.6)
- [ ] TRA-620 8.8 Mesure à blanc (10 témoins) puis run dépôt : PR `chore(cache)` + plafonds abaissés
      — tier/3 (sensitivePath), 2 pts (dépend de 8.6, 8.4)
- [ ] TRA-621 8.9 Run prod : preview du canal (Kode9 lu dans le manifeste), apply, mesure « après »
      — tier/3, 2 pts (dépend de 8.7, 8.8, 8.10)

#### Partie 8c — Mesure des pochettes (déployable seule)

- [ ] TRA-622 8.10 `[P]` `scripts/measure-discography-covers.ts` (hors ligne + HTTP) et mesure prod
      « avant » jointe au ticket (`test/measure-discography-covers.test.ts`) — tier/2, 2 pts

**Vagues** : A = {8.1, 8.2, 8.4, 8.10} (≤ 3 lanes, 8.10 peut attendre) → B = {8.3, 8.5} → C = 8.6 →
D = {8.7, 8.8} → E = 8.9. 8a est livrable seule (les nouvelles fiches gagnent la politique) ; 8c aussi ;
8b n'a de valeur qu'après 8.9.

#### Contenu attendu par tâche

**8.1 — Politique.** Nouveau module, aucune I/O. Types : `ReleaseGroupCandidate = { mbid; title;
firstReleaseDate; primaryType; secondaryTypes: string[]; artistCredits: { mbid; name }[] }`,
`DiscographyPolicy = { artistMbid: string; artistName: string; cap: number }` (`DEFAULT_DISCOGRAPHY_CAP = 40`),
`ExclusionReason = "secondary-type" | "primary-type" | "credit" | "various-artists" | "non-canonical"`.
Fonctions : `isNonCanonicalReleaseTitle(title): boolean` ; `classifyRelease(c, policy): { ok: true } |
{ ok: false; reason }` ; `selectReleases(candidates, policy): { kept: ReleaseGroupCandidate[]; excluded:
{ mbid; title; reason }[] }` (règles 8-D1 (1)→(4)) ; `orderDiscography(edges: EdgeRef[]): EdgeRef[]`
(8-D1 (5), stable, sans date en dernier) ; `toDiscographyEdge(c, policy): EdgeRef | null` (slug scopé via
`makeScopedSlug` et `pickScopeArtistName`, `year` = 4 premiers caractères, `releaseType` en minuscules).
Critères (tests nommés) : « Control Your Body (Hardwell edit) », « No Limit (Remixes, Pt. 3) », « Megamix »,
« The Remix Album », « Essence (4 Track Album Sampler) », « Body Mind & Soul (Original Mix) » → exclus
`non-canonical` ; « Discovery », « Random Access Memories », « Da Funk », « Selected Ambient Works 85–92 »,
« Live at the Apollo » → gardés ; crédit `[Spaceape, Kode9]` → exclu `credit`, `[Kode9, Spaceape]` → gardé,
3 crédits → exclu, Various Artists → exclu ; 5 albums + 90 singles → 5 albums + 35 singles les plus
récents, ordre final par année décroissante ; 45 albums → 40 albums, 0 single ; une entrée sans date est
dernière ; `orderDiscography` est stable sur une liste déjà triée.

**8.2 — Client MusicBrainz.** `src/musicbrainz.ts:560-632` : `inc=artist-credits` sur chaque page,
parse manuel (`id`, `title`, `first-release-date`, `primary-type`, `secondary-types`, `artist-credit[].artist.{id,name}`),
entrée sans `id` ou sans titre ignorée et comptée, page en échec → `unavailable: true` (la liste rendue
reste celle des pages lues), `priority` transmis à `mbFetch`. Les mocks de `test/helpers/pipeline-mocks.ts:110`
et les tests de `test/pipeline-e2e.test.ts` (l.248, 402, 935-1000, ~1709-1755) passent à la nouvelle
forme. Critères (`test/musicbrainz.test.ts`, fetch stubbé) : l'URL porte `inc=artist-credits` ; 3 types ×
pagination jusqu'à 4 pages ; crédits lus ; 503 sur une page → `unavailable: true` ; réponse malformée →
entrée ignorée, pas d'exception ; les tests d'espacement (l.957+) restent verts.

**8.3 — Pipeline.** `src/pipeline.ts:1287-1336` : `selectReleases` + `toDiscographyEdge` remplacent le
bloc `PRIMARY_OK` / `TARGET = 80` ; `unavailable: true` → journal `MB discography unavailable, LLM list
kept` et liste Gemini conservée ; le journal existant (l.1333) indique albums / EP / singles / exclus.
Critères (`test/pipeline-e2e.test.ts`) : artiste avec mbid, mock de 5 albums + 90 singles + 1 single
crédité en second + 1 compilation VA → 40 entrées, 5 albums, aucun crédit secondaire, ordre par année ;
`unavailable` → liste du brouillon intacte ; `landmark_project` reste membre de la liste ; aucun autre
test ne change.

**8.4 — Audit.** `Collector` de `scripts/audit-cache.ts` : `discography-edge-without-mbid` (par arête)
et `artist-discography-under-3` (par artiste, `discography.length < 3`) ; plafonds initiaux 1 214 et 196.
Critères : test unitaire sur un cache temporaire ; `npm run check` et le job `integrity` verts sur le
cache de `main` sans changer les autres seuils.

**8.5 — Fusion.** Dans `src/discography-policy.ts` : `mergeDiscography(input: { existing: EdgeRef[];
candidates: ReleaseGroupCandidate[]; allCredited: ReleaseGroupCandidate[]; policy; projectIndex:
{ byMbid: Map<string, Slug>; resolveSlug: (slug: Slug) => Slug } }): MergeResult` avec `MergeResult =
{ edges: EdgeRef[]; changed: boolean; posed: { slug; mbid; filled: ("year" | "releaseType")[] }[];
added: { slug; mbid; title; year?; releaseType }[]; ambiguous: { slug; reason: "multiple" | "type" |
"year-mismatch" }[]; capReached: boolean }` (8-D3 (a)→(d)). Critères : pose sur titre unique ; « Live at
the BBC » posé depuis `allCredited` bien qu'exclu des ajouts ; deux candidats de types différents sans
`releaseType` → `ambiguous/type` ; `year` « 1968 » contre 1975 → `year-mismatch` ; `year` et
`releaseType` absents complétés, présents inchangés ; doublons existants (« Birth of the Cool » ×2) tous
posés, aucun retiré ; ajout rattaché au slug du nœud projet par mbid, sinon redirection, sinon slug scopé ;
liste à 40 → rien ajouté, `capReached` ; liste intacte → `changed: false` et référence identique.

**8.6 — Migration.** `scripts/migrations/2026-10-21-backfill-discography-mbid.ts`, contrat de fait
(`MIGRATION_NAME`, `DEFAULT_MANIFEST_PATH = "out/discography-mbid.json"`, `runBackfill(options): Promise<{
manifest; written; exitCode }>`, `formatSummary`, `parseCliArgs` strict : `<cache-dir> [--apply]
[--manifest <p>] [--data-dir <d>] [--resume] [--only <slug,…>]`, `main()` gardé par `import.meta.url`).
Lecture par `readCacheNodes` (`2026-09-04-merge-genre-duplicates.ts:362`), exclusions lues dans
`--data-dir/identity-exclusions.json` (copie du canal, `sync-genre-cache.sh:443-444`) sinon `data/`,
redirections par `loadRedirects` + `resolveReadSlug` (`src/genre-registry.ts:165-214`). Manifeste
déterministe (trié, sans horodatage ; `removed: []`, `renamed: {}`, `redirects: {}`), par artiste :
`{ slug, mbid, before, after, posed, added, ambiguous, nearDuplicates, excluded (compteurs par raison), skipped?:
"no-mbid" | "excluded" | "name-mismatch" | "unavailable" | "cap" }`, totaux en tête. Point de reprise tous
les 25 artistes ; `--resume` saute un artiste dont la liste est celle que le manifeste précédent a décidée
(modèle similar-artists l.352). Critères (`test/backfill-discography-mbid.test.ts`, cache `mkdtemp`,
fetch injecté) : dry-run n'écrit aucun nœud et produit le manifeste ; `--apply` écrit par
`atomicWriteJson` après `safeParse` + `onlyAddsSchemaDefaults` ; nœud intact non réécrit ; artiste exclu
/ sans mbid / `name-mismatch` / `unavailable` sauté avec la raison ; `--only artist:kode9` ne lit que lui ;
deux runs donnent le même manifeste ; `pending-reverses.json` et `cache/nodes/project/` inchangés ;
≤ 1 requête à la fois (compteur sur le fetch injecté).

**8.7 — Canal.** `test/migration-channel-discography-mbid.test.ts` sur le modèle de
`migration-channel-landmark-highlights.test.ts` (ssh et rsync factices) : la migration passe par
`--migration 2026-10-21-backfill-discography-mbid`, le manifeste est accepté par la validation de forme
(`sync-genre-cache.sh:538-610`), l'union passe `validate-migrated-union.ts`, aucune suppression.

**8.8 — Run dépôt.** Dry-run complet sur `cache/` (≈ 497 artistes, ≈ 1 500 à 2 000 requêtes, ≈ 30 min),
tableau des 10 témoins (8-D7) dans la PR du script **avant** merge ; puis `--apply --data-dir data`,
PR `chore(cache): discographies MusicBrainz sur le cache du dépôt` avec `data/integrity-thresholds.json`
abaissé aux nouvelles valeurs. Critères : part d'arêtes avec mbid ≥ 90 % ; artistes avec mbid à moins de
3 entrées ≤ 20 (reste : artistes à 0-2 release groups retenus, listés) ; aucun artiste au-dessus de 40
qui n'y était déjà ; aucun `name`/`slug` existant modifié (diff vérifié par un script jetable) ; job
`integrity` vert.

**8.9 — Run prod.** `workflow_dispatch` `sync-genre-cache.yml` avec `migration=2026-10-21-backfill-discography-mbid`
sans `apply` (preview) → manifeste de l'union lu : entrée `artist:kode9` (attendu : « Memories of the
Future », « Black Sun », « Nothing » ajoutés, mbid posés sur ses 2 entrées si titres exacts) et totaux ;
puis `apply=true` depuis `main` propre ; vérification `GET /node/artist:kode9` (≥ 5 entrées avec mbid) et
`GET /image/<slug>?from=artist:kode9` → `found` ≤ 60 s ; mesure « après » par 8.10 à +24 h.

**8.10 — Mesure des pochettes.** Script en lecture seule (8-D6), sortie JSON + tableau texte : par
artiste `{ edges, withMbid, found, missing, unavailable, absent }` et totaux ; mode HTTP borné (6 relances,
10 témoins). Aucune écriture, aucune requête MusicBrainz. Critères : test sur un cache temporaire avec
sidecar ; mode HTTP testé contre un serveur factice (202 puis 200) ; mesure prod « avant » (hors ligne +
HTTP sur les 10 témoins) jointe au ticket avant 8.9.

### Risques et garde-fous

- **Mbid d'artiste faux sur un nœud → discographie d'un autre artiste ajoutée en bloc.** Garde-fous :
  exclusions TRA-574, `name-mismatch` sans requête (8-D3), tableau des 10 témoins avant tout apply,
  manifeste exhaustif relu par le dispatcher, aucune suppression (réversible par une migration de retrait
  par mbid).
- **Singles parasites et compilations.** Garde-fous : crédits (8-D2), titres non canoniques, plafond
  albums d'abord ; les cas nommés de la mesure sont des tests.
- **Quasi-doublons à l'ajout.** Une entrée existante sans mbid dont le titre diffère du release group
  (« Sine of the Dub » contre « Sine of the Dub / Stalker », TRA-612) n'est pas rapprochée, et la règle
  (b) ajoute le release group à côté. Garde-fou : le manifeste compte les ajouts dont le titre normalisé
  commence par celui d'une entrée existante sans mbid (`near-duplicate`), et ils apparaissent dans le
  tableau des témoins ; on décide sur cette mesure, sans rapprochement approximatif dans le script.
- **Panne MusicBrainz en cours de run.** Garde-fous : `unavailable` distinct du vide, artiste sauté et
  listé, `--resume`, 3 tentatives de `mbFetch`.
- **Changement d'ordre des listes existantes** (tri par année) : `landmark_project` reste membre ; les
  chips web et iOS suivent l'ordre reçu ; accepté.
- **Prod-only (Kode9) et union.** Le canal unionne dépôt ∪ prod : la migration tourne sur les artistes
  JIT ; les nœuds du dépôt déjà traités par 8.8 sont intacts (`changed: false`).
- **Taille des PR.** Les PR de code restent < 300 lignes ; la PR de cache est une PR de données, comme
  #528 et #537.
- **Volume MusicBrainz** : ≈ 2 000 requêtes à 1 req/s pour le dépôt, autant pour la prod ; aucune
  parallélisation au-delà de la file.

### Critères de sortie

- Dépôt : arêtes `discography` avec mbid ≥ 90 % (79,3 % avant) ; artistes avec mbid à moins de 3
  entrées ≤ 20 (164 avant) ; plafonds d'audit abaissés d'autant ; aucune liste existante raccourcie.
- Prod : `artist:kode9` liste ≥ 5 œuvres avec mbid ; leurs pochettes sont `found` sans rapprochement
  par titre ; la mesure 8.10 « après » montre un taux `found` supérieur à « avant » sur les 10 témoins et
  au total.
- Génération : une fiche artiste nouvelle a ≤ 40 entrées, albums tous présents jusqu'au plafond, aucun
  crédit secondaire ni titre non canonique (test 8.3).
- Un re-run des deux migrations (dépôt, prod) produit un manifeste sans `posed` ni `added`.

### Questions ouvertes pour Raphael — tranchées le 2026-10-18

1. **Listes existantes au-dessus du plafond** (44 artistes, 16 à 80 entrées, singles dominants) : les
   laisser intactes (recommandé, « jamais de suppression ») ou prévoir une migration de retrait des
   singles au-delà de 40, après mesure ?
2. **Génération** : MusicBrainz continue de **remplacer** la liste Gemini (8-D5) plutôt que de la
   fusionner comme le backfill. Confirmer.
3. **Compléments additifs** : poser aussi `year` et `releaseType` quand ils manquent sur une entrée
   rapprochée (8-D3 (a)), au-delà du seul mbid du brief. Confirmer.

Réponses de Raphael (2026-10-18, « plan validé go ») : (1) les 44 listes existantes au-dessus de 40
restent intactes, aucune migration de retrait ; (2) confirmé, MusicBrainz remplace la liste Gemini à la
génération ; (3) confirmé, `year` et `releaseType` sont complétés quand ils manquent. Risque ajouté par
le dispatcher : quasi-doublons à l'ajout, compteur `near-duplicate` dans le manifeste (8.6) et colonne
dans le tableau des témoins (8.8).

### Amendements en cours de livraison (2026-10-19)

Ces décisions ont été prises au fil des reviews et des mesures à blanc réelles. Elles priment sur le texte
de 8-D1, 8-D6 et 8.4 ci-dessus.

- **8-D6 / 8.4 (#541, review profonde) : deux métriques strictes auraient bloqué toute PR de données**
  qui ajoute un artiste, liste Gemini sans mbid ou liste MusicBrainz de moins de 3 entrées. Désormais :
  - `artist-discography-under-3` (196) est une métrique de couverture `"artist"` ;
  - nouvelle métrique `artist-discography-without-mbid` (339, par artiste), de couverture `"artist"` ;
  - `discography-edge-without-mbid` (1 214) devient informative.

  Suivi TRA-623 (#545) : l'arête inverse projet → artiste porte le mbid du projet.
- **8-D1, priorité sous le plafond** (TRA-625, #549). La mesure à blanc de TRA-618 a montré que « les
  plus récents d'abord » remplit les 40 places des Beatles de pirates et coupe Abbey Road. La priorité
  devient :
  1. voté avant non voté (`inc=ratings`, `ratingVotes`) ;
  2. album, puis EP, puis single ;
  3. votes décroissants ;
  4. le plus ancien d'abord ;
  5. titre, puis mbid.

  Les types secondaires `Soundtrack` et `Mixtape/Street` sont admis (Help!, A Hard Day's Night ; ex-TRA-627).
  L'ordre affiché reste par année décroissante.
- **8-D1, coupe des non votés** (TRA-628, #550). Si l'artiste a au moins 10 candidats votés, les non votés
  sont exclus (`unrated`), sauf les sorties de l'année précédente ou plus récentes (`currentYear`).
  Cela retire 55 Lost Lennon Tapes et Archives ; Kode9, à 0 vote, n'est pas touché.
- **8-D3, pose** (TRA-625 et TRA-628). Une entrée sans type face à un seul album admis, accompagné de
  singles, EP ou homonymes Live/Compilation, reçoit l'album (Giant Steps, Blue Train, Imagine). Une entrée
  typée garde la garde de type de TRA-617.
- **8.6 (#548, review profonde)** :
  - la sortie vaut 1 seulement sur refus ou au-delà de 20 % d'`unavailable` ;
  - un ajout ne suit une redirection que si la cible est scopée sur l'artiste ;
  - `DISCOGRAPHY_POLICY_VERSION` (3) et `currentYear` entrent dans l'empreinte de reprise.
- **8.10 (TRA-622)** : la mesure prod « avant » est faite en HTTP sur les 10 témoins, 64 pochettes sur
  86 arêtes (74,4 %). Une mesure hors ligne de prod demanderait un accès SSH, qui ne passe que par la CI.
- **Mesure à blanc finale** (TRA-618, politique v3, MusicBrainz réel) :
  - témoins du dépôt : part d'arêtes avec mbid de 56,6 % à 95,1 % ;
  - Kode9 : 2 → 26 entrées, dont Memories of the Future, Black Sun et Nothing ;
  - réserves connues : quelques albums tardifs peu votés de Coltrane coupés, et les albums crédités
    « The Mothers of Invention » absents chez Zappa (non-but).

### Amendements et bilan (2026-10-20)

- **Politique v4** (TRA-629, #553) : la clé de rapprochement retire les suffixes « (année) » et « EP ». La pose se fait en deux passes : d'abord le titre exact, puis la clé élargie, toujours sur le groupe complet. Une entrée « X EP » ne prend qu'un EP admis. La branche typée écarte les Live et les Compilation. Résultat : 20 vrais doublons (Kool and the Gang, Armin van Buuren…) reçoivent leur mbid au lieu d'être ajoutés une seconde fois. Il a fallu trois blocages de la review IA et trois reviews profondes.
- **Garde d'identité par alias** (TRA-630, #554) : `name-mismatch` accepte aussi le nom, le sort-name et les alias MusicBrainz, sauf les « Search hint ». La normalisation garde les points (H.A.W.K. ≠ Hawk). Les 20 faux positifs (Sakamoto, Hisaishi, Mulatu Astatke…) sont acceptés, sans aucun homonyme.
- **Politique v5** (TRA-647, #564), après la review produit de la PR de cache, qui avait trouvé 5 identités fausses : Trans-Europe Express, Joe's Garage, Merry Christmas Mr. Lawrence, Vrioon, Black Brown and Beige. Une entrée sans type ni année ne reçoit plus de mbid dans trois cas :
  - un candidat non voté chez un artiste qui en a au moins 10 votés (`unrated-pose`) ;
  - un mbid qui contredit le nœud projet (`node-conflict`) ;
  - un release group dont l'artiste n'est pas le crédit principal (`credit`, jugé sur le release group retenu, pas avant la décision).

  Le compromis est acté par le dispatcher : une pose fausse est définitive, une pose manquée se rattrape. On perd environ 25 poses correctes et on évite environ 8 fausses. TRA-649 doit les récupérer.
- **User-Agent MusicBrainz** sans adresse e-mail (TRA-626, #559). Le test du canal (TRA-619, #552) passe le vrai `deploy/sync-genre-cache.sh`.
- **Run dépôt** (TRA-620, #562, politique v5) :
  - 365 fiches artistes réécrites ; 778 mbid posés et 6 715 œuvres ajoutées ; aucune entrée perdue ;
  - arêtes avec mbid de 79,3 % à **96,5 %** ;
  - artistes avec mbid à moins de 3 entrées : de 164 à 37 ; les autres n'ont presque aucun release group sur MusicBrainz (Larry Levan, Ron Hardy…) ;
  - plafonds `artist-discography-under-3` de 196 à 69 et `artist-discography-without-mbid` de 339 à 181.
- **Run prod** (TRA-621, runs 39419311014 en preview et 39424381680 en apply) :
  - union dépôt ∪ prod : 38 nœuds prod-only écrits, 73 mbid posés et 475 œuvres ajoutées ; aucune suppression, aucun renommage ;
  - arêtes avec mbid de 95,6 % à 96,3 % ;
  - **Kode9 : de 2 à 26 œuvres, dont 24 avec mbid**. Memories of the Future, Black Sun, Nothing, Escapology et Astro-Darien ont leur pochette dès le premier appel, depuis le Cover Art Archive par mbid ;
  - pochettes des 10 témoins : 74,4 % avant (64 sur 86) et **90,1 %** juste après l'apply (246 sur 273). La mesure de référence est à faire à +24 h.
- **Suites** :
  - TRA-649 : rattraper les poses perdues en v5 ;
  - TRA-633 : environ 33 doublons restants (sous-titres, traductions, translittérations) et 28 slugs dégénérés sur des titres non latins ;
  - TRA-624 : enrichir les arêtes inverses existantes ;
  - TRA-632 : harnais des tests de canal ;
  - TRA-642 : `ios-check` instable sous charge ;
  - le canal ne rejoue pas le manifeste de cette migration à l'apply (deux passes MusicBrainz dans le même job de 120 min), à traiter si un run dépasse.
