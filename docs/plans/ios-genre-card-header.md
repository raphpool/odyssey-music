# Sélection des genres iOS : badge « (N) » et en-tête de carte insécable

Plan de la phase `plan` du process de livraison, écrit le 2026-10-23 sur le brief de Raphael (app iOS
Track1). **Validé le 2026-10-23** (dispatcher, par délégation de Raphael). Projet Linear : P-TRA-9
(https://linear.app/workspaceperso/project/onboarding-ios-badge-n-2a48c2507e72). Il amende la décision
D6 du plan [`ios-onboarding-accordion.md`](ios-onboarding-accordion.md) (TRA-631 → TRA-641, livré le
2026-10-20) : la forme dessinée du compteur de carte change, sa forme parlée reste. Tout le reste de ce
plan reste en vigueur, en particulier D3/Q4 (l'édition depuis l'onglet Genres passe par le même écran).

Source de vérité design : Figma `phudxrQNlzQJafXLma4FyX`, section `257:447`, écran
`1.2 Genres et sous-genres` `243:1585`, cartes `243:1609` (dépliée, « Hip-hop (1) »), `243:1675` (repliée
avec sélection, « Jazz (4) »), `243:1622` (repliée sans sélection), carte de spec `257:416`. Lu le
2026-10-23 via le MCP Figma (`get_metadata` + `get_screenshot` sur `257:447`). Figma n'est pas modifié par
ce plan (page « Screens — iOS » intouchable).

Tous les chemins sont relatifs à la racine du dépôt ; les numéros de ligne sont ceux de la branche
`claude/onboarding-genre-selection-layout-7be5b1` au 2026-10-23 (`9a9471de`).

## Problème

1. **Le compteur casse l'en-tête de carte dès qu'un sous-genre est coché.** `GenreAccordionCard.header`
   (`ios/Track1/DesignSystem/Components/Onboarding/GenreAccordionCard.swift:83-89`) dessine le titre de la
   famille (`Track1Text`, rôle `monoItem` 18/22) et, dès `selectedCount >= 1`, la chaîne
   `OnboardingCopy.selectedCount(_:)` = `"(4 sélectionnés)"` (`ios/Track1Core/Sources/Track1Core/Features/Onboarding/OnboardingCopy.swift:38-41`,
   rôle `monoTag` 13/16) dans un `HStack(spacing: 8)` sans `fixedSize`, `lineLimit` ni priorité. Budget de
   largeur de cette ligne : 321 pt d'en-tête (Figma) − 20 pt de chevron − 8 pt = **293 pt** sur un iPhone de
   393 pt, **302 pt** sur l'iPhone 17 Pro de la CI (402 pt). JetBrains Mono avance de 0,6 em (tracking 0 sur
   ces rôles : `Track1Typography.swift:61-67`), soit 10,8 pt/caractère à 18 pt et 7,8 pt à 13 pt.
   « Electronica / Downtempo (3 sélectionnés) » demande 248 + 8 + 125 = 381 pt : le `HStack` comprime les
   deux textes, qui se replient au milieu de leur chaîne, l'en-tête passe sur deux ou trois lignes et la ligne
   « 13 sous-genres » descend. C'est la casse observée par Raphael. Sans le mot, « (3) » demande 23 pt : la
   ligne tient pour toutes les familles réelles (la plus longue, « African / Middle Eastern », 24 caractères,
   fait 259 pt ; avec « (71) » : 298 pt, une ligne sur 402 pt, deux lignes propres sur 393 pt).
2. **Le Figma ne dessine pas le mot.** Les trois cartes de `243:1671` montrent « Hip-hop (1) » et
   « Jazz (4) » : titre `monoItem`, compteur `monoTag` dans la couleur de sélection, 8 pt d'écart, compteur
   centré sur la ligne de 22 pt (`243:1612` : y = 3, h = 16). Seule la carte de spec `257:432` parle encore de
   « (N sélectionné·s) » (voir l'arbitrage Q2).
3. **L'édition depuis l'onglet « Genres » est déjà le même écran.** `GenresTabView` ouvre
   `ProfileEditorSheet` (`ios/Track1/Features/Genres/GenresTabView.swift:71`, `273-296`), qui monte
   `OnboardingFlowView(model:)` ; en mode édition la racine du flux est `GenresStepView`
   (`ios/Track1/Features/Onboarding/OnboardingFlowView.swift:72-81`, `88-94`), avec les mêmes
   `GenreAccordionCard` et `SubgenreChip`. Le bogue et sa correction sont donc partagés par construction ;
   ce qui manque est la **preuve** (aucun test ne compare les deux parcours) et la garantie que l'en-tête
   tient aussi avec un nom long.

## Non-buts

- L'écran racine de l'onglet Genres (`GenresTabView`, grille de `GenreTile` en lecture seule + « Modifier
  mes genres », écran K.1 du plan Figma) ne change pas, ni la présentation en `sheet` de l'édition. Le
  remplacer par l'accordéon serait un changement produit (quand enregistre-t-on ?) : brief séparé si voulu
  (arbitrage Q1).
- Les chips de sous-genres (`SubgenreChip`, `ChipFlowLayout`) ne changent pas. « Nom de genre long » du
  brief désigne le titre d'une carte (Figma : « Genre card · Hip-hop », les chips sont les sous-genres). Un
  chip tient sur une ligne jusqu'à ~37 caractères (321 − 24 de padding − 4 de bordure = 293 pt / 7,8) ; le
  plus long nom réel de `data/genre-taxonomy.json` fait 31 caractères (arbitrage Q3, garde-fou dans les
  risques).
- `SectionHeader` (fiches de nœud), `GenreTile`, le compteur « Total : N genres » de la barre, Welcome,
  Today : inchangés.
- Aucune localisation, aucune chaîne anglaise : l'app n'a ni `.xcstrings` ni `String(localized:)` ; tout est
  en français en dur (`project.pbxproj:256` déclare `en`, les tests UI forcent `-AppleLanguages (fr)`).
- Aucune édition Figma, aucun nouveau fichier de test (le `project.pbxproj` liste les fichiers
  explicitement, 4 références par fichier ; les tests vont dans les fichiers existants).

## Décisions d'archi

### D1 — Badge dessiné « (N) », forme parlée « N sélectionné(s) » séparée, toutes deux dans `OnboardingCopy`

`OnboardingCopy.selectedCount(_:)` rend désormais `"(4)"` (parenthèses dans la chaîne, négatif lu 0, comme
aujourd'hui) et une nouvelle fonction `OnboardingCopy.spokenSelectedCount(_:)` rend `"4 sélectionnés"` /
`"1 sélectionné"` / `"0 sélectionné"` (règle française de `counter` : 0 et 1 au singulier).
`GenreAccordionCard.accessibilityLabel` (`GenreAccordionCard.swift:20-28`) cesse de dériver la forme parlée
en rognant les parenthèses et prend `spokenSelectedCount` : le label VoiceOver « Jazz, 13 sous-genres,
4 sélectionnés » ne bouge pas, donc les tests UI de TRA-640 qui lisent `", 2 sélectionnés"` sur le label de
la carte (`ios/Track1UITests/ProfileFlowTests.swift:129, 145, 185, 288`) restent valides.

*Alternative rejetée :* garder le mot et le faire tenir avec `minimumScaleFactor` ou `lineLimit(1)` sur le
compteur. Le Figma ne dessine pas le mot, et une échelle variable donne des compteurs de tailles
différentes d'une carte à l'autre.

### D2 — Deux `Track1Text` sur une ligne alignée `.firstTextBaseline` ; le badge est insécable, le titre se replie librement

La ligne de titre devient `HStack(alignment: .firstTextBaseline, spacing: Track1Tokens.spacing8)` avec le
titre (`monoItem`, `verbatim`) et le badge (`monoTag`, `verbatim`, `.fixedSize(horizontal: true, vertical:
false)`). Le badge prend toujours sa largeur idéale (≤ 4 caractères), le titre reçoit le reste et se replie
sur autant de lignes que nécessaire — pas de `lineLimit`, pas de `minimumScaleFactor` : à
`AccessibilityXXXL` (où `NavigationTests.testTabsRemainAccessibleInDarkModeAndLargeText` passe déjà
l'écran) tronquer cacherait le nom. Le chevron (20 pt fixes) et le `Spacer(minLength: 0)` du `HStack`
externe restent tels quels : le titre étant compressible, rien ne peut pousser le chevron.

C'est exactement le motif de `SectionHeader` (`ios/Track1/DesignSystem/Components/Node/SectionHeader.swift:34-40`),
l'autre ligne « titre + compte » du design system.

*Alternatives rejetées :* (a) un seul `Text` concaténé à deux polices — demande une nouvelle API de
`Track1Text` et déporte la typographie dans la carte ; (b) `lineLimit(1)` + troncature du titre — perd le
nom ; (c) `.center` comme aujourd'hui — exact au Figma sur une ligne, mais un titre replié sur deux lignes
place le badge entre les deux (vérifié, voir D3).

### D3 — Aucun changement du design system : `.firstTextBaseline` traverse déjà `Track1LineHeightLayout`

`Track1Text` enveloppe son `Text` dans un `Layout` maison qui le centre dans une boîte de N × lineHeight
(`ios/Track1/DesignSystem/Components/Core/Track1Text.swift:51-69`) sans implémenter `explicitAlignment`.
Apple documente que l'implémentation par défaut « fusionne les guides des sous-vues ». Vérifié le
2026-10-23 par une sonde SwiftUI macOS (Menlo 18 dans une boîte de 22, Menlo 13 dans une boîte de 16,
`HStack(alignment: .firstTextBaseline)`) : le compteur se place à +5 pt du haut du titre aussi bien en
`Text` nus qu'à travers la boîte de ligne (ligne de base réelle, pas le bord bas) ; avec un titre replié sur
deux lignes (44 pt), le compteur reste sur la **première** ligne (+5,5 pt), là où `.center` le met à
cheval entre les deux (+14 pt). Par rapport au Figma (compteur centré, y = 3), l'alignement sur la ligne de
base décale le badge de moins de 1 pt : invisible.

*Alternative rejetée :* implémenter `explicitAlignment` dans `Track1LineHeightLayout`, ou aligner `.top`
avec un padding de 3–4 pt pour imiter la ligne de base. Inutile au vu de la sonde ; le padding serait un
nombre magique qui dérive avec Dynamic Type (`.body` et `.footnote` ne s'échelonnent pas pareil).

### D4 — Parité onboarding / édition par construction, prouvée par un test UI, sans nouvelle abstraction

Rien à unifier dans le code (voir Problème 3). La partie 2 du brief est couverte par un test UI qui mesure
le même en-tête (même famille, même état « repliée, 1 sélectionné ») dans l'onboarding puis dans la
sheet d'édition, et exige les mêmes largeur et hauteur. Tout écart futur entre les deux entrées casse ce test.

*Alternative rejetée :* dupliquer les règles d'en-tête dans `GenresTabView` — il n'y a rien à dupliquer ;
ou changer la présentation (sheet → plein écran) — hors brief.

### D5 — Preuve de layout par mesure de cadres XCUITest, avec une taxonomie de test aux libellés longs

Les textes de l'en-tête ne sont pas des éléments d'accessibilité (l'en-tête est un seul bouton, cf.
commentaire `ProfileFlowTests.swift:100-104`) : on ne peut pas lire « (1) » dans la hiérarchie. On lit donc
le **cadre** du bouton `genre-card-<key>` (qui est l'en-tête : 46 pt repliée = 22 + 8 + 16, 22 pt dépliée)
et on exige :
- qu'un nom qui tient seul sur une ligne garde la même hauteur d'en-tête une fois un sous-genre coché
  (le badge n'ajoute pas de ligne) — c'est le test qui **reproduit le bogue** avant correction ;
- qu'un nom plus long que la ligne se replie (hauteur + 22 pt au moins) sans déborder (même largeur que
  les autres cartes, `maxX` dans l'écran) et garde son badge (label `", 1 sélectionné"`) ;
- que la sheet d'édition donne les mêmes mesures que l'onboarding.
Les libellés sont choisis sur le budget du Problème 1 : « Rock alternatif / Punk » (22 caractères,
238 pt : tient seul ; 269 pt avec « (1) » ; 363 pt avec l'ancien « (1 sélectionné) », donc le test échoue
sur `main`) et « Musiques traditionnelles d'Afrique et d'Orient » (46 caractères ; se replie
« Musiques traditionnelles » / « d'Afrique et d'Orient », 227 + 8 + 23 = 258 pt sur la 2e ligne : le badge
n'ajoute pas de ligne non plus). Les clés et identifiants (`family-0`, `local:genre-0a`…) restent ceux de
`editorialTaxonomy` (`ProfileFlowTests.swift:382-385`) pour réutiliser `UITestFlows.completeOnboarding`.
L'en-tête anime sa hauteur à la fermeture (ressort) : un helper attend un cadre stable avant de mesurer.
Captures jointes au `.xcresult` pour l'œil humain (artefact d'`ios-check`).

*Alternative rejetée :* tests de snapshot — pas d'outillage dans le dépôt, et une dépendance majeure hors
brief ; ne tester que les chaînes Core — ne prouve pas le layout.

## Découpage

Trois tâches en deux parties. Points = estimate Linear. « ∥ » marque les tâches parallélisables.

| # | Tâche | Tier | Pts | Dépend de |
|---|---|---|---|---|
| 1.1 | TRA-664 · Core + DS · Badge « (N) », forme parlée, ligne de titre insécable, test UI qui reproduit le bogue | tier/2 | 2 | — |
| 1.2 | TRA-668 · Doc · Publier ce plan et poser le renvoi D6 dans le plan accordéon | tier/1 | 1 | — ∥ 1.1 |
| 2.1 | TRA-666 · Tests UI · Nom long replié avec badge, parité onboarding / sheet d'édition, captures | tier/1 | 2 | 1.1 (blockedBy TRA-664) |

Total : 5 points. Chaque PR laisse `swift test` et `ios-check` verts.

### Partie 1 — Correction (déployable seule : le bogue disparaît sur les deux parcours)

- [ ] TRA-664 1.1 — `OnboardingCopy.selectedCount` → « (N) », `spokenSelectedCount` ; `GenreAccordionCard` :
  badge insécable, titre repliable, label parlé inchangé ; tests Core et Track1Tests mis à jour ; fixture
  `longLabelsTaxonomy` + un test UI (hauteur d'en-tête inchangée après sélection) qui échoue sur `main`.
- [ ] TRA-668 1.2 — `docs/plans/ios-genre-card-header.md` sur `main`, renvoi de 3 lignes sous D6 de
  `docs/plans/ios-onboarding-accordion.md`. ∥

### Partie 2 — Preuves (déployable seule : tests et captures uniquement)

- [ ] TRA-666 2.1 — Deux tests UI dans `ProfileFlowTests.swift` : nom long replié avec badge (largeur,
  hauteur, label) ; mêmes mesures dans la sheet d'édition de l'onglet Genres. Captures `1.2-long-family` et
  `3.3-edit-long-family`.

## Risques

- **Hauteur mesurée pendant l'animation.** La ligne « N sous-genres » réapparaît à la fermeture sous le
  ressort `Track1Motion.spring` : lire le cadre juste après `waitForNonExistence` du chip peut donner 30 au
  lieu de 46. Parade : helper `UITestFlows.settledFrame(of:)` (deux lectures égales à 100 ms d'écart, 3 s
  max) avant chaque mesure ; tolérance ± 1 pt.
- **Simulateur de CI.** Budget calculé pour l'iPhone 17 Pro (402 pt, `ios/scripts/check.sh:70`) ; les deux
  libellés gardent plus de 20 pt de marge et donnent le même nombre de lignes sur 393 pt. Si le pool change
  de modèle, recalculer avec la table du Problème 1 avant de toucher aux libellés.
- **`ios-check` n'est pas un check requis et ignore les PR en brouillon** (`.github/workflows/ios-ci.yml:8,
  52`). L'implémenteur passe la PR en « ready » et attend `ios-check` vert avant de demander le merge ;
  c'est lui qui exécute les tests UI (30 min par aller-retour, pas de simulateur en local :
  `docs/track1-builds.md:101-106`).
- **Spec Figma divergente.** `257:432` dit encore « (N sélectionné·s) » ; les maquettes disent « (N) ».
  Le code suit les maquettes ; Raphael met la carte de spec à jour lui-même (arbitrage Q2).
- **Dynamic Type AX.** Le titre peut occuper 3–4 lignes ; le badge reste sur la première (D3). Couvert par
  le test existant `NavigationTests:46` à `AccessibilityXXXL`, qui doit rester vert.
- **Chips de sous-genres (arbitrage Q3, repris par TRA-679).** Hors scope ici. Une puce plus large que sa
  rangée se replie sur autant de lignes que nécessaire, dans une pilule qui prend sa vraie hauteur :
  `ChipFlowLayout` la mesure de nouveau à la largeur de la rangée (TRA-679). Il n'y a donc plus de limite
  de 37 caractères à surveiller dans `data/genre-taxonomy.json` ; le plus long nom réel fait 31 caractères
  (« North American Indigenous Music »).
- **Session parallèle sur la fiche de nœud iOS** (`docs/plans/ios-node-page-ui-refresh.md`, même nuit).
  Fichiers partagés : `ProfileFlowTests.swift`, `UITestFlows.swift`, `project.pbxproj`. Règles de
  coordination dans les notes des tickets 1.1 et 2.1 ; update-branch sur `main` juste avant chaque merge.

## Critères de sortie

- Aucune carte de l'écran Genres (onboarding ou édition) ne dessine le mot « sélectionné » ; le badge est
  « (N) » dans la couleur de sélection, à côté du titre, aligné sur sa première ligne.
- VoiceOver lit toujours « <famille>, N sous-genres, M sélectionné(s) » ; `swift test --package-path
  ios/Track1Core` et les tests de `Track1Tests` sont verts.
- Trois tests UI nouveaux verts dans `ios-check` : hauteur d'en-tête inchangée après sélection sur un nom
  qui tient ; nom long replié sans débordement et avec son badge ; mêmes mesures dans la sheet d'édition.
  Les tests UI de TRA-640 restent verts sans modification de leurs assertions.
- Captures `1.2-long-family` et `3.3-edit-long-family` dans le `.xcresult` d'`ios-check`, vérifiées à l'œil
  par Raphael sur son iPhone après la release (parcours : nouveau profil, puis Genres → Modifier mes genres).
- Le plan est sur `main` et le plan accordéon renvoie vers lui sous D6.

## Arbitrages du gate (2026-10-23)

Validation par le dispatcher, par délégation de Raphael (absent cette nuit).

- **Q1 — Lecture du point 2 du brief → recommandation retenue.** Vérifié par le dispatcher :
  `ProfileEditorSheet` (`GenresTabView.swift:273`) monte `OnboardingFlowView`, puis `GenresStepView`. La
  sheet d'édition de l'onglet Genres a donc déjà le même layout que l'onboarding. Aucun changement de
  code ; la parité est prouvée par 2.1 (TRA-666). La grille de tuiles « Mes genres » ne change pas. Si
  Raphael voulait autre chose, ce sera un brief séparé.
- **Q2 — Carte de spec Figma `257:432` → le plan suit les maquettes (« (N) »).** La carte de spec reste à
  mettre à jour par Raphael ; le dispatcher le lui signale au matin. Nous ne touchons pas Figma.
- **Q3 — Chips de sous-genres → hors scope** (max réel 31 caractères, tient jusqu'à ~37). Ajouté aux
  Risques comme garde-fou à surveiller.
- **Q4 — Tiers validés :** 1.1 tier/2 (TRA-664), 1.2 tier/1 (TRA-668), 2.1 tier/1 (TRA-666).

## Tickets (tels que créés dans Linear, format `ticket-template.md`)

### TRA-664 (1.1) — Rendre le compteur de carte comme « (N) » et garantir l'en-tête de carte sur une ligne insécable

- https://linear.app/workspaceperso/issue/TRA-664 · Tier : **tier/2** · Estimate : **2** · Partie 1 ·
  Labels : `tier/2`, `Bug`

```markdown
## Contexte
Sur l'écran Genres (onboarding et sheet d'édition de l'onglet Genres, même vue `GenresStepView`),
cocher un sous-genre fait apparaître « (4 sélectionnés) » à côté du titre de la carte. Le `HStack`
comprime les deux textes, qui se replient au milieu de leur chaîne : l'en-tête casse. Le Figma
(`243:1609`, `243:1675`) dessine « Hip-hop (1) », « Jazz (4) » : le nombre seul, en `monoTag`, dans la
couleur de sélection. Plan : docs/plans/ios-genre-card-header.md#partie-1 (D1, D2, D3, D5).

## Portée
Fichiers à modifier (chemins vérifiés) :
- `ios/Track1Core/Sources/Track1Core/Features/Onboarding/OnboardingCopy.swift` — l.35-41 :
  `selectedCount(_:)` rend « (N) » ; ajouter `spokenSelectedCount(_:)` ; commentaires de doc à jour.
- `ios/Track1Core/Tests/Track1CoreTests/Profile/OnboardingCopyTests.swift` — l.58-73 : adapter les 4 tests
  de `selectedCount`, ajouter ceux de `spokenSelectedCount`.
- `ios/Track1/DesignSystem/Components/Onboarding/GenreAccordionCard.swift` — l.18-28 : label parlé via
  `spokenSelectedCount` (plus de rognage de parenthèses) ; nouveau `static func badge(selectedCount:)` ;
  l.83-89 : ligne de titre `HStack(alignment: .firstTextBaseline, …)`, badge `verbatim` et
  `.fixedSize(horizontal: true, vertical: false)`. Commentaire d'en-tête du fichier (l.4-7) inchangé.
- `ios/Track1Tests/DesignSystem/OnboardingComponentsTests.swift` — après l.196 : tests de `badge`.
  Les trois tests de label parlé l.180-196 doivent rester verts sans modification.
- `ios/Track1UITests/ProfileFlowTests.swift` — l.102 : commentaire « ("(2 sélectionnés)") » → « ("(2)") » ;
  ajouter la fixture `longLabelsTaxonomy` / `longLabelsCatalog` à côté de `editorialTaxonomy` (l.382-392)
  et un test UI (voir Tests attendus).
- `ios/Track1UITests/UITestFlows.swift` — ajouter `settledFrame(of:timeout:)` après `tapWhenReady` (l.124).
Hors-scope explicite :
- `SubgenreChip`, `ChipFlowLayout`, `GenresTabView`, `GenreTile`, `SectionHeader`, `Track1Text` /
  `Track1LineHeightLayout` (l'alignement `.firstTextBaseline` y fonctionne déjà, plan D3 : ne pas y toucher).
- Le compteur de la barre « Total : N genres » (`OnboardingCopy.counter`) et `selectionSummary`.
- Aucun nouveau fichier (le `project.pbxproj` liste les fichiers à la main).
- Les assertions existantes des tests UI de TRA-640 (l.106-197) : elles lisent le label parlé, inchangé.
- Coordination avec la session « fiche de nœud iOS » : ne pas toucher `Track1Tokens.swift` (ni ses
  tests), `EdgeChip.swift`, `Track1Icon.swift`, `AmbientGlow`, `App/RootView.swift`.

## Contrat
Core (`OnboardingCopy`) :
    /// "(4)", "(1)", "(0)" — the accent badge after a family title. The parentheses belong to the
    /// string. A negative count reads as 0.
    public static func selectedCount(_ count: Int) -> String
    /// "4 sélectionnés", "1 sélectionné", "0 sélectionné" — what VoiceOver says for the badge. Same French
    /// rule as `counter`: 0 and 1 are singular. A negative count reads as 0.
    public static func spokenSelectedCount(_ count: Int) -> String
App (`GenreAccordionCard<Content>`) :
    /// nil below 1 (nothing is drawn), else `OnboardingCopy.selectedCount(count)`.
    static func badge(selectedCount: Int) -> String?
    /// Unchanged signature and output: "Jazz, 13 sous-genres, 4 sélectionnés" (now built from
    /// `OnboardingCopy.spokenSelectedCount`, no parentheses trimming).
    static func accessibilityLabel(title: String, subgenreCount: Int, selectedCount: Int) -> String
Ligne de titre de `header` :
    HStack(alignment: .firstTextBaseline, spacing: Track1Tokens.spacing8) {
        Track1Text(title, role: .monoItem, verbatim: true)                       // se replie librement
        if let badge = Self.badge(selectedCount: selectedCount) {
            Track1Text(badge, role: .monoTag, verbatim: true)                     // couleur `accent`
                .fixedSize(horizontal: true, vertical: false)                     // jamais comprimé
        }
    }
Pas de `lineLimit`, pas de `minimumScaleFactor`, pas de `layoutPriority`. Le `HStack` externe (chevron,
`Spacer(minLength: 0)`) et la ligne « N sous-genres » ne changent pas.
Tests UI (`UITestFlows`) :
    /// The frame of `element` once two reads 100 ms apart are equal (the header animates its height
    /// when a card closes); fails the test after `timeout`.
    static func settledFrame(of element: XCUIElement, timeout: TimeInterval = 3) -> CGRect
Fixture `longLabelsTaxonomy` : mêmes clés, ids, slugs et `legacySelectionBySlug` que `editorialTaxonomy`
(l.382-385), seuls les `label` changent : `family-0` → "Rock alternatif / Punk", `family-1` →
"Musiques traditionnelles d'Afrique et d'Orient". `longLabelsCatalog = catalog(taxonomy: longLabelsTaxonomy)`.

## Critères d'acceptation
- [ ] `OnboardingCopy.selectedCount(0/1/2/4/-2)` = "(0)", "(1)", "(2)", "(4)", "(0)".
- [ ] `OnboardingCopy.spokenSelectedCount(0/1/2/4/-2)` = "0 sélectionné", "1 sélectionné",
      "2 sélectionnés", "4 sélectionnés", "0 sélectionné".
- [ ] `GenreAccordionCard.badge(selectedCount:)` = nil pour 0 et -1, "(4)" pour 4.
- [ ] `GenreAccordionCard.accessibilityLabel` rend exactement les trois chaînes des tests existants
      (l.180-196 d'`OnboardingComponentsTests`) sans que ces tests soient modifiés.
- [ ] Test UI : avec `longLabelsCatalog`, sur `genre-card-family-0` (« Rock alternatif / Punk »), la hauteur
      du cadre repliée avant toute sélection est égale (± 1 pt) à sa hauteur repliée après avoir coché
      `subgenre-chip-local:genre-0a`, et son label finit par ", 1 sélectionné". Ce test échoue sur `main`
      (l'ancien « (1 sélectionné) » fait passer l'en-tête sur deux lignes : 363 pt demandés pour 302).
- [ ] `swift test --package-path ios/Track1Core` vert ; `ios-check` vert (Track1Tests + toute la suite UI,
      dont TRA-640 et `NavigationTests` à AccessibilityXXXL, sans modification de leurs assertions).

## Tests attendus
- unitaire Core (`OnboardingCopyTests`) : les 4 tests de `selectedCount` réécrits sur « (N) » ; 4 tests de
  `spokenSelectedCount` (0, 1, 2 et 4, négatif).
- unitaire app (`OnboardingComponentsTests`) : `badge` nil sous 1, "(4)" à 4 ; les 3 tests de label parlé
  inchangés et verts.
- UI (`ProfileFlowTests`, nouveau `testTheBadgeAddsNoLineToAFamilyNameThatFitsOnOne`) : lancer avec
  `longLabelsCatalog`, `declineConsent`, `onboarding-start` ; `before = settledFrame(of: family0).height` ;
  `tapAboveBar(family0)`, `tapAboveBar(chip genre-0a)`, `tapAboveBar(family0)` ;
  `chip.waitForNonExistence(10)` ; `value == "replié"` ; `label.hasSuffix(", 1 sélectionné")` ;
  `settledFrame(of: family0).height == before ± 1`. Capture `1.2-badge` via `UITestFlows.screenshot`.

## Tier de risque
tier/2 — logique locale (chaînes Core) et composant de design system sans état ; couvert par des tests
unitaires et UI existants.

## Notes d'implémentation
- Ne pas implémenter `explicitAlignment` dans `Track1LineHeightLayout` ni aligner `.top` avec un padding :
  la sonde du 2026-10-23 (plan D3) montre que `.firstTextBaseline` traverse déjà la boîte de ligne et
  place le badge sur la première ligne d'un titre replié. `SectionHeader.swift:34` utilise le même motif.
- Le badge passe en `verbatim: true` (ce n'est pas une clé de localisation ; évite le parsing Markdown de
  `LocalizedStringKey`).
- Convention du dépôt : un commentaire qui documente une régression porte la date et le symptôme ; ici
  « 2026-10-23 : « (4 sélectionnés) » faisait replier le titre et le compteur au milieu de leur chaîne ».
- Pas de simulateur en local (`docs/track1-builds.md:101-106`) : `swift test` pour Core, typecheck de
  l'app possible sans xcodebuild (`docs/track1-builds.md:117-131`), le reste passe par `ios-check`. La PR
  doit être « ready » (pas brouillon) pour qu'`ios-check` tourne ; il n'est pas un check requis : attendre
  son vert avant de demander le merge.
- Mesures : l'identifiant `genre-card-<key>` est posé sur le **bouton d'en-tête** (`GenreAccordionCard.swift:108`),
  pas sur la carte ; repliée l'en-tête fait 46 pt (22 + 8 + 16), dépliée 22 pt. Toujours mesurer repliée.
- Les taps passent par `UITestFlows.tapAboveBar` (la barre pinnée prend le toucher de ce qui est dessous).
- Coordination (une autre session livre cette nuit la fiche de nœud iOS,
  `docs/plans/ios-node-page-ui-refresh.md`) :
  - `project.pbxproj` : normalement aucun identifiant à créer (aucun fichier nouveau). Si un identifiant
    devenait nécessaire, utiliser la plage F1…0430–043F ; ne jamais utiliser 0420–042F.
  - `ProfileFlowTests.swift` et `UITestFlows.swift` sont partagés avec cette session. Accéder à la barre
    d'onglets par `app.tabBars…` comme aujourd'hui ; l'autre session migrera ces accès vers ses aides
    `UITestFlows.tabBar(in:)` / `tabButton(_:in:)`. Si ces aides sont déjà sur `main` au moment de
    l'implémentation, les utiliser.
  - Faire un update-branch sur `main` juste avant le merge.
- Commits conventionnels, `Refs TRA-664` ; PR titrée `TRA-664 …`, `Fixes TRA-664`.
```

### TRA-668 (1.2) — Publier le plan « badge (N) » et poser le renvoi sous D6 du plan accordéon

- https://linear.app/workspaceperso/issue/TRA-668 · Tier : **tier/1** · Estimate : **1** · Partie 1
  (∥ 1.1) · Labels : `tier/1`

```markdown
## Contexte
Le plan de ce projet a été validé le 2026-10-23 (dispatcher, par délégation de Raphael) ; il amende la
décision D6 (textes du compteur) du plan accordéon (P-TRA-7). Comme pour TRA-635, le plan vit dans
`docs/plans/` et l'ancien plan renvoie vers lui pour qu'un lecteur de D6 ne parte pas sur
« (4 sélectionnés) ». Plan : docs/plans/ios-genre-card-header.md#partie-1.

## Portée
Fichiers à créer/modifier :
- `docs/plans/ios-genre-card-header.md` — le fichier n'est pas commité. Sa source est
  `/Users/raphaeldoulonne/Developer/odyssey-music/.claude/worktrees/onboarding-genre-selection-layout-7be5b1/docs/plans/ios-genre-card-header.md` :
  le copier tel quel dans le worktree du ticket, puis vérifier que les identifiants de ticket y sont posés (TRA-664,
  TRA-666 et TRA-668 sont déjà posés dans la source ; sinon les appliquer) et que l'en-tête porte
  « Validé le 2026-10-23 » avec le lien du projet Linear
  https://linear.app/workspaceperso/project/onboarding-ios-badge-n-2a48c2507e72.
- `docs/plans/ios-onboarding-accordion.md` — sous « ### D6 — Textes » (l.189-197) : un paragraphe de 3
  lignes « Amendement 2026-10-23 : le compteur dessiné devient « (N) », la forme parlée reste
  « N sélectionné(s) » ; voir [`ios-genre-card-header.md`](ios-genre-card-header.md) D1. » Ne pas réécrire D6.
Hors-scope explicite :
- Tout fichier hors `docs/plans/`. Aucun code.

## Contrat
Aucun. Markdown seulement.

## Critères d'acceptation
- [ ] `docs/plans/ios-genre-card-header.md` est sur `main`, avec ses trois identifiants de ticket, l'en-tête « Validé le 2026-10-23 »,
      avec le lien du projet P-TRA-9.
- [ ] `docs/plans/ios-onboarding-accordion.md` contient, sous D6, un lien vers `ios-genre-card-header.md`.
- [ ] `npm run check` vert (rien de touché hors docs).

## Tests attendus
- aucun : ticket documentaire (précédent TRA-635).

## Tier de risque
tier/1 — documentation.

## Notes d'implémentation
- Français dans les plans ; chemins relatifs à la racine ; ne pas modifier d'autres sections du plan
  accordéon.
- Faire un update-branch sur `main` juste avant le merge (une autre session livre la fiche de nœud iOS
  cette nuit).
- Commits conventionnels, `Refs TRA-668` ; PR titrée `TRA-668 …`, `Fixes TRA-668`.
```

### TRA-666 (2.1) — Prouver par tests UI qu'un nom de famille long se replie avec son badge et que la sheet d'édition dessine le même en-tête

- https://linear.app/workspaceperso/issue/TRA-666 · Tier : **tier/1** · Estimate : **2** · Partie 2
  (blockedBy TRA-664) · Labels : `tier/1`

```markdown
## Contexte
TRA-664 a remplacé « (N sélectionnés) » par « (N) » et rendu le badge insécable. Il reste à prouver les
deux garanties du brief que TRA-664 ne teste pas : un nom de famille plus long que la ligne se replie
proprement en gardant son badge, et la sheet d'édition de l'onglet Genres (même `GenresStepView`, plan
D4) dessine exactement le même en-tête que l'onboarding. Plan : docs/plans/ios-genre-card-header.md#partie-2
(D4, D5).

## Portée
Fichiers à modifier :
- `ios/Track1UITests/ProfileFlowTests.swift` — deux tests après
  `testCardsOpenTogetherAndKeepTheirSelectionWhenCollapsed` (l.158-197), sur la fixture `longLabelsCatalog`
  créée par TRA-664 ; helpers `card`, `element`, `tile`, `UITestFlows.settledFrame`, `tapAboveBar`.
Hors-scope explicite :
- Aucun fichier de l'app ni de Core. Si un test révèle un défaut de layout, ouvrir un ticket, ne pas corriger ici.
- Aucun nouveau fichier de test ; aucune modification des tests existants.
- Coordination avec la session « fiche de nœud iOS » : ne pas toucher `Track1Tokens.swift` (ni ses
  tests), `EdgeChip.swift`, `Track1Icon.swift`, `AmbientGlow`, `App/RootView.swift`.

## Contrat
Pas d'API nouvelle. Mesures lues sur le bouton `genre-card-<key>` (l'en-tête : 46 pt repliée sur une
ligne de titre, 22 pt de plus par ligne de titre supplémentaire à la taille de texte par défaut).

## Critères d'acceptation
- [ ] Test A (`testALongFamilyNameWrapsAndKeepsItsBadge`) : avec `longLabelsCatalog`, cartes repliées,
      `genre-card-family-1` (« Musiques traditionnelles d'Afrique et d'Orient ») a la même largeur (± 1 pt)
      que `genre-card-family-0`, son `frame.maxX` ≤ `app.frame.maxX`, et sa hauteur ≥ celle de `family-0`
      + 21 pt (le nom est replié, pas tronqué). Après avoir coché `subgenre-chip-local:genre-1a` et replié :
      même largeur, même hauteur (± 1 pt) qu'avant la sélection, label finissant par ", 1 sélectionné".
      Capture `1.2-long-family` jointe.
- [ ] Test B (`testTheEditSheetDrawsTheSameCardHeaderAsTheOnboarding`) : dans l'onboarding, famille-0
      cochée (`genre-0a`) puis repliée : mesurer `h0`/`w0` ; famille-1 repliée non cochée : `h1`/`w1` ;
      « Continuer » ; `node-title` présent ; onglet « Genres » ; `genres-edit` ; dans la sheet,
      `genre-card-family-0` (value "replié", label contenant "1 sélectionné") et `genre-card-family-1`
      ont des cadres de même largeur et hauteur (± 1 pt) que `w0/h0` et `w1/h1`. Capture
      `3.3-edit-long-family` jointe.
- [ ] Les deux tests sont verts dans `ios-check` ; aucun test existant n'est modifié.

## Tests attendus
- UI : les tests A et B ci-dessus. Pas de test unitaire (aucun code d'app).

## Tier de risque
tier/1 — ajout de tests.

## Notes d'implémentation
- Parcours de la sheet d'édition : `testEditingTheGenresAddsAFamilyThenTodayIsComputedAgain` (l.279-305)
  montre la séquence (`app.tabBars.buttons["Genres"]`, `app.buttons["genres-edit"]`, carte repliée qui
  compte déjà le genre coché). `firstProfile()` (l.334) utilise `taxonomyCatalog` : ne pas le réutiliser,
  rejouer `completeOnboarding`-like à la main avec `longLabelsCatalog` pour mesurer avant « Continuer ».
- Toujours mesurer repliée, après `settledFrame` (ressort de fermeture) ; chaque tap via `tapAboveBar`.
- La sheet est pleine largeur sur iPhone : les largeurs doivent être identiques. Si `ios-check` montre un
  écart de hauteur entre onboarding et sheet, c'est un défaut à remonter (ticket), pas une tolérance à élargir.
- Les tuiles de l'onglet (`genre-tile-family-1`) affichent le nom long sur 3 lignes avec échelle 0,7 : hors
  scope, ne rien asserter dessus.
- Captures : `UITestFlows.screenshot(named:in:)` (l.131). `ios-check` publie les `.xcresult` en artefacts ;
  il ignore les PR en brouillon et n'est pas un check requis : passer la PR en « ready » et attendre son vert.
- Coordination (une autre session livre cette nuit la fiche de nœud iOS,
  `docs/plans/ios-node-page-ui-refresh.md`) :
  - `project.pbxproj` : aucun identifiant à créer (aucun fichier nouveau). Si un identifiant devenait
    nécessaire, utiliser la plage F1…0430–043F ; ne jamais utiliser 0420–042F.
  - `ProfileFlowTests.swift` et `UITestFlows.swift` sont partagés avec cette session. Accéder à la barre
    d'onglets par `app.tabBars…` comme aujourd'hui ; l'autre session migrera ces accès vers ses aides
    `UITestFlows.tabBar(in:)` / `tabButton(_:in:)`. Si ces aides sont déjà sur `main` au moment de
    l'implémentation, les utiliser.
  - Faire un update-branch sur `main` juste avant le merge.
- Commits conventionnels, `Refs TRA-666` ; PR titrée `TRA-666 …`, `Fixes TRA-666`.
```
