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
table d'alias client `slug demandé → slug servi` (`slugAlias`,
`web/index.html:282`) alimente `byId`, `show()` et les chips. Le double-push du
canonique dans `DATA.nodes` est déjà évité par TRA-29.
Rejeté — ne compter que sur la table de redirections exportée (TRA-23) : elle
couvre `?node=` et les deep links au chargement, pas les slugs obtenus à chaud
(une chip matérialisée, un clic dans la recherche). Les deux mécanismes sont
complémentaires — TRA-23 sème `slugAlias` depuis `DATA.redirects`
(`web/index.html:314`), TRA-38 l'alimente à chaud.

**12. Dans `POST /materialize`, `slug` est une clé d'identité pour la recherche
seulement, jamais une cible d'écriture.** *(2026-09-10, TRA-43, review sécurité)*
En une phrase : le client dit *où chercher*, pas *quoi écrire*.
Sur un nœud existant, le refresh reprend nom, `mbid` et `disambiguator` **du nœud
caché** (`refreshIdentityFrom`, `src/services/materialize-service.ts:58`), jamais
ceux du client. Un mint neuf dérive son slug du nom, comme avant. `qid` est un
indice de stampage et de déduplication par la règle 4 de la décision 7 (un nœud
existe pour ce QID → on le sert), rien de plus. Les appelants internes (crawler,
`top-up-dangling`) qui doivent réellement épingler un slug le font via
`PipelineInput.slug` (`src/pipeline.ts:119`), hors de la surface HTTP.
Motif : le contrat initial de TRA-43 épinglait `body.slug` comme cible de `runJit`.
Sur un nœud périmé (TTL 12 h), `{ slug: "artist:x", name: "n'importe quoi" }`
aurait régénéré `artist:x` avec le contenu d'un autre nom — une réécriture
arbitraire, non authentifiée, de tout nœud du cache. Le trou a été vu en review
sécurité de la PR #37 avant merge.
Rejeté — épingler `body.slug` comme cible d'écriture : c'est précisément la
faille. Rejeté — authentifier `POST /materialize` : hors scope, et ne corrige pas
le fait qu'un slug client n'a aucune raison de gouverner ce qu'on écrit. Suite
dans TRA-45 : un `disambiguator` signifie « nœud distinct » et rend le `qid`
client caduc ; le `disambiguator` doit aussi être reporté au refresh.

**13. Le nœud « Trap (EDM) » est renommé `genre:edm-trap`, avec redirection ;
`genre:trap` reste réservé.** *(2026-09-10, TRA-35, tranché par Raphaël)*
En une phrase : deux concepts se disputaient un slug ; on donne au nôtre un slug
qui dit ce qu'il est, et on laisse le slug ambigu rediriger.
Le tag MusicBrainz `trap` (MBID `9a339aa8-…`) désigne le **trap hip-hop**
(Q2913982) — la jointure P8052 est correcte côté Wikidata —, tandis que notre
nœud `genre:trap` s'appelle « Trap (EDM) » et porte Q47781397 (TRA-33). Le nœud
devient `genre:edm-trap` (slug du catalogue `edm-trap-music`), nom, `qid` et
contenu inchangés, avec `genre:trap → genre:edm-trap` dans
`data/genre-redirects.json`. **La table MBID ne change pas** : elle reflète
Wikidata, et corriger `trap → Q47781397` y serait faux. Si le trap hip-hop arrive
par MusicBrainz, le résolveur le stampe Q2913982, la règle 4 ne trouve aucun nœud
pour ce QID, et il naît sous le slug dérivé du nom du tag — jamais `genre:trap`,
la redirection étant suivie avant le mint. Mécanique : un script de renommage
`scripts/migrations/2026-09-10-rename-genre-node.ts` qui **réutilise les fonctions
pures de la fusion** (réécriture des arêtes entrantes, `pending-reverses`, table
aplatie, même ordre d'écriture sûr que TRA-41) ; il corrige au passage les deux
arêtes dénormalisées encore à Q2913982 (`label:never-say-die`,
`project:every-dog-has-its-day`). `genre:trap` n'est pas dans
`ONBOARDING_GENRES` (vérifié). Exécution **après l'étape serveur de TRA-42**,
pour ne pas empiler deux migrations de cache serveur.
*Mise à jour du 2026-09-11 :* la réutilisation des fonctions de fusion a demandé
une généralisation préalable (`RewriteTarget`, TRA-46) ; le renommage est exécuté
sur le cache du dépôt (TRA-47, résultat en Partie 5) ; côté serveur, il est
intégré à la fenêtre de TRA-42, juste après la fusion — une seule fenêtre, deux
migrations dans l'ordre, plutôt que deux arrêts du serveur. Ajout de review
(TRA-35) : la garde onboarding du script est **stricte** — `genrePickList()`
filtre `ONBOARDING_GENRES` par présence en cache, jamais via `DATA.redirects`,
donc un slug d'onboarding renommé disparaîtrait de l'onboarding au lieu de
suivre la redirection ; le script refuse de renommer un tel slug tant que
`ONBOARDING_GENRES` (`web/index.html`) n'est pas mis à jour.
Rejeté — inverser la priorité `mbid > alias` dans `src/genre-identity.ts` :
affaiblit le résolveur pour tous les genres pour régler un cas. Rejeté — libérer
`genre:trap` pour le trap hip-hop : un profil ou un deep link qui stocke
`genre:trap` changerait de sens en silence ; la redirection garde le sens.

## Découpage

**Statut au 2026-09-11 (matin).** Parties 1 à 3 livrées. **Partie 4 terminée** :
TRA-24 à 30, 32 à 34, 36, 37, 43, 45 mergés ; la gate TRA-31 est verte 6/6 sur
`main` — son scénario 6 a révélé le trou « matérialisation par nom seul », corrigé
par TRA-43 (décision 12). **Partie 5 : tout est mergé** — fusion exécutée sur le
cache du dépôt (TRA-22, 41, 44, 42-repo, 23, 38, 39) et renommage
`genre:trap → genre:edm-trap` exécuté sur le cache du dépôt (TRA-46, 35, 47).
Il reste : (a) la **fenêtre serveur** de TRA-42, à exécuter à la main par
Raphaël, qui enchaîne désormais fusion puis renommage (procédure détaillée au
ticket TRA-42 ci-dessous) ; (b) TRA-40 (nettoyage, trois lots, `tier/1`, au
rythme hebdomadaire).

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

### Partie 4 — Prévention des doublons à l'émission *(ajoutée le 2026-09-09, terminée le 2026-09-10)*

Décisions 7, 8, 9, 10, 12. Déployable seule et **sûre avant la fusion** : une
arête vers un nœud existant ne bouge jamais, seuls les nouveaux slugs sont
canonicalisés. Elle devait être **entièrement mergée** avant le `--apply` de
TRA-22 — c'est fait : la gate TRA-31 est verte 6/6 sur `main`.

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
- [x] TRA-29 Garder `handleMaterialize` : servir le nœud genre canonique au lieu
      de re-minter un doublon. `tier/3` (PR #30)
- [x] TRA-30 Appliquer les redirections de genre à la lecture dans
      `node-service.getNode`. `tier/3` (PR #31)
- [x] TRA-32 Reporter le `qid` existant d'un nœud genre à la rematérialisation et
      aligner le repli slug sur le backfill (décision 10,
      `GenreRegistry.existingGenreQid`). `tier/3` (PR #32)
- [x] TRA-31 Prouver par un scénario post-fusion qu'aucun producteur ne recrée un
      doublon de genre (porte du `--apply` de TRA-22) : six scénarios, dont
      `club`/`dance`. `tier/1` (PR #34) — **verte 6/6 sur `main`** après TRA-43 ;
      le scénario 6 était en `it.fails` jusque-là.
- [x] TRA-43 Matérialiser un genre par l'identité que l'arête porte (slug + qid)
      depuis le front et le crawler, pas par nom re-dérivé. Trouvé par le
      scénario 6 de TRA-31 : `club` et `dance` (même QID via P8052) matérialisés
      par nom seul donnaient deux nœuds, l'un avec le mauvais qid, l'autre sans.
      Décision 12 sur le rôle de `body.slug`. `tier/3` (PR #37, 598 lignes —
      les nits du tour 2 sont dans TRA-45)
- [x] TRA-45 Matérialisation par identité : `disambiguator` ⇒ `qid` client
      ignoré, `disambiguator` reporté au refresh, `precacheAllDangling` envoie
      slug/qid (suite de TRA-43). `tier/3` (PR #43)
- [ ] TRA-40 Nettoyage — nits accumulés des reviews de la Partie 4 (prévention
      des doublons) : trois lots (A : I/O et performance ; B : robustesse et
      lisibilité ; C : tests), ≤ 200 lignes chacun, aucun changement de
      comportement observable. Collecte aussi les nits des PR de la Partie 5
      (#35, #37, #38, #41, #42). `tier/1` — **À faire**, au rythme hebdomadaire.

### Partie 5 — Fusion des doublons par QID *(ex-Partie 4)*

C'est le gain concret : le contenu coupé en deux se recolle. Décision 11 pour la
partie front, décision 13 pour le renommage de `genre:trap`.

- [x] TRA-14 Rapport de détection (lecture seule) des groupes de nœuds genre
      partageant un QID, avec les usages de chaque membre
      (`npm run report:genre-dupes -- cache` : 20 groupes, 40 nœuds). `tier/2`
- [x] TRA-22 Script de fusion des doublons de genre — logique pure : élection
      d'un nœud canonique, union des arêtes, réécriture des arêtes entrantes,
      table `data/genre-redirects.json`. Contrat d'élection mis à jour le
      2026-09-10 (ci-dessous). `tier/3` (PR #35)
- [x] TRA-41 CLI, rapport et application disque de la fusion des doublons de
      genre (suite de TRA-22, sans `--apply` sur le cache réel). Ordre d'écriture
      sûr : invariants → nœuds → `pending-reverses` → redirections → suppression
      des perdants ; après un crash, relancer `--apply` converge. `tier/3` (PR #38)
- [x] TRA-44 Point d'entrée CLI de la fusion des doublons de genre
      (`parseCliArgs`, `main`, script npm `migrate:genre-merge`) — suite de
      TRA-41. Les arguments ambigus sont refusés (exit 2) : `cacheDir` sans
      `nodes/`, positionnel surnuméraire, flag répété. `tier/3` (PR #39)
- [ ] TRA-42 Exécuter la fusion des doublons de genre sur le cache réel (repo
      puis serveur) et committer les redirections. **Étape repo faite** (PR #40,
      résultat ci-dessous) ; **reste la fenêtre serveur**, à faire à la main par
      Raphaël, qui inclut depuis TRA-47 le renommage `genre:trap → genre:edm-trap`
      — une seule fenêtre, deux migrations dans l'ordre : sauvegarde `tar` du
      cache serveur → arrêt → déploiement (`deploy/deploy-server.sh`, qui exclut
      `cache/` et livre le code + `data/genre-redirects.json`) → sur le serveur,
      `npm run migrate:genre-merge -- cache` (dry-run, comparer aux 20 groupes)
      puis `--apply` → `npx tsx scripts/migrations/2026-09-10-rename-genre-node.ts
      cache genre:trap genre:edm-trap` (dry-run) puis `--apply` → redémarrage →
      trois vérifications HTTP : `GET /node/genre:electronic-music` renvoie
      `node.slug === "genre:electronic"` avec `redirected_from` ;
      `GET /node/genre:trap` renvoie `node.slug === "genre:edm-trap"` ;
      `POST /materialize {"type":"genre","name":"Electronic music"}` renvoie le
      canonique en `source: "cache"`. Si la table de redirections produite sur
      le serveur diverge de celle du repo (21 entrées), les fusionner et
      committer le résultat. Le ticket se ferme sur ces trois vérifications,
      consignées dans Linear. `tier/3` — **En cours**.
- [x] TRA-23 Propager les redirections au graphe exporté et résoudre les deep
      links dans le front : `GraphProjection.redirects` (`src/graph.ts:45`,
      depuis `data/genre-redirects.json` via le loader de TRA-27) et `?node=`
      résolu par `DATA.redirects → slugAlias` (`web/index.html:314`). `tier/3`
      (PR #41)
- [x] TRA-38 Front : suivre le slug servi quand il diffère du slug demandé
      (chips matérialisées, `/node` redirigé, clic recherche) — décision 11.
      `tier/3` (PR #36)
- [x] TRA-39 `image-service` et `/links` ignoraient la table de redirections de
      genre appliquée par `node-service` : `GET /image/:slug` et `GET /links/:slug`
      la suivent désormais via `resolveReadSlug` (`src/genre-registry.ts:126`),
      partagé avec `node-service`. `tier/3` (PR #42)
- [x] TRA-46 Généraliser la réécriture d'arêtes de la migration de fusion
      (`RewriteTarget`) pour la réutiliser dans le renommage TRA-35 :
      `rewriteNodeEdges` / `rewritePendingReverses` prennent une cible générique
      au lieu du groupe de fusion. Préparatoire, comportement de fusion inchangé.
      `tier/3` (PR #45)
- [x] TRA-35 Renommer le nœud « Trap (EDM) » en `genre:edm-trap` avec redirection
      `genre:trap → genre:edm-trap` (collision de slug trap hip-hop / EDM) —
      décision 13. Script `scripts/migrations/2026-09-10-rename-genre-node.ts`
      `<cacheDir> <from> <to> [--apply]`, tests sur fixture `mkdtemp`. Ajout de
      review : garde onboarding **stricte** — la liste d'onboarding du front ne
      suit pas les redirections, donc le script refuse de renommer un slug de
      `ONBOARDING_GENRES` tant que la liste n'est pas mise à jour ; `genre:trap`
      n'en fait pas partie. `tier/3` (PR #46)
- [x] TRA-47 Exécuter le renommage `genre:trap → genre:edm-trap` sur le cache du
      repo (PR de données) et l'ajouter à la fenêtre serveur de TRA-42. Résultat
      ci-dessous. `tier/3` (PR #47)

TRA-15 (fusion et redirections en un seul ticket) annulé : remplacé par TRA-22
et TRA-23.

**Règle d'élection — tranchée le 2026-09-10 par Raphaël.** Règle inversée par
rapport au contrat initial de TRA-22 : **usages entrants d'abord** — le slug le
plus référencé par les arêtes entrantes gagne —, nom du catalogue en départage,
puis slug le plus court, puis ordre lexicographique. Invariant ajouté aux
critères de sortie : les 34 slugs de `ONBOARDING_GENRES` (`web/index.html:656`)
survivent tous au `--apply`. Pour mémoire, le contrat initial faisait gagner le
nœud dont le nom égale le nom du catalogue ; sur le cache réel, 10 des 20 groupes
contiennent un slug d'onboarding, c'est à chaque fois le membre le plus utilisé,
et l'ancienne règle élisait l'autre dans neuf cas (`electronic-music` 61 contre
`electronic` 179, `intelligent-dance-music` 1 contre `idm` 171, `ambient-music`
4 contre `ambient` 139, `house`, `pop`, `rock`, `experimental`, `soul`, `dub` —
seul `synth-pop` tombait juste). `web/index.html:668` filtre par `byId.has` :
neuf genres d'onboarding auraient disparu en silence. La règle tranchée réécrit
**167 références** (mesuré à l'`--apply` ; l'estimation du matin disait 125) au
lieu de 766, et c'est déjà ce que supposaient l'exemple de TRA-22
(`"genre:electronic-music": "genre:electronic"`) et le critère de TRA-23.

**Résultat du `--apply` sur le cache du dépôt (2026-09-10, TRA-42, PR #40).**
20 groupes fusionnés, **167 arêtes réécrites** (artist 48, genre 69, label 22,
project 15, track 13), 20 redirections dans `data/genre-redirects.json`
(`generated_at` réel), **34/34 slugs d'onboarding préservés**, 0 groupe résiduel
au rapport, second `--apply` no-op. Export : 1 392 → 1 375 nœuds,
7 509 → 7 387 arêtes, quarantaine 12 → 9. Sur les 20 canoniques élus, **15
diffèrent** de ce qu'aurait donné « nom du catalogue d'abord » — `electronic`,
`idm`, `ambient`, `house`, `pop`, `rock`, `experimental`, `avant-garde`,
`industrial`, `dub`, `folk`, `classical`, `contemporary-classical`, `drone`,
`noise` — tous des slugs courts sauvés par « usages d'abord » ; les cinq autres
(`electroacoustic-music`, `minimal-music`, `microhouse`, `soul`, `synth-pop`)
coïncident.

**Résultat du renommage sur le cache du dépôt (2026-09-11, TRA-47, PR #47).**
1 nœud renommé (`genre:trap` → `genre:edm-trap`, nom « Trap (EDM) », Q47781397,
contenu inchangé), **4 arêtes entrantes réécrites** (`artist:skrillex`,
`label:owsla`, `label:never-say-die`, `project:every-dog-has-its-day`), 2 `qid`
dénormalisés corrigés (Q2913982 → Q47781397 sur `label:never-say-die` et
`project:every-dog-has-its-day`), table `data/genre-redirects.json` à **21
entrées** (20 de la fusion + `genre:trap → genre:edm-trap`), 0 groupe au rapport
de doublons. Export identique à celui de la fusion — 1 375 nœuds, 7 387 arêtes,
quarantaine 9 — au renommage près.

**Note de déploiement du `--apply`.** `deploy/deploy-server.sh:75` exclut
`cache/` du rsync : le cache du serveur évolue par JIT et n'est pas écrasé au
déploiement. Donc, dans l'ordre : (1) migration exécutée sur le cache du dépôt
**et** sur le cache du serveur, serveur arrêté ; (2) `data/genre-redirects.json`
committé ; (3) serveur redémarré — `cacheIndex` et la table de redirections sont
mémoïsés par processus. Au matin du 2026-09-11, (1)-repo et (2) sont faits pour
la fusion **et** pour le renommage (PR #40 et #47) ; (1)-serveur et (3) restent —
c'est la fenêtre serveur de TRA-42 ci-dessus, qui enchaîne les deux migrations.
Jusqu'à son exécution, le serveur sert encore les 40 nœuds d'avant fusion et
`genre:trap` avec le code d'après : sans table de redirections chargée, rien ne
redirige ; le registre (règle 2) garde les slugs existants, donc **aucun doublon
nouveau** n'est créé entre-temps.

Chaîne restante : la fenêtre serveur de TRA-42 (fusion, puis renommage). TRA-40
est indépendant.

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
  (critère de sortie, vérifié 34/34 à l'`--apply`). Le script de renommage
  (TRA-35) porte la même garde, stricte : il refuse de renommer un slug
  d'onboarding.
- **Régression mécanique de la fusion (évitée, vérifiée).** Sans prévention,
  chaque producteur re-mint le perdant à la matérialisation suivante, parfois
  sans `qid` donc hors radar. Garde-fou : la Partie 4 entière avant le `--apply`,
  et TRA-31 comme porte — six scénarios qui rejouent les trois producteurs et la
  matérialisation sur un cache en forme d'après-fusion, verts 6/6 sur `main`. La
  porte a payé : le scénario 6 a trouvé un vrai trou (TRA-43) avant l'`--apply`.
- **L'index QID et la table de redirections sont chargés par processus.** Un
  `--apply` de migration pendant que le serveur tourne laisse la mémo et la
  table périmées jusqu'au prochain `write()` d'un nœud genre. Et le cache du
  serveur n'est pas celui du dépôt (`deploy/deploy-server.sh:75` l'exclut du
  rsync). Garde-fou : la note de déploiement de la Partie 5 — migration sur les
  deux caches, serveur arrêté, puis redémarrage. Fenêtre serveur de TRA-42 en
  attente ; elle enchaîne fusion puis renommage (TRA-47) dans le même arrêt,
  pour ne pas empiler deux migrations serveur.
- **`PipelineDeps.genreRegistry` est optionnel.** Un appelant qui l'omet
  désactive la prévention en silence. Garde-fou : commentaire explicite sur le
  champ, critère de TRA-28 (`grep runPipeline(` : tout appelant qui écrit passe
  le registre), et TRA-31 assemble les services exactement comme `server.ts`.
- **`POST /materialize` est une surface d'écriture non authentifiée.** Tout
  champ client qui gouverne *ce qu'on écrit* — et pas seulement *où l'on
  cherche* — est une réécriture arbitraire potentielle. Garde-fou : décision 12
  (`body.slug` clé de recherche, identité reprise du nœud caché au refresh), et
  TRA-45 pour le reste de la surface (`disambiguator` ⇒ `qid` client ignoré :
  sinon `{ name: "Fake", disambiguator: "xx", qid: "Q170611" }` mint un second
  nœud pour le QID de `techno`, rendu collant par TRA-32). TRA-45 est mergé
  (PR #43).
- **Collision d'index avant fusion (résorbée).** Le choix « slug le plus court »
  différait du membre le plus utilisé dans 2 groupes sur 20 (`electroacoustic`,
  `minimal`). Transitoire : la fusion a redirigé les deux vers
  `electroacoustic-music` et `minimal-music`, conformément à « usages d'abord ».
- **Un refresh peut écraser une curation.** Le `qid` de `genre:trap` en a failli
  faire les frais (décision 10). Garde-fou : `existingGenreQid` (TRA-32) et le
  log du désaccord ; TRA-35 et TRA-47 (décision 13) ont renommé le nœud en
  `genre:edm-trap` et corrigé les deux `qid` dénormalisés sur le cache du dépôt.
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

### Leçon de process

Les PR empilées sur une branche squash-mergée (TRA-41 sur TRA-22, TRA-44 sur
TRA-41) demandent un `rebase --onto` de la base squashée puis un force-push avec
lease — une manœuvre manuelle à chaque merge de la base, et une occasion de
perdre du travail. À éviter : préférer des PR séquentielles (la suivante part de
`main` après le merge de la précédente) quand le découpage le permet, quitte à
attendre une review. La chaîne TRA-46 → TRA-35 → TRA-47 a suivi cette règle :
trois PR séquentielles (#45, #46, #47), chacune partie de `main` après le merge
de la précédente.

## Critères de sortie

- [x] ≥ 95 % des occurrences de genre du corpus portent un `qid` (cible mesurée
      comme atteignable : 96,7 %). Atteint par TRA-21 : 96,7 % des arêtes,
      256/274 nœuds genre.
- [x] Zéro groupe de nœuds genre partageant un QID après la Partie 5. Atteint sur
      le cache du dépôt : 0 groupe résiduel après la fusion (TRA-42, PR #40,
      second `--apply` no-op) et toujours 0 après le renommage (TRA-47, PR #47).
- [x] **Non-régression après fusion** : sur un cache en forme d'après-fusion,
      matérialiser un artiste dont MusicBrainz renvoie un tag d'un groupe
      fusionné, un genre dont le brouillon Gemini cite un perdant, un genre dont
      le catalogue donne un perdant pour parent, et demander directement un
      perdant à la matérialisation ou à la lecture — **aucun fichier genre
      supplémentaire, zéro groupe au rapport** (TRA-31, 6/6 vert sur `main`).
- [x] Les 34 slugs de `ONBOARDING_GENRES` (`web/index.html:656`) existent tous
      dans `web/data.json` après le `--apply` de TRA-22 — invariant de la règle
      d'élection tranchée le 2026-09-10. Vérifié 34/34 (TRA-42) ; le renommage
      ne touche aucun slug d'onboarding (garde stricte de TRA-35).
- [x] Un `qid` committé sur un nœud genre survit à une rematérialisation dont le
      résolveur donnerait un autre QID ; le désaccord est loggé (TRA-32,
      décision 10).
- [ ] **Fusion et renommage déployés sur le cache serveur** (fenêtre serveur de
      TRA-42) : les trois vérifications HTTP passent — `GET /node/genre:electronic-music`
      → `genre:electronic` avec `redirected_from`, `GET /node/genre:trap` →
      `genre:edm-trap`, `POST /materialize {"type":"genre","name":"Electronic
      music"}` → canonique en `source: "cache"` — et sont consignées dans Linear.
- [ ] Un rapport de couverture reproductible par une commande, qui liste les
      non-résolus par fréquence — c'est la file de curation d'alias.
- [x] `npm run check` vert, et **aucun changement visible dans l'UI** à l'issue de
      la Partie 4 : l'identité est de la plomberie, elle ne doit rien changer à
      l'écran avant que la reco et le picker s'en servent. Partie 4 mergée, CI
      verte ; les seules retouches front (TRA-38, TRA-23) suivent un slug servi
      ou un deep link, sans effet à l'écran.
- [ ] Le pipeline tourne de bout en bout sur un genre neuf et écrit un `qid`
      (vérifié par `npm run smoke:pipeline`).
