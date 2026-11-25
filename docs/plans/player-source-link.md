# Lecteur iOS : « Source : media.com » sous la dernière phrase

Plan de la phase `plan` du process de livraison, écrit le 2026-11-25 sur le brief de Raphael (app iOS
Track1, lecteur `PlayerView`). **En attente de validation** (gate humain, étape 3). Projet Linear : à créer
après validation.

Brief : « À la fin du texte dans le player, on devrait avoir « Source : media.com » — « Source » en blanc
plein, et « media.com » (le domaine du média source) en blanc à 80 % d'opacité, souligné et cliquable. »

Pas de maquette Figma pour cette ligne : le brief est la source de vérité du style. Le lecteur lui-même
reste celui de Figma `338:2461` (plans TRA-731, TRA-782, TRA-795, TRA-801).

Tous les chemins sont relatifs à la racine du dépôt ; les numéros de ligne sont ceux de `main` au
2026-11-25 (`0eae87e`).

## Problème

1. **Le lecteur ne dit pas d'où vient le texte.** `PlayerView` (`ios/Track1/Features/Node/PlayerView.swift`)
   dessine l'article phrase par phrase (`PlayerView.paragraphs(for:)`, l.147-151, via
   `ArticleSentences.split`) et rien d'autre : ni l'article ni les sources ne sont attribués. Le serveur
   envoie pourtant les citations avec chaque nœud (`NodeDetail.citations`,
   `ios/Track1Core/Sources/Track1Core/API/APIModels.swift:215`, type `Citation { url, title? }` l.303-312),
   déjà filtrées côté serveur (`src/mobile/nodes.ts:87-92`, `sanitizeCitations`) et revalidées au décodage
   (`ValidatedPublicURL` → `URLValidation.publicHTTPSURL`, `APIModels.swift:556-563`). Le schéma impose au
   moins une citation par nœud (`src/schemas.ts:103`) ; le pipeline en demande 2 à 4 (`src/pipeline.ts:325`),
   dans l'ordre du corpus (`src/pipeline.ts:1981`).
2. **La fiche de nœud les montre déjà, pas le lecteur.** `NodeArticleView` (`ios/Track1/Features/Node/NodeArticleView.swift`)
   dessine une section « sources » en fin de fiche (D15 du plan `track1-ios-figma.md`), une ligne par
   citation, ouverte par `openURL` (`NodePageView.swift:139-145`), avec le contrôle de l'URL au point d'usage
   (`safeCitationURL`, l.202-207). Le lecteur, qui est l'écran de lecture principal depuis le Today
   (`TodayFlowTests`), n'a aucun équivalent.
3. **Le texte du lecteur ne peut pas devenir un lien.** Par construction : `Text(verbatim:)` partout, « never
   a link » (`PlayerView.swift:113`, `ArticleSentences.swift:4-6`). La ligne de source est donc la seule
   chose cliquable du texte, et sa cible ne peut être qu'une URL validée, jamais un texte venu du réseau.

## Non-buts

- La fiche de nœud (`NodePageView`, `NodeArticleView`, section « sources ») ne change pas : ses lignes
  `Track1ListItem` restent telles quelles.
- Aucune autre citation que la première n'est dessinée dans le lecteur (D1, arbitrage Q1). Pas de liste
  « Sources : a.com, b.com ».
- Pas de titre de citation (`Citation.title`) : le brief demande le domaine.
- Aucun changement de `PlayerScroll` (Core) : la ligne n'est ni une phrase, ni une cible du carrousel, ni
  un focus (D2). Les tests `PlayerScrollTests` et le test UI de pas à pas (TRA-801) restent inchangés.
- Aucun événement d'analytics : le plan de tracking (`docs/track1-tracking-plan.md`) n'a pas d'événement
  « source ouverte », et la fiche de nœud n'en émet pas non plus (D5, Q7).
- Aucune localisation : le libellé est en français en dur comme tout le chrome de l'app (« Retour »,
  « Pas encore de texte pour cette œuvre. ») ; `contentLanguage` n'est pas consulté (D5, Q6).
- Aucun fichier nouveau dans les cibles de l'app (`ios/Track1`, `ios/Track1Tests`, `ios/Track1UITests`) :
  le `project.pbxproj` liste les fichiers à la main. Les fichiers nouveaux vont dans le package
  `ios/Track1Core` (Package.swift, pas de pbxproj).
- Pas de web : le « player » de `web/index.html` (l.89-102) est un lecteur audio, sans texte ; le brief
  vise le lecteur iOS.

## Décisions d'archi

### D1 — Une seule source : la première citation dont l'URL passe `URLValidation.publicHTTPSURL`, affichée par son hôte sans `www.`

`PlayerSource.first(in: node.citations)` prend la première citation (ordre du corpus, celui du serveur)
dont l'URL est publique en HTTPS avec un hôte (`URLValidation.swift:10-23`, le même garde que
`NodeArticleView.safeCitationURL`). Le domaine affiché est `url.host` en minuscules, débarrassé d'un seul
préfixe `www.` et seulement si ce qui reste contient encore un point (`www.pitchfork.com` → `pitchfork.com`,
`en.wikipedia.org` inchangé, `www.com` inchangé). Un hôte IDN reste en punycode (`xn--…`) : c'est une donnée
tierce, on ne la rend pas jolie au risque d'un homographe. Sans citation utilisable : rien n'est dessiné.

Le contrôle de l'URL se fait au point d'usage, comme `NodeArticleView.sourceRows(entries:)` (l.121-133) :
`Citation` ne peut pas porter une URL invalide, donc les tests passent par `first(urls:)` pour prouver
l'exclusion.

*Alternatives rejetées :* toutes les citations sur la ligne (« Sources : a.com · b.com ») — le brief est au
singulier, et deux domaines sur 309 pt se replient ; le `title` de la citation — le brief demande le
domaine ; garder `www.` (comme la fiche) — « www.pitchfork.com » n'est pas le « média » du brief.

### D2 — Une ligne de pied sous la dernière phrase, dans le contenu défilant, hors carrousel, couleurs fixes

La ligne est dessinée **après** le `VStack` des phrases, à `PlayerMetrics.sourceSpacing` = 24 pt
(`Track1Tokens.spacing24`) sous la dernière, alignée à gauche sur la colonne de 309 pt. Elle défile avec le
texte mais **ne publie pas** de `PlayerFramesKey` : elle n'entre ni dans `frames`, ni dans le focus
(`focusedIndex`), ni dans les pas du carrousel (`settledOffset`). La marge basse
(`PlayerMetrics.bottomMargin`, l.93-95) ne change pas : la dernière phrase atteint toujours le centre de
lecture (387), la ligne de source apparaît alors de 24 pt sous elle (y ≈ 428 pour une phrase d'une
ligne, ≈ 479 pour quatre lignes), dans la zone opaque du masque (opaque jusqu'à 562 sur 844 pt, 530 sur
812 pt) et au-dessus de la barre Now (694). L'espace résiduel sous la ligne est inoffensif : le scroll ne
s'arrête que sur une phrase.

Les couleurs sont celles du brief, fixes : « Source : » en `Track1Tokens.colorTextPrimary` (le « blanc »
du thème, `0xF6E9D8`, que `PlayerViewTests` appelle déjà `white`), le domaine en `colorTextPrimary` à
80 % d'opacité, souligné. La ligne ne suit pas le focus (Q3).

*Alternatives rejetées :* (a) en faire un item du carrousel — un pas de plus pour lire une ligne de
métadonnée, et ses couleurs devraient suivre le focus, contre le brief ; (b) l'attacher dans la vue du
dernier paragraphe — son cadre inclurait la ligne et la dernière phrase serait centrée 29 pt trop haut ;
(c) la mettre dans l'en-tête ou la barre Now — « à la fin du texte », dit le brief ; (d) rythme de 56 pt
(`paragraphSpacing`) — la ligne, blanche, ressemblerait à une phrase au focus (Q4).

### D3 — Un seul `Text` concaténé dans le rôle `reader`, via un nouvel initialiseur `Track1Text(_ text: Text, role:)` ; toute la ligne est un `Button`

Deux styles sur une même ligne qui doit pouvoir se replier : seule la concaténation de `Text`
(`Text(verbatim: "Source\u{00A0}: ") + Text(verbatim: domain).underline().foregroundColor(…)`) le permet
avec le repli natif. `Track1Text` (`ios/Track1/DesignSystem/Components/Core/Track1Text.swift:7-32`)
n'accepte qu'une `String` : il gagne `init(_ text: Text, role: Track1TextRole)`, l'initialiseur `String`
existant lui délègue (`verbatim` construit le `Text` comme aujourd'hui, l.29-31). Rien d'autre ne bouge
dans le design system : `Track1LineHeightLayout` et `track1Text(role)` (police, interligne, tracking,
`Track1Typography.swift:127-152`) s'appliquent au `Text` concaténé comme à un `Text` simple.

Le rôle est `reader` (22/34, celui des phrases, `Track1Typography.swift:63`) : la ligne fait partie du
texte, seule la couleur la distingue (même principe que TRA-801 : « only the colour tells »).

Toute la ligne est un `Button(action:)` en `.buttonStyle(.plain)` qui appelle `openURL(url)`
(l'`@Environment(\.openURL)` déjà présent dans `PlayerReader`, l.235), comme la fiche
(`NodePageView.swift:142`). La zone de toucher atteint 44 pt par la recette de `PlayerBackButton`
(l.511-523 : `.padding(outset).contentShape(Rectangle()).padding(-outset)`), avec
`outset = (PlayerNowBarMetrics.minimumTouchTarget − Track1TextRole.reader.lineHeight) / 2` = 5 pt ; la mise
en page garde ses 34 pt. Traits d'accessibilité : `.isLink`, libellé explicite `source.line`, identifiant
`player-source`.

*Alternatives rejetées :* un `HStack` de deux `Track1Text` — pas de repli (un domaine long se casserait au
milieu, cf. TRA-664) et `underline()` n'existe pas sur une `View` ; un `AttributedString` avec attribut
`.link` — seul le domaine serait tactile, mais sur 34 pt de haut (sous les 44 pt minimum) et sans passer par
notre `openURL` ; un `Text` nu sans `Track1LineHeightLayout` — perd l'interligne de 34 pt.

### D4 — La logique (choix de la citation, domaine, libellé) vit dans `Track1Core`, testée par `swift test` ; la vue ne fait que dessiner

`PlayerSource` est un nouveau fichier du package (`ios/Track1Core/Sources/Track1Core/Features/Node/PlayerSource.swift`),
Foundation seulement (`test/ios-core-package.test.ts` interdit `import SwiftUI` dans le package, l.138-177,
et `#if os(iOS)` dans ses tests, l.179-222). Il dépend de `Citation` et `URLValidation`, tous deux dans
Core. Ses tests tournent en local (`swift test --package-path ios/Track1Core`, la seule exécution Swift
autorisée en local, `docs/track1-builds.md:127-134`) : c'est là que vont tous les cas limites d'URL. Côté
app, `PlayerView.source(for:)` ne fait qu'appliquer la règle « pas de texte, pas de source » et
`PlayerMetrics` porte les constantes, vérifiées dans `PlayerViewTests` comme les autres mesures.

*Alternative rejetée :* tout dans `PlayerView` comme `artistNames(of:)` — testable seulement dans
`ios-check` (30 min par aller-retour, pas de simulateur en local).

### D5 — Libellé français en dur « Source\u{00A0}: », même chemin d'ouverture que la fiche, pas d'événement

Le libellé est `PlayerSource.label = "Source\u{00A0}:"` suivi d'une espace et du domaine : l'espace
insécable est celle de la typographie française déjà appliquée au contenu (TRA-823,
`ArticleSentencesTests.swift:140`) et empêche le deux-points de passer seul à la ligne. Il est français
quelle que soit `NodeDetail.contentLanguage` : tout le chrome de l'app est en français en dur (TRA-814 ne
traduit que le contenu). Le mot « Source » est le même dans les deux langues ; seule l'espace diffère.

L'ouverture passe par `openURL` de l'environnement, sans `ListeningActions` (réservé aux services
d'écoute, avec leurs événements) et sans événement analytics : parité avec la section « sources » de la
fiche.

*Alternatives rejetées :* libellé selon `contentLanguage` — pas d'infrastructure de localisation, et un
chrome bilingue à moitié ; un événement `source_opened` — pas dans le plan de tracking, brief séparé si
voulu.

### D6 — Preuve en trois étages : Core, app, UI ; pas de snapshot

- Core (`PlayerSourceTests`, nouveau fichier du package) : choix de la première URL valable, exclusion
  des URL `http`, privées, avec identifiants ; domaine en minuscules, `www.` retiré selon la règle D1,
  punycode conservé ; `line`.
- App (`PlayerViewTests`, fichier existant) : constantes de `PlayerMetrics` (identifiant, 24 pt, couleurs
  `[F6,E9,D8,FF]` et `[F6,E9,D8,CC]`, outset 5), `PlayerView.source(for:)` sur quatre nœuds (article +
  citation ; article sans citation ; ni article ni teaser avec citation ; teaser seul avec citation).
  `NodeTextComponentsTests` (existant) : un `Track1Text(Text, role: .reader)` concaténé mesure la même
  hauteur qu'un `Track1Text(String, role: .reader)` du même texte (une ligne, 34 pt), par
  `UIHostingController.sizeThatFits` comme l.79-88.
- UI (`TodayFlowTests`, fichier existant) : la fixture de `UITestFlows.nodeBody` reçoit une citation ;
  le test ouvre le lecteur, lit `player-source` (libellé « Source : media.example »), avance de cinq
  phrases avec `settledFocus`, mesure la ligne 24 pt (± 1) sous `player-paragraph-5`, tactile, alignée à
  gauche sur la colonne, puis vérifie qu'un sixième swipe laisse le focus sur [5] (la ligne n'est pas un
  pas) et qu'il n'y a pas de `player-paragraph-6`. On ne tape pas la ligne (Safari sortirait de l'app).

*Alternative rejetée :* tests de snapshot — pas d'outillage dans le dépôt, dépendance majeure hors brief.

## Découpage

Une partie, un ticket. Points = estimate Linear.

| # | Tâche | Tier | Pts | Dépend de |
|---|---|---|---|---|
| 1.1 | TRA-? · Core + DS + lecteur · « Source : media.com » sous la dernière phrase, cliquable, avec ses tests Core, app et UI | tier/2 | 2 | — |

Diff attendu ≈ 280 lignes (Core ~45 + tests ~70 ; `Track1Text` ~12 ; `PlayerView` ~70 ; `PlayerViewTests`
~45 ; `NodeTextComponentsTests` ~15 ; `UITestFlows` ~3 ; `TodayFlowTests` ~35). Si l'implémentation dépasse
300 lignes, couper en deux PR : (a) `PlayerSource` + `Track1Text(Text, role:)` + leurs tests (tier/1, rien
de visible), (b) le lecteur + test UI (tier/2) — voir Q8.

### Partie 1 — La ligne de source (déployable seule : une ligne de plus en fin de lecture, rien d'autre ne bouge)

- [ ] TRA-? 1.1 — `PlayerSource` (Core) ; `Track1Text(_ text: Text, role:)` ; `PlayerMetrics.source*` ;
  `PlayerView.source(for:)` ; `PlayerSourceLine` sous les phrases dans `PlayerReader.reading(height:)` ;
  fixture UI avec citation ; tests Core, app et UI.

## Risques

- **Le refactor de `Track1Text` touche chaque texte de l'app.** Le chemin `String` doit rester
  byte-identique (`verbatim` → `Text(verbatim:)`, sinon `Text(LocalizedStringKey)`). Garde-fou : le test de
  parité `TeaserCard`/`Track1Text` existant (`NodeTextComponentsTests.swift:79-88`) et toute la suite
  `Track1Tests` dans `ios-check`.
- **Libellé d'accessibilité d'un `Button` à `Text` concaténé.** SwiftUI combine normalement les runs, mais
  pour que `source.label` soit déterministe en UI test, le libellé est posé explicitement
  (`.accessibilityLabel(source.line)`).
- **Casse de l'hôte.** `URLValidation.publicHTTPSURL` compare en minuscules mais rend `components.url`
  tel qu'écrit : `domain(of:)` doit abaisser la casse lui-même (test Core `https://WWW.Example.COM/a` →
  `example.com`).
- **La fixture UI gagne une citation pour tous les nœuds.** La fiche de nœud dessine alors une section
  « sources » dans les tests UI. Aucun test UI ne compte les enfants de `node-card` ni ne cherche
  `section-sources` (vérifié le 2026-11-25 : seule occurrence de « sources » dans `Track1UITests`,
  `linksBody`, l.323). Si `ios-check` révèle un test qui défile la fiche jusqu'en bas et change de
  comportement, c'est à remonter, pas à contourner en retirant la citation.
- **Dynamic Type AX.** La ligne se replie sur deux lignes ou plus ; un domaine est un seul mot, SwiftUI le
  coupe au caractère s'il dépasse 309 pt (≥ ~28 caractères à 22 pt, rare). Pas de `lineLimit`, pas de
  `minimumScaleFactor`. L'outset de toucher est calculé sur la hauteur de ligne non échelonnée (34) ; aux
  tailles AX la ligne dépasse déjà 44 pt.
- **`ios-check` ignore les PR en brouillon et n'est pas un check requis** (`.github/workflows/ios-ci.yml:55`).
  L'implémenteur passe la PR en « ready » et attend `ios-check` vert avant de demander le merge ; c'est lui
  qui exécute les tests UI (pas de simulateur en local, `docs/track1-builds.md:127-134`).
- **Mesure UI pendant l'animation.** La ligne est mesurée après `settledFocus` (deux lectures à 0,2 s
  d'écart), jamais juste après `swipeUp()` ; tolérance ± 1 pt.

## Critères de sortie

- Sur un nœud qui a une citation publique HTTPS et du texte, le lecteur dessine « Source : <domaine> »
  24 pt sous la dernière phrase, « Source : » en `colorTextPrimary`, le domaine en `colorTextPrimary` à 80 %
  souligné, dans le rôle `reader`, et un toucher sur la ligne ouvre l'URL de la citation via le système.
- Sans citation utilisable, ou quand le lecteur affiche « Pas encore de texte pour cette œuvre. », rien
  n'est dessiné.
- Le carrousel est inchangé : six phrases, six pas, la ligne n'est jamais le focus ni une cible du scroll ;
  `PlayerScrollTests` et `testThePlayerStepsOneSentenceAtATimeAndFocusesTheOneAtTheReadingCenter` passent
  sans modification.
- `swift test --package-path ios/Track1Core` vert en local ; `ios-check` vert (Track1Tests et toute la
  suite UI), avec le nouveau test UI et sa capture `3.2-source`.
- Raphael voit la ligne sur son iPhone (parcours : Aujourd'hui → Découvrir, défiler jusqu'à la dernière
  phrase) et le domaine s'ouvre dans Safari.
- Le plan est sur `main`, avec l'identifiant du ticket et la date de validation.

## Questions ouvertes pour le gate

- **Q1 — Une seule source (la première citation) ?** Recommandation : oui (D1). Alternative : toutes les
  citations, ce qui change la forme (« Sources : a.com · b.com ») et le repli sur 309 pt.
- **Q2 — « Blanc plein » = `colorTextPrimary` (`0xF6E9D8`, le blanc du thème, déjà celui de la phrase au
  focus) et non `#FFFFFF` ?** Recommandation : `colorTextPrimary`, pour rester dans les tokens ; 80 % par
  `.opacity(0.8)` (pas de token « blanc 80 % » dans `Track1Tokens`).
- **Q3 — Couleurs fixes même quand la dernière phrase n'a pas le focus ?** Le brief le dit ; conséquence :
  quand on lit l'avant-dernière phrase, la ligne blanche est visible sous une dernière phrase atténuée.
  Recommandation : suivre le brief (D2), et revenir dessus en un ticket tier/1 si ça gêne à l'œil.
- **Q4 — 24 pt sous la dernière phrase (note de bas de texte) plutôt que 56 (rythme des phrases), et rôle
  `reader` (22 pt) plutôt qu'un rôle plus petit ?** Recommandation : 24 pt et `reader` (D2, D3). Les deux
  sont des constantes `PlayerMetrics`, un changement d'une ligne.
- **Q5 — `www.` retiré, punycode conservé (D1) ?** La fiche garde `www.` ; les deux écrans divergeraient sur
  ce point.
- **Q6 — Libellé « Source : » en français quelle que soit la langue du contenu (D5) ?**
- **Q7 — Pas d'événement analytics à l'ouverture (D5) ?**
- **Q8 — Tier/2, 2 points, un seul ticket ?** Split proposé en Découpage si le diff dépasse 300 lignes.

## Ticket (brouillon, format `ticket-template.md`)

### TRA-? (1.1) — Afficher « Source : media.com » cliquable sous la dernière phrase du lecteur

- Tier : **tier/2** · Estimate : **2** · Partie 1 · Labels : `tier/2`

```markdown
## Contexte
Le lecteur (`PlayerView`, écran Figma `338:2461`) dessine l'article phrase par phrase sans dire d'où vient
le texte, alors que chaque nœud arrive avec ses citations (`NodeDetail.citations`) et que la fiche de nœud
les montre déjà en section « sources ». Raphael veut, à la fin du texte, une ligne « Source : media.com » :
« Source : » en blanc plein, le domaine en blanc à 80 %, souligné et cliquable. Plan :
docs/plans/player-source-link.md#partie-1 (D1 à D6).

## Portée
Fichiers à créer (package Track1Core : pas de `project.pbxproj`) :
- `ios/Track1Core/Sources/Track1Core/Features/Node/PlayerSource.swift` — Foundation seulement (pas
  d'`import SwiftUI`, `test/ios-core-package.test.ts` l'interdit) : struct `PlayerSource`, voir Contrat.
- `ios/Track1Core/Tests/Track1CoreTests/Node/PlayerSourceTests.swift` — pas de `#if os(iOS)`.
Fichiers à modifier (chemins vérifiés, lignes de `main` au 2026-11-25, `0eae87e`) :
- `ios/Track1/DesignSystem/Components/Core/Track1Text.swift` — l.7-32 : ajouter `init(_ text: Text, role:)` ;
  l'`init(_ content: String, role:, verbatim:)` existant lui délègue en construisant le `Text` comme l.29-31
  (`verbatim ? Text(verbatim:) : Text(LocalizedStringKey(…))`). Le reste du fichier ne change pas.
- `ios/Track1/Features/Node/PlayerView.swift` — `PlayerMetrics` (l.6-110) : constantes `source*` (Contrat) ;
  doc du type l.112-113 : préciser que la ligne de source est le seul lien, cible = URL de citation
  validée, texte = hôte de cette URL ; `PlayerView` : `static func source(for:)` à côté de
  `paragraphs(for:)` (l.147-151) ; `PlayerReader` : propriété `source` calculée une fois dans l'`init`
  (l.237-243) comme `paragraphs` ; `reading(height:)` (l.313-341) : envelopper le `VStack` des phrases
  (l.317-321) dans un `VStack(alignment: .leading, spacing: PlayerMetrics.sourceSpacing)` qui ajoute
  `PlayerSourceLine` après lui quand `source != nil` ; nouvelle vue privée `PlayerSourceLine` après
  `PlayerParagraph` (l.344-367). `PlayerReader` ouvre avec `openURL($0)` (environnement l.235), pas avec
  `openListening`.
- `ios/Track1Tests/Node/PlayerViewTests.swift` — helper `node(…)` l.28-36 : paramètre
  `citations: String = "[]"` injecté dans le JSON ; tests dans « Measures » (l.44-109) et « Paragraphs »
  (l.111-150), voir Tests attendus.
- `ios/Track1Tests/DesignSystem/NodeTextComponentsTests.swift` — un test de parité de hauteur sur le modèle
  de l.79-88.
- `ios/Track1UITests/UITestFlows.swift` — `nodeBody` l.296 : `"citations": [Any]()` →
  `[["url": "https://www.media.example/\(slug)", "title": "Media"]]` ; `static let sourceDomain =
  "media.example"` à côté d'`articleSentenceCount` (l.304).
- `ios/Track1UITests/TodayFlowTests.swift` — un test après
  `testThePlayerStepsOneSentenceAtATimeAndFocusesTheOneAtTheReadingCenter` (l.72-102), réutilisant
  `openPlayer()` (l.191), `settledFocus` (l.109), `element` (l.203).
Hors-scope explicite :
- `NodeArticleView`, `NodePageView`, `Track1ListItem` (la fiche garde ses lignes et son `www.`).
- `PlayerScroll.swift`, `PlayerScrollTests.swift`, `PlayerCarousel`, `PlayerSnapBehavior`,
  `PlayerMetrics.bottomMargin` : la ligne n'est ni un cadre, ni un focus, ni un pas.
- `ListeningActions`, analytics, `Track1Tokens` (pas de nouveau token : `.opacity(0.8)` sur
  `colorTextPrimary`), `Track1Typography` (le rôle est `reader`).
- Aucun fichier nouveau dans `ios/Track1`, `ios/Track1Tests`, `ios/Track1UITests` ; aucune édition du
  `project.pbxproj`.
- Aucune localisation, aucun `lineLimit` / `minimumScaleFactor`.

## Contrat
Core (`PlayerSource.swift`, `public`, Foundation) :
    /// The source line the reader draws under the last sentence (plan player-source-link, D1).
    public struct PlayerSource: Equatable, Sendable {
        /// "Source\u{00A0}:" — French chrome like the rest of the app; U+00A0 keeps the colon on the line.
        public static let label: String
        /// Host of `url`, lowercased, without one leading "www." when a dot remains after it
        /// ("www.pitchfork.com" → "pitchfork.com", "en.wikipedia.org" and "www.com" unchanged). Punycode as is.
        public let domain: String
        /// The citation URL as `URLValidation.publicHTTPSURL` returned it.
        public let url: URL
        /// "Source\u{00A0}: pitchfork.com": the drawn text and the accessibility label.
        public var line: String { get }
        /// `first(urls: citations.map(\.url))`.
        public static func first(in citations: [Citation]) -> PlayerSource?
        /// The first URL that is a public HTTPS one with a host (`URLValidation.publicHTTPSURL`); nil when none.
        /// The check stays at the point of use, as `NodeArticleView.sourceRows(entries:)` does.
        public static func first(urls: [URL]) -> PlayerSource?
        /// nil for a URL without a host, or whose host is empty once lowercased and stripped.
        public static func domain(of url: URL) -> String?
    }
Design system (`Track1Text.swift`) :
    init(_ text: Text, role: Track1TextRole)                              // nouveau
    init(_ content: String, role: Track1TextRole, verbatim: Bool = false) // inchangé, délègue au précédent
App (`PlayerView.swift`) :
    extension PlayerMetrics {
        static let sourceIdentifier = "player-source"
        /// Under the last sentence: a footnote, closer than the 56 pt between sentences (plan D2).
        static let sourceSpacing: CGFloat = Track1Tokens.spacing24          // 24
        static let sourceLabelColor: Color = Track1Tokens.colorTextPrimary
        static let sourceDomainOpacity: Double = 0.8
        static let sourceDomainColor: Color = Track1Tokens.colorTextPrimary.opacity(sourceDomainOpacity)
        /// 44 pt of touch on a 34 pt line, the back button's recipe (`PlayerBackButton`).
        static let sourceTouchOutset: CGFloat                               // (minimumTouchTarget − reader.lineHeight) / 2 = 5
    }
    extension PlayerView {
        /// nil when the reader shows `emptyMessage` (no sentence in the article and no teaser): no text, no source;
        /// else `PlayerSource.first(in: node.citations)`.
        static func source(for node: NodeDetail) -> PlayerSource?
    }
    /// One `Track1Text(Text, role: .reader)`: `Text(verbatim: PlayerSource.label + " ")` in `sourceLabelColor`
    /// + `Text(verbatim: source.domain).underline().foregroundColor(sourceDomainColor)`; `.frame(width:
    /// columnWidth, alignment: .leading)`; wrapped in `Button(action: { open(source.url) })`,
    /// `.buttonStyle(.plain)`, hit area padded by `sourceTouchOutset` (`.padding(outset).contentShape(Rectangle())
    /// .padding(-outset)`), `.accessibilityLabel(source.line)`, `.accessibilityAddTraits(.isLink)`,
    /// `.accessibilityIdentifier(PlayerMetrics.sourceIdentifier)`. No `PlayerFramesKey` preference, no animation.
    private struct PlayerSourceLine: View { let source: PlayerSource; let open: (URL) -> Void }
Fixture UI (`UITestFlows`) : chaque nœud de `fixturesJSON` porte une citation
`https://www.media.example/<slug>` (titre « Media ») ; `UITestFlows.sourceDomain == "media.example"`.

## Critères d'acceptation
- [ ] `PlayerSource.label == "Source\u{00A0}:"` ; `PlayerSource(domain: "pitchfork.com", url: …).line ==
      "Source\u{00A0}: pitchfork.com"`.
- [ ] `PlayerSource.first(urls:)` : `[https://www.pitchfork.com/reviews/x]` → domaine `pitchfork.com`, url
      identique ; `[https://en.wikipedia.org/wiki/X]` → `en.wikipedia.org` ; `[https://WWW.Example.COM/a]`
      → `example.com` ; `[https://www.com/]` → `www.com` ; `[https://xn--mnchen-3ya.de/]` → `xn--mnchen-3ya.de` ;
      `[http://a.example/, https://b.example/]` → `b.example` ; `[https://127.0.0.1/, https://user:pw@c.example/,
      https://d.example:8443/]` → nil ; `[]` → nil.
- [ ] `PlayerSource.first(in:)` sur deux `Citation` décodées rend la première.
- [ ] `PlayerMetrics.sourceIdentifier == "player-source"`, `sourceSpacing == 24`, `rgba(sourceLabelColor) ==
      [0xF6, 0xE9, 0xD8, 0xFF]`, `rgba(sourceDomainColor) == [0xF6, 0xE9, 0xD8, 0xCC]`, `sourceTouchOutset == 5`.
- [ ] `PlayerView.source(for:)` : article + citation → non nil (domaine attendu) ; article + `citations: []`
      → nil ; article vide + teaser nil + citation → nil (le lecteur montre `emptyMessage`) ; article vide +
      teaser + citation → non nil.
- [ ] `Track1Text(Text(verbatim: "Source\u{00A0}: ") + Text(verbatim: "media.example").underline(), role: .reader)`
      et `Track1Text("Source\u{00A0}: media.example", role: .reader, verbatim: true)` mesurent la même
      hauteur (± 0,5) à 309 pt de large, > 0, via `UIHostingController.sizeThatFits`.
- [ ] Test UI : dans le lecteur, `app.buttons["player-source"]` existe avec le libellé
      `"Source\u{00A0}: media.example"` ; après cinq `swipeUp()` séparés par `settledFocus(movedFrom:)`, le
      focus est `[5]`, la ligne est `isHittable`, `source.frame.minY − paragraph5.frame.maxY == 24 ± 1`,
      `source.frame.minX == paragraph5.frame.minX ± 1`, `source.frame.maxY ≤ app.frame.maxY` ; un sixième
      `swipeUp()` laisse le focus à `[5]` ; `player-paragraph-6` n'existe pas. Capture `3.2-source`.
- [ ] `swift test --package-path ios/Track1Core` vert ; `ios-check` vert avec `Track1Tests` et toute la
      suite UI, dont `testThePlayerStepsOneSentenceAtATimeAndFocusesTheOneAtTheReadingCenter` et
      `PlayerScrollTests` sans modification.

## Tests attendus
- unitaire Core (`PlayerSourceTests`) : les cas de `first(urls:)` ci-dessus, `first(in:)` sur des
  `Citation` décodées (JSON comme `APIClientTests.swift:397`), `domain(of:)`, `line`.
- unitaire app (`PlayerViewTests`) : constantes ; `source(for:)` sur les quatre nœuds ; `rgba` l.38-42.
  (`NodeTextComponentsTests`) : parité de hauteur `Track1Text(Text)` / `Track1Text(String)`.
- UI (`TodayFlowTests.testTheReaderEndsWithTheSourceOfTheArticleUnderItsLastSentence`) : le scénario du
  critère UI. Ne pas taper la ligne (Safari quitterait l'app).

## Tier de risque
tier/2 — composant sans état dans le design system (nouvel initialiseur), logique locale en Core, ouverture
d'une URL tierce déjà validée par le chemin existant (`URLValidation`), couverte par tests Core, app et UI.

## Notes d'implémentation
- La ligne ne publie **aucun** `PlayerFramesKey` : sinon elle entre dans `frames`, devient focusable et un
  pas du carrousel (plan D2). Ne pas toucher `bottomMargin` : l'espace sous la ligne est inoffensif, le
  scroll ne s'arrête que sur une phrase.
- `Text(verbatim:)` pour le libellé comme pour le domaine : le domaine vient du réseau (jamais de
  Markdown, jamais de `LocalizedStringKey`). La cible du lien est l'URL rendue par
  `URLValidation.publicHTTPSURL`, jamais une chaîne.
- `URLValidation.publicHTTPSURL` compare l'hôte en minuscules mais rend l'URL telle qu'écrite :
  `domain(of:)` abaisse la casse lui-même.
- `.buttonStyle(.plain)` garde les couleurs posées sur le `Text` ; poser `.accessibilityLabel(source.line)`
  explicitement pour un libellé déterministe en UI test.
- Convention du dépôt : un commentaire explique *pourquoi*, en anglais ; les constantes de `PlayerMetrics`
  citent le plan (`player-source-link`, D2/D3) faute de nœud Figma.
- Pas de simulateur en local (`docs/track1-builds.md:127-134`) : `swift test` pour Core, typecheck de
  l'app possible sans xcodebuild (`docs/track1-builds.md:146-160`), le reste passe par `ios-check`. La PR
  doit être « ready » (pas brouillon) pour qu'`ios-check` tourne (`.github/workflows/ios-ci.yml:55`) ; il
  n'est pas un check requis : attendre son vert avant de demander le merge.
- Mesures UI toujours après `settledFocus` (ressort du scroll), tolérance ± 1 pt ; `element(app, …)` lit
  `descendants(matching: .any)`, la ligne se lit avec `app.buttons[…]`.
- Si le diff dépasse 300 lignes, couper : (a) `PlayerSource` + `Track1Text(Text, role:)` + tests (tier/1),
  (b) lecteur + UI (tier/2) ; (b) dépend de (a).
- Commits conventionnels, `Refs TRA-?` ; PR titrée `TRA-? …`, `Fixes TRA-?`.
```
