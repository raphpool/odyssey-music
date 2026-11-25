# Fond du lecteur : teinte plus forte, foncé plus tard

Plan rédigé le 2026-11-25 (phase `plan` du delivery-process), amendé le même jour après les décisions
de Raphael (voir « Décisions de Raphael »). Brief : « le background linéaire du player devrait être
encore davantage teinté par la couleur dominante de la cover ; le dégradé doit tendre beaucoup plus
tard vers le foncé ».

## Problème

Le lecteur (`PlayerView`, iOS) peint derrière les phrases un dégradé linéaire vertical construit par
`PlayerMetrics.tintStops(_:)` dans `ios/Track1/Features/Node/PlayerView.swift` :

- un cadre de 2064 pt (`tintHeight`, Figma `338:2463`) ancré en haut de l'écran, fixe pendant le
  défilement ;
- trois stops couleur à 0, 5 et 10 % du cadre (`tintPositions`), soit 0, 103 et 206 pt ;
- `Track1Tokens.colorBackgroundElevated` (`0x1A110E`) dès 15 % (`tintEndpoint`), soit 310 pt.

Sur l'écran de référence (844 pt), le fond est donc **déjà entièrement foncé au tiers supérieur**,
au-dessus du centre de lecture (387 pt). Et les trois couleurs sont celles de `CoverTintTone`
(`ios/Track1Core/Sources/Track1Core/Media/CoverTint.swift`) : luminosité HSB imposée à
0,33 / 0,27 / 0,20 et saturation plafonnée à 0,35, un « sol sombre et peu contrasté » conçu pour la
fiche nœud, pas pour un lecteur plein écran. Résultat : la cover teinte à peine le lecteur.

Deux axes, indépendants l'un de l'autre :

1. **Géométrie** — repousser le passage au foncé bien plus bas dans l'écran.
2. **Ton** — rendre les trois stops plus lumineux et plus saturés, donc plus proches de la couleur de
   la cover.

Contraintes constatées dans le code :

- Le `CoverTint` du lecteur est calculé une fois dans `NodeHeroModel.load()`
  (`ios/Track1/Media/NodeHeroModel.swift`, l. 50) et partagé par la fiche nœud et la carte de contenu.
  Toute modification des constantes de `CoverTintTone` changerait ces surfaces.
- Au moment d'écrire ce plan, `TodayHomeMetrics` (`ios/Track1/Features/Today/TodayHomeView.swift`,
  l. 37-43) **réutilise** `PlayerMetrics.tintStops` et `PlayerMetrics.tintHeight` pour le fond de la
  home. Ce couplage disparaît avec le ticket 1.2 du plan `home-ambient-cover-background`, qui
  remplace le dégradé de la home par un fond ambiant et supprime `TodayHomeMetrics.tintHeight` /
  `tintStops`. Ce plan s'exécute **après** ce ticket (voir « Relation avec
  `home-ambient-cover-background` ») ; il n'a donc rien à faire côté Today.

## Non-buts

- Changer le fond de la fiche nœud (`CoverTintGradient`, Figma `282:837`) ou de la carte de contenu
  (`285:1034`). Ces deux surfaces doivent rester **pixel pour pixel identiques**.
- Toucher à la home (`TodayHomeView`, `TodayView`) : son fond est le sujet du plan
  `docs/plans/home-ambient-cover-background.md`, et il n'a plus de dégradé une fois son ticket 1.2
  mergé. Aucun fond ambiant n'est prévu pour le lecteur : le dégradé reste son seul fond.
- Modifier l'échantillonnage de la cover (`DominantColor.bands(of:)`, tiers haut/milieu/bas) ou
  stocker une couleur dans le pipeline / le schéma (décision D10 du plan natif : la couleur se
  calcule sur le téléphone).
- Toucher au masque de fondu des paragraphes (`PlayerMetrics.fadeStops`), à la barre Now, au
  bouton retour ou au défilement.
- Généraliser `CoverTintGradient` (voir D5).
- Mettre à jour Figma. Le code documentera l'écart avec le ticket et la date, comme le fait déjà
  l'en-tête de `PlayerMetrics` (« The ticket wins »).

## Décisions d'archi

### D1 — Le lecteur a son propre ton ; la fiche nœud et la carte gardent le leur
Le ton actuel (`CoverTintTone`) est une spec validée pour la fiche nœud (références Cosmogramma,
annexe A.2 du plan natif) et il est testé à la couleur près (`CoverTintTests`). Le lecteur reçoit
une **seconde échelle** de luminosité/saturation ; l'échelle existante ne bouge pas. La home n'est
pas concernée : après le ticket 1.2 du plan home-ambient, elle n'a plus de dégradé.
*Alternative rejetée :* relever les constantes de `CoverTintTone` pour tout le monde. Changerait
la fiche et la carte que le brief ne nomme pas, et casserait leurs références Figma.

### D2 — L'échelle est un paramètre de `CoverTintTone`, dans `Track1Core`
`CoverTintTone` gagne un type valeur `Scale` (luminosité des trois stops + plafond de saturation)
avec deux valeurs nommées : `.page` (les constantes actuelles, à l'identique) et `.player`.
`tint(bands:)` devient `tint(bands:scale:)` avec `.page` par défaut, donc **aucun appelant existant
ne change de comportement**. Les constantes statiques `stopBrightness` / `saturationMax` restent
exposées comme alias de `.page` (lues par `NodePageView.pageTint` et par `NodePageViewTests`).
Le code vit dans le package : c'est la seule logique Swift testable en local
(`swift test --package-path ios/Track1Core`), et les valeurs sont **absolues et lisibles** en un
seul endroit, ce que Raphael réglera sur appareil.
*Alternative rejetée :* une transformation « boost » appliquée au `CoverTint` déjà calculé (gain de
saturation et de luminosité). Diff plus petit, mais le plafond à 0,35 a déjà écrasé la saturation :
une cover vive et une cover terne donneraient le même résultat, et les réglages seraient des gains
relatifs, pas des valeurs.

### D3 — L'écran propriétaire choisit l'échelle à la création de son `NodeHeroModel`
`PlayerView` construit déjà son propre `NodeHeroModel` (`PlayerView.swift`, l. 242) et le modèle
est documenté comme « un modèle par nœud, possédé par la vue ». `NodeHeroModel.init` prend un
paramètre `scale: CoverTintTone.Scale = .page` et `load()` le passe à `tint(bands:scale:)`.
L'énumération `State` ne change pas ; `NodePageView.coverTint(for:)` ne change pas ; `TodayView`
(qui crée aussi un modèle, l. 147, pour l'image de la cover) ne change pas.
*Alternative rejetée :* faire porter les trois bandes brutes par `State.loaded` et laisser chaque
surface dériver son ton. Plus général, mais touche l'énumération utilisée par trois écrans et leurs
tests pour le même résultat ; on y reviendra si une surface a un jour besoin de deux tons.
*Alternative rejetée :* recalculer `DominantColor.bands(of:)` dans la vue du lecteur. Refait la
réduction 32 × 32 et trois `CIAreaAverage` à chaque évaluation du `body`.

### D4 — La géométrie reste en fractions du cadre de 2064 pt ; seules les valeurs changent
`PlayerMetrics.tintPositions` et `tintEndpoint` restent des fractions de `tintHeight` (convention
Figma en place). Valeurs de départ, validées par Raphael le 2026-11-25, à régler sur appareil :

| Constante | Avant | Après | En points (cadre 2064) |
| --- | --- | --- | --- |
| `tintPositions` | `[0, 0.05, 0.10]` | `[0, 0.15, 0.30]` | 0 / 310 / 619 |
| `tintEndpoint` | `0.15` | `0.45` | 929 |
| `tintHeight` | `2064` | `2064` | — |

Le foncé plat n'est atteint qu'à 929 pt, **sous le bas de l'écran de référence** (844 pt) : tout
l'écran reste teinté, la barre Now (≈ 694-749 pt) se pose sur un ton encore coloré, à mi-chemin
entre le troisième stop et le foncé.
*Alternative rejetée :* exprimer les stops en points de l'écran visible (hauteur du
`GeometryReader`). Le dégradé s'étirerait avec la taille d'écran et romprait la convention du cadre
Figma.
*Alternative rejetée :* supprimer le point de fin foncé. Le fond ne rejoindrait jamais le token
`background.elevated` et la barre Now flotterait sur un ton moyen.

### D5 — `PlayerMetrics` garde son propre constructeur de stops ; `CoverTintGradient` n'est pas touché
Après le ticket 1.2 du plan home-ambient, `PlayerMetrics.tintStops` n'a plus qu'un appelant : le
lecteur. T1 change donc **deux constantes et un commentaire**, rien d'autre. `CoverTintGradient`
(fiche nœud et carte, positions fixées par `CoverTintTone`) reste tel quel.
*Alternative rejetée (version initiale de ce plan) :* un constructeur paramétré dans
`CoverTintGradient`, partagé par la fiche, le lecteur et la home, et la recopie des constantes
actuelles dans `TodayHomeMetrics` pour que la home garde son rendu. N'avait de sens qu'avec trois
appelants ; la home n'en est plus un. Cette version ne survit que comme **repli** si l'ordre des
tickets s'inverse (voir « Relation avec `home-ambient-cover-background` »).

## Découpage

Une seule partie : les deux tâches sont indépendantes l'une de l'autre, déployables seules et
jugeables séparément sur appareil (un axe du brief chacune).

### Partie 1 — Fond du lecteur

- [ ] TRA-831 **Retarder le passage au foncé du dégradé du lecteur** (axe géométrie, D4 + D5) —
  `PlayerMetrics` et son test. tier/1, 1 point. **Après** le ticket 1.2 de
  `home-ambient-cover-background`.
- [ ] TRA-832 **Teinter davantage le fond du lecteur avec la couleur de la cover** (axe ton,
  D1 + D2 + D3) — `CoverTintTone.Scale` dans `Track1Core`, `NodeHeroModel(scale:)`,
  `NodePageView.pageTint(scale:)`, `PlayerView`, et leurs tests. tier/2, 3 points. Aucune dépendance.

**T1 et T2 sont parallélisables** entre eux (worktrees simultanés). Zones de contact : les deux
touchent `ios/Track1/Features/Node/PlayerView.swift` (T1 : bloc de constantes l. 40-60 ; T2 : l. 242
et l. 246) et `ios/Track1Tests/Node/PlayerViewTests.swift` (T1 : réécrit le test existant
`testTheBackgroundIsTheCoverBandsAt0And5And10PercentThenTheElevatedColour` ; T2 : ajoute un test).
Hunks disjoints ; le second mergé rebase.

## Relation avec `home-ambient-cover-background`

Le plan `docs/plans/home-ambient-cover-background.md` remplace le dégradé de la home par la cover
floutée, zoomée et en dérive lente. Raphael a validé le 2026-11-25 que ce fond **remplace** le
dégradé (décision D1 de ce plan-là) : son ticket 1.2 supprime `TodayHomeMetrics.tintHeight` /
`tintStops` et le paramètre `tint` de `TodayHomeView`. Le fond ambiant est pour la home seulement ;
le lecteur garde son dégradé, qui reste **opaque** (`CoverTintGradient` et `PlayerMetrics` ne
fondent jamais vers la transparence ; rien ici ne change ce contrat).

**Ordre validé : home 1.2 avant T1.** Une fois 1.2 mergé, `TodayHomeView.swift` ne mentionne plus
`PlayerMetrics` et T1 se réduit à `PlayerMetrics` et `PlayerViewTests`.

**Repli si l'ordre s'inverse** (T1 démarre alors que `TodayHomeView.swift` contient encore
`PlayerMetrics`) : changer les constantes du lecteur changerait le fond de la home et casserait
`TodayHomeViewTests.testTheBackgroundIsTheFourStopGradientOfTheReader` (l. 125-136, qui asserte
`[0, 0.05, 0.10, 0.15, 1]`) dans `ios-check`. L'implémenteur de T1 attend 1.2 ; s'il faut vraiment
passer avant, T1 reprend la version initiale de D5 : `TodayHomeMetrics` reçoit ses propres
`tintHeight = 2064`, `tintPositions = [0, 0.05, 0.10]`, `tintEndpoint = 0.15` et construit ses stops
sans `PlayerMetrics` ; le test Today est réécrit avec ces valeurs en dur ; l'estimate revient à
2 points. Le ticket 1.2 supprimera ensuite ces lignes (conflit textuel seulement, l. 37-43 et
l. 125-136, le second mergé rebase).

**T2 n'a aucun contact** avec le plan home : `NodeHeroModel.init(scale:)` a une valeur par défaut,
`TodayView.swift` l. 147 continue de compiler sans changement, et `NodePageView.pageTint` n'est pas
appelé par la home.

## Risques

| Risque | Garde-fou |
| --- | --- |
| Lisibilité des phrases non focalisées (`colorTextTertiary`) sur un fond plus clair et plus saturé en haut de colonne. | Le masque `fadeStops` rend les phrases transparentes jusqu'à 52 pt et opaques seulement à 212 pt ; la colonne de lecture est au centre (387 pt), déjà sur le 2ᵉ/3ᵉ stop. Le test de T2 impose des stops strictement décroissants en luminosité. Réglage sur appareil : une seule constante (`Scale.player`). |
| T1 mergé avant home 1.2 : la home prend les nouvelles positions du lecteur et son test casse dans `ios-check`. | Précondition explicite dans le ticket T1 (`TodayHomeView.swift` ne mentionne plus `PlayerMetrics`) et repli documenté ci-dessus. |
| Régression du ton de la fiche nœud et de la carte. | `CoverTintTests.testCosmogrammaBandsGiveTheFigmaReferenceStopsAndShadow` inchangé ; `tint(bands:)` sans argument reste `.page` ; `NodePageViewTests` l. 82 continue d'asserter `[0.33, 0.27, 0.20]` ; `CoverTintGradient` non modifié. |
| Les tests de la cible app (`Track1Tests`) ne tournent que dans `ios-check` (runner `macos-26`) : un agent cloud ne peut pas les lancer. | La logique de T2 est dans `Track1Core` (`swift test` en local). Le test de T1 est une assertion de valeurs. Lire les annotations `::error::` du run `ios-check` (max 10 affichées). |
| `swift-format` strict (tabs, 110 colonnes) et la garde vitest `test/ios-design-tokens.test.ts` (aucune couleur brute dans `Features/`). | Aucune couleur brute à écrire : les stops passent par `Color(_ rgb: LinearRGB)` existant et le token `colorBackgroundElevated`. |
| Conflit textuel entre T1 et T2 dans `PlayerView.swift` / `PlayerViewTests.swift`. | Hunks disjoints (voir Découpage) ; le second mergé rebase. |

## Critères de sortie

- `PlayerMetrics.tintStops` renvoie des positions `[0, 0.15, 0.30, 0.45, 1]` et
  `tintEndpoint × tintHeight > 844` (le foncé est atteint sous l'écran de référence).
- `CoverTintTone.tint(bands:)` donne exactement les couleurs d'avant (test Cosmogramma inchangé) ;
  `tint(bands:scale: .player)` donne des stops de luminosité `[0.46, 0.38, 0.30]` et de saturation
  plafonnée à `0.60`.
- Le lecteur utilise `.player` pour la cover **et** pour le repli sans cover (couleur du type) ;
  la fiche nœud et la carte utilisent `.page` et `CoverTintGradient` n'a pas changé.
- `swift test --package-path ios/Track1Core` et le job `ios-check` sont verts ; `npm run check`
  vert (garde des couleurs brutes).
- Raphael a vu les deux tickets sur appareil (build de dev ou TestFlight) et validé ou ajusté les
  constantes `tintPositions` / `tintEndpoint` / `Scale.player`. Un ajustement de valeurs est un
  commit de suivi sur le même ticket, pas un nouveau plan.

## Décisions de Raphael (2026-11-25)

Questions ouvertes de la première version du plan, toutes tranchées dans la conversation principale :

1. « Encore davantage teinté » = **luminosité + saturation** des stops, en plus de la géométrie.
   T2 conservé.
2. Valeurs de départ **telles quelles** (`[0, 0.15, 0.30]` / `0.45` ; `.player` = `[0.46, 0.38, 0.30]`
   / `0.60`), à régler sur appareil.
3. Today : la question « Today suit-il le lecteur ? » n'a plus d'objet. Le fond de la home est
   **remplacé** par le fond ambiant (plan `home-ambient-cover-background`, ticket 1.2).
4. **Deux tickets**, un par axe.
5. Ordre : **home 1.2 avant T1** ; T2 libre. Le fond ambiant est pour la home, pas pour le lecteur.

## Annexe — Brouillons de tickets

### T1 — Retarder le passage au foncé du dégradé du lecteur

**Contexte.** Le fond du lecteur devient `background.elevated` dès 15 % de son cadre de 2064 pt
(310 pt), au-dessus du centre de lecture. Il doit rester teinté sur tout l'écran et n'atteindre le
foncé que sous le bas de l'écran. Plan : `docs/plans/player-gradient-tint.md#partie-1--fond-du-lecteur`,
décisions D4, D5. Dépend du ticket 1.2 de `docs/plans/home-ambient-cover-background.md` (voir
Précondition).

**Précondition.** `ios/Track1/Features/Today/TodayHomeView.swift` ne contient plus la chaîne
`PlayerMetrics` (le ticket 1.2 du plan home-ambient a supprimé `TodayHomeMetrics.tintHeight` /
`tintStops`). Si elle y est encore : attendre 1.2. S'il faut absolument passer avant, appliquer le
repli décrit dans les Notes ; l'estimate passe alors à 2.

**Portée.**
- `ios/Track1/Features/Node/PlayerView.swift` — `PlayerMetrics.tintPositions` et `tintEndpoint`
  (l. 43-44) ; le commentaire du bloc (l. 40-41, « the three cover bands at 0, 5 and 10 %, then
  `background.elevated` from 15 % ») réécrit avec les nouvelles valeurs, la date et l'ID du ticket.
  `tintStops` et `tintHeight` ne changent pas.
- `ios/Track1Tests/Node/PlayerViewTests.swift` —
  `testTheBackgroundIsTheCoverBandsAt0And5And10PercentThenTheElevatedColour` (l. 87-98) renommé et
  réécrit ; un test ajouté pour le foncé sous l'écran.
- Hors scope : `CoverTintGradient`, `CoverTintTone`, `NodeHeroModel`, `NodePageView`,
  `TodayHomeView`, `TodayView`, `fadeStops`, la barre Now, Figma, les couleurs des stops (T2).

**Contrat.**
- `PlayerMetrics.tintPositions: [CGFloat] = [0, 0.15, 0.30]`
- `PlayerMetrics.tintEndpoint: CGFloat = 0.45`
- `PlayerMetrics.tintHeight: CGFloat = 2064` (inchangé)
- `PlayerMetrics.tintStops(_ tint: CoverTint) -> [Gradient.Stop]` (signature et construction
  inchangées : trois stops couleur aux `tintPositions`, puis `colorBackgroundElevated` à
  `tintEndpoint` et à `1`).

**Critères d'acceptation.**
- [ ] `PlayerMetrics.tintStops(tint).map(\.location) == [0, 0.15, 0.30, 0.45, 1]` ; les trois
      premières couleurs sont `Color(tint.stops[i])`, les deux dernières `colorBackgroundElevated`
      (`[0x1A, 0x11, 0x0E, 0xFF]`), `tintHeight == 2064`.
- [ ] `PlayerMetrics.tintEndpoint * PlayerMetrics.tintHeight > PlayerMetrics.designHeight` (844).
- [ ] `PlayerMetrics.tintPositions` est strictement croissant et son dernier élément est
      `< tintEndpoint`.
- [ ] Le commentaire l. 40-41 ne mentionne plus « 0, 5 and 10 % » ni « from 15 % » ; il porte la
      date et l'ID du ticket.
- [ ] `git diff --stat` ne touche que les deux fichiers de la Portée.
- [ ] `ios-check` vert.

**Tests attendus.** Unitaires XCTest (`Track1Tests`, `PlayerViewTests`) : positions et couleurs des
cinq stops ; foncé atteint sous 844 pt ; positions croissantes sous le point de fin. Pas de test
d'intégration.

**Tier.** tier/1 — constantes de style isolées, composant présentationnel sans état.
**Estimate :** 1.

**Notes.** Les valeurs `[0, 0.15, 0.30]` / `0.45` sont la décision D4, validée par Raphael le
2026-11-25 : ne pas rediscuter, il règle sur appareil. Aucune couleur brute dans `Features/`
(`test/ios-design-tokens.test.ts`). `swift-format` strict, tabs, 110 colonnes. Les tests app ne
tournent que dans `ios-check` (runner `macos-26`) : pousser la PR et lire les annotations
`::error::`. Commentaires en anglais.
*Repli si la précondition n'est pas remplie et qu'on ne peut pas attendre :* ajouter à
`TodayHomeMetrics` (`TodayHomeView.swift`, l. 37-43) `tintHeight: CGFloat = 2064`,
`tintPositions: [CGFloat] = [0, 0.05, 0.10]`, `tintEndpoint: CGFloat = 0.15`, et faire construire
`tintStops(_:)` localement (trois stops couleur puis `colorBackgroundElevated` à `0.15` et `1`)
sans appeler `PlayerMetrics` ; réécrire
`TodayHomeViewTests.testTheBackgroundIsTheFourStopGradientOfTheReader` (l. 125-136) avec
`[0, 0.05, 0.10, 0.15, 1]` en dur et sans `PlayerMetrics` ; réécrire le commentaire l. 37
(« the same four-stop gradient as the reader's »). Ces lignes seront supprimées par home 1.2.

### T2 — Teinter davantage le fond du lecteur avec la couleur de la cover

**Contexte.** Les trois stops du lecteur sortent de `CoverTintTone` avec une luminosité imposée
(0,33 / 0,27 / 0,20) et une saturation plafonnée à 0,35, conçues pour la fiche nœud. Le lecteur
doit recevoir une échelle plus lumineuse et plus saturée, sans que la fiche nœud ni la carte ne
changent. Plan : `docs/plans/player-gradient-tint.md#partie-1--fond-du-lecteur`, décisions
D1, D2, D3. Aucune dépendance.

**Portée.**
- `ios/Track1Core/Sources/Track1Core/Media/CoverTint.swift` — `CoverTintTone.Scale`, `.page`,
  `.player`, `tint(bands:scale:)`, alias `stopBrightness` / `saturationMax` → `.page`.
- `ios/Track1Core/Tests/Track1CoreTests/Media/CoverTintTests.swift` — tests de `.player`.
- `ios/Track1/Media/NodeHeroModel.swift` — `init(node:store:scale:)`, `load()` passe `scale`.
- `ios/Track1/Features/Node/NodePageView.swift` — `pageTint(coverTint:type:scale:)` avec `.page`
  par défaut ; le repli sans cover utilise `scale.stopBrightness.count` et `tint(bands:scale:)`.
- `ios/Track1/Features/Node/PlayerView.swift` — l. 242 `NodeHeroModel(..., scale: .player)` ;
  l. 246 `pageTint(..., scale: .player)`.
- Tests : `ios/Track1Tests/Media/HeroImageTests.swift`, `ios/Track1Tests/Node/PlayerViewTests.swift`
  (ou `NodePageViewTests.swift` pour le repli).
- Hors scope : `DominantColor`, `CoverTintGradient`, `TodayView`, `TodayHomeView`, les constantes
  `tint*` de `PlayerMetrics` (T1), le `shadow` du lecteur (non utilisé par lui).

**Contrat.**
- `public struct CoverTintTone.Scale: Equatable, Sendable { public let stopBrightness: [Double]; public let saturationMax: Double }`
  avec `public static let page: Scale` (`[0.33, 0.27, 0.20]`, `0.35`) et
  `public static let player: Scale` (`[0.46, 0.38, 0.30]`, `0.60`).
- `public static func tint(bands: [LinearRGB], scale: Scale = .page) -> CoverTint?` — hue de chaque
  bande conservée, saturation `min(s, scale.saturationMax)`, luminosité `scale.stopBrightness[i]`.
  Le `shadow` garde `shadowBrightness` et `shadowSaturationGain`, plafonné par
  `scale.saturationMax`. `nil` sauf exactement trois bandes.
- `CoverTintTone.stopBrightness` et `saturationMax` restent publiques et valent `.page`.
- `NodeHeroModel.init(node: NodeDetail, store: NodeImageStore<UIImage>, scale: CoverTintTone.Scale = .page)`.
- `NodePageView.pageTint(coverTint: CoverTint?, type: NodeType, scale: CoverTintTone.Scale = .page) -> CoverTint`.

**Critères d'acceptation.**
- [ ] `tint(bands:)` sans `scale` : test Cosmogramma inchangé (`0x4A5552`, `0x44423A`, `0x322A22`,
      shadow `0x6A877E`, tolérance 2/255).
- [ ] `tint(bands:scale: .player)` sur trois gris : stops gris de luminosité `0.46`, `0.38`,
      `0.30` (± 1/255) ; sur un rouge pur en première bande : saturation `0.60` ± 0,01, hue 0 ± 1°.
- [ ] Pour toute échelle, les luminosités des stops sont strictement décroissantes du haut vers le
      bas, et `stopBrightness.count == 3`.
- [ ] `NodeHeroModel(..., scale: .player)` chargé sur l'image « tiers » des tests porte
      `CoverTintTone.tint(bands:scale: .player)` ; sans argument, `tint(bands:)` (test existant
      `testALoadedImageCarriesTheCoverTintOfItsBands` inchangé).
- [ ] `pageTint(coverTint: nil, type:, scale: .player)` : trois stops de la hue du type, luminosité
      `[0.46, 0.38, 0.30]` ± 0,01 ; sans `scale`, test existant
      `testWithoutACoverEachTypeGetsThreeDarkStopsOfItsOwnHue` inchangé.
- [ ] `PlayerView` passe `.player` aux deux appels (vérifiable par lecture ; le rendu se juge sur
      appareil).
- [ ] `swift test --package-path ios/Track1Core` vert en local ; `ios-check` vert ;
      `npm run check` vert (`test/ios-core-package.test.ts` : pas de `@testable import Track1Core`
      côté app).

**Tests attendus.** Unitaires `Track1CoreTests` : `.player` sur gris, sur rouge saturé, hue
conservée, décroissance, `.page` inchangé. Unitaires `Track1Tests` : modèle avec `scale: .player`,
repli `pageTint` avec `.player`. Pas de test d'intégration.

**Tier.** tier/2 — logique locale dans le package, signature d'un modèle partagé par trois écrans,
couvert par des tests existants. **Estimate :** 3.

**Notes.** Les valeurs de `.player` sont la décision D2, validée par Raphael le 2026-11-25 : ne pas
rediscuter, il règle sur appareil. Ne pas renommer `Scale`. Ne pas toucher aux constantes `tint*` de
`PlayerMetrics` (T1, parallèle). L'app n'utilise que l'API publique du package. Nommage et
commentaires en anglais ; commentaire de `Scale.player` : pourquoi (lecteur plein écran, brief du
2026-11-25) et ticket.
