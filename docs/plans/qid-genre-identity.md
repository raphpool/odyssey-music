# Identité de genre par QID Wikidata

## Problème

L'identité d'un genre est aujourd'hui une **chaîne de caractères**. Elle est
produite par Gemini en texte libre, puis écrasée par les tags MusicBrainz
(`fetchEntityGenresMb`, `src/musicbrainz.ts:392`), re-titrecasée et re-sluggée
(`src/pipeline.ts:797/887/954`). Rien ne garantit qu'un même genre s'écrive deux
fois pareil.

Conséquences mesurées sur le corpus :

- **20 paires de nœuds doublons** : `Electronic`(171 usages) + `Electronic music`(32),
  `Ambient`(106) + `Ambient music`(3), `Synth-pop`(29) + `Synthpop`(3). Le contenu
  d'un genre est coupé en deux et le user n'en voit qu'une moitié.
- **La jointure rate.** Un user qui coche `Techno` ne matche que les nœuds tagués
  littéralement `techno` ; tout ce que MusicBrainz a tagué `minimal techno` ou
  `detroit techno` est invisible ou relégué au palier de bruit.
- **Les sélections du user sont fragiles.** Le profil stocke des slugs de graphe ;
  un renommage de nœud casse la sélection en silence (`byId.has` échoue, le genre
  est ignoré sans erreur).
- **Aucune hiérarchie exploitable**, alors que `data/genre-catalog.json` contient
  6 207 genres Wikidata avec QID et parents — utilisé aujourd'hui à **un seul
  endroit** (`src/pipeline.ts:1020`, backfill de `parent_genres`). Le champ
  `wikidata_qid` n'est lu nulle part.

Le QID est l'identifiant d'entité Wikidata (`Q170611` = techno). Stable, unique,
indépendant de la langue, et pivot vers MusicBrainz, Discogs et AllMusic.

### Complément du 2026-09-09 — le slug ignore l'identité

Une fois les Parties 1 à 3 livrées (96,7 % des arêtes de genre et 256 nœuds
genre sur 274 portent un `qid`), la fusion des doublons a été gelée avant son
`--apply` sur le constat suivant, vérifié ligne par ligne sur `main` :

- **Aucun code ne demande « existe-t-il déjà un nœud genre pour ce QID ? ».**
  Le slug — la vraie clé d'identité du cache — est partout une fonction pure du
  *nom* : `normalizeEdge` (`src/pipeline.ts:1264`, `makeSlug(t, r.name)`),
  `mbGenreEdges` (`:805-806`, qui calcule `identity = resolver.resolve(...)` puis
  jette `identity.slug` pour refaire `makeSlug` du nom MB), le backfill
  `parent_genres` (`:1054`, `catalog.get(body)` slug-exact), et
  `handleMaterialize` (`src/services/materialize-service.ts:46-47`, `cache.get`
  → NotFound → `runJit` mint). `data/genre-redirects.json` n'est lu par personne
  côté pipeline ni services.
- **La cause dominante des doublons est le catalogue, pas Gemini.** Pour les
  7 plus grosses paires, le second slug est exactement le slug Wikidata :
  `electronic-music`, `ambient-music`, `house-music`, `pop-music`, `rock-music`,
  `intelligent-dance-music`, `synthpop`. 56 entrées du catalogue ont pour parent
  `electronic-music`, **0** ont `electronic` : chaque enfant reçoit une arête
  `parent_genres → genre:electronic-music`, jamais vers `genre:electronic`
  (179 usages). 13 des 24 références à `electronic-music` sont des `parent_genres`.
- **MusicBrainz n'est pas sûr non plus.** `data/genre-qid-map.json` contient
  4 paires de tags partageant un QID (`club`/`dance`, `rhumba`/`rumba`,
  `classic blues`/`vaudeville blues`, `contemporary gospel`/`urban contemporary
  gospel`). Un seul artiste tagué des deux crée deux nœuds de même `qid`.
- **La fusion telle que spécifiée régresse mécaniquement.** Quelle que soit
  l'élection, un producteur recrée le perdant : si `electronic-music` gagne, le
  prochain tag MB `electronic` re-mint `genre:electronic` — **sans qid**, car
  `catalog.get("electronic")` rate, donc invisible pour le rapport de doublons ;
  si `electronic` gagne, le backfill catalogue re-mint `electronic-music` via
  ses 56 enfants.

D'où la Partie 4 « Prévention », insérée avant la fusion.

## Non-buts

Ce projet ne livre **que l'identité**. Explicitement hors scope :

- La refonte de la reco (suppression du chemin B, index inverse genre → porteurs).
- La grille NTS et le picker hiérarchique de genres.
- Le seeding des familles absentes du corpus (Latin, Asia, African).
- La migration du profil `localStorage` vers des QIDs — elle arrivera avec le picker.
- Fermer le repli `data.tags` de MusicBrainz (`src/musicbrainz.ts:405`), qui est la
  vraie source de texte libre. C'est un changement de comportement : à traiter à part.
- Unifier le vocabulaire MusicBrainz (2 192 genres) avec le catalogue Wikidata :
  la jointure par QID y ferait entrer une centaine d'entrées qui ne sont pas des
  genres musicaux (radio drama, ASMR, interview).

## Décisions d'archi

**1. L'identité est le QID Wikidata, pas le MBID de genre ni un slug maison.**
Rejeté — le MBID de genre MusicBrainz : il existe et est stable, mais il ne porte
aucune hiérarchie et 5 % du vocabulaire MB est hors du catalogue. Rejeté — un
identifiant maison : aucun pivot vers les sources externes qu'on branchera ensuite.

**2. On résout après, on ne contraint pas avant.**
Gemini continue d'émettre du texte ; un résolveur déterministe tranche.
Rejeté — un enum de 6 207 valeurs dans le `responseSchema` : irréaliste à cette
taille, gonfle chaque prompt, et n'empêche pas la dérive sur les entités absentes.

**3. Jointure par identifiant d'abord, par chaîne en secours.**
MusicBrainz renvoie déjà le MBID du genre dans la réponse que le pipeline reçoit
(`inc=genres+tags`) et le code le jette. Wikidata porte le lien inverse via la
propriété **P8052**, complète à 99,5 % (2 181 des 2 192 genres MB).
Rejeté — un matcher de chaînes seul : mesuré à 88 % des occurrences contre
**96,7 %** en combinant les deux, et il rate précisément la tête de distribution
(`IDM` 144 usages, `R&B` 17, `Minimalism` 28).

**4. `qid` est un champ optionnel porté par l'arête, à côté de `mbid`.**
Le précédent existe : `mbid` est déjà déclaré sur `edgeRefBase`
(`src/schemas.ts:10-23`) et propagé par `normalizeEdge` (`src/pipeline.ts:1228`).
On suit exactement ce chemin. `src/graph.ts:105-112` recopie les tableaux d'arêtes
en bloc — **vérifié** : aucune modification nécessaire pour que le QID atteigne
`web/data.json`.
Rejeté — une table externe slug → qid : ajoute une indirection et se désynchronise
du cache à la première écriture.

**5. Un genre non résolu est conservé et marqué, jamais supprimé.**
Rejeté — le drop : détruit du signal réel (`Braindance`, `Drill 'n' bass`) et rend
la couverture invisible. Le non-résolu est la file de curation d'alias.

**6. Le backfill est hors ligne, idempotent, dry-run par défaut.**
Rejeté — une résolution paresseuse à la prochaine écriture de chaque nœud : laisse
le corpus dans un état mixte pendant des semaines, et le TTL de 12 h rendrait la
progression imprévisible.

**7. L'identité gouverne le slug à l'émission, et on ne crée jamais un second
nœud pour un QID déjà présent.** *(2026-09-09)*
En une phrase : avant d'écrire une arête vers un genre, on regarde si un nœud
existe déjà pour ce genre — par son slug, par une redirection, ou par son QID —
et on pointe dessus au lieu d'en inventer un nouveau.
Règle, dans cet ordre : (1) résoudre nom → QID ; (2) si le slug dérivé du nom
existe en cache, **le garder** — aucune arête existante ne bouge, ce qui rend la
prévention sûre avant la fusion ; (3) sinon, si `data/genre-redirects.json` le
redirige, suivre ; (4) sinon, si un nœud existe pour ce QID, pointer dessus ;
(5) sinon, minter le slug dérivé du nom comme aujourd'hui. Un genre non résolu
est conservé tel quel (décision 5). Deux arêtes nouvelles de même QID dans un
même nœud se replient sur la première.
La règle s'applique en **un seul point** : `runPipeline`, entre
`enrichFromMusicBrainz` (`src/pipeline.ts:610`) et `validateNode` (`:611`), là
où les trois producteurs ont fini d'émettre et où `canonicalizeDraft` (agnostique
du champ) a déjà tout normalisé. Le registre entre dans `PipelineDeps` comme
dépendance optionnelle — `PipelineDeps` ne porte aujourd'hui ni cache ni
résolveur — et est construit partout où un `NodeCache` existe (`server.ts`,
`materialize-service`, `crawler`, `top-up-dangling`).
Rejeté — canonicaliser aux trois sites d'émission (`mbGenreEdges`, backfill
`parent_genres`, `normalizeEdge`) : trois fois le diff, trois surfaces de test,
et tout producteur futur reste sans protection. Rejeté — canonicaliser dans
`NodeCache.write` : le cache ne doit pas réécrire le contenu qu'on lui confie, et
les migrations l'évitent de toute façon (`atomicWriteJson`).

**8. L'index `qid → slug` vit dans `NodeCache`.** *(2026-09-09)*
En une phrase : c'est le cache qui sait quel fichier porte quel QID, parce que
c'est lui qui écrit les fichiers.
`NodeCache.findGenreSlugByQid(qid)` : construit paresseusement depuis les
274 fichiers `cache/nodes/genre/*.json`, mémoïsé, jeté à chaque `write()` d'un
nœud `genre`. `NodeCache.write` est le seul écrivain runtime de nœuds :
l'invalidation y est garantie sans câblage. En cas de collision (état transitoire
avant fusion), choix déterministe : slug le plus court, puis lexicographique —
coïncide avec le membre le plus utilisé dans 18 groupes sur 20.
Rejeté — une mémo dans un module registre avec `invalidate()` à appeler par
chaque écrivain : un oubli à un site d'écriture re-mint exactement le doublon
qu'on veut empêcher. Rejeté — un fichier `data/genre-qid-index.json` committé et
régénéré par script : se désynchronise à la première écriture (même motif que
l'alternative rejetée de la décision 4).

**9. Les gardes vivent à l'entrée des services.** *(2026-09-09)*
En une phrase : demander un genre qui a été fusionné renvoie le nœud survivant au
lieu de « introuvable » ou d'un nouveau nœud.
`handleMaterialize` (`src/services/materialize-service.ts:27-67`) consulte le
registre — redirections puis index QID — avant de minter un `genre`, et réécrit
la requête vers le canonique (un `fresh` rafraîchit le canonique, jamais le
perdant). `node-service.getNode` (`src/services/node-service.ts:16-21`) applique
**la table de redirections seule** : un slug jamais matérialisé reste `null`,
la lecture ne matérialise pas. Le contrat HTTP ne change pas ; `node.slug` dans
la réponse fait foi.
Rejeté — consulter l'index QID à la lecture : transformerait une lecture en
matérialisation implicite. Rejeté — un statut HTTP 3xx : l'API renvoie du JSON,
le front lit `node.slug`.

**10. À la rematérialisation, le `qid` déjà committé sur un nœud genre gagne
sur le `qid` fraîchement résolu.** *(2026-09-10)*
En une phrase : un refresh reporte l'identité, il ne la corrige jamais.
Parité avec la migration de backfill (TRA-21), qui laisse les conflits « as-is ».
Le désaccord est loggé ; toute correction d'identité passe par une migration ou
un ticket de curation — `cache/` est committé, c'est la base de connaissance —
jamais par un refresh. Motif concret : `genre:trap`, curé en Q47781397 (trap EDM)
par TRA-33. Un draft Gemini nommé « Trap (electronic) » ne résout pas ; le repli
sur le body `trap` donne Q2913982 (trap hip-hop) et aurait écrasé la curation au
prochain refresh TTL. Mécanisme : `GenreRegistry.existingGenreQid` (TRA-32) ; le
backfill `parent_genres` part de l'entrée catalogue du `qid` gagnant, pas du nom.
Rejeté — laisser gagner le résolveur : avec un TTL de 12 h, chaque curation
deviendrait une correction éphémère, défaite au premier refresh.

**11. Le front suit le slug servi, pas le slug demandé.** *(2026-09-10)*
En une phrase : le serveur peut répondre avec un autre nœud que celui qu'on lui a
demandé, et c'est le front qui s'aligne.
Conséquence directe de la décision 9 : `handleMaterialize` (TRA-29) et
`GET /node/:slug` (TRA-30) peuvent renvoyer un nœud dont `node.slug` diffère du
slug demandé ; la réponse expose `redirected_from`. Côté front (TRA-38), une
table d'alias client `slug demandé → slug servi` alimente `byId`, `show()` et les
chips. Le double-push du canonique dans `DATA.nodes` est déjà évité par TRA-29.
Rejeté — ne compter que sur la table de redirections exportée (TRA-23) : elle
couvre `?node=` et les deep links au chargement, pas les slugs obtenus à chaud
(une chip matérialisée, un clic dans la recherche). Les deux mécanismes sont
complémentaires.

## Découpage

**Statut au 2026-09-10.** Parties 1 à 3 livrées. Partie 4 : neuf tickets mergés
(TRA-24 à 28, 33, 34, 36, 37), trois en review `tier/3` (TRA-29 PR #30, TRA-30
PR #31, TRA-32 PR #32), TRA-31 à lancer après leur merge. Partie 5 : TRA-22, 23,
35, 38, 39 à faire.

### Partie 1 — Résolveur d'identité (aucun comportement modifié)

Pur ajout : une table de données et un module avec ses tests. Rien n'est branché,
donc déployable sans risque.

- [x] TRA-10 Construire la table `MB genre MBID → QID` depuis Wikidata (P8052) et
      la committer dans `data/genre-qid-map.json`, avec le script one-shot qui l'a
      produite et un rapport de couverture reproductible. `tier/2`
- [x] TRA-11 Ajouter `src/genre-identity.ts` : résolution d'un genre vers un QID par
      MBID puis par chaîne normalisée puis par table d'alias curée, avec tests
      unitaires sur les cas mesurés (`IDM`, `R&B`, `Minimalism`, `Prog-Rock`,
      `Ambient music`). `tier/2`
- [x] TRA-16 Exclure `data/genre-qid-map.json` du check `diff-size` de la CI
      (ticket de plomberie, hors projet Linear). `tier/3`

### Partie 2 — Capturer l'identité à la source

Les nouveaux nœuds portent un QID. Rien ne le lit encore : déployable seul.

- [x] TRA-9 Faire remonter le MBID de genre que MusicBrainz renvoie déjà :
      `fetchEntityGenresMb` passe de `Promise<string[]>` à une forme portant
      `{ name, mbid }`, et les trois appelants sont adaptés. Aucun appel réseau
      supplémentaire. `tier/2`
- [x] TRA-17 Déclarer `qid` sur les arêtes de genre et les nœuds genre (`EdgeRef`,
      `edgeRefBase`, format `Q[1-9]\d*`) et le propager dans `normalizeEdge`.
      `tier/3` — schéma
- [x] TRA-18 Stamper le `qid` depuis les trois producteurs MusicBrainz, le
      backfill `parent_genres` et `emitReverses`. `tier/3`
- [x] TRA-19 Propager le `qid` du nœud genre jusqu'au graphe exporté (`VizNode`,
      `backfillGenreReverses`). `tier/3`

TRA-12 (les trois ci-dessus en un seul ticket) annulé : scindé.

### Partie 3 — Backfill du corpus existant

- [x] TRA-20 Logique pure du backfill (`planBackfill` / `formatReport`), sans
      écriture. `tier/3`
- [x] TRA-21 CLI et exécution de la migration
      `scripts/migrations/2026-09-04-backfill-genre-qid.ts` sur le cache réel.
      Résultat : 96,7 % des arêtes de genre et 256/274 nœuds genre portent un
      `qid`. `tier/3` — `scripts/migrations/**`

TRA-13 (les deux en un) annulé : scindé.

### Partie 4 — Prévention des doublons à l'émission *(ajoutée le 2026-09-09)*

Décisions 7, 8, 9, 10. Déployable seule et **sûre avant la fusion** : une arête
vers un nœud existant ne bouge jamais, seuls les nouveaux slugs sont
canonicalisés. Elle doit être **entièrement mergée** avant le `--apply` de TRA-22.

- [x] TRA-24 Indexer les nœuds genre par QID dans `NodeCache`
      (`findGenreSlugByQid`, mémoïsé, invalidé à l'écriture d'un nœud genre).
      Pur ajout. `tier/2`
- [x] TRA-25 Harnais de test bout-en-bout de `runPipeline` avec les frontières
      mockées (`src/tools/tavily.js`, `src/tools/local-fetcher.js`,
      `@google/genai`, `src/musicbrainz.js`) — il n'en existait aucun. `tier/1`
- [x] TRA-26 Stamper le `qid` et les parents du nœud genre via le résolveur au
      lieu du lookup slug-exact `catalog.get(body)` (`src/pipeline.ts:1049-1062`).
      C'est ce qui laissait `genre:electronic` sans qid, donc invisible pour le
      rapport de doublons. `tier/3`
- [x] TRA-27 Créer `src/genre-registry.ts` : la règle de la décision 7
      (`canonicalSlugFor`, `canonicalizeGenreEdges`, `canonicalizeNodeEdges`) et
      le loader validé de `data/genre-redirects.json` (absent → table vide).
      Pur ajout. `tier/2`
- [x] TRA-28 Brancher le registre dans `runPipeline` (`PipelineDeps.genreRegistry?`,
      appel entre `:610` et `:611`) et l'injecter depuis `server.ts`,
      `materialize-service`, `crawler`, `top-up-dangling`. `tier/3`
- [x] TRA-33 Curation d'alias : « Trap (EDM) » → Q47781397 et `qid` du nœud
      `genre:trap` ; relecture de `minimal` / `alternative`. `tier/2`
- [x] TRA-34 Convention `-r-and-b` dans les slugs dérivés du catalogue
      (`genreDisplayName` / `makeSlug`) : le backfill `parent_genres` rendait le
      token `rb` au lieu de `R&B`. `tier/2`
- [x] TRA-36 Registre : `canonicalizeNodeEdges` ne partageait pas le `batchMemo`
      entre les champs de genre d'un même nœud. `tier/2`
- [x] TRA-37 Crawler et `top-up-dangling` : matérialiser par slug canonique, pas
      par nom re-dérivé. `tier/3`
- [ ] TRA-29 Garder `handleMaterialize` : servir le nœud genre canonique au lieu
      de re-minter un doublon. `tier/3` — **En review** (PR #30).
- [ ] TRA-30 Appliquer les redirections de genre à la lecture dans
      `node-service.getNode`. `tier/3` — **En review** (PR #31).
- [ ] TRA-32 Reporter le `qid` existant d'un nœud genre à la rematérialisation et
      aligner le repli slug sur le backfill (décision 10,
      `GenreRegistry.existingGenreQid`). `tier/3` — **En review** (PR #32).
- [ ] TRA-31 Scénario post-fusion : sur un cache en forme d'après-fusion, aucun
      des trois producteurs ni la matérialisation ne recrée un doublon (six
      scénarios, dont `club`/`dance`). **Porte du `--apply` de TRA-22.** `tier/1`
      Gate post-merge : **bloqué par** TRA-29, TRA-30, TRA-32.

### Partie 5 — Fusion des doublons par QID *(ex-Partie 4)*

C'est le gain concret : le contenu coupé en deux se recolle. Décision 11 pour la
partie front.

- [x] TRA-14 Rapport de détection (lecture seule) des groupes de nœuds genre
      partageant un QID, avec les usages de chaque membre
      (`npm run report:genre-dupes -- cache` : 20 groupes, 40 nœuds). `tier/2`
- [ ] TRA-22 Script de fusion des doublons de genre : élection d'un nœud
      canonique, union des arêtes, réécriture des arêtes entrantes, suppression
      des perdants, table `data/genre-redirects.json`. **Gelée** : implémentation
      entamée dans un worktree, `--apply` interdit avant la Partie 4 complète et
      TRA-31 vert. Contrat d'élection mis à jour le 2026-09-10 (ci-dessous).
      `tier/3` — **Dépend de** TRA-31.
- [ ] TRA-23 Propager les redirections au graphe exporté (`GraphProjection.redirects`)
      et résoudre les deep links (`?node=`) dans le front. Réutilise le loader de
      TRA-27. `tier/3` — **Dépend de** TRA-22.
- [ ] TRA-35 Nœud `genre:trap` : propager Q47781397 aux arêtes dénormalisées et
      à la table MBID — collision du slug `trap` entre trap EDM et trap hip-hop,
      curation. `tier/2`
- [ ] TRA-38 Front : suivre le slug servi quand il diffère du slug demandé
      (chips matérialisées, `/node` redirigé, clic recherche) — décision 11.
      `tier/3` — **Bloqué par** TRA-29, TRA-30.
- [ ] TRA-39 `image-service` et `/links` ignorent la table de redirections de
      genre appliquée par `node-service` : `GET /image/:slug` et `GET /links/:slug`
      doivent la suivre aussi. `tier/3` — **Bloqué par** TRA-22.

TRA-15 (fusion et redirections en un seul ticket) annulé : remplacé par TRA-22
et TRA-23.

**Règle d'élection — tranchée le 2026-09-10 par Raphaël.** Règle inversée par
rapport au contrat initial de TRA-22 : **usages entrants d'abord** — le slug le
plus référencé par les arêtes entrantes gagne —, nom du catalogue en départage,
puis slug le plus court, puis ordre lexicographique. Invariant ajouté aux
critères de sortie : les 34 slugs de `ONBOARDING_GENRES` (`web/index.html:627`)
survivent tous au `--apply`. Pour mémoire, le contrat initial faisait gagner le
nœud dont le nom égale le nom du catalogue ; sur le cache réel, 10 des 20 groupes
contiennent un slug d'onboarding, c'est à chaque fois le membre le plus utilisé,
et l'ancienne règle élisait l'autre dans neuf cas (`electronic-music` 61 contre
`electronic` 179, `intelligent-dance-music` 1 contre `idm` 171, `ambient-music`
4 contre `ambient` 139, `house`, `pop`, `rock`, `experimental`, `soul`, `dub` —
seul `synth-pop` tombait juste). `web/index.html:639` filtre par `byId.has` :
neuf genres d'onboarding auraient disparu en silence. La règle tranchée réécrit
125 références au lieu de 766, et c'est déjà ce que supposaient l'exemple de
TRA-22 (`"genre:electronic-music": "genre:electronic"`) et le critère de TRA-23.

**Note de déploiement du `--apply`.** `deploy/deploy-server.sh:75` exclut
`cache/` du rsync : le cache du serveur évolue par JIT et n'est pas écrasé au
déploiement. Donc, dans l'ordre : (1) migration exécutée sur le cache du dépôt
**et** sur le cache du serveur, serveur arrêté ; (2) `data/genre-redirects.json`
committé ; (3) serveur redémarré — `cacheIndex` et la table de redirections sont
mémoïsés par processus.

Parallélisable : dans la Partie 4, les trois PR en review (TRA-29, TRA-30,
TRA-32) le sont entre elles. Ensuite la chaîne est : {TRA-29, TRA-30, TRA-32}
→ TRA-31 → TRA-22 → {TRA-23, TRA-39}. TRA-38 n'attend que TRA-29 et TRA-30, pas
la fusion ; TRA-35 est une curation sans dépendance déclarée.

## Risques

- **P8052 est communautaire et en retard sur MusicBrainz.** 11 genres MB n'ont pas
  de QID, et tout genre MB nouvellement créé arrivera sans. Garde-fou : décision 5
  — on conserve la chaîne et on marque non résolu, on ne perd jamais un genre.
- **Le backfill réécrit ~1 400 fichiers.** Chaque `NodeCache.write` déclenche
  `emitReverses` puis une réécriture du fichier global `pending-reverses.json`
  (88 Ko). Garde-fou : la migration écrit les fichiers directement au lieu de
  passer par `cache.write`, et une assertion vérifie qu'aucune arête inverse n'a
  bougé entre le dry-run et l'application.
- **Un champ Zod non optionnel casserait toutes les écritures.** Les 1 404 fichiers
  existants n'ont pas de `qid`. Garde-fou : `.optional()`, et un test qui parse un
  nœud legacy sans `qid`.
- **La fusion des doublons casse les profils existants.** Un profil qui stocke
  `genre:electronic-music` pointerait vers un nœud disparu, et `scoreAffinity`
  ignore silencieusement un slug absent. Garde-fou : les redirections de la
  Partie 5, et cette faiblesse disparaît quand le profil passera aux QIDs (autre
  projet). Avec la règle d'élection tranchée le 2026-09-10, les slugs
  d'onboarding — ceux que détient la majorité des profils — survivent tous
  (critère de sortie).
- **Régression mécanique de la fusion (évitée).** Sans prévention, chaque
  producteur re-mint le perdant à la matérialisation suivante, parfois sans
  `qid` donc hors radar. Garde-fou : la Partie 4 entière avant le `--apply`, et
  TRA-31 comme porte — six scénarios qui rejouent les trois producteurs et la
  matérialisation sur un cache en forme d'après-fusion.
- **L'index QID et la table de redirections sont chargés par processus.** Un
  `--apply` de migration pendant que le serveur tourne laisse la mémo et la
  table périmées jusqu'au prochain `write()` d'un nœud genre. Et le cache du
  serveur n'est pas celui du dépôt (`deploy/deploy-server.sh:75` l'exclut du
  rsync). Garde-fou : la note de déploiement de la Partie 5 — migration sur les
  deux caches, serveur arrêté, puis redémarrage.
- **`PipelineDeps.genreRegistry` est optionnel.** Un appelant qui l'omet
  désactive la prévention en silence. Garde-fou : commentaire explicite sur le
  champ, critère de TRA-28 (`grep runPipeline(` : tout appelant qui écrit passe
  le registre), et TRA-31 assemble les services exactement comme `server.ts`.
- **Collision d'index avant fusion.** Le choix « slug le plus court » diffère du
  membre le plus utilisé dans 2 groupes sur 20 (`electroacoustic`,
  `minimal`). Transitoire : n'affecte que les *nouveaux* noms résolus vers ces
  QIDs, et la fusion redirige.
- **Un refresh peut écraser une curation.** Le `qid` de `genre:trap` en a failli
  faire les frais (décision 10). Garde-fou : `existingGenreQid` (TRA-32) et le
  log du désaccord ; TRA-35 propage la curation aux arêtes dénormalisées.
- **Aucune télémétrie de coût aujourd'hui** : `runJit` jette
  `PipelineResult.metrics` et `_metrics` n'est plus écrit que par l'ancien agent.
  Ce projet ne fait aucun appel LLM, donc il n'est pas exposé — mais on ne pourra
  pas mesurer l'effet du QID sur le coût des projets suivants.

### À arbitrer après la Partie 4

Toute rematérialisation reconstruit le nœud à partir du draft LLM et l'écrit en
bloc (`NodeCache.write`, `src/cache.ts:306`) : les arêtes inverses accumulées et
la provenance d'image sont effacées à chaque refresh TTL. Bug pré-existant,
indépendant de ce projet — le `qid` n'en était qu'une victime, traitée à part par
la décision 10. Question ouverte pour Raphaël : faut-il fusionner les champs
dérivés à l'écriture dans `NodeCache.write` — ce qui revient sur le rejet de la
décision 7 (« le cache ne réécrit pas ce qu'on lui confie ») —, et si oui, dans ce
projet ou dans un ticket à part ? Non décidé.

## Critères de sortie

- [x] ≥ 95 % des occurrences de genre du corpus portent un `qid` (cible mesurée
      comme atteignable : 96,7 %). Atteint par TRA-21 : 96,7 % des arêtes,
      256/274 nœuds genre.
- [ ] Zéro groupe de nœuds genre partageant un QID après la Partie 5.
- [ ] **Non-régression après fusion** : sur un cache en forme d'après-fusion,
      matérialiser un artiste dont MusicBrainz renvoie un tag d'un groupe
      fusionné, un genre dont le brouillon Gemini cite un perdant, un genre dont
      le catalogue donne un perdant pour parent, et demander directement un
      perdant à la matérialisation ou à la lecture — **aucun fichier genre
      supplémentaire, zéro groupe au rapport** (TRA-31).
- [ ] Les 34 slugs de `ONBOARDING_GENRES` (`web/index.html:627`) existent tous
      dans `web/data.json` après le `--apply` de TRA-22 — invariant de la règle
      d'élection tranchée le 2026-09-10.
- [ ] Un `qid` committé sur un nœud genre survit à une rematérialisation dont le
      résolveur donnerait un autre QID ; le désaccord est loggé (TRA-32,
      décision 10).
- [ ] Un rapport de couverture reproductible par une commande, qui liste les
      non-résolus par fréquence — c'est la file de curation d'alias.
- [ ] `npm run check` vert, et **aucun changement visible dans l'UI** à l'issue de
      la Partie 4 : l'identité est de la plomberie, elle ne doit rien changer à
      l'écran avant que la reco et le picker s'en servent.
- [ ] Le pipeline tourne de bout en bout sur un genre neuf et écrit un `qid`
      (vérifié par `npm run smoke:pipeline`).
