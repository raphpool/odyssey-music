# Fond du lecteur : teinte plus forte, foncé plus tard

Plan rédigé le 2026-11-25 (phase `plan` du delivery-process). Brief de Raphael : « le background
linéaire du player devrait être encore davantage teinté par la couleur dominante de la cover ; le
dégradé doit tendre beaucoup plus tard vers le foncé ».

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

- `TodayHomeMetrics` (`ios/Track1/Features/Today/TodayHomeView.swift`, l. 37-43) **réutilise**
  `PlayerMetrics.tintStops` et `PlayerMetrics.tintHeight` pour le fond de l'écran Today (Figma
  `324:1790`). Toute modification des constantes du lecteur changerait Today.
- Le `CoverTint` du lecteur est calculé une fois dans `NodeHeroModel.load()`
  (`ios/Track1/Media/NodeHeroModel.swift`, l. 50) et partagé par la fiche nœud, la carte de contenu
  et Today. Toute modification des constantes de `CoverTintTone` changerait ces trois surfaces.

## Non-buts

- Changer le fond de la fiche nœud (`CoverTintGradient`, Figma `282:837`), de la carte de contenu
  (`285:1034`) ou de l'écran Today (`324:1790`). Ces trois surfaces doivent rester **pixel pour
  pixel identiques**.
- Le fond « ambient » du lecteur (cover zoomée, floutée, en mouvement lent) : c'est le plan
  `player-ambient-cover-background`, mené en parallèle. Voir la section « Dépendance » ci-dessous.
- Modifier l'échantillonnage de la cover (`DominantColor.bands(of:)`, tiers haut/milieu/bas) ou
  stocker une couleur dans le pipeline / le schéma (décision D10 du plan natif : la couleur se
  calcule sur le téléphone).
- Toucher au masque de fondu des paragraphes (`PlayerMetrics.fadeStops`), à la barre Now, au
  bouton retour ou au défilement.
- Mettre à jour Figma. Le code documentera l'écart avec le ticket et la date, comme le fait déjà
  l'en-tête de `PlayerMetrics` (« The ticket wins »).

## Décisions d'archi

### D1 — Le lecteur a son propre ton ; fiche nœud et Today gardent le leur
Le ton actuel (`CoverTintTone`) est une spec validée pour la fiche nœud (références Cosmogramma,
annexe A.2 du plan natif) et il est testé à la couleur près (`CoverTintTests`). Le lecteur reçoit
une **seconde échelle** de luminosité/saturation ; l'échelle existante ne bouge pas.
*Alternative rejetée :* relever les constantes de `CoverTintTone` pour tout le monde. Changerait
trois écrans que le brief ne nomme pas, et casserait les références Figma de la fiche nœud.

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
(qui crée aussi un modèle, l. 147) ne change pas.
*Alternative rejetée :* faire porter les trois bandes brutes par `State.loaded` et laisser chaque
surface dériver son ton. Plus général, mais touche l'énumération utilisée par trois écrans et leurs
tests pour le même résultat ; on y reviendra si une surface a un jour besoin de deux tons.
*Alternative rejetée :* recalculer `DominantColor.bands(of:)` dans la vue du lecteur. Refait la
réduction 32 × 32 et trois `CIAreaAverage` à chaque évaluation du `body`.

### D4 — La géométrie reste en fractions du cadre de 2064 pt ; seules les valeurs changent
`PlayerMetrics.tintPositions` et `tintEndpoint` restent des fractions de `tintHeight` (convention
Figma en place). Valeurs de départ, à juger sur appareil :

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
Figma partagée avec Today.
*Alternative rejetée :* supprimer le point de fin foncé. Le fond ne rejoindrait jamais le token
`background.elevated` et la barre Now flotterait sur un ton moyen.

### D5 — Un seul constructeur de stops paramétré, trois jeux de constantes
`CoverTintGradient.stops(tint:endpoint:)` (`ios/Track1/DesignSystem/Components/Node/
CoverTintGradient.swift`) gagne une variante paramétrée par les positions et la position du point de
fin ; la signature existante délègue à la nouvelle avec les constantes de `CoverTintTone`.
`PlayerMetrics.tintStops` et `TodayHomeMetrics.tintStops` appellent cette variante, **chacun avec
ses propres constantes**. Today recopie les valeurs actuelles (`[0, 0.05, 0.10]`, `0.15`, `2064`)
et cesse de dépendre de `PlayerMetrics`. Le commentaire de `PlayerMetrics` (« `CoverTintGradient`
cannot draw it: its stops are fixed… ») et celui de `TodayHomeMetrics` (« the same four-stop
gradient as the reader's ») deviennent faux et sont réécrits.
*Alternative rejetée :* dupliquer le constructeur dans Today. Trois copies des mêmes cinq lignes,
et le test Today qui compare ses positions à celles du lecteur devrait de toute façon être remplacé
par des valeurs en dur.

## Découpage

Une seule partie : les deux tâches sont indépendantes, déployables seules et jugeables séparément
sur appareil (un axe du brief chacune).

### Partie 1 — Fond du lecteur

- [ ] TRA-? **Retarder le passage au foncé du dégradé du lecteur** (axe géométrie, D4 + D5) —
  `PlayerMetrics`, `CoverTintGradient`, `TodayHomeMetrics` et leurs tests. tier/1, 2 points.
- [ ] TRA-? **Teinter davantage le fond du lecteur avec la couleur de la cover** (axe ton,
  D1 + D2 + D3) — `CoverTintTone.Scale` dans `Track1Core`, `NodeHeroModel(scale:)`,
  `NodePageView.pageTint(scale:)`, `PlayerView`, et leurs tests. tier/2, 3 points.

**Parallélisables** (worktrees simultanés). Zones de contact : les deux touchent
`ios/Track1/Features/Node/PlayerView.swift` (T1 : bloc de constantes l. 40-60 ; T2 : l. 242 et
l. 246) et `ios/Track1Tests/Node/PlayerViewTests.swift` (T1 : réécrit le test existant
`testTheBackgroundIsTheCoverBandsAt0And5And10PercentThenTheElevatedColour` ; T2 : ajoute un test).
Hunks disjoints ; le second mergé rebase. Si Raphael préfère un seul ticket, les deux tiennent dans
~ 280 lignes de diff, mais on perd la possibilité de juger chaque axe séparément.

## Dépendance avec `player-ambient-cover-background`

Les deux plans modifient `PlayerView.body` → `.background(alignment: .top)` (l. 248-251) et le bloc
`tint*` de `PlayerMetrics`. Ordre recommandé : **ce plan d'abord** (deux tickets courts, jugeables
en un build), l'ambient ensuite, pour deux raisons :

1. Si le fond ambient **remplace** le dégradé, T1 devient caduc mais T2 reste utile (le ton
   `.player` peut servir à teinter un voile par-dessus la cover floutée). Le planner de l'ambient
   doit le dire explicitement.
2. Si le fond ambient se **superpose** au dégradé (cover floutée dessous, dégradé dessus), le
   dégradé devra devenir partiellement transparent. C'est un changement de contrat :
   `CoverTintGradient` est **opaque par spec** (en-tête du fichier et
   `CoverTintGradientTests.testTheStopsAreOpaque`). Ce plan garde l'opacité ; la transparence, si
   elle vient, est une décision du plan ambient, prise après avoir vu T1 + T2 sur appareil.

Juger T1 et T2 **avant** que l'ambient n'arrive, sinon les deux effets se confondent et les
constantes seront réglées sur un fond qui n'existera plus.

## Risques

| Risque | Garde-fou |
| --- | --- |
| Lisibilité des phrases non focalisées (`colorTextTertiary`) sur un fond plus clair et plus saturé en haut de colonne. | Le masque `fadeStops` rend les phrases transparentes jusqu'à 52 pt et opaques seulement à 212 pt ; la colonne de lecture est au centre (387 pt), déjà sur le 2ᵉ/3ᵉ stop. Le test de T2 impose des stops strictement décroissants en luminosité. Réglage sur appareil : une seule constante (`Scale.player`). |
| Régression visuelle de Today si le découplage est oublié ou mal fait. | `TodayHomeViewTests` asserte `[0, 0.05, 0.10, 0.15, 1]` et `tintHeight == 2064` **sans** référence à `PlayerMetrics`. |
| Régression du ton de la fiche nœud et de la carte. | `CoverTintTests.testCosmogrammaBandsGiveTheFigmaReferenceStopsAndShadow` inchangé ; `tint(bands:)` sans argument reste `.page` ; `NodePageViewTests` l. 82 continue d'asserter `[0.33, 0.27, 0.20]`. |
| Les tests de la cible app (`Track1Tests`) ne tournent que dans `ios-check` (runner `macos-26`) : un agent cloud ne peut pas les lancer. | La logique de T2 est dans `Track1Core` (`swift test` en local). Les tests de T1 sont des assertions de valeurs. Lire les annotations `::error::` du run `ios-check` (max 10 affichées). |
| `swift-format` strict (tabs, 110 colonnes) et la garde vitest `test/ios-design-tokens.test.ts` (aucune couleur brute dans `Features/`). | Aucune couleur brute à écrire : les stops passent par `Color(_ rgb: LinearRGB)` existant et le token `colorBackgroundElevated`. |
| Conflit textuel entre T1 et T2 dans `PlayerView.swift` / `PlayerViewTests.swift`. | Hunks disjoints (voir Découpage) ; le second mergé rebase. |

## Critères de sortie

- `PlayerMetrics.tintStops` renvoie des positions `[0, 0.15, 0.30, 0.45, 1]` et
  `tintEndpoint × tintHeight > 844` (le foncé est atteint sous l'écran de référence).
- `TodayHomeMetrics.tintStops` renvoie `[0, 0.05, 0.10, 0.15, 1]` sur un cadre de 2064 pt, sans
  dépendre de `PlayerMetrics`.
- `CoverTintTone.tint(bands:)` donne exactement les couleurs d'avant (test Cosmogramma inchangé) ;
  `tint(bands:scale: .player)` donne des stops de luminosité `[0.46, 0.38, 0.30]` et de saturation
  plafonnée à `0.60`.
- Le lecteur utilise `.player` pour la cover **et** pour le repli sans cover (couleur du type) ;
  la fiche nœud et Today utilisent `.page`.
- `swift test --package-path ios/Track1Core` et le job `ios-check` sont verts ; `npm run check`
  vert (garde des couleurs brutes).
- Raphael a vu les deux tickets sur appareil (build de dev ou TestFlight) et validé ou ajusté les
  constantes `tintPositions` / `tintEndpoint` / `Scale.player`. Un ajustement de valeurs est un
  commit de suivi sur le même ticket, pas un nouveau plan.

## Annexe — Brouillons de tickets

### T1 — Retarder le passage au foncé du dégradé du lecteur

**Contexte.** Le fond du lecteur devient `background.elevated` dès 15 % de son cadre de 2064 pt
(310 pt), au-dessus du centre de lecture. Il doit rester teinté sur tout l'écran et n'atteindre le
foncé que sous le bas de l'écran. Today partage aujourd'hui ces constantes et doit garder son
rendu. Plan : `docs/plans/player-gradient-tint.md#partie-1--fond-du-lecteur`, décisions D4, D5.

**Portée.**
- `ios/Track1/Features/Node/PlayerView.swift` — `PlayerMetrics.tintPositions`, `tintEndpoint`,
  `tintStops` (délègue au constructeur paramétré), commentaire du bloc l. 40-41 réécrit.
- `ios/Track1/DesignSystem/Components/Node/CoverTintGradient.swift` — variante paramétrée de
  `stops`, l'existante délègue.
- `ios/Track1/Features/Today/TodayHomeView.swift` — `TodayHomeMetrics` possède `tintHeight`,
  `tintPositions`, `tintEndpoint` ; `tintStops` n'appelle plus `PlayerMetrics` ; commentaire l. 37
  réécrit.
- Tests : `ios/Track1Tests/Node/PlayerViewTests.swift`, `ios/Track1Tests/Node/TodayHomeViewTests.swift`,
  `ios/Track1Tests/DesignSystem/CoverTintGradientTests.swift`.
- Hors scope : `CoverTintTone`, `NodeHeroModel`, `NodePageView`, `fadeStops`, la barre Now, Figma.

**Contrat.**
- `CoverTintGradient.stops(tint: CoverTint, positions: [CGFloat], endpointPosition: CGFloat, endpoint: Color) -> [Gradient.Stop]`
  — trois stops couleur aux `positions`, puis `endpoint` à `endpointPosition` et à `1`. Opaque.
- `CoverTintGradient.stops(tint:endpoint:)` — inchangée en signature et en résultat.
- `PlayerMetrics.tintPositions: [CGFloat] = [0, 0.15, 0.30]`, `PlayerMetrics.tintEndpoint: CGFloat = 0.45`,
  `PlayerMetrics.tintHeight: CGFloat = 2064` (inchangé), `PlayerMetrics.tintStops(_:)` inchangée en
  signature.
- `TodayHomeMetrics.tintHeight: CGFloat = 2064`, `tintPositions: [CGFloat] = [0, 0.05, 0.10]`,
  `tintEndpoint: CGFloat = 0.15`, `tintStops(_ tint: CoverTint?) -> [Gradient.Stop]?` inchangée en
  signature.

**Critères d'acceptation.**
- [ ] `PlayerMetrics.tintStops(tint).map(\.location) == [0, 0.15, 0.30, 0.45, 1]` ; les trois
      premières couleurs sont `Color(tint.stops[i])`, les deux dernières `colorBackgroundElevated`.
- [ ] `PlayerMetrics.tintEndpoint * PlayerMetrics.tintHeight > PlayerMetrics.designHeight` (844).
- [ ] `TodayHomeMetrics.tintStops(tint)?.map(\.location) == [0, 0.05, 0.10, 0.15, 1]` et
      `TodayHomeMetrics.tintHeight == 2064`, le test ne référence plus `PlayerMetrics`.
- [ ] `CoverTintGradient.stops(tint:endpoint:)` renvoie toujours `[0, 0.13, 0.27, 0.50, 1]`
      (tests existants verts) ; la variante paramétrée renvoie les positions passées et des stops
      opaques.
- [ ] Les deux commentaires obsolètes sont réécrits avec la date et l'ID du ticket.
- [ ] `ios-check` vert.

**Tests attendus.** Unitaires XCTest (`Track1Tests`) : positions et couleurs du lecteur ; foncé
atteint sous 844 pt ; positions de Today en dur ; variante paramétrée (positions passées, cinq
stops, opacité). Pas de test d'intégration.

**Tier.** tier/1 — styles isolés, composant présentationnel sans état. **Estimate :** 2.

**Notes.** Les valeurs `[0, 0.15, 0.30]` / `0.45` sont la décision D4 : ne pas rediscuter, Raphael
règle sur appareil. Aucune couleur brute dans `Features/` (`test/ios-design-tokens.test.ts`).
`swift-format` strict, tabs, 110 colonnes. Les tests app ne tournent que dans `ios-check`.

### T2 — Teinter davantage le fond du lecteur avec la couleur de la cover

**Contexte.** Les trois stops du lecteur sortent de `CoverTintTone` avec une luminosité imposée
(0,33 / 0,27 / 0,20) et une saturation plafonnée à 0,35, conçues pour la fiche nœud. Le lecteur
doit recevoir une échelle plus lumineuse et plus saturée, sans que la fiche nœud, la carte ni Today
ne changent. Plan : `docs/plans/player-gradient-tint.md#partie-1--fond-du-lecteur`, décisions
D1, D2, D3.

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

**Notes.** Les valeurs de `.player` sont la décision D2 : ne pas rediscuter, Raphael règle sur
appareil. Ne pas renommer `Scale`. Ne pas toucher aux constantes `tint*` de `PlayerMetrics` (T1,
parallèle). L'app n'utilise que l'API publique du package. Nommage et commentaires en anglais ;
commentaire de `Scale.player` : pourquoi (lecteur plein écran, brief du 2026-11-25) et ticket.
