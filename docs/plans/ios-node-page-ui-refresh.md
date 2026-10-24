# Fiche de nœud iOS : rafraîchissement de l'interface (carte, chips, teinte de pochette, barre d'onglets)

Plan de la phase `plan` du process de livraison, écrit le 2026-10-23 sur le brief Figma « UI Refresh ».
**Validé le 2026-10-23 par le dispatcher sur délégation de Raphael.** Projet Linear P-TRA-8 :
https://linear.app/workspaceperso/project/fiche-de-noeud-ios-rafraichissement-de-linterface-67c53dca9a99
(milestones = parties 1 à 3, tickets TRA-657 → TRA-671 ; **partie 4 ajoutée le 2026-10-24** après
l'arbitrage Q5 de Raphael : milestone 4, tickets TRA-698 et TRA-699, parent TRA-676). Il complète
[`track1-ios-figma.md`](track1-ios-figma.md) : il **remplace sa décision D8** (barre d'onglets native) et
**amende sa décision D10** (une teinte dominante → une palette de pochette à trois bandes). Tout le reste de
ce plan reste en vigueur, en particulier D9 (ordre des sections = Data contract) et le contrat des
identifiants d'accessibilité de H.1.

Source de vérité design : Figma `phudxrQNlzQJafXLma4FyX`, section « UI Refresh » `286:1712` : écran
`2.1 Today · project — Cosmogramma` `282:835` (contenu `282:837`, carte `285:1034`, badge `286:1668`,
héros `286:1672`, chip `286:1662`, barre de streaming `282:888`, barre d'onglets `282:889`) et carte de
spec `Spec · 2.1 project` `286:1697` (texte « UI » `286:1701`, texte « Background · cover tint »
`293:832`). Les valeurs de l'annexe A ont été lues le 2026-10-23 via le MCP Figma (`get_design_context`).

Tous les chemins sont relatifs à la racine du dépôt. État du dépôt au moment du plan : `9a9471de`
(263 tests dans `ios/Track1Tests`, 491 dans `ios/Track1Core/Tests`, comptés par `grep 'func test'`). La
partie 4 a été précisée le 2026-10-24 sur `e651dc75` (parties 1 à 3 mergées).

## Problème

La fiche de nœud livrée par le plan Figma (`ios/Track1/Features/Node/NodePageView.swift`) est celle de
l'écran 2.1 d'origine. Le designer a produit une révision « UI Refresh » de ce même écran et demande,
dans la carte de spec `286:1697`, de l'appliquer **à tous les types de nœuds** :

1. **Halo teinté** : l'ombre portée sous la pochette (boîtier) et sous le disque prend les couleurs de la
   pochette (`drop-shadow 0 0 5 #6A877E` sur Cosmogramma). Aujourd'hui, seule la coque du boîtier porte
   une ombre noire (`HeroJewelCase`, `.black.opacity(0.18)`), et la teinte calculée (`DominantColor.of`)
   ne sert qu'à l'étiquette du disque et au glow radial (`AmbientGlow`).
2. **Fond teinté par la pochette** : un dégradé linéaire vertical, opaque, dérivé de la palette de la
   pochette, sur le parent (fond de page) et sur une **carte de contenu** (nouvelle) qui enveloppe la
   fiche ; les deux dégradés rejoignent leur jeton (`background/base` pour le parent, `background/elevated`
   pour la carte) à 50 % de leur hauteur. Aujourd'hui, le fond est `colorBackgroundBase` plus un glow
   radial de 280 pt (`AmbientGlow`, tons ember / silver / teinté selon la racine et le type).
3. **Nouveau style de chip** : sans remplissage, bordure `#7D6459` à 20 %, rayon 6 pt. Aujourd'hui :
   remplissage `colorBackgroundElevated`, bordure `colorBorderDefault`, rayon 0 (`EdgeChipStyle`,
   `EdgeChipMetrics`).
4. **Barre d'onglets** : icônes seules (sans texte), icônes spécifiques (maison, double croche, loupe),
   couleurs actif / inactif fixées (`#F0642D` / `#C8B6A3`), effet « liquid glass » plus discret, et une
   marge haute de 12 pt qui, avec les 8 pt entre la barre de streaming et la barre d'onglets, donne les
   20 pt exacts du Figma entre les boutons Apple Music / Spotify et la pilule. Aujourd'hui, la barre est
   la `TabView` native (`ios/Track1/App/RootView.swift`, `ApplicationTabs.tabs`) : Liquid Glass natif et
   `Tab(role: .search)` sous iOS 26, `.tabItem` + `.ultraThinMaterial` avant ; libellés affichés ;
   SF Symbols `house`, `music.note`, `magnifyingglass` ; aucune marge réglable.
5. **« Tous les écarts avec la prod »** : relevés dans l'annexe A.3 ; ceux qui restent ambigus sont
   posés en questions au gate.

Ce qui ne bouge pas et contraint la solution :

- Le projet Xcode référence chaque fichier Swift de `ios/Track1` et `ios/Track1Tests` explicitement
  (`ios/Track1.xcodeproj/project.pbxproj`, identifiants `F1…`/`B1…` par plage ; dernière plage utilisée :
  `0410–0412`). **Plage réservée à ce plan : `0420–042F`.** `ios/Track1Core` n'a pas besoin du pbxproj.
- `test/ios-design-tokens.test.ts` interdit toute couleur brute et police système hors
  `ios/Track1/DesignSystem/`. Les conversions RGB → `Color` et les nouveaux styles vivent donc dans le
  design system, jamais dans `Features/` ou `App/`.
- `ios/Track1Tests/DesignSystem/Track1TokensTests.swift` compte les couleurs (47 aujourd'hui) : tout
  jeton ajouté y est déclaré.
- En local, seul `swift test --package-path ios/Track1Core` est autorisé ; l'app n'est compilée que par le
  job `ios-check` (runtime iOS 26.4, cible de déploiement iOS 17.0). Voir `docs/track1-builds.md`.
- Les tests UI (`ios/Track1UITests/*.swift`) trouvent les onglets par `app.tabBars.buttons["Aujourd’hui"]`
  etc. (≈ 45 appels dans 6 fichiers) et vérifient `isSelected`. Une barre dessinée à la main n'est pas un
  `tabBars` pour XCUITest : la migration de ces requêtes fait partie du plan.
- La teinte dominante est calculée sur l'iPhone par `CIAreaAverage` sur un échantillon 32 × 32
  (`ios/Track1/Media/DominantColor.swift`) ; `cover_url` n'existe pas dans l'API mobile (D10 : rejeté).
- Les identifiants d'accessibilité de la fiche (`node-hero`, `node-title`, `teaser`, `section-<field>`,
  `edge-chip-<slug>`, `release-card-<slug>`, `streaming-bar`, …) sont le contrat des tests UI : aucun
  n'est renommé.
- L'analytics n'est pas concernée : `node_viewed` est enregistré par `NodeViewModel`, pas par la vue ;
  un changement d'onglet n'émet aucun événement.

## Non-buts

- Aucun changement d'API mobile ni de schéma (`src/schemas.ts`, `src/node-spec.ts`) : la palette est
  calculée sur l'iPhone, comme la teinte dominante (D10).
- Aucun changement de `NodePageModel`, `NodePageSpec`, de l'ordre des sections ni des libellés (D9).
- Aucun changement des composants dont le Figma rafraîchi est identique à la prod : `SectionHeader`,
  `TrackRow`, `ReleaseCard`, `StreamingButton`/`StreamingBar` (annexe A.3).
- Pas d'écran Figma pour les autres types de nœuds : les règles « tous les types » sont tranchées ici
  (décisions D3 et D5), pas inventées par l'implémenteur.
- Pas de relèvement de la cible iOS, pas de `tabBarMinimizeBehavior`, pas de glow radial redessiné :
  `AmbientGlow` reste pour `todayBackdrop()`, l'onglet Genres, l'onboarding, l'écran de confidentialité
  et les états sans page de `NodeView` ; il quitte seulement la fiche chargée (`NodePageView`).
- Pas de tests de capture d'écran (snapshot) : la validation visuelle reste celle de Raphael sur iPhone.
- La ligne « parce que tu explores … » sous la date (`286:1669`) n'est **pas** un rafraîchissement
  d'interface mais une donnée nouvelle ; elle est isolée en partie 4, retenue par Raphael le 2026-10-24
  (Q5, D8).

## Décisions d'archi

### D1 — Barre d'onglets dessinée dans le design system, `TabView` conservée comme conteneur (remplace D8)

- **Décision.** `Track1TabBar` (nouveau composant sans état, `ios/Track1/DesignSystem/Components/Navigation/`)
  dessine la pilule à deux onglets et le bouton rond de recherche aux cotes du Figma. `RootView` garde
  `TabView(selection:)` pour les piles de navigation par onglet et l'état de sélection, masque la barre
  native (`.toolbar(.hidden, for: .tabBar)` sur le contenu de chaque onglet) et monte `Track1TabBar` en
  `.safeAreaInset(edge: .bottom)` de la `TabView`. Un seul chemin de code pour iOS 17 → 26 : la branche
  `#available(iOS 26, *)` et `Tab(role: .search)` disparaissent ; le bouton Recherche appelle
  `router.select(.search)` qui ouvre la sheet comme aujourd'hui.
- **Pourquoi.** La spec impose une géométrie (pilule 200 × 62, onglets 96 × 54, cercle 62, marge haute
  12 pt), des couleurs actif / inactif, l'absence de texte et un verre « plus discret » : la barre native
  ne permet aucun de ces réglages, ni sous iOS 26 (Liquid Glass imposé) ni avant (barre pleine largeur).
- **Rejeté : garder la barre native et la personnaliser** (`UITabBarAppearance`, `tint`, libellés
  vides). Impossible d'obtenir la pilule, le cercle isolé, la marge de 12 pt ni d'atténuer le verre.
- **Rejeté : abandonner `TabView` pour un `ZStack` maison.** On perdrait la conservation native des
  piles et des positions de défilement de chaque onglet, pour un diff plus gros, sans gain visuel.

### D2 — Palette de pochette à trois bandes, mathématiques pures dans `Track1Core` (amende D10)

- **Décision.** `DominantColor` (app) gagne `bands(of:)` : trois `CIAreaAverage` sur les tiers haut /
  milieu / bas du même échantillon 32 × 32 (une seule réduction d'image). `Track1Core` gagne
  `CoverTintTone.tint(bands:)` : pour chaque bande, teinte et saturation conservées (saturation plafonnée
  à 0,35), luminosité HSB imposée par l'échelle 0,33 / 0,27 / 0,20 ; le halo du héros est la bande haute
  remontée à 0,53 de luminosité avec sa saturation × 1,65 (plafond 0,35). Ces constantes reproduisent les
  stops de référence Cosmogramma (`#4A5552`, `#44423A`, `#322A22`) et le halo `#6A877E` à ±2/255 près
  (annexe A.2).
- **Pourquoi.** La spec demande « the cover artwork palette, not the CD label color » et une transition
  « blue-green → sage → sandy » : des bandes verticales de la pochette donnent exactement cette lecture,
  avec le même outil que la teinte dominante. Les constantes dans Core sont testables par `swift test`
  en local.
- **Rejeté : quantification k-means / histogramme.** Plus coûteux, non déterministe sans graine, et la
  spec n'exige qu'un dégradé vertical « doux ».
- **Rejeté : précalculer la palette côté pipeline.** Champ de schéma, tier/3, et D10 l'a déjà écarté.

### D3 — Même traitement pour tous les types ; repli sur la couleur du type sans image

- **Décision.** La teinte vient de l'image que le héros affiche, quelle que soit sa chaîne (`.release`
  pour project / track, `.photo` ou `.derivedCover` pour artist). Sans image (genre, label, artiste
  sans photo, placeholder), la palette de repli est `CoverTintTone.tint(bands:)` nourrie trois fois de
  `Track1Tokens.colorNode(type)` : la même échelle produit un dégradé sourd aux couleurs du type.
  La distinction racine / non-racine (silver hors racine) disparaît avec `glowTone`.
- **Pourquoi.** « apply it to all the nodes type » ; les genres et labels n'ont jamais d'image (D10, Q5
  du plan Figma) et doivent pourtant recevoir la carte et le fond.
- **Rejeté : fond plat (base / elevated) sans image.** Les fiches genre et label seraient les seules
  sans ambiance, alors que l'ember / silver actuels leur en donnent une.
- **Rejeté : garder `AmbientGlow` sous le dégradé.** La spec dit « do not fade to transparency or
  blur » : deux ambiances superposées se contredisent.

### D4 — Le dégradé parent est fixé au viewport ; celui de la carte suit la hauteur de la carte

- **Décision.** Le fond de page (`NodePageView`) est un `CoverTintGradient` plein cadre, non défilant,
  stops à 0 / 13 / 27 / 50 % de la hauteur **du viewport**, point final `colorBackgroundBase`. La carte
  (`NodeContentCard`) porte son propre `CoverTintGradient` aux mêmes positions relatives à **sa** hauteur,
  point final `colorBackgroundElevated` ; elle défile avec le contenu.
- **Pourquoi.** Dans le Figma, le parent est le cadre de contenu entier (2 033 pt) : « measured relative
  to each frame's own height » rendrait la teinte du parent dépendante de la longueur de la fiche
  (15 pistes ou 2 sections). Fixer le parent au viewport donne la même ambiance à toutes les fiches ; la
  carte, elle, est bien un cadre dont la hauteur est celle du contenu, comme dans le Figma.
- **Rejeté : parent proportionnel à la hauteur de contenu.** Visible seulement dans les gouttières de
  16 pt et derrière le top bar ; dépend du nœud ; plus coûteux (lecture de la hauteur du contenu).
  Facile à changer plus tard : c'est un paramètre de `CoverTintGradient`.

### D5 — Halo teinté sur le boîtier et le disque seulement

- **Décision.** `HeroDisc` et `HeroJewelCase` reçoivent chacun `.shadow(color: halo, radius: 2.5,
  x: 0, y: 0)` (`drop-shadow 0 0 5` Figma, convention du fichier : rayon SwiftUI = rayon Figma / 2, voir
  le commentaire de la coque). L'ombre noire existante de la coque est conservée. Les héros photo
  (`.photo`, `.cover`) ne reçoivent pas de halo.
- **Pourquoi.** La spec nomme « the CD cover & its CD ». Rien n'est dessiné pour une photo d'artiste.
- **Rejeté : halo sur toutes les images.** Non spécifié ; à ajouter si Raphael le demande (Q7).

### D6 — Badge de type = type du nœud affiché, vocabulaire des tags de chip

- **Décision.** Le badge en tête de carte (`286:1668`) affiche `EdgeChip.tag(for: node.type)`
  (« ARTIST », « PROJECT », … déjà en majuscules anglaises) dans `colorNode(type)`, précédé d'un carré
  12 × 12 de la même couleur, rôle `.monoSection` (Bold 15/20 : le Figma dessine 14/25 hors style, on ne
  crée pas un rôle pour un seul usage). Sur la fiche Cosmogramma, il lira donc « PROJECT », pas
  « ARTIST » (Q1).
- **Pourquoi.** Le Figma écrit « ARTIST » en `#5D7FA8` (= `colorNodeArtist`) sur une fiche de projet :
  soit une coquille de maquette, soit un sens non documenté. Lier le badge au type du nœud est la seule
  lecture qui s'applique « à tous les types ».
- **Rejeté : eyebrow fixe « ARTIST » / « du jour ».** Faux sur quatre types sur cinq.

### D7 — Migration des tests UI en deux temps

- **Décision.** D'abord (3.1, test seul) des aides `UITestFlows.tabBar(in:)` et `tabButton(_:in:)` qui
  encapsulent `app.tabBars…` sans changer le comportement ; ensuite (3.4) la barre dessinée et le
  basculement des deux aides vers `app.otherElements["tab-bar"]` et `app.buttons["tab-<onglet>"]`.
- **Pourquoi.** Le job `tests-Track1` exécute toute la suite UI : une PR qui remplace la barre doit
  laisser les 45 appels verts. Les isoler avant rend la PR de bascule petite et lisible.
- **Rejeté : tout dans une PR.** > 300 lignes, mélange test / UI.

### D8 — Les genres du profil sont résolus au choix du jour et persistés avec la recommandation

- **Décision.** Au moment où `TodayViewModel.load(for:)` lit le catalogue pour choisir l'œuvre du jour, il
  construit `EditorialGenreTaxonomy(catalog:)` et résout `profile.selection.genres` (ids de taxonomie, dans
  l'ordre de coche) en noms éditoriaux (`EditorialGenreChoice.name`), trois au plus, ids inconnus ignorés.
  Les noms sont écrits dans `DailyRecommendation.profileGenreNames` (clé `profile_genre_names`, `[]` par
  défaut au décodage) et persistés par `DailyRecommendationStore` avec le reste de la recommandation. La vue
  lit `TodayPresentation.reasonLine(of:)`, fonction pure : `nil` sans nom. Sans `selection` (profil v1), avec
  une taxonomie `degraded` ou un catalogue indisponible, la liste est vide et la ligne absente ; la date ne
  change pas.
- **Pourquoi.** Une recommandation déjà persistée est servie sans relire le catalogue (TRA-343,
  `TodayViewModel.swift:14-15`) : résoudre les noms à l'affichage obligerait soit à relire le catalogue à
  chaque lancement (et à perdre la ligne hors ligne), soit à accepter une ligne présente au premier lancement
  du jour et absente ensuite. La révision du profil fait partie de la clé de cache : une sélection modifiée
  produit une nouvelle recommandation, donc de nouveaux noms ; les noms stockés ne peuvent pas être périmés.
- **Rejeté : résoudre à l'affichage en relisant le catalogue.** Un appel réseau par lancement, contraire à
  TRA-343, et un top bar asynchrone alors que `NodeView` fige son contenu à la création
  (`ios/Track1/Features/Node/NodeView.swift:21-23`).
- **Rejeté : stocker les noms dans le profil.** Changement du format `profile.v2.json` et du flux
  d'onboarding, livré par un autre projet ; rayon d'impact sans rapport avec la ligne.
- **Rejeté : `genre_ids` comme source.** Slugs triés par ordre alphabétique (`GenreSelection.swift:32`,
  `ProfileStore.swift:170`) et noms `CatalogNode.name`, jamais les noms éditoriaux : l'ordre de la personne et
  le vocabulaire de l'onboarding seraient perdus.
- **Rejeté : afficher `DailyRecommendation.reasons`.** « Lié à X » / « Proche de Y » : pas des genres, et
  l'arbitrage Q5 fixe la source.
- **Typographie et copie.** Le Figma dessine la ligne en JetBrains Mono Bold 12 / 25 hors style : comme pour
  le badge (D6), aucun rôle n'est créé pour un usage unique ; `.monoLabel` (Mono Regular 12 / 16, `.caption`)
  est réutilisé et la graisse Bold n'est pas reproduite (un rôle `monoCaption` Bold 12 / 16 serait un suivi
  DS de 1 pt si Raphael le demande). Couleur `colorTextTertiary`, 4 pt sous la date (métadonnées Figma lues
  le 2026-10-24 : date `282:838` y = 0, h = 24 ; ligne `286:1669` y = 28, h = 25, texte centré, x = 14 sur
  345), centrée, deux lignes au plus. Séparateur ` - ` (espace, trait d'union U+002D, espace), tel que
  dessiné ; « · » aurait été cohérent avec `OnboardingCopy.selectionSummary`, mais le Figma est la source de
  vérité de ce plan.

## Découpage

Quatre parties, chacune mergeable et déployable seule. Dans chaque partie, les tâches marquées ∥ sont
parallélisables (worktrees simultanés). Points : 1 ≈ 1–2 h, 2 ≈ 2–4 h, 3 ≈ une demi-journée.

### Partie 1 — Chips et carte de contenu

Incrément visible : la fiche prend le nouveau style de chip et la carte arrondie (fond elevated plat
pour l'instant), le teaser devient du texte, le badge de type apparaît. Aucune teinte : la partie 2
l'ajoute.

- [ ] TRA-657 **1.1 — DS · Jetons `colorBorderChip` et `radius6`, nouveau style d'`EdgeChip`** — tier/1,
  1 pt, ∥ (indépendante).
  - Portée : `ios/Track1/DesignSystem/Track1Tokens.swift` (ajouter `colorBorderChip = rgba(0x7D64_5933)`
    et `radius6: CGFloat = 6`), `ios/Track1/DesignSystem/Components/Node/EdgeChip.swift`
    (`EdgeChipMetrics.cornerRadius = Track1Tokens.radius6`, `EdgeChipStyle.fill = .clear`,
    `EdgeChipStyle.border = Track1Tokens.colorBorderChip` ; `pressedFill` reste `colorSurfacePressed` ;
    l'overflow garde sa bordure `colorBorderStrong` en tirets, prend le même rayon et le même fond
    transparent). Hors scope : `ChipFlowLayout`, `EdgeChipFormat`, les hauteurs (padding 8 inchangé →
    34 / 32 pt inchangés).
  - Contrat : `Track1Tokens.colorBorderChip: Color`, `Track1Tokens.radius6: CGFloat`.
  - Critères : `EdgeChipTests.testFillAndBorderAreElevatedBackgroundAndDefaultBorder` renommé et réécrit
    (fond `.clear`, bordure `colorBorderChip`, rayon 6) ; `Track1TokensTests` passe à 48 couleurs avec
    l'entrée `("theme.color.border.chip", colorBorderChip, "7d645933")` ; tous les autres tests
    d'`EdgeChipTests` inchangés et verts.
  - Tests : unitaires ci-dessus.
  - Notes : nom du jeton à déclarer dans le commentaire d'en-tête de `Track1Tokens.swift` comme les
    autres ; la valeur Figma est `rgba(125,100,89,0.2)` sur l'instance `282:856` et la frame `286:1662`.

- [ ] TRA-658 **1.2 — DS · `NodeContentCard` et `NodeTypeBadge`** — tier/1, 2 pts, ∥ (indépendante).
  - Portée : créer `ios/Track1/DesignSystem/Components/Node/NodeContentCard.swift` et
    `ios/Track1/DesignSystem/Components/Node/NodeTypeBadge.swift`, créer
    `ios/Track1Tests/DesignSystem/NodeContentCardTests.swift` ; enregistrer les trois fichiers dans
    `ios/Track1.xcodeproj/project.pbxproj` (identifiants `0420`, `0421`, `0422`, même forme que
    `EdgeChip.swift`). Hors scope : `NodePageView` (1.3), tout dégradé (2.4).
  - Contrat :
    - `struct NodeContentCard<Content: View>: View { init(@ViewBuilder content: () -> Content) }` —
      fond `colorBackgroundElevated`, `RoundedRectangle(cornerRadius: radius16, style: .continuous)`,
      padding 12 pt horizontal, 8 pt haut, 24 pt bas, `VStack(alignment: .leading, spacing: 18)`,
      identifiant `node-card`.
    - `enum NodeContentCardMetrics { cornerRadius = radius16; horizontalPadding = spacing12;
      topPadding = spacing8; bottomPadding = spacing24; sectionSpacing: CGFloat = 18;
      outerInset = spacing16; contentWidth(for pageWidth:) -> CGFloat }` (393 → 337).
    - `struct NodeTypeBadge: View { init(type: NodeType) }` — carré 12 × 12 `colorNode(type)`, espace
      8 pt, texte `EdgeChip.tag(for: type)` rôle `.monoSection` couleur `colorNode(type)`, identifiant
      `node-type-badge`, label VoiceOver = `EdgeChipFormat.typeLabel(type)` (nom français du type,
      `ios/Track1Core/Sources/Track1Core/Features/Node/EdgeChipFormat.swift:27`).
  - Critères : les métriques valent les valeurs ci-dessus ; le badge de chacun des 5 types a sa
    couleur de nœud et son tag ; `contentWidth(for: 393) == 337` ; les identifiants sont ceux du
    contrat.
  - Tests : `NodeContentCardTests` (métriques, largeur de contenu, 5 badges, identifiants).

- [ ] TRA-659 **1.3 — App · `NodePageView` dans la carte, teaser en texte** — tier/2, 3 pts, dépend de
  1.1 et 1.2.
  - Portée : `ios/Track1/Features/Node/NodePageView.swift` (`content(tint:)` : la `ScrollView` contient
    un `NodeContentCard` à 16 pt des bords, 24 pt sous le top bar ; dans la carte et dans cet ordre :
    `NodeTypeBadge(type: node.type)`, `NodeHero` centré, `titleBlock`, teaser, `FactsBlock`, les blocs
    de `NodePageModel.blocks(for:)`, `NodeArticleView` ; les `.padding(.horizontal, spacing24)` internes
    disparaissent au profit du padding de la carte ; le carrousel « related albums » a des marges de
    contenu égales au padding de la carte et est limité à la largeur de contenu de la carte),
    `ios/Track1/DesignSystem/Components/Node/TeaserCard.swift` (plus de fond ni de padding : texte
    `.bodyMedium` `colorTextPrimary`, identifiant `teaser` conservé, le nom du type reste),
    `ios/Track1/DesignSystem/Components/Node/NodeHero.swift` (`NodeHero.topInset` supprimé ou mis à 0 :
    la carte porte l'espacement), `ios/Track1Tests/DesignSystem/HeroTests.swift`
    (`testTheHeroSitsSixteenPointsBelowTheTopBarAndIsNamedNodeHero` → nouvelle géométrie),
    `ios/Track1Tests/Node/NodePageViewTests.swift`. Hors scope : fond de page et `AmbientGlow` (2.4),
    barre de streaming (3.4), ordre des sections (D9).
  - Contrat : aucun identifiant d'accessibilité existant ne change ; `node-card` et `node-type-badge`
    s'ajoutent.
  - Critères : la carte contient, dans l'ordre, badge, héros, titre, teaser, faits, sections, article ;
    le teaser n'a plus de fond ; les tests UI `TodayFlowTests`, `NavigationTests`, `SearchFlowTests`
    passent sans modification ; `tapAboveBar` continue de fonctionner (vérifié par les tests qui
    l'appellent).
  - Tests : `NodePageViewTests` (ordre des enfants de la carte via les identifiants, teaser sans fond) ;
    `HeroTests` adapté ; suite UI inchangée.
  - Notes : `.id(node.id)` reste sur le héros. Le `.padding(.bottom, spacing24)` du contenu reste
    sous la carte. Ne pas toucher à `highlightsView` autrement que pour l'enlever du padding 24.

- [ ] TRA-660 **1.4 (Q4 : oui) — DS · Date du top bar en JetBrains Mono Bold 18/24** — tier/1, 1 pt,
  ∥ (indépendante).
  - Portée : `ios/Track1/DesignSystem/Track1Typography.swift` (rôle `monoHeadline` :
    `.jetBrainsMonoBold`, 18, 24, `.callout`), `ios/Track1/DesignSystem/Components/Navigation/TopBar.swift`
    (`.date` passe de `.eyebrow` à `.monoHeadline`, couleur `colorTextSecondary` inchangée),
    `ios/Track1Tests/DesignSystem/Track1TypographyTests.swift`, `NavigationComponentsTests.swift`.
  - Critères : le rôle existe avec ces valeurs ; le top bar en mode date l'utilise ; `.eyebrow` reste
    (autres usages).

### Partie 2 — Teinte dérivée de la pochette

Incrément visible : halo teinté sous le boîtier et le disque, fond de page et carte en dégradé de
pochette (ou de couleur de type), `AmbientGlow` quitte la fiche.

- [ ] TRA-661 **2.1 — Core · `CoverTint` et `CoverTintTone`** — tier/1, 2 pts, ∥ (indépendante).
  - Portée : créer `ios/Track1Core/Sources/Track1Core/Media/CoverTint.swift` et
    `ios/Track1Core/Tests/Track1CoreTests/Media/CoverTintTests.swift`. Pas de pbxproj. Hors scope :
    tout ce qui touche UIKit / SwiftUI / Core Image.
  - Contrat :
    - `public struct LinearRGB: Equatable, Sendable { public let red, green, blue: Double }` (sRGB, 0…1).
    - `public struct CoverTint: Equatable, Sendable { public let stops: [LinearRGB] /* 3 */;
      public let shadow: LinearRGB }`.
    - `public enum CoverTintTone { public static let stopPositions: [Double] = [0, 0.13, 0.27];
      public static let endpointPosition: Double = 0.50; public static let stopBrightness: [Double] =
      [0.33, 0.27, 0.20]; public static let saturationMax: Double = 0.35; public static let
      shadowBrightness: Double = 0.53; public static let shadowSaturationGain: Double = 1.65;
      public static func tint(bands: [LinearRGB]) -> CoverTint? }` — `nil` si `bands.count != 3` ;
      conversion RGB ↔ HSB interne (pure).
  - Critères : bandes `hsb(164°, 0.13, 0.60)`, `hsb(48°, 0.15, 0.50)`, `hsb(30°, 0.32, 0.40)` →
    stops `#4A5552`, `#44423A`, `#322A22` et halo `#6A877E`, chaque canal à ±2/255 ; une bande saturée
    à 1,0 donne un stop à 0,35 de saturation ; une bande grise (saturation 0) donne un stop gris de la
    luminosité de l'échelle ; deux ou quatre bandes → `nil` ; le résultat est déterministe et
    `Equatable`.
  - Tests : les cinq cas ci-dessus dans `CoverTintTests`, exécutables par
    `swift test --package-path ios/Track1Core`.
  - Notes : la luminosité est la composante B de HSB (`max(r,g,b)`), comme lue sur les références
    (annexe A.2). Pas de dépendance à `Foundation` au-delà de ce que le package importe déjà.

- [ ] TRA-662 **2.2 — App · Bandes de la pochette et état du héros** — tier/2, 2 pts, dépend de 2.1.
  - Portée : `ios/Track1/Media/DominantColor.swift` (ajouter `static func bands(of image: UIImage) ->
    [LinearRGB]?` : trois `average(of:)` sur les tiers haut / milieu / bas du même échantillon 32 × 32,
    lignes 0–10, 11–21, 22–31, même division par l'alpha, `nil` si une bande est entièrement
    transparente ; `of(_:)` inchangé), `ios/Track1/Media/NodeHeroModel.swift`
    (`State.loaded(UIImage, tint: Color?, coverTint: CoverTint?)`), `ios/Track1/Features/Node/NodePageView.swift`
    (`heroTint(for:)` inchangé ; ajouter `static func coverTint(for state:) -> CoverTint?` ; aucun
    usage visuel encore), `ios/Track1Tests/Media/HeroImageTests.swift`,
    `ios/Track1Tests/Node/NodePageViewTests.swift`. Hors scope : le dessin (2.3, 2.4).
  - Contrat : `DominantColor.bands(of:) -> [LinearRGB]?` (3 éléments, haut → bas) ;
    `NodeHeroModel.State.loaded(_:tint:coverTint:)`.
  - Critères : une image 32 × 32 dont les tiers sont rouge / vert / bleu purs donne trois bandes
    `(1,0,0)`, `(0,1,0)`, `(0,0,1)` à ±2/255 ; une image à moitié transparente garde ses couleurs
    (règle de `average(of:)`) ; une image entièrement transparente donne `nil` ; après `load()`,
    `coverTint` est non nil quand `bands` l'est.
  - Tests : `HeroImageTests` (3 cas), `NodePageViewTests` (`coverTint(for:)` sur les 3 états).
  - Notes : une seule réduction d'image (`reduced(_:)`) pour les quatre moyennes. Le passage de
    `LinearRGB` à `Color` n'a pas lieu ici (jeton de lint) : il vit en 2.4 dans le design system.

- [ ] TRA-663 **2.3 — DS · Halo teinté du boîtier et du disque** — tier/1, 1 pt, dépend de 2.2 (pour la
  valeur) mais le composant peut être écrit en ∥ avec un `halo: Color?` fourni par l'appelant.
  - Portée : `ios/Track1/DesignSystem/Components/Node/NodeHero.swift` (`NodeHero.init` gagne
    `halo: Color? = nil` ; `ReleaseHero` l'applique à `HeroDisc` et `HeroJewelCase` par
    `.shadow(color:radius:x:y:)` avec `NodeHeroStyle.haloRadius = 2.5`, offset 0 ; l'ombre noire de la
    coque reste ; `.photo` / `.cover` ignorent `halo`), `ios/Track1Tests/DesignSystem/HeroTests.swift`.
    Hors scope : `NodePageView` (branché en 2.4).
  - Contrat : `NodeHero(kind:image:imageStyle:discTint:halo:accessibilityLabel:)` ;
    `NodeHeroStyle.haloRadius: CGFloat = 2.5`.
  - Critères : `haloRadius == 2.5` ; `NodeHeroStyle.appliesHalo(to kind:)` vrai pour `.release` seul.
  - Tests : `HeroTests` (les deux critères).

- [ ] TRA-665 **2.4 — App · Fonds en dégradé de pochette, fin d'`AmbientGlow` sur la fiche** — tier/2,
  3 pts, dépend de 1.3, 2.2, 2.3.
  - Portée : créer `ios/Track1/DesignSystem/Components/Node/CoverTintGradient.swift` (identifiant pbxproj
    `0423`) et `ios/Track1Tests/DesignSystem/CoverTintGradientTests.swift` (`0424`) ;
    `ios/Track1/DesignSystem/Components/Node/NodeContentCard.swift` (`init(tint: CoverTint?,
    @ViewBuilder content:)` : avec une teinte, le fond est `CoverTintGradient(tint:, endpoint:
    colorBackgroundElevated)` ; sans, le fond plat de 1.2) ; `ios/Track1/Features/Node/NodePageView.swift`
    (fond de page = `CoverTintGradient(tint:, endpoint: colorBackgroundBase)` plein cadre,
    `ignoresSafeArea`, non défilant ; `AmbientGlow` et `glowTone(isRoot:type:tint:)` supprimés ;
    `static func pageTint(coverTint: CoverTint?, type: NodeType) -> CoverTint` : la teinte de la
    pochette sinon `CoverTintTone.tint(bands: [rgb(colorNode(type)) × 3])` ; halo du héros =
    `Color(tint.shadow)` pour les kinds `.release`) ; `ios/Track1Tests/Node/NodePageViewTests.swift`
    (les trois tests `glow…` remplacés). Hors scope : `AmbientGlow.swift` et ses tests (le composant
    reste pour `todayBackdrop()`, `GenresTabView`, `PrivacyChoiceView`, `GenresStepView`), les états
    sans page de `NodeView.undrawn` (`ios/Track1/Features/Node/NodeView.swift:100-110`, chargement /
    « pas encore de fiche » / échec : ils gardent leur `AmbientGlow` ember / silver, le type du nœud
    n'étant pas connu avant la lecture), barre d'onglets.
  - Contrat :
    - `struct CoverTintGradient: View { init(tint: CoverTint, endpoint: Color) }` et
      `static func stops(tint: CoverTint, endpoint: Color) -> [Gradient.Stop]` = 5 stops :
      `stops[0]@0`, `stops[1]@0.13`, `stops[2]@0.27`, `endpoint@0.50`, `endpoint@1.0`, axe
      `.top → .bottom`.
    - `extension Color { init(_ rgb: LinearRGB) }` dans le même fichier (design system : seul endroit
      autorisé pour `Color(red:green:blue:)`).
    - `extension LinearRGB { init?(_ color: Color) }` ou équivalent via `UIColor`, dans le design
      system, pour la couleur de type.
  - Critères : les 5 stops ont ces positions et ces couleurs ; `pageTint` rend la teinte de la pochette
    quand elle existe, sinon une palette dont les 3 stops ont la teinte HSB de `colorNode(type)` (5
    types, racine ou non) ; `NodePageView` ne référence plus `AmbientGlow` ; la carte sans teinte garde
    le fond plat.
  - Tests : `CoverTintGradientTests` (stops, conversion aller-retour `LinearRGB` ↔ `Color` à ±1/255),
    `NodePageViewTests` (`pageTint` : pochette, repli par type, indépendance de `isRoot`).
  - Notes : les stops et le point final restent opaques (spec : « opaque, darkened colors »). Le
    `TopBar` reste au-dessus du fond de page comme aujourd'hui (même `VStack`).

### Partie 3 — Barre d'onglets

Incrément visible : la pilule Aujourd'hui / Genres et le bouton rond Recherche du Figma, icônes
seules, 20 pt entre les boutons de streaming et la pilule.

- [ ] TRA-667 **3.1 — Tests UI · Aides `tabBar(in:)` et `tabButton(_:in:)`** — tier/1, 1 pt, ∥
  (indépendante, à merger avant 3.4).
  - Portée : `ios/Track1UITests/UITestFlows.swift` (ajouter `static func tabBar(in app:
    XCUIApplication) -> XCUIElement` = `app.tabBars.firstMatch` et `static func tabButton(_ title:
    String, in app: XCUIApplication) -> XCUIElement` = `app.tabBars.buttons[title]`), remplacer tous les
    `app.tabBars…` de `NavigationTests.swift`, `ConsentTests.swift`, `SearchFlowTests.swift`,
    `TodayFlowTests.swift`, `ProfileFlowTests.swift` par ces aides (y compris l'argument `bar:` de
    `tapAboveBar`). Hors scope : tout fichier hors `ios/Track1UITests/`.
  - Critères : `grep -rn 'tabBars' ios/Track1UITests` ne trouve plus que les deux aides ; la suite UI
    est verte sans autre changement.
  - Tests : la suite UI elle-même (CI).

- [ ] TRA-669 **3.2 — DS · Icônes d'onglet en assets vectoriels et glyphes `Track1Icon` sur asset** —
  tier/1, 2 pts, ∥ (indépendante).
  - Portée : créer `ios/Track1/Resources/Assets.xcassets/Tab/` (`Contents.json` avec
    `provides-namespace`) et `Today.imageset`, `Genres.imageset`, `Search.imageset` (SVG de l'annexe B,
    `preserves-vector-representation`, `template-rendering-intent: template`) ;
    `ios/Track1/DesignSystem/Components/Core/Track1Icon.swift` (`Glyph` gagne `tabToday`, `tabGenres`,
    `tabSearch` ; `enum Source { case system(String), asset(String) }` et `var source: Source` ;
    `systemName` ne reste défini que pour les glyphes système ou devient optionnel ; le `body` rend
    `Image(systemName:)` ou `Image(asset)` en `.renderingMode(.template)`) ;
    `ios/Track1Tests/DesignSystem/Track1IconTests.swift` (`testEveryGlyphIsItsSFSymbol` et
    `testEverySymbolExistsOnTheSystem` restreints aux sources système ; nouveau test : les trois assets
    se chargent par `UIImage(named: "Tab/Today")` etc.). Hors scope : `AppTab.glyph` (3.4) — la barre
    native actuelle a besoin d'un `systemImage`.
  - Contrat : `Track1Icon.Glyph.tabToday / .tabGenres / .tabSearch`, `Glyph.source`,
    noms d'assets `Tab/Today`, `Tab/Genres`, `Tab/Search`.
  - Critères : les trois assets existent et se chargent ; chaque glyphe système garde son SF Symbol ;
    la taille d'icône reste 20 pt (`testTheIconFrameIs20Points`).
  - Notes : les SVG de l'annexe B ont une couleur de trait figée ; le rendu `template` l'ignore et
    `Tone` colore. Le catalogue est référencé en bloc par le pbxproj : aucun identifiant à allouer.

- [ ] TRA-670 **3.3 — DS · `Track1TabBar`** — tier/1, 3 pts, dépend de 3.2.
  - Portée : créer `ios/Track1/DesignSystem/Components/Navigation/Track1TabBar.swift` (`0425`) et
    `ios/Track1Tests/DesignSystem/Track1TabBarTests.swift` (`0426`). Hors scope : `RootView`,
    `AppRouter`.
  - Contrat :
    - `struct Track1TabBar: View { struct Item: Identifiable, Equatable { let id: String; let glyph:
      Track1Icon.Glyph; let label: String; let identifier: String }; init(items: [Item], selected:
      String, search: Item, onSelect: @escaping (String) -> Void, onSearch: @escaping () -> Void) }`.
    - Dessin : fond = `LinearGradient` `colorBackgroundBase.opacity(0)` → `colorBackgroundBase`, haut →
      bas, sur toute la barre, `ignoresSafeArea(edges: .bottom)` ; rangée `HStack` : pilule (fond
      `.ultraThinMaterial` + `colorGlassSurface`, bordure 1 pt `colorGlassBorder`, rayon `radiusFull`,
      padding 4) contenant un bouton par item 96 × 54 (fond `colorGlassSelected` si sélectionné), `Spacer`,
      bouton rond 62 × 62 (même fond et bordure que la pilule) ; icônes 20 pt : sélectionné
      `colorIconAction`, autre `colorIconSecondary`, recherche `colorIconPrimary` ; padding 12 pt haut,
      25 pt horizontal ; bas : 0 avec indicateur d'accueil, 12 pt sans. Aucun `glassEffect`.
    - `enum Track1TabBarMetrics { tabWidth = 96; tabHeight = 54; pillPadding = spacing4;
      searchDiameter = 62; topPadding = spacing12; horizontalInset: CGFloat = 25; iconSize =
      sizeIconMedium; bottomPaddingWithoutHomeIndicator = spacing12; borderWidth: CGFloat = 1 }`.
    - `enum Track1TabBarStyle` exposant les couleurs ci-dessus par nom, pour les tests.
    - Accessibilité : conteneur `.accessibilityElement(children: .contain)` identifiant `tab-bar` ;
      chaque bouton `accessibilityLabel(item.label)`, `accessibilityIdentifier(item.identifier)`,
      trait `.isSelected` quand sélectionné ; le bouton de recherche jamais sélectionné.
    - Retour haptique : non (il reste sur `router.selectedTab` dans `RootView`).
  - Critères : métriques et couleurs = annexe A.1 ; zone tactile ≥ 44 pt sur chaque bouton ; le
    bouton sélectionné et lui seul porte `.isSelected` ; `onSelect` reçoit l'id touché, `onSearch`
    est appelé par le bouton rond.
  - Tests : `Track1TabBarTests` (métriques, style = jetons, stops du fondu, sélection, callbacks via
    un `Item` factice).

- [ ] TRA-671 **3.4 — App · Monter `Track1TabBar`, masquer la barre native, 8 pt sous la barre de
  streaming, bascule des aides UI** — tier/2, 3 pts, dépend de 3.1, 3.3.
  - Portée : `ios/Track1/App/RootView.swift` (`tabs` : une seule `TabView(selection: tabSelection)`
    avec `entry(for: .today).tag(.today)` et `entry(for: .genres).tag(.genres)`, chacune sous
    `.toolbar(.hidden, for: .tabBar)` ; plus de `Tab(role: .search)`, plus de branche `#available(iOS
    26, *)`, plus de `.toolbarBackground(…, for: .tabBar)` ; `.safeAreaInset(edge: .bottom, spacing: 0) {
    Track1TabBar(items: [today, genres], selected: router.selectedTab.rawValue, search: …, onSelect:
    { router.select(AppTab(rawValue: $0)!) }, onSearch: { router.select(.search) }) }` et
    `.ignoresSafeArea(.keyboard, edges: .bottom)` sur la barre), `ios/Track1/App/AppRouter.swift`
    (`AppTab.glyph` → `.tabToday / .tabGenres / .tabSearch` ; `var accessibilityIdentifier: String` →
    `tab-today`, `tab-genres`, `tab-search`), `ios/Track1/Features/Node/NodePageView.swift` (le `VStack`
    de l'inset bas reçoit `.padding(.bottom, Track1Tokens.spacing8)`),
    `ios/Track1/DesignSystem/Components/Node/StreamingButton.swift` (`StreamingBar.bottomGap =
    spacing8` exposé pour le test), `ios/Track1UITests/UITestFlows.swift` (`tabBar(in:)` →
    `app.otherElements["tab-bar"]`, `tabButton(_:in:)` → `app.buttons[identifiant]` par table
    titre → identifiant), `ios/Track1Tests/DesignSystem/StreamingBarTests.swift`,
    `ios/Track1Tests/Node/AppRouterNodeTests.swift` si `AppTab` y est testé. Hors scope : `SearchSheetView`,
    `AmbientGlow`, `Track1App.swift` (le `.tint` racine reste).
  - Contrat : `AppTab.accessibilityIdentifier`, `StreamingBar.bottomGap: CGFloat = 8`.
  - Critères : `RootView.swift` ne contient plus `#available(iOS 26`, `role: .search`, `tabItem` ni
    `toolbarBackground` ; `NavigationTests.testThreeTabsKeepTheirIndependentNavigationStacks`,
    `testTabsRemainAccessibleInDarkModeAndLargeText` (hauteur ≥ 44 et `isSelected`), `ConsentTests`,
    `ProfileFlowTests` (présence / absence de la barre) et `SearchFlowTests` (la sheet s'ouvre depuis le
    bouton rond) sont verts ; `StreamingBar.bottomGap == 8` et, avec `Track1TabBarMetrics.topPadding
    == 12`, l'écart boutons → pilule vaut 20 pt (test arithmétique sur les deux constantes).
  - Tests : suite UI via les aides ; `StreamingBarTests` ; `Track1IconTests` déjà couvert.
  - Notes : la barre native masquée par `.toolbar(.hidden, for: .tabBar)` doit l'être pour la racine
    **et** les pages poussées (`navigationDestination`) : poser le modificateur sur le `NavigationStack`
    renvoyé par `entry(for:)`, pas sur sa racine ; vérifier qu'aucune barre native ne réapparaît en
    poussant une fiche depuis Aujourd'hui (test UI `NavigationTests` existant qui pousse puis revient).
    Le job `ios-check` tourne sur iOS 26.4 seulement : la vérification iOS 17/18 reste manuelle (risque
    R1). Sans `.ignoresSafeArea(.keyboard)`, le champ de l'onglet Genres remonterait la barre avec le
    clavier.

### Partie 4 — Ligne « parce que tu explores … » sous la date

Retenue par Raphael le 2026-10-24 (Q5 : source = genres du profil). Milestone Linear « 4 — Ligne « parce que
tu explores … » », parent TRA-676 (laissé ouvert). Incrément visible : sous la date de l'onglet Aujourd'hui,
« parce que tu explores IDM - Glitch - Ambient » avec les trois premiers genres cochés dans l'onboarding ; rien
de plus quand le profil n'a pas de sélection éditoriale ou que la taxonomie est dégradée.

Ce que la cartographie du 2026-10-24 a établi (worktree sur `e651dc75`) :

- Profil v2 : `Profile.selection: GenreSelection?` (`ios/Track1Core/Sources/Track1Core/Profile/Profile.swift`),
  `GenreSelection.genres: [String]` = ids de taxonomie **dans l'ordre de coche**, uniques
  (`GenreSelectionModel.swift:12-14` ; une famille cochée sans genre ajoute tous ses genres en fin, dans
  l'ordre servi). `genre_ids` sont des slugs triés alphabétiquement : pas la source. `selection == nil` pour un
  profil v1 non réédité.
- Noms : `EditorialGenreTaxonomy(catalog:)` (failable : `nil` si `CatalogTaxonomy.degraded`) puis
  `genre(_ id:)?.name` (`ios/Track1Core/Sources/Track1Core/Features/Onboarding/EditorialGenreTaxonomy.swift:48,
  87`). Rien n'est embarqué dans le bundle ; l'onboarding et l'onglet Genres gardent la taxonomie dans un
  `@State` local, sans cache partagé : « le catalogue déjà lu pour l'onboarding » du plan initial n'existait pas.
- Aujourd'hui : `TodayViewModel.load(for:)` ne lit le catalogue que sans recommandation persistée pour la date
  et la révision (`ios/Track1Core/Sources/Track1Core/Features/Today/TodayViewModel.swift:64-77`, TRA-343) ;
  d'où D8.
- Top bar : `TopBar.Content.date(Date)` (`ios/Track1/DesignSystem/Components/Navigation/TopBar.swift:9-12`),
  texte `top-bar-date` en `.monoHeadline` `colorTextSecondary` (TRA-660) ; seul motif `case .date(` :
  `TopBar.swift:34` ; seul appel : `ios/Track1/Features/Today/TodayView.swift:96`. Pas de
  `.accessibilityElement(children: .contain)` en mode date (seulement sur le fil d'Ariane). `NodeView` fige
  `topBar` (`@State`, `NodeView.swift:21-23`) : la raison doit être connue avant la page, ce que
  `TodayPresentation.screen` garantit (`.page` seulement avec `.recommendation`) et que `.id(opening.recommendationID)`
  renouvelle à chaque recommandation.
- Rôles (`ios/Track1/DesignSystem/Track1Typography.swift:32-52`) : aucun Mono Bold 12 ; `.monoLabel` = Mono
  Regular 12 / 16 `.caption`. `colorTextTertiary = rgb(0x8D7A6D)` (`Track1Tokens.swift:35`).
- Tests : `NavigationComponentsTests.testTopBarDateIsDrawnInMonoHeadline`
  (`ios/Track1Tests/DesignSystem/NavigationComponentsTests.swift:114`) ; `TodayFlowTests` lit `top-bar-date` par
  `descendants(matching: .any)` (`ios/Track1UITests/TodayFlowTests.swift:15-43`) et relance l'app à l'étape 7
  (chemin en cache) ; fixture UI : famille `family-0`, genre `local:genre-0a` nommé « Genre 0a »
  (`UITestFlows.swift:29, 152-158`). Tests Core (`ios/Track1Core/Tests/Track1CoreTests/`) :
  `Recommendation/TodayViewModelTests.swift` (catalogue `degraded`, profil par JSON, `CatalogProbe` compte les
  lectures), `Recommendation/DailyRecommendationStoreTests.swift` (`rawEntry(…)`, « même jeu de clés »),
  `Recommendation/TodayPresentationTests.swift`, `Profile/OnboardingCopyTests.swift` (modèle de test de copie) ;
  `EditorialFixture.catalog(nodes:edges:teasers:families:genres:legacy:)` dans
  `Profile/EditorialGenreTaxonomyTests.swift:224`.
- pbxproj : dernier identifiant utilisé dans `0420–042F` : `0426` ; la partie 4 n'ajoute aucun fichier d'app
  (`0427–042F` restent disponibles si un fichier de test l'exigeait).

- [ ] TRA-698 **4.1 — Core · `TodayReason`, `TodayReasonCopy`, `DailyRecommendation.profileGenreNames`,
  `TodayPresentation.reasonLine`** — tier/2, 2 pts, ∥ (indépendante ; sa PR embarque cette mise à jour du plan).
  - Portée : créer `ios/Track1Core/Sources/Track1Core/Features/Today/TodayReason.swift` et
    `ios/Track1Core/Tests/Track1CoreTests/Recommendation/TodayReasonTests.swift` ; modifier
    `ios/Track1Core/Sources/Track1Core/Recommendation/DailyRecommendation.swift` (champ, clé
    `profile_genre_names`, `init(from:)` explicite avec `decodeIfPresent ?? []`, `encode(to:)` écrit toujours la
    clé), `Features/Today/TodayViewModel.swift` (après le `readCatalog()` réussi, lignes 74-105 : taxonomie,
    noms, passage à `DailyRecommendation`), `Features/Today/TodayPresentation.swift` (`reasonLine(of:)`), tests
    `DailyRecommendationStoreTests`, `TodayViewModelTests`, `TodayPresentationTests`. Pas de pbxproj. Hors
    scope : `ios/Track1/**`, `Affinity.swift`, `reasons`, `Profile*`, `GenreSelection`,
    `EditorialGenreTaxonomy`, `DailyRecommendationStore.swift`.
  - Contrat :
    - `public enum TodayReason { public static let maxGenres = 3; public static func genreNames(selection:
      GenreSelection?, taxonomy: EditorialGenreTaxonomy?) -> [String] }` — ordre de coche,
      `taxonomy.genre(id)?.name`, ids inconnus et noms vides ignorés, tronqué à 3, `[]` si l'un des deux est `nil`.
    - `public enum TodayReasonCopy { public static let separator = " - "; public static func line(genreNames:
      [String]) -> String? }` — « parce que tu explores A - B - C », `nil` si vide, pas de troncature.
    - `DailyRecommendation.profileGenreNames: [String]` (clé `profile_genre_names`) ; `init(…, reasons:,
      profileGenreNames: [String] = [], viewRecorded:)` ; `init(from:)` : clé absente → `[]`.
    - `TodayPresentation.reasonLine(of state: TodayState) -> String?`.
  - Critères : sélection `[Q2, Q1, Q3, Q4]` nommés IDM / Ambient / Glitch / Dub → `["IDM", "Ambient",
    "Glitch"]` ; id inconnu ignoré sans décaler ; `nil` × 2 → `[]` ; copie 3 noms / 1 nom / 0 ; la clé est
    toujours écrite, une entrée brute sans la clé décode en `[]`, aller-retour save/history ; `load(for:)` avec
    `EditorialFixture.catalog` et un profil à `selection` → noms stockés ; taxonomie `degraded` → `[]` ; chemin
    en cache → noms persistés sans lecture du catalogue ; `reasonLine` sur les 4 états ;
    `swift test --package-path ios/Track1Core` et `npm run check` verts.
  - Tests : `TodayReasonTests`, extensions de `DailyRecommendationStoreTests`, `TodayViewModelTests`,
    `TodayPresentationTests`.
  - Notes : l'`init(from:)` explicite est indispensable (`StoredHistory.Entry` décode entrée par entrée avec
    `try?`, `DailyRecommendationStore.swift:131-132` : un champ sans défaut viderait l'historique, R8).
    `Profile.init` est interne : profil de test par JSON avec `"selection"`.

- [ ] TRA-699 **4.2 — App · `TopBar.Content.date(Date, reason:)`, branchement Aujourd'hui, test UI** — tier/2,
  2 pts, dépend de 4.1.
  - Portée : `ios/Track1/DesignSystem/Components/Navigation/TopBar.swift` (`case date(Date, reason: String? =
    nil)` ; `static let reasonRole: Track1TextRole = .monoLabel`, `reasonColor = Track1Tokens.colorTextTertiary`,
    `reasonSpacing = Track1Tokens.spacing4` ; en mode date, `VStack(spacing: reasonSpacing)` { date inchangée,
    identifiant `top-bar-date` ; si raison : `Track1Text(…, role: reasonRole, verbatim: true)`, `reasonColor`,
    centrée, `lineLimit(2)`, identifiant `top-bar-reason` } ; le `.frame(maxWidth: .infinity, minHeight:
    sizeControlMedium)` passe au `VStack` ; sans raison, rendu identique à aujourd'hui),
    `ios/Track1/Features/Today/TodayView.swift:96` (`.date(.now, reason: TodayPresentation.reasonLine(of:
    model.state))`), `ios/Track1Tests/DesignSystem/NavigationComponentsTests.swift`,
    `ios/Track1UITests/TodayFlowTests.swift`. Hors scope : `NodeView`, `NodePageView`, `RootView` (passent
    `topBar` tel quel), `TopBarFormat`, `TopBarClearance`, `Track1Typography.swift`, `Track1Tokens.swift`, Core,
    pbxproj.
  - Contrat : ci-dessus ; identifiants `top-bar-date` (inchangé, sur le texte de la date) et `top-bar-reason`
    (sur le texte de la raison) ; aucun identifiant sur le conteneur (sinon `.accessibilityElement(children:
    .contain)` d'abord).
  - Critères : `reasonRole == .monoLabel` (`.jetBrainsMonoRegular`, 12, 16, `.caption`), `reasonColor ==
    colorTextTertiary`, `reasonSpacing == 4` ; `.date(.now)` compile sans argument ; UI : à l'étape 3 de
    `testTodayShowsTheNodeOfTheDayAndKeepsItThroughNavigationAndRelaunch`, `top-bar-reason` existe et son
    `label` vaut « parce que tu explores Genre 0a » ; à l'étape 7 (relance), il existe encore ; `top-bar-date`,
    `SearchFlowTests`, `NavigationTests` inchangés et verts ; `test/ios-design-tokens.test.ts` vert.
  - Tests : `NavigationComponentsTests` (constantes seulement, pas d'arbre d'accessibilité) ; `TodayFlowTests`
    (présence et texte, persistance après relance).
  - Notes : la raison ne vit que sur la racine d'Aujourd'hui (les pages poussées sont en `.breadcrumb`,
    `RootView.swift:240`) ; `lineLimit(2)` plutôt que le `nowrap` du Figma : des noms longs passent à la ligne
    au lieu d'être coupés, le top bar défile avec la page.

## Vue d'ensemble

| # | Tâche | Tier | Pts | Dépend de |
| --- | --- | --- | --- | --- |
| 1.1 | TRA-657 · DS · jetons `colorBorderChip`, `radius6`, style d'`EdgeChip` | tier/1 | 1 | — ∥ |
| 1.2 | TRA-658 · DS · `NodeContentCard`, `NodeTypeBadge` | tier/1 | 2 | — ∥ |
| 1.3 | TRA-659 · App · `NodePageView` dans la carte, teaser en texte | tier/2 | 3 | 1.1, 1.2 |
| 1.4 | TRA-660 · DS · date du top bar en Mono Bold 18 (Q4 : oui) | tier/1 | 1 | — ∥ |
| 2.1 | TRA-661 · Core · `CoverTint`, `CoverTintTone` | tier/1 | 2 | — ∥ |
| 2.2 | TRA-662 · App · `DominantColor.bands`, état du héros | tier/2 | 2 | 2.1 |
| 2.3 | TRA-663 · DS · halo du boîtier et du disque | tier/1 | 1 | — ∥ (branché par 2.4) |
| 2.4 | TRA-665 · App · fonds en dégradé, fin d'`AmbientGlow` sur la fiche | tier/2 | 3 | 1.3, 2.2, 2.3 |
| 3.1 | TRA-667 · Tests UI · aides `tabBar` / `tabButton` | tier/1 | 1 | — ∥ |
| 3.2 | TRA-669 · DS · assets d'icônes, glyphes sur asset | tier/1 | 2 | — ∥ |
| 3.3 | TRA-670 · DS · `Track1TabBar` | tier/1 | 3 | 3.2 |
| 3.4 | TRA-671 · App · monter la barre, masquer la native, 8 pt, bascule UI | tier/2 | 3 | 3.1, 3.3 |
| 4.1 | TRA-698 · Core · `TodayReason`, `profileGenreNames`, `reasonLine` | tier/2 | 2 | — ∥ |
| 4.2 | TRA-699 · App · seconde ligne du top bar, test UI | tier/2 | 2 | 4.1 |

Vague 1 (parallèle) : 1.1, 1.2, 1.4, 2.1, 2.3, 3.1, 3.2. Vague 2 : 1.3, 2.2, 3.3. Vague 3 : 2.4, 3.4.
Partie 4 (ajoutée le 2026-10-24, parties 1 à 3 mergées) : 4.1 puis 4.2.
Les parties 1, 2, 3 et 4 sont indépendantes entre elles sauf 2.4 ← 1.3 (la carte porte le dégradé).
Aucun chemin sensible (`sensitivePath`) n'est touché : aucun tier/3.

## Risques

- **R1 — Barre native qui réapparaît sur une page poussée (iOS 17/18).** La CI ne compile et ne teste
  que sur iOS 26.4. Garde-fou : modificateur sur le `NavigationStack` (note de 3.4), test UI qui pousse
  une fiche, et vérification par Raphael sur iPhone ; si un runtime 17 révèle le problème, le repli est
  `UITabBar.appearance().isHidden` documenté dans la PR, pas une régression silencieuse.
- **R2 — Tests UI cassés par la disparition de `tabBars`.** Garde-fou : D7, 3.1 mergée avant 3.4 ; les
  identifiants `tab-bar` / `tab-<onglet>` sont le nouveau contrat.
- **R3 — Couleurs brutes hors design system.** `test/ios-design-tokens.test.ts` échoue si `Color(red:…)`
  apparaît dans `Features/` ou `App/`. Garde-fou : conversions dans `CoverTintGradient.swift` (2.4).
- **R4 — Rendu de la palette sur de vraies pochettes.** Les constantes de D2 sont calées sur les
  références Cosmogramma ; une pochette très claire ou très saturée pourrait donner un haut de page
  trop vif. Garde-fou : plafond de saturation 0,35 et luminosités fixes ; Raphael juge sur 5 fiches
  (project avec pochette, track, artist avec photo, genre, label) avant de clore le projet.
- **R5 — Clavier et barre dessinée.** Un `safeAreaInset` suit le clavier. Garde-fou :
  `.ignoresSafeArea(.keyboard)` (3.4) et le test UI de l'onglet Genres.
- **R6 — Coût Core Image.** Quatre `CIAreaAverage` par image de héros au lieu d'une. Sur un échantillon
  32 × 32, négligeable ; garde-fou : une seule réduction d'image (2.2).
- **R7 — Perte du comportement natif iOS 26** (barre qui se réduit au défilement, bouton de recherche
  natif). Accepté par D1 ; à confirmer en Q6.
- **R8 — Historique des recommandations vidé par le nouveau champ.** `StoredHistory.Entry` décode chaque
  entrée par `try? DailyRecommendation(from:)` (`DailyRecommendationStore.swift:131-132`) : un champ sans
  valeur par défaut ferait ignorer toutes les entrées existantes, donc re-choisir l'œuvre du jour (contraire
  à TRA-343). Garde-fou : `init(from:)` explicite avec `decodeIfPresent ?? []` (4.1) et un test d'entrée
  brute sans la clé `profile_genre_names`.

## Critères de sortie

- Les tâches des parties 1, 2, 3 et 4 sont mergées sur `main` ; `npm run check` et
  `ios-check` verts ; aucun identifiant d'accessibilité existant renommé.
- Sur l'iPhone de Raphael, la fiche Cosmogramma (ou toute fiche de projet avec pochette) montre : le
  badge de type, la carte arrondie au dégradé de pochette, le fond de page teinté, le halo sous le
  boîtier et le disque, les chips sans fond à bordure fine et rayon 6, le teaser en texte ; la barre
  d'onglets est la pilule + le cercle, sans texte, icônes du Figma, 20 pt entre les boutons de
  streaming et la pilule ; VoiceOver annonce « Aujourd'hui, sélectionné » et « Genres » sur les deux
  onglets et « Recherche » sur le bouton rond.
- Une fiche genre et une fiche label (sans image) montrent la carte et le fond aux couleurs de leur
  type, sans glow radial.
- Sur l'iPhone de Raphael, l'onglet Aujourd'hui montre sous la date « parce que tu explores A - B - C » avec
  les trois premiers genres cochés dans l'onboarding, à la première ouverture du jour comme après une
  relance ; un profil sans sélection éditoriale n'affiche que la date.
- `docs/plans/track1-ios-figma.md` reçoit, dans la PR de 3.4, une note sous D8 et D10 renvoyant à ce
  plan.

## Arbitrages du gate (2026-10-23, dispatcher sur délégation de Raphael)

- **Q1 — Badge de type.** *Arbitrage : badge = type du nœud (D6).* Le Figma écrit « ARTIST » (`#5D7FA8`) sur une fiche de projet. Proposition
  D6 : le badge affiche le type du nœud (« PROJECT » en `colorNodeProject` sur Cosmogramma). Oui, ou
  autre sens ?
- **Q2 — Dégradé parent.** *Arbitrage : dégradé parent fixé au viewport (D4).* Fixé au viewport (D4, proposé) ou proportionnel à la hauteur du contenu
  comme dans le cadre Figma ?
- **Q3 — Sans image.** *Arbitrage : repli sur la couleur du type (D3).* Repli sur la couleur du type passée par l'échelle (D3, proposé), ou fond plat
  pour genre / label / artiste sans photo ?
- **Q4 — Date du top bar.** *Arbitrage : oui, tâche 1.4 créée (TRA-660).* Le Figma la dessine en JetBrains Mono Bold 18/24 (la prod : Roboto
  Condensed Medium 16, rôle `.eyebrow`). Appliquer (tâche 1.4) ? Proposé : oui, c'est un écart listé.
- **Q5 — Ligne « parce que tu explores IDM - Glitch - Ambient ».** *Arbitrage : reportée le 2026-10-23 ; **retenue par Raphael le 2026-10-24, source = genres du profil
  (`selection.genres`)** — partie 4 créée (milestone 4, TRA-698, TRA-699, parent TRA-676), décision D8.* Aucune donnée ne la porte aujourd'hui
  (`DailyRecommendation.reasons` contient « Lié à X » / « Proche de Y », pas des genres). Créer la
  partie 4 maintenant (source proposée : les noms des genres du profil), la reporter, ou l'écarter ?
  Proposé : reporter, hors « UI refresh ».
- **Q6 — Barre dessinée.** *Arbitrage : barre dessinée confirmée (D1).* D1 renverse D8 et renonce au Liquid Glass natif et à sa réduction au
  défilement. Confirmer ?
- **Q7 — Halo sur les photos d'artiste.** *Arbitrage : pas de halo sur les photos d'artiste (D5).* Aucun (D5, proposé) ou le même halo que le boîtier ?
- **Q8 — Bas de la barre sans indicateur d'accueil.** *Arbitrage : 12 pt sans indicateur d'accueil, 0 avec.* 12 pt (proposé) : le Figma dessine 21 pt de safe
  area, moins que les 34 pt réels d'un iPhone Face ID.

## Annexe A — Valeurs lues dans le Figma (2026-10-23)

### A.1 Barre d'onglets `282:889` (composant `173:108`)

| Élément | Valeur Figma | Jeton / métrique cible |
| --- | --- | --- |
| Cadre | 393 × 95, padding 12 haut, 21 bas, 25 horizontal, `justify-between` | `topPadding 12`, `horizontalInset 25` |
| Fond | dégradé haut → bas `rgba(18,12,10,0)` → `#120C0A` | `colorBackgroundBase` 0 → 1 |
| Pilule « Tabs » | fond `glass.surface` `rgba(9,10,14,0.68)`, bordure 1 pt `glass.border` `rgba(255,255,255,0.26)`, rayon full, padding 4 | `colorGlassSurface`, `colorGlassBorder`, `radiusFull`, `spacing4` |
| Onglet | 96 × 54, rayon full ; sélectionné : fond `glass.selected` `rgba(255,255,255,0.26)` | `tabWidth`, `tabHeight`, `colorGlassSelected` |
| Recherche | cercle 62, même fond et bordure que la pilule | `searchDiameter` |
| Icônes | 20 × 20 ; Today `#F0642D` (actif), Genres `#C8B6A3` (inactif), Search `#F6E9D8` | `colorIconAction`, `colorIconSecondary`, `colorIconPrimary` |
| Streaming → barre | barre de streaming y = 1880.23, h = 44 ; barre d'onglets y = 1932.23 → 8 pt, + 12 pt de padding = 20 pt jusqu'à la pilule | `StreamingBar.bottomGap 8` + `topPadding 12` |

### A.2 Teinte de pochette (`293:832`, `286:1674`, `286:1685`, `282:837`, `285:1034`)

- Parent `282:837` : `linear-gradient(180deg, #4A5552 0%, #44423A 13%, #322A22 27%, background/base
  #120C0A 50%)`, padding 32 haut, 24 horizontal, gap 24.
- Carte `285:1034` : mêmes stops, point final `background/elevated #1A110E` à 50 % ; x = 16, largeur
  361, rayon 16, padding 8 haut, 24 bas, 12 horizontal, gap 18, sans bordure.
- Halo : `drop-shadow(0 0 5px #6A877E)` sur « Partially exposed compact disc » `286:1674` et sur
  « Transparent jewel case » `286:1685` ; l'ombre de la coque `0 8.278 20.696 -6.899 rgba(0,0,0,0.18)`
  reste.
- Lecture HSB des références (luminosité = max(r,g,b)) : `#4A5552` = (164°, 0.13, 0.33) ; `#44423A` =
  (48°, 0.15, 0.27) ; `#322A22` = (30°, 0.32, 0.20) ; `#6A877E` = (164°, 0.21, 0.53). D'où l'échelle
  0,33 / 0,27 / 0,20, le plafond de saturation 0,35, et le halo (0,53 ; × 1,65).

### A.3 Écarts relevés entre le Figma rafraîchi et la prod

| Élément | Figma rafraîchi | Prod (`9a9471de`) | Sort |
| --- | --- | --- | --- |
| Chip `286:1662` / `282:856` | sans fond, bordure `rgba(125,100,89,0.2)`, rayon 6, padding 8, gap 4, tag Mono/Tag `colorNode`, nom Body/Small primary | fond elevated, bordure default, rayon 0, même padding / gap / rôles | 1.1 |
| Carte de contenu `285:1034` | voir A.2 | aucune carte ; padding 24 par élément | 1.2, 1.3, 2.4 |
| Badge `286:1668` | carré 11.37 × 12 `#5D7FA8` + « ARTIST » Mono Bold 14/25 `#5D7FA8` | aucun | 1.2, 1.3, Q1 |
| Teaser `285:1038` | texte Body/Medium primary, sans fond | `TeaserCard` fond elevated, padding 16 | 1.3 |
| Héros `286:1672` | 276 × 183.227, halo teinté | mêmes cotes, pas de halo | 2.3 |
| Fond de page | dégradé A.2 | base + `AmbientGlow` | 2.4 |
| Top bar date `282:838` | JetBrains Mono Bold 18/24 secondary | `.eyebrow` Roboto Condensed Medium 16/20 secondary | Q4, 1.4 |
| Top bar ligne 2 `286:1669` | « parce que tu explores IDM - Glitch - Ambient » Mono Bold 12/25 tertiary | aucune | Q5, partie 4 |
| Section header `282:846` | Mono/Section primary + compte Mono/Tag tertiary, gap 8, baseline | identique | — |
| Track row `282:867` | n° Mono/Tag tertiary 24 pt, titre Body/Medium primary, gap 12, padding 10 vertical, bordure basse default | identique | — |
| Release card `282:885` | 120, pochette rayon 8 bordure default, titre SemiBold 13/16 primary, gap 8 | identique (`.labelSmall`) | — |
| Streaming bar / button `282:888` | surface default, 44 pt, padding 12 / 16 / 8, gap 6, Mono/Micro primary, logo 16 | identique | — |
| Barre d'onglets `282:889` | A.1 | native | 3.x |

## Annexe B — SVG des icônes d'onglet (`I282:889;173:60`, `173:65`, `173:71`)

Les trois fichiers sont livrés tels quels dans les imagesets de 3.2 (rendu `template` : la couleur de
trait est ignorée).

`Tab/Today.imageset/Today.svg` :

```svg
<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M2.5 8.75L10 2.5L17.5 8.75" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" stroke="#F0642D"/>
<path d="M4.16667 7.91667V16.6667C4.16667 16.8877 4.25446 17.0996 4.41074 17.2559C4.56702 17.4122 4.77899 17.5 5 17.5H8.33333V12.5H11.6667V17.5H15C15.221 17.5 15.433 17.4122 15.5893 17.2559C15.7455 17.0996 15.8333 16.8877 15.8333 16.6667V7.91667" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" stroke="#F0642D"/>
</svg>
```

`Tab/Genres.imageset/Genres.svg` :

```svg
<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M7.5 15V4.16667L17.5 2.5V13.3333" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" stroke="#C8B6A3"/>
<path d="M7.5 15C7.5 16.3807 6.38071 17.5 5 17.5C3.61929 17.5 2.5 16.3807 2.5 15C2.5 13.6193 3.61929 12.5 5 12.5C6.38071 12.5 7.5 13.6193 7.5 15Z" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" stroke="#C8B6A3"/>
<path d="M17.5 13.3333C17.5 14.714 16.3807 15.8333 15 15.8333C13.6193 15.8333 12.5 14.714 12.5 13.3333C12.5 11.9526 13.6193 10.8333 15 10.8333C16.3807 10.8333 17.5 11.9526 17.5 13.3333Z" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" stroke="#C8B6A3"/>
</svg>
```

`Tab/Search.imageset/Search.svg` :

```svg
<svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M14.1667 8.75C14.1667 11.7415 11.7415 14.1667 8.75 14.1667C5.75846 14.1667 3.33333 11.7415 3.33333 8.75C3.33333 5.75846 5.75846 3.33333 8.75 3.33333C11.7415 3.33333 14.1667 5.75846 14.1667 8.75Z" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" stroke="#F6E9D8"/>
<path d="M16.6667 16.6667L12.6667 12.6667" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" stroke="#F6E9D8"/>
</svg>
```
