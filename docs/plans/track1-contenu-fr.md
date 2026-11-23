# Track1 — contenu des nœuds en français

Plan de la phase `plan` du process de livraison, écrit le 2026-11-23 sur le brief de Raphael (23/11) :
« traduire tous les nœuds qu'on est susceptible d'utiliser dans l'app en français […] le contenu en
français ». **En attente de validation** : aucun ticket Linear n'est créé, les identifiants sont des `TRA-?`.

Tous les chemins sont relatifs à la racine du dépôt ; les numéros de ligne et les mesures sont ceux de
`origin/main` au 2026-11-23 (`f37743e0`). Les mesures de volume ont été faites hors ligne sur `cache/nodes/`.
L'état de la prod vient d'une seule lecture publique de `GET https://dropcliffs.com/api/odyssey/mobile/v1/catalog`
(1 803 nœuds) et de `/api/odyssey/version` (SHA `966071b`, déployé le 2026-10-24). Aucun appel Gemini n'a été
fait : l'environnement cloud n'a pas la clé (R2).

## Problème

1. **L'app est en français, le contenu des nœuds est en anglais.** Le texte suit un seul chemin :
   `editorial_article` et le teaser du type (`TEASER_FIELD_BY_TYPE`, `src/node-spec.ts:120-126`) → `toVizNode`
   (`src/graph.ts:199-240`, champs `article` / `teaser` / `facts`) → `GET /mobile/v1/nodes/:id`
   (`src/mobile/nodes.ts:34-53`) → `NodeDetail` (`ios/Track1Core/Sources/Track1Core/API/APIModels.swift:196-231`).
   L'app dessine ensuite : l'article phrase par phrase dans le lecteur (`PlayerView.paragraphs`,
   `ios/Track1/Features/Node/PlayerView.swift:140-143`, via `ArticleSentences.split`), l'article entier et le
   teaser sur la fiche (`NodePageView.swift`, `NodeArticleView.swift`, `NodePageHeader.swift:25-33`), et les
   faits (`NodePageHeader.swift`, `factFields`). Le teaser du **catalogue** (`CatalogNode.teaser`) n'est dessiné
   par aucune vue de `ios/Track1` : il est seulement recopié dans `DailyRecommendation.teaser` et
   `EditorialGenreChoice.definition`.
2. **Volume à traduire** (cache committé, tous les nœuds ont un article) :

   | Type | Nœuds | Article moyen | Articles (car.) | Teasers (car.) |
   | --- | --- | --- | --- | --- |
   | project | 292 | 1 633 car. / 240 mots | 476 830 | 67 838 |
   | track | 239 | 1 578 car. / 232 mots | 377 141 | 38 611 |
   | artist | 578 | 1 443 car. / 215 mots | 833 812 | 151 231 |
   | genre | 316 | 1 570 car. / 227 mots | 496 063 | 61 479 |
   | label | 175 | 1 661 car. / 244 mots | 290 669 | 35 359 |
   | **Total** | **1 600** | 1 547 car. / 228 mots | **2 474 515** | **354 518** |

   Les faits en texte libre pèsent environ 44 000 caractères, presque tous hors des œuvres (`era` 287 genres,
   `origin` 295 genres et 528 artistes, `active_years` 432 artistes, `location` 174 labels). Six projets au
   plus, et aucune track, portent `vocals`, `samples_notes`, `inspirations` ou `bpm`.
   En prod : 361 projets, 311 tracks, 631 artistes, 314 genres, 186 labels ; teasers mesurés 385 908 car. ;
   articles ≈ 2,79 M car. (extrapolés avec les moyennes par type ci-dessus).

   | Périmètre | Nœuds | Source (car.) | Entrée (tokens) | Sortie (tokens) | Coût Flash Lite |
   | --- | --- | --- | --- | --- | --- |
   | Œuvres du dépôt | 531 | 0,96 M | ≈ 0,51 M | ≈ 0,33 M | ≈ 0,14 $ |
   | Œuvres de prod | 672 | 1,21 M | ≈ 0,64 M | ≈ 0,41 M | ≈ 0,17 $ |
   | Tout le dépôt | 1 600 | 2,87 M | ≈ 1,52 M | ≈ 0,98 M | ≈ 0,41 $ |
   | Toute la prod | 1 803 | 3,23 M | ≈ 1,71 M | ≈ 1,11 M | ≈ 0,46 $ |

   Hypothèses : 4 caractères par token en entrée ; sortie = 1,2 × les caractères source, à 3,5 caractères par
   token ; 500 tokens de consigne et de schéma par appel ; un appel par nœud ; tarifs de `pricingConfig`
   (`src/config.ts:72-79` : 0,075 $ et 0,30 $ par million, à vérifier sur la grille en vigueur). Ajouter 10 à
   20 % pour les seconds essais. Avec un modèle huit fois plus cher en sortie, toute la prod reste sous 5 $.
   **Le coût n'est pas la contrainte ; la qualité, le quota de requêtes (≈ 2 000 appels) et l'accès à la clé
   le sont.**
3. **Le dépôt n'a pas tous les nœuds de la prod.** 209 nœuds de prod n'existent pas dans `cache/nodes/` :
   69 projets, 72 tracks, 53 artistes, 11 labels, 4 genres. **`track:idioteque--radiohead`, l'exemple du brief,
   en fait partie.** Traduire le dépôt seul ne corrige donc pas l'exemple. À l'inverse, les nœuds communs sont
   presque identiques : sur 1 594, 8 seulement ont un teaser différent entre prod et dépôt (3 artistes,
   4 genres, 1 label, aucune œuvre). La mesure porte sur le teaser, seul texte que le catalogue expose.
4. **Un champ que le schéma ne déclare pas n'atteint jamais le disque** (`src/schemas.ts:88-105`, Zod supprime
   les clés inconnues). Conséquence propre à ce projet : le code de prod du 24/10 ne connaît pas le champ de
   traduction. S'il réécrit un nœud qui le porte (une arête inverse posée par un nœud voisin suffit), il
   l'efface.
5. **La production ne reçoit plus rien depuis le 24/10.** Même constat et mêmes deux canaux (code :
   `deploy/deploy-server.sh` ; données : `deploy/sync-genre-cache.sh`) que `docs/plans/track1-pochettes.md`
   (branche `claude/plan-pochettes`, Problème §5, R1 et Q1) : ce plan s'y réfère et ne le redit pas. Seul le
   client iOS se livre sans déploiement, par TestFlight. **Aucun texte français n'atteint l'app tant que le
   code puis les données n'ont pas été poussés à la main** (D6, partie 5).
6. **Les routes mobiles refusent tout paramètre inconnu.** `/mobile/v1/nodes/:id` répond 400 dès que l'URL
   porte une query (`src/mobile/router.ts:105-106`), `/mobile/v1/catalog` dès qu'elle porte autre chose que
   `identities` (`src/mobile/http.ts:27-30`). Un `?lang=fr` envoyé à la prod actuelle casserait l'app.
7. **Le découpage en phrases a des défauts que le français rend plus visibles.** Sonde indicative avec l'ICU de
   Node (`Intl.Segmenter`, ICU 78 ; Foundation est à épingler par `swift test`) : une coupure tombe après
   `feat.`, `ft.`, `prod.`, `vs.`, `Dr.`, `St.` ou `Vol.` suivis d'une majuscule (« Dr. » / « Dre et sort en
   1999… »), et la règle des 25 caractères (`ArticleSentences.swift:27-49`) recolle alors le fragment à la
   phrase **précédente** ou ne recolle rien ; un titre qui finit par `?` ou `!` entre guillemets français
   (`« Where Is My Mind ? »`) est coupé avant le `»`.

## Non-buts

- **Rétablir le déploiement** (runners, workflow `deploy`) : hors périmètre, comme dans le plan pochettes.
  Ce plan ne contient que les actions manuelles de mise en production.
- **La page web** (`web/index.html`, `web/data.json`) reste en anglais et ne change pas d'un octet (D2).
- **Les libellés de l'app.** Les libellés de données de la fiche (`SONIC MARKERS`, `Founded`, `article`,
  `sources`, `performers`, `+N more`) sont en anglais par la décision Q1 de `docs/plans/track1-ios-figma.md:304`.
  Ils seront à côté d'un texte français : question Q6, aucun ticket ici.
- **Les noms.** Nom du nœud, noms d'arêtes (artistes, labels, œuvres, genres), familles et genres de la
  taxonomie (`data/genre-taxonomy.json`) : jamais traduits, ce sont des identités.
- **Les citations** (`citations[].title`, `citations[].url`) : titres de pages tierces, laissés tels quels.
- **Le teaser du catalogue** (`MobileCatalogNode.teaser`) : aucune vue iOS ne le dessine (Problème §1). Le
  catalogue ne change pas ; `docs/track1-api.md:83` reste vrai.
- **Une seconde langue**, un réglage de langue dans l'app, la langue de VoiceOver.
- **Le client React Native** (`mobile/`) : non modifié. Son schéma de nœud n'est pas strict
  (`mobile/src/api/contracts.ts:148-161`), il ignore le champ ajouté.
- **Réécrire ou améliorer le texte anglais**, le prompt de rédaction (`SYSTEM_PROMPT`, `src/pipeline.ts:684-760`)
  ou `scripts/audit-cache.ts` (aucune nouvelle métrique d'audit : le lot rapporte lui-même sa couverture).
- **Le doublon** `track:idioteque--radiohead-kid-a-goalmode2-3bbdb5ab` vu dans le catalogue de prod.

## Décisions d'archi

### D1 — Périmètre : les œuvres d'abord, puis le reste ; article, teaser et faits en texte libre

- **Vague 1 : projets et tracks** (672 en prod, dont 531 dans le dépôt). Ce sont les seuls types recommandés
  à l'accueil (`Affinity.isRecommendable`) et les seuls que le lecteur affiche phrase par phrase.
- **Vague 2 : artistes, genres, labels** (1 131 en prod). Ils s'ouvrent en un tap depuis la fiche d'une œuvre.
- **Champs traduits** : `editorial_article`, le teaser du type, et les faits en texte libre que l'app dessine :
  `era`, `origin`, `sonic_markers` (genre) ; `origin`, `active_years` (artiste) ; `location`, `active_years`
  (label) ; `musical_key`, `vocals`, `samples_notes`, `inspirations` (œuvres).
- **Jamais traduits** : voir Non-buts, plus `year`, `founded`, `duration`, `bpm`, `release_type`, `founders`.
- Le même outil traite les deux vagues ; seul l'ordre des passes change (`--types`).

- Rejeté — tout traduire en une passe : 1 803 textes écrits avant que quiconque ait lu un échantillon.
- Rejeté — s'arrêter aux œuvres : la fiche d'une œuvre mène en un tap à des pages en anglais.
- Rejeté — traduire le teaser du catalogue : environ 450 Ko de plus sur un catalogue de 1,65 Mo, pour un
  texte que l'app n'affiche pas.

### D2 — Stockage : un bloc `l10n.fr` dans le nœud, à côté de l'anglais ; `graph.ts` et le web inchangés

Le nœud gagne un champ optionnel `l10n: { fr?: NodeTranslation }`, déclaré une fois dans `baseFields`
(`src/schemas.ts:88`), donc valable pour les cinq types. `NodeTranslation` porte `teaser`, `article`, `facts`
(optionnel) et sa provenance : `source_sha256` (empreinte du texte anglais traduit), `model`, `translated_at`.
C'est la forme groupée des « champs `*_fr` » du brief. L'anglais reste la source ; le français est une couche
dérivée, régénérable, qu'on retire en supprimant le bloc.

Une traduction est **courante** quand son `source_sha256` égale l'empreinte du texte anglais du nœud. Le lot ne
retraduit que ce qui manque ou n'est plus courant ; l'API ne sert qu'une traduction courante (D5).

`toVizNode` (`src/graph.ts:199-240`) est une liste blanche : il ne projette pas le bloc. `web/data.json` et le
graphe live sont donc identiques à aujourd'hui, ce qu'un test épingle. Le lecteur mobile lit le bloc sur le
`NodePayload` qu'il a déjà en main (`src/mobile/nodes.ts:40-45`).

| Option | Web | Schéma | `graph.ts` |
| --- | --- | --- | --- |
| **Bloc `l10n.fr` dans le nœud (retenu)** | inchangé, `data.json` identique | 1 champ optionnel, 3 fichiers, tier/3 | inchangé, épinglé par un test |
| Champs plats `*_fr` | inchangé si non projetés | 6 champs, plus un par fait (≈ 15 déclarations) ; états partiels possibles (teaser français, article anglais) | inchangé |
| Une table par langue (`cache/l10n/fr/…`) | inchangé par construction | schéma de nœud intact, mais un second magasin avec son schéma ; `deploy/sync-genre-cache.sh` ne transporte que `nodes/` et `pending-reverses.json`, il faut l'étendre (tier/3 dans `deploy/`) | inchangé ; deux lectures par fiche |
| Remplacer l'anglais | la page web passe en français sous des libellés anglais (`<html lang="en">`) | intact en apparence ; sans marqueur de langue le lot ne sait pas reprendre, il faut donc quand même un champ | intact |

- Rejeté — champs plats : rien ne garantit qu'article et teaser arrivent ensemble, et la provenance n'a pas
  de place.
- Rejeté — table par langue : chaque migration qui renomme, fusionne ou supprime un slug
  (`2026-10-16-scope-release-slugs`, `2026-10-20-merge-duplicate-labels`,
  `2026-10-24-merge-near-duplicate-releases`, et les suivantes) devrait déplacer un second fichier ; un oubli
  laisse une traduction orpheline. Dans le nœud, la traduction suit le nœud.
- Rejeté — remplacement : irréversible hors historique git, change le web sans qu'il soit demandé, et perd le
  réglage anti-remplissage du prompt de rédaction, écrit pour l'anglais.

### D3 — Moteur : Gemini, par le SDK déjà en place, un appel par nœud, sortie contrainte puis validée

Un module `src/translation/` appelle Gemini (`@google/genai`, déjà importé par `src/pipeline.ts:22` ; aucune
dépendance ajoutée) avec un schéma de réponse contraint `{ teaser, article, facts }`, température 0,2, thinking
désactivé. Le modèle est `GEMINI_TRANSLATION_MODEL`, par défaut celui du pipeline (`gemini-2.5-flash-lite`).

La sortie est une **donnée non fiable**. Elle passe un validateur pur avant toute écriture :

- noms propres : le nom du nœud (sauf genre) et les noms de ses arêtes artiste, label, projet et track présents
  dans l'anglais doivent se retrouver à l'identique (4,6 par article en moyenne) ;
- titres : un passage entre guillemets qui est un nom connu ou qui a la forme d'un titre (8 mots au plus, la
  moitié au moins en capitale initiale) doit se retrouver à l'identique. Mesuré sur 3 994 passages entre
  guillemets : 54 % sont un nom du nœud ou d'une arête, 27 % ont la forme d'un titre, 20 % sont des citations
  ou des termes de scène, que le français traduit ;
- années : tout nombre à quatre chiffres de l'anglais est dans le français (2,0 par article) ;
- structure : même nombre de paragraphes, rapport de longueur borné, pas de balisage ni d'URL ajoutés, pas
  d'échappement `\n` ou `\"` résiduel (les régressions TRA-458 et TRA-577) ;
- langue : le texte est bien du français (part de mots-outils), pas l'anglais renvoyé tel quel.

Un échec donne un second essai à température 0 avec les motifs du refus ; un second échec laisse le nœud sans
français, listé dans le manifeste. **Une traduction invalide n'est jamais écrite.** La qualité éditoriale, que
le validateur ne mesure pas, passe par un pilote de 30 œuvres lu par Raphael avant le lot (tâche 2.5).

- Rejeté — une API de traduction (DeepL, Cloud Translation) : une dépendance et un secret de plus, plusieurs
  dizaines d'euros au tarif public (de l'ordre de 20 € le million de caractères) contre moins de 1 $, et
  aucun moyen d'interdire la traduction des titres sans glossaire par nœud.
- Rejeté — faire traduire par un agent Claude dans une session cloud (pas besoin de clé) : deux moteurs, donc
  deux voix, puisque le serveur n'a que Gemini pour les nouveaux nœuds (D4) ; et des textes qui entrent dans
  `cache/` sans passer par l'outil.
- Rejeté — plusieurs nœuds par appel : un refus du validateur coûterait tout le paquet, et Flash Lite mélange
  les contenus voisins.

### D4 — Nouveaux nœuds : traduits à l'écriture, par la même fonction, dans une étape optionnelle du pipeline

`PipelineDeps` gagne `translate?`, sur le modèle exact de `resolveImage` et `similarArtists`
(`src/pipeline.ts:146-156`) : étape facultative, bornée par un délai, qui ne coûte jamais le nœud. Elle
s'exécute après `attachSimilarArtists` et avant `validateNode` (`src/pipeline.ts:803-809`), quand les noms
d'arêtes sont définitifs. Le serveur, le crawl et les top-ups la branchent. Un échec laisse le nœud en
anglais ; le lot le reprendra.

Cela fait **un second appel Gemini par nœud** (≈ 950 tokens en entrée, 620 en sortie, ≈ 0,0003 $, 2 à 4 s).
La ligne « un seul appel par nœud » de `CLAUDE.md` devient « un seul appel de rédaction, plus un appel de
traduction optionnel » : question Q3.

- Rejeté — un seul appel bilingue (ajouter les champs français au schéma de rédaction) : la rédaction tourne
  à température 0,95 pour varier la prose (`src/config.ts:63`), la traduction veut 0,2 ; un refus du français
  obligerait à rejouer l'appel entier avec son corpus (jusqu'à 80 Ko) ; et le flux aurait une autre voix que
  le lot.
- Rejeté — écrire directement en français : c'est l'option « remplacement » de D2.
- Rejeté — ne rien faire à l'écriture et laisser un lot périodique rattraper : une fiche générée depuis l'app
  s'ouvre sous les yeux de la personne, en anglais.
- Rejeté — traduire à la lecture, par une file côté serveur : écrire un nœud à la lecture est fermé depuis
  TRA-475, et la décision 3b-D3 (`docs/plans/graph-integrity.md:574-590`) l'a déjà refusé pour les images.

### D5 — Contrat mobile : un champ additif `node.l10n.fr`, le client choisit ; repli nœud entier sur l'anglais

`GET /mobile/v1/nodes/:id` ajoute `node.l10n.fr = { teaser, article, facts? }` quand le nœud porte une
traduction courante. `teaser`, `article` et `facts` gardent l'anglais. La provenance n'est pas exposée.
`version` reste `v1` ; le catalogue ne change pas.

Côté iOS, l'app n'affiche **qu'une langue, celle de l'appareil** (précision de Raphael, 23/11). Jamais
l'anglais et le français côte à côte.
- La langue voulue vient des préférences de l'appareil : `Locale.preferredLanguages`. Le français si la
  première langue commence par `fr`, l'anglais sinon. Elle est lue en un seul endroit et injectable pour les
  tests.
- Sur un appareil en français, `NodeDetail` applique le français en un seul endroit, si `l10n.fr` est présent
  et complet : `teaser` et `article` prennent le français, `facts` prend le français clé par clé, et
  `contentLanguage` vaut `.fr`. Sinon, la fiche reste en anglais et `contentLanguage` vaut `.en`.
- Sur un appareil en anglais (ou dans toute autre langue), `l10n.fr` est ignoré : tout reste en anglais.
- Les trois lecteurs (`NodePageHeader`, `PlayerView.paragraphs`, `NodeArticleView`) ne sont pas modifiés.
- Le repli est **par nœud entier** : jamais un teaser français sur un article anglais.

L'interface de l'app reste en français (décision Q4 de la v1). La faire suivre la langue de l'appareil est
hors de ce plan.

`ArticleSentences` garde la segmentation de Foundation et gagne deux règles, utiles aussi à l'anglais : une
phrase qui finit par une abréviation d'une liste fermée (`feat.`, `ft.`, `vs.`, `prod.`, `vol.`, `Dr.`, `St.`,
`No.`) est recollée à la **suivante** ; une phrase qui commence par un signe fermant (`»`, `”`, `)`, `,`, `;`,
`:`) est recollée à la précédente. Les initiales ne sont pas dans la liste : « Kid A. » finit une phrase.

- Rejeté — un paramètre `?lang=fr` : la prod actuelle répond 400 (Problème §6) ; la build serait inutilisable
  jusqu'au déploiement.
- Rejeté — négocier par `Accept-Language` : il faut `Vary`, un ETag par langue et valider un en-tête de plus,
  pour économiser 2 Ko par fiche ; et le client ne sait plus dans quelle langue est le texte reçu.
- Rejeté — le serveur sert le français d'office dans `article` : toutes les builds basculent le jour du
  déploiement, y compris celle dont le découpage en phrases n'a pas été vérifié en français ; et le retour
  arrière exige un déploiement, sur un canal à l'arrêt. Avec le champ additif, une build n'affiche le français
  que si elle a été faite pour.
- Rejeté — choisir la langue dans chaque vue : trois endroits à tenir d'accord.

### D6 — Livraison : tout se merge sans déploiement ; en prod, le code d'abord, les données ensuite

- **Livrable sans déploiement** : toutes les PR de code (parties 1 à 4), le lot joué sur le dépôt (parties 2
  et 6), et une build TestFlight qui sait lire `l10n.fr` et découpe mieux les phrases (4.2, 4.3). Cette build
  reste en anglais tant que la prod ne sert pas le champ.
- **Qui lance le lot** : il faut la clé Gemini. Soit Raphael, en local (`GEMINI_API_KEY` dans son shell), soit
  un agent une fois la clé enregistrée comme secret réseau de l'environnement cloud pour
  `generativelanguage.googleapis.com` (en-tête `x-goog-api-key`) : question Q2. L'aperçu (`--apply` absent) ne
  fait aucun appel réseau : un agent peut toujours le lancer.
- **Les 209 nœuds absents du dépôt** arrivent par le chemin existant : `bash deploy/pull-cache.sh --apply`
  (lecture seule sur le serveur, TRA-493), puis une passe du lot. Sans ce pull, « Idioteque » reste en anglais.
- **Comment le cache traduit atteint la prod** : par `bash deploy/sync-genre-cache.sh --apply`, sans nouvelle
  migration. Le canal transfère tout `nodes/` de l'union (`deploy/sync-genre-cache.sh:911`) ; quand un slug
  existe des deux côtés avec le même `materialized_at`, le dépôt gagne
  (`decideSameIdentity`, `scripts/prepare-genre-cache-union.ts:219-243`). Le lot ne touche donc **jamais**
  `materialized_at`.
- **Ordre en prod : `deploy/deploy-server.sh` avant le canal de données.** C'est l'inverse de la décision D6
  du plan pochettes, et c'est voulu : `image_url` était connu du code du 24/10, `l10n` ne l'est pas
  (Problème §4). Les deux plans se concilient si le lot d'images passe avant que le lot d'ici (2.6) soit
  mergé, ou si le code est déployé avant tout passage du canal. Sinon, rien de grave : le français effacé par
  l'ancien code est reposé au passage suivant (R3).

- Rejeté — traduire dans le canal, sur l'union (`--migration`) : l'aperçu et l'application sont deux
  exécutions, donc deux passes payantes et deux textes différents, sauf à câbler un rejeu dans un script bash
  de 989 lignes ; et la prod recevrait des textes que personne n'a relus dans une PR.
- Rejeté — jouer le lot sur le serveur : la prod divergerait du dépôt, qui est la base de connaissance.
- Rejeté — embarquer le français dans l'app pour contourner le gel (un JSON de ≈ 3,5 Mo dans le binaire) :
  seconde source de vérité, périmée à chaque nœud créé, à retirer ensuite. À rouvrir seulement si le gel dure
  (Q7).

## Découpage

`[P]` = parallélisable dans sa vague ; 1 pt ≈ 1,5 h ; chaque tâche < 300 lignes de diff écrit (200 pour un
tier/3), tests compris. Les fichiers de `cache/nodes/` sont comptés « générés » par `scripts/ci/pr-policy.ts`
et n'entrent pas dans ce total. Le tier est le tier pressenti.

### Partie 1 — Le socle : un nœud sait porter une traduction, et on sait la juger

Déployable seule : champ optionnel et fonctions pures. Aucun nœud ne porte encore de français.

- [ ] TRA-802 1.1 [P] Déclarer le bloc `l10n.fr` dans le schéma de nœud — tier/3, 2 pts
- [ ] TRA-803 1.2 [P] Refuser une traduction mal formée — tier/2, 2 pts
- [ ] TRA-804 1.3 Refuser une traduction infidèle : noms, titres, années — tier/2, 2 pts (après 1.2)
- [ ] TRA-805 1.4 Extraire la source d'une traduction, son empreinte et la typographie française — tier/2, 2 pts (après 1.1 et 1.2 ; parallèle à 1.3)

### Partie 2 — Le moteur et le lot : les œuvres du dépôt sont traduites

Déployable seule : le dépôt gagne du français validé ; l'anglais n'est pas touché. Atteint la prod par 5.3.

- [ ] TRA-806 2.1 Traduire un nœud, fournisseur injecté — tier/2, 2 pts (après 1.3 et 1.4)
- [ ] TRA-807 2.2 Brancher Gemini comme fournisseur de traduction — tier/2, 2 pts (après 2.1)
- [ ] TRA-808 2.3 Créer l'outil de lot : aperçu, écriture gardée, reprise — tier/2, 3 pts (après 2.2)
- [ ] TRA-811 2.4 Donner au lot son débit, son arrêt sur quota et son échantillon — tier/2, 2 pts (après 2.3)
- [ ] TRA-812 2.5 Jouer le pilote sur 30 œuvres et faire valider la qualité — tier/3, 1 pt (après 2.4 ; exige la clé, Q2)
- [ ] TRA-813 2.6 Traduire les projets et les tracks du dépôt — tier/2, 1 pt (après validation de 2.5)

### Partie 3 — Les nouveaux nœuds naissent avec leur français

Déployable seule : étape facultative, inerte sans clé, qui ne coûte jamais un nœud. Sans effet en prod avant
le déploiement du code.

- [ ] TRA-809 3.1 Brancher la traduction à l'écriture dans le pipeline — tier/2, 3 pts (après 2.2 ; parallèle à 2.3)

### Partie 4 — L'API mobile sert le français, l'app le lit

Déployable seule : champ additif côté serveur ; côté iOS, comportement inchangé tant que le serveur ne
l'envoie pas.

- [ ] TRA-810 4.1 Servir `l10n.fr` sur `/mobile/v1/nodes/:id` — tier/3, 2 pts (après 1.4 ; parallèle à 2.1)
- [ ] TRA-814 4.2 [P] Lire `l10n.fr` côté iOS et afficher le français — tier/2, 2 pts (ne dépend pas de 4.1, le contrat est fixé ici)
- [ ] TRA-815 4.3 [P] Fiabiliser le découpage en phrases pour le français — tier/2, 2 pts

### Partie 5 — Mise en production (actions de Raphael, bloquées par Q1)

- [ ] TRA-816 5.1 [P] Ramener dans le dépôt les nœuds créés en prod — tier/2, 1 pt (dès que possible ; ne dépend de rien)
- [ ] TRA-817 5.2 Traduire les œuvres ramenées de la prod — tier/2, 1 pt (après 5.1 et 2.5)
- [ ] TRA-818 5.3 Déployer le code, puis passer le cache traduit sur la prod — tier/3, 1 pt (après 1.1, 4.1 et 2.6 ; de préférence après 3.1 et 5.2)

### Partie 6 — Le reste du catalogue

Déployable seule : mêmes outils, autres types. Atteint la prod par un nouveau passage de 5.3.

- [ ] TRA-819 6.1 Traduire les artistes, les genres et les labels — tier/2, 2 pts (après 2.6)

### Ordre d'attaque

1. Vague A, en parallèle (aucun fichier commun) : 1.1, 1.2, 4.2, 4.3. Raphael peut lancer 5.1 le même jour.
2. Vague B, en parallèle : 1.3, 1.4.
3. Vague C, en parallèle : 2.1, 4.1.
4. Vague D : 2.2.
5. Vague E, en parallèle : 2.3, 3.1. Puis 2.4.
6. Vague F : 2.5, puis lecture de Raphael, puis 2.6, 5.2 et 6.1.
7. Vague G, Raphael : 5.3, puis une build TestFlight (`ios-testflight`) si 4.2 et 4.3 n'en ont pas déjà une.

Total : 18 tâches, 33 pts. Voisinage avec le plan pochettes : ses tâches 3.1 et 3.2 touchent aussi
`src/mobile/contracts.ts`, `docs/track1-api.md` et `APIModels.swift`, à d'autres endroits (`MobileCatalogNode`,
`CatalogNode`) ; la seconde PR mergée se rebase, sans conflit de fond.

## Risques

- **R1 — Le déploiement reste gelé.** Tout le français reste dans le dépôt ; l'app ne change pas. Garde-fou :
  rien de ce plan ne dégrade l'existant en attendant (champ additif, build iOS inerte) ; les scripts `deploy/`
  se lancent à la main. Question Q1, la même que celle du plan pochettes.
- **R2 — Le lot a besoin de la clé Gemini et de `generativelanguage.googleapis.com`, que l'environnement cloud
  n'a pas.** Garde-fou : 2.5, 2.6, 5.2 et 6.1 portent le prérequis en tête de ticket ; l'aperçu tourne sans
  réseau. Question Q2.
- **R3 — Le code de prod du 24/10 efface `l10n` quand il réécrit un nœud.** Garde-fou : ordre de D6 (code
  avant données) ; le canal repose le français au passage suivant, puisque le dépôt gagne à horodatage égal.
- **R4 — Une traduction fausse est pire que l'anglais** : titre traduit, nom déformé, fait ajouté, calque.
  Garde-fou : validateur de D3 (refus = pas d'écriture) ; pilote lu par Raphael (2.5) ; échantillon de 20
  textes dans chaque PR de lot ; l'anglais reste intact et le bloc se retire sans perte ; `--force --slugs`
  retraduit un nœud précis.
- **R5 — Le pull de la prod (5.1) peut être refusé** par sa propre validation
  (`scripts/ci/pull-cache-validate.ts`, plafonds de `data/integrity-thresholds.json`). Les 141 œuvres propres à
  la prod, dont « Idioteque », restent alors en anglais. Garde-fou : le pull est lancé tôt, son aperçu dit ce
  qui bloque ; l'outil de lot accepte n'importe quel dossier de cache, ce qui laisse une porte, non planifiée.
- **R6 — Des nœuds restent en anglais** : ceux créés en prod après le pull et avant le déploiement de 3.1, les
  8 nœuds dont le texte diffère entre prod et dépôt, les refus du validateur. Garde-fou : repli par nœud
  entier, sans erreur ; le lot est idempotent et se rejoue à chaque cycle pull → lot → canal.
- **R7 — La traduction à l'écriture ralentit une génération demandée depuis l'app** (2 à 4 s sur une dizaine).
  Garde-fou : étape bornée à 30 s, sur le modèle de l'image ; un échec ne coûte jamais le nœud.
- **R8 — Quota Gemini.** ≈ 2 000 requêtes pour toute la prod ; une clé en offre gratuite a un plafond
  journalier. Garde-fou : débit réglable (`--rpm`), arrêt propre sur refus de quota, reprise là où le lot
  s'est arrêté.
- **R9 — Le lot modifie autre chose que `l10n`.** Un `materialized_at` changé ferait gagner le dépôt sur un
  nœud que la prod a rafraîchi depuis. Garde-fou : l'outil relit chaque nœud écrit et refuse toute différence
  hors du bloc (critère de 2.3).
- **R10 — Le français arrive avec un jour de retard sur un appareil** : la fiche est servie avec
  `Cache-Control: private, max-age=86400` (`src/mobile/router.ts:130`). Accepté.
- **R11 — Le dépôt grossit** d'environ 3,5 Mo de texte, et chaque PR de lot touche des centaines de fichiers
  générés. Accepté ; les PR de lot ne contiennent que `cache/nodes/`.
- **R12 — Après le lot et avant le canal, `deploy/pull-cache.sh` classe les nœuds traduits en `changed`.**
  C'est du bruit dans son aperçu, jamais une copie (un pull n'écrase pas un nœud du dépôt). Garde-fou : lancer
  5.1 avant de merger 2.6 quand c'est possible.

## Critères de sortie

- Sur `main` : `npm run check` et `npm run audit:cache` sont verts ; l'aperçu
  `npx tsx scripts/translate-nodes.ts cache --types project,track` annonce 0 nœud manquant hors refus listés ;
  un second passage avec `--apply` n'écrit rien ; `npm run build:graph` produit un `web/data.json` sans aucune
  clé `l10n`.
- En prod : `https://dropcliffs.com/api/odyssey/version` rend le SHA de `main` qui contient 1.1 et 4.1 ;
  `GET /mobile/v1/nodes/track:idioteque--radiohead` rend un `node.l10n.fr.article` non vide et un
  `node.article` anglais inchangé ; sur 20 œuvres tirées du catalogue, 19 au moins rendent `l10n.fr`.
- Dans l'app (build contenant 4.2 et 4.3) : « Idioteque » s'affiche en français dans le lecteur et sur la
  fiche ; un nœud sans traduction s'affiche en anglais, sans erreur ; aucune phrase du lecteur ne commence par
  `»` ni ne finit sur `feat.`.
- Un nœud créé depuis l'app après 5.3 porte `l10n.fr` dès sa première lecture (3.1 déployé).
- Après 6.1 et un nouveau passage du canal : même contrôle sur 20 artistes, genres et labels.

## Questions pour Raphael (gate)

- **Q1 — Déploiement.** Même question que Q1 du plan pochettes, avec trois commandes à lancer depuis un poste
  avec `ssh-agent`, dans cet ordre : `bash deploy/pull-cache.sh --apply` (dès maintenant), puis
  `bash deploy/deploy-server.sh` (code), puis `bash deploy/sync-genre-cache.sh --apply` (données). Peux-tu les
  lancer, et quand ? Sans elles, les tâches 5.1 à 5.3 attendent et l'app reste en anglais.
- **Q2 — Qui joue le lot ?** Toi en local avec ta clé, ou un agent après que tu as enregistré la clé comme
  secret de l'environnement cloud pour `generativelanguage.googleapis.com` ? Ta clé est-elle sur une offre
  facturée (≈ 2 000 requêtes) ?
- **Q3 — Un second appel Gemini par nœud.** D4 ajoute un appel de traduction à l'écriture, ce qui amende la
  ligne « un seul appel par nœud » de `CLAUDE.md`. D'accord ? Sinon les nouveaux nœuds restent en anglais
  jusqu'au lot suivant.
- **Q4 — Modèle.** Flash Lite par défaut, jugé sur le pilote de 30 œuvres que tu lis (2.5). S'il ne suffit pas,
  on change `GEMINI_TRANSLATION_MODEL` sans toucher au code ; le coût reste sous 5 $. D'accord ?
- **Q5 — Ton et citations.** Français éditorial neutre, sans tutoiement ; titres et noms laissés dans leur
  langue ; guillemets français ; les citations de critiques sont traduites. D'accord ?
- **Q6 — Libellés de la fiche.** `SONIC MARKERS`, `Founded`, `article`, `sources`, `+N more` restent en anglais
  (décision Q1 de `track1-ios-figma`) au-dessus d'un texte français. Veux-tu un ticket pour les passer en
  français ? Il n'est pas planifié ici.
- **Q7 — Si le gel dure.** Veux-tu un palliatif qui embarque le français des œuvres dans l'app (TestFlight),
  sur le modèle de TRA-794 pour les pochettes ? Rejeté par défaut (D6).
- **Q8 — Web.** La page web reste en anglais et `web/data.json` ne change pas. D'accord ?

## Tickets proposés (format `ticket-template.md`, à créer après validation)

### TRA-802 (1.1) — Déclarer le bloc `l10n.fr` dans le schéma de nœud

```markdown
## Contexte
Les textes des nœuds n'existent qu'en anglais et l'app iOS est en français. Ce ticket donne au nœud la place
où ranger une traduction française, à côté de l'anglais. Aucun comportement utilisateur ne change : aucun nœud
ne porte encore de traduction. Plan : docs/plans/track1-contenu-fr.md#partie-1 (décision D2).

## Portée
Fichiers à modifier :
- `src/node-spec.ts` — ajouter `CONTENT_LOCALES`, `ContentLocale`, `TRANSLATABLE_FACT_FIELDS`
- `src/types.ts` — ajouter `NodeTranslation`, `NodeL10n`, et `l10n?` sur `BaseNode` ; ré-exporter les deux
  constantes de `node-spec.ts` comme les autres (lignes 3-13)
- `src/schemas.ts` — ajouter `l10n` à `baseFields` (ligne 88)
- `test/schemas.test.ts` — nouveaux cas
- `test/graph.test.ts` — un cas `toVizNode`
Hors-scope explicite :
- `src/graph.ts` : vérifié, NON modifié. `VizNode` ne gagne aucun champ.
- `NODE_SPEC_JSON` (`src/node-spec.ts:205-214`) : inchangé, le web n'a pas besoin de ces constantes.
- `ios/Track1Core/Sources/Track1Core/Features/Node/NodePageSpec.swift` et son test de parité.
- Tout fichier de `cache/`, `scripts/migrations/`, `scripts/audit-cache.ts`.

## Contrat
    // src/node-spec.ts
    export const CONTENT_LOCALES = ["fr"] as const;
    export type ContentLocale = (typeof CONTENT_LOCALES)[number];
    /** Text facts a translation may carry. A subset of OPTIONAL_TEXT_FIELDS. */
    export const TRANSLATABLE_FACT_FIELDS: Record<NodeType, readonly string[]> = {
      genre: ["era", "origin", "sonic_markers"],
      label: ["location", "active_years"],
      artist: ["origin", "active_years"],
      project: ["musical_key", "vocals", "samples_notes", "inspirations"],
      track: ["musical_key", "vocals", "samples_notes", "inspirations"],
    };

    // src/types.ts
    export interface NodeTranslation {
      teaser: string;                    // translation of the type's teaser field
      article: string;                   // translation of editorial_article
      facts?: Record<string, string>;    // keys: a subset of TRANSLATABLE_FACT_FIELDS[type]
      source_sha256: string;             // 64 lowercase hex chars
      model: string;
      translated_at: string;             // ISO 8601 datetime
    }
    export type NodeL10n = Partial<Record<ContentLocale, NodeTranslation>>;
    // BaseNode: l10n?: NodeL10n;

    // src/schemas.ts
    export const nodeTranslationSchema: z.ZodType<NodeTranslation>;   // used by baseFields.l10n.fr

Règles Zod : `teaser` min 1 ; `article` min 80 (le plancher de `editorial_article`) ; `facts` : record de
chaînes non vides, optionnel ; `source_sha256` : `/^[a-f0-9]{64}$/` ; `model` min 1 ; `translated_at` :
datetime ; `l10n` et `l10n.fr` optionnels. Les mêmes règles valent en lecture et en écriture
(`buildSchemas` est commun ; `nodeTranslationSchema` ne dépend pas du slug, il est déclaré hors de
`buildSchemas` et exporté).

## Critères d'acceptation
- [ ] Un nœud de chacun des cinq types portant un `l10n.fr` valide passe `nodePayloadSchema` et ressort avec
      le bloc identique.
- [ ] Un nœud sans `l10n` passe comme avant et ressort sans clé `l10n`.
- [ ] `l10n.fr` est refusé si `article` fait moins de 80 caractères, si `teaser` est vide, si `source_sha256`
      n'est pas 64 caractères hexadécimaux minuscules, ou si `translated_at` n'est pas une date ISO.
- [ ] Une clé de langue non déclarée (`l10n.es`) est supprimée à la validation, sans erreur.
- [ ] `toVizNode` d'un nœud portant `l10n.fr` rend un objet sans clé `l10n`, dont `article` et `teaser` sont
      l'anglais.
- [ ] Chaque champ de `TRANSLATABLE_FACT_FIELDS[type]` appartient à `OPTIONAL_TEXT_FIELDS[type]`.
- [ ] `npm run check` est vert, `test/ios-node-page-spec.test.ts` compris.

## Tests attendus
- unitaire : les six critères ci-dessus, dans `test/schemas.test.ts` et `test/graph.test.ts`.
- intégration : aucun.

## Tier de risque
tier/3 — changement du schéma de nœud.

## Notes d'implémentation
- `exactOptionalPropertyTypes` est actif : une clé absente est omise, jamais mise à `undefined`.
- Zod supprime les clés non déclarées : c'est ce qui rend ce ticket obligatoire avant toute écriture.
- La restriction des clés de `facts` par type n'est PAS dans le schéma (`baseFields` ne connaît pas le type).
  Elle est tenue par le validateur (1.2) et par la projection mobile (4.1). Ne pas la rediscuter ici.
- Diff écrit à tenir sous 200 lignes, tests compris.
```

### TRA-803 (1.2) — Refuser une traduction mal formée

```markdown
## Contexte
La sortie d'un modèle de traduction est une donnée non fiable : elle peut être vide, tronquée, balisée, ou
rendre l'anglais tel quel. Ce ticket écrit le juge, une fonction pure qui refuse une traduction avant qu'elle
soit écrite, avec ses règles de forme. Les règles de fidélité (noms, titres, années) sont le ticket 1.3.
Aucun comportement utilisateur ne change. Plan : docs/plans/track1-contenu-fr.md#partie-1 (décision D3).

## Portée
Fichiers à créer :
- `src/translation/validate.ts` — types `TranslationSource`, `TranslationCandidate`, `TranslationIssue` et
  la fonction `validateTranslation`
- `test/translation/validate.test.ts`
Hors-scope explicite :
- Tout appel réseau ou modèle. Toute lecture de `cache/`.
- `src/schemas.ts`, `src/types.ts`, `src/node-spec.ts` (ticket 1.1, mené en parallèle : ne rien en importer
  d'autre que le type `NodeType`, qui existe déjà).
- Les règles `missing_proper_noun`, `missing_title`, `missing_year` (ticket 1.3) : leurs codes sont déclarés
  ici, leurs règles non.
- La normalisation typographique (ticket 1.4).

## Contrat
    import type { NodeType } from "../node-spec.js";

    export interface TranslationSource {
      type: NodeType;
      name: string;
      teaser: string;
      article: string;
      facts: Record<string, string>;        // translatable facts only, non-blank
      properNouns: readonly string[];       // names that must survive verbatim
    }
    export interface TranslationCandidate {
      teaser: string;
      article: string;
      facts?: Record<string, string>;
    }
    export type TranslationIssueCode =
      | "empty" | "too_short" | "length_ratio" | "paragraph_count" | "missing_proper_noun"
      | "missing_title" | "missing_year" | "not_french" | "markup" | "escape_leftover"
      | "url_added" | "fact_keys";
    export interface TranslationIssue {
      code: TranslationIssueCode;
      field: string;                         // "teaser", "article" or "facts.<name>"
      detail?: string;                       // a short excerpt, never the whole text
    }
    /** Empty array = accepted. Pure and deterministic. */
    export function validateTranslation(
      source: TranslationSource, candidate: TranslationCandidate): TranslationIssue[];

Règles de ce ticket, appliquées champ par champ (`teaser` contre `teaser`, `article` contre `article`) :
1. `empty` : `teaser` ou `article` vide une fois rogné. `too_short` : `article` < 80 caractères.
2. `length_ratio` : longueur candidate / longueur source hors de [0,7 ; 1,7] pour `article`, de [0,6 ; 2,0]
   pour `teaser` ; pour un fait, longueur candidate > 3 × la source + 20.
3. `paragraph_count` : nombre de paragraphes de `article` (séparateur : ligne vide) différent de la source ;
   ou saut de ligne dans `teaser`.
4. `not_french` : pour `article`, et pour `teaser` s'il a 12 mots ou plus, en ignorant les passages entre
   guillemets (`"…"`, `“…”`, `«…»`) : part de mots-outils français (`le la les des du de un une et est dans
   en que qui pour avec sur par au aux`) < 10 %, ou part de mots-outils anglais (`the and of with is was by
   from which`) > 8 %.
5. `markup` : présence de trois accents graves consécutifs ou d'un `#` en tête de ligne ; ou de `**` / `__`
   quand le champ source n'en contient pas.
6. `escape_leftover` : présence des deux caractères `\n` littéraux, ou de `\"` littéral.
7. `url_added` : une URL `http://` ou `https://` absente du champ source.
8. `fact_keys` : les clés de `candidate.facts` ne sont pas exactement celles de `source.facts`, ou une valeur
   est vide. Un `candidate.facts` absent vaut `{}`.

## Critères d'acceptation
- [ ] Une traduction française bien formée d'un article de deux paragraphes rend `[]`.
- [ ] Chacune des huit règles a un cas qui la déclenche seule, avec le `code` et le `field` attendus.
- [ ] Le texte anglais renvoyé tel quel déclenche `not_french`.
- [ ] Un candidat français qui cite trois titres anglais entre guillemets ne déclenche pas `not_french`.
- [ ] Un teaser de 8 mots n'est pas soumis à `not_french`.
- [ ] Une source sans fait et un candidat sans `facts` ne déclenchent pas `fact_keys` ; un fait en trop ou
      manquant le déclenche.
- [ ] `detail` ne dépasse jamais 120 caractères.
- [ ] `npm run check` est vert.

## Tests attendus
- unitaire : cas nominal, un cas par règle, les cas limites ci-dessus.
- intégration : aucun.

## Tier de risque
tier/2 — logique métier locale, pure, sans effet de bord.

## Notes d'implémentation
- Les seuils sont décidés : ne pas les ajuster sans mesure sur le pilote (ticket 2.5).
- L'union `TranslationIssueCode` porte déjà les trois codes du ticket 1.3, pour que ce dernier n'ait pas à
  changer un type exporté.
- Commentaires et noms en anglais ; pas d'export default.
```

### TRA-804 (1.3) — Refuser une traduction infidèle : noms, titres, années

```markdown
## Contexte
Une traduction bien formée peut encore trahir le texte : « Around the World » devenu « Autour du monde », un
nom d'artiste déformé, une année perdue. Ce ticket ajoute au validateur les trois règles de fidélité, celles
que le brief nomme (noms propres, titres). Aucun comportement utilisateur ne change.
Plan : docs/plans/track1-contenu-fr.md#partie-1 (décision D3).

## Portée
Fichiers à modifier :
- `src/translation/validate.ts` — trois règles de plus dans `validateTranslation`
- `test/translation/validate.test.ts` — nouveaux cas
Hors-scope explicite :
- Les types exportés et les huit règles du ticket 1.2 : inchangés.
- Tout appel réseau ou modèle.

## Contrat
`validateTranslation` garde sa signature. Trois règles s'ajoutent, champ par champ :
1. `missing_proper_noun` : un élément de `source.properNouns` présent dans le champ source et absent du champ
   candidat. « Présent » veut dire : sous-chaîne exacte, sensible à la casse, qui n'est ni précédée ni suivie
   d'une lettre ou d'un chiffre. `detail` porte le nom.
2. `missing_title` : un passage entre guillemets du champ source (`"…"`, `“…”`, ou `'…'` commençant par une
   capitale ou un chiffre) qui est un titre, et dont l'intérieur n'apparaît pas à l'identique dans le champ
   candidat. Est un titre : un intérieur égal à un élément de `properNouns` (sans tenir compte de la casse),
   ou fait de 8 mots au plus dont la moitié au moins commencent par une capitale ou un chiffre. Une
   ponctuation finale à l'intérieur des guillemets (`.`, `,`, `;`, `:`, `!`, `?`) est ignorée. Les
   guillemets du candidat sont libres (`"…"` ou `«…»`). `detail` porte le titre.
3. `missing_year` : un nombre de quatre chiffres entre 1000 et 2099 du champ source, absent du champ
   candidat. Les occurrences comptent : deux fois `1994` dans la source en exigent deux. `detail` porte
   l'année.

## Critères d'acceptation
- [ ] Une traduction fidèle, avec ses noms, ses titres et ses années, rend toujours `[]`.
- [ ] `Warp Records` présent dans l'article source et absent du candidat déclenche `missing_proper_noun` sur
      `article` ; le même nom absent de la source ne déclenche rien.
- [ ] Le nom `Air` n'est pas tenu pour présent dans une source qui ne contient que `Airplay`.
- [ ] `"Around the World"` rendu « Autour du monde » déclenche `missing_title` ; rendu
      `« Around the World »` ne déclenche rien.
- [ ] Une citation de critique (`"playful, occasionally inspired time capsule"`) traduite ne déclenche rien.
- [ ] `"minipops 67 [120.2]"`, présent dans `properNouns`, doit se retrouver à l'identique.
- [ ] `2001's Drukqs` rendu « Drukqs, sorti en 2001 » ne déclenche rien ; l'année retirée déclenche
      `missing_year`.
- [ ] `the early 2010s` rendu « le début des années 2010 » ne déclenche rien.
- [ ] Les cas du ticket 1.2 passent sans modification.
- [ ] `npm run check` est vert.

## Tests attendus
- unitaire : un cas positif et un cas négatif par règle, plus les cas limites ci-dessus.
- intégration : aucun.

## Tier de risque
tier/2 — logique métier locale, pure, sans effet de bord.

## Notes d'implémentation
- Mesure faite au planning sur les 1 600 articles du dépôt : 3 994 passages entre guillemets, dont 54 % sont
  un nom du nœud ou d'une arête, 27 % ont la forme d'un titre, 20 % sont des citations ou des termes de
  scène. La règle 2 vise les 81 % ; les citations restent libres d'être traduites.
- Les genres ne sont pas dans `properNouns` (ticket 1.4) : « ambient music » peut devenir
  « musique ambient ».
- Un titre déjà présent dans `properNouns` peut déclencher les règles 1 et 2 à la fois : c'est accepté, les
  deux motifs servent au second essai du traducteur.
```

### TRA-805 (1.4) — Extraire la source d'une traduction, son empreinte et la typographie française

```markdown
## Contexte
Pour traduire un nœud et savoir plus tard si sa traduction est encore à jour, il faut une seule définition de
« ce qui est traduit » et de son empreinte. Ce ticket l'écrit, avec la remise en forme typographique du texte
français. Aucun comportement utilisateur ne change.
Plan : docs/plans/track1-contenu-fr.md#partie-1 (décisions D2 et D3).

## Portée
Fichiers à créer :
- `src/translation/source.ts` — `translationSourceOf`, `translationSourceHash`, `currentTranslation`
- `src/translation/typography.ts` — `normalizeFrenchText`
- `test/translation/source.test.ts`, `test/translation/typography.test.ts`
Hors-scope explicite :
- `src/translation/validate.ts` (tickets 1.2 et 1.3) : importer ses types, ne pas le modifier.
- `src/editorial-text.ts` : réutilisé, non modifié.
- Tout appel réseau, toute écriture de nœud.

## Contrat
    import type { ContentLocale } from "../node-spec.js";
    import type { NodePayload, NodeTranslation } from "../types.js";
    import type { TranslationSource } from "./validate.js";

    /** What gets translated for this node, and the names that must survive. */
    export function translationSourceOf(node: NodePayload): TranslationSource;
    /** sha256 hex of JSON.stringify([teaser, article, [[field, value], ...]]), UTF-8. */
    export function translationSourceHash(
      source: Pick<TranslationSource, "teaser" | "article" | "facts">): string;
    /** The node's translation for `locale` when its source_sha256 matches the node's text today. */
    export function currentTranslation(
      node: NodePayload, locale: ContentLocale): NodeTranslation | undefined;

    /** normalizeEditorialText, then French spacing. Idempotent. */
    export function normalizeFrenchText(text: string): string;

- `teaser` : la valeur du champ `TEASER_FIELD_BY_TYPE[node.type]`. `article` : `editorial_article`.
- `facts` : les champs de `TRANSLATABLE_FACT_FIELDS[node.type]` dont la valeur est une chaîne non vide une
  fois rognée, dans l'ordre de déclaration.
- `properNouns` : le nom du nœud, sauf si le nœud est un genre ; plus le nom de chaque arête de type
  `artist`, `label`, `project` ou `track` (listes et arêtes simples, d'après `LIST_EDGES_BY_TYPE` et
  `SINGULAR_EDGES_BY_TYPE`). Dédoublonnés, ceux de moins de 3 caractères écartés.
- Dans l'empreinte, `facts` est sérialisé en tableau de paires `[champ, valeur]` dans l'ordre ci-dessus.
- `normalizeFrenchText` : applique `normalizeEditorialText` ; met une espace insécable U+00A0 après `«` et
  avant `»` (en remplaçant une espace ordinaire, ou en l'ajoutant) ; remplace par U+00A0 une espace ordinaire
  qui précède `;`, `:`, `!` ou `?`. N'ajoute jamais d'espace devant ces quatre signes s'il n'y en avait pas.
  Ne change aucun autre caractère, et aucun guillemet.

## Critères d'acceptation
- [ ] `translationSourceOf` d'une track rend son `editorial_teaser`, son article, ses faits traduisibles non
      vides, et dans `properNouns` son nom, ses artistes, son projet et son label, sans ses genres.
- [ ] Pour un nœud genre, `properNouns` ne contient pas le nom du nœud.
- [ ] `year`, `duration`, `bpm`, `founded`, `founders`, `release_type`, `cover_url`, `photo_url` ne sont
      jamais dans `facts`.
- [ ] L'empreinte fait 64 caractères hexadécimaux ; elle change si l'article, le teaser ou un fait
      traduisible change d'un caractère ; elle ne change pas si une arête, `image_url`, `materialized_at` ou
      `l10n` change.
- [ ] `currentTranslation` rend le bloc quand `source_sha256` égale l'empreinte du nœud, `undefined` quand le
      nœud n'a pas de bloc ou que l'article anglais a changé depuis.
- [ ] `normalizeFrenchText("« Idioteque » sort en 2000 : un tournant ?")` rend le même texte avec U+00A0
      après `«`, avant `»`, avant `:` et avant `?`.
- [ ] `normalizeFrenchText` ne touche pas `https://example.com`, `12:30` ni `12" vinyl`.
- [ ] `normalizeFrenchText(normalizeFrenchText(x)) === normalizeFrenchText(x)` sur les cas du test.
- [ ] `npm run check` est vert.

## Tests attendus
- unitaire : un cas par critère ; un nœud de chaque type pour `translationSourceOf`.
- intégration : aucun.

## Tier de risque
tier/2 — fonctions pures, sans effet de bord.

## Notes d'implémentation
- L'empreinte ne couvre que le texte, pas les noms : le canal de données fusionne des arêtes sur un nœud sans
  changer son texte, et la traduction doit rester courante.
- Ne pas convertir les guillemets droits en guillemets français : `12"` est un format de disque.
- `node:crypto` suffit ; aucune dépendance.
```

### TRA-806 (2.1) — Traduire un nœud, fournisseur injecté

```markdown
## Contexte
Ce ticket écrit la fonction qui traduit un nœud en français : elle prépare la demande, juge la réponse avec
le validateur et fait un second essai. Le fournisseur (Gemini) lui est injecté ; son branchement est le
ticket 2.2. La fonction servira au lot (2.3) et à l'écriture des nouveaux nœuds (3.1). Aucun comportement
utilisateur ne change. Plan : docs/plans/track1-contenu-fr.md#partie-2 (décision D3).

## Portée
Fichiers à créer :
- `src/translation/translate-node.ts` — types du fournisseur, `createNodeTranslator`, le prompt
- `test/translation/translate-node.test.ts`
Fichier à modifier :
- `src/config.ts` — ajouter `translationConfig`
Hors-scope explicite :
- Tout import de `@google/genai` (ticket 2.2). `src/pipeline.ts` (ticket 3.1). `scripts/` (ticket 2.3).
- Toute écriture de nœud. Le prompt de rédaction (`SYSTEM_PROMPT`).

## Contrat
    export interface GenerateJsonRequest {
      model: string; systemInstruction: string; prompt: string;
      responseSchema: unknown; temperature: number;
    }
    export type GenerateJsonResult =
      | { ok: true; text: string; inputTokens: number; outputTokens: number }
      | { ok: false; reason: "quota_exhausted" | "provider_unavailable" };
    /** The provider boundary: the only thing tests replace. Never throws for a provider error. */
    export type GenerateJson = (request: GenerateJsonRequest) => Promise<GenerateJsonResult>;

    export interface TranslationUsage { inputTokens: number; outputTokens: number; costUsd: number }
    export type TranslationFailure = "provider_unavailable" | "quota_exhausted" | "invalid_output";
    export type TranslateOutcome =
      | { ok: true; translation: NodeTranslation; attempts: 1 | 2; usage: TranslationUsage }
      | { ok: false; reason: TranslationFailure; issues: TranslationIssue[]; attempts: number;
          usage: TranslationUsage };

    export interface NodeTranslatorDeps { generate: GenerateJson; model?: string; now?: () => Date }
    export type NodeTranslator = (node: NodePayload, locale: ContentLocale) => Promise<TranslateOutcome>;
    export function createNodeTranslator(deps: NodeTranslatorDeps): NodeTranslator;

    // src/config.ts
    export const translationConfig = {
      model: envString("GEMINI_TRANSLATION_MODEL", pipelineConfig.defaultModel),
      temperature: 0.2,
      timeoutMs: 20_000,       // one provider call
      stepTimeoutMs: 30_000,   // the whole translation step of the pipeline
    };

Déroulé d'un appel :
1. `translationSourceOf(node)` ; schéma de réponse : objet `{ teaser, article, facts }`, `teaser` et `article`
   requis, `facts` objet dont les propriétés sont exactement les clés de `source.facts`, toutes requises
   (propriété `facts` omise du schéma quand la source n'a aucun fait).
2. Essai 1 à `translationConfig.temperature`. Chaque texte reçu passe `normalizeFrenchText`, puis l'ensemble
   passe `validateTranslation`. Une réponse qui n'est pas un objet JSON de cette forme est un essai refusé.
3. S'il y a des refus : essai 2 à température 0, le prompt complété par la liste des `code` et `detail`.
4. Accepté : `{ ok: true }` avec `source_sha256 = translationSourceHash(source)`, `model`, `translated_at`.
   Refusé deux fois : `{ ok: false, reason: "invalid_output", issues }` (ceux du second essai).
5. Le fournisseur rend `{ ok: false }` : la fonction rend aussitôt `{ ok: false, reason }` avec la même
   raison, `issues: []`. Elle ne réessaie pas : c'est l'affaire du fournisseur (ticket 2.2).
6. `usage` additionne tous les essais ; `costUsd` se calcule avec `pricingConfig`, comme `buildMetrics`
   (`src/pipeline.ts:1859-1865`).

Le prompt système (en anglais, constante du module) porte ces règles et rien d'autre : traduire en français
éditorial neutre, sans s'adresser au lecteur ; ne rien ajouter, ne rien retirer ; garder à l'identique les
noms de personnes, de groupes, de labels, les titres d'albums et de morceaux, et les noms de genres ; traduire
les citations de critiques ; garder les années et les nombres ; garder les paragraphes ; guillemets français
pour ce que la source met entre guillemets ; aucun balisage ; un seul objet JSON. Le prompt utilisateur donne
le type, le nom, la liste `properNouns` sous l'intitulé « keep verbatim », puis les textes.

## Critères d'acceptation
- [ ] Avec un `generate` factice qui rend une traduction valide : `{ ok: true, attempts: 1 }`, et le bloc
      rendu passe le schéma `l10n.fr` de 1.1.
- [ ] La requête envoyée porte le modèle de `translationConfig`, la température 0,2 et un schéma dont les
      clés de `facts` sont celles de la source ; pour une source sans fait, le schéma n'a pas de `facts`.
- [ ] Le prompt utilisateur contient chaque élément de `properNouns`.
- [ ] Un premier rendu refusé puis un second valide : `{ ok: true, attempts: 2 }` ; le second appel est à
      température 0 et son prompt contient les codes de refus.
- [ ] Deux rendus refusés : `{ ok: false, reason: "invalid_output" }` avec les `issues` du second.
- [ ] Un rendu qui n'est pas du JSON compte comme un essai refusé.
- [ ] `generate` qui rend `{ ok: false, reason: "quota_exhausted" }` : la fonction rend la même raison après
      un seul appel.
- [ ] Le texte accepté a ses espaces insécables (passage par `normalizeFrenchText`).
- [ ] `usage` additionne les tokens des deux essais.
- [ ] `npm run check` est vert.

## Tests attendus
- unitaire : les cas ci-dessus, avec un `generate` factice (frontière externe). Le validateur, la source et
  la typographie sont les vrais (on ne mocke pas ce qu'on possède).
- intégration : aucune.

## Tier de risque
tier/2 — nouveau module sans effet de bord.

## Notes d'implémentation
- Gemini double-échappe parfois `\n` et `\"` (TRA-458, TRA-577) : `normalizeFrenchText` les corrige avant le
  validateur, qui refuse ce qui resterait.
- Résultats typés, pas d'exception aux frontières ; on ne lance que sur invariant cassé.
- Le prompt est une constante courte, sans exemple long : le diff doit tenir sous 300 lignes.
```

### TRA-807 (2.2) — Brancher Gemini comme fournisseur de traduction

```markdown
## Contexte
Le traducteur du ticket 2.1 reçoit son fournisseur par injection. Ce ticket écrit le vrai : un appel Gemini à
sortie JSON contrainte, qui rend un résultat typé au lieu de lancer. C'est le seul fichier du module de
traduction qui touche le SDK. Aucun comportement utilisateur ne change.
Plan : docs/plans/track1-contenu-fr.md#partie-2 (décision D3).

## Portée
Fichiers à créer :
- `src/translation/gemini-generate.ts` — `createGeminiGenerateJson`
- `test/translation/gemini-generate.test.ts`
Hors-scope explicite :
- `package.json` : `@google/genai` est déjà importé par `src/pipeline.ts:22` ; ne rien ajouter ni déplacer.
- `src/pipeline.ts` et `generateNodeDraft` : non modifiés, pas de factorisation avec l'appel de rédaction.
- `src/translation/translate-node.ts` : importer ses types, ne pas le modifier.

## Contrat
    import type { GenerateJson } from "./translate-node.js";

    /** Built on @google/genai: responseMimeType application/json, thinking disabled. */
    export function createGeminiGenerateJson(apiKey: string): GenerateJson;

- Une clé vide est un invariant cassé : `createGeminiGenerateJson("")` lance.
- Appel : `model`, `systemInstruction`, `responseSchema` et `temperature` viennent de la requête ;
  `responseMimeType: "application/json"` ; `thinkingConfig: { thinkingBudget: 0 }`.
- Succès : `{ ok: true, text, inputTokens, outputTokens }`, lus sur `resp.text` et `usageMetadata`
  (`promptTokenCount`, `candidatesTokenCount`, 0 si absents). Un texte absent vaut `""`.
- Erreur dont le message contient `429` ou `RESOURCE_EXHAUSTED` : un nouvel essai après
  `pipelineConfig.retryDelayMs`, puis `{ ok: false, reason: "quota_exhausted" }`.
- Toute autre erreur (dont `503`, `UNAVAILABLE`, réseau) : un nouvel essai après le même délai, puis
  `{ ok: false, reason: "provider_unavailable" }`.
- Un appel qui dépasse `translationConfig.timeoutMs` est traité comme `provider_unavailable`.
- La fonction ne lance jamais pour une erreur du fournisseur et ne journalise jamais le texte envoyé.

## Critères d'acceptation
- [ ] Un appel réussi transmet au SDK le modèle, l'instruction système, le schéma et la température de la
      requête, avec `responseMimeType: "application/json"` et le thinking désactivé.
- [ ] Les tokens rendus sont ceux de `usageMetadata` ; sans `usageMetadata`, ils valent 0.
- [ ] Le SDK lance `RESOURCE_EXHAUSTED` deux fois : `{ ok: false, reason: "quota_exhausted" }`, deux appels
      au SDK, aucune exception.
- [ ] Le SDK lance `503` une fois puis répond : `{ ok: true }`, deux appels au SDK.
- [ ] Le SDK lance une erreur réseau deux fois : `{ ok: false, reason: "provider_unavailable" }`.
- [ ] `createGeminiGenerateJson("")` lance.
- [ ] `npm run check` est vert ; aucun test n'appelle le réseau.

## Tests attendus
- unitaire : `vi.mock("@google/genai")`, sur le modèle de `test/helpers/pipeline-mocks.ts:93` ; délai de
  nouvel essai ramené à 0 par la variable `GEMINI_RETRY_DELAY_MS` ou des minuteurs simulés.
- intégration : pas de test `*.live.test.ts` dans ce ticket ; le pilote (2.5) est le premier appel réel.

## Tier de risque
tier/2 — adaptateur d'une frontière externe, sans effet de bord irréversible.

## Notes d'implémentation
- Reprendre de `generateNodeDraft` (`src/pipeline.ts:1227-1273`) la forme de l'appel et la lecture de
  `usageMetadata`, sans rien y modifier.
- Le SDK envoie la clé dans un en-tête : dans l'environnement cloud, un secret réseau injecté par le proxy
  suffit, et la clé locale peut être factice.
```

### TRA-808 (2.3) — Créer l'outil de lot : aperçu, écriture gardée, reprise

```markdown
## Contexte
Il faut traduire les nœuds déjà en cache : 1 600 dans le dépôt. Ce ticket écrit l'outil qui parcourt un cache,
traduit ce qui manque et écrit le bloc `l10n.fr` dans chaque nœud, sans rien toucher d'autre. Il traite les
nœuds un par un ; le débit, l'arrêt sur quota et l'échantillon sont le ticket 2.4. Il ne lance pas le lot
(tickets 2.5, 2.6, 5.2, 6.1). Plan : docs/plans/track1-contenu-fr.md#partie-2 (décisions D3 et D6).

## Portée
Fichiers à créer :
- `scripts/translate-nodes.ts` — fonction exportée `runTranslation` et point d'entrée CLI
- `test/translate-nodes.test.ts`
Fichier à modifier :
- `package.json` — ajouter le script `"translate:nodes": "tsx scripts/translate-nodes.ts"` (aucune dépendance)
Hors-scope explicite :
- `scripts/migrations/`, `deploy/`, `.github/`, `scripts/audit-cache.ts`, `data/integrity-thresholds.json`.
- Tout fichier de `cache/` : ce ticket n'en modifie aucun.
- `src/cache.ts` : ne pas passer par `NodeCache.write` (voir Notes).
- `--concurrency`, `--rpm`, `--sample`, `stopped` (ticket 2.4).

## Contrat
    tsx scripts/translate-nodes.ts <cache-dir> [--locale fr] [--types project,track]
        [--slugs <slug>,<slug>] [--limit <n>] [--force] [--apply] [--manifest <path>]

    export interface TranslationRunOptions {
      cacheDir: string; locale: ContentLocale; types?: readonly NodeType[]; slugs?: readonly Slug[];
      limit?: number; force: boolean; apply: boolean;
    }
    export interface TranslationRunManifest {
      tool: "translate-nodes"; locale: ContentLocale; model: string; generated_at: string;
      applied: boolean;
      counts: Record<NodeType, { total: number; current: number; missing: number; stale: number }>;
      translated: Slug[];
      failed: { slug: Slug; reason: TranslationFailure; issues: TranslationIssue[] }[];
      usage: TranslationUsage;
    }
    export function runTranslation(
      options: TranslationRunOptions, translate: NodeTranslator): Promise<TranslationRunManifest>;

- Défauts : `--locale fr`, tous les types, `--manifest out/translate-nodes-fr.json`.
- Les nœuds sont traités dans l'ordre des slugs, un à la fois.
- Sans `--apply` : aucun appel au traducteur, aucun fichier de nœud écrit ; `counts` est calculé, le manifeste
  est écrit et un résumé par type est imprimé.
- Un nœud est traité s'il n'a pas de traduction courante (`currentTranslation`), ou si `--force`.
  `missing` : pas de bloc. `stale` : un bloc dont l'empreinte ne correspond plus.
- Écriture d'un nœud : le nœud tel que lu, plus `l10n.fr` (les autres langues du bloc sont conservées) ; la
  copie doit passer `nodePayloadSchema` sans perdre un champ ; écriture par `atomicWriteJson`. Après
  écriture, le fichier relu privé de `l10n` doit être égal, champ pour champ, au nœud lu avant ; sinon
  l'outil s'arrête avec une erreur.
- Tout résultat `{ ok: false }` du traducteur : le nœud n'est pas écrit, il va dans `failed`, le lot continue.
- Codes de sortie : 0 terminé sans `failed` ; 1 terminé avec des `failed` ; 2 erreur d'usage.
- Le point d'entrée CLI construit le traducteur avec `createGeminiGenerateJson(pipelineConfig.geminiApiKey)` ;
  avec `--apply` et sans clé, sortie 2 avant toute lecture. L'aperçu n'a pas besoin de clé.

## Critères d'acceptation
- [ ] Sur un cache de test de 4 nœuds dont 1 déjà traduit, l'aperçu annonce `missing: 3`, n'appelle pas le
      traducteur et ne modifie aucun fichier.
- [ ] Avec `--apply` et un traducteur factice : 3 nœuds gagnent `l10n.fr` ; `materialized_at`, les arêtes et
      tous les autres champs sont identiques ; l'ordre des clés existantes ne change pas.
- [ ] Un second passage avec `--apply` n'appelle pas le traducteur et n'écrit rien (`translated: []`).
- [ ] Un nœud dont l'article anglais a changé depuis sa traduction est compté `stale` et retraduit.
- [ ] `--types project,track` ignore les autres types ; `--slugs` ne traite que les slugs donnés ; `--limit 2`
      s'arrête après 2 nœuds traités.
- [ ] `--force --slugs <slug>` retraduit un nœud dont la traduction est courante.
- [ ] Un `invalid_output` laisse le fichier du nœud inchangé à l'octet, le liste dans `failed`, et le code
      de sortie est 1.
- [ ] Une traduction qui ferait perdre un champ au nœud à la validation est refusée avant écriture.
- [ ] `--apply` sans clé Gemini sort avec le code 2 sans lire le cache ; l'aperçu sans clé fonctionne.
- [ ] `npm run check` est vert.

## Tests attendus
- unitaire : `runTranslation` sur un cache temporaire (`mkdtemp`), avec un traducteur factice.
- intégration : aucun appel réel à Gemini.

## Tier de risque
tier/2 — outil hors `scripts/migrations/`, aperçu par défaut, écritures validées et réversibles par git.

## Notes d'implémentation
- Lire les nœuds avec `readCacheNodes` et `looksLikeCacheDir`
  (`scripts/migrations/2026-09-04-merge-genre-duplicates.ts:362`), et reprendre le garde
  `onlyAddsSchemaDefaults` (`scripts/migrations/2026-10-15-backfill-artist-identity.ts:301`), comme
  `scripts/migrations/2026-10-24-unescape-quotes.ts`.
- Ne PAS passer par `NodeCache.write` : il émet des arêtes inverses et réécrit d'autres nœuds. Ce lot n'écrit
  que le nœud traduit.
- Ne jamais toucher `materialized_at` : le canal de données départage dépôt et prod sur ce champ
  (`scripts/prepare-genre-cache-union.ts:219-243`).
- Ce n'est pas une migration du canal : pas de `--data-dir`, pas de contrat `renamed` / `removed`.
- `out/` est ignoré par git : le manifeste n'entre pas dans une PR.
```

### TRA-811 (2.4) — Donner au lot son débit, son arrêt sur quota et son échantillon

```markdown
## Contexte
L'outil du ticket 2.3 traduit les nœuds un par un et ne sait ni tenir un débit, ni s'arrêter proprement quand
le quota Gemini est atteint, ni produire de quoi relire. Ce ticket ajoute ces trois choses, nécessaires avant
de lancer ≈ 2 000 appels et de soumettre un échantillon à Raphael.
Plan : docs/plans/track1-contenu-fr.md#partie-2 (risques R4 et R8).

## Portée
Fichiers à modifier :
- `scripts/translate-nodes.ts`
- `test/translate-nodes.test.ts` — nouveaux cas, aucun cas retiré
Hors-scope explicite :
- Les règles d'écriture et de sélection du ticket 2.3 : inchangées.
- `src/translation/` : non modifié.
- Tout fichier de `cache/`.

## Contrat
Options ajoutées :

    [--concurrency <n>] [--rpm <n>] [--sample <path>] [--sample-size <n>]

    // added to TranslationRunOptions
    concurrency: number; rpm: number; sampleSize: number; samplePath?: string;
    now?: () => number; sleep?: (ms: number) => Promise<void>;   // injected clock, tests only
    // added to TranslationRunManifest
    stopped?: "quota_exhausted" | "provider_unavailable";

- Défauts : `--concurrency 4`, `--rpm 120`, `--sample-size 30`. `--concurrency` de 1 à 16, `--rpm` de 1 à
  2000 ; hors bornes, sortie 2.
- Jamais plus de `concurrency` appels au traducteur en cours, ni plus de `rpm` appels démarrés sur une minute
  glissante.
- Arrêt : trois résultats de suite dont la raison est `quota_exhausted` ou `provider_unavailable` arrêtent le
  lot. Aucun nouvel appel n'est démarré ; les appels en cours finissent et leurs résultats valides sont
  écrits ; `stopped` porte la dernière raison ; ces trois nœuds ne vont pas dans `failed`. Relancer la même
  commande reprend, puisque le lot ignore les traductions courantes.
- Un `invalid_output` ne compte pas dans la série et la remet à zéro.
- `--sample <path>` : fichier Markdown de `sampleSize` nœuds traduits dans ce passage, tirés de façon
  déterministe (ordre des slugs, pas régulier), avec pour chacun le slug, puis le teaser et l'article anglais,
  puis le teaser, l'article et les faits français. Moins de nœuds traduits que `sampleSize` : tous y sont.
- Codes de sortie : ceux du ticket 2.3, plus 3 quand `stopped` est renseigné.

## Critères d'acceptation
- [ ] Avec `--concurrency 2` et un traducteur factice lent, jamais plus de 2 appels ne sont en cours.
- [ ] Avec `--rpm 3` et une horloge injectée, le quatrième appel ne démarre qu'après 60 secondes simulées.
- [ ] Trois `quota_exhausted` de suite : `stopped: "quota_exhausted"`, code de sortie 3, aucun appel démarré
      ensuite, et les nœuds traduits avant restent écrits.
- [ ] Deux `provider_unavailable`, un succès, puis deux `provider_unavailable` : le lot ne s'arrête pas.
- [ ] Après un arrêt, relancer la commande avec un traducteur qui répond termine le lot sans retraduire les
      nœuds déjà écrits.
- [ ] `--sample` produit un fichier contenant, pour chaque nœud tiré, les deux versions ; deux passages sur
      les mêmes nœuds tirent les mêmes.
- [ ] `--concurrency 0` et `--rpm 5000` sortent avec le code 2.
- [ ] Les cas du ticket 2.3 passent sans modification.
- [ ] `npm run check` est vert.

## Tests attendus
- unitaire : horloge et attente injectées, traducteur factice ; aucun `setTimeout` réel de plus de 50 ms.
- intégration : aucun appel réel à Gemini.

## Tier de risque
tier/2 — outil hors `scripts/migrations/`, logique locale couverte par des tests.

## Notes d'implémentation
- L'ordre des écritures peut différer de l'ordre des slugs ; `translated` est trié avant d'être écrit dans le
  manifeste, pour qu'il soit déterministe.
- L'échantillon va dans `out/`, ignoré par git : il est collé dans le corps de la PR du lot, pas committé.
- Pas de dépendance pour la limitation de débit : une file et une horloge suffisent.
```

### TRA-812 (2.5) — Jouer le pilote sur 30 œuvres et faire valider la qualité

```markdown
## Contexte
Avant de traduire 531 œuvres, il faut qu'un humain ait lu ce que le modèle produit : le validateur garantit
les noms, les titres et les années, pas la qualité du français. Ce ticket traduit 30 œuvres du dépôt et
soumet l'échantillon à Raphael. Sa décision porte aussi sur le modèle (Q4 du plan).
Plan : docs/plans/track1-contenu-fr.md#partie-2 (décision D3, risque R4).

**Prérequis** : `GEMINI_API_KEY` et l'accès à `generativelanguage.googleapis.com`. L'environnement cloud des
agents n'a ni l'un ni l'autre tant que Raphael ne les a pas ouverts (Q2 du plan). Sans eux, ne pas commencer.

## Portée
Fichiers modifiés :
- `cache/nodes/project/*.json`, `cache/nodes/track/*.json` — 30 fichiers, par l'outil uniquement
Hors-scope explicite :
- Toute modification de code, de seuil du validateur ou du prompt : si le pilote en révèle le besoin, le
  dire dans la PR et s'arrêter ; c'est un nouveau ticket.
- Tout autre type de nœud. Toute édition manuelle d'un fichier de `cache/`.

## Contrat
Commande, depuis la racine du dépôt :

    npx tsx scripts/translate-nodes.ts cache --types project,track --limit 30 --apply \
        --manifest out/translate-pilot-fr.json --sample out/translate-pilot-fr.md --sample-size 30

Le corps de la PR contient : le contenu de `out/translate-pilot-fr.md` (30 œuvres, anglais puis français), le
modèle utilisé, `usage` (tokens, coût), le nombre de nœuds acceptés au premier essai, au second, et refusés,
avec le décompte des `code` de refus.

## Critères d'acceptation
- [ ] 30 œuvres au plus sont modifiées ; `git diff --stat` ne montre que des fichiers de `cache/nodes/project/`
      et `cache/nodes/track/`.
- [ ] Chaque fichier modifié ne diffère de `origin/main` que par l'ajout de `l10n.fr`.
- [ ] `npm run check` et `npm run audit:cache` sont verts.
- [ ] Relancer la commande sans `--limit` en aperçu annonce 30 œuvres `current` de plus qu'avant.
- [ ] Le corps de la PR contient l'échantillon complet et les chiffres ci-dessus.
- [ ] La PR est approuvée par Raphael avant merge (tier/3) ; un refus ferme la PR sans merge.

## Tests attendus
- unitaire : aucun nouveau test (aucun code).
- intégration : la suite existante lit le cache committé ; elle doit rester verte.

## Tier de risque
tier/3 — relecture humaine obligatoire : c'est le seul contrôle de la qualité éditoriale.

## Notes d'implémentation
- Si plus de 3 œuvres sur 30 sont refusées par le validateur, ne pas ouvrir la PR en l'état : rapporter les
  motifs à Raphael.
- Si la clé est injectée par le proxy de l'environnement, `GEMINI_API_KEY` peut être une valeur factice.
- Ne pas retoucher un texte français à la main. Pour reprendre un nœud : `--force --slugs <slug>`.
```

### TRA-813 (2.6) — Traduire les projets et les tracks du dépôt

```markdown
## Contexte
Le pilote est validé : le même outil traduit maintenant toutes les œuvres du dépôt (531, dont 30 déjà
faites). Elles atteindront la prod par la tâche 5.3. Aucun effet dans l'app avant.
Plan : docs/plans/track1-contenu-fr.md#partie-2.

**Prérequis** : la PR du pilote (2.5) est mergée ; `GEMINI_API_KEY` et l'accès à
`generativelanguage.googleapis.com` (Q2 du plan).

## Portée
Fichiers modifiés :
- `cache/nodes/project/*.json`, `cache/nodes/track/*.json` — par l'outil uniquement
Hors-scope explicite :
- Tout code, tout autre type de nœud, toute édition manuelle d'un fichier de `cache/`.

## Contrat
    npx tsx scripts/translate-nodes.ts cache --types project,track --apply \
        --manifest out/translate-works-fr.json --sample out/translate-works-fr.md --sample-size 20

Volume attendu : ≈ 500 appels, ≈ 0,5 M tokens en entrée et 0,3 M en sortie, ≈ 0,15 $ en Flash Lite, 10 à
30 minutes. Le corps de la PR contient l'échantillon de 20 œuvres, `counts`, `usage` et la liste `failed`
avec ses motifs.

## Critères d'acceptation
- [ ] `git diff --stat` ne montre que des fichiers de `cache/nodes/project/` et `cache/nodes/track/`.
- [ ] L'aperçu relancé après le lot annonce, pour `project` et `track`, `missing + stale` égal au nombre de
      nœuds listés dans `failed`.
- [ ] `failed` compte au plus 5 % des œuvres ; au-delà, s'arrêter et rapporter les motifs.
- [ ] Un second passage avec `--apply` n'écrit rien de plus que les `failed` repris.
- [ ] `npm run check`, `npm run audit:cache` et `npm run build:graph` sont verts ; le `web/data.json` produit
      ne contient pas la chaîne `"l10n"`.
- [ ] Le corps de la PR contient l'échantillon et les chiffres.

## Tests attendus
- unitaire : aucun nouveau test.
- intégration : la suite existante sur le cache committé reste verte.

## Tier de risque
tier/2 — contenu généré, validé par l'outil, relu sur échantillon dans le résumé de PR.

## Notes d'implémentation
- Si le lot s'arrête sur le quota (code de sortie 3), relancer la même commande plus tard : il reprend.
- Ne pas committer `out/` ni `web/data.json` (ignorés).
- Si `deploy/pull-cache.sh` doit tourner (5.1), le lancer de préférence avant de merger cette PR (R12).
```

### TRA-809 (3.1) — Brancher la traduction à l'écriture dans le pipeline

```markdown
## Contexte
Un nœud créé après le lot (génération depuis l'app, crawl, top-up) naîtrait en anglais. Ce ticket ajoute au
pipeline une étape facultative qui traduit le nœud juste avant sa validation, avec la même fonction que le
lot. Effet visible : une fiche générée depuis l'app s'ouvre en français, une fois le code déployé.
Plan : docs/plans/track1-contenu-fr.md#partie-3 (décision D4).

## Portée
Fichiers à modifier :
- `src/pipeline.ts` — `PipelineDeps.translate` (après la ligne 156), nouvelle étape `attachTranslation`
  appelée entre `attachSimilarArtists` et `validateNode` (lignes 803-809)
- `src/services/materialize-service.ts` — dépendance `translate` (lignes 209-214) transmise à `runPipeline`
  (lignes 706-712)
- `src/server.ts` — brancher le traducteur (lignes 113-123)
- `src/cli.ts` — brancher le traducteur dans `buildCrawlDeps` (lignes 60-84), à la même condition que l'image
- `CLAUDE.md` — la ligne « Modèle » de la section « Stack réelle » (voir Contrat ; changement validé par
  Raphael au gate du plan, question Q3)
Fichiers à créer :
- `src/translation/pipeline-translator.ts` — `makePipelineTranslator`
- `test/pipeline-translation.test.ts`
Hors-scope explicite :
- `generateNodeDraft`, `SYSTEM_PROMPT`, `makeNodeSchema` : l'appel de rédaction ne change pas.
- `metricsSchema` et `_metrics` : le coût de la traduction n'y entre pas ; il est tracé dans le log.
- `scripts/top-up-*.ts`, `src/crawler.ts` : ils reçoivent leurs dépendances de `src/cli.ts`.

## Contrat
    // src/pipeline.ts, PipelineDeps
    /** OPTIONAL: French translation of the node, after enrichment. Unset = no translation step. A null,
     *  a throw or a timeout leaves the node without l10n: the pipeline never fails because of it. */
    translate?: (node: NodePayload) => Promise<NodeTranslation | null>;

    // src/translation/pipeline-translator.ts
    export function makePipelineTranslator(deps: {
      apiKey: string; logger?: (line: string) => void;
    }): NonNullable<PipelineDeps["translate"]>;

- `attachTranslation` : sans `translate`, ne fait rien. Sinon l'appelle sur le nœud enrichi, borné par
  `translationConfig.stepTimeoutMs`. Un résultat non nul qui passe `nodeTranslationSchema` (ticket 1.1)
  devient `node.l10n = { fr: résultat }`. Tout autre cas laisse le nœud sans `l10n` et écrit une ligne de
  log.
- Un nœud rafraîchi ne garde jamais l'ancien bloc : le nœud est reconstruit, le bloc vient de l'étape ou
  n'existe pas.
- `makePipelineTranslator` assemble `createGeminiGenerateJson` (ticket 2.2) et `createNodeTranslator`
  (ticket 2.1) pour la langue `fr`. Il rend `outcome.translation` quand `ok`, sinon `null` avec une ligne de
  log portant `reason` et les `code` des refus, jamais le texte.
- `CLAUDE.md`, ligne actuelle : « Modèle : Gemini Flash Lite, **un seul appel** par nœud, schéma de réponse
  contraint ». Nouvelle ligne : « Modèle : Gemini Flash Lite, **un seul appel de rédaction** par nœud, schéma
  de réponse contraint ; plus un appel de traduction, étape optionnelle (`PipelineDeps.translate`) ».

## Critères d'acceptation
- [ ] Sans `translate`, `runPipeline` rend un nœud sans clé `l10n`, identique à aujourd'hui.
- [ ] Avec un `translate` qui rend un bloc valide, le nœud rendu porte `l10n.fr` et passe `nodePayloadSchema`.
- [ ] `translate` reçoit le nœud après l'enrichissement MusicBrainz : ses arêtes sont celles du nœud rendu.
- [ ] `translate` qui rend `null`, qui lance, ou qui dépasse le délai : le nœud est rendu sans `l10n`, et
      `runPipeline` n'échoue pas.
- [ ] Un bloc invalide rendu par `translate` (article de 10 caractères) ne fait pas échouer le nœud : il est
      écarté avant `validateNode`.
- [ ] `materialize-service` transmet `translate` à `runPipeline` quand il le reçoit, et rien sinon.
- [ ] `makePipelineTranslator` rend `null` pour un `invalid_output` et pour un `quota_exhausted`.
- [ ] `npm run check` est vert.

## Tests attendus
- unitaire : `test/pipeline-translation.test.ts`, sur le modèle de `test/pipeline-image.test.ts` et avec
  `test/helpers/pipeline-mocks.ts` (Gemini, Tavily et MusicBrainz y sont déjà simulés).
- intégration : un cas dans `test/materialize-service.test.ts` pour la transmission de la dépendance.

## Tier de risque
tier/2 — étape facultative du pipeline, couverte par des tests, sans effet irréversible.

## Notes d'implémentation
- Copier la forme d'`attachResolvedImage` (`src/pipeline.ts:903-947`) : course contre un délai, `finally` qui
  annule le minuteur, aucune exception qui remonte.
- Coût : ≈ 950 tokens en entrée et 620 en sortie par nœud, ≈ 0,0003 $, 2 à 4 secondes.
- Le serveur lit la clé comme aujourd'hui (`pipelineConfig.geminiApiKey`). Sans clé, ne pas brancher l'étape.
- Sans effet en prod avant `deploy/deploy-server.sh` (tâche 5.3).
- Ne modifier `CLAUDE.md` que sur cette ligne.
```

### TRA-810 (4.1) — Servir `l10n.fr` sur `/mobile/v1/nodes/:id`

```markdown
## Contexte
Les nœuds portent maintenant une traduction, mais l'API mobile ne projette que l'anglais. Ce ticket ajoute à
la réponse d'une fiche un champ additif `node.l10n.fr`. Les clients existants l'ignorent ; l'app le lira avec
le ticket 4.2. Sans effet en prod avant le déploiement du code (tâche 5.3).
Plan : docs/plans/track1-contenu-fr.md#partie-4 (décision D5).

## Portée
Fichiers à modifier :
- `src/mobile/contracts.ts` — types `MobileNodeTranslation`, `MobileNodeL10n`
- `src/mobile/nodes.ts` — type `MobileNode`, `MobileNodeResult.node`, lecture du bloc dans `read`
  (lignes 36-51)
- `docs/track1-api.md` — nouvelle section « Contenu localisé d'une fiche », après « Catalogue disponible »
- `test/mobile/nodes.test.ts` — nouveaux cas
Hors-scope explicite :
- `src/graph.ts` et `VizNode` : NON modifiés. Le bloc est lu sur le `NodePayload`, pas sur la projection.
- `src/mobile/catalog.ts`, `src/mobile/router.ts`, `src/mobile/http.ts` : le catalogue ne change pas, aucune
  route n'accepte de nouveau paramètre, `Cache-Control` ne change pas.
- `mobile/` (client React Native) et `ios/`.

## Contrat
    // src/mobile/contracts.ts
    export interface MobileNodeTranslation {
      teaser: string;
      article: string;
      facts?: Record<string, string>;
    }
    export interface MobileNodeL10n { fr?: MobileNodeTranslation }

    // src/mobile/nodes.ts
    export type MobileNode = VizNode & { l10n?: MobileNodeL10n };
    export interface MobileNodeResult { node: MobileNode; source: "cache"; redirected_from?: Slug }

Réponse de `GET /mobile/v1/nodes/:id`, champs ajoutés seulement :

    { "node": { "...": "champs actuels inchangés",
        "l10n": { "fr": { "teaser": "…", "article": "…", "facts": { "origin": "…" } } } },
      "source": "cache" }

- `l10n.fr` est présent si et seulement si `currentTranslation(node, "fr")` rend un bloc.
- `facts` ne porte que les clés de `TRANSLATABLE_FACT_FIELDS[type]` présentes à la fois dans le bloc et dans
  les `facts` anglais de la fiche ; sans aucune clé, `facts` est omis.
- `source_sha256`, `model` et `translated_at` ne sortent jamais.
- Sans traduction courante, la clé `l10n` est absente (pas `null`, pas `{}`).
- `teaser`, `article`, `facts` de premier niveau restent l'anglais. `version` reste `v1`.

## Critères d'acceptation
- [ ] Un nœud avec une traduction courante est servi avec `node.l10n.fr.teaser` et `.article` égaux au bloc ;
      `node.teaser` et `node.article` sont l'anglais.
- [ ] Un nœud sans bloc est servi sans clé `l10n` ; la réponse est identique à celle d'aujourd'hui.
- [ ] Un nœud dont l'article anglais a changé depuis la traduction est servi sans clé `l10n`.
- [ ] La réponse ne contient ni `source_sha256`, ni `model`, ni `translated_at`.
- [ ] Une clé de `facts` hors de `TRANSLATABLE_FACT_FIELDS[type]`, ou absente des faits anglais, n'est pas
      servie.
- [ ] Un nœud lu à travers une redirection porte toujours `redirected_from` et son `l10n.fr`.
- [ ] `GET /mobile/v1/catalog` rend la même `revision` avant et après ce changement sur un même cache.
- [ ] `docs/track1-api.md` décrit le champ, sa règle de présence et la règle de repli côté client.
- [ ] `npm run check` est vert, `test/mobile/compatibility.test.ts` compris.

## Tests attendus
- unitaire : `test/mobile/nodes.test.ts`, un cas par critère, sur un `NodeCache` temporaire comme les cas
  existants.
- intégration : `test/mobile/compatibility.test.ts` reste vert sans modification (le schéma de nœud du client
  React Native n'est pas strict).

## Tier de risque
tier/3 — changement d'un contrat d'API public.

## Notes d'implémentation
- Ajouter le bloc après `sanitizeNodeImage` et `sanitizeCitations`, sans toucher à ces deux fonctions.
- Aucun paramètre de langue : les routes répondent 400 à toute query inconnue (`src/mobile/router.ts:105`),
  et cela reste vrai.
- Le plan pochettes modifie aussi `src/mobile/contracts.ts` et `docs/track1-api.md` (`has_image`) : zones
  différentes, se rebaser sur la PR mergée la première.
- Diff écrit à tenir sous 200 lignes, tests et doc compris.
```

### TRA-814 (4.2) — Lire `l10n.fr` côté iOS et afficher le français

```markdown
## Contexte
Le serveur enverra un bloc français dans la réponse d'une fiche (contrat du ticket 4.1). Ce ticket le fait
lire par l'app : quand le bloc est là et complet, le lecteur et la fiche affichent le français ; sinon rien
ne change. La prod n'envoie pas encore le champ : la build reste en anglais jusqu'à la tâche 5.3.
Plan : docs/plans/track1-contenu-fr.md#partie-4 (décision D5).

## Portée
Fichiers à modifier :
- `ios/Track1Core/Sources/Track1Core/API/APIModels.swift` — `NodeDetail` (lignes 196-231), nouveau type
  `ContentLanguage`
Fichier à créer :
- `ios/Track1Core/Tests/Track1CoreTests/API/NodeLocalizationTests.swift`
Hors-scope explicite :
- `NodePageHeader.swift`, `PlayerView.swift`, `NodePageView.swift`, `NodeArticleView.swift` : NON modifiés,
  ils lisent déjà `node.teaser`, `node.article` et `node.facts`.
- `Catalog`, `CatalogNode`, `APIClient.swift` : aucun en-tête, aucun paramètre de langue.
- `ArticleSentences.swift` (ticket 4.3). `NodePageSpec` et ses libellés anglais (Q6 du plan).
- Le client React Native (`mobile/`).

## Contrat
JSON reçu, champ additif et facultatif :

    "node": { "...": "…", "l10n": { "fr": { "teaser": "…", "article": "…", "facts": { "origin": "…" } } } }

    public enum ContentLanguage: String, Sendable { case en, fr }

    public struct NodeDetail {
        // existing members unchanged
        /// Language of `teaser`, `article` and `facts` as decoded.
        public let contentLanguage: ContentLanguage
    }

    /// The language the content is shown in: the device's first preferred language when it is French,
    /// English otherwise. Read in one place; tests inject the list of preferred languages.
    public static func preferredContentLanguage(preferredLanguages: [String]) -> ContentLanguage

Règle de langue (précision de Raphael, 23/11) : l'app n'affiche que la langue de l'appareil, jamais les deux.
Sur un appareil qui n'est pas en français, `l10n.fr` est ignoré et la fiche reste en anglais.

Règle de décodage, sur un appareil en français :
- `l10n.fr` est lu de façon tolérante : absent, mal formé ou d'un autre type, il est lu comme absent et ne
  fait jamais échouer la fiche.
- Le bloc s'applique seulement si `article` et `teaser` sont non vides une fois rognés. Alors `teaser` et
  `article` prennent les valeurs françaises ; `facts` garde les clés anglaises, et la valeur française
  remplace l'anglaise pour chaque clé présente dans les deux ; une clé française absente des faits anglais
  est ignorée ; `contentLanguage` vaut `.fr`.
- Sinon `teaser`, `article`, `facts` sont ceux d'aujourd'hui et `contentLanguage` vaut `.en`.
- Jamais de mélange : pas de teaser français avec un article anglais.

## Critères d'acceptation
- [ ] Une réponse sans `l10n` se décode comme aujourd'hui, avec `contentLanguage == .en`.
- [ ] Sur un appareil en français, une réponse avec un `l10n.fr` complet donne `article` et `teaser` français,
      et `contentLanguage == .fr`.
- [ ] Sur un appareil en anglais (`["en-GB", "fr-FR"]`), la même réponse reste entièrement en anglais, avec
      `contentLanguage == .en`.
- [ ] `preferredContentLanguage` : `["fr-FR"]` et `["fr-CA", "en"]` donnent `.fr` ; `["en-US"]`, `["de-DE",
      "fr-FR"]` et `[]` donnent `.en`.
- [ ] `facts["origin"]` prend la valeur française ; `facts["year"]`, absent du bloc, garde sa valeur.
- [ ] Une clé de `l10n.fr.facts` absente des faits anglais n'apparaît pas dans `facts`.
- [ ] `l10n.fr` avec un `article` vide ou fait d'espaces : tout reste en anglais.
- [ ] `l10n` valant `null`, une chaîne, ou `{ "fr": 3 }` : la fiche se décode, en anglais.
- [ ] `PlayerView.paragraphs(for:)` d'une fiche décodée en français rend les phrases de l'article français
      (test dans `ios/Track1Tests/Node/PlayerViewTests.swift`).
- [ ] `NodePageHeader(node:)` d'une fiche décodée en français rend le teaser français.
- [ ] `swift test` dans `ios/Track1Core` est vert ; `ios-check` est vert.

## Tests attendus
- unitaire : `NodeLocalizationTests.swift`, un cas par critère, en décodant du JSON comme
  `NodePageHeaderTests.swift` (ligne 264).
- intégration : un cas ajouté à `ios/Track1Tests/Node/PlayerViewTests.swift`.

## Tier de risque
tier/2 — logique de décodage locale, couverte par des tests.

## Notes d'implémentation
- `NodeDetail` n'a pas d'initialiseur membre à membre : les tests décodent du JSON.
- Suivre la convention du fichier pour un champ additif : `(try? …) ?? nil` (voir `NodeEdge.artist`,
  ligne 274).
- Le plan pochettes modifie `CatalogNode` dans le même fichier : zone différente, se rebaser.
- Se livre par TestFlight sans déploiement serveur.
```

### TRA-815 (4.3) — Fiabiliser le découpage en phrases pour le français

```markdown
## Contexte
Le lecteur affiche l'article une phrase à la fois (`ArticleSentences.split`). Deux défauts existent déjà en
anglais et deviennent fréquents en français : une coupure après une abréviation suivie d'une majuscule
(`feat. Four Tet`, `Dr. Dre`, `Vol. II`), et une coupure avant le guillemet fermant d'un titre qui finit par
`?` ou `!`. Ce ticket ajoute deux règles et épingle le comportement par des phrases françaises.
Plan : docs/plans/track1-contenu-fr.md#partie-4 (décision D5, Problème §7).

## Portée
Fichiers à modifier :
- `ios/Track1Core/Sources/Track1Core/Features/Node/ArticleSentences.swift`
- `ios/Track1Core/Tests/Track1CoreTests/Node/ArticleSentencesTests.swift` — nouveaux cas, aucun cas retiré
Hors-scope explicite :
- La fusion des règles Markdown avec `NodePageHeader.stripMarkdown` (TRA-751).
- `PlayerView.swift`, `PlayerScroll.swift`, `APIModels.swift`.
- Le framework NaturalLanguage : `Track1Core` reste sur Foundation.

## Contrat
`ArticleSentences.split(_:)` garde sa signature. Deux règles s'ajoutent après la segmentation de Foundation
et avant `glueShortFragments`. Elles ne joignent que des phrases voisines d'une même ligne, et le résultat
d'une jointure est la portion du texte nettoyé qui couvre les deux phrases : aucune espace n'est inventée ni
perdue, une espace insécable reste insécable.
- **Abréviation** : une phrase dont le dernier mot est une abréviation de la liste est jointe à la phrase
  suivante. Liste fermée, comparée sans tenir compte de la casse : `feat.`, `ft.`, `vs.`, `prod.`, `vol.`,
  `Dr.`, `St.`, `No.`.
- **Signe fermant** : une phrase qui commence par `»`, `”`, `"`, `)`, `,`, `;` ou `:` est jointe à la phrase
  précédente.
Ne sont PAS dans la liste, par décision : `etc.` (il finit souvent une phrase) et les initiales (`J.`), parce
que « Kid A. » ou « face B. » finissent une phrase.
Dans les cas ci-dessous, `~` note une espace insécable U+00A0, et « rend le texte entier » veut dire une
seule phrase, égale à l'entrée.

## Critères d'acceptation
- [ ] `«~Idioteque~» est le huitième morceau de Kid A. Le morceau repose sur un échantillon de Paul Lansky.`
      → 2 phrases, coupées après `Kid A.`.
- [ ] `Qui aurait parié sur ce disque~? Personne, à l’époque, chez Warp Records.` → 2 phrases ; la première
      est `Qui aurait parié sur ce disque~?`.
- [ ] `Le maxi sort chez XL Recordings avec Burial feat. Four Tet, puis ressort en 2012 dans une version
      longue.` → rend le texte entier.
- [ ] `Le morceau réunit Skream ft. Example et sort en 2010 chez Tempa.` → rend le texte entier.
- [ ] `Le disque est produit par Dr. Dre et sort en 1999 chez Aftermath Entertainment.` → rend le texte
      entier.
- [ ] `La compilation Artificial Intelligence Vol. II paraît en 1994 chez Warp Records.` → rend le texte
      entier.
- [ ] `Le maxi oppose Basic Channel vs. Maurizio sur deux faces de douze minutes.` → rend le texte entier.
- [ ] `Enregistré à St. Louis en 1978, l’album sort l’année suivante chez Stax.` → rend le texte entier.
- [ ] `Le groupe enchaîne avec «~Where Is My Mind~?~», devenu son titre le plus connu.` → rend le texte
      entier.
- [ ] `Le groupe enchaîne avec «~Where Is My Mind?~». La suite est plus contrastée, mais reste dans la même
      veine.` → 2 phrases ; la première est `Le groupe enchaîne avec «~Where Is My Mind?~».`.
- [ ] `Le critique parle d’un «~disque parfait~». La suite est plus contrastée, mais reste dans la même
      veine.` → 2 phrases.
- [ ] `Le disque tient en trois mots~: basse, espace, silence. Il sort en 2006 chez Hyperdub Records.` →
      2 phrases.
- [ ] `Le label publie de la house, de la techno, etc. Il ferme ses portes en 2001 après dix ans.` →
      2 phrases.
- [ ] `The single was a collaboration with Flying Lotus feat. Thundercat and reached the charts in 2014.` →
      rend le texte entier.
- [ ] Tous les tests existants de `ArticleSentencesTests.swift` passent sans modification.
- [ ] `swift test` dans `ios/Track1Core` est vert ; `ios-check` est vert.

## Tests attendus
- unitaire : un test par critère, avec U+00A0 écrit `\u{00A0}` dans les littéraux.
- intégration : aucun.

## Tier de risque
tier/2 — logique locale pure, couverte par des tests.

## Notes d'implémentation
- Sonde faite au planning avec l'ICU de Node (`Intl.Segmenter`, ICU 78), indicative seulement : elle coupe
  après `feat.`, `ft.`, `vs.`, `prod.`, `Dr.`, `St.` et `Vol.` suivis d'une majuscule, et avant le `»` de
  `«~Where Is My Mind~?~»` ; elle coupe correctement après `Kid A.` et après `etc.`. Foundation peut
  différer : les critères disent le résultat attendu, pas la cause.
- `trimmingCharacters(in: .whitespacesAndNewlines)` retire aussi U+00A0 : joindre des phrases déjà rognées
  perdrait l'espace insécable. D'où la règle « portion du texte nettoyé ».
- La règle des 25 caractères (`minimumLength`) recolle un fragment court à la phrase PRÉCÉDENTE, ce qui est
  le mauvais côté après une abréviation. D'où l'ordre : les deux règles nouvelles d'abord,
  `glueShortFragments` ensuite.
- Le texte vient du réseau : il est nettoyé et coupé, jamais interprété ; les vues restent en
  `Text(verbatim:)`.
- Se livre par TestFlight sans déploiement serveur ; améliore aussi les articles anglais.
```

### TRA-816 (5.1) — Ramener dans le dépôt les nœuds créés en prod

```markdown
## Contexte
209 nœuds de la prod n'existent pas dans le dépôt (69 projets, 72 tracks, 53 artistes, 11 labels, 4 genres),
dont `track:idioteque--radiohead`. Le lot de traduction tourne sur le dépôt : sans eux, ces fiches restent
en anglais. Le chemin existe déjà (TRA-493) ; son workflow est désactivé, la commande se lance à la main.
Plan : docs/plans/track1-contenu-fr.md#partie-5 (décision D6, Problème §3).

**Action de Raphael** : exige un poste avec `ssh-agent` et l'accès au serveur. Un agent cloud ne peut pas la
mener.

## Portée
Fichiers modifiés :
- `cache/nodes/**` — ajout des nœuds classés `new`, par `deploy/pull-cache.sh` uniquement
Hors-scope explicite :
- Toute modification de `deploy/pull-cache.sh`, de `scripts/ci/pull-cache-validate.ts` ou de
  `data/integrity-thresholds.json` : si la validation refuse, s'arrêter et le rapporter.
- Les nœuds classés `changed` : jamais copiés (règle du script).

## Contrat
    bash deploy/pull-cache.sh            # aperçu : classification et validation
    bash deploy/pull-cache.sh --apply    # copie les nœuds `new` validés dans cache/nodes/

Lecture seule sur le serveur. Le corps de la PR donne le nombre de nœuds `new` par type et la liste `changed`.

## Critères d'acceptation
- [ ] L'aperçu se termine avec le code 0 ; sinon la PR n'est pas ouverte et le message de validation est
      rapporté.
- [ ] `cache/nodes/track/idioteque--radiohead.json` existe après `--apply`.
- [ ] `git diff --stat` ne montre que des fichiers ajoutés sous `cache/nodes/` ; aucun fichier modifié.
- [ ] `npm run check` et `npm run audit:cache` sont verts.
- [ ] Le corps de la PR contient les décomptes `new` et `changed`.

## Tests attendus
- unitaire : aucun nouveau test.
- intégration : la suite existante sur le cache committé reste verte.

## Tier de risque
tier/2 — lecture seule en prod, ajout de nœuds déjà validés par le script.

## Notes d'implémentation
- Mesure du planning, par le catalogue public du 2026-11-23 : 209 identités de prod absentes du dépôt, et
  8 nœuds communs dont le teaser diffère.
- À lancer de préférence avant de merger la PR de 2.6 : sinon l'aperçu liste en `changed` chaque nœud déjà
  traduit, ce qui est du bruit, pas une erreur.
- Si la validation refuse à cause d'un plafond d'intégrité, c'est un sujet du plan `graph-integrity`, pas de
  celui-ci : ne pas relever un plafond ici.
```

### TRA-817 (5.2) — Traduire les œuvres ramenées de la prod

```markdown
## Contexte
Le pull (5.1) a ajouté au dépôt les œuvres créées en prod, dont « Idioteque ». Ce ticket repasse le lot : il
ne traduit que ce qui manque, donc ces œuvres-là. Plan : docs/plans/track1-contenu-fr.md#partie-5.

**Prérequis** : la PR de 5.1 et celle du pilote (2.5) sont mergées ; `GEMINI_API_KEY` et l'accès à
`generativelanguage.googleapis.com` (Q2 du plan).

## Portée
Fichiers modifiés :
- `cache/nodes/project/*.json`, `cache/nodes/track/*.json` — par l'outil uniquement
Hors-scope explicite :
- Tout code, tout autre type de nœud, toute édition manuelle d'un fichier de `cache/`.

## Contrat
    npx tsx scripts/translate-nodes.ts cache --types project,track --apply \
        --manifest out/translate-pulled-fr.json --sample out/translate-pulled-fr.md --sample-size 20

Volume attendu : ≈ 140 appels, ≈ 0,05 $.

## Critères d'acceptation
- [ ] `cache/nodes/track/idioteque--radiohead.json` porte un `l10n.fr` dont l'article contient `Kid A` et
      `Radiohead`.
- [ ] `git diff --stat` ne montre que des fichiers de `cache/nodes/project/` et `cache/nodes/track/`.
- [ ] L'aperçu relancé annonce, pour `project` et `track`, `missing + stale` égal au nombre de `failed`.
- [ ] `npm run check` et `npm run audit:cache` sont verts.
- [ ] Le corps de la PR contient l'échantillon, `counts`, `usage` et `failed`.

## Tests attendus
- unitaire : aucun nouveau test.
- intégration : la suite existante sur le cache committé reste verte.

## Tier de risque
tier/2 — contenu généré, validé par l'outil, relu sur échantillon.

## Notes d'implémentation
- Si 2.6 n'est pas encore jouée, cette commande fait les deux d'un coup : fusionner alors les deux tickets
  en une seule PR et le dire dans son titre.
- Ne pas retoucher un texte à la main : `--force --slugs <slug>`.
```

### TRA-818 (5.3) — Déployer le code, puis passer le cache traduit sur la prod

```markdown
## Contexte
Le français est dans le dépôt, l'API sait le servir et l'app sait le lire, mais la prod tourne sur le code du
24 octobre et ne reçoit plus rien. Ce ticket est la mise en production : le code d'abord, les données
ensuite. C'est lui qui fait apparaître le français dans l'app.
Plan : docs/plans/track1-contenu-fr.md#partie-5 (décision D6, risque R3).

**Action de Raphael** : exige un poste avec `ssh-agent`. Bloqué par la question Q1 du plan, la même que celle
du plan pochettes.

## Portée
Aucun fichier du dépôt n'est modifié. Deux scripts existants sont lancés, sans changement :
- `deploy/deploy-server.sh`
- `deploy/sync-genre-cache.sh`
Hors-scope explicite :
- Toute modification de `deploy/`, `.github/` ou d'un workflow.
- Rétablir le déploiement automatique.

## Contrat
Dans cet ordre, depuis un `main` à jour qui contient au moins 1.1, 4.1 et 2.6 :

    bash deploy/deploy-server.sh                 # 1. le code : la prod connaît le champ l10n
    bash deploy/sync-genre-cache.sh              # 2. aperçu de l'union, à lire
    bash deploy/sync-genre-cache.sh --apply      # 3. les données

Le code passe en premier parce que le code du 24/10 supprime un champ qu'il ne connaît pas dès qu'il réécrit
un nœud. Le canal transfère tout `nodes/` de l'union ; à `materialized_at` égal, la version du dépôt gagne.

## Critères d'acceptation
- [ ] Après l'étape 1, `https://dropcliffs.com/api/odyssey/version` rend le SHA de `main` déployé, et
      `GET /mobile/v1/nodes/track:idioteque--radiohead` répond 200.
- [ ] L'aperçu de l'étape 2 ne signale aucun conflit ni aucune redirection non committée ; sinon s'arrêter.
- [ ] Après l'étape 3, `GET https://dropcliffs.com/api/odyssey/mobile/v1/nodes/track:idioteque--radiohead`
      rend un `node.l10n.fr.article` non vide, et `node.article` est toujours l'anglais.
- [ ] Sur 20 œuvres tirées de `GET /mobile/v1/catalog`, 19 au moins rendent `node.l10n.fr`.
- [ ] `GET /mobile/v1/catalog` répond 200 avec le même nombre de nœuds qu'avant, à ceux du pull près.
- [ ] Dans une build TestFlight qui contient 4.2 et 4.3, « Idioteque » s'affiche en français dans le lecteur
      et sur la fiche.
- [ ] L'archive de retour arrière imprimée par le script est notée dans le ticket.

## Tests attendus
- unitaire : aucun.
- intégration : les contrôles HTTP ci-dessus, faits à la main ou par `curl`.

## Tier de risque
tier/3 — écriture en production.

## Notes d'implémentation
- Si le lot d'images du plan pochettes (sa tâche 4.1) doit passer par le canal, deux ordres sont sûrs :
  avant le merge de 2.6 d'ici, ou après l'étape 1 ci-dessus. Entre les deux, le français posé sur la prod
  peut être effacé par l'ancien code ; il est reposé au passage suivant du canal.
- Une fiche déjà ouverte sur un appareil reste en anglais jusqu'à 24 h (`Cache-Control: private,
  max-age=86400`).
- Ce ticket est rejouable : chaque passage du canal embarque ce qui a été mergé depuis (5.2, 6.1).
- Retour arrière des données : l'archive du script. Retour arrière du français seul : inutile, l'app retombe
  sur l'anglais dès que le bloc manque.
```

### TRA-819 (6.1) — Traduire les artistes, les genres et les labels

```markdown
## Contexte
Les œuvres sont en français ; les pages qu'on ouvre depuis une œuvre (artiste, genre, label) sont encore en
anglais. Ce ticket passe le même lot sur ces trois types, avec leurs faits en texte libre (`origin`, `era`,
`sonic_markers`, `location`, `active_years`). Ils atteignent la prod par un nouveau passage de 5.3.
Plan : docs/plans/track1-contenu-fr.md#partie-6 (décision D1).

**Prérequis** : la PR de 2.6 est mergée ; `GEMINI_API_KEY` et l'accès à `generativelanguage.googleapis.com`.

## Portée
Fichiers modifiés :
- `cache/nodes/artist/*.json`, `cache/nodes/genre/*.json`, `cache/nodes/label/*.json` — par l'outil uniquement
Hors-scope explicite :
- Tout code, toute édition manuelle d'un fichier de `cache/`.
- `data/genre-taxonomy.json` et les noms de genres : jamais traduits.

## Contrat
    npx tsx scripts/translate-nodes.ts cache --types artist,genre,label --apply \
        --manifest out/translate-entities-fr.json --sample out/translate-entities-fr.md --sample-size 30

Volume attendu : ≈ 1 070 appels sur le dépôt actuel (≈ 1 140 après le pull de 5.1), ≈ 1,0 M tokens en entrée
et 0,65 M en sortie, ≈ 0,30 $ en Flash Lite, 20 à 60 minutes. L'échantillon de la PR contient 10 artistes,
10 genres et 10 labels, faits compris.

## Critères d'acceptation
- [ ] `git diff --stat` ne montre que des fichiers de `cache/nodes/artist/`, `cache/nodes/genre/` et
      `cache/nodes/label/`.
- [ ] L'aperçu relancé annonce, pour ces trois types, `missing + stale` égal au nombre de `failed`.
- [ ] `failed` compte au plus 5 % des nœuds de chaque type ; au-delà, s'arrêter et rapporter les motifs.
- [ ] Dans l'échantillon, aucun nom de genre, d'artiste ou de label n'est traduit dans un fait (`origin`,
      `location`) : contrôle fait par l'auteur de la PR et écrit dans son corps.
- [ ] `npm run check`, `npm run audit:cache` et `npm run build:graph` sont verts ; le `web/data.json` produit
      ne contient pas la chaîne `"l10n"`.
- [ ] Le corps de la PR contient l'échantillon, `counts`, `usage` et `failed`.

## Tests attendus
- unitaire : aucun nouveau test.
- intégration : la suite existante sur le cache committé reste verte.

## Tier de risque
tier/2 — contenu généré, validé par l'outil, relu sur échantillon.

## Notes d'implémentation
- Le nom d'un nœud genre n'est pas un nom propre imposé : « ambient music » peut devenir « musique ambient ».
  C'est voulu (ticket 1.4).
- Si le quota arrête le lot (code de sortie 3), relancer la même commande : il reprend.
- Après merge, rejouer 5.3 (étapes 2 et 3 seulement si le code n'a pas changé).
```
