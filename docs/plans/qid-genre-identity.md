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

## Découpage

### Partie 1 — Résolveur d'identité (aucun comportement modifié)

Pur ajout : une table de données et un module avec ses tests. Rien n'est branché,
donc déployable sans risque.

- [ ] TRA-? Construire la table `MB genre MBID → QID` depuis Wikidata (P8052) et
      la committer dans `data/genre-qid-map.json`, avec le script one-shot qui l'a
      produite et un rapport de couverture reproductible. `tier/2`
- [ ] TRA-? Ajouter `src/genre-identity.ts` : résolution d'un genre vers un QID par
      MBID puis par chaîne normalisée puis par table d'alias curée, avec tests
      unitaires sur les cas mesurés (`IDM`, `R&B`, `Minimalism`, `Prog-Rock`,
      `Ambient music`). `tier/2`

### Partie 2 — Capturer l'identité à la source

Les nouveaux nœuds portent un QID. Rien ne le lit encore : déployable seul.

- [ ] TRA-? Faire remonter le MBID de genre que MusicBrainz renvoie déjà :
      `fetchEntityGenresMb` passe de `Promise<string[]>` à une forme portant
      `{ name, mbid }`, et les trois appelants (`src/pipeline.ts:792/882/949`) sont
      adaptés. Aucun appel réseau supplémentaire. `tier/2`
- [ ] TRA-? Porter `qid` sur les arêtes de genre : `EdgeRef` (`src/types.ts:19`),
      `edgeRefBase` (`src/schemas.ts:10`, champ optionnel, format `Q[1-9]\d*`) et
      `normalizeEdge` (`src/pipeline.ts:1228`). Sans la déclaration Zod, le champ
      est supprimé silencieusement à chaque écriture. `tier/3` — schéma
      **Dépend de** : Partie 1.

### Partie 3 — Backfill du corpus existant

- [ ] TRA-? Migration `scripts/migrations/<date>-backfill-genre-qid.ts` : stampe le
      `qid` sur les arêtes de genre des nœuds en cache et sur les nœuds genre
      eux-mêmes. Aucun appel LLM. Dry-run par défaut, idempotent, rapport de
      couverture avant/après. `tier/3` — `scripts/migrations/**`
      **Dépend de** : Partie 2.

### Partie 4 — Fusion des doublons par QID

C'est le gain concret : le contenu coupé en deux se recolle.

- [ ] TRA-? Rapport de détection (lecture seule) des groupes de nœuds genre
      partageant un QID, avec les usages de chaque membre du groupe. `tier/2`
- [ ] TRA-? Fusion effective : élection d'un nœud canonique, réécriture des arêtes
      entrantes, conservation des slugs perdus comme redirections pour ne pas casser
      les liens partagés (`?node=genre:electronic-music`). `tier/3`
      **Dépend de** : la tâche précédente.

Parallélisable : les deux tâches de la Partie 1 le sont entre elles. Tout le reste
est une chaîne de dépendances.

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
  Partie 4, et cette faiblesse disparaît quand le profil passera aux QIDs (autre
  projet).
- **Aucune télémétrie de coût aujourd'hui** : `runJit` jette
  `PipelineResult.metrics` et `_metrics` n'est plus écrit que par l'ancien agent.
  Ce projet ne fait aucun appel LLM, donc il n'est pas exposé — mais on ne pourra
  pas mesurer l'effet du QID sur le coût des projets suivants.

## Critères de sortie

- [ ] ≥ 95 % des occurrences de genre du corpus portent un `qid` (cible mesurée
      comme atteignable : 96,7 %).
- [ ] Zéro groupe de nœuds genre partageant un QID après la Partie 4.
- [ ] Un rapport de couverture reproductible par une commande, qui liste les
      non-résolus par fréquence — c'est la file de curation d'alias.
- [ ] `npm run check` vert, et **aucun changement visible dans l'UI** à l'issue de
      la Partie 3 : l'identité est de la plomberie, elle ne doit rien changer à
      l'écran avant que la reco et le picker s'en servent.
- [ ] Le pipeline tourne de bout en bout sur un genre neuf et écrit un `qid`
      (vérifié par `npm run smoke:pipeline`).
