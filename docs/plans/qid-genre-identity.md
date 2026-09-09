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

## Découpage

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

Décisions 7, 8, 9. Déployable seule et **sûre avant la fusion** : une arête vers
un nœud existant ne bouge jamais, seuls les nouveaux slugs sont canonicalisés.
Elle doit être **entièrement mergée** avant le `--apply` de TRA-22.

- [ ] TRA-24 Indexer les nœuds genre par QID dans `NodeCache`
      (`findGenreSlugByQid`, mémoïsé, invalidé à l'écriture d'un nœud genre).
      Pur ajout. `tier/2`
- [ ] TRA-25 Harnais de test bout-en-bout de `runPipeline` avec les frontières
      mockées (`src/tools/tavily.js`, `src/tools/local-fetcher.js`,
      `@google/genai`, `src/musicbrainz.js`) — il n'en existe aucun. `tier/1`
- [ ] TRA-26 Stamper le `qid` et les parents du nœud genre via le résolveur au
      lieu du lookup slug-exact `catalog.get(body)` (`src/pipeline.ts:1049-1062`).
      C'est ce qui laisse `genre:electronic` sans qid, donc invisible pour le
      rapport de doublons. `tier/3`
- [ ] TRA-27 Créer `src/genre-registry.ts` : la règle de la décision 7
      (`canonicalSlugFor`, `canonicalizeGenreEdges`, `canonicalizeNodeEdges`) et
      le loader validé de `data/genre-redirects.json` (absent → table vide).
      Pur ajout. `tier/2` — **Dépend de** TRA-24.
- [ ] TRA-28 Brancher le registre dans `runPipeline` (`PipelineDeps.genreRegistry?`,
      appel entre `:610` et `:611`) et l'injecter depuis `server.ts`,
      `materialize-service`, `crawler`, `top-up-dangling`. `tier/3`
      **Dépend de** TRA-27, TRA-25.
- [ ] TRA-29 Garder `handleMaterialize` : servir le nœud genre canonique au lieu
      de re-minter. `tier/3` — **Dépend de** TRA-28.
- [ ] TRA-30 Appliquer les redirections à la lecture dans `node-service.getNode`.
      `tier/3` — **Dépend de** TRA-28.
- [ ] TRA-31 Scénario post-fusion : sur un cache en forme d'après-fusion, aucun
      des trois producteurs ni la matérialisation ne recrée un doublon (six
      scénarios, dont `club`/`dance`). **Porte du `--apply` de TRA-22.** `tier/1`
      **Dépend de** TRA-26, TRA-28, TRA-29, TRA-30.

### Partie 5 — Fusion des doublons par QID *(ex-Partie 4)*

C'est le gain concret : le contenu coupé en deux se recolle.

- [x] TRA-14 Rapport de détection (lecture seule) des groupes de nœuds genre
      partageant un QID, avec les usages de chaque membre
      (`npm run report:genre-dupes -- cache` : 20 groupes, 40 nœuds). `tier/2`
- [ ] TRA-22 Fusion effective : élection d'un nœud canonique, union des arêtes,
      réécriture des arêtes entrantes, suppression des perdants, table
      `data/genre-redirects.json`. **Gelée** : implémentation entamée dans un
      worktree, `--apply` interdit avant la Partie 4 complète et TRA-31 vert.
      `tier/3` — **Dépend de** TRA-24 à TRA-31.
- [ ] TRA-23 Propager les redirections au graphe exporté (`GraphProjection.redirects`)
      et résoudre `?node=` dans le front. Réutilise le loader de TRA-27. `tier/3`
      **Dépend de** TRA-22.

**Règle d'élection — recommandation en attente d'arbitrage.** Le contrat de
TRA-22 fait gagner le nœud dont le nom égale le nom du catalogue. Sur le cache
réel, 10 des 20 groupes contiennent un slug de `ONBOARDING_GENRES`
(`web/index.html:628-634`), et dans les dix c'est le membre le plus utilisé ; la
règle actuelle élit l'autre dans neuf cas (`electronic-music` 61 contre
`electronic` 179, `intelligent-dance-music` 1 contre `idm` 171, `ambient-music`
4 contre `ambient` 139, `house`, `pop`, `rock`, `experimental`, `soul`, `dub` —
seul `synth-pop` tombe juste). `web/index.html:639` filtre par `byId.has` :
neuf genres d'onboarding disparaîtraient en silence, et la redirection `?node=`
ne couvre pas les constantes du code. Recommandation : **usages entrants
d'abord, nom du catalogue en départage**, puis slug le plus court, puis ordre
lexicographique — 125 références réécrites au lieu de 766, profils d'onboarding
intacts, et c'est déjà ce que supposent l'exemple de TRA-22
(`"genre:electronic-music": "genre:electronic"`) et le critère de TRA-23.
C'est une modification du contrat de TRA-22 : postée en commentaire, pas
appliquée.

Parallélisable : les deux tâches de la Partie 1 le sont entre elles ; dans la
Partie 4, TRA-24, TRA-25 et TRA-26 le sont (vague 1), puis TRA-29 et TRA-30
(vague 4). Tout le reste est une chaîne : TRA-27 → TRA-28 → {TRA-29, TRA-30}
→ TRA-31 → TRA-22 → TRA-23.

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
  projet). Avec la règle d'élection recommandée, les slugs d'onboarding — ceux
  que détient la majorité des profils — survivent tous.
- **Régression mécanique de la fusion (évitée).** Sans prévention, chaque
  producteur re-mint le perdant à la matérialisation suivante, parfois sans
  `qid` donc hors radar. Garde-fou : la Partie 4 entière avant le `--apply`, et
  TRA-31 comme porte — six scénarios qui rejouent les trois producteurs et la
  matérialisation sur un cache en forme d'après-fusion.
- **L'index QID et la table de redirections sont chargés par processus.** Un
  `--apply` de migration pendant que le serveur tourne laisse la mémo et la
  table périmées jusqu'au prochain `write()` d'un nœud genre. Garde-fou : le
  `--apply` se fait serveur arrêté ou suivi d'un redémarrage — le déploiement
  régénère `web/data.json` et redémarre de toute façon.
- **`PipelineDeps.genreRegistry` est optionnel.** Un appelant qui l'omet
  désactive la prévention en silence. Garde-fou : commentaire explicite sur le
  champ, critère de TRA-28 (`grep runPipeline(` : tout appelant qui écrit passe
  le registre), et TRA-31 assemble les services exactement comme `server.ts`.
- **Collision d'index avant fusion.** Le choix « slug le plus court » diffère du
  membre le plus utilisé dans 2 groupes sur 20 (`electroacoustic`,
  `minimal`). Transitoire : n'affecte que les *nouveaux* noms résolus vers ces
  QIDs, et la fusion redirige.
- **Aucune télémétrie de coût aujourd'hui** : `runJit` jette
  `PipelineResult.metrics` et `_metrics` n'est plus écrit que par l'ancien agent.
  Ce projet ne fait aucun appel LLM, donc il n'est pas exposé — mais on ne pourra
  pas mesurer l'effet du QID sur le coût des projets suivants.

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
- [ ] Les 34 slugs de `ONBOARDING_GENRES` (`web/index.html:628-634`) existent
      tous dans `web/data.json` après le `--apply` de TRA-22.
- [ ] Un rapport de couverture reproductible par une commande, qui liste les
      non-résolus par fréquence — c'est la file de curation d'alias.
- [ ] `npm run check` vert, et **aucun changement visible dans l'UI** à l'issue de
      la Partie 4 : l'identité est de la plomberie, elle ne doit rien changer à
      l'écran avant que la reco et le picker s'en servent.
- [ ] Le pipeline tourne de bout en bout sur un genre neuf et écrit un `qid`
      (vérifié par `npm run smoke:pipeline`).
