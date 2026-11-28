# Lecteur iOS : un extrait légal du morceau pendant la lecture

Plan de la phase `plan` du process de livraison, écrit le 2026-11-28 sur le brief de Raphael (app iOS
Track1, lecteur `PlayerView`). **Validé par Raphael le 2026-11-28** (gate humain, étape 3), amendé le même
jour avec ses décisions (section « Décisions de Raphael » ci-dessous). Projet Linear : à créer ; les
identifiants des tickets sont à reporter ici.

Brief : « J'aimerais qu'on ait un extrait de la musique, qu'on obtienne de façon légale — soit un extrait
de l'album, soit un extrait du titre qu'on recommande — qui se joue dans le player pendant que
l'utilisateur est en train de lire la description. »

Précisions : surface = l'app iOS uniquement (le lecteur `ios/Track1/Features/Node/PlayerView.swift`, pas le
player audio du site web) ; l'extrait doit être obtenu légalement, et le plan doit dire d'où il vient, à
quelles conditions, et ce qui se passe sans extrait.

Tous les chemins sont relatifs à la racine du dépôt ; les numéros de ligne sont ceux de `origin/main` au
2026-11-28 (`e86f046`).

## Décisions de Raphael (2026-11-28)

Réponses aux questions du gate, intégrées dans les décisions, le découpage et les tickets ci-dessous.

- **Q1 Source** : iTunes Search API sans clé (D1), recommandation acceptée.
- **Q2 Album** : **pas la piste 1 par défaut.** L'extrait d'un album est une piste « déjà notable » : une
  piste de l'album qui figure parmi les pistes notables de son artiste. Règle complète en D3 (ordre quand
  plusieurs pistes sont notables, repli quand aucune ne l'est ou n'a d'extrait). Le repli « piste 1 » est
  **une hypothèse à confirmer** (Q2b) : Raphael l'a supposée sans la trancher.
- **Q4 Lecture automatique** à l'ouverture du lecteur : oui. Raphael a été informé de la tension avec la
  condition « entertainment value » (§ 5.2.5, condition v de la licence) et **assume cette décision de
  risque** ; le kill switch serveur reste (Risques, ticket 1.4).
- **Q5 Session audio** : `.ambient` (mode silencieux respecté, jamais d'interruption d'une autre app, pas de
  démarrage automatique si une autre app joue).
- **Q10** : ticket 1.4 (champ additif de `/links`) en **tier/2**.
- **Q3, Q6, Q7 (libellé français), Q8, Q9, silence sans extrait** : recommandations du plan, non contestées.
- **Q11 reste ouverte** : les conditions non vérifiées (Performance Partners, Identity Guidelines) sont à
  lire par Raphael **avant le merge de 3.2** ; c'est une précondition écrite dans ce ticket.

## Problème

1. **Le lecteur est muet.** `PlayerView` dessine l'article phrase par phrase et une barre « Now »
   (`PlayerNowBar`, Figma `338:2493`) qui n'offre que des liens sortants : « Écouter sur Apple Music »,
   « Écouter sur Spotify » (`PlayerReader.bottomBar`, `PlayerView.swift:292-310` ;
   `ListeningActions.actions`, `ios/Track1Core/Sources/Track1Core/Listening/ListeningActions.swift:53-68`).
   Écouter la musique dont on lit la description impose de quitter l'app.
2. **Le serveur sait déjà parler à iTunes, mais jette l'extrait.** `/mobile/v1/nodes/:slug/links`
   (`src/mobile/router.ts:95,122`, `src/mobile/media.ts:107-144`) résout la page Apple Music d'un
   artiste / album / morceau par l'iTunes Search API (`src/streaming-links.ts:106-126`,
   `src/itunes.ts:85-128`). La réponse iTunes d'un `song` porte un champ `previewUrl` (extrait de 30 s)
   que `ITunesResult` (`src/itunes.ts:25-36`) ne déclare pas : l'extrait est déjà dans la réponse HTTP,
   il n'est pas lu.
3. **Rien dans l'app ne joue de l'audio.** Aucun `AVFoundation`, `AVPlayer` ni `AVAudioSession` dans
   `ios/` (vérifié par grep) ; l'`Info.plist` n'a pas de `UIBackgroundModes`. Le seul son est le tick
   système de l'onboarding (`AudioToolbox`, `GenresStepView.swift:120`). Tout est à construire : session
   audio, moteur, états, contrôle, attribution.
4. **La contrainte légale n'est pas un détail d'implémentation.** Une URL d'extrait est une donnée tierce
   comme une pochette : hôte à valider des deux côtés (convention `CLAUDE.md`, `safePublicHttpsUrl`,
   `URLValidation`). Et l'extrait vient avec des conditions d'usage (attribution, lien vers la boutique,
   streaming seul) qui dictent l'UI autant que le droit.

## Ce que disent les sources (vérifié le 2026-11-28)

**Vérifié, texte d'Apple :**

- iTunes Search API, section *Legal* de la documentation
  (<https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/index.html>) :
  les « Promo Content » (dont « previews of songs ») peuvent être utilisés « for the purposes of promoting
  the subject of the Promo Content », à six conditions : (i) « placed only on pages that promote the
  content on which the Promo Content is based » ; (ii) « proximate to a “Download on iTunes” […] badge
  (as approved by Apple) that acts as a link directly to pages within iTunes […] where consumers can
  purchase the promoted content » ; (iii) « includes attribution indicating the Promo Content was
  “provided courtesy of iTunes” if such Promo Content includes song or music video previews » ;
  (iv) « is streamed only, and not downloaded, saved, cached, or synchronized with video » ; (v) « is not
  used for independent entertainment value apart from its promotional purpose » ; (vi) « is not used to
  promote any other goods or services ». Apple fournit le contenu « as is » et peut en demander le retrait.
  La même doc (*Understanding Search Results*) définit `previewUrl` : « A URL referencing the 30-second
  preview file for the content associated with the returned media type », « Only when media type is
  track ». Aucune authentification, aucune clé.
- App Store Review Guidelines (<https://developer.apple.com/app-store/review/guidelines/>), § 5.2.5 :
  « Music from iTunes and Apple Music previews may not be used for their entertainment value (such as as
  the background music to a photo collage or the soundtrack to a game) or in any other unauthorized
  manner. If you provide music previews from iTunes or Apple Music, you must display a link to the
  corresponding music in iTunes or Apple Music. » § 4.5.2 (MusicKit) : « Make sure to follow the Apple
  Music Identity Guidelines when integrating Apple Music services in your app. »
- Spotify, blog officiel du 2024-11-27 (<https://developer.spotify.com/blog/2024-11-27-changes-to-the-web-api>) :
  les « 30-second preview URLs » ne sont plus accessibles aux nouvelles applications. Spotify est exclu.

**Vu seulement via des extraits de recherche (hôte injoignable depuis la session) :**

- Page « Search API » d'Apple Performance Partners (<https://performance-partners.apple.com/search-api>) :
  « Developers may use promotional content in the API, including previews of songs […] only to promote
  store content and not for entertainment purposes. Use of sound samples and other assets from the API
  must be proximate to a store badge. Terms and conditions apply. » Et : « limited to approximately
  20 calls per minute (subject to change) » — le commentaire de `src/itunes.ts:10` dit « ~20 req/s » ;
  la valeur basse est retenue pour le dimensionnement.

**Non vérifié (à lire par Raphael avant la mise en production de la partie 3) :**

- Les « Terms and conditions » du programme Performance Partners auxquels la page renvoie.
- Les Apple Music Identity Guidelines (<https://marketing.services.apple/apple-music-identity-guidelines>) :
  forme exacte du badge « Listen on Apple Music », libellé d'attribution en français.
- Les conditions de l'Apple Music API / MusicKit pour un usage « extraits seuls, sans abonnement » :
  trois fils du forum développeur posent la question (threads 836910, 857472, 761237), aucun n'a de
  réponse d'Apple.
- Les conditions d'utilisation de l'API Deezer (champ `preview`, MP3 30 s) : hôte injoignable, et la FAQ
  développeur indique que Deezer « does not certify developers using its API ».

## Non-buts

- **Pas de web.** Le player de `web/index.html` ne change pas ; le client React Native historique
  (`mobile/`) non plus : son schéma `linksResponseSchema` (`mobile/src/api/contracts.ts:175-181`) est un
  `z.object` non strict, un champ de plus le laisse valide.
- **Pas de champ de nœud, pas de schéma.** Rien dans `src/types.ts`, `src/schemas.ts`, `src/node-spec.ts`,
  `src/graph.ts`, ni dans `cache/nodes/**` (D2). Pas de ticket `tier/3` de schéma.
- **Pas de MusicKit, pas de clé Apple, pas de secret** côté serveur ni côté app (D1). Pas de dépendance
  npm ni Swift nouvelle.
- **Pas de lecture en arrière-plan** : pas de `UIBackgroundModes`, pas de `MPNowPlayingInfoCenter`, pas de
  commandes sur l'écran verrouillé, pas de reprise après interruption (D4). L'extrait n'est pas un lecteur
  de musique ; c'est un complément à la lecture, qui s'arrête quand la lecture s'arrête.
- **Pas d'extrait pour les genres et les labels** (D3) : ils n'ont ni page Apple Music ni barre Now
  (`NodePageListening.actions`, `NodePageDisplay.swift:42-47`). Un plan séparé pourrait jouer le
  « landmark track » d'un genre ; ce n'est pas ce brief (Q3).
- **Pas de boucle, pas de fondu, pas de réglage de volume** dans l'app (Q6, Q10).
- **Pas de cache audio** sur l'appareil ni sur le serveur, ni de proxy audio par notre serveur : le flux
  va d'Apple à l'appareil (condition iv). Seule l'URL de l'extrait et ses métadonnées sont mises en cache
  (sidecar `cache/links/`, ignoré par git).
- **Pas d'événement analytics** nouveau : le plan de tracking (`docs/track1-tracking-plan.md`, événement 16)
  précise qu'`external_listening_opened` « n'est pas une confirmation de lecture audio » ; un éventuel
  `preview_played` est un brief à part (Q9).
- **Pas de localisation** du chrome : libellés français en dur, comme « Retour » et la ligne de source
  (plan `player-source-link`, D5).
- **Pas de changement de `PlayerScroll`**, du carrousel, du focus, ni de la ligne de source.

## Décisions d'archi

### D1 — Source : l'iTunes Search API (`previewUrl`), résolue par le serveur, sans clé

L'extrait vient du champ `previewUrl` des résultats `entity=song` de l'iTunes Search API, et de
`/lookup?id=<collectionId>&entity=song` pour les pistes d'un album. Raisons : (a) c'est la seule source
d'extraits 30 s de musique commerciale **sans authentification ni clé**, avec des conditions d'usage
publiées par Apple (section *Legal* ci-dessus) ; (b) le projet l'utilise déjà pour les pochettes et les
liens Apple Music, avec sa vérification de correspondance (`nameMatchScore`, `canonicalArtist`,
`isVariousArtists`) et son sidecar à misses expirantes (`src/streaming-links.ts:41-42,200-205`) ;
(c) le lien « Écouter sur Apple Music » que la licence exige à côté de l'extrait existe déjà dans la barre
Now ; (d) les fichiers sont des AAC `.m4a` servis en HTTPS sur `audio-ssl.itunes.apple.com`, lisibles par
`AVPlayer` sans DRM.

Conditions retenues, traduites en exigences du plan : extrait joué **seulement dans le lecteur du nœud
dont il est l'extrait** (i, v) ; **ligne d'attribution « avec l'aimable autorisation d'iTunes » et lien
vers la page Apple Music du morceau**, à côté du bouton Apple Music de la barre Now (ii, iii, § 5.2.5) ;
**streaming seul**, aucune écriture sur disque, garde automatisée (iv) ; pas d'autre usage (vi).

La résolution est faite **par le serveur**, jamais par l'app : la limite d'appels d'Apple est par IP, le
serveur la lisse par son sidecar ; l'app ne connaît qu'une URL déjà vérifiée ; et l'hôte iTunes n'entre
pas dans l'app (pas d'ATS à ouvrir, pas de parsing de réponse tierce sur l'appareil).

*Alternatives rejetées :* **Apple Music API / MusicKit** (`previews[].url`) — mêmes fichiers, mais
exige l'Apple Developer Program, une clé MusicKit `.p8`, un JWT ES256 signé côté serveur (secret = tier/3,
rotation à 6 mois), et ses conditions pour un usage sans abonnement ne sont pas vérifiables (forums sans
réponse). C'est la voie de secours si Apple contestait l'usage de la Search API : même URL d'extrait,
seul le résolveur change. **Deezer** (`preview`) — conditions non vérifiables, troisième fournisseur,
aucun lien Deezer dans l'app pour satisfaire l'attribution. **Spotify** — `preview_url` retiré aux
nouvelles apps. **YouTube** (`src/youtube.ts`, sidecar `cache/youtube/`) — l'audio sans la vidéo ni le
lecteur YouTube viole ses conditions. **Extraits auto-hébergés** — la « courte citation » française ne
couvre pas le phonogramme ; il faudrait des licences SACEM/SCPP.

### D2 — Transport : champ additif `preview` dans `/links` et dans le sidecar `cache/links/` ; aucun champ de nœud

Le sidecar `StreamingLinks` (`src/streaming-links.ts:69-75`) gagne `preview?: PreviewLink | PreviewMiss`
(absent = jamais tenté, `{ url: null, resolved_at }` = miss réessayé après `MISS_TTL_MS`, objet = trouvé).
La route `/mobile/v1/nodes/:slug/links` renvoie `preview: { url, apple_url, track_name, source } | null`,
toujours présent, revalidé à la sortie (`src/mobile/media.ts`), hôte compris. Les sidecars existants
(liens résolus avant ce plan) n'ont pas la clé : la prochaine lecture résout **seulement** l'extrait et
réécrit le sidecar sans toucher aux liens — migration paresseuse, zéro script.

*Alternatives rejetées :* un champ de nœud `preview_url` dans `cache/nodes/**` — impose `types.ts`,
`schemas.ts`, `node-spec.ts`, `graph.ts`, une migration du cache committé et un ticket `tier/3`, pour une
donnée dérivée et régénérable (c'est exactement pourquoi les liens sont un sidecar,
`src/streaming-links.ts:5-8`) ; une route `/preview` séparée — un aller-retour réseau de plus à l'ouverture
du lecteur, alors que `/links` porte déjà la réponse iTunes dont l'extrait sort ; un proxy audio
`/mobile/v1/nodes/:slug/preview.m4a` — notre bande passante, et une mise en cache côté serveur que la
condition (iv) interdit.

### D3 — Quel extrait, par type : le morceau lui-même, une piste notable de l'album (sinon la piste 1), le premier titre iTunes de l'artiste ; rien pour genre et label

- **track** : le `previewUrl` du candidat `song` déjà retenu pour le lien Apple (`resolveApple("song")`,
  même réponse HTTP, zéro appel de plus). `apple_url` = ce lien.
- **project** (décision de Raphael, Q2) : une **piste notable de l'album**. Le candidat `album` retenu donne
  un `collectionId` ; `/lookup?id=<collectionId>&entity=song` liste ses pistes (un appel iTunes de plus, une
  fois, sidecar). Côté graphe, les pistes notables de l'album sont, **dans cet ordre** : le `reference_track`
  du premier artiste crédité (`edges.artists[0]`), puis ses `notable_tracks` dans l'ordre de la liste
  (`src/node-spec.ts:34-39` : le `reference_track` est « the reference track, chosen among discography /
  notable_tracks », TRA-457 — c'est la plus notable des notables), **restreintes aux pistes qui sont dans la
  `tracklist` de l'album** (même slug, `src/node-spec.ts:50`). La piste retenue est la première de cette
  liste dont le titre, canonisé (`canonicalName`, même pliage que `canonicalArtist`), est **égal** au titre
  d'une piste iTunes de l'album qui a un `previewUrl`. **Repli** : pas d'artiste crédité, artiste absent du
  cache, pas de `tracklist`, aucune notable sur l'album, aucun titre égal ou aucune notable avec extrait →
  la **première piste du premier disque** qui a un `previewUrl` (**hypothèse à confirmer, Q2b**). Le
  sidecar note quel chemin a gagné (`pick: "notable" | "first_track"`), pour l'audit. `apple_url` =
  `trackViewUrl` de la piste retenue (page de l'album, piste sélectionnée).
- **artist** : recherche `entity=song` sur le nom de l'artiste ; premier résultat dont le crédit, canonisé
  (`canonicalArtist`, `src/itunes.ts:215-224`), est **exactement** le nom de l'artiste et qui a un
  `previewUrl`. L'ordre d'iTunes tient lieu de « titre le plus connu ». `apple_url` = `trackViewUrl` du
  morceau (pas la page artiste : § 5.2.5 veut le lien vers « the corresponding music »).
- **genre, label** : `preview: null`, sans appel (comme `LINKABLE_TYPES`).

Un mauvais extrait est pire que pas d'extrait (le principe de `lookupVerifiedAlbumArt`,
`src/itunes.ts:247-250`) : en l'absence de correspondance vérifiée, miss.

*Alternatives rejetées :* pour un album, la piste 1 par défaut — proposition initiale du plan, écartée par
Raphael (une piste notable dit mieux pourquoi l'album compte ; la piste 1 ne reste que le repli) ; la piste
la plus connue selon iTunes — iTunes ne donne pas de popularité par piste ; l'ordre de la `tracklist`
parmi les notables (la plus tôt sur le disque) — l'ordre éditorial `reference_track` puis `notable_tracks`
porte un signal, l'ordre du disque n'en porte pas ; chercher les notables par l'arête `project` de chaque
nœud `track` au lieu de la `tracklist` de l'album — une lecture de cache par piste notable, alors que la
`tracklist` est déjà sur l'album ; pour un artiste, la piste 1 du premier projet de sa `discography` —
deux appels, et la discographie du cache n'est pas ordonnée par notoriété ; pour un genre, le
`landmark_tracks[0]` — pas de barre Now pour porter l'attribution, brief séparé (Q3).

### D4 — Lecture : `AVPlayer` en streaming, session `.ambient`, lecture automatique sauf si une autre app joue, pause par la pochette, arrêt dès que le lecteur disparaît

- Catégorie `AVAudioSession.Category.ambient` : l'extrait **respecte le commutateur silencieux** et **ne
  coupe jamais l'audio d'une autre app** (il se mélange). C'est la catégorie d'Apple pour un son
  secondaire à l'activité principale — ici, lire.
- **Lecture automatique** à l'ouverture du lecteur dès que l'extrait est prêt, **sauf** si
  `AVAudioSession.isOtherAudioPlaying` est vrai au départ : alors l'extrait attend en pause et la pochette
  montre « lecture ». Un appui joue quand même (le choix de l'utilisateur). La lecture automatique est une
  **décision de risque de Raphael** (2026-11-28, Q4), pris en connaissance de la condition « entertainment
  value » ; le kill switch serveur `ODYSSEY_PREVIEWS` (ticket 1.4) permet de couper tous les extraits sans
  livrer l'app.
- **Un seul contrôle** : la pochette de la barre Now devient un bouton lecture / pause, avec un glyphe
  superposé (`play.fill` existant, `pause.fill` à ajouter à `Track1Icon.Glyph`). Pas de barre de
  progression, pas de volume.
- **Arrêt** (pas pause) : retour, disparition de la vue (changement d'onglet), passage de la scène hors
  `.active`. **Pause** : interruption (appel, Siri) ; pas de reprise automatique. **Fin** : l'extrait joue
  une fois ; l'état `ended` montre « lecture » pour le rejouer. Pas de boucle.
- **Échec** (URL refusée, 4xx, réseau) : silence, aucun message, la barre Now reste celle d'aujourd'hui
  (la ligne d'attribution disparaît avec l'extrait).

*Alternatives rejetées :* `.playback` — ignore le commutateur silencieux et interrompt Spotify/Apple Music
de l'utilisateur, pour 30 s ; `.soloAmbient` — interrompt les autres apps ; lecture sur action seulement —
le brief dit « se joue pendant que l'utilisateur lit » (Q4 le laisse ouvert) ; un bouton de plus dans la
pastille — la barre fait déjà 306 pt sur une colonne de 309 avec deux services ; `UIBackgroundModes:
audio` — l'extrait suivrait l'utilisateur hors du lecteur, à rebours de la condition (i) et du non-but.

### D5 — Attribution : une ligne au-dessus de la barre Now, « Extrait avec l'aimable autorisation d'iTunes » avec la marque Apple Music, qui ouvre la page du morceau

Dès que `preview` est non nul (prêt ou pas, en lecture ou pas), `PlayerReader.bottomBar` dessine, dans le
`VStack` qui porte déjà `listeningNotice` (`PlayerView.swift:297-306`), une ligne
`PlayerPreviewAttribution` : le libellé en rôle `bodySmall`, la marque `Brand/AppleMusic` (celle du bouton
de la barre, `StreamingButton.logoName`) et la flèche sortante, le tout étant un `Button` qui ouvre
`preview.appleURL` par `openURL` (comme la ligne de source). Elle est **à 8 pt au-dessus de la barre**
dont le bouton Apple Music porte déjà la marque : condition (ii) « proximate », § 5.2.5 « display a
link ». Libellé d'accessibilité : « Extrait avec l'aimable autorisation d'iTunes. Écouter <titre> sur
Apple Music ». La ligne n'entre pas dans les cadres du carrousel.

Le libellé reprend « provided courtesy of iTunes » (condition iii) en français ; Q7 demande si Raphael
préfère le texte anglais verbatim ou « Apple Music » (nom actuel du service, mais pas celui du texte
légal).

*Alternatives rejetées :* attribution dans la pastille — pas de place ; attribution seulement pendant la
lecture — la condition (iii) porte sur la présence de l'extrait, pas sur son état ; pas de lien propre
(se contenter du bouton Apple Music de la barre) — pour un artiste, ce bouton mène à la page artiste, pas
au morceau joué.

### D6 — Code : décodage, machine à états et protocole de moteur dans `Track1Core` (testés par `swift test`) ; `AVFoundation` et la vue dans l'app ; faux moteur pour les UI tests

- **Core** (`ios/Track1Core`, Foundation seulement — `test/ios-core-package.test.ts` interdit SwiftUI,
  UIKit et Segment) : `PreviewLink` décodé depuis `/links` avec validation d'hôte
  (`URLValidation.previewAssetURL`), `NodeViewModel.preview`, la machine à états `PreviewPlaybackModel`
  (`idle / loading / playing / paused / ended / failed`) et le protocole `PreviewEngine` (charger, jouer,
  pauser, arrêter, événements). Tout le comportement (autoplay conditionnel, pause sur interruption, arrêt
  sur disparition, rejouer après la fin) est prouvé en local par `swift test --package-path ios/Track1Core`
  avec un faux moteur.
- **App** : `AVPreviewEngine: PreviewEngine` (un seul fichier, `ios/Track1/Media/`, `AVFoundation`), la
  session `.ambient`, les notifications d'interruption et de fin ; `PlayerNowBar` et
  `PlayerPreviewAttribution` dessinent l'état et renvoient les gestes ; `RootView` injecte le moteur.
- **UI tests** : `UITestFixtureReaders` (simulateur seulement) fournit un `UITestPreviewEngine` qui ne
  touche ni réseau ni session audio et répond « prêt » tout de suite ; la fixture `linksBody` porte un
  `preview`. Les UI tests vérifient l'attribution, le bouton et ses états, pas le son.
- **Garde** : `test/ios-preview-streaming.test.ts` (modèle : `test/ios-no-webview.test.ts`) refuse
  `AVAssetDownloadURLSession`, `AVAssetDownloadTask`, `AVAssetExportSession`, `AVAssetWriter` dans `ios/`,
  et `UIBackgroundModes` dans `Info.plist` : la condition (iv) et le non-but « arrière-plan » deviennent
  des tests.

*Alternatives rejetées :* `AVFoundation` dans Core — disponible sur macOS, mais `docs/track1-builds.md`
réserve le package à la logique pure et un `AVPlayer` dans `swift test` est lent et non déterministe ;
intercepter `URLSession` pour les UI tests — rejeté par le plan D3 de `UITestFixtureReaders`
(« avoids intercepting `URLSession` traffic ») ; snapshot tests — pas d'outillage.

## Découpage

Trois parties, dix tickets, 23 points. Points = estimate Linear. ‖ = parallélisable avec la ligne du dessus.

| # | Tâche | Tier | Pts | Dépend de |
|---|---|---|---|---|
| 1.1 | TRA-846 · `src/itunes.ts` : lire `previewUrl`, valider son hôte, lister les pistes d'un album | tier/2 | 2 | — |
| 1.2 | TRA-847 · `src/album-preview.ts` : pistes notables d'un album (graphe) et choix de la piste iTunes | tier/2 | 2 | 1.1 |
| 1.3 | TRA-851 · `src/streaming-links.ts` : résoudre et mettre en sidecar l'extrait par type | tier/2 | 3 | 1.1, 1.2 |
| 1.4 | TRA-852 · `src/mobile/media.ts` + `src/flags.ts` + `docs/track1-api.md` : exposer `preview` dans `/links`, lire les notables, kill switch | tier/2 | 2 | 1.3 |
| 2.1 ‖ | TRA-848 · Core : `PreviewLink`, `LinksResponse.preview`, `NodeViewModel.preview` | tier/2 | 2 | — |
| 2.2 ‖ | TRA-849 · Core : `PreviewEngine` (protocole) et `PreviewPlaybackModel` (machine à états) | tier/2 | 3 | — |
| 3.0 ‖ | TRA-850 · Garde vitest « streaming seul, pas d'arrière-plan » | tier/1 | 1 | — |
| 3.1 | TRA-853 · App : `AVPreviewEngine`, faux moteur UI test, injection jusqu'à `PlayerView` | tier/2 | 3 | 2.2 |
| 3.2 | TRA-854 · App : pochette lecture/pause dans `PlayerNowBar`, ligne d'attribution, câblage dans `PlayerReader` (précondition Q11) | tier/2 | 3 | 2.1, 3.1 |
| 3.3 | TRA-855 · UI test : fixture `preview`, attribution, bascule lecture/pause | tier/1 | 2 | 3.2 |

Diffs attendus (tests compris) : 1.1 ≈ 230, 1.2 ≈ 200, 1.3 ≈ 280, 1.4 ≈ 240, 2.1 ≈ 220, 2.2 ≈ 290,
3.0 ≈ 90, 3.1 ≈ 260, 3.2 ≈ 290, 3.3 ≈ 120. Si 1.3, 2.2 ou 3.2 dépasse 300 lignes, couper le long de la
frontière indiquée dans ses notes.

Ordre d'attaque : 1.1 → 1.2 → 1.3 → 1.4 en worktree A ; 2.1 et 2.2 en worktrees B et C en parallèle ; 3.0 à
tout moment ; puis 3.1 → 3.2 → 3.3. Les parties 1 et 2 se mergent dans n'importe quel ordre.

### Partie 1 — Serveur : l'extrait sort de `/links` (déployable seule : champ additif, l'app d'aujourd'hui l'ignore)

- [ ] TRA-846 1.1 — `src/itunes.ts` : `ITunesResult` lit `previewUrl`, `collectionId`, `trackNumber`,
  `discNumber`, `wrapperType` ; `isAllowedPreviewUrl` ; `AppleCandidate.previewUrl` / `collectionId` ;
  `lookupAlbumSongs(collectionId)` ; `canonicalName` exporté ; tests `test/itunes.test.ts` et un
  `test/itunes-preview.live.test.ts` (hors `npm run test`).
- [ ] TRA-847 1.2 — `src/album-preview.ts` (nouveau, pur) : `notableTrackTitles(project, artist)` (D3 :
  `reference_track` puis `notable_tracks`, restreints à la `tracklist`) et `pickAlbumSong(songs, titles)`
  (notable par égalité canonique, sinon piste 1 disque 1) ; tests `test/album-preview.test.ts`.
- [ ] TRA-851 1.3 — `src/streaming-links.ts` : `PreviewLink` / `PreviewMiss` dans `StreamingLinks`,
  `ResolveLinksInput.notableTrackTitles` / `previews`, `resolvePreview` par type (D3), résolution
  paresseuse des sidecars sans clé, miss expirante ; tests `test/streaming-links.test.ts`.
- [ ] TRA-852 1.4 — `src/mobile/media.ts` : `MobileLinksResponse.preview`, lecture du nœud artiste pour les
  titres notables, revalidation d'hôte à la sortie, kill switch `previewsEnabled()` (`src/flags.ts`) ;
  `src/server.ts` (commentaire de route) ; `docs/track1-api.md` (section « Liens d'écoute et extrait ») ;
  tests `test/mobile/media.test.ts`.

### Partie 2 — Core iOS : l'app comprend l'extrait et sait le piloter (déployable seule : rien de visible)

- [ ] TRA-848 2.1 — `APIModels.swift` : `PreviewLink`, `LinksResponse.preview` (additif, hôte validé par
  `URLValidation.previewAssetURL`) ; `NodeViewModel.preview` ; tests `ListeningTests`,
  `NodeListeningTests`, `NodeViewModelTests`.
- [ ] TRA-849 2.2 — `ios/Track1Core/Sources/Track1Core/Listening/PreviewPlayback.swift` : `PreviewEngine`,
  `PreviewEngineEvent`, `PreviewPlaybackState`, `PreviewPlaybackModel`, `PreviewLink.attributionLabel` ;
  tests `PreviewPlaybackTests` avec un faux moteur.

### Partie 3 — App iOS : l'extrait se joue dans le lecteur (déployable à partir de 3.2)

- [ ] TRA-850 3.0 — `test/ios-preview-streaming.test.ts` : garde contre le téléchargement d'assets et le
  mode arrière-plan.
- [ ] TRA-853 3.1 — `ios/Track1/Media/AVPreviewEngine.swift` (+ pbxproj), `UITestPreviewEngine` dans
  `UITestFixtureReaders.swift`, `AppContainer.makePreviewEngine`, `RootView` → `PlayerDestination` →
  `PlayerView(previewEngine:)` ; `ios/Track1Tests/Media/AVPreviewEngineTests.swift` (+ pbxproj).
- [ ] TRA-854 3.2 — `Track1Icon.Glyph.pause` ; `PlayerNowBar` : pochette bouton lecture/pause avec glyphe ;
  `PlayerPreviewAttribution` et `PlayerMetrics.preview*` dans `PlayerView.swift` ; `PlayerReader` crée et
  pilote `PreviewPlaybackModel` ; tests `Track1IconTests`, `PlayerNowBarTests`, `PlayerViewTests`.
- [ ] TRA-855 3.3 — `UITestFlows.linksBody` porte un `preview` ; `TodayFlowTests` : attribution lue, bascule
  lecture → pause → lecture, capture `3.3-preview`.

## Risques

- **Apple conteste l'usage (relecture App Store ou retrait).** Garde-fous : l'extrait n'est joué que sur la
  page du nœud, attribution + lien vers le morceau toujours affichés, streaming seul garanti par la garde
  3.0, pas de mode arrière-plan. Plan B sans changement d'app : résoudre la même URL par l'Apple Music API
  (D1), le contrat `/links` ne bouge pas. Plan C : `preview: null` partout en désactivant le résolveur
  (`previewsEnabled()` dans `src/flags.ts`, variable `ODYSSEY_PREVIEWS=0`, lue à chaque appel comme
  `onDemandImagesEnabled`, `src/flags.ts:45-48` ; ticket 1.4) — `/links` répond `preview: null` et l'app
  retombe sur la barre Now d'aujourd'hui, sans livraison App Store.
- **Lecture automatique perçue comme intrusive ou comme « entertainment value ».** Décision de risque prise
  par Raphael le 2026-11-28 (Q4), informé de la condition (v) et du § 5.2.5. Garde-fous : le son est
  `.ambient` (silencieux respecté), ne démarre pas par-dessus une autre app, s'arrête au retour, dure 30 s,
  et porte sur l'œuvre lue ; le kill switch ci-dessus coupe tout en une variable d'environnement ; passer
  en « lecture sur appui » est un changement d'une ligne (`autoplay: false` dans `PreviewPlaybackModel`).
- **La piste notable dépend du graphe, le sidecar n'expire pas.** Si `notable_tracks` ou `tracklist`
  changent après la première résolution, l'album garde son extrait d'avant (`pick` dans le sidecar dit
  lequel). `invalidateSidecar` existe (`src/streaming-links.ts:230-232`) ; le brancher sur les écritures
  de nœud (`invalidateCacheIndex`, `src/server.ts:105-111`) est un ticket `tier/1` si le cas se présente.
  Un album sans `tracklist` dans le cache tombe sur la piste 1 : accepté et noté dans `pick`.
- **Limite d'appels iTunes (~20/min par IP, non vérifié).** La résolution est déjà JIT et mise en sidecar ;
  un album coûte un `lookup` de plus, une fois. Un 429 est un miss réessayé après 7 jours
  (`MISS_TTL_MS`), jamais une erreur côté app. Pas de backfill en masse dans ce plan.
- **URL d'extrait périmée (Apple ré-encode ses assets).** Les hits du sidecar n'expirent pas. L'app
  traite un échec de lecture comme « pas d'extrait » (silence, pas de message). Si ça devient fréquent :
  ticket `tier/1` pour expirer les hits de `preview` à 30 jours.
- **Mauvais extrait (homonyme, reprise).** Mêmes règles d'égalité canonique que les pochettes ; pour un
  artiste, crédit exact exigé, « Various Artists » refusé. Reste le cas « bon artiste, mauvais morceau »
  pour un album dont la piste 1 d'iTunes n'est pas celle du pressage original : accepté (c'est l'album).
- **Session audio et autres apps.** `.ambient` + `isOtherAudioPlaying` lus au démarrage seulement : si
  l'utilisateur lance Spotify pendant l'extrait, les deux se mélangent 30 s au plus. Accepté.
- **Swift 6 et `AVPlayer`.** Les notifications (`AVPlayerItem.didPlayToEndTimeNotification`,
  `AVAudioSession.interruptionNotification`) et le KVO sur `status` arrivent hors acteur principal ; le
  moteur est `@MainActor` et saute sur `MainActor` avant d'émettre. `docs/track1-builds.md:159-160` :
  ces erreurs d'isolation n'apparaissent que dans `ios-check`.
- **`ios-check` ignore les PR en brouillon et n'est pas un check requis** (`.github/workflows/ios-ci.yml:55`).
  Chaque PR iOS passe en « ready » et attend son vert avant de demander le merge.
- **Le `project.pbxproj` liste les fichiers à la main.** 3.1 ajoute deux fichiers à l'app ; les
  identifiants suivent la convention `F1…` (fileRef) / `B1…` (buildFile) des groupes `Media`
  (`project.pbxproj:327-328`). Tout autre fichier nouveau va dans le package.
- **Sidecars existants.** La résolution paresseuse réécrit chaque sidecar touché une fois (liens
  conservés). Un sidecar tronqué à la main est déjà toléré par `readSidecar` ; `preview` suit la même
  tolérance (clé absente → jamais tenté).

## Critères de sortie

- Sur un morceau du cache présent sur Apple Music, `GET /mobile/v1/nodes/track:…/links` renvoie
  `preview.url` sur un sous-domaine strict de `itunes.apple.com` ou `mzstatic.com`, `preview.apple_url` sur
  `music.apple.com`, `preview.track_name` non vide ; sur un album, l'extrait d'une piste notable de l'album
  (`reference_track`, puis `notable_tracks` de l'artiste, dans la `tracklist`), et seulement à défaut sa
  piste 1 ; sur un artiste, un morceau crédité exactement à lui ; sur un genre ou un label,
  `preview: null` ; avec `ODYSSEY_PREVIEWS=0`, `preview: null` partout sans appel iTunes. Deux lectures
  consécutives ne font qu'une résolution.
- Dans le lecteur iOS, sur un nœud avec extrait : l'extrait démarre seul (sauf autre audio en cours), la
  pochette montre « pause » puis « lecture » à l'appui, la ligne « Extrait avec l'aimable autorisation
  d'iTunes · Apple Music » est visible au-dessus de la barre Now et ouvre la page du morceau ; le retour
  arrête le son ; le commutateur silencieux le coupe ; un appel le met en pause.
- Sans extrait (`null`, échec réseau, URL refusée) : le lecteur est exactement celui d'aujourd'hui.
- `npm run check` vert ; `swift test --package-path ios/Track1Core` vert ; `ios-check` vert avec
  `Track1Tests` et toute la suite UI, dont le nouveau test et sa capture.
- `test/ios-preview-streaming.test.ts` passe et échoue bien si l'on introduit `AVAssetDownloadTask` ou
  `UIBackgroundModes`.
- Raphael a lu les conditions non vérifiées (Performance Partners, Identity Guidelines) avant le merge de
  3.2 (Q11, précondition du ticket) ; le plan est sur `main` avec les identifiants des tickets.

## Questions du gate (tranchées le 2026-11-28, sauf Q2b et Q11)

- **Q1 — Source.** Tranché : iTunes Search API sans clé (D1) ; Apple Music API / MusicKit reste le plan B
  documenté (même contrat `/links`).
- **Q2 — Extrait d'un album.** Tranché par Raphael : **une piste notable de l'album**, pas la piste 1.
  Règle complète en D3 : `reference_track` de l'artiste puis ses `notable_tracks` dans l'ordre, restreints
  à la `tracklist` de l'album, premier titre égal (canonisé) à une piste iTunes qui a un extrait.
- **Q2b — Repli quand aucune piste de l'album n'est notable, ou qu'aucune notable n'a d'extrait : la
  piste 1 du disque 1.** **Hypothèse non tranchée**, supposée par Raphael ; elle est codée comme telle
  (`pick: "first_track"`) et se remplace par « pas d'extrait » (`null`) en une ligne dans `pickAlbumSong`
  si Raphael préfère le silence à une piste quelconque.
- **Q3 — Artiste / genre / label.** Tranché : artiste = son premier titre iTunes crédité exactement ; genre
  et label = rien (le `landmark_tracks[0]` d'un genre serait un brief séparé).
- **Q4 — Lecture automatique.** Tranché : oui, à l'ouverture (D4). Décision de risque assumée par Raphael
  vis-à-vis de « entertainment value » ; kill switch serveur conservé.
- **Q5 — Session audio.** Tranché : `.ambient`, pas de démarrage automatique si une autre app joue (D4).
- **Q6 — Une seule lecture, pas de boucle, pas de fondu.** Tranché : oui.
- **Q7 — Libellé d'attribution.** Tranché : « Extrait avec l'aimable autorisation d'iTunes » (D5), en
  français.
- **Q8 — Contrôle.** Tranché : la pochette de la barre Now avec glyphe superposé ; mesures fixées par 3.2.
- **Q9 — Analytics.** Tranché : aucun événement nouveau (non-but).
- **Q10 — Tier du champ additif de `/links`.** Tranché : tier/2 (ticket 1.4).
- **Q11 — Conditions non vérifiées. Ouverte.** Les pages Performance Partners (« Search API » et ses
  T&C) et les Apple Music Identity Guidelines sont injoignables depuis la session de planification ;
  Raphael les lit **avant le merge de 3.2**, qui le porte en précondition (case non cochée dans ses
  critères, comme le veut `tiers.md` pour une étape de procédure). Si elles exigent un badge graphique
  précis ou un libellé verbatim, un ticket `tier/1` remplace la ligne d'attribution.

## Tickets (brouillons, format `ticket-template.md`)

### 1.1 — Lire `previewUrl` dans les réponses iTunes et lister les pistes d'un album

- Tier : **tier/2** · Estimate : **2** · Partie 1 · Dépend de : —

```markdown
## Contexte
Le lecteur iOS va jouer un extrait de 30 s du morceau dont on lit la description (plan
docs/plans/player-audio-preview.md, D1, D3). L'iTunes Search API renvoie déjà cet extrait dans le champ
`previewUrl` des résultats `song`, que `src/itunes.ts` ne lit pas. Cette tâche apprend au wrapper à lire
et valider ce champ, et à lister les pistes d'un album par `/lookup`, sans rien changer aux appelants.

## Portée
Fichiers à modifier (lignes de `origin/main` au 2026-11-28, `e86f046`) :
- `src/itunes.ts` — `ITunesResult` (l.25-36) : ajouter `previewUrl?`, `collectionId?` (déjà là),
  `trackNumber?`, `discNumber?`, `wrapperType?` ; `AppleCandidate` (l.46-54) : ajouter `previewUrl?: string`
  (seulement `song`, seulement si `isAllowedPreviewUrl`) et `collectionId?: number` (`album` et `song`) ;
  `toCandidate` (l.110-128) les remplit ; nouveau `isAllowedPreviewUrl` à côté de `toHighResArtwork`
  (l.326-337), sur le modèle de `isAllowedImageUrl` (`src/images/hosts.ts:26-45`) ; nouveau
  `lookupAlbumSongs` ; le pliage de `canonicalArtist` (l.215-224) devient `export function canonicalName`,
  `canonicalArtist` n'étant plus qu'un alias interne (1.2 et 1.3 l'appliquent aussi à des titres).
- `test/itunes.test.ts` — cas ci-dessous, avec un `fetchImpl` injecté comme les tests existants.
Fichier à créer :
- `test/itunes-preview.live.test.ts` — tape la vraie API (exclu de `npm run test` par le motif
  `*.live.test.ts`) : « Windowlicker » Aphex Twin en `song` a un `previewUrl` accepté ; `lookupAlbumSongs`
  sur son `collectionId` rend des pistes triées. Sert à vérifier les hôtes réels le jour J.
Hors-scope explicite :
- `src/streaming-links.ts`, `src/album-preview.ts`, `src/mobile/**`, le sidecar (tickets 1.2 à 1.4).
- `lookupVerifiedAlbumArt` et la logique pochette : inchangés.
- Aucun nouveau paquet.

## Contrat
    export const PREVIEW_HOST_SUFFIXES: readonly string[]  // [".itunes.apple.com", ".mzstatic.com"]
    /** https, canonical href, no credentials/port, hostname a STRICT subdomain of a PREVIEW_HOST_SUFFIXES entry. */
    export function isAllowedPreviewUrl(raw: string): boolean
    export interface AppleCandidate {
      url: string; id: number; title: string; artistName?: string;
      /** 30-second preview, song entity only, already accepted by isAllowedPreviewUrl. */
      previewUrl?: string;
      /** iTunes collection id, album and song entities. */
      collectionId?: number;
    }
    export interface AppleAlbumSong {
      trackId: number; trackName: string;
      /** music.apple.com song page (trackViewUrl through cleanAppleUrl). */
      url: string;
      discNumber: number; trackNumber: number;
      /** Accepted by isAllowedPreviewUrl. Songs without one are not listed. */
      previewUrl: string;
    }
    /** GET /lookup?id=<collectionId>&entity=song ; songs only (wrapperType "track"), sorted by disc then track;
     *  [] on HTTP error, malformed body, timeout. Zod-checked like albumSearchResponseSchema. */
    export async function lookupAlbumSongs(collectionId: number, fetchImpl?: typeof fetch): Promise<AppleAlbumSong[]>
    /** Accents, case, punctuation and `&`/`and` folded, nothing else: the folding canonicalArtist applied. */
    export function canonicalName(raw: string): string

## Critères d'acceptation
- [ ] `isAllowedPreviewUrl("https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview1/v4/a/b/c.m4a")` → true ;
      `"https://a1.mzstatic.com/x.m4a"` → true ; `"https://itunes.apple.com/x.m4a"` (domaine nu) → false ;
      `"http://audio-ssl.itunes.apple.com/x"` → false ; `"https://audio-ssl.itunes.apple.com.evil.example/x"` → false ;
      `"https://user@audio-ssl.itunes.apple.com/x"` → false ; `"https://audio-ssl.itunes.apple.com:8443/x"` → false ;
      `"https://AUDIO-SSL.itunes.apple.com/x"` (href non canonique) → false.
- [ ] `searchAppleEntities("song", …)` : un résultat avec `previewUrl` acceptable rend un candidat avec
      `previewUrl` et `collectionId` ; un `previewUrl` refusé rend le candidat SANS `previewUrl` (le lien
      Apple reste) ; un résultat `album` n'a jamais `previewUrl` mais a `collectionId`.
- [ ] `lookupAlbumSongs(281953326, fetchImpl)` sur une réponse fixture `{collection, track(d1 t2), track(d1 t1),
      track(d2 t1, sans previewUrl)}` rend `[d1 t1, d1 t2]` ; une réponse `{"results": "nope"}` → `[]` ;
      HTTP 500 → `[]` ; `fetch` qui rejette → `[]` ; l'URL demandée est exactement
      `https://itunes.apple.com/lookup?id=281953326&entity=song`.
- [ ] `canonicalName("Windowlicker")`, `canonicalName("WINDOWLICKER ")` et `canonicalName("Window-licker")`
      sont égaux ; `canonicalName("Rock & Roll") === canonicalName("Rock and Roll")` ; `canonicalName("Vol. 2")`
      ≠ `canonicalName("Vol. 3")` (test de l'export ; le comportement de `canonicalArtist` ne change pas).
- [ ] `npm run check` vert ; `test/itunes-preview.live.test.ts` passe en local avec réseau (non exigé en CI).

## Tests attendus
- unitaire (`test/itunes.test.ts`) : les cas ci-dessus ; un `previewUrl` en `http://` est écarté et le
  candidat conservé ; `wrapperType: "collection"` est ignoré par `lookupAlbumSongs`.
- live (`test/itunes-preview.live.test.ts`) : hôte réel du `previewUrl`, tri du `lookup`.

## Tier de risque
tier/2 — parsing et validation d'une donnée tierce qui finira dans un lecteur audio ; aucune écriture,
aucun appelant modifié.

## Notes d'implémentation
- Conventions du fichier : Zod `safeParse` sur un `z.array(z.unknown())` puis par résultat
  (`albumSearchResultSchema`, l.130-136) ; `AbortController` à `REQUEST_TIMEOUT_MS` (l.23) ; `[]`/`null`
  sur toute erreur, jamais de throw.
- `isAllowedPreviewUrl` exige `parsed.href === raw` comme `isAllowedImageUrl` : ce qu'on a vérifié est
  exactement ce que l'appareil demandera.
- `cleanAppleUrl` (l.66-75) garde le paramètre `i` : c'est lui qui fait d'une URL d'album une URL de
  morceau. Ne pas le retirer.
- Commentaires en anglais, qui disent pourquoi (`src/` convention) ; citer le plan (D1, D3).
- Commits conventionnels, `Refs TRA-<id>` ; PR titrée `TRA-<id> …`, `Fixes TRA-<id>`.
```

### 1.2 — Choisir la piste notable d'un album : titres notables depuis le graphe, piste iTunes par égalité canonique

- Tier : **tier/2** · Estimate : **2** · Partie 1 · Dépend de : 1.1

```markdown
## Contexte
Raphael a tranché (plan docs/plans/player-audio-preview.md, « Décisions de Raphael », D3) : l'extrait d'un
album n'est pas sa piste 1 mais une piste « déjà notable » — une piste de l'album que le graphe désigne
comme notable chez son artiste. Cette tâche écrit la règle, pure et testée, en deux fonctions : d'un côté
les titres notables d'un album lus dans les arêtes du cache, de l'autre le choix de la piste iTunes qui
porte l'extrait. Le repli « piste 1 » est une hypothèse de Raphael à confirmer (Q2b) : il est codé, nommé,
et remplaçable en une ligne.

## Portée
Fichiers à créer :
- `src/album-preview.ts` — pur : aucun I/O, aucun `fetch`, aucun accès cache. Importe `canonicalName` de
  `./itunes.js` (1.1) et les types `EdgeRef` (`src/types.ts:25-35`) et `VizNode` (`src/graph.ts:41-56`).
- `test/album-preview.test.ts`.
Hors-scope explicite :
- `src/streaming-links.ts` (1.3 appelle `pickAlbumSong`), `src/mobile/media.ts` (1.4 appelle
  `notableTrackTitles`), `src/itunes.ts`, `src/node-spec.ts`, `src/graph.ts`, le schéma.
- Aucune lecture de nœud `track` : l'appartenance à l'album se lit dans la `tracklist` du projet.

## Contrat
    /** Edge fields read: project.edges.tracklist (list, src/node-spec.ts:50), artist.edges.reference_track (single,
     *  l.39) and artist.edges.notable_tracks (list, l.37). `edges` values are EdgeRef | EdgeRef[] (src/graph.ts:48). */
    export function notableTrackTitles(
      project: Pick<VizNode, "edges">,
      artist: Pick<VizNode, "edges"> | null,
    ): string[]
    // Order: reference_track first (if its slug is in the tracklist), then notable_tracks in list order, slugs
    // deduplicated, each title taken from the TRACKLIST edge (the album's spelling). [] when artist is null, when the
    // project has no tracklist, or when no notable track is on the album.
    export interface AlbumSongLike { trackName: string; discNumber: number; trackNumber: number; previewUrl: string }
    export type AlbumPick = "notable" | "first_track"
    /** First notable title (in order) whose canonicalName equals the canonicalName of a song's trackName → that song,
     *  "notable". Otherwise the song with the lowest (discNumber, trackNumber) → "first_track" (hypothesis Q2b: one
     *  return statement to change). null when `songs` is empty. `songs` are the lookupAlbumSongs results, which already
     *  all carry a previewUrl. */
    export function pickAlbumSong<S extends AlbumSongLike>(songs: readonly S[], notableTitles: readonly string[]): { song: S; pick: AlbumPick } | null

## Critères d'acceptation
- [ ] `notableTrackTitles` : artiste avec `reference_track` = T2 et `notable_tracks` = [T3, T1, T9], album dont la
      `tracklist` = [T1, T2, T3] → `["<nom T2 dans la tracklist>", "<nom T3>", "<nom T1>"]` (T9 absent : hors
      album) ; `reference_track` absent → ordre de `notable_tracks` ; `reference_track` aussi dans
      `notable_tracks` → une seule fois, en tête ; `artist === null` → `[]` ; projet sans `tracklist` → `[]` ;
      `tracklist` donnée comme un seul `EdgeRef` (objet, pas liste) → traitée comme une liste de un ;
      `notable_tracks` absent et `reference_track` absent → `[]`.
- [ ] `pickAlbumSong([d1t1 "Intro", d1t2 "Windowlicker", d2t1 "Nannou"], ["Nannou", "Windowlicker"])` → d2t1,
      `"notable"` (l'ordre des notables gagne, pas celui du disque) ; `(…, ["WINDOWLICKER"])` → d1t2 (égalité
      canonique) ; `(…, ["Window Licker"])` → d1t2 (ponctuation et espaces pliés) ; `(…, ["Windowlicker (Remix)"])`
      → `first_track` (pas d'égalité : un titre plus long est un autre titre) ; `(…, [])` → d1t1, `"first_track"` ;
      `([d2t1, d1t2, d1t1], [])` → d1t1 (tri, pas premier élément) ; `([], ["x"])` → null.
- [ ] Aucun import autre que `./itunes.js`, `./types.js`, `./graph.js` ; aucune fonction asynchrone.
- [ ] `npm run check` vert.

## Tests attendus
- unitaire (`test/album-preview.test.ts`) : les cas ci-dessus, avec des `EdgeRef` minimaux (`slug`, `type`, `name`).

## Tier de risque
tier/2 — logique métier locale, pure, entièrement couverte ; décide quel extrait est joué (un mauvais choix est
une mauvaise expérience, pas un incident).

## Notes d'implémentation
- La `tracklist` est la source du titre comparé : c'est l'orthographe de l'album, celle que l'iTunes `lookup`
  a le plus de chances de reproduire. `canonicalName` plie accents, casse, ponctuation et `&`/`and`, rien de
  plus : « Windowlicker (Remix) » ne vaut pas « Windowlicker » (même règle d'égalité que les pochettes, TRA-589).
- Le repli `first_track` est l'hypothèse Q2b : un commentaire en anglais le dit, avec la date et le lien du plan,
  pour qu'un futur ticket le change en `null` sans archéologie.
- Commentaires en anglais ; commits conventionnels `Refs TRA-<id>` ; PR `TRA-<id> …`, `Fixes TRA-<id>`.
```

### 1.3 — Résoudre l'extrait d'un morceau, d'un album ou d'un artiste et le garder dans le sidecar `cache/links/`

- Tier : **tier/2** · Estimate : **3** · Partie 1 · Dépend de : 1.1, 1.2

```markdown
## Contexte
`resolveStreamingLinks` (`src/streaming-links.ts`) trouve la page Apple Music d'un nœud et met le résultat
en sidecar. Le lecteur iOS a besoin, pour le même nœud, de l'URL d'un extrait de 30 s (plan
docs/plans/player-audio-preview.md, D2, D3) : le morceau lui-même, une piste notable de l'album (règle
`pickAlbumSong` du ticket 1.2, piste 1 en repli), ou le premier titre iTunes crédité exactement à
l'artiste. Les titres notables viennent de l'appelant (1.4 lit le graphe) : ce module ne lit que le réseau
et son sidecar. Les sidecars déjà écrits n'ont pas la clé : ils sont complétés paresseusement à la lecture
suivante. Un drapeau `previews: false` (kill switch, 1.4) saute toute résolution d'extrait.

## Portée
Fichiers à modifier (lignes de `origin/main` au 2026-11-28, `e86f046`) :
- `src/streaming-links.ts` — `StreamingLinks` (l.69-75) : `preview?: PreviewLink | PreviewMiss` ;
  `resolveApple` (l.106-126) rend le candidat (`AppleCandidate`) et plus seulement l'URL, pour garder
  `previewUrl`, `collectionId`, `title` ; `resolveStreamingLinks` (l.139-190) : après les liens, appelle
  `resolvePreview` quand `needsPreviewResolution` ; sur un sidecar en cache (l.143-146), si les liens sont
  frais mais `needsPreviewResolution` est vrai, ne résout QUE l'extrait et réécrit ; `isStaleMiss`
  (l.200-205) inchangé ; `readSidecar` (l.207-222) tolère `preview` absent / malformé (→ absent) ;
  en-tête du fichier (l.1-27) : documenter la provenance de l'extrait par type.
- `test/streaming-links.test.ts` — cas ci-dessous ; `searchAppleEntities` et `lookupAlbumSongs` sont des
  frontières externes : injecter par un paramètre `deps` optionnel de `resolveStreamingLinks` (voir Contrat),
  le défaut étant les vraies fonctions.
Hors-scope explicite :
- `src/itunes.ts` (1.1) et `src/album-preview.ts` (1.2) : appelés, pas modifiés ; `src/mobile/**` (1.4),
  `cache/nodes/**`, le schéma.
- La résolution Spotify et MusicBrainz : inchangée.
- Pas de backfill en masse ni de script.

## Contrat
    export interface PreviewLink {
      /** Accepted by isAllowedPreviewUrl at resolution time; re-checked on every way out. */
      url: string;
      /** music.apple.com page of the previewed song (the one the licence asks to link to). */
      apple_url: string;
      track_name: string;
      source: "itunes";
      /** Which rule picked it (audit only, never served): the song itself, a notable track of the album, the
       *  first-track fallback (Q2b), or iTunes' top song of the artist. */
      pick: "song" | "notable" | "first_track" | "artist_top";
      resolved_at: string;   // ISO
    }
    export interface PreviewMiss { url: null; resolved_at: string }
    export interface StreamingLinks {
      spotify: string | null; apple: string | null; sources: {…}; resolvedAt: string;
      /** Absent: never attempted (sidecar written before previews existed). */
      preview?: PreviewLink | PreviewMiss;
    }
    export const PREVIEWABLE_TYPES: ReadonlySet<string>   // same members as LINKABLE_TYPES
    /** true when `preview` is absent, or a miss older than MISS_TTL_MS. A hit never expires. */
    export function needsPreviewResolution(cached: StreamingLinks, now?: number): boolean
    export interface StreamingLinksDeps {
      searchAppleEntities: typeof searchAppleEntities;
      lookupAlbumSongs: typeof lookupAlbumSongs;
      findArtistMbidByName: typeof findArtistMbidByName;
      fetchArtistStreamingLinksMb: typeof fetchArtistStreamingLinksMb;
    }
    export interface ResolveLinksInput {
      slug: Slug; type: NodeType; name: string; artistName?: string; cacheDir: string; force?: boolean;   // existing
      /** Projects only: notableTrackTitles(project, artist) from src/album-preview.ts, computed by the caller (1.4). */
      notableTrackTitles?: string[];
      /** false: resolve links only, never touch `preview` (kill switch, flags.previewsEnabled). Default true. */
      previews?: boolean;
    }
    export async function resolveStreamingLinks(input: ResolveLinksInput, deps?: Partial<StreamingLinksDeps>): Promise<StreamingLinks>
    /** D3: track → previewUrl of the song candidate kept for `apple` ("song"); project →
     *  pickAlbumSong(await lookupAlbumSongs(candidate.collectionId), input.notableTrackTitles ?? []) ("notable" |
     *  "first_track"); artist → first `song` search result whose canonicalName(artistName) === canonicalName(name),
     *  not Various Artists, with a preview ("artist_top"). null = miss. */
    export async function resolvePreview(input: ResolveLinksInput, appleCandidate: AppleCandidate | null, deps: StreamingLinksDeps): Promise<PreviewLink | null>

## Critères d'acceptation
- [ ] track avec candidat `song` porteur de `previewUrl` → `preview.url` = ce `previewUrl`, `apple_url` =
      `links.apple`, `track_name` = `candidate.title`, `source: "itunes"` ; une seule recherche iTunes.
- [ ] project : candidat `album` (`collectionId: 42`) → `lookupAlbumSongs(42)` appelé une fois ; avec
      `notableTrackTitles: ["Nannou"]` et des pistes `[d1 t1 "Intro", d1 t2 "Nannou"]` → `preview` = d1 t2,
      `pick: "notable"`, `track_name: "Nannou"`, `apple_url` = l'URL de cette piste ; avec
      `notableTrackTitles: []` ou absent → d1 t1, `pick: "first_track"` ; `lookupAlbumSongs` → `[]` →
      `preview: { url: null, … }` ; pas de candidat `album` → miss sans `lookup`.
- [ ] track → `pick: "song"` ; artist → `pick: "artist_top"`.
- [ ] `previews: false` : aucun appel `lookupAlbumSongs`, aucune recherche `song` pour un artiste, la clé
      `preview` du sidecar n'est ni écrite ni modifiée (un sidecar qui en avait une la garde) ; les liens se
      résolvent comme avant.
- [ ] artist « Aphex Twin » : résultats `song` `[ {artist: "Aphex Twin & X"}, {artist: "Various Artists"},
      {artist: "aphex twin", previewUrl} ]` → le troisième ; aucun crédit exact → miss ; la requête `song`
      utilise le nom de l'artiste seul.
- [ ] genre et label → `preview` jamais écrit ni résolu (aucun appel), comme aujourd'hui pour les liens.
- [ ] Sidecar existant sans clé `preview`, liens présents → la lecture suivante résout l'extrait seulement
      (aucun appel `musicArtist`/`album` pour les liens déjà résolus… sauf le `album` nécessaire au
      `collectionId` d'un project, documenté), réécrit le fichier avec `spotify`/`apple` identiques.
- [ ] `needsPreviewResolution` : absent → true ; `{url: null, resolved_at: il y a 8 jours}` → true ;
      `{url: null, resolved_at: hier}` → false ; hit vieux d'un an → false ; `resolved_at` illisible → true.
- [ ] `readSidecar` sur `{"spotify":null,"apple":null,"sources":{},"resolvedAt":"…","preview":"garbage"}`
      → `preview` absent ; sur un `preview` valide → conservé tel quel.
- [ ] `force: true` re-résout liens et extrait.
- [ ] `npm run check` vert.

## Tests attendus
- unitaire (`test/streaming-links.test.ts`) : les cas ci-dessus avec un `cacheDir` temporaire
  (`mkdtemp`, comme les tests existants l.1-3) et des `deps` injectés qui comptent leurs appels ; un
  `previewUrl` candidat refusé par `isAllowedPreviewUrl` (déjà filtré en 1.1) n'apparaît jamais dans un
  sidecar — test de non-régression avec un faux `searchAppleEntities` qui renvoie un candidat sans
  `previewUrl`.

## Tier de risque
tier/2 — logique métier locale, écriture dans un sidecar ignoré par git, couverte par tests ; aucun contrat
public modifié (1.3 s'en charge).

## Notes d'implémentation
- Ne pas changer la signature publique de `resolveStreamingLinks` autrement que par `deps?` : `src/server.ts:155`
  la passe telle quelle à `createMobileMedia`.
- Un miss d'extrait n'est pas un miss de liens : `isStaleMiss` reste sur `spotify`/`apple` seuls.
- `MISS_TTL_MS` (l.42) sert aux deux : une seule constante.
- Garder la tolérance de `readSidecar` (« hand-edited or truncated sidecar ») : `preview` doit être un objet
  avec `url` string acceptée par `isAllowedPreviewUrl` ou `null`, `apple_url` string, `track_name` string
  non vide, sinon absent.
- Journaliser en `log.warn` un `lookupAlbumSongs` vide sur un album trouvé (utile à l'audit), jamais en erreur.
- Si le diff dépasse 300 lignes : (a) types + `needsPreviewResolution` + `readSidecar` + tests, (b)
  `resolvePreview` + câblage + tests.
```

### 1.4 — Exposer `preview` dans `GET /mobile/v1/nodes/:slug/links`, lire les pistes notables, poser le kill switch, documenter

- Tier : **tier/2** (Q10, tranché) · Estimate : **2** · Partie 1 · Dépend de : 1.3

```markdown
## Contexte
Le sidecar porte désormais l'extrait (1.3). L'app iOS le lit par la route `/links` qu'elle appelle déjà à
l'ouverture du lecteur (plan docs/plans/player-audio-preview.md, D2). Le champ est additif : les clients
d'aujourd'hui (iOS, `mobile/` React Native) l'ignorent. Toute URL est revalidée à la sortie, hôte compris,
comme `spotify` et `apple`. C'est aussi ici que le graphe entre en jeu : pour un album, la route lit le nœud
de son premier artiste et passe les titres notables au résolveur (D3). Et c'est ici que vit le kill switch
`ODYSSEY_PREVIEWS=0` (Risques), qui rend `preview: null` partout sans appel iTunes.

## Portée
Fichiers à modifier (lignes de `origin/main` au 2026-11-28, `e86f046`) :
- `src/flags.ts` — `previewsEnabled()` après `onDemandImagesEnabled` (l.45-48), même forme (fonction, lue à
  chaque appel, `ODYSSEY_PREVIEWS` à `0`/`false` → off, on par défaut), même doc.
- `src/mobile/media.ts` — `MobileLinksResponse` (l.26-32) : `preview: MobilePreviewLink | null` ;
  `links()` (l.107-144) : branche genre/label (l.110-118) → `preview: null` ; branche résolue (l.119-140) :
  pour un `project`, lire le nœud du premier artiste (`dependencies.nodes.read(artists[0].slug)`, null toléré)
  et calculer `notableTrackTitles(node.node, artist?.node ?? null)` (`src/album-preview.ts`, 1.2) ; appeler
  `resolveLinks` avec `notableTrackTitles` (projects) et `previews: previewsEnabled()` ; sortie →
  `toMobilePreview(resolved.preview)`, `null` si le flag est off ; `STREAMING_HOSTS` (l.56-59) inchangé,
  l'hôte de l'extrait passe par `isAllowedPreviewUrl` (import de `../itunes.js`).
- `src/server.ts` — commentaire de route `/links` (l.15-20) : mentionner `preview`.
- `docs/track1-api.md` — nouvelle section « Liens d'écoute et extrait (TRA-<id>) » après « Contenu localisé
  d'une fiche (TRA-810) » (l.142-176), même style : exemple JSON, règles de présence, règle de repli client.
- `test/mobile/media.test.ts` — étendre le test l.177-211 et le test de route l.228 ; nouveaux cas.
Hors-scope explicite :
- `src/mobile/router.ts` (la route existe), `src/mobile/contracts.ts` (les types de `/links` vivent dans
  `media.ts`), `src/album-preview.ts` (appelé, pas modifié), `mobile/` (client RN), iOS.

## Contrat
    export interface MobilePreviewLink {
      url: string;         // isAllowedPreviewUrl
      apple_url: string;   // safePublicHttpsUrl(…, "music.apple.com")
      track_name: string;  // trimmed, non-empty
      source: "itunes";
    }
    export interface MobileLinksResponse {
      slug: Slug; spotify: string | null; apple: string | null; sources: …; resolvedAt: string;
      /** Always present. null: no preview, previews switched off, or a preview whose url/apple_url/track_name
       *  failed validation. `pick` and `resolved_at` never leave the server. */
      preview: MobilePreviewLink | null;
    }
    // src/flags.ts
    /** ODYSSEY_PREVIEWS=0 (or false) switches every preview off at the next request: no iTunes call, `preview: null`. */
    export function previewsEnabled(): boolean
Réponse HTTP (exemple pour la doc) :
    { "slug": "track:windowlicker--aphex-twin", "spotify": null, "apple": "https://music.apple.com/…?i=…",
      "sources": { "apple": "itunes" }, "resolvedAt": "2026-11-28T10:00:00.000Z",
      "preview": { "url": "https://audio-ssl.itunes.apple.com/…/x.m4a", "apple_url": "https://music.apple.com/…?i=…",
                   "track_name": "Windowlicker", "source": "itunes" } }

## Critères d'acceptation
- [ ] Sidecar résolu avec `preview` valide → la réponse porte `preview` avec les quatre clés, `resolved_at`
      exclu.
- [ ] `preview.url` sur `https://evil.example/x.m4a` → `preview: null` (les liens restent) ;
      `apple_url` sur `https://open.spotify.com/…` → `preview: null` ; `track_name: "  "` → `preview: null`.
- [ ] `preview` absent ou `{ url: null }` → `preview: null`.
- [ ] genre et label → `preview: null`, `resolveLinks` jamais appelé (test existant l.177 étendu).
- [ ] project avec artiste en cache (`reference_track` T2, `notable_tracks` [T3], `tracklist` [T1, T2, T3]) →
      `resolveLinks` reçoit `notableTrackTitles: ["<T2>", "<T3>"]` ; artiste absent du cache → `[]` ; artist
      ou track → `notableTrackTitles` absent ; un seul `nodes.read` de plus, et seulement pour un project.
- [ ] `ODYSSEY_PREVIEWS=0` (via `vi.stubEnv`) → `resolveLinks` reçoit `previews: false` et la réponse porte
      `preview: null` même si le sidecar en a un ; variable absente → `previews: true` ; `previewsEnabled()`
      lit la variable à chaque appel (pas de constante de module).
- [ ] La route `GET /mobile/v1/nodes/:slug/links` sert `preview` avec `Cache-Control: private, max-age=86400`
      (test l.228 étendu) ; la réponse d'un sidecar sans `preview` est identique à celle d'aujourd'hui plus
      `"preview": null`.
- [ ] `docs/track1-api.md` décrit le champ, sa présence (« toujours présent, `null` sans extrait ou
      extraits désactivés »), les hôtes acceptés, la provenance par type (D3, sans les détails de choix), et
      la règle client : « un client qui ignore `preview` reste correct ».
- [ ] `npm run check` vert ; `test/mobile/compatibility.test.ts` inchangé et vert.

## Tests attendus
- unitaire (`test/mobile/media.test.ts`) : les cas ci-dessus via le `media(resolveLinks)` helper existant,
  qui capture l'`input` reçu ; le flag par `vi.stubEnv("ODYSSEY_PREVIEWS", "0")` + `vi.unstubAllEnvs()`
  (aucun fichier `test/flags.test.ts` sur `main` : les flags sont testés par leurs consommateurs).
- intégration : le test de route l.228 (serveur http réel) lit `preview` dans le JSON.

## Tier de risque
tier/2 — champ additif, toujours présent, sur une route lue par notre seule app ; revalidation d'hôte à
la sortie. Raphael peut relever en tier/3 (plan, Q10).

## Notes d'implémentation
- Même discipline que `toMobileImage` (l.61-79) : « The URL comes from a sidecar derived from third-party
  sources: it is checked on every way out ».
- `MobileProviderUnavailableError` (l.141-143) couvre déjà un `resolveLinks` qui rejette : rien à ajouter.
  Une lecture d'artiste qui échoue (`nodes.read` rejette) ne doit PAS faire échouer `/links` : titres `[]`,
  `log.warn`, et la résolution continue (le repli piste 1 fera foi).
- `nodes.read` d'un artiste passe par `resolveReadSlug` et peut renvoyer `redirected_from` : lire
  `result.node`, ignorer le reste.
- Doc en français, clés en snake_case dans `preview` comme `image_url` / `materialized_at` ; `resolvedAt`
  reste camelCase (historique, décodé sous les deux formes par iOS).
```

### 2.1 — Décoder `preview` dans `LinksResponse` et l'exposer par `NodeViewModel.preview`

- Tier : **tier/2** · Estimate : **2** · Partie 2 · Dépend de : — (contrat 1.4 figé par le plan)

```markdown
## Contexte
La route `/links` va porter un objet `preview` (plan docs/plans/player-audio-preview.md, D2, 1.4). L'app
doit le décoder comme une donnée tierce — hôte de l'extrait et hôte Apple Music vérifiés — sans jamais
faire échouer la réponse si le champ manque ou est malformé, puis l'exposer au lecteur à côté de
`listening`. Rien de visible après cette tâche.

## Portée
Fichiers à modifier (lignes de `origin/main` au 2026-11-28, `e86f046`) :
- `ios/Track1Core/Sources/Track1Core/API/URLValidation.swift` — après `providerURL` (l.25-28) :
  `previewAssetURL(from:)` et `previewHostSuffixes`.
- `ios/Track1Core/Sources/Track1Core/API/APIModels.swift` — `LinksResponse` (l.455-475) : propriété
  `preview: PreviewLink?` décodée en additif (`(try? v.decodeIfPresent(…)) ?? nil`, le motif de
  `NodeEdge.artist` l.420-421) ; nouveau `public struct PreviewLink` après `LinksResponse`, décodé par des
  wrappers privés comme `AppleURL` (l.650-659) ; `CodingKeys` : `case preview`.
- `ios/Track1Core/Sources/Track1Core/Features/Node/NodeViewModel.swift` — `public private(set) var preview:
  PreviewLink?` (à côté de `listening`, l.26) ; `load()` (l.82-85) le remet à nil ; `loadListening`
  (l.120-138) l'affecte depuis `links?.preview` sous le même garde de slug (l.131) et d'annulation (l.135).
- Tests : `ios/Track1Core/Tests/Track1CoreTests/ListeningTests.swift` (décodage, à côté des refus d'hôte
  l.124-162) ; `ios/Track1Core/Tests/Track1CoreTests/Node/NodeListeningTests.swift` (modèle) ;
  `ios/Track1Core/Tests/Track1CoreTests/Node/NodeViewModelTests.swift` — helper `linksResponse(slug:)`
  (l.375-379) gagne un paramètre `preview: String = "null"`.
Hors-scope explicite :
- `ListeningState`, `ListeningActions`, `ListeningAction` : inchangés (l'extrait n'est pas une action).
- Toute vue, `PlayerNowBar`, `PlayerView` (3.2). `ContentReaders`, `APIClient` (la route est la même).

## Contrat
    extension URLValidation {
        /// Strict subdomains only, lowercase compare: "audio-ssl.itunes.apple.com" yes, "itunes.apple.com" no.
        public static let previewHostSuffixes: [String]   // [".itunes.apple.com", ".mzstatic.com"]
        /// publicHTTPSURL(from:) whose host ends with one of previewHostSuffixes and is longer than it.
        public static func previewAssetURL(from value: String) -> URL?
    }
    public struct PreviewLink: Equatable, Sendable {
        public let url: URL          // previewAssetURL
        public let appleURL: URL     // providerURL(host: "music.apple.com")
        public let trackName: String // non-empty after trimming
        // Decodable from {"url","apple_url","track_name","source"}; "source" ignored.
    }
    public struct LinksResponse { …; /// Additive: absent, null or malformed → nil, the response still decodes.
                                   public let preview: PreviewLink? }
    NodeViewModel { public private(set) var preview: PreviewLink? }   // nil until `.ready`, nil for another slug

## Critères d'acceptation
- [ ] `previewAssetURL("https://audio-ssl.itunes.apple.com/a/b.m4a")` non nil ; `"https://x.mzstatic.com/a.m4a"`
      non nil ; `"https://itunes.apple.com/a.m4a"` nil ; `"https://mzstatic.com/a"` nil ;
      `"https://audio-ssl.itunes.apple.com.evil.example/a"` nil ; `"http://audio-ssl.itunes.apple.com/a"` nil ;
      `"https://user:pw@audio-ssl.itunes.apple.com/a"` nil ; `"https://AUDIO-SSL.ITUNES.APPLE.COM/a"` non nil.
- [ ] `LinksResponse` JSON avec `preview` valide → `preview.url`, `appleURL`, `trackName` attendus ; sans clé
      `preview` → nil ; `"preview": null` → nil ; `"preview": "x"` → nil ; `preview.url` hors hôtes → nil ;
      `apple_url` sur `open.spotify.com` → nil ; `track_name: ""` → nil. Dans tous ces cas `spotify`/`apple`
      décodent comme avant.
- [ ] `NodeViewModel` : liens avec `preview` → après `load()`, `model.preview` non nil et `listening == .ready` ;
      réponse pour un autre slug → `preview == nil` (l.131) ; genre → `preview == nil` sans appel `/links` ;
      `readLinks` en échec → nil ; second `load()` ne le réinitialise pas ; `load()` après `.failed` le remet
      à nil avant de relire.
- [ ] `swift test --package-path ios/Track1Core` vert ; `test/ios-core-package.test.ts` vert.

## Tests attendus
- unitaire Core (`ListeningTests`) : hôtes ; décodage de `LinksResponse` avec/sans/malformé.
- unitaire Core (`NodeListeningTests`, `NodeViewModelTests`) : les cas de modèle ci-dessus.

## Tier de risque
tier/2 — décodage défensif d'une donnée tierce, logique locale, aucune UI.

## Notes d'implémentation
- Un `preview` malformé ne doit JAMAIS faire échouer `LinksResponse` : la barre Now d'aujourd'hui en dépend.
  C'est la règle « Additive, optional field » déjà écrite l.420 et l.450.
- `trackName` : refuser vide après `trimmingCharacters(in: .whitespacesAndNewlines)` ; la vue le passera
  par `PlayerView.oneLine` (contrôles et bidi) avant de l'afficher.
- Pas de `#if os(iOS)` dans les tests du package ; JSON comme `NodeViewModelTests.linksResponse`.
```

### 2.2 — `PreviewEngine` et `PreviewPlaybackModel` : la lecture d'un extrait comme machine à états pure

- Tier : **tier/2** · Estimate : **3** · Partie 2 · Dépend de : — (‖ 2.1)

```markdown
## Contexte
Le lecteur va jouer l'extrait avec `AVPlayer` (plan docs/plans/player-audio-preview.md, D4, D6). Tout le
comportement — lecture automatique sauf si une autre app joue, pause sur interruption, arrêt quand la vue
disparaît, rejouer après la fin, silence sur échec — doit être prouvé par `swift test`, sans AVFoundation.
Cette tâche crée le protocole du moteur et le modèle qui le pilote ; l'app fournira le moteur (3.1).

## Portée
Fichiers à créer (package : pas de pbxproj) :
- `ios/Track1Core/Sources/Track1Core/Listening/PreviewPlayback.swift` — Foundation + Observation seulement.
- `ios/Track1Core/Tests/Track1CoreTests/PreviewPlaybackTests.swift` — avec un `FakePreviewEngine` interne au
  test (enregistre les commandes, émet des événements à la demande).
Hors-scope explicite :
- `AVFoundation`, `AVAudioSession` : app (3.1). SwiftUI : interdit dans le package.
- `NodeViewModel` (2.1), `PlayerNowBar`, `PlayerView` (3.2).
- Analytics, boucle, fondu, volume (non-buts).

## Contrat
    public enum PreviewPlaybackState: String, Equatable, Sendable { case idle, loading, playing, paused, ended, failed }
    public enum PreviewEngineEvent: Equatable, Sendable { case readyToPlay, didPlayToEnd, failed, interrupted }
    /// The audio boundary. Main-actor: AVPlayer callbacks hop to the main actor before emitting.
    @MainActor public protocol PreviewEngine: AnyObject {
        /// Read once, when autoplay is decided (D4).
        var isOtherAudioPlaying: Bool { get }
        var events: AsyncStream<PreviewEngineEvent> { get }
        func load(_ url: URL)
        /// From the current position; after `didPlayToEnd`, from the start.
        func play()
        func pause()
        /// Releases the item and deactivates the session. Idempotent.
        func stop()
    }
    @MainActor @Observable public final class PreviewPlaybackModel {
        public let link: PreviewLink
        public private(set) var state: PreviewPlaybackState   // .idle
        public init(link: PreviewLink, engine: any PreviewEngine, autoplay: Bool = true)
        /// load(link.url), then consumes `events` until stop() or the task is cancelled.
        public func start() async
        /// playing → pause(); paused/ended → play(); idle/loading/failed → nothing.
        public func toggle()
        /// Scene left `.active` (D4): playing → pause(); nothing else changes.
        public func sceneBecameInactive()
        /// View gone: stop() on the engine, state .idle, event loop ends.
        public func stop()
        /// Accessibility label of the cover control for `state` (French): "Lire l’extrait" / "Mettre l’extrait en pause"; nil when no control is drawn.
        public static func controlLabel(for state: PreviewPlaybackState) -> String?
    }
    extension PreviewLink {
        /// "Extrait avec l’aimable autorisation d’iTunes" (plan D5, Q7).
        public static let attributionLabel: String
        /// "<attributionLabel>. Écouter <trackName> sur Apple Music" — the attribution line's accessibility label.
        public var attributionAccessibilityLabel: String { get }
    }

## Critères d'acceptation
- [ ] `start()` → `load(url)` est la première commande, `state == .loading` ; `readyToPlay` avec
      `isOtherAudioPlaying == false` et `autoplay` → `play()` puis `.playing` ; avec `isOtherAudioPlaying == true`
      → aucune commande `play`, `.paused` ; avec `autoplay == false` → `.paused`.
- [ ] `didPlayToEnd` en `.playing` → `.ended`, aucune commande ; `toggle()` en `.ended` → `play()`, `.playing`.
- [ ] `toggle()` : `.playing` → `pause()`, `.paused` ; `.paused` → `play()`, `.playing` ; `.loading` / `.idle` /
      `.failed` → aucune commande, état inchangé.
- [ ] `interrupted` en `.playing` → `.paused`, commande `pause()` ; en `.paused` → rien.
- [ ] `failed` dans tout état → `.failed`, commande `stop()` ; `toggle()` ensuite ne fait rien.
- [ ] `sceneBecameInactive()` : `.playing` → `pause()`, `.paused` ; `.loading` → reste `.loading` mais le
      `readyToPlay` suivant n'autoplaye plus (→ `.paused`).
- [ ] `stop()` → commande `stop()`, `.idle`, la boucle d'événements se termine (le `Task` de `start()` rend
      la main) ; un `readyToPlay` reçu après `stop()` est ignoré ; `stop()` deux fois n'émet qu'une commande.
- [ ] L'annulation du `Task` qui exécute `start()` appelle `stop()` sur le moteur (le lecteur peut quitter
      pendant le chargement).
- [ ] `controlLabel(for:)` : `.playing` → "Mettre l’extrait en pause" ; `.paused`, `.ended` → "Lire l’extrait" ;
      `.idle`, `.loading`, `.failed` → nil.
- [ ] `PreviewLink.attributionLabel == "Extrait avec l’aimable autorisation d’iTunes"` ;
      `attributionAccessibilityLabel` pour « Windowlicker » == "Extrait avec l’aimable autorisation d’iTunes.
      Écouter Windowlicker sur Apple Music".
- [ ] `swift test --package-path ios/Track1Core` vert ; aucun `import` autre que Foundation / Observation.

## Tests attendus
- unitaire Core (`PreviewPlaybackTests`) : chaque critère est un test ; le faux moteur expose
  `commands: [String]` et une `continuation` pour émettre. Attendre les transitions par une boucle
  `waitUntil` comme `NodeViewModelTests.waitUntil`, jamais par `sleep` fixe.

## Tier de risque
tier/2 — nouveau composant avec état, pur, entièrement couvert par tests ; aucune UI, aucun réseau.

## Notes d'implémentation
- Observation (`@Observable`) est déjà dans le package (`NodeViewModel`) ; `platforms: .macOS(.v14)` le permet.
- Une seule boucle `for await event in engine.events` dans `start()` ; `stop()` pose un drapeau lu par la
  boucle et appelle `engine.stop()` ; l'`AsyncStream` du faux moteur se termine quand le test le décide.
- Apostrophe typographique U+2019 dans les libellés, comme `NodePageListening.failureMessage`.
- Si le diff dépasse 300 lignes : (a) protocole + états + libellés + tests de libellés, (b) le modèle + ses tests.
```

### 3.0 — Garde vitest : l'extrait est streamé, jamais téléchargé, jamais en arrière-plan

- Tier : **tier/1** · Estimate : **1** · Partie 3 · Dépend de : — (‖ tout)

```markdown
## Contexte
La licence des extraits iTunes exige qu'ils soient « streamed only, and not downloaded, saved, cached »
(plan docs/plans/player-audio-preview.md, D1 condition iv, D6), et le plan exclut la lecture en
arrière-plan. Le dépôt transforme déjà ce genre de règle en test (`test/ios-no-webview.test.ts`). Cette
garde tourne dans `npm run check`, avant que la moindre ligne d'AVFoundation n'existe.

## Portée
Fichier à créer :
- `test/ios-preview-streaming.test.ts` — modèle : `test/ios-no-webview.test.ts` (liste `forbidden` l.15-,
  scan de `ios/Track1` et `ios/Track1Core/Sources`, dossiers `.build` ignorés, tests sur un dépôt temporaire).
Hors-scope explicite :
- Aucun fichier Swift, aucun plist. `.github/**` (tier/3) : la garde est prise par `npm run test` existant.

## Contrat
    // Forbidden in ios/Track1/**/*.swift and ios/Track1Core/Sources/**/*.swift (word boundaries):
    //   AVAssetDownloadURLSession, AVAssetDownloadTask, AVAggregateAssetDownloadTask, AVAssetExportSession,
    //   AVAssetWriter, AVAssetResourceLoaderDelegate
    // Forbidden in ios/Track1/Resources/Info.plist: the key UIBackgroundModes
    // Forbidden in ios/Track1.xcodeproj/project.pbxproj: INFOPLIST_KEY_UIBackgroundModes

## Critères d'acceptation
- [ ] Le test passe sur `origin/main`.
- [ ] Sur un dépôt temporaire, un fichier `ios/Track1/Media/X.swift` contenant `AVAssetDownloadTask` est signalé
      avec son chemin ; un commentaire `// never use AVAssetDownloadTask` ne l'est pas (le motif exige un usage,
      pas une mention : même approche que les gardes d'import, ou motif `\bAVAssetDownloadTask\b` hors ligne
      commençant par `//`) ; un fichier sous `.build/` est ignoré.
- [ ] Un `Info.plist` temporaire avec `<key>UIBackgroundModes</key>` est signalé.
- [ ] `npm run check` vert.

## Tests attendus
- unitaire : les cas ci-dessus (vrai dépôt + dépôt temporaire), comme l.76-122 du modèle.

## Tier de risque
tier/1 — ajout de test, aucun code de production.

## Notes d'implémentation
- Réutiliser les helpers du modèle plutôt que les copier si l'extraction tient en < 20 lignes ; sinon
  copier et dire pourquoi.
- Le motif sur une ligne de commentaire : ignorer les lignes dont le premier caractère non blanc est `/`.
```

### 3.1 — `AVPreviewEngine`, faux moteur de test, et injection jusqu'au lecteur

- Tier : **tier/2** · Estimate : **3** · Partie 3 · Dépend de : 2.2 (et 3.0 mergé de préférence)

```markdown
## Contexte
`PreviewPlaybackModel` (2.2) pilote un `PreviewEngine`. Cette tâche fournit le vrai moteur — `AVPlayer`,
session `.ambient`, interruptions, fin de lecture — et un faux pour les UI tests, puis amène le moteur
jusqu'à `PlayerView` sans encore l'utiliser (plan docs/plans/player-audio-preview.md, D4, D6). Après
cette tâche, l'app compile avec un moteur injecté et rien de visible ne change.

## Portée
Fichiers à créer (app : entrées `project.pbxproj` obligatoires, convention `F1…` fileRef / `B1…` buildFile,
groupes `A300000000000000000002E0 /* Media */` l.327 et `A300000000000000000002E1 /* Media */` l.328, phase
Sources de la cible correspondante) :
- `ios/Track1/Media/AVPreviewEngine.swift`
- `ios/Track1Tests/Media/AVPreviewEngineTests.swift`
Fichiers à modifier (lignes de `origin/main` au 2026-11-28, `e86f046`) :
- `ios/Track1/App/UITestFixtureReaders.swift` — dans le `#if targetEnvironment(simulator)` : `UITestPreviewEngine`
  (modèle : `UITestReminderCenter`, l.~120-150) et `static func previewEngine(environment:) -> (any PreviewEngine)?`
  (non nil dès que `TRACK1_UI_TEST_FIXTURES_JSON` est présent).
- `ios/Track1/App/AppContainer.swift` — `let makePreviewEngine: @MainActor () -> any PreviewEngine` ; choisi
  dans les deux branches `#if targetEnvironment(simulator)` (l.82-95) : faux si `fixtureReaders != nil`,
  sinon `{ AVPreviewEngine() }`.
- `ios/Track1/App/RootView.swift` — `ApplicationTabs` (l.50-) reçoit `makePreviewEngine` ; route `.player`
  (l.259-275) le passe à `PlayerDestination` ; `PlayerDestination` (l.422-441) le passe à `PlayerView`.
- `ios/Track1/Features/Node/PlayerView.swift` — `init` (l.144-152) gagne `previewEngine: any PreviewEngine`,
  stocké, non utilisé (3.2) ; `ios/Track1Tests/Node/PlayerViewTests.swift` : adapter les appels à `PlayerView(`
  s'il y en a (vérifier ; le fichier teste surtout des statiques).
Hors-scope explicite :
- `PlayerNowBar`, `PlayerReader`, toute UI (3.2). `Info.plist` (aucun `UIBackgroundModes`, garde 3.0).
- `MPNowPlayingInfoCenter`, `MPRemoteCommandCenter`, `AVAudioSession` autre que `.ambient`.

## Contrat
    @MainActor final class AVPreviewEngine: PreviewEngine {
        static let category: AVAudioSession.Category = .ambient
        /// AVAudioSession.sharedInstance().isOtherAudioPlaying
        var isOtherAudioPlaying: Bool { get }
        var events: AsyncStream<PreviewEngineEvent> { get }
        /// Refuses a URL that URLValidation.previewAssetURL rejects: emits .failed without touching AVPlayer.
        func load(_ url: URL)
        func play(); func pause(); func stop()
    }
    // Events: AVPlayerItem.status == .readyToPlay → .readyToPlay ; .failed → .failed ;
    // AVPlayerItem.didPlayToEndTimeNotification → .didPlayToEnd ; AVAudioSession.interruptionNotification(.began) → .interrupted.
    // play() after didPlayToEnd: seek(to: .zero) then play(). stop(): pause, replaceCurrentItem(nil), setActive(false, .notifyOthersOnDeactivation).
    // Simulator only:
    final class UITestPreviewEngine: PreviewEngine   // isOtherAudioPlaying false; load → .readyToPlay at once; never ends; records nothing
    enum UITestFixtureReaders { static func previewEngine(environment: [String: String]) -> (any PreviewEngine)? }
    final class AppContainer { let makePreviewEngine: @MainActor () -> any PreviewEngine }
    struct PlayerView { init(model:, imageStore:, previewEngine: any PreviewEngine, safeAreaBottom:, onBack:) }

## Critères d'acceptation
- [ ] `AVPreviewEngine.category == .ambient` (test).
- [ ] `load(URL("https://evil.example/a.m4a"))` émet `.failed` et ne crée aucun `AVPlayerItem` (test : l'URL
      refusée ne déclenche aucune requête — vérifiable par un `URLProtocol` de test ou, plus simple, par un
      hook interne `itemFactory` injectable qui n'est pas appelé).
- [ ] `stop()` deux fois ne lève rien ; `play()` sans `load` ne lève rien.
- [ ] `UITestPreviewEngine.load(_:)` émet `.readyToPlay` ; `isOtherAudioPlaying == false`.
- [ ] `UITestFixtureReaders.previewEngine(environment: ["TRACK1_UI_TEST_FIXTURES_JSON": "{}"])` non nil ;
      `environment: [:]` → nil.
- [ ] L'app compile et tous les tests existants passent (`ios-check` vert) ; aucun changement visible.
- [ ] `test/ios-preview-streaming.test.ts` (3.0) et `test/ios-no-webview.test.ts` verts.

## Tests attendus
- unitaire app (`AVPreviewEngineTests`) : catégorie ; URL refusée ; idempotence de `stop`.
- Les tests Core de 2.2 restent la preuve du comportement ; ici on prouve la frontière.

## Tier de risque
tier/2 — nouveau composant avec état et effets système (session audio), sans donnée personnelle, sans réseau
hors l'URL validée ; couvert par les tests Core (2.2) et les tests de frontière.

## Notes d'implémentation
- `AVPlayer` et ses notifications arrivent hors `MainActor` : observer avec `NotificationCenter` +
  `Task { @MainActor in … }`, et le KVO de `AVPlayerItem.status` par `observe(\.status)` qui saute sur le
  main actor avant d'appeler la continuation. `docs/track1-builds.md:159-160` : les erreurs d'isolation
  inter-cibles ne sortent qu'en `ios-check` — passer la PR en ready tôt.
- `setActive(true)` dans `play()`, pas dans `load` : activer la session au moment du son, pas avant.
- Pas de `automaticallyWaitsToMinimizeStalling = false` : le flux est court, laisser le défaut.
- `AVPlayerItem(url:)` sur une URL déjà validée ; pas de `AVURLAsset` avec options réseau exotiques ;
  jamais `AVAssetResourceLoaderDelegate` (garde 3.0).
- Le faux moteur vit dans `UITestFixtureReaders.swift` pour n'ajouter aucun fichier pbxproj de plus.
- Ne pas oublier les quatre entrées pbxproj par fichier (fileRef, buildFile, groupe, phase Sources) ; l'ID
  suit le dernier `F1…`/`B1…` libre de la plage 0x4xx ; `test/ios-check.test.ts` et `ios-check` valident.
```

### 3.2 — La pochette joue et met en pause ; la ligne d'attribution ouvre le morceau sur Apple Music

- Tier : **tier/2** · Estimate : **3** · Partie 3 · Dépend de : 2.1, 3.1

```markdown
## Contexte
L'extrait est résolu (partie 1), décodé (2.1), pilotable (2.2) et le moteur est injecté (3.1). Cette tâche
le fait entendre : `PlayerReader` crée un `PreviewPlaybackModel` dès que `model.preview` existe, la pochette
de la barre Now devient le bouton lecture/pause, et une ligne d'attribution — exigée par la licence (plan
docs/plans/player-audio-preview.md, D4, D5) — apparaît au-dessus de la barre et ouvre la page Apple Music du
morceau. Sans extrait, le lecteur ne change pas d'un pixel.

**Précondition (Q11, étape de procédure) :** avant le merge de cette PR, Raphael lit les conditions que la
session de planification n'a pas pu vérifier — la page Apple Performance Partners « Search API » et ses
T&C, et les Apple Music Identity Guidelines — et écrit son OK dans la PR. Si elles imposent un badge
graphique ou un libellé verbatim, la ligne d'attribution est ajustée par un ticket `tier/1` qui suit.

## Portée
Fichiers à modifier (lignes de `origin/main` au 2026-11-28, `e86f046`) :
- `ios/Track1/DesignSystem/Components/Core/Track1Icon.swift` — `Glyph` (l.10-23) : `case pause` → `"pause.fill"`.
- `ios/Track1/DesignSystem/Components/Node/PlayerNowBar.swift` — `PlayerNowBarMetrics` (l.5-46) : `previewToggleIdentifier`,
  `previewGlyphSize`, `previewVeil` (voir Contrat) ; `PlayerNowBar.init` (l.60-70) : deux paramètres optionnels
  `previewState: PreviewPlaybackState? = nil`, `togglePreview: (() -> Void)? = nil` ; `coverView` (l.107-123) :
  enveloppée dans un `Button` quand `togglePreview != nil` et que `PreviewPlaybackModel.controlLabel(for:)` est
  non nil, glyphe superposé selon l'état.
- `ios/Track1/Features/Node/PlayerView.swift` — `PlayerMetrics` (l.6-124) : constantes `preview*` ;
  `PlayerReader` (l.246-377) : `@State private var playback: PreviewPlaybackModel?`, `@Environment(\.scenePhase)`,
  création dans `.onChange(of: model.preview, initial: true)`, `.task(id:)` qui appelle `start()`,
  `.onDisappear { playback?.stop() }`, `onChange(of: scenePhase)` → `sceneBecameInactive()` hors `.active` ;
  `bottomBar` (l.292-310) : `PlayerPreviewAttribution` entre le notice et la barre, et les deux nouveaux
  paramètres passés à `PlayerNowBar` ; nouvelle vue privée `PlayerPreviewAttribution` après `PlayerSourceLine`
  (l.407-430, son modèle).
- Tests : `ios/Track1Tests/DesignSystem/Track1IconTests.swift` (table l.17, `allCases` l.22-34) ;
  `ios/Track1Tests/DesignSystem/PlayerNowBarTests.swift` (helper `bar(…)` l.19-27 gagne les deux paramètres) ;
  `ios/Track1Tests/Node/PlayerViewTests.swift` (constantes ; helper `node(…)` l.28-38 inchangé).
Hors-scope explicite :
- `PlayerScroll`, `PlayerCarousel`, `PlayerSnapBehavior`, `PlayerSourceLine`, `bottomMargin`.
- `ListeningActions`, `NodePageListening`, `StreamingBar` (la fiche de nœud ne change pas).
- `Track1Tokens` (aucun token nouveau), `Track1Typography` (rôles existants), analytics.
- Aucun fichier nouveau (les vues privées vivent dans `PlayerView.swift`), aucune édition pbxproj.

## Contrat
    extension PlayerNowBarMetrics {
        static let previewToggleIdentifier = "player-preview-toggle"
        /// SF Symbol over the 30.881 pt cover: 14 pt, colorIconPrimary, on a colorGlassPill veil (no Figma node; plan D4, Q8).
        static let previewGlyphSize: CGFloat = 14
        static let previewVeil = Track1Tokens.colorGlassPill
    }
    struct PlayerNowBar {
        init(title:, artist:, cover:, actions:, isOpening:, previewState: PreviewPlaybackState? = nil,
             togglePreview: (() -> Void)? = nil, open:)
        /// nil → the cover is decorative as today; else the glyph: .playing → .pause, .paused/.ended → .play, others → nil (no button).
        static func previewGlyph(for state: PreviewPlaybackState?) -> Track1Icon.Glyph?
    }
    // Cover button: .accessibilityLabel(PreviewPlaybackModel.controlLabel(for:)), .accessibilityValue(state.rawValue),
    // .accessibilityIdentifier(previewToggleIdentifier), touch area 44 x 44 by the PlayerOpenButton recipe (l.169-175).
    extension PlayerMetrics {
        static let previewAttributionIdentifier = "player-preview-attribution"
        static let previewAttributionRole = Track1TextRole.bodySmall
        static let previewAttributionColor: Color = Track1Tokens.colorTextPrimary
        /// Same marks as the Now bar's Apple Music button (PlayerNowBarMetrics.logoSize / arrowSize / markSpacing).
    }
    /// One Button, .buttonStyle(.plain): Track1Text(PreviewLink.attributionLabel, role: bodySmall, verbatim: true) +
    /// Image(StreamingButton.logoName(for: .appleMusic)) + Track1Icon(.arrowDownRight) flipped, lineLimit(2), width columnWidth,
    /// leading aligned; action: open(link.appleURL); .accessibilityLabel(link.attributionAccessibilityLabel), .isLink,
    /// identifier previewAttributionIdentifier. No PlayerFramesKey preference.
    private struct PlayerPreviewAttribution: View { let link: PreviewLink; let open: (URL) -> Void }
    extension PlayerView {
        /// Drawn only when the Now bar is (actions non-empty) and the node has a preview.
        static func showsPreview(actions: [ListeningAction], preview: PreviewLink?) -> Bool
    }

## Critères d'acceptation
- [ ] `Track1Icon.Glyph.allCases` contient `.pause` → `"pause.fill"`, et le symbole existe sur le système
      (tests existants étendus).
- [ ] `PlayerNowBar.previewGlyph(for:)` : nil → nil ; `.loading` → nil ; `.playing` → `.pause` ; `.paused` →
      `.play` ; `.ended` → `.play` ; `.failed` → nil ; `.idle` → nil.
- [ ] Une barre avec `previewState: .playing` et `togglePreview` mesure la même taille (± 0,5) qu'une barre
      sans (le glyphe est superposé, la pastille ne bouge pas) ; l'appui sur le bouton appelle `togglePreview`
      une fois ; `isOpening: true` ne désactive PAS le bouton de l'extrait (seuls les liens sortants sont
      désactivés) — vérifier par `UIHostingController` comme l.30-32.
- [ ] `PlayerMetrics.previewAttributionIdentifier == "player-preview-attribution"`, rôle `.bodySmall`, couleur
      `rgba == [0xF6, 0xE9, 0xD8, 0xFF]` ; `PlayerNowBarMetrics.previewToggleIdentifier == "player-preview-toggle"`,
      `previewGlyphSize == 14`.
- [ ] `PlayerView.showsPreview(actions: [], preview: link)` → false (genre/label : pas de barre, pas
      d'attribution) ; `(actions: [a], preview: nil)` → false ; `(actions: [a], preview: link)` → true.
- [ ] `PlayerReader` : la ligne et le bouton n'existent que si `showsPreview` ; le `PreviewPlaybackModel` est
      créé une fois par `preview` (pas à chaque redraw) ; `onDisappear` appelle `stop()` ; `scenePhase` →
      `.inactive`/`.background` appelle `sceneBecameInactive()`. (Prouvé par le test UI 3.3 et la revue : pas
      de simulateur en local.)
- [ ] Sans extrait : `PlayerViewTests` et `PlayerNowBarTests` existants passent sans modification de leurs
      attentes ; `testThePlayerNowBarEndsAboveTheTabBar` (UI, existant) passe.
- [ ] `ios-check` vert ; `test/ios-preview-streaming.test.ts` vert.
- [ ] Raphael a lu les conditions Performance Partners et les Identity Guidelines et l'a écrit dans la PR
      (précondition Q11 ; case laissée à Raphael, le merge attend son OK — pas un check CI).

## Tests attendus
- unitaire app (`Track1IconTests`, `PlayerNowBarTests`, `PlayerViewTests`) : les critères ci-dessus.
- UI : 3.3.

## Tier de risque
tier/2 — composant du design system avec état, ouverture d'une URL tierce déjà validée (`providerURL`
`music.apple.com`), effets audio pilotés par le modèle testé en 2.2.

## Notes d'implémentation
- `Text(verbatim:)` pour tout texte du réseau (`trackName` passe par `PlayerView.oneLine`, l.193-203) ;
  la cible du lien est `link.appleURL`, jamais une chaîne.
- L'attribution est visible dès que `preview` existe, quel que soit l'état de lecture (D5, condition iii) ;
  elle disparaît si l'état devient `.failed` ? NON : elle reste tant que `preview` existe (la licence
  s'attache à l'extrait servi, pas au son) ; seul le bouton de la pochette disparaît (`controlLabel` nil).
- Le `VStack` de `bottomBar` (l.297) garde `spacing8` : notice, attribution, barre.
- `.buttonStyle(.plain)` sur la pochette pour ne pas teinter l'image ; glyphe `Track1Icon(.play/.pause,
  color: .primary, size: previewGlyphSize)` sur un `Circle().fill(previewVeil)` de 22 pt centré.
- `@State private var playback` est un `@Observable` : lire `playback.state` dans le corps suffit à
  redessiner.
- Si le diff dépasse 300 lignes : (a) `Track1Icon.pause` + `PlayerNowBar` + ses tests (tier/2),
  (b) `PlayerView` + attribution + ses tests (tier/2) ; (b) dépend de (a).
```

### 3.3 — UI test : l'extrait s'annonce, se met en pause et reprend depuis la pochette

- Tier : **tier/1** · Estimate : **2** · Partie 3 · Dépend de : 3.2

```markdown
## Contexte
Le lecteur joue un extrait avec attribution et bouton lecture/pause (3.2) ; les UI tests tournent sans réseau
ni audio, avec `UITestPreviewEngine` (3.1). Cette tâche prouve le parcours de bout en bout dans `ios-check`
(plan docs/plans/player-audio-preview.md, D6) : la fixture porte un extrait, le lecteur l'annonce, l'appui
bascule les états.

## Portée
Fichiers à modifier (lignes de `origin/main` au 2026-11-28, `e86f046`) :
- `ios/Track1UITests/UITestFlows.swift` — `linksBody` (l.324-330) : ajouter
  `"preview": ["url": "https://audio-ssl.itunes.apple.com/fixture/\(slug).m4a", "apple_url":
  "https://music.apple.com/fr/album/fixture/1?i=2", "track_name": "Fixture Track", "source": "itunes"]` ;
  `static let previewTrackName = "Fixture Track"` à côté de `sourceDomain` (l.309).
- `ios/Track1UITests/TodayFlowTests.swift` — un test après `testTheReaderEndsWithTheSourceOfTheArticleUnderItsLastSentence`
  (l.108), réutilisant `openPlayer()` (l.226) et `element` (l.238).
Hors-scope explicite :
- Toute source de l'app ou du package. `UITestFixtureReaders` (3.1).
- Le son lui-même (pas de simulateur audio en CI) ; le retour (le moteur factice n'expose rien à XCUITest).

## Contrat
    func testTheReaderPlaysThePreviewAndTheCoverPausesAndResumesIt()
    // openPlayer() ; attribution = app.buttons["player-preview-attribution"] exists, label ==
    // "Extrait avec l’aimable autorisation d’iTunes. Écouter Fixture Track sur Apple Music" ; its frame is above
    // app.otherElements["player-now-bar"] (attribution.frame.maxY <= bar.frame.minY) and inside the window ;
    // toggle = app.buttons["player-preview-toggle"] ; toggle.value == "playing" (the fake engine is ready at once,
    // no other audio) ; toggle.tap() → value "paused" (wait ≤ 2 s) ; toggle.tap() → "playing" ; screenshot "3.3-preview".
    // Not tapped: the attribution (Safari would leave the app).

## Critères d'acceptation
- [ ] Le test passe dans `ios-check` sur le nœud du jour (project ou track, qui a une `linksBody`).
- [ ] Les tests UI existants passent sans modification : `testThePlayerNowBarEndsAboveTheTabBar` (la pastille
      n'a pas changé de taille), `testThePlayerStepsOneSentenceAtATimeAndFocusesTheOneAtTheReadingCenter`
      (l'attribution n'est pas un pas), `testTheReaderEndsWithTheSourceOfTheArticleUnderItsLastSentence`.
- [ ] Capture `3.3-preview` attachée.

## Tests attendus
- UI : le test ci-dessus. Attentes avec `waitForExistence(timeout:)` / `XCTNSPredicateExpectation` sur
  `value`, jamais de `sleep` fixe.

## Tier de risque
tier/1 — tests et fixtures seulement.

## Notes d'implémentation
- La fixture `preview` est décodée par le vrai `LinksResponse` : une URL hors hôtes la ferait disparaître
  en silence (pas d'attribution) — c'est voulu, et c'est pourquoi l'hôte de la fixture est
  `audio-ssl.itunes.apple.com`.
- `element(app, …)` lit `descendants(matching: .any)` ; les boutons se lisent par `app.buttons[…]`.
- `ios-check` ne tourne que sur une PR « ready » (`.github/workflows/ios-ci.yml:55`) ; pas de simulateur en
  local (`docs/track1-builds.md:127-134`).
```
