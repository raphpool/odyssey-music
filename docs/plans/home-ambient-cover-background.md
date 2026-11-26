# Home iOS : fond ambiant de la cover (zoom, flou, dérive lente)

Plan rédigé le 2026-11-25 (phase `plan` du delivery-process). **Statut : brouillon, en attente du gate
humain.** Aucun ticket Linear n'est créé.

Brief de Raphael : « répliquer l'effet du background de YouTube quand on lance en Chromecast depuis un
mobile vers l'ordinateur : la cover est zoomée à fond, un layer de blur est apposé dessus, et elle bouge
très lentement. » Surface confirmée : **la home iOS** (onglet Today, écran `TodayHomeView`), pas le
lecteur ni le player web. Le fichier `docs/plans/player-ambient-cover-background.md` (player web) est
caduc et n'est pas la base de ce plan.

Tous les chemins sont relatifs à la racine du dépôt ; les numéros de ligne sont ceux de `b680912`
(branche `claude/tender-pascal-rk58tg`, 2026-11-25).

## Problème

1. **La home a déjà la cover, mais son fond ne la montre pas.** `TodayView.read()`
   (`ios/Track1/Features/Today/TodayView.swift`, l. 147-156) charge l'image du nœud recommandé via
   `NodeHeroModel`, en tire `cover: Image?` et `tint: CoverTint?`, et les passe à `TodayHomeView`. Celle-ci
   dessine la cover nette dans un carré de 308,8 pt (`coverView`, l. 194-222) et, derrière tout l'écran,
   `backdrop` (l. 164-174) : `colorBackgroundElevated` plat, plus le dégradé linéaire à quatre stops du
   lecteur quand il y a une teinte. Les trois couleurs de ce dégradé sortent de `CoverTintTone` (luminosité
   imposée 0,33 / 0,27 / 0,20, saturation plafonnée à 0,35) et le foncé est atteint dès 15 % d'un cadre de
   2064 pt, soit 310 pt : le fond est déjà plat dans le tiers haut de la cover nette (222-531 pt). La home est
   un aplat sombre à peine teinté.
2. **Le dégradé de la home est emprunté au lecteur.** `TodayHomeMetrics.tintHeight` et `tintStops`
   (`ios/Track1/Features/Today/TodayHomeView.swift`, l. 37-43) délèguent à `PlayerMetrics.tintStops` et
   `PlayerMetrics.tintHeight` (`ios/Track1/Features/Node/PlayerView.swift`, l. 40-60). Le plan
   `docs/plans/player-gradient-tint.md` (D5, ticket T1) prévoit de découpler Today du lecteur en recopiant
   les constantes dans `TodayHomeMetrics`. Ce plan tranche la relation entre ce dégradé et le fond ambiant
   (voir « Relation avec `player-gradient-tint` »).
3. **Le motif existe déjà dans le design system, sans la cover.** `AmbientGlow`
   (`ios/Track1/DesignSystem/Components/Navigation/AmbientGlow.swift`) et `WelcomeBackdrop`
   (`ios/Track1/DesignSystem/Components/Onboarding/WelcomeBackdrop.swift`) sont des fonds décoratifs
   absolus, `allowsHitTesting(false)`, `accessibilityHidden(true)`, placés en `.background`.
   `WelcomeBackdrop` est le seul fond **animé** : `TimelineView(.animation(minimumInterval: 1/15))`, phase de
   boucle calculée par des maths pures de `Track1Core` (`LoopPhase`, `ColorCycle`,
   `ios/Track1Core/Sources/Track1Core/Backdrop/ColorCycle.swift`), figé à la phase 0 sous Reduce Motion,
   lisibilité du texte prouvée par `WCAGContrast` (`BackdropTests`,
   `ios/Track1Tests/DesignSystem/BackdropTests.swift`). Il n'existe aucune vue qui floute ou déplace une
   image : c'est ce qui manque.

## Non-buts

- Le lecteur (`PlayerView`) et son dégradé : c'est `docs/plans/player-gradient-tint.md`. Ce plan ne
  modifie ni `PlayerMetrics`, ni `CoverTintGradient`, ni `CoverTintTone`, ni `NodeHeroModel`.
- La fiche nœud (`NodePageView`, `CoverTintGradient`, Figma `282:837`), la carte de contenu (`285:1034`) :
  pixel pour pixel identiques.
- Les écrans sans page de l'onglet Today (chargement, catalogue vide, indisponible) : ils gardent
  `todayBackdrop()` (glow Ember, `ios/Track1/Features/Today/RecommendationLoadingView.swift`, l. 44-53).
- La cover nette de la home (`coverView`, son ombre `324:1808`), le bloc date/genres, le titre, le bouton
  « Découvrir » : aucune mesure de `TodayHomeMetrics` autre que `tintHeight` / `tintStops` ne change.
- Un nouvel appel réseau ou une nouvelle taille d'image : le fond réutilise l'`Image` déjà chargée pour la
  cover nette. Pas de pré-flou CoreImage dans ce plan (voir D2, c'est le repli de performance).
- Stocker une couleur ou une image dérivée dans le pipeline ou le schéma (décision D10 du plan natif : tout
  se calcule sur le téléphone).
- Mettre à jour Figma : `324:1790` dessine le dégradé à quatre stops. Le code documente l'écart avec la
  date et l'ID du ticket, comme l'en-tête de `PlayerMetrics` (« The ticket wins »).
- Le player web (`web/`).

## Décisions d'archi

### D1 — Le fond ambiant **remplace** le dégradé teinté de la home ; pas de superposition
Avec une cover chargée, la home dessine la cover floutée et zoomée sous un voile sombre neutre (D5) ;
sans cover, elle reste `colorBackgroundElevated` plat, **exactement comme aujourd'hui sans teinte**.
`TodayHomeMetrics.tintHeight` et `tintStops` sont supprimés, et le paramètre `tint: CoverTint?` disparaît
de `TodayHomeView.init` et de `TodayView.Page`. La teinte et la cover viennent de la même image
(`NodeHeroModel.load()`, `ios/Track1/Media/NodeHeroModel.swift`, l. 47-50) : une teinte sans cover n'arrive
que si `DominantColor.bands` échoue (une bande sans pixel opaque), cas où le dégradé n'était déjà pas
dessiné. On ne perd donc aucun rendu existant.
*Alternative rejetée :* superposer le dégradé au-dessus de la cover floutée. Il faudrait le rendre
partiellement transparent, or il est **opaque par spec** (en-tête de `CoverTintGradient.swift`,
`CoverTintGradientTests.testTheStopsAreOpaque`), et il porterait la même teinte que la cover floutée
qu'il recouvre : double teinte, effet lavé, deux jeux de constantes à régler l'un contre l'autre. La
référence Chromecast n'a pas de dégradé coloré, seulement un voile sombre.
*Alternative rejetée :* garder le dégradé comme repli sans cover. Il n'est jamais dessiné sans cover
(voir ci-dessus) : ce serait du code mort.

### D2 — Un composant du design system, `AmbientCoverBackdrop`, qui floute et déplace l'`Image` à l'affichage
Nouveau fichier `ios/Track1/DesignSystem/Components/Node/AmbientCoverBackdrop.swift` (à côté de
`CoverTintGradient.swift`, l'autre fond dérivé de la cover), même contrat que `AmbientGlow` et
`WelcomeBackdrop` : décoratif, absolu, `ignoresSafeArea()`, `allowsHitTesting(false)`,
`accessibilityHidden(true)`, à placer en `.background`. Il reçoit l'`Image` de la cover et la dessine
`resizable().scaledToFill()` à la taille de l'écran (`GeometryReader`), floutée (`.blur(radius:opaque:)`,
`opaque: true`), **puis** agrandie (`scaleEffect`) et décalée (`offset`) par la dérive (D3), clippée à
l'écran, sous le voile (D5). Le flou s'applique avant la transformation : il est rendu à la taille de mise
en page, la transformation n'est qu'un déplacement de calque Core Animation, et le rayon s'exprime en
points de l'écran. Les valeurs d'art direction (zoom, rayon, voile) vivent dans `DesignSystem/`, hors du
périmètre scanné par `test/ios-design-tokens.test.ts`, et `AmbientCoverBackdropMetrics` les expose aux
tests comme `PlayerNowBarMetrics` ou `DiscoverButtonMetrics`.
*Alternative rejetée :* tout écrire dans `TodayHomeView.backdrop`. Les constantes d'art direction
n'ont rien à faire dans `Features/`, et le composant servira tel quel si une autre surface veut l'effet.
*Alternative rejetée :* pré-flouter l'image une fois (CoreImage, dans `ios/Track1/Media/` comme
`DominantColor`) et n'animer qu'une transformation. Moins coûteux par image, mais ~40 lignes de CoreImage
et un test de plus pour un gain qu'on n'a pas mesuré. C'est le **repli** si la mesure sur appareil (Risques)
montre un coût trop élevé : un ticket de suivi, pas une décision de ce plan.

### D3 — Le mouvement : `TimelineView` à 15 images/s et maths pures dans `Track1Core`, pas `repeatForever`
Nouveau fichier `ios/Track1Core/Sources/Track1Core/Backdrop/AmbientDrift.swift` (à côté de
`ColorCycle.swift`) : une boucle de 60 s, une dérive en huit (Lissajous 1:2, `x = aₓ·sin(2πφ)`,
`y = a_y·sin(4πφ)`), amplitude 24 pt en x et 16 pt en y, phase par `LoopPhase.wrapped`, donc sans coupure
et **centrée à la phase 0** (`offset(phase: 0) == (0, 0)`). Le composant lit la phase dans un
`TimelineView(.animation(minimumInterval: 1/15, paused:))`, comme `WelcomeBackdrop` (même
`frameInterval`, même `@State start = Date()` pour partir de la phase 0 à l'apparition). Sous Reduce
Motion : schedule en pause et phase 0, la cover floutée est immobile et centrée. À 15 images/s, le pas
maximal est 0,17 pt en x et 0,22 pt en y par image : sous le pixel, invisible sur un calque flouté. Toute
la cinématique est testable en local par `swift test --package-path ios/Track1Core`.
*Alternative rejetée :* `.animation(.linear(duration:).repeatForever(autoreverses: true))` sur
`offset`. Moins de redessins, mais l'animation redémarre ou se dédouble à chaque changement d'identité de
la vue, n'est pas inspectable par un test, n'a pas de phase partagée (`LoopPhase` est « one definition
for every looping animation of the design system »), et le dépôt n'en a aucun précédent.
*Alternative rejetée :* animer aussi le zoom (respiration). Le brief dit « elle bouge » ; le zoom reste
constant, une seule grandeur à régler.

### D4 — Zoom et flou : des constantes, et un invariant de marge testé
`AmbientCoverBackdropMetrics.zoom = 1.7 (1.6 jusqu'à l'amendement du 2026-11-26, voir TRA-829)`, `blurRadius = 64` (points de mise en page, soit ≈ 102 pt
une fois agrandi). Invariant, vérifié par un test sur le cadre de référence 393 × 844 :
`(zoom − 1) / 2 × 393 ≥ amplitude.x + blurRadius` (118 ≥ 88) et
`(zoom − 1) / 2 × 844 ≥ amplitude.y + blurRadius` (253 ≥ 80). Aucun bord de l'image, aucune frange de
flou n'entre jamais dans l'écran, quelle que soit la phase. Un réglage qui casse l'invariant fait échouer
le test : c'est voulu.
*Alternative rejetée :* calculer le zoom à l'exécution d'après la taille réelle de l'écran. Plus
« juste », mais une valeur de moins à lire et à régler, et l'invariant sur 393 × 844 couvre tous les
iPhone supportés (le ratio le plus étroit est celui du cadre de référence).

### D5 — Le voile : `colorBackgroundElevated` en dégradé d'opacité 0,65 → 0,80, lisibilité prouvée par `WCAGContrast`
Le voile est un `LinearGradient` vertical de `Track1Tokens.colorBackgroundElevated` : opacité
`veilTopOpacity = 0.65` en haut, `veilBottomOpacity = 0.80` à partir de `veilTextStop = 0.62` de la
hauteur et jusqu'en bas. Pourquoi deux valeurs : sur une pochette blanche (pire cas), un voile `elevated`
à 0,65 laisse `colorTextPrimary` à 4,84:1 (le badge de date et les pilules de genre, en haut, sont en
`colorTextPrimary` : `DateBadge.swift` l. 71, `GenrePillRow.swift` l. 105) mais `colorTextSecondary`
(sous-titre, 15 pt) à 2,94:1 ; il faut 0,80 pour le porter à 5,11:1 (0,766 est le minimum). 0,62 × 844 =
523 pt : le voile atteint son opacité maximale juste avant le bas de la cover nette (531 pt), donc bien avant
le titre (≈ 580 pt). Un voile plat à 0,80 partout tuerait l'effet autour de la cover ; à 0,65 partout, le sous-titre
serait illisible sur une pochette claire. Le test reproduit `testTextPrimaryKeepsAContrastOf4Point5…` de
`BackdropTests` : `WCAGContrast.composite(elevated, opacity:, over: white)` contre les deux rôles. Avec
`elevated` plutôt que du noir, un voile à 1 redonne exactement le fond plat d'aujourd'hui : la continuité
avec le repli sans cover est garantie.
*Alternative rejetée :* réutiliser `Track1Tokens.colorOverlayScrim` (noir à 54 %, `GenreTile`). Un
seul passage laisse le texte primaire sous 4,5:1 sur une pochette blanche, et deux passages reviennent à
une constante maison.
*Alternative rejetée :* un voile teinté par le `CoverTint` (`shadow` ou troisième stop). La cover
floutée porte déjà sa teinte ; un voile coloré la double. Possible réglage ultérieur si Raphael veut plus
de couleur (question Q4), pas la valeur de départ.

### D6 — Sous Reduce Transparency, la home reste plate ; le choix est une fonction pure de `TodayHomeContent`
`TodayHomeContent.backdrop(hasCover:reduceTransparency:) -> Backdrop` (`.ambient` ou `.flat`), lue par
`TodayHomeView` avec `@Environment(\.accessibilityReduceTransparency)`. Une image floutée sous un voile
translucide est précisément ce que ce réglage demande d'éviter ; le tableau « Mouvements et variantes
accessibles » de `docs/track1-design.md` (l. 224-232) impose « surface opaque si transparence réduite ».
Le repli est le fond plat d'aujourd'hui, donc testable sans rendu.
*Alternative rejetée :* ignorer le réglage. Le design doc en fait une colonne de son tableau, et le
coût est une ligne de `switch`.

## Découpage

Une seule partie, deux tâches **séquentielles** (T2 dépend de T1). Points = estimate Linear.

| # | Tâche | Tier | Pts | Dépend de |
|---|---|---|---|---|
| 1.1 | TRA-829 · Ajouter le composant `AmbientCoverBackdrop` et la dérive `AmbientDrift` | tier/2 | 3 | — |
| 1.2 | TRA-830 · Remplacer le dégradé de la home par le fond ambiant de la cover | tier/2 | 2 | 1.1 |

### Partie 1 — Fond ambiant de la home (déployable seule : sans cover, rien ne change)

- [ ] TRA-829 1.1 — `Track1Core` : `AmbientDrift` (boucle, amplitude, phase, offset) et ses tests ;
  `DesignSystem` : `AmbientCoverBackdrop` + `AmbientCoverBackdropMetrics` et leurs tests (constantes,
  invariant de marge, voile, WCAG) ; deux entrées pbxproj (`0490`, `0491`). Aucun appelant : la home ne
  change pas encore.
- [ ] TRA-830 1.2 — `TodayHomeView` : `backdrop` dessine `AmbientCoverBackdrop(cover:)` ou le fond plat selon
  `TodayHomeContent.backdrop(hasCover:reduceTransparency:)` ; suppression de `TodayHomeMetrics.tintHeight` /
  `tintStops` et du paramètre `tint` ; `TodayView.Page` et `read()` ne portent plus de teinte ;
  `TodayHomeViewTests` réécrits.

Diff attendu : 1.1 ≈ 45 (Core) + 70 (tests Core) + 100 (composant) + 90 (tests app) + 12 (pbxproj) ;
1.2 ≈ 35 (app) + 45 (tests). Un seul ticket tiendrait en ≈ 400 lignes, au-dessus de la borne : deux
tickets, le second ne peut pas tourner avant le premier (pas de worktree parallèle). Si Raphael préfère un
seul ticket pour juger l'effet d'un coup, 1.1 et 1.2 fusionnent sans autre changement (question Q3).

## Relation avec `player-gradient-tint`

Le plan `docs/plans/player-gradient-tint.md` touche la home en un seul point : son ticket T1 (D5)
recopie `tintHeight = 2064`, `tintPositions = [0, 0.05, 0.10]`, `tintEndpoint = 0.15` dans
`TodayHomeMetrics` (`TodayHomeView.swift`, l. 37-43) et réécrit
`TodayHomeViewTests.testTheBackgroundIsTheFourStopGradientOfTheReader` (l. 125-136) sans référence à
`PlayerMetrics`, pour que le lecteur puisse changer ses constantes sans changer Today.

**Décision (D1) : remplacement.** La home n'a plus de dégradé ; ce que T1 voulait préserver disparaît.
Conséquences :

- **Ordre recommandé : 1.2 de ce plan avant le T1 du dégradé.** Une fois 1.2 mergé, `TodayHomeView.swift`
  ne mentionne plus `PlayerMetrics` : le T1 du dégradé se réduit à `PlayerMetrics`, `CoverTintGradient` et
  leurs tests, et perd `TodayHomeView.swift`, `TodayHomeViewTests.swift` et son critère
  « `TodayHomeMetrics.tintStops(tint)?.map(\.location) == [0, 0.05, 0.10, 0.15, 1]` ». Son estimate baisse
  d'un point.
- **Si le T1 du dégradé passe d'abord**, rien ne casse : 1.2 supprime les constantes que T1 vient de
  recopier. Conflit textuel seulement (mêmes lignes 37-43 et 125-136), le second mergé rebase.
- **Zones de contact** : `ios/Track1/Features/Today/TodayHomeView.swift` l. 37-43 et
  `ios/Track1Tests/Node/TodayHomeViewTests.swift` l. 38-45 (fixture `tint`) et l. 123-140. Aucune avec le T2
  du dégradé (`CoverTintTone.Scale`) : Today ne lit plus de teinte, `TodayView` l. 147 garde
  `NodeHeroModel(node:store:)` et l'échelle par défaut.
- **À amender dans `player-gradient-tint.md`** (par son auteur, ce plan n'y touche pas) : D5 et T1 perdent
  leur volet Today ; le non-but « Today pixel pour pixel identique » devient « Today est traité par
  `home-ambient-cover-background` » ; la section « Dépendance avec `player-ambient-cover-background` » est
  caduque (il n'y a plus de fond ambiant du lecteur) ; le risque « régression visuelle de Today » disparaît.

## Risques

| Risque | Garde-fou |
| --- | --- |
| **Coût GPU / batterie** : un calque plein écran flouté à 64 pt, recomposé 15 fois par seconde tant que la home est visible. | Fréquence plafonnée (`frameInterval = 1/15`, pas de dérive visible en dessous) ; flou rendu à la taille de mise en page puis transformé (D2) ; `opaque: true` ; pause et phase 0 sous Reduce Motion ; `TimelineView` ne tourne pas en arrière-plan. **À mesurer sur appareil au premier build** (Xcode Debug Navigator, jauge énergie, et Instruments « Core Animation FPS » sur la home immobile) : au-dessus de ~10 % de GPU au repos, repli = pré-flou CoreImage une fois (D2) ou `frameInterval = 1/10`, ticket tier/1 de suivi. |
| **La `TimelineView` continue de tourner quand l'onglet Genres est sélectionné** : `RootView` monte les deux onglets dans un `TabView` (`RootView.swift`, l. 166-169), et la documentation de `TimelineView` ne garantit pas la pause d'une vue montée mais hors écran. | Même mesure que ci-dessus, onglet Genres sélectionné. Si ça tourne : `TodayView` connaît `router.selectedTab` ; passer un `isActive` à `TodayHomeView` qui le relaie au `paused:` du schedule, ticket tier/1 de suivi. Pas dans 1.2 : on ne corrige pas ce qu'on n'a pas mesuré. |
| **Lisibilité sur une pochette claire** (badge de date, pilules, titre, sous-titre). | D5 : voile 0,65 / 0,80 testé contre un blanc pur avec `WCAGContrast` pour `colorTextPrimary` partout et `colorTextSecondary` dans la zone texte ; `veilTextStop × 844 ≤ y du titre` testé avec les métriques existantes. Le bouton « Découvrir » a son propre fond. |
| **Effet trop faible ou trop fort** (zoom, flou, dérive, voile). | Valeurs de départ (D3-D5), Raphael règle sur appareil ; un réglage est un commit de suivi sur le même ticket. Les tests WCAG sont le **plancher** : passer sous 0,63 en haut ou 0,77 en bas les fait échouer, et c'est alors une décision produit explicite (modifier le test en le disant), pas un oubli. |
| **Régression pour qui n'a pas de cover** (fixture UI-test, nœud sans image, erreur `/image`). | Repli `.flat` = `colorBackgroundElevated` seul, comme aujourd'hui sans teinte ; `backdrop(hasCover: false, …) == .flat` testé. |
| **Les UI tests ne voient jamais l'effet** : la fixture répond `503` à `/image` (`UITestFixtureReaders.swift`, l. 63-64), la home de test a le placeholder. | Accepté : la capture `2.x-today` reste déterministe, aucun UI test ne change. L'effet est jugé sur appareil. Précédent rassurant pour le jour où une fixture aura une image : les UI tests traversent déjà `WelcomeBackdrop` (même `TimelineView` à 15 images/s) sans attente d'inactivité. |
| **Les tests de la cible app (`Track1Tests`) ne tournent que dans `ios-check`** (runner `macos-26`) : un agent cloud ne peut pas les lancer. | La cinématique est dans `Track1Core` (`swift test` en local). Les tests app sont des assertions de valeurs et d'invariants, pas de rendu. Lire les annotations `::error::` du run (10 affichées au maximum). |
| **pbxproj** : deux nouveaux fichiers d'app (composant, test) exigent des entrées `F1…` / `B1…`. | Plage **réservée à ce plan : `0490–049F`** (vérifiée libre à `b680912` ; `0420–042F` appartient à `ios-node-page-ui-refresh`). 1.1 utilise `0490` et `0491`. Une collision fait échouer `ios-check` au build. `Track1Core` n'a pas besoin du pbxproj. |
| **`swift-format` strict** (tabs, 110 colonnes) et la garde vitest `test/ios-design-tokens.test.ts` (aucune couleur brute dans `Features/`, `App/`). | Le voile et le repli passent par `Track1Tokens.colorBackgroundElevated` ; le composant est dans `DesignSystem/`, non scanné. |
| **Mémoire** : la cover est dessinée deux fois (nette à 308 pt, floutée à ≈ 630 × 1350 pt). | Même `UIImage` déjà décodée pour la cover nette, aucun téléchargement, aucune copie : une texture de plus pour le compositeur, du même ordre que l'écran lui-même. |

## Critères de sortie

- Sur la home avec une cover chargée : la cover apparaît floutée, zoomée (aucun bord visible), dérivant
  lentement en boucle sous un voile sombre ; date, genres, titre et sous-titre restent lisibles. Sans
  cover : fond `colorBackgroundElevated` plat, identique à aujourd'hui. Sous Reduce Motion : cover floutée
  immobile et centrée. Sous Reduce Transparency : fond plat.
- `swift test --package-path ios/Track1Core` vert en local : `AmbientDrift` sans coupure, centré à la
  phase 0, borné par son amplitude, continu (pas < 0,25 pt par image à 15 images/s), boucle de 60 s.
- `ios-check` vert : constantes du composant, invariant de marge (D4), stops du voile et contraste WCAG
  (D5), `TodayHomeContent.backdrop` (D6), `TodayHomeView.swift` ne contient plus `PlayerMetrics`,
  `TodayHomeView.init` n'a plus de `tint`.
- `npm run check` vert (`test/ios-design-tokens.test.ts`, `test/ios-core-package.test.ts`).
- Raphael a vu le fond sur appareil (build de dev ou TestFlight), mesuré le coût GPU au repos sur la home
  et sur l'onglet Genres, et validé ou ajusté `zoom`, `blurRadius`, `AmbientDrift.amplitude`,
  `loopDuration`, `veilTopOpacity`, `veilBottomOpacity`. Un ajustement est un commit de suivi sur le
  ticket 1.2, pas un nouveau plan.
- `docs/plans/player-gradient-tint.md` a été amendé par son auteur (volet Today de D5/T1 retiré).

## Questions ouvertes pour le gate

- **Q1 — Remplacement du dégradé de la home (D1).** Recommandé : oui, le fond ambiant remplace le dégradé
  teinté, qui n'est plus dessiné nulle part sur la home. Conséquence : le T1 de `player-gradient-tint` se
  réduit au lecteur (voir « Relation »). Alternative : garder le dégradé par-dessus la cover floutée, au
  prix de son opacité (changement de contrat) et d'une double teinte.
- **Q2 — Valeurs de départ (D3-D5).** zoom 1,6 ; flou 64 pt ; dérive 24 × 16 pt en huit sur 60 s à
  15 images/s ; voile `elevated` 0,65 → 0,80 à partir de 62 % de la hauteur. L'implémenteur les pose telles
  quelles, Raphael règle sur appareil. Les planchers WCAG (0,63 en haut, 0,77 en bas) sont des tests : les
  franchir est une décision produit à écrire dans le test. OK ?
- **Q3 — Un ou deux tickets, et leurs tiers.** Recommandé : deux tickets séquentiels, tous deux tier/2
  (1.1 : nouveau composant avec état et coût de rendu ; 1.2 : change le fond de l'écran principal pour tous,
  Raphael notifié). Alternatives : un seul ticket de ≈ 400 lignes ; ou 1.2 en tier/1 (styles isolés,
  couvert par les tests).
- **Q4 — Voile neutre ou teinté.** Recommandé : neutre (`colorBackgroundElevated`, comme la référence
  Chromecast). Si l'effet manque de couleur sur appareil, un voile teinté par le `CoverTint` est un réglage
  possible, qui réintroduirait le paramètre `tint` dans `TodayHomeView` : à décider après avoir vu.

## Annexe — Brouillons de tickets (format `ticket-template.md`)

### TRA-829 (1.1) — Ajouter le composant `AmbientCoverBackdrop` et la dérive `AmbientDrift`

- Tier : **tier/2** · Estimate : **3** · Partie 1 · Labels : `tier/2`

```markdown
## Contexte
La home de l'onglet Today doit montrer, derrière son contenu, la cover du nœud du jour zoomée à fond,
floutée, dérivant très lentement sous un voile sombre, à la manière du fond YouTube en Chromecast. Cette
tâche crée le composant et la cinématique, sans encore les brancher : la home ne change pas. Elle suit les
fonds décoratifs existants `AmbientGlow` et `WelcomeBackdrop` (contrat, `TimelineView`, maths pures dans
`Track1Core`, lisibilité prouvée par `WCAGContrast`).
Plan : docs/plans/home-ambient-cover-background.md#partie-1 (D2, D3, D4, D5).

## Portée
Fichiers à créer (chemins vérifiés sur `b680912`) :
- `ios/Track1Core/Sources/Track1Core/Backdrop/AmbientDrift.swift` — `public enum AmbientDrift`, à côté de
  `ColorCycle.swift` (qui définit `LoopPhase`, à réutiliser).
- `ios/Track1Core/Tests/Track1CoreTests/Backdrop/AmbientDriftTests.swift` — modèle :
  `BackdropMathTests.swift` du même dossier.
- `ios/Track1/DesignSystem/Components/Node/AmbientCoverBackdrop.swift` — `enum AmbientCoverBackdropMetrics`
  et `struct AmbientCoverBackdrop: View`, à côté de `CoverTintGradient.swift`.
- `ios/Track1Tests/DesignSystem/AmbientCoverBackdropTests.swift` — modèle : `BackdropTests.swift` du même
  dossier (helpers `rgb(_:)`, `assertEqual`).
Fichier à modifier :
- `ios/Track1.xcodeproj/project.pbxproj` — quatre entrées pour chaque nouveau fichier d'app, même forme que
  celles de `CoverTintGradient.swift` (`F10000000000000000000423` / `B10000000000000000000423`, l. 39, 178
  et le groupe / la phase Sources qui les listent) et de `CoverTintGradientTests.swift` (`…0424`, l. 40,
  179) : `PBXFileReference`, `PBXBuildFile`, enfant du groupe (`Node` de `DesignSystem/Components` pour le
  composant, `A30000000000000000000200 /* DesignSystem */` des tests pour le test), entrée de la phase
  Sources de la cible (`Track1` pour le composant, `Track1Tests` pour le test). Identifiants :
  `F10000000000000000000490` / `B10000000000000000000490` (composant),
  `F10000000000000000000491` / `B10000000000000000000491` (test). Plage `0490–049F` réservée au plan.
  `Track1Core` n'a pas besoin du pbxproj.
Hors-scope explicite :
- `TodayHomeView.swift`, `TodayView.swift`, `TodayHomeViewTests.swift` : c'est le ticket 1.2. Ce ticket
  n'ajoute aucun appelant.
- `AmbientGlow`, `WelcomeBackdrop`, `CoverTintGradient`, `CoverTintTone`, `DominantColor`, `NodeHeroModel`,
  `PlayerMetrics` : lus pour le modèle, pas modifiés.
- Pré-flou CoreImage, nouvelle taille d'image, appel réseau, Figma, `deploy/`, `.github/`, `web/`.

## Contrat
Track1Core (API publique, `Foundation` seulement, pas de SwiftUI) :
    public enum AmbientDrift {
        /// One loop of the drift. 60 s: "very slowly".
        public static let loopDuration: TimeInterval          // 60
        /// Half-extent of the drift, in points of the screen: x then y.
        public static let amplitude: (x: Double, y: Double)   // (24, 16)
        /// LoopPhase.wrapped(elapsed / loopDuration).
        public static func phase(elapsed: TimeInterval) -> Double
        /// A figure-eight (Lissajous 1:2): x = amplitude.x * sin(2πφ), y = amplitude.y * sin(4πφ).
        /// (0, 0) at phase 0, the same point at phase 0 and 1, bounded by the amplitude; φ wraps.
        public static func offset(phase: Double) -> (x: Double, y: Double)
    }
DesignSystem (interne à l'app) :
    enum AmbientCoverBackdropMetrics {
        static let zoom: CGFloat                  // 1.7
        static let blurRadius: CGFloat            // 64, applied before the zoom
        static let frameInterval: TimeInterval    // 1.0 / 15, as WelcomeBackdrop
        static let veilTopOpacity: Double         // 0.65
        static let veilBottomOpacity: Double      // 0.80
        static let veilTextStop: CGFloat          // 0.62 of the height: bottom opacity from here down
        static let designSize: CGSize             // 393 x 844, the reference frame of the margin invariant
        /// Three stops of Track1Tokens.colorBackgroundElevated: top opacity at 0, bottom opacity at
        /// veilTextStop and at 1.
        static func veilStops() -> [Gradient.Stop]
        /// How far the zoomed image overflows one side of the screen: (zoom - 1) / 2 * side.
        static func overflow(side: CGFloat) -> CGFloat
    }
    /// Decorative, absolute: ignoresSafeArea, allowsHitTesting(false), accessibilityHidden(true).
    struct AmbientCoverBackdrop: View { init(cover: Image) }
Rendu du composant (ordre des modificateurs, D2) : `cover.resizable().scaledToFill()` cadré à la taille du
`GeometryReader` → `.blur(radius: blurRadius, opaque: true)` → `.scaleEffect(zoom)` → `.offset` de
`AmbientDrift.offset(phase:)` → recadré à la taille du `GeometryReader` et `.clipped()` → `.overlay` du
voile `LinearGradient(stops: veilStops(), startPoint: .top, endPoint: .bottom)`. Phase lue dans
`TimelineView(.animation(minimumInterval: frameInterval, paused: reduceMotion))` depuis un
`@State start = Date()` ; sous `accessibilityReduceMotion`, phase 0.

## Critères d'acceptation
Track1Core (`AmbientDriftTests`, `swift test --package-path ios/Track1Core`) :
- [ ] `loopDuration == 60` ; `phase(elapsed:)` donne 0, 0.25, 0, 0.25 pour 0, 15, 60, 75 s (± 1e-12).
- [ ] `offset(phase: 0) == (0, 0)` et `offset(phase: 0) == offset(phase: 1)` (± 1e-9) : pas de coupure.
- [ ] Pour 1000 phases régulières de 0 à 1 : `|x| ≤ amplitude.x` et `|y| ≤ amplitude.y`.
- [ ] Continuité : pour 900 pas (`loopDuration × 15`), chaque composante bouge de moins de 0.25 pt entre deux
      pas consécutifs.
- [ ] `offset(phase: 1.25) == offset(phase: 0.25)` et `offset(phase: .nan) == (0, 0)` (la phase passe par
      `LoopPhase.wrapped`).
Track1Tests (`AmbientCoverBackdropTests`, `ios-check`) :
- [ ] `zoom == 1.7`, `blurRadius == 64`, `frameInterval == 1/15` (± 1e-12), `veilTopOpacity == 0.65`,
      `veilBottomOpacity == 0.80`, `veilTextStop == 0.62`, `designSize == (393, 844)`.
- [ ] Invariant de marge : `overflow(side: 393) ≥ CGFloat(AmbientDrift.amplitude.x) + blurRadius` et
      `overflow(side: 844) ≥ CGFloat(AmbientDrift.amplitude.y) + blurRadius`.
- [ ] `veilStops()` : trois stops aux positions `[0, 0.62, 1]`, chacun de la couleur
      `Track1Tokens.colorBackgroundElevated` (composantes RGB égales, via `UIColor.getRed`) aux opacités
      `[0.65, 0.80, 0.80]` (± 1/255) ; opacités croissantes du haut vers le bas.
- [ ] WCAG, sur un blanc pur `RGB(hex: 0xFFFFFF)` : `WCAGContrast.ratio(textPrimary, composite(elevated,
      opacity: veilTopOpacity, over: white)) ≥ 4.5` ; `ratio(textSecondary, composite(elevated, opacity:
      veilBottomOpacity, over: white)) ≥ 4.5` ; et, pour prouver que le voile est nécessaire,
      `ratio(textSecondary, white) < 4.5`.
- [ ] `veilTextStop × 844 ≤ TodayHomeMetrics.mainBlockTop + coverSide + mainBlockSpacing +
      NodeTypeBadge.tagRole.lineHeight + mainBlockSpacing` (le voile est à son maximum avant le titre) et
      `veilTextStop × 844 ≥ TodayHomeMetrics.mainBlockTop` (il n'assombrit pas le bloc du haut au maximum).
- [ ] `AmbientCoverBackdrop(cover: Image(systemName: "photo"))` se construit (pin du contrat).
- [ ] `ios-check` vert ; `npm run check` vert (`test/ios-core-package.test.ts` : pas de
      `@testable import Track1Core` côté app).

## Tests attendus
- unitaire Track1Core : nominal (phase, offset à 0 et 1), limite (bornes, continuité), erreur (NaN, phase
  hors 0...1).
- unitaire Track1Tests : constantes, invariant de marge, stops du voile, contraste WCAG, position du stop
  texte, construction.
- Pas de test de rendu ni d'intégration : l'effet se juge sur appareil (ticket 1.2).

## Tier de risque
tier/2 — nouveau composant avec état (`@State start`, `TimelineView`) et coût de rendu continu ; aucun
chemin sensible.

## Notes d'implémentation
- Reprendre la structure de `WelcomeBackdrop.swift` (en-tête, `reduceMotion`, `start`, `TimelineView`,
  `GeometryReader` + `.clipped()`, `.ignoresSafeArea().allowsHitTesting(false).accessibilityHidden(true)`)
  et celle d'`AmbientGlow` pour la place des constantes. Ne pas copier la logique couleur.
- Le flou **avant** `scaleEffect` (D2) : rendu à la taille de mise en page, puis transformation Core
  Animation ; `opaque: true` pour ne pas créer de frange transparente.
- Sous Reduce Motion : `paused: true` **et** phase 0 (la `TimelineView` rend une fois : il faut forcer la
  phase, comme le `if reduceMotion { field(phase: 0) }` de `WelcomeBackdrop`).
- Les valeurs (1.6, 64, 24 × 16, 60 s, 0.65 / 0.80 / 0.62) sont les décisions D3-D5 : les poser telles
  quelles, Raphael règle sur appareil au ticket 1.2.
- Commentaires en anglais ; un commentaire par constante qui dit *pourquoi* (les deux opacités du voile
  et le stop texte renvoient au calcul WCAG, l'invariant de marge au flou et à la dérive) ; en-tête du
  composant : brief du 2026-11-25, référence Chromecast, pas de node Figma, ID du ticket.
- `swift-format` strict : tabs, 110 colonnes. Aucune couleur brute : `Track1Tokens.colorBackgroundElevated`
  (`DesignSystem/` n'est pas scanné, mais on n'en a pas besoin).
- `AmbientDrift` : `Foundation` seulement, pas de `#if os(iOS)` ; tuple nommé comme `ProgressFraction.sweep`.
- Commits conventionnels, `Refs TRA-829` ; PR titrée `TRA-829 …`, `Fixes TRA-829`.
```

### TRA-830 (1.2) — Remplacer le dégradé de la home par le fond ambiant de la cover

- Tier : **tier/2** · Estimate : **2** · Partie 1 · Labels : `tier/2` · Dépend de 1.1

```markdown
## Contexte
La home de l'onglet Today dessine derrière son contenu `background.elevated` et, quand la cover a une
teinte, le dégradé à quatre stops emprunté au lecteur (`PlayerMetrics.tintStops`). Elle doit désormais
dessiner la cover elle-même, floutée, zoomée et en dérive lente sous un voile sombre
(`AmbientCoverBackdrop`, ticket 1.1), et rester exactement comme aujourd'hui sans cover. Le dégradé n'est
plus dessiné : ses constantes et le paramètre `tint` disparaissent de la home. Sous Reduce Transparency, la
home reste plate.
Plan : docs/plans/home-ambient-cover-background.md#partie-1 (D1, D6) et « Relation avec
`player-gradient-tint` ».

## Portée
Fichiers à modifier (chemins et lignes vérifiés sur `b680912`) :
- `ios/Track1/Features/Today/TodayHomeView.swift` — supprimer `TodayHomeMetrics.tintHeight` et
  `tintStops(_:)` et leur commentaire (l. 37-43) ; ajouter à `TodayHomeContent` l'énumération `Backdrop`
  et `backdrop(hasCover:reduceTransparency:)` ; `TodayHomeView` : retirer la propriété et le paramètre
  `tint` (l. 127, 132-134), ajouter `@Environment(\.accessibilityReduceTransparency)`, réécrire `backdrop`
  (l. 164-174) : `colorBackgroundElevated` sous tout, et `AmbientCoverBackdrop(cover:)` par-dessus quand
  `backdrop(hasCover:reduceTransparency:) == .ambient`. L'en-tête du fichier (l. 4) et le commentaire de
  `backdrop` (l. 164) sont réécrits : la home ne suit plus `324:1790` pour le fond, le ticket gagne.
- `ios/Track1/Features/Today/TodayView.swift` — `Page` perd `tint` (l. 24) ; l'appel `TodayHomeView(…)`
  (l. 96-99) et `Page(…)` dans `read()` (l. 152-156) ne passent plus de teinte. `NodeHeroModel` reste créé
  et chargé (l. 147-148) : c'est lui qui donne la cover.
- `ios/Track1Tests/Node/TodayHomeViewTests.swift` — supprimer la fixture `tint` (l. 38-45),
  `testTheBackgroundIsTheFourStopGradientOfTheReader` et `testWithoutATintTheBackgroundIsFlat`
  (l. 123-140) ; réécrire `testTheViewIsBuiltWithOrWithoutATintAndACover` (l. 201-207) sans `tint` ; ajouter
  les tests des critères ci-dessous.
Hors-scope explicite :
- `AmbientCoverBackdrop`, `AmbientCoverBackdropMetrics`, `AmbientDrift` et leurs valeurs (ticket 1.1) : on
  les appelle, on ne les change pas. Un réglage de valeurs se fait dans ce ticket **après** la revue sur
  appareil, par commit de suivi, jamais en changeant la structure.
- `PlayerMetrics`, `PlayerView`, `CoverTintGradient`, `CoverTintTone`, `NodeHeroModel`, `NodePageView`,
  `DominantColor` : pas touchés (le lecteur est `docs/plans/player-gradient-tint.md`).
- `todayBackdrop()` et les écrans chargement / vide / indisponible ; `coverView`, le bloc du haut, le
  titre, `DiscoverButton` ; les autres mesures de `TodayHomeMetrics` ; les identifiants d'accessibilité
  `today-home` / `today-title` / `today-discover` (lus par `TodayFlowTests`).
- Mise en pause quand l'onglet Genres est sélectionné : à mesurer d'abord (plan, Risques), ticket de suivi
  si nécessaire.
- Figma, `deploy/`, `.github/`, `web/`, pbxproj (aucun fichier nouveau).

## Contrat
    extension TodayHomeContent {
        enum Backdrop: Equatable { case ambient, flat }
        /// `.ambient` only with a cover and without Reduce Transparency; `.flat` is today's elevated colour.
        static func backdrop(hasCover: Bool, reduceTransparency: Bool) -> Backdrop
    }
    struct TodayHomeView: View {
        init(home: TodayHome, cover: Image?, isOpening: Bool, discover: @escaping () -> Void)
    }
`TodayHomeMetrics` n'a plus ni `tintHeight` ni `tintStops`. `TodayView.Page` porte `recommendationID`,
`home`, `cover`. `TodayHomeView.swift` ne mentionne plus `PlayerMetrics` ni `CoverTint`.

## Critères d'acceptation
Dans `TodayHomeViewTests` (`ios-check`) :
- [ ] `backdrop(hasCover: true, reduceTransparency: false) == .ambient`.
- [ ] `backdrop(hasCover: false, reduceTransparency: false) == .flat` et
      `backdrop(hasCover: true, reduceTransparency: true) == .flat`,
      `backdrop(hasCover: false, reduceTransparency: true) == .flat`.
- [ ] Le source `ios/Track1/Features/Today/TodayHomeView.swift`, lu comme
      `PlayerViewTests.testThePlayerSourceDrawsNoShareControl` lit `PlayerView.swift`, ne contient ni
      `PlayerMetrics` ni `tintStops` ni `CoverTint`, et contient `AmbientCoverBackdrop(`.
- [ ] `TodayHomeView(home:cover:isOpening:discover:)` se construit avec `cover: nil` et avec
      `cover: Image(systemName: "photo")` (pin du contrat, remplace le test l. 201-207).
- [ ] Les tests existants de mesures, de cover, de textes et de `TodayHomeScreen` sont inchangés et verts.
- [ ] `ios-check` vert (y compris `TodayFlowTests` : la fixture n'a pas de cover, la home de test reste
      plate) ; `npm run check` vert (`test/ios-design-tokens.test.ts` : aucune couleur brute dans
      `Features/Today/`).
- [ ] Revue sur appareil par Raphael (build de dev ou TestFlight) : effet visible avec une cover, fond
      plat sans cover, immobile sous Reduce Motion, plat sous Reduce Transparency ; coût GPU au repos
      relevé sur la home et sur l'onglet Genres, consigné dans la PR.

## Tests attendus
- unitaire Track1Tests : `backdrop` (nominal `.ambient`, limites `.flat` × 3), assertion textuelle sur le
  source, construction de la vue sans `tint`.
- Pas de test de rendu : l'effet et le coût se jugent sur appareil, et la revue le consigne.

## Tier de risque
tier/2 — change le fond de l'écran principal pour tous les utilisateurs et introduit un rendu continu sur
cet écran ; couvert par des tests de contrat, aucun chemin sensible, Raphael notifié.

## Notes d'implémentation
- D1 est tranchée : le dégradé **disparaît** de la home, on ne le garde ni en repli ni sous la cover. Ne
  pas rediscuter.
- Ordre des `.background` : `TodayHomeView.body` garde `.background(alignment: .top) { backdrop }` et
  `.ignoresSafeArea(.container, edges: .top)` (l. 160-161) ; dans `backdrop`, le `ZStack` garde
  `colorBackgroundElevated` en premier et `.ignoresSafeArea()` (l. 166-173) ; `AmbientCoverBackdrop`
  remplace le `LinearGradient` et son `.frame(height:)`.
- `@Environment(\.accessibilityReduceTransparency)` est lu dans la vue et passé à la fonction pure, comme
  `reduceMotion` est passé à `Track1Motion.animation(_:reduceMotion:)` ailleurs.
- Coordination avec `player-gradient-tint` T1 : si sa PR est ouverte sur `TodayHomeView.swift` l. 37-43 ou
  `TodayHomeViewTests.swift` l. 123-140, le second mergé rebase ; dans tous les cas, **ce ticket supprime**
  ces lignes (les constantes recopiées par T1 comprises).
- Mesure du coût : Xcode → Debug Navigator → jauge énergie et GPU, home immobile 30 s, puis onglet Genres
  30 s ; Instruments « Core Animation FPS » si la jauge est ambiguë. Noter les valeurs dans la PR. Au-dessus
  de ~10 % de GPU au repos : ticket de suivi (pré-flou CoreImage ou `frameInterval = 1/10`), pas de
  changement dans ce ticket.
- Commentaires en anglais, datés, avec l'ID du ticket là où le code s'écarte du mock-up `324:1790`.
- `swift-format` strict, tabs, 110 colonnes. Commits conventionnels, `Refs TRA-830` ; PR `TRA-830 …`,
  `Fixes TRA-830`.
```

## Amendement du 2026-11-26 — zoom 1,7

Validé par Raphael pendant l'implémentation de TRA-829 : le flou est appliqué avant le zoom, donc agrandi
avec l'image. À 1,6 sa bande de bord faisait environ 102 pt à l'écran et la dérive en montrait environ 8 pt
sur 393 pt de large. Le zoom passe à 1,7 et l'invariant de marge testé devient
`overflow ≥ amplitude + blurRadius × zoom`. Les mentions « 1,6 » qui restent plus haut (Q2, notes du
brouillon 1.1) sont historiques.
