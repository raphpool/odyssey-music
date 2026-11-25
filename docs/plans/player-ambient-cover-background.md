# Player web : fond ambiant de la cover (flou, zoom, dérive lente)

Plan de la phase `plan` du process de livraison, écrit le 2026-11-25 sur le brief de Raphael (page
statique `web/`). **Statut : brouillon, en attente du gate humain.** Aucun ticket Linear n'est créé.

Brief : « répliquer l'effet du background de YouTube quand on lance en Chromecast depuis un mobile vers
l'ordinateur : la cover est zoomée à fond, un layer de blur est apposé dessus, et elle bouge très
lentement. »

Tous les chemins sont relatifs à la racine du dépôt ; les numéros de ligne sont ceux de `0eae87e`
(branche `claude/tender-pascal-rk58tg`, 2026-11-25).

## Problème

1. **Le player n'a aucun rapport visuel avec ce qu'il joue.** `#player` (`web/index.html:92-103`) est une
   barre fixe en bas de page : fond plat `rgba(14,14,13,0.94)` + `backdrop-filter: blur(10px)`
   (`web/styles.css:637-686`), un bouton, le titre, la ligne artiste, la barre de progression. Le
   singleton `Player` (`web/index.html:2706-2809`) ne pose que `titleEl.textContent` et la ligne artiste
   (`playTrack`, l.2761-2763) ; il ne touche jamais à l'image.
2. **La cover est pourtant connue côté client, sans réseau.** Tout nœud projeté porte son `image_url`
   (TRA-455) et `resolveHeroImage(node)` (`web/index.html:142-169`) la résout pour la carte de nœud : pour
   un `track`, sa propre `image_url`, sinon la cover de son projet parent (`edges.project`, l.163). Le
   résultat est déjà filtré par `safeCssUrl` (l.267-280, TRA-495 : URL tierce = donnée non fiable).
3. **Le motif visuel existe déjà dans la carte de nœud.** `.node-tint` + `.node-tint-fade`
   (`web/styles.css:210-232`, « à la YouTube Music ») : copie floutée et saturée de l'image du héros,
   `inset: -60px`, `blur(60px) saturate(1.35)`, opacité 0.55, en `z-index: -2` sous un dégradé sombre
   `z-index: -1`, dans un conteneur `position: relative; overflow: hidden; isolation: isolate` (l.202-208).
   Elle est peinte par `setBgImage` (l.289-294) et insérée dynamiquement par `prepend` (l.445-460). Ce
   qui manque au player, c'est ce calque, plus le **mouvement** : il n'existe aujourd'hui aucune
   `@keyframes`, aucune `animation` ni aucune règle `prefers-reduced-motion` dans `web/`.

## Non-buts

- **Pas de teinte par couleur dominante.** C'est le plan parallèle `player-gradient-tint` (voir Risques :
  mêmes lignes, ordre à trancher).
- Pas de vignette de cover visible dans la barre, pas de refonte du layout du player (bouton, barre,
  comportement mobile `@media (max-width: 600px)`, l.682-686), pas de changement du `.wrap` padding.
- Pas d'appel JIT `/image/:slug` depuis le player : sans cover résolvable côté client, le player garde
  exactement son apparence actuelle.
- Pas d'extraction de couleur ni de `<canvas>` (CORS sur les hôtes d'images), pas de dépendance.
- Pas d'iOS (`AmbientGlow` de Track1 n'est pas concerné).
- Aucun fichier de `scripts/deploy-web.sh`, `deploy/`, `.github/` : le cache-busting de `styles.css`
  (`scripts/deploy-web.sh:89-111`, `?v=$SHA_SHORT`) couvre déjà une feuille modifiée.

## Décisions d'archi

### D1 — Même motif que la carte de nœud : deux calques absolus sous le contenu, `#player` isolé et clippé

Deux enfants sont ajoutés en tête de `#player`, avant `.player-row` : `.player-ambient` (la cover,
`z-index: -2`) et `.player-scrim` (dégradé sombre de lisibilité, `z-index: -1`), tous deux
`position: absolute; pointer-events: none; aria-hidden="true"`. `#player` reçoit `overflow: hidden` et
`isolation: isolate` (comme `.node`, l.206-207) : les calques à z négatif se peignent au-dessus du fond
de `#player` et sous `.player-row` (contenu en flux et `.player-bar` positionné, z auto). Rien ne déborde
de `#player` aujourd'hui (pas de popover, pas d'infobulle) : le clip est sans effet sur l'existant, et
la transition `translateY(110%)` d'ouverture n'est pas affectée.

*Alternatives rejetées :* (a) `background-image` + `filter` directement sur `#player` — le flou
s'appliquerait au texte et aux boutons ; (b) pseudo-éléments `::before/::after` alimentés par une
variable CSS `--player-cover` — évite deux balises, mais sort du chemin `setBgImage` (DOM, pas
d'interpolation HTML) que TRA-495 a durci et que les tests jsdom savent lire ; le motif `.node-tint` est
déjà celui du dépôt.

### D2 — La source de la cover est `resolveHeroImage(node)`, posée de façon synchrone à l'ouverture

Dans `playTrack`, juste après `titleEl.textContent = node.name` (l.2761) et avant `open()` (l.2764), le
player appelle `resolveHeroImage(node)` puis `setBgImage(ambientEl, url)`. La cover apparaît en même
temps que le titre, avant le `fetch` de `/resolve` (l.2766) ; un échec de résolution audio (« playback
unavailable ») la laisse en place, cohérent avec le titre qui reste affiché. Un nœud sans cover
résolvable (ou dont l'URL est refusée par `safeCssUrl`) ne pose rien.

*Alternatives rejetées :* `node.image_url` seul — perd le repli « cover du projet parent » que la carte
de nœud applique déjà au même `track` ; JIT `/image/:slug` — un aller-retour réseau pour un effet
décoratif, et une nouvelle entrée dans `imageJitPromises` hors brief.

### D3 — Deux classes d'état sur `#player`, `has-cover` et `playing`, ciblées par classe de conteneur ; sans cover, apparence inchangée

`has-cover` est posée sur `#player` quand `setBgImage` a accepté une URL, retirée dans `close()` et quand
le titre suivant n'a pas de cover. `.player-ambient` et `.player-scrim` sont à `opacity: 0` par défaut et
passent à leur opacité cible sous `.has-cover > …` (avec `transition: opacity 0.6s` : la cover fond à
l'ouverture). Le fond `rgba(14,14,13,0.94)` et le `backdrop-filter` actuels de `#player` restent tels
quels : ce sont le repli sans cover, pixel pour pixel identique à aujourd'hui.

`playing` suit les écouteurs `play` / `pause` / `ended` déjà en place (l.2787-2792) et est retirée
explicitement dans `close()` ; elle pilote l'animation (D4) via `.playing > .player-ambient`.

Les sélecteurs d'état sont écrits sur les **classes** (`.has-cover > …`, `.playing > …`), pas sur l'id :
`#player` est `position: fixed`, et `web/design.html` ne peut montrer ces états que sur un conteneur
inline qui porte les mêmes classes (D7). Les règles de base (`#player { … }`) gardent l'id.

*Alternative rejetée :* un scrim toujours visible qui remplace le fond de `#player` — soit il est à 0.94
et cache la cover, soit il est à ~0.6 et change l'apparence sans cover.

### D4 — Mouvement : une seule animation CSS composée (transform), en pause hors lecture, désactivée sous `prefers-reduced-motion`

`@keyframes player-ambient-drift` anime `transform` uniquement : dérive horizontale de −2 % à +2 % de la
largeur du calque et zoom de `scale(1.1)` à `scale(1.2)`, 60 s, `ease-in-out`, `infinite alternate`,
`will-change: transform`. Le calque est `inset: -120px` : la marge solide hors du clip reste
≥ 120 px + 3 % de la largeur à tout instant, supérieure à deux fois le rayon de flou (D5), donc aucun
bord ni frange transparente n'entre jamais dans la barre. `background-size: cover` sur une boîte
large et basse (≈ 64 px de haut, pleine largeur) est déjà le « zoom à fond » : on voit une bande
horizontale d'un carré agrandi ≈ 5× sur un écran de 1440 px.

`animation-play-state: paused` par défaut, `running` seulement sous `.playing > .player-ambient` : une
barre ouverte mais en pause, ou fermée, ne consomme rien. Sous `@media (prefers-reduced-motion: reduce)`,
`animation: none` et `transform: scale(1.1)` fixe : la cover floue reste, elle ne bouge plus.

*Alternatives rejetées :* `requestAnimationFrame` en JS — plus de code, pas de `reduced-motion`
gratuit, pas composé ; animer `background-position` — repeint à chaque image au lieu d'une
transformation composée ; animer en continu tant que la barre est ouverte — coût GPU dans un onglet
inactif pour rien (question Q1 au gate).

### D5 — Valeurs de départ chiffrées, ajustables à l'œil ensuite

| Propriété | `.player-ambient` | `.player-scrim` |
|---|---|---|
| position / inset | `absolute; inset: -120px` | `absolute; inset: 0` |
| image | `background-size: cover; background-position: center` | `linear-gradient(to bottom, rgba(5,5,5,0.45) 0%, rgba(5,5,5,0.7) 100%)` |
| filtre | `blur(40px) saturate(1.4)` | — |
| opacité (`.has-cover > …`) | `0.85` (0 sinon, `transition: opacity 0.6s ease`) | `1` (0 sinon, même transition) |
| z-index | `-2` | `-1` |
| animation | `player-ambient-drift 60s ease-in-out infinite alternate`, `paused` hors `.playing` | — |

Le bas du scrim est à 0.7 parce que `.pa` (`var(--muted)` #8a8780, l.659) y est écrit : sur `--card-bg`
(#0e0e0d) il est à ≈ 4.4:1 ; une cover claire floutée sous 0.85 d'opacité et 0.7 de scrim reste plus
sombre que ce fond. Ces chiffres sont posés tels quels par l'implémenteur ; Raphael les ajuste à l'œil
sur `web/design.html` après livraison (Q2) — un ajustement de valeurs est un ticket tier/1 séparé.

*Alternative rejetée :* copier `blur(60px) saturate(1.35) / 0.55` de `.node-tint` — calibré pour une
carte haute de plusieurs centaines de pixels, trop lavé sur une bande de 64 px.

### D6 — Tests : jsdom sur le vrai `web/index.html`, assertions textuelles pour ce que jsdom ne calcule pas

Même harnais que `test/web-hero-image.test.ts` et `test/web-safe-css-url.test.ts` : `JSDOM` sur le vrai
fichier, `runScripts: "dangerously"`, `fetch` stubbé dans `beforeParse`. `Player` est une `const` de
script classique (pas une propriété de `window`) : on l'atteint par `w.eval("Player.playTrack(...)")`,
motif déjà utilisé dans `test/web-image-pending.test.ts:129,156`. L'état lu est le DOM (`classList` de
`#player`, `style.backgroundImage` de `#player-ambient`), jamais un membre interne : l'API publique
de `Player` (`playTrack`, `isPlaying`, `currentTrackId`) ne change pas. Les règles que jsdom n'évalue
pas (`@keyframes`, `animation-play-state`, `prefers-reduced-motion`) sont vérifiées par assertions
textuelles sur `web/styles.css`, comme `test/ci-integrity-job.test.ts` compare des motifs de la CI.

*Alternative rejetée :* tests visuels (Playwright) — aucun outillage dans le dépôt, dépendance majeure
hors brief.

### D7 — `web/design.html` montre l'état `has-cover`, et sa section player devient inspectable

Une troisième « stage » rejoint les deux existantes (`web/design.html:691-722`) : un conteneur inline qui
reproduit le fond de `#player` et porte les classes `has-cover playing`, les deux calques (cover
mzstatic déjà utilisée par la page, l.235) et la même `.player-row` que la stage « playing ». Constat
fait en cartographie : la section porte `id="player"` (l.692) et hérite donc de
`#player { position: fixed; transform: translateY(110%) }` de `styles.css` — elle est hors écran
aujourd'hui. Le ticket renomme l'ancre en `dp-player` (section l.692 et lien de la table des matières
l.102) : deux lignes, nécessaires pour vérifier le rendu de la nouvelle stage. C'est la seule correction
hors brief, et elle ne touche que la page de design.

## Découpage

Une partie, un ticket. Points = estimate Linear.

| # | Tâche | Tier | Pts | Dépend de |
|---|---|---|---|---|
| 1.1 | TRA-? · Web · Poser un fond ambiant flou et dérivant de la cover dans le player | tier/2 | 2 | — |

### Partie 1 — Fond ambiant du player (déployable seule : sans cover, rien ne change)

- [ ] TRA-? 1.1 — `styles.css` : `#player` isolé et clippé, `.player-ambient`, `.player-scrim`, états
  `has-cover` / `playing`, `@keyframes player-ambient-drift`, `prefers-reduced-motion` ; `index.html` :
  deux calques dans le markup, `setAmbientCover` / `clearAmbientCover` dans `Player`, classe `playing`
  sur les écouteurs audio ; `design.html` : stage `has-cover`, ancre `dp-player` ;
  `test/web-player-ambient.test.ts`.

Diff attendu ≈ 40 lignes de CSS, 20 de JS, 25 de HTML de design, 120 de test.

## Risques

- **Coût GPU / batterie.** Un calque pleine largeur flouté à 40 px et animé en continu. Garde-fous : un
  seul calque, `transform` seulement (composé), `will-change`, pause hors lecture (D4), `reduced-motion`.
  À la review : Chrome → Rendering → « Frame rendering stats » pendant une lecture ; si l'onglet
  dépasse ~5 % de CPU au repos sur un portable, baisser `blur` à 24 px ou allonger la durée à 90 s
  (ticket tier/1 de valeurs, pas de changement de structure).
- **Lisibilité de la ligne artiste** (`.pa`, `--muted`) sur une cover très claire. Garde-fou : scrim à
  0.7 en bas (D5). Si insuffisant à l'œil, passer `.pa` à `var(--fg)` avec `opacity: 0.75` sous
  `.has-cover` — à décider par Raphael après avoir vu (Q2), pas par l'implémenteur.
- **Conflit d'ordre avec `player-gradient-tint`.** Les deux plans éditent les mêmes régions :
  `web/styles.css:637-686`, `web/index.html:92-103` et `2706-2809`, `web/design.html:691-722`. Deux PR
  parallèles sur ces lignes se marchent dessus ; l'ordre recommandé est **ambiant d'abord** : il crée
  `.player-scrim`, support naturel d'un dégradé teinté (la teinte s'appliquerait au dégradé du scrim,
  pas au fond de `#player`). Si la teinte arrive d'abord, ce ticket se rebase et pose son scrim sur le
  dégradé existant. Il faut aussi trancher si la teinte s'applique par-dessus la cover floue (effet
  cumulé, risque de lavage) ou seulement en repli sans cover (Q3).
- **jsdom et `<audio>`.** `HTMLMediaElement.prototype.play/pause/load` ne sont pas implémentés : jsdom
  logue « Not implemented » sans lever. Le test les remplace par des stubs dans `beforeParse` (ou
  `vi.spyOn` sur le prototype) pour un run silencieux ; `play` doit retourner une promesse résolue car
  `playTrack` fait `await audio.play()` (l.2771).
- **`fetch` à deux usages dans le test.** Le harnais existant répond la même chose à toutes les requêtes ;
  ici `data.json` doit rendre les nœuds et `/resolve/:id` un `{ videoId }`. Le stub dispatche sur l'URL.
- **Safari.** `inset`, `filter`, `isolation`, `will-change` sont supportés (Safari ≥ 14.1). Le
  `backdrop-filter` de `#player` (l.641) n'a pas son préfixe `-webkit-` — préexistant, hors scope,
  et sans incidence sous une cover opaque.
- **Cache CSS 4 h chez Cloudflare.** Déjà traité par `?v=$SHA_SHORT` dans `scripts/deploy-web.sh:109` ;
  aucune action.

## Critères de sortie

- En lecture d'un titre dont la cover est résolvable côté client, la barre du player montre la cover
  floutée, zoomée, dérivant lentement sous un dégradé sombre ; titre et ligne artiste restent lisibles.
- Sans cover résolvable, la barre est identique à aujourd'hui (fond 0.94 + `backdrop-filter`).
- Fermer le player retire la cover ; passer à un titre sans cover la retire aussi ; mettre en pause
  arrête le mouvement ; `prefers-reduced-motion: reduce` donne une cover floue immobile.
- Une URL d'image hostile (TRA-495) ne pose ni image ni attribut `on*`.
- `web/design.html#dp-player` montre les trois états (sans cover, en lecture, `has-cover`).
- `npm run check` vert ; `test/web-player-ambient.test.ts` couvre chaque critère d'acceptation du ticket.

## Questions ouvertes pour le gate

- **Q1 — Mouvement hors lecture.** Recommandé : en pause quand l'audio est en pause ou la barre fermée
  (D4). Alternative : continu tant que la barre est ouverte, comme l'écran Chromecast.
- **Q2 — Intensité.** Les valeurs de D5 sont des valeurs de départ ; l'implémenteur les pose telles
  quelles et Raphael ajuste à l'œil sur `design.html` dans un ticket tier/1 séparé. OK ?
- **Q3 — Ordre avec `player-gradient-tint`.** Ambiant d'abord, teinte sur le scrim ensuite ? Et la
  teinte s'applique-t-elle par-dessus la cover floue ou seulement en repli sans cover ?
- **Q4 — Tier.** tier/2 (chemin « URL tierce → CSS », même via `setBgImage`, et nouvel état dans le
  singleton) plutôt que tier/1 (styles isolés). À confirmer.
- **Q5 — Mobile.** Même effet sur téléphone (par défaut oui ; la pause hors lecture limite la batterie).
  Veux-tu le couper sous `max-width: 600px` ?

## Tickets (brouillon, format `ticket-template.md`)

### TRA-? (1.1) — Poser un fond ambiant flou et dérivant de la cover dans le player web

- Tier : **tier/2** · Estimate : **2** · Partie 1 · Labels : `tier/2`

```markdown
## Contexte
Le player fixe en bas de page (`#player`) a un fond plat sans rapport avec le titre joué. Comme
l'écran Chromecast de YouTube, il doit montrer la cover du titre zoomée à fond, floutée, dérivant très
lentement sous un dégradé sombre, et redevenir exactement ce qu'il est aujourd'hui quand aucune cover
n'est connue. La cover est déjà résolue côté client par `resolveHeroImage(node)` et posée en CSS par
`setBgImage` ; le motif visuel est celui de `.node-tint` sur la carte de nœud.
Plan : docs/plans/player-ambient-cover-background.md#partie-1 (D1 à D7).

## Portée
Fichiers à modifier (chemins et lignes vérifiés sur `0eae87e`) :
- `web/styles.css` — bloc `#player` l.637-686 : ajouter `overflow: hidden; isolation: isolate;` à
  `#player` (l.638-647) ; après l.681 (`body.player-open .wrap`), avant le `@media (max-width: 600px)`
  l.682 : règles `.player-ambient`, `.player-scrim`, `.has-cover > .player-ambient`,
  `.has-cover > .player-scrim`, `.playing > .player-ambient`, `@keyframes player-ambient-drift`,
  `@media (prefers-reduced-motion: reduce)`. Commentaire d'en-tête de bloc en anglais, daté, qui renvoie
  au motif `.node-tint` (l.210-232).
- `web/index.html` — l.92-93 : insérer, en premiers enfants de `#player` avant `.player-row`,
  `<div class="player-ambient" id="player-ambient" aria-hidden="true"></div>` puis
  `<div class="player-scrim" aria-hidden="true"></div>` ; l.2711-2718 : `const ambientEl =
  document.getElementById("player-ambient")` ; deux fonctions privées `setAmbientCover(node)` et
  `clearAmbientCover()` dans l'IIFE ; `playTrack` : appel de `setAmbientCover(node)` entre l.2761
  (`titleEl.textContent = node.name`) et l.2764 (`open()`) ; `close()` l.2723-2728 : `clearAmbientCover()`
  et `root.classList.remove("playing")` ; écouteurs l.2787-2792 : `root.classList.add("playing")` sur
  `play`, `remove` sur `pause` et `ended`. Mettre à jour le commentaire d'en-tête l.2706-2709.
- `web/design.html` — l.102 : `href="#player"` → `href="#dp-player"` ; l.692 : `id="player"` →
  `id="dp-player"` (la section héritait de `#player { position: fixed; transform: translateY(110%) }`
  et était hors écran) ; après la stage l.709-721 : une troisième `.dp-stage`
  `data-label="#player.open.has-cover.playing · ambient cover"` dont le conteneur inline porte
  `class="has-cover playing"` et `style="position: relative; overflow: hidden; isolation: isolate;
  background: rgba(14, 14, 13, 0.94); border-top: 1px solid var(--card-border);"`, puis dans l'ordre :
  `<div class="player-ambient" style="background-image: url('<URL mzstatic de la l.235>');"></div>`,
  `<div class="player-scrim"></div>`, et la même `.player-row` que la stage « playing » (l.711-719).
- `test/web-player-ambient.test.ts` — nouveau, sur le modèle de `test/web-hero-image.test.ts`.
Hors-scope explicite :
- Toute autre règle de `#player` (layout, mobile l.682-686, `.player-bar`, `.player-btn`), `.wrap`.
- `resolveHeroImage`, `safeCssUrl`, `setBgImage`, `jitResolveImage` : on les appelle, on ne les change pas.
- Teinte par couleur dominante (plan `player-gradient-tint`), vignette de cover, JIT `/image`.
- `scripts/deploy-web.sh`, `deploy/`, `.github/`, `src/`, `ios/`. Aucune dépendance.
- Le `backdrop-filter` sans préfixe `-webkit-` de `#player` (préexistant).

## Contrat
DOM (markup statique, `web/index.html`) :
    #player
      > .player-ambient#player-ambient[aria-hidden=true]   (new, first child)
      > .player-scrim[aria-hidden=true]                    (new)
      > .player-row                                        (unchanged)
      > audio#player-audio                                 (unchanged)
Classes d'état sur `#player` : `open` (existante), `has-cover` (nouvelle : une cover est posée),
`playing` (nouvelle : l'audio joue).
`Player` (IIFE, `web/index.html`), fonctions privées — l'objet retourné (`playTrack`, `isPlaying`,
`currentTrackId`) ne change pas :
    // resolveHeroImage(node) -> setBgImage(ambientEl, url). Adds `has-cover` and returns true when a
    // cover was set; otherwise clears any previous cover (clearAmbientCover) and returns false.
    function setAmbientCover(node): boolean
    // Removes `has-cover`, sets ambientEl.style.backgroundImage = "".
    function clearAmbientCover(): void
CSS (`web/styles.css`), sélecteurs et valeurs — les états sont ciblés par classe de conteneur, pas par
l'id, pour que `design.html` puisse les reproduire (plan D3) :
    #player                                { + overflow: hidden; isolation: isolate; }
    .player-ambient                        { position: absolute; inset: -120px; z-index: -2;
                                             pointer-events: none; background-size: cover;
                                             background-position: center;
                                             filter: blur(40px) saturate(1.4);
                                             opacity: 0; transition: opacity 0.6s ease;
                                             will-change: transform;
                                             animation: player-ambient-drift 60s ease-in-out infinite alternate;
                                             animation-play-state: paused; }
    .has-cover > .player-ambient           { opacity: 0.85; }
    .playing > .player-ambient             { animation-play-state: running; }
    .player-scrim                          { position: absolute; inset: 0; z-index: -1; pointer-events: none;
                                             background: linear-gradient(to bottom, rgba(5,5,5,0.45) 0%, rgba(5,5,5,0.7) 100%);
                                             opacity: 0; transition: opacity 0.6s ease; }
    .has-cover > .player-scrim             { opacity: 1; }
    @keyframes player-ambient-drift        { from { transform: translate3d(-2%, 0, 0) scale(1.1); }
                                             to   { transform: translate3d(2%, 0, 0) scale(1.2); } }
    @media (prefers-reduced-motion: reduce) { .player-ambient { animation: none; transform: scale(1.1); } }
Ces valeurs sont celles du plan (D5) : les poser telles quelles, ne pas les « améliorer ».

## Critères d'acceptation
Dans `test/web-player-ambient.test.ts` (jsdom sur le vrai `web/index.html`, `Player` atteint par
`w.eval(...)`, `fetch` stubbé par URL : `data.json` → nœuds du test, `/resolve/` → `{ videoId: "v" }` ;
`HTMLMediaElement.prototype.play` stubbé en `() => Promise.resolve()`, `pause`/`load` en no-op) :
- [ ] A — `Player.playTrack(track)` avec `track.image_url` https valide : **sans attendre** la promesse,
      `#player.classList` contient `open` et `has-cover`, et `#player-ambient.style.backgroundImage`
      vaut `url('<href canonique>')`.
- [ ] B — `track` sans `image_url`, `edges.project = { slug: "project:x", name }` et `project:x` dans
      les données avec `image_url` : la cover posée est celle du projet.
- [ ] C — `track` sans `image_url` ni projet imageable : `open` présent, `has-cover` absent,
      `backgroundImage === ""`.
- [ ] D — `track.image_url = 'https://upload.wikimedia.org/a"onmouseover="alert(1)//'` (EVIL de
      `test/web-safe-css-url.test.ts`) : pas de `has-cover`, `backgroundImage === ""`, aucun attribut
      `on*` dans le document (réutiliser le helper `eventHandlerAttrs`).
- [ ] E — après A, clic sur `#player-close` : `has-cover` et `playing` absents, `backgroundImage === ""`.
- [ ] F — après A, `playTrack` d'un second titre avec une autre cover remplace l'image ; d'un troisième
      sans cover la retire (`has-cover` absent, `backgroundImage === ""`).
- [ ] G — `dispatchEvent(new Event("play"))` sur `#player-audio` ajoute `playing` ; `pause` puis
      `ended` le retirent.
- [ ] H — `#player` a deux premiers enfants `.player-ambient#player-ambient[aria-hidden="true"]` et
      `.player-scrim[aria-hidden="true"]`, avant `.player-row`.
- [ ] I — texte de `web/styles.css` : contient `@keyframes player-ambient-drift`, une règle
      `.player-ambient` avec `animation: player-ambient-drift` et `animation-play-state: paused`, une
      règle `.playing > .player-ambient` avec `animation-play-state: running`, un bloc
      `@media (prefers-reduced-motion: reduce)` qui contient `.player-ambient` et `animation: none`,
      et la règle `#player` contient `overflow: hidden` et `isolation: isolate`.
- [ ] J — texte de `web/design.html` : `id="dp-player"`, `href="#dp-player"`, aucun `id="player"`, et
      une `.dp-stage` contenant `class="player-ambient"` et `class="player-scrim"`.
- [ ] `npm run check` vert ; les tests `web-*.test.ts` existants inchangés et verts.

## Tests attendus
- unitaire (jsdom) : A à H ci-dessus, un `it` par lettre ; nominal (A, B, G), limite (C, F), erreur (D).
- textuel : I et J (lecture de `web/styles.css` et `web/design.html` par `readFileSync`, comme les
  autres tests `web-*` lisent `web/index.html`).
- Pas de test visuel : vérification à l'œil par Raphael sur `web/design.html#dp-player` et en lecture
  réelle après déploiement.

## Tier de risque
tier/2 — nouvel état dans le singleton `Player` et chemin « URL tierce → CSS » (via `setBgImage`,
TRA-495) ; couvert par des tests jsdom, pas de chemin sensible touché.

## Notes d'implémentation
- Reprendre le motif `.node-tint` / `.node-tint-fade` (`web/styles.css:210-232`, `web/index.html:445-460`)
  mais avec les valeurs du Contrat (D5), pas celles de la carte : la carte est haute, la barre fait 64 px.
- Les règles d'état sont sur `.has-cover > …` et `.playing > …` (classes posées sur `#player` par le JS)
  pour que `design.html` puisse les reproduire sur un conteneur inline ; `#player` lui-même garde son
  fond et son `backdrop-filter` comme repli sans cover (D3).
- `setAmbientCover` quand `resolveHeroImage` rend `null` ou `setBgImage` rend `false` : appeler
  `clearAmbientCover()` (un titre sans cover après un titre avec cover doit nettoyer, critère F).
- `playing` : poser dans l'écouteur `play` existant (l.2787), retirer dans `pause` (l.2788) et `ended`
  (l.2789-2792), et dans `close()` sans attendre l'événement `pause` asynchrone.
- Convention du dépôt : commentaires en anglais ; un commentaire qui pose une règle visuelle dit
  pourquoi (« inset -120px: the solid margin stays above twice the blur radius while the layer drifts »).
- `web/` n'est pas dans `files.includes` de `biome.json` : CSS/HTML non formatés par Biome ; garder le
  style de `styles.css` (2 espaces). Le test, lui, est formaté par Biome (tabs, guillemets doubles).
- jsdom : attendre le chargement des données avant `playTrack` (même attente que
  `test/web-hero-image.test.ts`) ; `w.eval("byId.size")` > 0.
- Ne pas exposer `setAmbientCover` / `clearAmbientCover` dans l'objet retourné par `Player`.
- Coordination : si une PR de `player-gradient-tint` est ouverte sur `#player`, faire un update-branch
  sur `main` juste avant le merge ; en cas de conflit sur le bloc `#player`, garder les deux calques et
  poser la teinte sur `.player-scrim` (plan, Risques).
- Commits conventionnels, `Refs TRA-?` ; PR titrée `TRA-? …`, `Fixes TRA-?`.
```
