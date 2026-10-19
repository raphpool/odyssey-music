# Track1 iOS — V1 fidèle au Figma de handoff (re-planification de P-TRA-4)

Statut : **Validé par Raphael le 2026-10-11, sauf règle 9 (article conservé).** Toutes les
recommandations par défaut sont retenues (Q1 à Q6, D11 à D13). L'article et les sources restent sur
la fiche (D15). Les ID Linear sont reportés dans la colonne « Ticket » de la vue d'ensemble (créés le
2026-10-12 : TRA-381 à TRA-409, plus TRA-367, 372, 373 et 374 amendés).

Ce plan remplace la partie interface du plan V1 [`track1-ios-v1-basic.md`](track1-ios-v1-basic.md).
Les décisions D1, D2, D3, D5 et D6 de ce plan restent en vigueur. **D4 est remplacée** par D4bis
ci-dessous.

Sources :
- Figma de handoff v1.0 du 2026-10-11, fichier `phudxrQNlzQJafXLma4FyX`
  (`https://www.figma.com/design/phudxrQNlzQJafXLma4FyX/track1?node-id=<id>`, avec `-` à la place de
  `:` dans l'id). Pages lues : Cover `0:1`, Read me `168:1394`, Foundations `4:3`, Components ·
  Core `4:5`, Node page `168:1395`, Navigation & system `4:9`, Onboarding `168:1396`, Flows 1 à 3
  (`168:1398`, `168:1399`, `168:1400`), Spec · Data contract `168:1401`. Les pages « Explo / … »
  (`28:2`, `57:458`, `56:340`) et « Archive · v0 kit » (`30:2`) ne sont pas des sources.
- Code `origin/main` `4218dbd`. Les PR #330 (TRA-368) et #331 (TRA-364) sont encore ouvertes.
- Tickets Linear : TRA-347, 352, 317, 331, 315, 318, 319, 354, 320, 321, 367, 372, 373, 374, 376,
  379, 364, 368, 371.

## Problème

Le plan V1 gelait la fidélité visuelle (D4) en attendant le Figma. Le Figma est livré. Il fixe :
- un thème unique sombre, Nocturne ;
- deux polices embarquées, JetBrains Mono et Roboto ;
- une trentaine de composants en 4 groupes ;
- trois parcours : onboarding en 7 écrans, onglet Aujourd'hui qui *est* la fiche du jour,
  recherche en sheet avec fil d'Ariane ;
- un Data contract qui dit où chaque champ du nœud s'affiche.

Le Figma contredit plusieurs choix déjà livrés ou planifiés :
- **Article et sources** (TRA-365, mergé) : non affichés en v1 (Data contract, règle 9). Raphael
  les conserve (D15).
- **Onglets** : Aujourd'hui / Recherche / Réglages deviennent Aujourd'hui / Genres / Recherche,
  et la recherche s'ouvre en sheet.
- **Aujourd'hui** (TRA-373) : plus de carte « Découvrir ». La fiche du jour s'affiche directement.
- **Recherche** (TRA-364 et TRA-372) : plus de filtres par type, une temporisation de 150 ms au
  lieu de 300 ms, et des fiches récentes quand la requête est vide.
- **Onboarding** (TRA-340, mergé) : on ne choisit plus au moins 3 genres sur une page. On choisit
  des genres parents, puis leurs sous-genres, sur une étape par parent.
- **Génération** : toute relation non matérialisée devrait être générée à la volée. Cela contredit
  D2 (lecture seule).

Les contraintes ne changent pas :
- un seul runner macOS ;
- au plus 3 PR iOS ouvertes ;
- un gate CI à 600 lignes ou 20 fichiers par PR, avec une cible sous 400 ;
- les plages d'IDs pbxproj (D5) ;
- des XCUITest fragiles sous charge (TRA-378).

L'implémentation se fera dans une session cloud Linux sans Xcode : chaque ticket doit être
autoportant, et seul `ios-check` compile et teste le Swift.

**Calibrage des tailles.** Les tâches V1 estimées entre 210 et 290 lignes ont livré 406 à 715
lignes (#330, #329, #331). Les estimations ci-dessous comptent ajouts et suppressions, tests et
pbxproj compris, et intègrent ce facteur.

## Ce qui change par rapport au plan V1

### Décisions V1

| Décision | Sort |
| --- | --- |
| D1 — #317 découpée | Historique, inchangée. |
| D2 — écrans en lecture seule | **Maintenue**, contre la génération à la volée du Data contract (voir D11). |
| D3 — XCUITest seulement sur les vrais parcours, fixtures de lecture | Maintenue. Trois parcours : Aujourd'hui (H.2), Recherche (I.2), Onboarding (J.4). On y ajoute des captures d'écran (D7). |
| D4 — UI SwiftUI système, rien de plus | **Remplacée par D4bis.** |
| D5 — plages d'IDs pbxproj | Maintenue. Nouvelles plages à partir de `0200` (jusqu'à `01FF`, tout est pris). |
| D6 — archive Preview signée localement | Inchangée (`ios/scripts/archive.sh`, TRA-360). |

### Code mergé ou en cours : réutilisé, amendé ou remplacé

| Code (ticket) | Sort | Tâche |
| --- | --- | --- |
| `NodeViewModel`, `NavigationContext` (TRA-358) | Réutilisés tels quels. | — |
| `Affinity` (TRA-359), `DailySelection` (TRA-363), `DailyRecommendationStore` (TRA-369) | Réutilisés. | — |
| `TodayViewModel` (TRA-371, mergé) | Réutilisé. `discover()` est appelé à l'affichage de la fiche du jour, pas sur un bouton. | H.2 |
| `ContentReaders`, route `.node` (TRA-361) | `ContentReaders` est réutilisé, et son lecteur `image` sert enfin. | F.3 |
| `AppRouter`, `AppTab` (TRA-335, TRA-361) | Amendés : onglets, titres de route, `popTo`, sheet de recherche. | G.1 |
| `NodeView` minimal (TRA-361) | Reste le conteneur d'états. Le corps `.loaded` est remplacé par `NodePageView`. | H.1 |
| `NodeArticleView`, `NodeArticleParser` (TRA-365) | **Conservés** (D15, écart validé à la règle 9) : logique inchangée, habillage Nocturne en sections « article » et « sources » en fin de fiche. | H.1, H.3 |
| `NodeRelationsView` (TRA-366) | Remplacé par les sections chips, carrousel et pistes. L'événement `relation_opened` est conservé. | H.1, L.1 |
| `ListeningActions` (TRA-362) | Réutilisé par la barre d'écoute. | E.4, H.1 |
| `NodeListeningView` et état d'écoute du VM (TRA-368, PR #330) | L'état est réutilisé. La vue est remplacée par `StreamingBar`. | H.1, L.1 |
| `SearchViewModel` (TRA-364, PR #331) | Réutilisé avec une temporisation de 150 ms et les récents. Les filtres restent dans le VM, sans UI. | I.1 |
| `UITestFixtureReaders` (TRA-370) | Réutilisé. Les fixtures sont enrichies dans les fichiers de test, sans changer le code. | — |
| `ios/scripts/archive.sh` (TRA-360) | Réutilisé. | L.3 |
| `Track1Theme`, `Track1PrimaryButtonStyle` | Remplacés par `Track1Tokens` et les composants, puis supprimés. | A.1, L.2 |
| `OnboardingView` et `ProfileMissingView` (TRA-340) | Remplacés par le Flow 1, puis supprimés. `Profile` et `ProfileStore` sont réutilisés. | J.x, L.2 |
| `PrivacyChoiceView`, `SettingsView` | Conservés et habillés (non dessinés). | K.2 |
| `EntryView` et `EntryStatusView` | Laissés en place, comme en V1 (`AppConfigurationTests` les utilise). | — |

### Tickets V1 restants

| Ticket | Sort |
| --- | --- |
| TRA-368 (PR #330) | **Garder tel quel**, le merger. Sa vue est remplacée en H.1 et supprimée en L.1. |
| TRA-364 (PR #331) | **Garder tel quel**, le merger. Les changements Figma vont en I.1. |
| TRA-379 — concurrence de `TodayViewModel` | **Garder tel quel.** Il bloque H.2. |
| TRA-376 — ne pas recharger la fiche au retour | **Garder tel quel.** Il bloque H.1 (qui modifie `NodeView`). |
| TRA-373 — vue Aujourd'hui + XCUITest | **Amender** : il devient H.2, avec la fiche du jour directe. Plage pbxproj `0320–032F` au lieu de `01B0–01BF`. |
| TRA-372 — vue Recherche + XCUITest | **Amender** : il devient I.2, en sheet. Plage `0340–034F` au lieu de `01D0–01DF`. |
| TRA-367 — image (optionnelle) | **Amender et rendre obligatoire** : il devient F.3, chargeur et cache d'images. Plage `02E0–02EF`. |
| TRA-374 — installation iPhone et smoke (tier/3) | **Amender** : il devient L.3, avec le smoke des parcours Figma et le relevé visuel. |

Les parents TRA-341, TRA-342, TRA-343, TRA-348 et TRA-337 gardent leur rôle de conteneurs, avec le
contrat réduit V1 complété par les tâches rattachées ci-dessous.

### Tickets en pause `en-pause/figma`

| Ticket | Sort | Raison |
| --- | --- | --- |
| TRA-347 — particularités des 5 types de fiche | **Réécrire** en parent des Parties F et H.1 : « Présenter les cinq types de fiche selon le Data contract ». | Son contrat (composants RN, Figma d'exploration `34:144`…) est obsolète. Le Data contract `168:1401` le remplace exactement. |
| TRA-352 — animations accessibles | **Laisser en pause**, retirer `en-pause/figma`. | Le mouvement et sa variante Reduce Motion sont spécifiés par composant et par écran : chaque tâche les livre. La repasse transverse (Instruments, vidéos) dépend de TRA-346, 349, 350 et 351, hors V1. |
| TRA-317 — confidentialité (tier/3) | **Laisser en pause**, retirer `en-pause/figma`. | Le Figma ne la dessine pas. Elle reste bloquée par TRA-346, 339 et 350. |
| TRA-331 — validation des 16 écrans | **Laisser en pause**. Sa partie V1 est **fusionnée** dans L.3 (relevé visuel des 13 écrans dessinés). | La recette transverse (push, génération, hors ligne) est post-V1. À réécrire plus tard sur les 13 écrans réels. |
| TRA-315 — Segment vers Amplitude | **Laisser en pause**, retirer `en-pause/figma`. | Sans lien avec le Figma (R7 V1). À noter pour sa reprise : `daily_recommendation_opened` change de sens (R10). |
| TRA-318, 319, 354, 320, 321 — Partie 6 App Store | **Laisser en pause**, retirer `en-pause/figma`. | Hors V1. Ils restent bloqués par TRA-331 via leurs relations. |

## Non-buts

- **Génération à la volée.** Aucun `POST /mobile/v1/generations` (D2 maintenue, D11). TRA-349
  reste hors V1.
- **Étape 1.5 Notifications.** L'écran 1.5, `Notification preview` (`174:62`) et `Device outline`
  (`174:98`) restent hors V1, ainsi que TRA-346. L'onboarding enchaîne 1.4, puis 1.6.
- **Bonus Figma** : préécoute audio à l'appui long (genre, sous-genre) et dérive lente
  « Turrell » de l'Ambient glow. Le fond animé de l'écran Welcome (1.1), qui n'est pas marqué
  bonus, est inclus.
- **Contenus exclus par le Data contract (règle 9)** : `mbid`, `qid`, `materialized_at`,
  `image_source`. `editorial_article` et `citations` restent affichés (D15).
- **YouTube Music**, faute de lien dans `/links` (D12). Pas de logo de label non plus : le champ
  n'existe pas et un changement de schéma est tier/3.
- **Mode clair** (le Figma l'exclut) et **changement de la cible de déploiement** (iOS 17.0).
- **Hors iOS** : aucun changement serveur, schéma, pipeline, site, Android ou Expo. Les teasers
  coupés en milieu de phrase relèvent du pipeline et sont hors de ce plan.
- **Filtres par type dans l'UI de recherche.** Le Figma n'en dessine pas. Le VM les garde, sur
  `.all`.
- **Dépendance de test par capture** (snapshot testing) : voir D7.
- **Hors V1 maintenus** : la Partie 6 App Store, TRA-315, TRA-317, TRA-346, TRA-350 et TRA-351.

## Décisions d'archi

### D4bis — Le design system Nocturne vit en code SwiftUI, un composant Figma = un composant code

- **Jetons.** `Track1Tokens`, un `enum` Swift de constantes, porte les jetons sémantiques Figma :
  47 couleurs, 14 espacements, 6 rayons, 11 tailles et 5 jetons de mouvement. Les valeurs sont
  celles du mode Nocturne. Les noms suivent la syntaxe iOS du Figma (`theme.color.text.primary` →
  `Track1Tokens.colorTextPrimary`).
- **Thème sombre seul.** L'application est forcée en sombre (`UIUserInterfaceStyle = Dark`).
- **Typographie.** Les 20 rôles typographiques sont un `enum Track1TextRole`. Les 6 fichiers de
  police sont embarqués, et chaque rôle passe par `Font.custom(_:size:relativeTo:)` pour respecter
  Dynamic Type.
- **Composants.** Chaque composant Figma devient une `View` dans
  `ios/Track1/DesignSystem/Components/<Groupe>/`. Les propriétés Figma deviennent des paramètres et
  les variantes des `enum`.
- **Écrans.** Les fichiers de `Features/` et `App/` n'utilisent que des jetons et des composants.
  Un test vitest le vérifie (L.2).
- **Rejeté : des color sets dans `Assets.xcassets`.** Il faudrait 47 dossiers JSON (gate de 20
  fichiers), invisibles en revue et non testables. Rejeté aussi : garder l'UI système en la
  teintant, qui ne satisfait pas le handoff. Rejeté enfin : implémenter aussi le mode clair, que le
  Figma déclare legacy et non dessiné.

### D7 — Fidélité vérifiée par captures XCUITest, sans dépendance de snapshot

- **Captures.** Les XCUITest des trois parcours (H.2, I.2, J.4) joignent une capture
  (`XCTAttachment(screenshot:)`, `lifetime = .keepAlways`) nommée d'après l'écran Figma (« 1.2b »,
  « 2.1 »…). La capture se lit dans l'artefact `ios-xcresult-<run>-<attempt>`. La PR liste ces
  captures avec les node-ids, pour une comparaison visuelle en revue.
- **Logique des composants.** Elle est testée en XCTest sur des fonctions pures : résolution de
  style par variante, formatage, mise en page des chips, repli des images.
- **Rejeté : `swift-snapshot-testing`.** C'est une dépendance nouvelle, avec des images de
  référence liées au simulateur et à l'OS, ingérable sur un runner unique et depuis un conteneur
  sans Xcode. Rejeté aussi : aucune preuve visuelle avant le smoke final, qui découvrirait les
  écarts trop tard.

### D8 — Barre d'onglets native, recherche en sheet, Liquid Glass protégé par `#available`

- **Onglets.** `TabView` natif avec Aujourd'hui, Genres et Recherche. Sous iOS 26, la recherche est
  un `Tab(role: .search)` : le bouton rond isolé du Figma, avec le verre natif.
- **Recherche en sheet.** La sélection de Recherche est interceptée par le binding : l'onglet
  courant reste sélectionné et la sheet de recherche s'ouvre.
- **Verre.** `.glassEffect` sous `if #available(iOS 26, *)`. Sinon, `.ultraThinMaterial` avec
  `colorGlassSurface` et une bordure de 1 pt `colorGlassBorder`. La cible reste iOS 17.0 ; la CI
  tourne sur le runtime iOS 26.4.
- **Réglages.** L'onglet Réglages disparaît. `SettingsView` devient provisoirement la racine de
  l'onglet Genres (G.1), puis s'ouvre depuis cet onglet (K.1).
- **Rejeté : une barre d'onglets dessinée à la main.** Il faudrait réimplémenter l'accessibilité,
  les safe areas et le verre, alors que le Figma demande la barre native iOS 26. Rejeté aussi :
  relever la cible à iOS 26, qui exclurait des appareils (la note de TRA-352 l'interdit déjà).

### D9 — Le Data contract est projeté côté client et sa parité avec `src/node-spec.ts` est testée

- **Projection.** `NodePageModel`, une projection pure de `NodeDetail`, calcule : titre,
  sous-titre, teaser sans markdown, faits, sections dans l'ordre du schéma, présentation (chips,
  carrousel, pistes, unique), libellés, comptes et seuil de 8.
- **Constantes.** Les constantes Swift (`NodePageSpec`) sont encadrées par des marqueurs. Un test
  vitest les compare à `EDGE_FIELDS_BY_TYPE`, `SINGULAR_EDGES_BY_TYPE` et `OPTIONAL_TEXT_FIELDS`
  (F.1).
- **Écart toléré.** Le test de parité tolère explicitement l'article et les citations comme seul
  écart validé à la règle 9 (D15).
- **Ordre des sections.** C'est celui du schéma (règle 2 du Data contract). Il diffère de l'ordre
  dessiné en 2.1 (producers avant tracks) et en 2.3 (collaborators avant influences) ; la règle
  prime sur l'écran.
- **Rejeté : un serveur qui enverrait des sections ordonnées.** C'est un changement serveur hors
  V1. Rejeté aussi : s'appuyer sur l'ordre des clés JSON, que `JSONDecoder` ne conserve pas dans
  un `Dictionary`.

### D10 — Images : `/image` + cache + chaîne de repli côté client, teinte calculée sur l'iPhone

- **Chargement.** Toute image passe par `NodeImageStore` (F.3) : lecture de `/image` pour une
  identité, URL validée par `URLValidation.publicHTTPSURL`, chargement qui valide chaque
  redirection, puis cache mémoire et coalescence des requêtes en vol.
- **Chaînes de repli.** Le héros suit les chaînes du Data contract (F.4). Les cartes de carrousel
  chargent leur pochette paresseusement, par `/image` de la cible.
- **Teinte.** La couleur dominante (étiquette du disque, glow teinté des fiches projet et titre) est
  calculée sur l'iPhone avec `CIAreaAverage`.
- **Images manquantes.** Les tuiles de genre de l'onboarding gardent le placeholder dégradé (spec
  1.2b : « placeholder until the asset pipeline exists »).
- **Rejeté : ajouter `cover_url` aux `EdgeRef` de l'API mobile.** C'est un changement serveur, il
  alourdit chaque fiche, et il est hors V1. Rejeté aussi : précalculer la teinte dans le pipeline
  (champ de schéma, tier/3), et ajouter un champ image aux genres et labels (tier/3, voir Q5).

### D11 — D2 maintenue face à la génération à la volée

- **Ce que dit le Figma.** Le Data contract (règle 7) et l'écran 1.6 prévoient de générer une
  fiche non matérialisée pendant l'écran de chargement.
- **Ce que fait la V1.** Elle reste en lecture seule. Une relation est toujours un lien. Si la
  fiche n'existe pas, la page poussée affiche l'état non dessiné « pas encore de fiche »
  (`Track1Status.nodeMissing`, B.2). Un résultat de recherche sans fiche est une ligne désactivée.
- **Rejeté : appeler `createGeneration`.** Il faudrait un suivi de génération, des quotas et des
  erreurs non dessinés, plus TRA-349, hors V1. Cela romprait aussi la garantie D2 vérifiée par
  `ContentReaders`.

### D12 — Écoute : Spotify et Apple Music avec repli de recherche, pas de YouTube Music, pas de barre pour genre et label

- **Services.** `/links` ne renvoie que `spotify` et `apple`, et seulement pour artist, project et
  track (`LINKABLE_TYPES`). La `StreamingBar` affiche donc Apple Music puis Spotify, à partir de
  `ListeningActions`, avec le lien exact ou à défaut le lien de recherche (comportement TRA-362
  conservé). YouTube Music n'est jamais affiché.
- **Genre et label.** Pas de barre, alors que le Figma en dessine une en 2.4 et 2.5.
- **Rejeté : masquer un service sans lien exact** (lecture littérale du Figma). On jetterait le
  repli de TRA-362, et une fiche dont le résolveur a échoué ne pourrait plus s'écouter. Rejeté
  aussi : ajouter YouTube Music à l'API mobile (changement serveur).

### D13 — Onboarding : taxonomie dérivée du catalogue, profil = parents et sous-genres, minimum 1

- Remplacée le 2026-10-15 par `docs/plans/ios-onboarding-taxonomy.md`.
- **Taxonomie.** Les tuiles 1.2 sont les genres du catalogue `/catalog` qui ont au moins une arête
  `subgenres` vers un genre du catalogue, et aucune arête `parent_genres` vers un genre du
  catalogue. Il y en a 31 sur le cache actuel. Les lignes 1.3 sont leurs `subgenres`, avec le
  `teaser` du catalogue (`editorial_definition`) comme description.
- **Profil.** `genreIDs` = parents sélectionnés ∪ sous-genres sélectionnés.
  `ProfileSelection.minimumGenres` passe de 3 à 1 (« ≥ 1 genre » du Figma). Les profils existants
  restent valides.
- **Écrans 1.5 et 1.6.** 1.5 est hors V1. 1.6 est l'état de chargement d'Aujourd'hui après
  l'onboarding, avec une expiration à 20 s.
- **Rejeté : servir la taxonomie depuis le serveur** (changement d'API hors V1). Rejeté aussi : une
  liste de parents codée en dur (périmée dès la prochaine matérialisation), et prendre tous les
  genres sans parent (157 tuiles, dont 126 sans sous-genre).

### D14 — Ce qui n'est pas dessiné est composé de composants dessinés, et validé au gate

- **Quoi.** Ce qui n'a pas de maquette : états d'erreur, vide, introuvable et expiration, écran de
  consentement, réglages, onglet Genres.
- **Comment.** Ces écrans sont *composés* de composants Figma existants : Ambient glow, Text,
  Button, ListItem et Genre tile, sans création visuelle. Chaque composition est décrite dans sa
  tâche (B.2, K.1, K.2). Le défaut est validé en répondant à Q3 et Q4.
- **Rejeté : bloquer les écrans dessinés en attendant ces maquettes.** Ils seraient bloqués
  inutilement, alors qu'ils doivent bien afficher leurs échecs. Rejeté aussi : garder l'UI système
  pour ces états, qui détonnerait dans un thème sombre unique.

### D15 — L'article et les sources restent sur la fiche (écart validé à la règle 9)

- **Décision de Raphael (gate du 2026-10-11).** Contre la règle 9 du Data contract (`179:7`), la
  fiche garde `editorial_article` et `citations`. `NodeArticleView` et `NodeArticleParser`
  (TRA-365) sont conservés, logique inchangée.
- **Placement.** Deux sections après la dernière section d'arêtes, avant la barre d'écoute :
  « article », puis « sources ». Elles réutilisent les composants dessinés :
  - `SectionHeader` (`171:62`) ;
  - texte `bodyLarge` en `colorTextPrimary` pour les paragraphes et les listes de l'article ;
  - une ligne `Track1ListItem` avec chevron (`22:26`) par source.

  Le rythme est celui des autres sections (`spacing24` entre sections, `spacing12` sous l'en-tête).
  Le premier écran dessiné (héros, titre, teaser, faits, premières sections) reste identique au
  Figma.
- **Parité.** Le test de parité (F.1) déclare `editorial_article` et `citations` comme seuls écarts
  tolérés à la règle 9. Tout autre champ de la règle 9 affiché le fait échouer.
- **Rejeté : suivre la règle 9**, refusé par Raphael. Rejeté aussi :
  - l'article sous le teaser : il repousserait les relations hors du premier écran et
    contredirait l'anatomie du Flow 2 ;
  - un écran « Lire l'article » séparé : une navigation non dessinée.

## Questions ouvertes du Figma

### Bloquantes : défaut validé au gate du 2026-10-11

| # | Question | Bloque | Recommandation par défaut |
| --- | --- | --- | --- |
| Q1 | Langue de la copie | J.2, B.2, E.2, F.2 | **Interface en français.** On traduit « Daily music explorations » en « Explorations musicales quotidiennes » et « Preparing your daily recommendation... » en « Préparation de ta recommandation du jour… ». Les **libellés de données** restent ceux du Data contract, en anglais minuscule comme le `KIND_LABEL` du web : sections, faits, `+N more`, `Founded`. Les libellés de données sont centralisés dans `NodePageSpec` et les messages d'état dans `Track1Status`, pour que la bascule coûte peu. |
| Q2 | Nom produit | J.2 | **« track1 »**, comme le Figma, le bundle et les cibles. « Odyssey » reste le nom du dépôt. |
| Q3 | Onglet Genres (3.3, non dessiné) | K.1 | **Grille des genres parents** du profil (Genre tile sélectionnée, en lecture seule). Bouton Primary « Modifier mes genres » : rouvre les étapes 1.2 → 1.4 en sheet, en mode édition, avec un dernier CTA « Enregistrer ». IconButton « More » (`ellipsis`) en haut à droite : ouvre les réglages en sheet. Toucher une tuile ne fait rien en V1. L'ordre de sélection n'a aucun effet sur la recommandation. |
| Q4 | États d'erreur, de vide et d'expiration (non dessinés) | B.2, donc H.1, H.2, I.2 et J.4 | **`Track1StatusView`** : Ambient glow, titre Title/3, message Body/Medium en `colorTextSecondary`, bouton Secondary Medium facultatif. Mêmes compositions pour le consentement et les réglages (K.2). Expiration du chargement 1.6 à **20 s**, puis « Réessayer ». |
| Q5 | Images de genre et de label absentes du schéma | F.4, D.1 | **Pas de changement de schéma.** Tuiles de genre en placeholder dégradé. Héros de genre : pochette de `landmark_projects[0]`, sinon celle de `landmark_tracks[0]`, sinon placeholder. Héros de label : pochette de `notable_releases[0]`, sinon placeholder. Pas de logo de label. |
| Q6 | Teinte du disque : calcul sur l'appareil ou dans le pipeline ? | F.4 | **Sur l'appareil.** `CIAreaAverage` sur la pochette réduite, mise en cache par identité. La même couleur teinte le glow des fiches projet et titre à la racine d'Aujourd'hui. |

### Non bloquantes pour la V1

| # | Question | Recommandation |
| --- | --- | --- |
| Q7 | Heure de la notification | Hors V1 (étape 1.5 exclue). Si 1.5 est réactivée avec TRA-346 : 9 h, heure locale, notification locale `UNUserNotificationCenter`, sans APNs. |
| Q8 | Préécoute à l'appui long | Hors V1 : c'est un bonus, sans source audio définie. |
| Q9 | Teasers coupés, faits rarement renseignés (7 sur 294 projets) | Qualité du pipeline, hors de ce plan. L'app affiche le teaser tel quel, sans troncature (règle du Teaser card). |

Réponses du gate du 2026-10-11 : Q1 à Q6 et D11 à D13 sont validées avec la recommandation par
défaut. La règle 9 n'est pas suivie pour l'article et les sources (D15).

## Data contract comparé à `src/node-spec.ts` et à l'API mobile

- **Champs.** Tous les champs du Data contract existent dans `src/types.ts` et
  `src/node-spec.ts`. L'API mobile les transmet déjà, sans changement serveur :
  - `NodeDetail.teaser` correspond à `TEASER_FIELD_BY_TYPE` ;
  - `NodeDetail.facts` correspond à `OPTIONAL_TEXT_FIELDS`, dont les champs de sous-titre (`year`,
    `release_type`, `duration`, `origin`, `active_years`, `era`, `founded`, `location`) et
    `cover_url` ou `photo_url` ;
  - `NodeDetail.edges` contient des `EdgeRef` avec `year` et `releaseType` ;
  - `NodeDetail.image_url` donne la photo de l'artiste ou la pochette du projet ou du titre.
- **Écarts internes au Figma, tranchés par l'ordre de vérité :**
  - `duration` d'un titre : le composant Fact row (`172:11`) le met dans les faits, le Data
    contract (`179:157`) dans le sous-titre. **Sous-titre seulement.**
  - Ordre des sections : la règle 2 dit « ordre du schéma », mais les écrans 2.1 et 2.3 dessinent
    un autre ordre. **Ordre du schéma** (D9).
- **Écart validé (D15).** L'article (`NodeDetail.article`) et les citations restent affichés, contre
  la règle 9.
- **Écarts avec l'API.** Genres et labels n'ont pas de champ image, et le logo de label n'existe
  pas (Q5). Les `EdgeRef` n'ont pas de pochette (D10). `/links` n'a pas YouTube Music (D12).
- **Repli du héros de genre.** « pochette du projet du titre repère » demanderait deux lectures
  (`/node` du titre, puis `/image` du projet). Le plan prend `/image` de `landmark_tracks[0]`, qui
  renvoie la pochette du titre ou de son projet. C'est un écart accepté, documenté en F.4.

## Découpage

### Règles communes à toutes les tâches

- **Branche et PR.** Partir de `origin/main`. 1 tâche = 1 branche = 1 PR, titre préfixé de l'ID du
  ticket. Le corps contient `Fixes TRA-<tâche>` et `Refs TRA-<parent>`, jamais `Fixes TRA-<parent>`.
  Au plus 3 PR iOS ouvertes.
- **Vérification.** Le Swift n'est vérifié que par `ios-check` : respecter `ios/.swift-format`
  (tabulations, 110 colonnes). Une tâche qui touche `test/` passe aussi `npm run check`.
- **Figma (obligatoire).**
  - Avant tout `get_design_context`, lire `skill://figma/figma-design-to-code/SKILL.md` avec
    `get_figma_skill`, puis passer `skillNames: "resource:figma-design-to-code"`.
  - Appeler `get_design_context` sur les node-ids de la tâche, et lire la carte Doc ou Spec citée.
  - Lire les valeurs avec `get_variable_defs`.
  - Ordre de vérité : Data contract > Spec et annotations > écran > composant > Foundations.
  - Le code renvoyé (React ou CSS) est une maquette : le traduire en SwiftUI natif (stacks,
    `Layout`), sans positions absolues.
  - Ne jamais ouvrir `28:2`, `57:458`, `56:340` ni `30:2`.
  - Ne télécharger que les assets listés par la tâche, et ne jamais laisser d'URL Figma temporaire
    dans le code.
- **Design system (D4bis).**
  - **Jetons et rôles uniquement** dans `Features/` et `App/`. Les seules valeurs brutes autorisées
    sont les dégradés d'art direction dans `DesignSystem/` (Ambient glow, Welcome backdrop,
    placeholders média) et les marques.
  - **Un composant Figma = une `View`.** Les propriétés deviennent des paramètres et les variantes
    des `enum`. L'état Pressed vient de `ButtonStyle.Configuration.isPressed`, l'état Disabled de
    l'environnement `isEnabled`.
  - **Données tierces** affichées par `Text(verbatim:)`. Aucune URL tierce n'est chargée ni ouverte
    sans `URLValidation`. Ouverture uniquement par l'OS. Jamais `WebKit` ni `SafariServices`
    (`test/ios-no-webview.test.ts`).
  - **Accessibilité.**
    - Cibles d'au moins 44 pt.
    - `accessibilityLabel` sur IconButton et Artwork.
    - Dynamic Type par `Track1TextRole`.
    - Toute animation passe par `Track1Motion`, qui renvoie `nil` sous Reduce Motion.
  - **Haptique** par `.sensoryFeedback` (iOS 17) :
    - `.impact(weight: .light)` sur les CTA de bas d'écran et les boutons d'écoute ;
    - `.selection` sur les sélections et les changements d'onglet.
  - **Verre** : `.glassEffect` sous `if #available(iOS 26, *)`, repli `.ultraThinMaterial` (D8).
- **Analytics.** Uniquement les noms existants d'`AnalyticsEventName`, par un `NodeEventRecorder`
  soumis au consentement. Aucun nouvel événement, aucune saisie dans les propriétés.
- **Tests.**
  - XCTest sur les fonctions pures et les view models, avec les vrais types du projet. Seuls le
    réseau et l'OS sont substitués.
  - XCUITest seulement en H.2, I.2 et J.4, plus l'adaptation des fichiers existants en G.1 et K.1.
  - Captures D7 dans chaque XCUITest qui montre un écran dessiné.
  - Si l'interface d'un composant diffère de son contrat, l'écrire dans la PR.
- **Taille.** Cible sous 400 lignes, ajouts et suppressions, tests et pbxproj compris. Le gate CI
  est à 600 lignes ou 20 fichiers. Une tâche tier/3 ne dépasse pas 200 lignes.
- **pbxproj (D5).**
  - Format des IDs : préfixe (`B1` build file, `F1` file reference, `A3` groupe) + 18 zéros + 4
    caractères hexadécimaux pris dans la plage de la tâche.
  - Phases : app `A20000000000000000000004`, tests `…0006`, tests UI `…0007`, Resources
    `A20000000000000000000005`.
  - Groupes existants : `A3…0002` Track1, `A3…0003` App, `A3…0004` DesignSystem, `A3…0005`
    Resources, `A3…0013` Features, `A3…0014` Privacy, `A3…0016` Profile, `A3…0017` Persistence,
    `A3…0018` Onboarding, `A3…0019` Settings, `A3…0021` Features/Node, `A3…0022` Navigation,
    `A3…0006` Track1Tests, `A3…0020` Track1Tests/Profile, `A3…0023` Track1Tests/Node, `A3…0007`
    Track1UITests.
  - Le groupe `DesignSystem/Components` et ses 4 sous-groupes `Core`, `Navigation`, `Onboarding`
    et `Node` sont créés **par B.1 seule**. `Track1Tests/DesignSystem` est créé par A.1.
  - Les conflits sur les lignes uniques de groupe ou de phase se résolvent par insertion, jamais par
    renumérotation. Vérifier qu'aucun ID n'apparaît deux fois.
  - **Plage `03F0–03FF` consommée** par l'intégration du package `Track1Core` (TRA-422, #344). Ne
    pas la réattribuer. Les IDs ont **24 caractères** : préfixe + 18 zéros + 4 caractères
    hexadécimaux.
  - **Hors pbxproj.** Tout nouveau fichier sans SwiftUI va dans
    `ios/Track1Core/Sources/Track1Core/…`, avec son test dans
    `ios/Track1Core/Tests/Track1CoreTests/…`, sans entrée pbxproj. Seuls les fichiers qui importent
    SwiftUI, Segment ou lisent `Bundle.main` consomment encore une plage. Voir
    `docs/track1-builds.md`.

### Vue d'ensemble

Parents : **DS** = TRA-381 « Construire le design system Nocturne en SwiftUI » ;
**ONB** = TRA-382 « Choisir ses genres avec l'onboarding Figma » ; TRA-347 réécrit (D9).
Estimation en points : 1 (moins de 250 lignes), 2 (250 à 340), 3 (plus de 340).

| Tâche | Ticket | Titre | Parent | Tier | Est. | Diff | Dépend de | Plage | Vague |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | TRA-368, TRA-364, TRA-379, TRA-376 | Merger #330, #331 ; TRA-379, TRA-376 | (existants) | 2 | — | — | — | — | 0 |
| A.1 | TRA-383 | Jetons Nocturne et thème sombre | TRA-381 (DS) | 2 | 2 | ~300 | — | 0200–020F | 1 |
| A.2 | TRA-384 | Polices, rôles typographiques et icône d'app | TRA-381 (DS) | 2 | 2 | ~310 + binaires | A.1 | 0210–021F | 2 |
| B.1 | TRA-385 | Composants Core : Text, Button, IconButton, Icon | TRA-381 (DS) | 2 | 3 | ~380 | A.2 | 0220–022F | 3 |
| B.2 | TRA-386 | États non dessinés : `Track1Status` | TRA-381 (DS) | 2 | 1 | ~220 | B.1 | 0230–023F | 4 |
| C.1 | TRA-387 | Ambient glow et Top bar | TRA-381 (DS) | 2 | 2 | ~340 | B.1 | 0240–024F | 4 |
| C.2 | TRA-388 | ListItem, Artwork, SearchField | TRA-381 (DS) | 2 | 3 | ~350 | B.1 | 0250–025F | 4 |
| D.1 | TRA-389 | Genre tile, Subgenre row, Select-all chip, Bottom action bar | TRA-381 (DS) | 2 | 3 | ~380 | B.1 | 0260–026F | 4 |
| D.2 | TRA-390 | Progress bar et Welcome backdrop | TRA-381 (DS) | 2 | 2 | ~260 | B.1 | 0270–027F | 4 |
| E.1 | TRA-391 | Teaser card, Section header, Fact row, Track row | TRA-381 (DS) | 2 | 2 | ~300 | B.1 | 0280–028F | 4 |
| E.2 | TRA-392 | Edge chip, Overflow et disposition en flux | TRA-381 (DS) | 2 | 2 | ~300 | B.1 | 0290–029F | 4 |
| E.3 | TRA-393 | Hero et Release card | TRA-381 (DS) | 2 | 3 | ~380 | C.2 | 02A0–02AF | 5 |
| E.4 | TRA-394 | Streaming button et Streaming bar | TRA-381 (DS) | 2 | 2 | ~280 | B.1 | 02B0–02BF | 4 |
| F.1 | TRA-395 | Sections de fiche selon le Data contract + parité vitest | TRA-347 | 2 | 2 | ~340 | — | 02C0–02CF | 1 |
| F.2 | TRA-396 | En-tête de fiche : sous-titre, teaser, faits | TRA-347 | 2 | 2 | ~260 | F.1 | 02D0–02DF | 2 |
| F.3 | TRA-367 (amendé) | Charger les images sans redirection non sûre | TRA-341 | 2 | 3 | ~360 | — | 02E0–02EF | 1 |
| F.4 | TRA-397 | Sources du héros et couleur dominante | TRA-347 | 2 | 2 | ~330 | F.3 | 02F0–02FF | 2 |
| G.1 | TRA-398 | Onglets Aujourd'hui / Genres / Recherche, sheet et fil d'Ariane | TRA-341 | 2 | 3 | ~380 | B.1, C.1 | 0300–030F | 5 |
| H.1 | TRA-399 | Page de fiche Figma | TRA-347 | 2 | 3 | ~380 | TRA-376, TRA-368, B.2, C.1, E.1–E.4, F.2, F.4, G.1 | 0310–031F | 6 |
| H.2 | TRA-373 (amendé) | Aujourd'hui affiche la fiche du jour | TRA-343 | 2 | 3 | ~380 | H.1, D.2, TRA-379 | 0320–032F | 7 |
| H.3 | TRA-400 | Article et sources en sections Nocturne (D15) | TRA-341 | 2 | 2 | ~260 | H.1, E.1, C.2 | 03E0–03EF | 7 |
| I.1 | TRA-401 | Fiches récentes et temporisation de 150 ms | TRA-348 | 2 | 2 | ~300 | TRA-364 | 0330–033F | 2 |
| I.2 | TRA-372 (amendé) | Sheet de recherche | TRA-348 | 2 | 3 | ~380 | I.1, C.2, H.1 | 0340–034F | 7 |
| J.1 | TRA-402 | Taxonomie et modèle du parcours d'onboarding | TRA-382 (ONB) | 2 | 3 | ~380 | — | 0350–035F | 1 |
| J.2 | TRA-403 | Écrans 1.1 Welcome et 1.2 Genres | TRA-382 (ONB) | 2 | 2 | ~330 | J.1, C.1, D.1, D.2 | 0360–036F | 5 |
| J.3 | TRA-404 | Écrans 1.3 et 1.4 Sous-genres | TRA-382 (ONB) | 2 | 2 | ~340 | J.2 | 0370–037F | 6 |
| J.4 | TRA-405 | Brancher l'onboarding au lancement et l'enchaîner sur Aujourd'hui | TRA-382 (ONB) | 2 | 3 | ~380 | J.3, H.2 | 0380–038F | 8 |
| K.1 | TRA-406 | Onglet Genres (composition par défaut, Q3) | TRA-382 (ONB) | 2 | 3 | ~350 | J.3, G.1 | 0390–039F | 7 |
| K.2 | TRA-407 | Habiller le consentement et les réglages | TRA-381 (DS) | 2 | 2 | ~260 | B.2, C.1, C.2 | 03A0–03AF | 5 |
| L.1 | TRA-408 | Supprimer les anciennes vues de relations et d'écoute | TRA-381 (DS) | 2 | 1 | ~−400 | H.1 | 03B0–03BF | 7 |
| L.2 | TRA-409 | Supprimer l'ancien onboarding et `Track1Theme`, verrouiller les jetons | TRA-381 (DS) | 2 | 2 | ~−300 / +80 | J.4, K.1, K.2, I.2, H.3 | 03D0–03DF | 9 |
| L.3 | TRA-374 (amendé) | Installer la V1 Figma sur l'iPhone et consigner la preuve | TRA-337 | 3 | 2 | ~140 | toutes | — | 10 |

**Chemin critique** : A.1 → A.2 → B.1 → C.2 → E.3 → H.1 → H.2 → J.4 → L.2 → L.3.

**Ordre recommandé** (3 PR iOS au plus) :
1. Vider la vague 0 : #330 et #331, puis TRA-379 et TRA-376.
2. Lancer en parallèle A.1, F.1, F.3 et J.1 : logique pure, sans fichier commun hors pbxproj.
3. Faire passer la Partie A, puis B.1, en priorité : elles débloquent presque toutes les tâches d'interface.

**Conflits attendus.** Ce sont des insertions mécaniques ; celui qui merge en second rebase.
- Les composants d'un même sous-groupe pbxproj (lignes uniques).
- `RootView.swift` : G.1, H.1, H.2, I.2, J.4, K.1.
- `NodeView.swift` : TRA-376, H.1, I.2.
- `NodePageView.swift` : H.1, H.3.
- `AppContainer.swift` : F.3, H.2, I.1.
- `Info.plist` : A.1, A.2.

### Partie 0 — Finir le socle V1 en cours

Tickets existants, gardés tels quels :
- TRA-368 (PR #330) ;
- TRA-364 (PR #331) ;
- TRA-379, après TRA-371 mergé ;
- TRA-376.

Aucun ne change de contrat. Ils occupent les 3 créneaux de PR jusqu'à leur merge. La Partie A et
F.1, F.3 et J.1 démarrent dès qu'un créneau se libère.

### Partie A — Fondations Nocturne

Incrément visible : l'application passe en sombre, avec la teinte d'action Nocturne.

#### A.1 — Jetons Nocturne et thème sombre

- **Parent :** DS · **Tier :** tier/2 · **Diff :** ~300 lignes, 5 fichiers · **Dépend de :** — ·
  **Parallélisable :** oui · **pbxproj :** `0200–020F` (crée `Track1Tests/DesignSystem`).
- **Figma :** Foundations `4:3`, avec `180:2` (en-tête), `180:6` (couleurs sémantiques), `180:479`
  (espacements, rayons, tailles) et `180:581` (effets, mouvement). Valeurs par `get_variable_defs`
  sur ces cadres (exemple : `171:96` donne `theme.color.node.artist = #5d7fa8`). Les primitives
  `180:268` ne sont pas codées.
- **Portée :**
  - `ios/Track1/DesignSystem/Track1Tokens.swift` (nouveau, groupe `A3…0004`).
  - `ios/Track1/Resources/Info.plist` : `UIUserInterfaceStyle = Dark`.
  - `ios/Track1/App/Track1App.swift` : `.tint(Track1Tokens.colorTextAction)` à la racine.
  - `ios/Track1Tests/DesignSystem/Track1TokensTests.swift` (nouveau).
  - pbxproj.
- **Contrat :**
  - `enum Track1Tokens` avec des constantes `static let`.
  - **47 couleurs `Color`** (sRGB, alpha compris) : background ×3, surface ×3, text ×7, icon ×5,
    border ×4, action ×7, status ×4, overlay ×1, glass ×3, node ×5, selection ×3, progress ×2.
  - **Espacements** `spacing0` à `spacing64` (14 valeurs, `CGFloat`) ; **rayons** `radius0`,
    `radius8`, `radius12`, `radius16`, `radius20`, `radiusFull` ; **11 tailles** `size*`
    (`sizeControlMedium` = 44, `sizeControlLarge` = 52, artwork 48/64/96, etc.).
  - `static func colorNode(_ type: NodeType) -> Color`.
  - `enum Track1Motion { case fast, standard, slow }` (120, 200 et 350 ms), avec deux courbes :
    `standard` = cubic-bezier(0.2, 0, 0, 1) et `emphasized` = (0.2, 0, 0, 1.2).
  - `static func animation(_: Track1Motion, emphasized: Bool = false, reduceMotion: Bool) -> Animation?`
    renvoie `nil` si `reduceMotion`.
  - `Track1Theme` reste en place (supprimé en L.2).
- **Critères d'acceptation :**
  - [ ] `colorTextPrimary` = `#F6E9D8`, `colorBackgroundElevated` = `#1A110E`,
    `colorBorderDefault` = `#443027`, et les 5 couleurs `node` (`#5D7FA8`, `#E6A23A`, `#F0642D`,
    `#8DA66B`, `#C8B6A3`) égalent le Figma au 1/255 près.
  - [ ] Les 47 couleurs, 14 espacements, 6 rayons et 11 tailles existent et correspondent aux
    variables Figma. Le test énumère chaque nom et chaque valeur lus par `get_variable_defs`.
  - [ ] `Track1Motion.animation(…, reduceMotion: true)` renvoie `nil`, et sinon les durées 0,12,
    0,2 et 0,35 s.
  - [ ] `Bundle.main.object(forInfoDictionaryKey: "UIUserInterfaceStyle")` vaut `"Dark"` dans l'app
    de test. `ConsentTests` et `NavigationTests` restent verts.
- **Tests attendus :** `Track1TokensTests` (XCTest).

#### A.2 — Polices, rôles typographiques et icône d'app

- **Parent :** DS · **Tier :** tier/2 · **Diff :** ~310 lignes + 6 TTF et 1 PNG, 16 fichiers ·
  **Dépend de :** A.1 (`Info.plist`, groupe DesignSystem) · **Parallélisable :** non, avec A.1 ·
  **pbxproj :** `0210–021F` (crée le groupe `Resources/Fonts`).
- **Figma :** Typographie `180:376` (20 styles, `180:379` à `180:474`) ; Text `170:38` (doc
  `170:39`, rôles `11:33`) ; icône d'app `174:41` (section `174:87`).
- **Portée :**
  - `ios/Track1/Resources/Fonts/` : `JetBrainsMono-Regular.ttf`, `JetBrainsMono-Medium.ttf`,
    `JetBrainsMono-Bold.ttf`, `Roboto-Regular.ttf`, `Roboto-SemiBold.ttf`,
    `RobotoCondensed-Medium.ttf`, `OFL-JetBrainsMono.txt`, `OFL-Roboto.txt`, et `README.md`
    (hors pbxproj) qui consigne la version, l'URL source et le SHA-256 de chaque fichier.
  - Sources des polices :
    - JetBrains Mono : release GitHub officielle `JetBrains/JetBrainsMono`, TTF statiques ;
    - Roboto et Roboto Condensed : distribution Google Fonts, fichiers `static/`.
    - Licence : OFL 1.1, livrée avec chaque archive.
    - Si le téléchargement est impossible depuis l'environnement, la tâche s'arrête et le signale.
      On ne substitue jamais une autre police.
  - `ios/Track1/Resources/Info.plist` : `UIAppFonts` (6 entrées).
  - `ios/Track1/DesignSystem/Track1Typography.swift` (nouveau).
  - `ios/Track1/Resources/Assets.xcassets/AppIcon.appiconset/` : `AppIcon-1024.png` (export du
    nœud `174:41` en 1024 × 1024, opaque, sans alpha) et `Contents.json` (taille unique iOS).
  - `ios/Track1Tests/DesignSystem/Track1TypographyTests.swift` (nouveau).
  - pbxproj : polices et OFL dans la phase Resources `A2…0005`.
- **Contrat :**
  - `enum Track1FontFace: String, CaseIterable` dont la valeur brute est le nom PostScript.
  - `enum Track1TextRole: CaseIterable` à 20 cas : `displayHero`, `display`, `title1`, `title2`,
    `title3`, `headline`, `bodyLarge`, `bodyMedium`, `bodySmall`, `labelLarge`, `labelMedium`,
    `labelSmall`, `labelTab`, `eyebrow`, `caption`, `monoSection`, `monoItem`, `monoTag`,
    `monoLabel`, `monoMicro`. Chacun porte `face`, `size`, `lineHeight` et `textStyle`, selon le
    tableau ci-dessous.
  - Taille × interligne et style de référence pour Dynamic Type :

    | Rôle | Police | Taille / interligne | Style |
    | --- | --- | --- | --- |
    | displayHero | JetBrains Mono Bold | 56/64 | `.largeTitle` |
    | display | JetBrains Mono Bold | 34/41 | `.largeTitle` |
    | title1 | JetBrains Mono Bold | 28/34 | `.title` |
    | title2 | JetBrains Mono Bold | 22/28 | `.title2` |
    | title3 | JetBrains Mono Bold | 20/25 | `.title3` |
    | headline | JetBrains Mono Bold | 18/24 | `.headline` |
    | monoSection | JetBrains Mono Bold | 15/20 | `.subheadline` |
    | monoItem | JetBrains Mono Regular | 18/22 | `.body` |
    | monoTag | JetBrains Mono Regular | 13/16 | `.footnote` |
    | monoLabel | JetBrains Mono Regular | 12/16 | `.caption` |
    | monoMicro | JetBrains Mono Medium | 11/14 | `.caption2` |
    | bodyLarge | Roboto Regular | 17/25 | `.body` |
    | bodyMedium | Roboto Regular | 15/22 | `.subheadline` |
    | bodySmall | Roboto Regular | 13/18 | `.footnote` |
    | labelLarge | Roboto SemiBold | 17/22 | `.headline` |
    | labelMedium | Roboto SemiBold | 15/20 | `.subheadline` |
    | labelSmall | Roboto SemiBold | 13/16 | `.footnote` |
    | labelTab | Roboto SemiBold | 10/12 | `.caption2` |
    | eyebrow | Roboto Condensed Medium | 16/20 | `.callout` |
    | caption | Roboto Regular | 12/16 | `.caption` |

  - `var font: Font` = `Font.custom(face.rawValue, size:, relativeTo:)`.
  - `extension View { func track1Text(_ role: Track1TextRole) -> some View }` applique la police
    et l'interligne. L'interligne est `lineHeight − UIFont.lineHeight`, mis à l'échelle par
    `UIFontMetrics(forTextStyle:)`.
- **Critères d'acceptation :**
  - [ ] Les 6 `Track1FontFace` se chargent dans l'app de test (`UIFont(name:size:) != nil`).
  - [ ] Chaque rôle a la police, la taille et l'interligne du tableau.
  - [ ] En catégorie `accessibilityExtraExtraExtraLarge`, la taille mise à l'échelle de `bodyLarge`
    dépasse 17.
  - [ ] Le README liste 6 SHA-256 qui correspondent aux fichiers commités, et la PR n'ajoute aucune
    autre police.
- **Tests attendus :** `Track1TypographyTests` (XCTest) et `test/ios-fonts.test.ts` (vitest, nouveau :
  recalcule le SHA-256 de chaque `.ttf` de `ios/Track1/Resources/Fonts/` et le compare au README ;
  `npm run check`).

### Partie B — Composants Core et états non dessinés

Incrément : bibliothèque utilisable, aucun écran ne change.

#### B.1 — Composants Core : Text, Button, IconButton, Icon

- **Parent :** DS · **Tier :** tier/2 · **Diff :** ~380 lignes, 7 fichiers · **Dépend de :** A.2 ·
  **Parallélisable :** non (elle crée les groupes de composants) · **pbxproj :** `0220–022F` (crée
  `DesignSystem/Components` et ses 4 sous-groupes `Core`, `Navigation`, `Onboarding`, `Node`).
- **Figma :** page `4:5`, sections Text `170:38` (`11:33`), Button `170:54` (doc `170:55`,
  ensemble `16:20`), IconButton `170:67` (doc `170:68`, `14:58`) et Icon `170:77` (doc `170:78`,
  `14:2`).
- **Portée :**
  - Dans `ios/Track1/DesignSystem/Components/Core/` : `Track1Text.swift`, `Track1Button.swift`,
    `Track1IconButton.swift`, `Track1Icon.swift`.
  - Dans `ios/Track1Tests/DesignSystem/` : `Track1ButtonTests.swift`, `Track1IconTests.swift`.
  - pbxproj.
- **Contrat :**
  - `struct Track1Text: View { init(_ content: String, role: Track1TextRole, verbatim: Bool = false) }`.
  - `enum Track1ButtonKind { case primary, secondary, ghost }` et
    `enum Track1ControlSize { case medium, large }` (44 / 52 pt).
  - `enum Track1ControlState { case normal, pressed, disabled }`.
  - `struct Track1Button: View { init(_ title: String, kind:, size:, icon: Track1Icon.Glyph? = nil, haptic: Bool = false, action:) }` :
    capsule `radiusFull`, libellé `labelLarge`, Primary « bone » (`colorActionPrimary`, libellé
    `colorTextInverse`).
  - `struct Track1IconButton: View { init(_ glyph:, accessibilityLabel: String, kind:, size:, action:) }`.
  - `struct Track1Icon: View` avec deux enums :
    - `Glyph` : `check`, `chevronDown`, `chevronRight`, `close`, `home`, `more`, `musicNote`,
      `play`, `search` ;
    - `Tone` : `primary`, `secondary`, `inverse`.
  - Correspondance SF Symbols : `checkmark`, `chevron.down`, `chevron.right`, `xmark`, `house`,
    `ellipsis`, `music.note`, `play.fill`, `magnifyingglass`. Cadre de 20 pt.
  - Fonction pure `Track1ButtonColors.resolve(kind:state:) -> (fill: Color, label: Color, border: Color?)`
    qui suit le Figma.
- **Critères d'acceptation :**
  - [ ] Les 9 combinaisons style × état de `Track1ButtonColors.resolve` correspondent aux variantes
    `15:9` à `15:77`.
  - [ ] Les hauteurs valent 44 et 52 pt, et l'IconButton respecte une cible de 44 × 44 pt minimum.
  - [ ] Chaque `Glyph` donne exactement son SF Symbol, et chaque `Tone` sa couleur `colorIcon*`.
- **Tests attendus :** `Track1ButtonTests` et `Track1IconTests` (XCTest).

#### B.2 — États non dessinés : `Track1Status`

- **Parent :** DS · **Tier :** tier/2 · **Diff :** ~220 lignes, 3 fichiers · **Dépend de :** B.1,
  et Q1 et Q4 validées · **Parallélisable :** oui · **pbxproj :** `0230–023F`.
- **Figma :** aucun écran. Composition (D14) de Text `11:33` (Title/3, Body/Medium), Button `16:20`
  (Secondary Medium) et Ambient glow `173:42`. Expiration : Spec 1.6 `176:338`. Questions ouvertes
  `181:27`.
- **Portée :**
  - `ios/Track1/DesignSystem/Components/Core/Track1StatusView.swift`.
  - `ios/Track1Tests/DesignSystem/Track1StatusTests.swift`.
  - pbxproj.
- **Contrat :**
  - `enum Track1Status { case nodeMissing, nodeFailed, todayEmpty, todayUnavailable, searchFailed, loadingTimeout }`.
  - `var content: StatusContent`, avec
    `struct StatusContent: Equatable { title: String; message: String?; actionTitle: String?; identifier: String; actionIdentifier: String? }`.
  - `struct Track1StatusView: View { init(_ status: Track1Status, action: (() -> Void)?) }`.
  - Mise en page : colonne centrée, marges `spacing24`, titre `title3`, message `bodyMedium`
    `colorTextSecondary`, bouton Secondary Medium.
  - Copie française par défaut (Q1) :

    | Cas | Titre | Message | Bouton | Identifiants |
    | --- | --- | --- | --- | --- |
    | `nodeMissing` | « Pas encore de fiche » | « Cette page n'existe pas encore dans track1. » | — | `node-missing` |
    | `nodeFailed` | « Fiche indisponible » | — | « Réessayer » | `node-failed`, `node-retry` |
    | `todayEmpty` | « Aucune découverte pour ces goûts » | — | « Modifier mes genres » | `today-empty`, `today-edit-genres` |
    | `todayUnavailable` | « Découverte indisponible » | — | « Réessayer » | `today-unavailable`, `today-retry` |
    | `searchFailed` | « Recherche indisponible » | — | « Réessayer » | `search-failed`, `search-retry` |
    | `loadingTimeout` | « Ça prend plus de temps que prévu » | — | « Réessayer » | `loading-timeout`, `loading-retry` |

- **Critères d'acceptation :**
  - [ ] Chaque cas renvoie exactement le titre, le bouton et les identifiants du tableau.
  - [ ] `nodeMissing` n'a aucune action. Les autres en ont une.
  - [ ] Les identifiants `node-missing`, `node-failed` et `node-retry` sont ceux déjà lus par les
    tests V1.
- **Tests attendus :** `Track1StatusTests` (XCTest, table de cas).

### Partie C — Composants Navigation & système

#### C.1 — Ambient glow et Top bar

- **Parent :** DS · **Tier :** tier/2 · **Diff :** ~340 lignes, 5 fichiers · **Dépend de :** B.1 ·
  **Parallélisable :** oui · **pbxproj :** `0240–024F`.
- **Figma :**
  - Top bar : section `173:19`, doc `173:20`, ensemble `173:18` avec les variantes Date `173:14`
    et Breadcrumb `173:16`.
  - Ambient glow : section `173:43`, doc `173:44`, ensemble `173:42` avec les tons Ember `173:30`
    et Silver `173:36`.
  - Effets : `180:583`.
- **Portée :**
  - `ios/Track1/DesignSystem/Components/Navigation/AmbientGlow.swift` et `TopBar.swift`.
  - `ios/Track1Tests/DesignSystem/NavigationComponentsTests.swift`.
  - pbxproj.
- **Contrat :**
  - `struct AmbientGlow: View { enum Tone: Equatable { case ember, silver, tinted(Color) }; init(tone:, height: CGFloat = 280) }`.
  - Rendu : 3 dégradés radiaux, fondu vers `colorBackgroundBase` et grain à 10 %. Le grain est une
    texture de bruit générée une fois et mise en cache.
  - `tinted` dérive ses 3 couleurs de la teinte selon trois couples luminosité / opacité, fixés dans
    `AmbientGlowPalette`.
  - Rendu statique : la dérive « Turrell » est un bonus, hors V1.
  - `enum AmbientGlowPalette { static func stops(for: AmbientGlow.Tone) -> [Color] }`.
  - `struct TopBarCrumb: Hashable { let index: Int; let title: String }`, où l'index −1 désigne la
    racine.
  - `struct TopBar: View { enum Content { case date(Date), breadcrumb([TopBarCrumb]) }; init(_ content:, onSelect: (TopBarCrumb) -> Void) }`.
    La barre défile avec le contenu.
  - `enum TopBarFormat` :
    - `static func date(_: Date, timeZone: TimeZone) -> String` : modèle `dMMMM`, locale `fr_FR`
      (« 13 octobre ») ;
    - `static func collapsed(_: [TopBarCrumb]) -> [TopBarItem]`, avec
      `enum TopBarItem { case crumb(TopBarCrumb), ellipsis }`. Il garde les 3 derniers crumbs et
      replie les précédents en « … ». Le séparateur est « › ».
  - Identifiants : `top-bar-date`, `top-bar-breadcrumb`, `top-bar-crumb-<index>`.
- **Critères d'acceptation :**
  - [ ] `date(2026-10-13T08:00Z, Europe/Paris)` donne « 13 octobre ».
    `date(2026-10-31T23:30Z, Europe/Paris)` donne « 1 novembre ».
  - [ ] 5 crumbs donnent `[ellipsis, c2, c3, c4]`. 3 crumbs restent inchangés.
  - [ ] `stops(.ember) ≠ stops(.silver)`. `stops(.tinted(c))` est déterministe pour une couleur
    donnée.
- **Tests attendus :** `NavigationComponentsTests` (XCTest).

#### C.2 — ListItem, Artwork, SearchField

- **Parent :** DS · **Tier :** tier/2 · **Diff :** ~350 lignes, 6 fichiers · **Dépend de :** B.1 ·
  **Parallélisable :** oui · **pbxproj :** `0250–025F`.
- **Figma :**
  - SearchField : section `174:180`, doc `174:181`, ensemble `30:21` (`30:11`, `30:16`).
  - ListItem : section `174:191`, doc `174:192`, ensemble `22:142`.
  - Artwork : section `174:202`, doc `174:203`, ensemble `18:2`.
- **Portée :**
  - Dans `ios/Track1/DesignSystem/Components/Navigation/` : `Track1ListItem.swift`,
    `Track1Artwork.swift`, `Track1SearchField.swift`.
  - `ios/Track1Tests/DesignSystem/ListComponentsTests.swift`.
  - pbxproj.
- **Contrat :**
  - `struct Track1Artwork: View` avec `enum Size { small, medium, large }` (48, 64, 96),
    `enum Shape { square, circle }` et `enum State: Equatable { case loading, image(UIImage), unavailable }`.
    Init : `init(state:, size:, shape:, fallback: Track1Icon.Glyph, accessibilityLabel: String)`.
    L'image est fournie par l'appelant ; aucun chargement réseau ici.
  - `struct Track1ListItem: View { enum Accessory { none, chevron }; init(title:, subtitle: String?, artwork: Track1Artwork?, accessory:, action:) }`.
    Toute la ligne est la cible. Disabled vient de l'environnement.
  - `struct Track1SearchField: View { init(text: Binding<String>, focus: FocusState<Bool>.Binding, onSubmit: () -> Void) }`.
    Placeholder « Rechercher un artiste ou une œuvre », glyphe `search` en tête, bouton d'effacement
    visible seulement si le texte n'est pas vide (`static func showsClear(_ text: String) -> Bool`).
    Identifiants `search-field` et `search-clear`.
- **Critères d'acceptation :**
  - [ ] Les tailles d'Artwork valent 48, 64 et 96 pt. `unavailable` affiche le glyphe de repli, et
    `accessibilityLabel` est toujours posé.
  - [ ] `showsClear("")` est faux, et `showsClear("a")` vrai.
  - [ ] Les couleurs de ListItem Default, Pressed et Disabled suivent `22:2`, `22:10` et `22:18`.
- **Tests attendus :** `ListComponentsTests` (XCTest).

### Partie D — Composants Onboarding

#### D.1 — Genre tile, Subgenre row, Select-all chip, Bottom action bar

- **Parent :** DS · **Tier :** tier/2 · **Diff :** ~380 lignes, 7 fichiers · **Dépend de :** B.1 ·
  **Parallélisable :** oui · **pbxproj :** `0260–026F`.
- **Figma :**
  - Genre tile : section `175:7`, doc `175:8`, ensemble `175:6`.
  - Subgenre row : section `175:28`, doc `175:29`, ensemble `175:27`.
  - Select-all chip : section `175:48`, doc `175:49`, ensemble `175:47`.
  - Bottom action bar : section `173:138`, doc `173:139`, ensemble `173:137` (`173:123`,
    `173:130`).
- **Portée :**
  - Dans `ios/Track1/DesignSystem/Components/Onboarding/` : `GenreTile.swift`, `SubgenreRow.swift`,
    `SelectAllChip.swift`.
  - `ios/Track1/DesignSystem/Components/Navigation/BottomActionBar.swift`.
  - `ios/Track1Tests/DesignSystem/OnboardingComponentsTests.swift`.
  - pbxproj.
- **Contrat :**
  - **GenreTile.** `struct GenreTile: View { init(name: String, isSelected: Bool, artwork: Track1Artwork.State?, action:) }`.
    - Rapport 164:176. `nil` donne le placeholder dégradé (Q5).
    - Sélection : bordure intérieure de 3 pt `colorSelectionBorder`, surface `colorSelectionSurface`
      à 90 %, contenu `colorSelectionContent`.
    - Haptique `.selection`.
  - **SubgenreRow.** `struct SubgenreRow: View { init(name:, description: String?, isSelected:, action:) }`.
    Description sur 2 lignes au plus.
  - **SelectAllChip.** `struct SelectAllChip: View { init(isSelected:, action:) }` : « Tous » avec le
    glyphe `chevronDown`.
  - **BottomActionBar.** `struct BottomActionBar: View { init(title: String, isEnabled: Bool, counter: String?, action:) }`.
    - Bouton Primary Large et haptique `.impact(weight: .light)`.
    - Fondu au-dessus, barre fixe.
  - Libellé du compteur :
    `enum OnboardingCopy { static func counter(_ n: Int) -> String }`, avec singulier français pour
    0 et 1 (« Total : 1 genre », « Total : 2 genres »).
  - Identifiants : `genre-tile-<identity>`, `subgenre-row-<identity>`, `select-all`,
    `bottom-action`, `bottom-counter`.
  - Les préécoutes à l'appui long sont hors V1.
- **Critères d'acceptation :**
  - [ ] `counter(0)` donne « Total : 0 genre », `counter(1)` « Total : 1 genre », `counter(34)`
    « Total : 34 genres ».
  - [ ] La résolution de style de GenreTile et SubgenreRow sélectionnées donne les jetons
    `colorSelection*`, et les états par défaut les jetons de surface. L'état désactivé du
    BottomActionBar est vérifié par l'XCUITest de J.4.
- **Tests attendus :** `OnboardingComponentsTests` (XCTest).

#### D.2 — Progress bar et Welcome backdrop

- **Parent :** DS · **Tier :** tier/2 · **Diff :** ~260 lignes, 4 fichiers · **Dépend de :** B.1 ·
  **Parallélisable :** oui · **pbxproj :** `0270–027F`.
- **Figma :** Progress bar : section `175:58`, doc `175:59`, `175:56`. Welcome backdrop : section
  `175:67`, doc `175:68`, `175:66`. Motion 1.1 : spec `176:69`.
- **Portée :**
  - Dans `ios/Track1/DesignSystem/Components/Onboarding/` : `Track1ProgressBar.swift`,
    `WelcomeBackdrop.swift`.
  - `ios/Track1Tests/DesignSystem/BackdropTests.swift`.
  - pbxproj.
- **Contrat :**
  - `struct Track1ProgressBar: View { enum Mode: Equatable { case indeterminate, determinate(Double) } }`.
    - Balayage en boucle de 1,2 s. Les changements de largeur s'animent en 200 ms (standard).
    - Valeur bornée à 0…1.
    - Sous Reduce Motion : barre partielle statique.
  - `struct WelcomeBackdrop: View` : `TimelineView` qui fait morpher le dégradé ambre → rose →
    violet, en boucle de 45 s. Sous Reduce Motion, il est figé sur la frame Figma.
  - `enum WelcomeBackdropPalette` avec deux fonctions :
    - `static func colors(at phase: Double) -> [Color]`, continue, `phase` dans 0…1 ;
    - `static let overlayOpacity: Double` : voile qui garantit un contraste de 4,5:1 pour
      `colorTextPrimary`.
- **Critères d'acceptation :**
  - [ ] `colors(at: 0) == colors(at: 1)` : boucle sans coupure.
  - [ ] Le contraste de `colorTextPrimary` sur la couleur la plus claire de la palette, voile
    compris, est d'au moins 4,5. Le test calcule la luminance relative WCAG.
  - [ ] `determinate(1.4)` est borné à 1, et `determinate(-1)` à 0.
- **Tests attendus :** `BackdropTests` (XCTest).

### Partie E — Composants de fiche

#### E.1 — Teaser card, Section header, Fact row, Track row

- **Parent :** DS · **Tier :** tier/2 · **Diff :** ~300 lignes, 6 fichiers · **Dépend de :** B.1 ·
  **Parallélisable :** oui · **pbxproj :** `0280–028F`.
- **Figma :**
  - Teaser card : section `171:51`, doc `171:52`, `171:49`.
  - Section header : section `171:65`, doc `171:66`, `171:62`.
  - Fact row : section `172:5`, doc `172:6`, `172:2`.
  - Track row : section `172:37`, doc `172:38`, `172:34`.
- **Portée :**
  - Dans `ios/Track1/DesignSystem/Components/Node/` : `TeaserCard.swift`, `SectionHeader.swift`,
    `FactRow.swift` (avec `FactsBlock`), `TrackRow.swift`.
  - `ios/Track1Tests/DesignSystem/NodeTextComponentsTests.swift`.
  - pbxproj.
- **Contrat :**
  - `TeaserCard(text:)` : `Text(verbatim:)`, jamais tronqué.
  - `SectionHeader(title:, count: Int?)` : titre en minuscules, mono, compte affiché seulement s'il
    n'est pas `nil`. 12 pt au-dessus du contenu.
  - `FactRow(label:, value:)` : libellé mono en majuscules dans une colonne fixe de 104 pt.
  - `FactsBlock(rows: [(label: String, value: String)])` : rien n'est rendu si `rows` est vide.
  - `TrackRow(number: Int, title: String, action:)` : toute la ligne fait 44 pt.
    `static func formattedNumber(_: Int) -> String` complète à 2 chiffres.
  - Identifiants : `teaser`, `facts`, `section-<field>`, `track-row-<n>`.
- **Critères d'acceptation :**
  - [ ] `formattedNumber(1)` donne « 01 », `formattedNumber(12)` « 12 » et `formattedNumber(100)`
    « 100 ».
  - [ ] `FactsBlock(rows: [])` a un corps vide. Le test vérifie la fonction pure `isEmpty`.
  - [ ] `SectionHeader(count: nil)` n'affiche aucun compte : fonction pure `countText`.
- **Tests attendus :** `NodeTextComponentsTests` (XCTest).

#### E.2 — Edge chip, Overflow et disposition en flux

- **Parent :** DS · **Tier :** tier/2 · **Diff :** ~300 lignes, 4 fichiers · **Dépend de :** B.1,
  Q1 · **Parallélisable :** oui · **pbxproj :** `0290–029F`.
- **Figma :** section `171:99`, doc `171:100`, ensemble `171:96` (`171:76`, `171:80`, `171:84`,
  `171:88`, `171:92`) et Overflow `171:97`.
- **Portée :**
  - Dans `ios/Track1/DesignSystem/Components/Node/` : `EdgeChip.swift` (chip et overflow),
    `ChipFlowLayout.swift`.
  - `ios/Track1Tests/DesignSystem/EdgeChipTests.swift`.
  - pbxproj.
- **Contrat :**
  - `EdgeChip(type: NodeType, name: String, meta: String?, action:)`.
    - Étiquette de type en `Track1Tokens.colorNode(type)`, fond `colorBackgroundElevated`, bordure
      `colorBorderDefault`.
    - 34 pt visuels, zone de toucher de 44 pt.
    - Nom tronqué par une ellipse à 280 pt.
  - `EdgeChipOverflow(hiddenCount:, action:)` affiche « +N more » (Q1).
  - `struct ChipFlowLayout: Layout` avec un écart de 8 pt sur les deux axes.
  - Fonction pure `static func rows(sizes: [CGSize], maxWidth: CGFloat, spacing: CGFloat) -> [[Int]]`.
  - `enum EdgeChipFormat { static func meta(year: String?, releaseType: String?) -> String? }` :
    « · 2015 », « · 2015 · album », ou `nil`.
  - Identifiants : `edge-chip-<identity>`, `edge-overflow-<field>`.
- **Critères d'acceptation :**
  - [ ] `rows` replie à la ligne au bon endroit pour des largeurs connues (3 cas, dont une chip plus
    large que `maxWidth`, qui occupe seule sa ligne).
  - [ ] `meta(nil, nil)` vaut `nil`, `meta("2015", nil)` « · 2015 », `meta("2015", "album")`
    « · 2015 · album ».
  - [ ] La couleur d'étiquette de chacun des 5 types est `colorNode(type)`.
- **Tests attendus :** `EdgeChipTests` (XCTest).

#### E.3 — Hero et Release card

- **Parent :** DS · **Tier :** tier/2 · **Diff :** ~380 lignes, au plus 10 fichiers (assets
  compris) · **Dépend de :** C.2 (`Track1Artwork.State`) · **Parallélisable :** oui ·
  **pbxproj :** `02A0–02AF`.
- **Figma :** Hero : section `171:35`, doc `171:36`, ensemble `171:34` avec les variantes Release
  `171:2` (boîtier `171:3`, disque `171:4`, coque `171:15`), Artist `171:30` et Cover `171:31`.
  Release card : section `172:20`, doc `172:21`, `172:16`.
- **Portée :**
  - Dans `ios/Track1/DesignSystem/Components/Node/` : `NodeHero.swift`, `ReleaseCard.swift`.
  - Si `get_design_context` de `171:2` fournit des textures raster pour la coque, les ajouter sous
    `ios/Track1/Resources/Assets.xcassets/Hero/`, au plus 4 fichiers. Les formes simples se
    dessinent en SwiftUI.
  - `ios/Track1Tests/DesignSystem/HeroTests.swift`.
  - pbxproj.
- **Contrat :**
  - `struct NodeHero: View { enum Kind { case release, artist, cover; init(_ type: NodeType) }; init(kind:, image: Track1Artwork.State, discTint: Color?) }`.
    - Correspondance des types : project et track → `release`, artist → `artist`, genre et label →
      `cover`.
    - `release` : boîtier et disque partiellement sorti, l'étiquette du disque teintée par
      `discTint`. Le boîtier n'est jamais rogné.
    - `artist` : cercle de 164 pt. `cover` : carré de 164 pt.
    - Centré, 16 pt sous la Top bar. Placeholder dégradé propre à chaque variante.
  - `ReleaseCard(title:, meta: String?, cover: Track1Artwork.State, action:)` : 120 pt de large,
    titre sur 2 lignes au plus.
    `static func meta(year: String?, releaseType: String?) -> String?` donne « 2015 · album ».
  - Identifiants : `node-hero`, `release-card-<identity>`.
- **Critères d'acceptation :**
  - [ ] `Kind(.project)` et `Kind(.track)` donnent `release`, `Kind(.artist)` donne `artist`,
    `Kind(.genre)` et `Kind(.label)` donnent `cover`.
  - [ ] `ReleaseCard.meta` couvre les 4 combinaisons présent / absent.
  - [ ] Les constantes `NodeHero.Kind.size` égalent le Figma : release 276 × 183, artist et cover
    164 × 164.
- **Tests attendus :** `HeroTests` (XCTest).

#### E.4 — Streaming button et Streaming bar

- **Parent :** DS · **Tier :** tier/2 · **Diff :** ~280 lignes, 8 fichiers · **Dépend de :** B.1 ·
  **Parallélisable :** oui · **pbxproj :** `02B0–02BF`.
- **Figma :** Streaming button : section `172:104`, doc `172:105`, ensemble `172:75` (`172:45`
  Apple Music, `172:55` Spotify). Streaming bar `172:76`. Logo : section `170:90`, doc `170:91`,
  `169:122` (`169:107` Apple Music, `169:114` Spotify). YouTube Music (`172:65`, `169:121`) n'est
  pas utilisé (D12).
- **Portée :**
  - `ios/Track1/DesignSystem/Components/Node/StreamingButton.swift` (bouton et barre).
  - `ios/Track1/Resources/Assets.xcassets/Brand/AppleMusic.imageset/` et `Spotify.imageset/`.
    Marques exportées en vectoriel (PDF ou SVG, `preserves-vector-representation`), jamais
    recolorées.
  - `ios/Track1Tests/DesignSystem/StreamingBarTests.swift`.
  - pbxproj.
- **Contrat :**
  - `StreamingButton(provider: ListeningProvider, action:)` : pilule `colorSurfaceDefault`,
    `monoMicro`, hauteur `sizeControlMedium`, logo de 16 pt, haptique légère.
  - `StreamingBar(actions: [ListeningAction], isOpening: Bool, open: (ListeningAction) -> Void)`.
    Fonction pure `static func ordered(_: [ListeningAction]) -> [ListeningAction]` : Apple Music
    puis Spotify.
  - La barre n'existe pas si `actions` est vide. Boutons désactivés pendant `isOpening`.
  - Identifiants : `streaming-bar`, `listen-apple_music`, `listen-spotify` (ceux de TRA-368).
- **Critères d'acceptation :**
  - [ ] `ordered([spotify, appleMusic])` donne `[appleMusic, spotify]`. Une liste vide donne une
    barre absente.
  - [ ] Les identifiants de bouton sont `listen-<provider.rawValue>`.
  - [ ] `UIImage(named: "Brand/AppleMusic")` et `"Brand/Spotify"` existent dans l'app de test, et
    `"Brand/YouTubeMusic"` n'existe pas.
- **Tests attendus :** `StreamingBarTests` (XCTest).

### Partie F — Données de fiche et images (Data contract)

Incrément : projection et chargement testés, prêts pour H.1. Aucun écran ne change.

#### F.1 — Sections de fiche selon le Data contract, avec test de parité

- **Parent :** TRA-347 (réécrit) · **Tier :** tier/2 · **Diff :** ~340 lignes, 5 fichiers ·
  **Dépend de :** — · **Parallélisable :** oui · **pbxproj :** `02C0–02CF`.
- **Figma :** Data contract `168:1401`, avec les règles globales `179:5` (règles 1 à 7 et 9), les
  arêtes inverses `179:8`, et les tables project `179:57`, track `179:132`, artist `179:222`, genre
  `179:297` et label `179:367`.
- **Portée :**
  - `ios/Track1/Features/Node/NodePageSpec.swift` (nouveau, constantes).
  - `ios/Track1/Features/Node/NodePageModel.swift` (nouveau, sections).
  - `ios/Track1Tests/Node/NodePageModelTests.swift` (nouveau).
  - `test/ios-node-page-spec.test.ts` (nouveau, vitest).
  - pbxproj.
- **Contrat :**
  - `enum NodePageSpec`. Les constantes de parité sont entre `// BEGIN node-spec-parity` et
    `// END node-spec-parity` :
    - `sectionOrder: [NodeType: [String]]` = les clés de `EDGE_FIELDS_BY_TYPE` dans l'ordre ;
    - `singleFields: [NodeType: [String]]` = `SINGULAR_EDGES_BY_TYPE` ;
    - `carouselField: [NodeType: String]` : artist `discography`, label `notable_releases`, genre
      `landmark_projects`, project `related_projects` ;
    - `trackListField` = project `tracklist` ;
    - `chipLimit = 8`.
  - `static func label(field: String, type: NodeType) -> String` reprend `KIND_LABEL` de
    `web/index.html`, et à défaut le nom du champ avec `_` → espace :
    - `artists` → « artist(s) » ; `project` → « album / ep » pour un titre ;
    - `personnel` → « performers » ; `tracklist` → « tracks » ;
    - `related_projects` → « related albums » ; `landmark_projects` → « landmark albums » ;
    - les autres libellés figurent dans les tables Figma.
  - `struct NodePageSection: Equatable { field: String; label: String; presentation: Presentation; edges: [NodeEdge]; totalCount: Int; showsCount: Bool }`.
  - `enum Presentation { case chips, carousel, trackList, single }`.
  - `NodePageModel.sections(for: NodeDetail) -> [NodePageSection]`, avec ces règles :
    - ordre du schéma ;
    - liste vide ou absente : pas de section ;
    - `single` : `showsCount = false`, une seule arête ;
    - chips : toutes les arêtes, la vue gère le seuil de 8 ;
    - `trackList` : liste complète, dans l'ordre du tableau.
  - `static let rule9Deviations = ["editorial_article", "citations"]`, entre les marqueurs : champs
    exclus par la règle 9 mais affichés quand même (D15, validé le 2026-10-11).
  - Le test vitest lit le fichier Swift et compare chaque liste aux objets de `src/node-spec.ts`. Il
    exige que `rule9Deviations` vaille exactement `["editorial_article", "citations"]`, et qu'aucun
    autre champ de la règle 9 (`mbid`, `qid`, `materialized_at`, `image_source`) ne figure entre les
    marqueurs.
- **Critères d'acceptation :**
  - [ ] Pour une fixture complète de chacun des 5 types, l'ordre des sections égale celui de
    `EDGE_FIELDS_BY_TYPE`. Pour un artiste, `influences` vient avant `collaborators`.
  - [ ] Une arête vide n'a pas de section, et les arêtes uniques ont `showsCount == false`.
  - [ ] Un genre à 10 sous-genres a `totalCount == 10` et ses 10 arêtes.
  - [ ] Le test vitest accepte l'écart validé et échoue si `rule9Deviations` contient un autre champ
    (par exemple `mbid`).
  - [ ] Le test vitest échoue si un champ est ajouté ou réordonné d'un côté seulement (vérifié en le
    faisant échouer localement avant le commit, puis consigné dans la PR).
- **Tests attendus :** `NodePageModelTests` (XCTest) et `test/ios-node-page-spec.test.ts`
  (`npm run check`).

#### F.2 — En-tête de fiche : sous-titre, teaser et faits

- **Parent :** TRA-347 · **Tier :** tier/2 · **Diff :** ~260 lignes, 3 fichiers · **Dépend de :**
  F.1, Q1 · **Parallélisable :** oui · **pbxproj :** `02D0–02DF`.
- **Figma :** les mêmes tables (`179:57` à `179:367`), Fact row doc `172:6`, Teaser card doc
  `171:52`, et les specs 2.1 à 2.5 : `177:252`, `177:403`, `177:671`, `177:917`, `177:1063`.
- **Portée :**
  - `ios/Track1/Features/Node/NodePageHeader.swift` (nouveau).
  - `ios/Track1Tests/Node/NodePageHeaderTests.swift` (nouveau).
  - pbxproj.
- **Contrat :**
  - `struct NodePageHeader: Equatable { title: String; subtitle: String?; teaser: String?; facts: [NodeFact] }`
    et `init(node: NodeDetail)`.
  - **Sous-titre.** Segments joints par « · », segment absent omis, `nil` si aucun segment :

    | Type | Segments |
    | --- | --- |
    | project | `artists` (noms joints par « , ») · `release_type` (« Album », « EP », « Single ») · `year` |
    | track | `artists` · nom de l'arête `project` · `duration` (m:ss : `"261"` → « 4:21 », `"4:21"` inchangé) · `year` |
    | artist | `origin` · `active_years` |
    | genre | `era` · `origin` |
    | label | « Founded » + `founded` (Q1) · `location` |

  - **Teaser.** `node.teaser` sans markdown :
    - `*x*`, `**x**` et `_x_` deviennent `x` ;
    - `` `x` `` devient `x` ;
    - `[t](u)` devient `t` ;
    - une chaîne vide devient `nil`.
  - **Faits.** Une ligne par champ présent, dans cet ordre :
    - project et track : `bpm` « BPM », `musical_key` « KEY », `vocals` « VOCALS »,
      `samples_notes` « SAMPLES », `inspirations` « INSPIRATIONS » ;
    - genre : `sonic_markers` « SONIC MARKERS » ;
    - label : `founders` « FOUNDERS », `active_years` « ACTIVE » ;
    - artist : aucun fait.
  - `materialized_at` n'est jamais lu. L'article et les citations ne font pas partie de l'en-tête :
    ils sont rendus en fin de page (H.1, H.3, D15).
- **Critères d'acceptation :**
  - [ ] Les 5 types en données complètes, partielles et vides donnent les sous-titres attendus.
    Exemple : « Kendrick Lamar · Album · 2015 ». Un `release_type` absent est omis.
  - [ ] `duration` `"261"` donne « 4:21 », `"4:21"` reste « 4:21 », `"abc"` est omis.
  - [ ] Le teaser `"*Cosmogramma* is"` donne « Cosmogramma is ».
  - [ ] Un artiste n'a aucun fait. Un projet sans champ optionnel a `facts == []`.
- **Tests attendus :** `NodePageHeaderTests` (XCTest, fixtures `NodeDetail` décodées depuis un
  JSON de l'API).

#### F.3 — Charger les images sans redirection non sûre (TRA-367 amendé, obligatoire)

- **Parent :** TRA-341 · **Tier :** tier/2 · **Diff :** ~360 lignes, 6 fichiers · **Dépend de :** —
  · **Parallélisable :** oui · **pbxproj :** `02E0–02EF` (crée les groupes `Media` sous `A3…0002`
  et `Track1Tests/Media`). L'ancienne plage `0130–013F` est libérée.
- **Figma :** Data contract, règle 8 (`179:7`) ; états d'Artwork `18:2`.
- **Portée :**
  - `ios/Track1/Media/NodeImageLoader.swift` et `NodeImageStore.swift` (nouveaux).
  - `ios/Track1/App/AppContainer.swift` : `imageStore` construit sur `readers.image`.
  - `ios/Track1Tests/Media/NodeImageLoaderTests.swift` et `NodeImageStoreTests.swift`.
  - pbxproj.
- **Contrat :**
  - `enum NodeImageLoader { static func load(url: URL, configuration: URLSessionConfiguration = .ephemeral) async -> UIImage? }`.
    - L'URL initiale et chaque redirection passent `URLValidation.publicHTTPSURL`, sinon la requête
      est annulée.
    - Réponse non-2xx, type non image ou plus de 10 Mo : `nil`.
    - Image sous-échantillonnée à 600 px de côté au plus (ImageIO).
  - `actor NodeImageStore` :
    - `init(readImage: @escaping @Sendable (NodeIdentity) async -> APIResult<ImageResponse>, load: @escaping @Sendable (URL) async -> UIImage? = { await NodeImageLoader.load(url: $0) })` ;
    - `func image(for identity: NodeIdentity) async -> UIImage?` : lit `/image`. Une réponse dont le
      `slug` diffère, un `image_url` nul ou invalide donnent `nil`. Le résultat est mis en cache
      (`NSCache`), échec compris pour la session.
    - `func image(at url: URL) async -> UIImage?` : pour `NodeDetail.image_url` déjà validée.
    - Coalescence : deux demandes concurrentes de la même identité font un seul `/image`.
  - En fixtures UI, `readers.image` échoue, donc le placeholder s'affiche. Aucune fixture n'est
    ajoutée.
  - Plus de paramètre `readImage` dans `NodeViewModel` : l'ancien contrat de TRA-367 est abandonné.
- **Critères d'acceptation :**
  - [ ] Une redirection vers un hôte privé, en `http` ou avec un port explicite : la cible n'est
    jamais demandée et le résultat est `nil`. Une redirection HTTPS publique charge l'image.
  - [ ] `/image` avec un autre `slug` ou un `image_url` nul donne `nil`.
  - [ ] Deux `image(for:)` concurrents sur la même identité appellent `readImage` une seule fois.
    Un second appel après succès n'appelle rien.
- **Tests attendus :** `NodeImageLoaderTests` (`URLProtocol` local au fichier) et
  `NodeImageStoreTests` (vrai store, lecteurs en closures).

#### F.4 — Sources du héros et couleur dominante

- **Parent :** TRA-347 · **Tier :** tier/2 · **Diff :** ~330 lignes, 6 fichiers · **Dépend de :**
  F.3, Q5, Q6 · **Parallélisable :** oui · **pbxproj :** `02F0–02FF`.
- **Figma :** Hero doc `171:36` (DATA et RULES). Lignes de héros du Data contract : `179:87`,
  `179:167`, `179:242`, `179:317`, `179:387`. Questions ouvertes `181:27`.
- **Portée :**
  - Dans `ios/Track1/Media/` : `HeroImageSource.swift`, `DominantColor.swift`,
    `NodeHeroModel.swift`.
  - `ios/Track1Tests/Media/HeroImageTests.swift`.
  - pbxproj.
- **Contrat :**
  - `enum HeroCandidate: Equatable { case url(URL), node(NodeIdentity) }`.
  - `enum HeroImageSource { static func candidates(for: NodeDetail) -> [HeroCandidate] }`, par
    type :
    - artist : `image_url`, puis `discography[0]` ;
    - project : `image_url` ;
    - track : `image_url`, puis l'arête `project` ;
    - genre : `landmark_projects[0]`, puis `landmark_tracks[0]` (écart accepté, voir la section
      Data contract) ;
    - label : `notable_releases[0]`.
    - Les URLs passent `URLValidation.publicHTTPSURL`, sinon le candidat est ignoré.
  - `enum DominantColor { static func of(_ image: UIImage) -> Color? }` : `CIAreaAverage` sur une
    version 32 × 32. Une image totalement transparente donne `nil`.
  - `@MainActor @Observable final class NodeHeroModel` :
    - `enum State: Equatable { case loading, loaded(UIImage, tint: Color?), placeholder }` ;
    - `init(node: NodeDetail, store: NodeImageStore)` et `func load() async`.
    - `load` essaie les candidats dans l'ordre ; le premier non nul gagne, sinon `placeholder`.
    - Un résultat arrivé après annulation est ignoré.
- **Critères d'acceptation :**
  - [ ] Les candidats sont exacts pour les 5 types, avec et sans arêtes ni `image_url`. Une
    `image_url` en `http` est ignorée.
  - [ ] Une image 4 × 4 rouge pur donne une couleur dominante rouge, chaque composante à ±0,02
    près.
  - [ ] Si le premier candidat donne `nil` et le second une image, l'état est `loaded`. Si tous
    donnent `nil`, il est `placeholder`.
  - [ ] Une réponse arrivée après annulation ne change pas l'état.
- **Tests attendus :** `HeroImageTests` (XCTest, vrai `NodeImageStore` avec lecteurs en
  closures).

### Partie G — Navigation (Flow 3, socle)

#### G.1 — Onglets Aujourd'hui / Genres / Recherche, sheet et fil d'Ariane

- **Parent :** TRA-341 · **Tier :** tier/2 · **Diff :** ~380 lignes, 6 fichiers · **Dépend de :**
  C.1 (`TopBarCrumb`), B.1 · **Parallélisable :** oui, avec la Partie E et F · **pbxproj :**
  `0300–030F` (aucun fichier attendu).
- **Figma :** en-tête Flow 3 `178:64` ; Tab bar : section `173:109`, doc `173:110`, `173:108`
  (`173:57`, `173:74`, `173:91`) ; Search sheet doc `174:170` (déclenchement et fermeture) ;
  spec 3.2 `178:764`.
- **Portée :**
  - `ios/Track1/App/AppRouter.swift`.
  - `ios/Track1/App/RootView.swift`.
  - `ios/Track1Tests/Node/AppRouterNodeTests.swift`.
  - `ios/Track1UITests/NavigationTests.swift`.
  - `ios/Track1UITests/ProfileFlowTests.swift` : remplacer les assertions `entry-status-search`.
  - pbxproj si un fichier est créé.
- **Contrat :**
  - `AppTab` : `today` (« Aujourd'hui », glyphe `home`), `genres` (« Genres », `musicNote`),
    `search` (« Recherche », `search`). `settings` disparaît.
  - Nouveaux membres d'`AppRouter` :
    - `var isSearchPresented: Bool` ;
    - `func select(_ tab: AppTab)` : `.search` ouvre la sheet sans changer `selectedTab` ; un
      re-toucher de `.today` déjà sélectionné vide la pile Aujourd'hui ;
    - `private(set) var titles: [NodeIdentity: String]` ;
    - `func openNode(_:context:title:in:)` enregistre le titre ;
    - `func popTo(index: Int, in: AppTab)` garde `path[0...index]`, et l'index −1 désigne la racine ;
    - `func breadcrumb(for: AppTab, rootTitle: String?) -> [TopBarCrumb]`.
  - `RootView` :
    - `TabView(selection:)` dont le binding passe par `router.select` ;
    - sous iOS 26, `Tab(role: .search)` ; sous iOS 17 et 18, `tabItem` avec un repli
      `.toolbarBackground(.ultraThinMaterial, for: .tabBar)` ;
    - haptique `.selection` au changement d'onglet ;
    - la racine de l'onglet Genres est **provisoirement** `SettingsView`, jusqu'à K.1 ;
    - `.sheet(isPresented: $router.isSearchPresented)` contient un placeholder
      (`search-sheet`, champ inerte), remplacé en I.2.
- **Critères d'acceptation :**
  - [ ] `select(.search)` met `isSearchPresented` à vrai sans changer `selectedTab`. `select(.today)`
    sur Aujourd'hui avec une pile de 2 vide la pile.
  - [ ] `popTo(index: 0)` sur une pile de 3 garde 1 élément. `breadcrumb` renvoie la racine puis les
    titres enregistrés, dans l'ordre.
  - [ ] XCUITest : les onglets « Aujourd'hui », « Genres » et « Recherche » existent. Toucher
    « Recherche » affiche `search-sheet`, et Aujourd'hui reste sélectionné. « Genres » affiche
    `profile-settings-edit`.
  - [ ] `ConsentTests` et `ProfileFlowTests` (adapté) restent verts.
- **Tests attendus :** `AppRouterNodeTests` (XCTest), `NavigationTests` et `ProfileFlowTests`
  adaptés (XCUITest).

### Partie H — Fiche et Aujourd'hui (Flow 2)

Incrément visible : la fiche Figma complète, puis Aujourd'hui qui affiche la fiche du jour.

#### H.1 — Page de fiche Figma

- **Parent :** TRA-347 · **Tier :** tier/2 · **Diff :** ~380 lignes, 5 fichiers · **Dépend de :**
  TRA-376, TRA-368, B.2, C.1, E.1 à E.4, F.2, F.4, G.1 · **Parallélisable :** non, avec les autres
  tâches qui touchent `NodeView` · **pbxproj :** `0310–031F`.
- **Figma :**
  - Écrans : 2.1 `177:22` (spec `177:252`), 2.2 `177:266` (`177:403`), 2.3 `177:417`
    (`177:671`), 2.4 `177:685` (`177:917`) et 2.5 `177:931` (`177:1063`).
  - Anatomie : en-tête Flow 2 `177:21`.
  - Navigation : 3.2 `178:610` (spec `178:764`).
- **Portée :**
  - `ios/Track1/Features/Node/NodePageView.swift` (nouveau).
  - `ios/Track1/Features/Node/NodeView.swift` : états `.loaded` → `NodePageView`, `.loading` →
    `Track1ProgressBar(.indeterminate)`, `.missing` → `Track1StatusView(.nodeMissing)`, `.failed` →
    `.nodeFailed`.
  - `ios/Track1/App/RootView.swift` : passe l'`imageStore`, la Top bar, le glow et le router.
  - `ios/Track1Tests/Node/NodePageViewTests.swift` (nouveau).
  - pbxproj.
- **Contrat :**
  - `struct NodePageView: View` avec
    `init(node: NodeDetail, hero: NodeHeroModel, topBar: TopBar.Content, isRoot: Bool, listening: ListeningState, onOpenEdge: (NodeEdge, String) -> Void, onOpenListening: (ListeningAction) -> Void, onSelectCrumb: (TopBarCrumb) -> Void)`.
  - Ordre vertical :
    1. `AmbientGlow` (derrière) ;
    2. `TopBar` ;
    3. `NodeHero`, avec `discTint` venant de `NodeHeroModel` ;
    4. titre `title3` et sous-titre (`NodePageHeader`) ;
    5. `TeaserCard` ;
    6. `FactsBlock` ;
    7. les sections de `NodePageModel` :
       - chips `ChipFlowLayout`, 8 au plus, puis `EdgeChipOverflow` qui déplie la section sur
         place (`@State Set<String>`) ;
       - carrousel horizontal de `ReleaseCard`, avec un écart de 12 pt et la dernière carte qui
         dépasse ; chaque pochette se charge par `imageStore.image(for:)` dans `.task` ;
       - `TrackRow` pour la liste de pistes ;
       - une chip unique sans compte ;
    8. l'article et les sources : `NodeArticleView` existant, tel quel jusqu'à H.3 (D15) ;
    9. `StreamingBar` en `.safeAreaInset(edge: .bottom)`, 8 pt au-dessus de la barre d'onglets.
  - Marges de `spacing24`, rythme de section `spacing24`.
  - Toucher une chip, une carte ou une piste appelle
    `router.openNode(edge.slug, context: context.followingRelation(), title: edge.name)` et émet
    `relation_opened`, avec la même logique qu'aujourd'hui dans `NodeRelationsView`.
  - Glow : fonction pure `static func glowTone(isRoot: Bool, type: NodeType, tint: Color?) -> AmbientGlow.Tone`.
    - Non racine : `.silver`.
    - Racine de type project ou track avec une teinte : `.tinted(tint)`.
    - Sinon : `.ember`.
  - Identifiants : `node-title`, `node-subtitle`, plus ceux des composants.
  - `NodeArticleView` est conservé (D15) : `NodePageView` le place tel quel après la dernière section
    d'arêtes, et H.3 l'habille. `NodeRelationsView` et `NodeListeningView` ne sont plus référencés
    (supprimés en L.1).
- **Critères d'acceptation :**
  - [ ] `glowTone` couvre les 4 cas : non racine, racine project avec teinte, racine project sans
    teinte, racine genre.
  - [ ] `relation_opened` est émis une seule fois par toucher, avec les propriétés V1. Le test passe
    par le vrai `NodeViewModel` et l'enregistreur en closure.
  - [ ] `git grep -n "NodeRelationsView\|NodeListeningView" ios/Track1/App ios/Track1/Features/Node/NodeView.swift`
    ne trouve rien. `NodeArticleView` n'est référencé que par `NodePageView`.
  - [ ] Les XCUITest existants restent verts.
- **Tests attendus :** `NodePageViewTests` (XCTest). Le rendu est exercé par les XCUITest de H.2 et
  I.2 (risque R3).

#### H.2 — Aujourd'hui affiche la fiche du jour (TRA-373 amendé)

- **Parent :** TRA-343 · **Tier :** tier/2 · **Diff :** ~380 lignes, 7 fichiers · **Dépend de :**
  H.1, D.2, TRA-379 · **Parallélisable :** oui, avec I.2 (conflit mécanique sur `RootView`) ·
  **pbxproj :** `0320–032F` (remplace `01B0–01BF`).
- **Figma :** écrans 2.1 à 2.5 en racine d'Aujourd'hui, avec la Top bar Date (`173:14`) ; en-tête
  Flow 3 `178:64` (re-toucher Aujourd'hui) ; 1.6 Loading `176:326` (spec `176:338`).
- **Portée :**
  - `ios/Track1/Features/Today/TodayView.swift` (nouveau).
  - `ios/Track1/Features/Today/RecommendationLoadingView.swift` (nouveau, mise en page 1.6).
  - `ios/Track1/App/RootView.swift`.
  - `ios/Track1/App/AppContainer.swift` : `dailyRecommendationStore` partage le `LocalStore`. Sur
    simulateur, l'argument `-track1-reset-daily-recommendation` donne `resetBeforeUse: true`.
  - `ios/Track1UITests/TodayFlowTests.swift` et `ios/Track1UITests/UITestFlows.swift` (nouveaux :
    lancement avec fixtures, refus du consentement, onboarding).
  - pbxproj.
- **Contrat :**
  - `TodayView` lance `.task(id: profile.revision) { await model.load(for: profile) }`.
  - États :
    - `.loading` : `RecommendationLoadingView` (Ambient glow, « Préparation de ta recommandation
      du jour… » (Q1), `Track1ProgressBar(.indeterminate)`). Au-delà de **20 s**,
      `Track1StatusView(.loadingTimeout)`, dont l'action relance `load`.
    - `.recommendation(rec)` : `NodeView` de `rec.nodeID` avec `TopBar.Content.date(now)` et
      `isRoot: true`. À la première apparition de chaque `recommendationID` :
      `recordImpressionIfNeeded()`, puis **un** `discover()` qui donne le `NavigationContext`
      (`source .home`). Une recomposition ne rappelle rien.
    - `.emptyCatalog` : `.todayEmpty`, dont l'action fait `router.select(.genres)`.
    - `.unavailable` : `.todayUnavailable`, dont l'action relance.
    - Profil absent : `ProfileMissingView` inchangé jusqu'à J.4.
  - Les fiches poussées depuis Aujourd'hui affichent le fil d'Ariane
    (`router.breadcrumb(for: .today, rootTitle:)`, avec le nom de la fiche du jour une fois
    chargée). Toucher un crumb appelle `popTo`.
- **Critères d'acceptation (XCUITest sur fixtures) :**
  - [ ] Parcours principal :
    1. Consentement refusé.
    2. Onboarding avec le catalogue fixture.
    3. Aujourd'hui affiche `top-bar-date` et `node-title`.
    4. Toucher une chip pousse la fiche liée, avec `top-bar-breadcrumb`.
    5. Toucher le crumb racine revient à la fiche du jour.
    6. Re-toucher Aujourd'hui depuis une fiche poussée revient aussi à la racine.
    7. Relancer sans arguments de réinitialisation affiche le même `node-title`.
  - [ ] Un catalogue fixture sans œuvre liée affiche `today-empty`.
  - [ ] Captures D7 « 2.x-today » et « 3.2 » jointes.
  - [ ] `NavigationTests`, `ProfileFlowTests` et `ConsentTests` restent verts.
- **Tests attendus :** `TodayFlowTests` (XCUITest, fixtures `TRACK1_UI_TEST_FIXTURES_JSON` et
  `TRACK1_PROFILE_CATALOG_JSON`, dont des nœuds avec faits et arêtes des 5 types).

#### H.3 — Article et sources en sections Nocturne (D15, écart validé à la règle 9)

- **Parent :** TRA-341 · **Tier :** tier/2 · **Diff :** ~260 lignes, 4 fichiers · **Dépend de :**
  H.1, E.1, C.2 · **Parallélisable :** oui, avec H.2, I.2 et L.1 (aucun fichier commun) ·
  **pbxproj :** `03E0–03EF` (aucun fichier attendu).
- **Figma :** aucune maquette de l'article. Composition (D15) de :
  - Section header `171:62` (doc `171:66`) ;
  - Text `11:33`, rôle Body/Large `180:434` ;
  - ListItem `22:142`, variante Standard + Chevron `22:26` ;
  - rythme de section `180:481` ;
  - écart avec le Data contract, règle 9 `179:7`.
- **Portée :**
  - `ios/Track1/Features/Node/NodeArticleView.swift` : habillage seulement, `NodeArticleParser` et
    `safeCitationURL(_:)` inchangés.
  - `ios/Track1/Features/Node/NodePageSpec.swift` : `articleLabel = "article"`,
    `sourcesLabel = "sources"`, hors des marqueurs de parité.
  - `ios/Track1/Features/Node/NodePageView.swift` : passage des callbacks d'ouverture, sans changer
    la position fixée en H.1.
  - `ios/Track1Tests/Node/NodeArticleTests.swift` : cas ajoutés.
- **Contrat :**
  - Section « article » : `SectionHeader(title: NodePageSpec.articleLabel, count: nil)`, puis les
    blocs de `NodeArticleParser.blocks(from:)`.
    - Paragraphes en `bodyLarge`, `colorTextPrimary`, `Text(verbatim:)`.
    - Listes : une puce par élément, même rôle.
    - Article vide : pas de section.
  - Section « sources » : `SectionHeader(title: NodePageSpec.sourcesLabel, count: n)`, où `n` est le
    nombre de sources valides, puis un `Track1ListItem` par citation.
    - Titre : `citation.title`, sinon l'hôte. Sous-titre : l'hôte, ou rien si le titre est déjà
      l'hôte. Accessoire : chevron.
    - Toucher une ligne ouvre l'URL par l'OS (`OpenURLAction`), seulement après
      `NodeArticleView.safeCitationURL(_:)`.
    - Une citation invalide n'est pas rendue. Aucune source valide : pas de section.
  - Fonction pure `static func sourceRows(_ citations: [Citation]) -> [NodeSourceRow]`, avec
    `struct NodeSourceRow: Equatable { title: String; subtitle: String?; url: URL }`.
  - Espacements : `spacing24` entre sections, `spacing12` sous l'en-tête, marges `spacing24`.
  - Plus aucune référence à `Track1Theme` dans le fichier.
  - Identifiants : `section-article`, `section-sources`, `source-row-<index>`.
- **Critères d'acceptation :**
  - [ ] `sourceRows` :
    - une citation titrée donne le titre et l'hôte ;
    - une citation sans titre donne l'hôte sans sous-titre ;
    - une URL `http`, privée ou avec port explicite est exclue.
  - [ ] Un article vide ne produit pas de section « article ». Zéro source valide ne produit pas de
    section « sources ». Le test passe par une fonction pure `sections(article:citations:)`.
  - [ ] Les cas existants de `NodeArticleTests` restent verts, et `test/ios-no-webview.test.ts`
    passe.
  - [ ] `git grep Track1Theme ios/Track1/Features/Node/NodeArticleView.swift` ne trouve rien.
- **Tests attendus :** `NodeArticleTests` (XCTest).

### Partie I — Recherche (Flow 3, sheet 3.1)

#### I.1 — Fiches récentes et temporisation de 150 ms

- **Parent :** TRA-348 · **Tier :** tier/2 · **Diff :** ~300 lignes, 6 fichiers · **Dépend de :**
  TRA-364 (PR #331 mergée) · **Parallélisable :** oui · **pbxproj :** `0330–033F`.
- **Figma :** Search sheet doc `174:170` (BEHAVIOR) ; spec 3.1 `178:596`.
- **Portée :**
  - `ios/Track1/Persistence/RecentNodesStore.swift` (nouveau).
  - `ios/Track1/Features/Search/SearchViewModel.swift`.
  - `ios/Track1/Features/Settings/SettingsView.swift` : « Effacer le profil » vide aussi les
    récents.
  - `ios/Track1/App/AppContainer.swift`.
  - `ios/Track1Tests/RecentNodesStoreTests.swift` (nouveau) et `ios/Track1Tests/SearchTests.swift`.
  - pbxproj.
- **Contrat :**
  - `struct RecentNode: Codable, Equatable, Sendable { identity: NodeIdentity; name: String; type: NodeType }`.
  - `actor RecentNodesStore`, sur le `LocalStore` existant :
    - `init(store: LocalStore)` ;
    - `func record(_: RecentNode) async` : dédoublonne par identité en remontant l'entrée en tête,
      et garde 10 entrées au plus ;
    - `func list() async -> [RecentNode]` et `func clear() async`.
  - `SearchViewModel` :
    - temporisation de **150 ms** ;
    - `private(set) var recents: [RecentNode]`, chargé quand la phase est `.idle` ;
    - `init(…, recents: RecentNodesStore? = nil)` ;
    - le filtre reste `.all`, sans changement de contrat.
- **Critères d'acceptation :**
  - [ ] 12 `record` gardent les 10 derniers. Un `record` d'une identité déjà présente la remonte en
    tête sans doublon. Un nouveau store sur le même répertoire relit la liste. `clear` la vide.
  - [ ] « ab », « abc », « abcd » saisis en moins de 150 ms donnent un seul appel. La phase `.idle`
    expose les récents du store.
  - [ ] Les tests existants de `SearchTests` passent avec la nouvelle durée.
- **Tests attendus :** `RecentNodesStoreTests` (vrai `LocalStore`, répertoire temporaire) et
  `SearchTests` (XCTest).

#### I.2 — Sheet de recherche (TRA-372 amendé)

- **Parent :** TRA-348 · **Tier :** tier/2 · **Diff :** ~380 lignes, 6 fichiers · **Dépend de :**
  I.1, C.2, H.1 · **Parallélisable :** oui, avec H.2 · **pbxproj :** `0340–034F` (remplace
  `01D0–01DF`).
- **Figma :** 3.1 `178:68` (spec `178:596`) ; Search sheet `174:113` (doc `174:170`) ; ListItem
  `22:142` ; SearchField `30:21`.
- **Portée :**
  - `ios/Track1/Features/Search/SearchSheetView.swift` (nouveau, remplace le placeholder de G.1).
  - `ios/Track1/App/RootView.swift`.
  - `ios/Track1/Features/Node/NodeView.swift` : au passage `.loaded`, `recentNodes.record`.
  - `ios/Track1UITests/SearchFlowTests.swift` (nouveau).
  - `ios/Track1UITests/NavigationTests.swift`.
  - pbxproj.
- **Contrat :**
  - Sheet native : `.presentationDetents([.large])`, fond en verre (D8), scrim `colorOverlayScrim`.
  - `Track1SearchField` reçoit le focus à l'ouverture, avec le clavier.
  - Étiquette de liste : texte du nœud `174:120`.
  - Lignes `Track1ListItem` :
    - titre = nom ;
    - sous-titre = libellé de type, le même que l'étiquette d'Edge chip. `SearchHit` n'a pas
      d'année : pas d'année en V1, et pas d'analyse de `subtitle`.
  - Requête vide : liste des récents. Récents vides : aucune ligne.
  - Phases :
    - `.tooShort` : aucune ligne ;
    - `.tooLong` : « Recherche limitée à 120 caractères. » ;
    - `.empty` : « Aucun résultat » ;
    - `.failed` : `Track1StatusView(.searchFailed)`.
  - `.missing` : la ligne est désactivée, avec le sous-titre « Pas encore de fiche »
    (`search-missing-<index>`) ; ni navigation, ni requête.
  - `.node` : la sheet se ferme, puis
    `router.openNode(identity, context:, title: hit.name, in: router.selectedTab)`. Le fil d'Ariane
    part de la fiche courante.
  - Fermeture : glisser vers le bas, toucher le scrim, ou touche « Rechercher » sur un champ vide.
  - Identifiants : `search-sheet`, `search-row-<index>`.
- **Critères d'acceptation (XCUITest sur fixtures) :**
  - [ ] Parcours principal :
    1. Toucher Recherche.
    2. Saisir la requête fixture.
    3. Toucher un résultat de cache : la fiche s'ouvre (`node-title`).
    4. Toucher une chip, puis revenir : on retrouve la fiche d'origine.
    5. Rouvrir la sheet, requête vide : la fiche consultée figure parmi les récents.
  - [ ] Un résultat de catalogue sans fiche est désactivé, et le toucher ne navigue pas.
  - [ ] Un résultat dont l'identité est dans `unavailable` affiche `node-failed` et `node-retry`.
    Une relation vers une identité absente des fixtures affiche `node-missing`.
  - [ ] En mode sombre et en taille XXXL, `search-field` est présent dans la sheet. Capture D7
    « 3.1 » jointe.
- **Tests attendus :** `SearchFlowTests` et `NavigationTests` adaptés (XCUITest).

### Partie J — Onboarding (Flow 1)

Incrément visible (J.4) : le premier lancement suit les écrans 1.1 → 1.2 → 1.3/1.4 → 1.6.

#### J.1 — Taxonomie et modèle du parcours d'onboarding

- **Parent :** ONB · **Tier :** tier/2 · **Diff :** ~380 lignes, 7 fichiers · **Dépend de :** — ·
  **Parallélisable :** oui · **pbxproj :** `0350–035F`.
- **Figma :** specs 1.2b `176:155`, 1.3 `176:209` et 1.4 `176:257` ; Genre tile doc `175:8` ;
  Subgenre row doc `175:29` ; Select-all chip doc `175:49`.
- **Portée :**
  - Dans `ios/Track1/Features/Onboarding/` : `GenreTaxonomy.swift`, `OnboardingFlowModel.swift`
    (nouveaux).
  - `ios/Track1/Profile/Profile.swift` : `minimumGenres` passe à 1, et `selectionInstruction` est
    adaptée.
  - Dans `ios/Track1Tests/Profile/` : `GenreTaxonomyTests.swift`, `OnboardingFlowModelTests.swift`
    (nouveaux), `OnboardingContractTests.swift` (minimum 1).
  - pbxproj.
- **Contrat :**
  - `struct GenreChoice: Equatable, Sendable { identity: NodeIdentity; name: String; definition: String? }`.
  - `struct GenreTaxonomy { init(catalog: Catalog) }` :
    - `let parents: [GenreChoice]` : genres avec au moins un sous-genre dans le catalogue et aucun
      parent dans le catalogue (D13), triés par nom (comparaison localisée `fr`) ;
    - `func subgenres(of: NodeIdentity) -> [GenreChoice]` : arêtes `subgenres` du parent ou
      `parent_genres` du sous-genre, sans doublon et sans le parent lui-même ;
    - `definition` = `CatalogNode.teaser`.
  - `@MainActor @Observable final class OnboardingFlowModel`, avec
    `init(taxonomy: GenreTaxonomy, editing: Profile? = nil)` :
    - `private(set) var selectedParents: [NodeIdentity]`, dans l'ordre de sélection ;
    - `func toggleParent(_:)` et `var canContinueFromGenres: Bool` (au moins 1) ;
    - `var subgenreSteps: [NodeIdentity]` : parents sélectionnés, dans l'ordre ;
    - `func toggleSubgenre(_:, of:)`, `func toggleAll(of:)` et `func isAllSelected(of:) -> Bool`
      (vrai aussi après sélection manuelle complète) ;
    - `var selectedSubgenreCount: Int` ;
    - `func ctaTitle(forStep index: Int) -> String` : « Continuer », et « Terminer » sur la dernière
      étape, ou « Enregistrer » si `editing` ;
    - désélectionner un parent retire ses sous-genres ; la sélection survit au retour arrière ;
    - `func makeDraft() -> ProfileDraft` : `genreIDs` = parents ∪ sous-genres, sans doublon, dans
      l'ordre de sélection.
  - `editing` présélectionne les parents et sous-genres du profil.
- **Critères d'acceptation :**
  - [ ] Sur une fixture (Hip-Hop avec 3 sous-genres, Jazz avec 2, Ambient sans sous-genre, un cycle
    A ↔ B), les parents sont [Hip-Hop, Jazz]. Ambient est exclu et le cycle ne boucle pas.
  - [ ] Sélectionner Jazz puis Hip-Hop donne `subgenreSteps == [Jazz, Hip-Hop]`. Le CTA de la
    dernière étape est « Terminer ».
  - [ ] `toggleAll` sélectionne tout puis vide. Sélectionner tout à la main rend
    `isAllSelected == true`.
  - [ ] `makeDraft` contient les parents et les sous-genres choisis. Un profil à 1 genre est valide.
  - [ ] `editing` restitue exactement la sélection d'un profil existant.
- **Tests attendus :** `GenreTaxonomyTests`, `OnboardingFlowModelTests` et
  `OnboardingContractTests` (XCTest).

#### J.2 — Écrans 1.1 Welcome et 1.2 Genres
Écrans remplacés le 2026-10-18 par `docs/plans/ios-onboarding-accordion.md`.

- **Parent :** ONB · **Tier :** tier/2 · **Diff :** ~330 lignes, 5 fichiers · **Dépend de :** J.1,
  C.1, D.1, D.2, Q1, Q2 · **Parallélisable :** oui · **pbxproj :** `0360–036F`.
- **Figma :** en-tête Flow 1 `176:51` (principes globaux) ; 1.1 `176:56` (spec `176:69`) ; 1.2a
  `176:80` (spec `176:114`) ; 1.2b `176:122` (spec `176:155`).
- **Portée :**
  - Dans `ios/Track1/Features/Onboarding/` : `WelcomeView.swift`, `GenresStepView.swift`,
    `OnboardingFlowView.swift` (nouveaux).
  - `ios/Track1Tests/Profile/GenresStepLayoutTests.swift` (nouveau).
  - pbxproj.
- **Contrat :**
  - `WelcomeView` : `WelcomeBackdrop`, « track1 » (Q2) en `displayHero`, « Explorations musicales
    quotidiennes » (Q1) en `bodyLarge`, et `BottomActionBar` « Démarrer » (`onboarding-start`).
  - `GenresStepView` :
    - `AmbientGlow(.ember)`, « Sélectionne tes genres » en `title1`, « Tu recevras une
      recommandation par jour pour les explorer » en `bodyMedium` ;
    - grille de 2 colonnes de `GenreTile` (placeholder, Q5), gouttière de 16 pt, qui défile ;
    - `BottomActionBar` « Continuer », désactivé tant qu'aucun parent n'est choisi
      (`onboarding-genres-continue`).
    - `enum GenresStepLayout { static func tileSize(containerWidth: CGFloat) -> CGSize }` : largeur
      `(w − 16) / 2`, hauteur au rapport 176/164.
  - `OnboardingFlowView(model:, onFinish: (ProfileDraft) -> Void)` : `NavigationStack` avec Welcome
    puis Genres. Les étapes suivantes viennent en J.3. **Non branché** sur `RootView` avant J.4.
- **Critères d'acceptation :**
  - [ ] `tileSize(345)` donne 164,5 × ~176,5. `tileSize(327)` (iPhone SE, 375 − 48) donne
    155,5 × ~166,9. Le test se fait au centième.
  - [ ] Le CTA Genres est désactivé quand `canContinueFromGenres` est faux. Fonction pure
    `GenresStepView.isContinueEnabled(model)`.
- **Tests attendus :** `GenresStepLayoutTests` (XCTest). Le rendu est exercé par l'XCUITest de J.4.

#### J.3 — Écrans 1.3 et 1.4 Sous-genres
Écrans remplacés le 2026-10-18 par `docs/plans/ios-onboarding-accordion.md`.

- **Parent :** ONB · **Tier :** tier/2 · **Diff :** ~340 lignes, 5 fichiers · **Dépend de :** J.2 ·
  **Parallélisable :** non (même flux) · **pbxproj :** `0370–037F`.
- **Figma :** 1.3 `176:166` (spec `176:209`) et 1.4 `176:223` (spec `176:257`).
- **Portée :**
  - Dans `ios/Track1/Features/Onboarding/` : `SubgenresStepView.swift`, `ScrollTickDetector.swift`
    (nouveaux), et `OnboardingFlowView.swift` (étapes par parent).
  - `ios/Track1Tests/Profile/ScrollTickDetectorTests.swift` (nouveau).
  - pbxproj.
- **Contrat :**
  - `SubgenresStepView(parent:, model:)` :
    - nom du parent en `title2`, « Sélectionne les sous-genres qui t'intéressent » ;
    - `SelectAllChip`, puis une liste de `SubgenreRow` (définition sur 2 lignes) ;
    - `BottomActionBar` avec `model.ctaTitle` et le compteur
      `OnboardingCopy.counter(model.selectedSubgenreCount)`.
  - Le CTA est toujours actif sur une étape de sous-genres.
  - Une étape par parent, poussée dans l'ordre. Le retour par geste conserve la sélection.
  - Défilement : à chaque ligne qui passe sous le bord supérieur de la barre d'action, une haptique
    `.impact(weight: .light, intensity: 0.5)` et le son système 1104 (`AudioServicesPlaySystemSound`,
    muet en mode silencieux).
  - `enum ScrollTickDetector { static func crossings(rowMaxYs: [CGFloat], previousOffset: CGFloat, newOffset: CGFloat, threshold: CGFloat) -> Int }`
    est une fonction pure.
- **Critères d'acceptation :**
  - [ ] `crossings` vaut 0 sans franchissement, 1 pour une ligne franchie vers le haut et 2 pour
    deux lignes. Le défilement inverse compte aussi.
  - [ ] Sur le dernier parent, le CTA vaut « Terminer » (vérifié par `OnboardingFlowModel`, J.1).
    `onFinish` reçoit `makeDraft()`.
- **Tests attendus :** `ScrollTickDetectorTests` (XCTest). Le rendu est exercé en J.4.

#### J.4 — Brancher l'onboarding au lancement et l'enchaîner sur Aujourd'hui

- **Parent :** ONB · **Tier :** tier/2 · **Diff :** ~380 lignes, 6 fichiers · **Dépend de :** J.3,
  H.2 · **Parallélisable :** non · **pbxproj :** `0380–038F`.
- **Figma :** en-tête Flow 1 `176:51` ; 1.6 `176:326` (spec `176:338`, fondu vers Flow 2).
- **Portée :**
  - `ios/Track1/App/RootView.swift`.
  - `ios/Track1/Features/Onboarding/OnboardingFlowView.swift`.
  - `ios/Track1UITests/ProfileFlowTests.swift` (réécrit sur le nouveau parcours).
  - `ios/Track1UITests/UITestFlows.swift` (aide `completeOnboarding`).
  - `ios/Track1UITests/TodayFlowTests.swift` (utilise la nouvelle aide).
  - pbxproj si besoin.
- **Contrat :**
  - `RootView` :
    - consentement (inchangé) ;
    - sans profil : `OnboardingFlowView` en plein écran, sans onglets, avec la taxonomie lue sur
      `readers.catalog` (échec : `Track1StatusView(.todayUnavailable)` avec « Réessayer ») ;
    - `onFinish` : `ProfileStore` enregistre le brouillon, puis fondu (`Track1Motion.slow`, ou
      immédiat sous Reduce Motion) vers les onglets ;
    - Aujourd'hui affiche alors `RecommendationLoadingView` (= 1.6) jusqu'à la recommandation.
  - `ProfileMissingView` n'est plus atteignable (supprimé en L.2).
  - Les événements émis aujourd'hui par `OnboardingView` sont conservés, avec les mêmes noms et
    les mêmes propriétés. Aucun nouvel événement.
  - « Modifier les goûts » dans les réglages ouvre encore l'ancien `OnboardingView` jusqu'à K.1.
- **Critères d'acceptation (XCUITest sur fixtures) :**
  - [ ] Premier lancement :
    1. Consentement refusé.
    2. `onboarding-start`.
    3. Sans parent choisi, `onboarding-genres-continue` est désactivé. Choisir 2 parents.
    4. Sur la première étape, « Tous ».
    5. Sur la seconde, 1 sous-genre : le compteur affiche « Total : N genres ».
    6. « Terminer ».
    7. Aujourd'hui affiche `node-title`.
  - [ ] Relancer l'app ne remontre pas l'onboarding.
  - [ ] Le retour par geste de la seconde étape vers la première conserve la sélection.
  - [ ] Captures D7 « 1.1 », « 1.2a », « 1.2b », « 1.3 », « 1.4 », « 1.6 » jointes.
  - [ ] `TodayFlowTests`, `NavigationTests` et `ConsentTests` restent verts.
- **Tests attendus :** `ProfileFlowTests` réécrit (XCUITest, catalogue fixture à 2 parents
  reliés à leurs sous-genres par des arêtes `subgenres`, et à des œuvres par des arêtes `genres`).

### Partie K — Écrans non dessinés

#### K.1 — Onglet Genres, composition par défaut (Q3)

- **Parent :** ONB · **Tier :** tier/2 · **Diff :** ~350 lignes, 6 fichiers · **Dépend de :** J.3,
  G.1, et Q3 validée · **Parallélisable :** oui, avec K.2 · **pbxproj :** `0390–039F` (crée le
  groupe `Features/Genres`).
- **Figma :** spec 3.3 `178:776` (blocs suggérés) ; Genre tile `175:6` ; Tab bar Genres `173:74` ;
  IconButton `14:58` ; Icon More `13:9`.
- **Portée :**
  - `ios/Track1/Features/Genres/GenresTabView.swift` (nouveau).
  - `ios/Track1/App/RootView.swift` : la racine de l'onglet Genres devient `GenresTabView`.
  - `ios/Track1/Features/Onboarding/OnboardingFlowView.swift` : mode édition sans Welcome.
  - `ios/Track1/Features/Settings/SettingsView.swift` : « Modifier les goûts » ouvre le flux en
    édition.
  - `ios/Track1UITests/ProfileFlowTests.swift` (parcours d'édition).
  - pbxproj.
- **Contrat (défaut Q3) :**
  - `AmbientGlow(.ember)`, « Mes genres » en `title1`.
  - Grille des parents du profil en `GenreTile` sélectionnées, en lecture seule.
  - `Track1Button` Primary « Modifier mes genres » (`genres-edit`) : sheet
    `OnboardingFlowView(editing: profile)` avec les étapes 1.2 → 1.4 et un CTA final
    « Enregistrer ». Après l'enregistrement, Aujourd'hui recalcule avec la nouvelle révision (V1).
  - `Track1IconButton(.more, accessibilityLabel: "Réglages")` (`genres-settings`) : `SettingsView`
    en sheet.
- **Critères d'acceptation :**
  - [ ] XCUITest : l'onglet Genres affiche les parents du profil. « Modifier mes genres » →
    ajouter un parent → « Enregistrer » → Aujourd'hui affiche un `node-title` recalculé (révision
    changée).
  - [ ] `genres-settings` ouvre les réglages, et `analytics-settings` y est présent.
- **Tests attendus :** `ProfileFlowTests` (XCUITest). La logique d'édition est déjà couverte par
  `OnboardingFlowModelTests` (J.1).

#### K.2 — Habiller le consentement et les réglages (non dessinés)

- **Parent :** DS · **Tier :** tier/2 · **Diff :** ~260 lignes, 3 fichiers · **Dépend de :** B.2,
  C.1, C.2, Q4 · **Parallélisable :** oui · **pbxproj :** `03A0–03AF` (aucun fichier attendu).
- **Figma :** aucun écran. Composition (D14) d'Ambient glow `173:42`, Text `11:33`, Button `16:20`
  et ListItem `22:142`.
- **Portée :**
  - `ios/Track1/Features/Privacy/PrivacyChoiceView.swift`.
  - `ios/Track1/Features/Settings/SettingsView.swift`.
  - `ios/Track1UITests/ConsentTests.swift` si un libellé change.
- **Contrat :**
  - Consentement : `AmbientGlow(.ember)`, titre `title2`, texte `bodyMedium`, puis deux boutons.
    « Accepter » est un Button Primary Large, « Continuer sans partager » un Secondary Large.
  - Réglages : `ScrollView` de sections, titres `monoSection`, lignes `Track1ListItem` avec chevron
    s'il y a navigation. « Effacer le profil » s'affiche en `colorTextDanger`.
  - Tous les identifiants existants sont conservés : `analytics-consent-*`,
    `profile-settings-edit`, `analytics-settings`.
  - Plus aucune référence à `Track1Theme` dans ces deux fichiers.
- **Critères d'acceptation :**
  - [ ] `ConsentTests` reste vert sans changer d'identifiant.
  - [ ] `git grep Track1Theme` sur les deux fichiers ne trouve rien.
- **Tests attendus :** `ConsentTests` existant (XCUITest).

### Partie L — Nettoyage et livraison

#### L.1 — Supprimer les anciennes vues de relations et d'écoute

- **Parent :** DS · **Tier :** tier/2 · **Diff :** ~−400 lignes, 5 fichiers · **Dépend de :** H.1 ·
  **Parallélisable :** oui, avec H.2, H.3 et I.2 · **pbxproj :** `03B0–03BF` (suppressions
  seulement).
- **Figma :** aucun.
- **Portée :**
  - Supprimer `ios/Track1/Features/Node/NodeRelationsView.swift` et
    `ios/Track1/Features/Node/NodeListeningView.swift` (venu de la PR #330).
  - Traiter `ios/Track1Tests/Node/NodeRelationsTests.swift` : déplacer dans
    `NodeViewModelTests.swift` les cas qui testent `NodeAnalytics.relationOpened` ou le VM, et
    supprimer ceux de la vue supprimée.
  - Retirer leurs références du pbxproj.
  - `NodeArticleView.swift` et `NodeArticleTests.swift` sont **conservés** (D15).
- **Contrat :** suppressions et déplacements de tests seulement. Un test qui couvre du code encore
  vivant est conservé ou déplacé, jamais perdu.
- **Critères d'acceptation :**
  - [ ] `relation_opened` reste couvert par au moins un test.
  - [ ] `git grep -n "NodeRelationsView\|NodeListeningView" ios/` ne trouve rien.
  - [ ] `ios-check` est vert et `test/ios-no-webview.test.ts` passe.
- **Tests attendus :** `NodeViewModelTests` complété.

#### L.2 — Supprimer l'ancien onboarding et `Track1Theme`, verrouiller les jetons

- **Parent :** DS · **Tier :** tier/2 · **Diff :** ~−300 / +80 lignes, 6 fichiers · **Dépend de :**
  J.4, K.1, K.2, I.2, H.3 · **Parallélisable :** non (dernière tâche de
  code) · **pbxproj :** `03D0–03DF`.
- **Portée :**
  - Supprimer `ios/Track1/Features/Onboarding/OnboardingView.swift` (dont `ProfileMissingView`) et
    `ios/Track1/DesignSystem/Track1Theme.swift`.
  - pbxproj.
  - `test/ios-design-tokens.test.ts` (nouveau, vitest).
- **Contrat du test vitest :** aucun fichier de `ios/Track1/Features/` ni de `ios/Track1/App/` ne
  contient :
  - `Color(red:`, `Color(.sRGB`, `Color(hex`, `UIColor(red:` ;
  - `.font(.system`, `Font.system(` ;
  - `.font(.largeTitle|.title|.headline|.body|.caption|.footnote|.subheadline|.callout)` ;
  - `Track1Theme`.
- **Critères d'acceptation :**
  - [ ] Le test vitest passe sur `main` après suppression et échoue sur une ligne fautive ajoutée
    localement (preuve dans la PR).
  - [ ] `ios-check` est vert. `git grep -n "Track1Theme\|ProfileMissingView" ios/` ne trouve rien.
- **Tests attendus :** `test/ios-design-tokens.test.ts` (`npm run check`).

#### L.3 — Installer la V1 Figma sur l'iPhone et consigner la preuve (TRA-374 amendé)

- **Parent :** TRA-337 · **Tier :** tier/3 · **Diff :** ~140 lignes, 2 fichiers · **Dépend de :**
  toutes les tâches de code requises · **Parallélisable :** non.
- **Prérequis (Raphael) :** compte Apple Developer, iPhone enregistré, Team ID, et
  `TRACK1_API_BASE_URL` (D6).
- **Portée :**
  - `docs/track1-native-release.md` (nouveau).
  - `docs/track1-builds.md` : renvoi vers ce document.
- **Contenu attendu :**
  - le contenu prévu au plan V1 (prérequis, commande, installation, renouvellement, absences
    volontaires, tableau de preuve) ;
  - le **smoke Figma** (voir les critères de sortie) ;
  - le **relevé visuel** : pour chacun des 13 écrans dessinés et retenus (1.1, 1.2a, 1.2b, 1.3,
    1.4, 1.6, 2.1 à 2.5, 3.1, 3.2), le node-id Figma, une capture de l'iPhone, et « conforme » ou
    l'écart constaté.
- **Critères d'acceptation :**
  - [ ] Le tableau ne contient que des valeurs observées, sur un SHA de `main` postérieur à L.2.
  - [ ] Chaque étape du smoke est OK, ou un ticket de bug est ouvert pour chaque échec. Chaque
    écart visuel est accepté par Raphael ou fait l'objet d'un ticket.
  - [ ] Aucun `.p8`, `.p12`, `.mobileprovision` ni bloc `PRIVATE KEY`.
- **Tests attendus :** preuve manuelle. L'agent rédige, Raphael exécute et remplit.

## Risques

- **R1 — Runner unique et 31 PR.**
  - Garde-fous : tâches sous 400 lignes et 3 PR au plus.
  - XCUITest limités à trois parcours, et composants testés en XCTest pur.
  - Ordre : Partie A puis B.1 d'abord, car elles débloquent presque toutes les tâches d'interface.
  - Partie 0 vidée avant toute ouverture de PR.
- **R2 — pbxproj.**
  - Les groupes de composants sont créés une seule fois (B.1), et chaque tâche a sa plage.
  - Les lignes uniques se fusionnent par insertion.
  - Les composants d'un même sous-groupe provoquent des conflits mécaniques fréquents, à rebaser
    avant relecture.
- **R3 — Fidélité invérifiable dans le conteneur cloud.**
  - Les composants ne sont rendus qu'à partir de H.1 et J.4.
  - Garde-fous :
    - captures D7 jointes à l'xcresult ;
    - fonctions pures de style testées ;
    - relevé visuel sur iPhone en L.3.
  - Écart attendu : petits décalages de métriques de police. Ils sont tolérés s'ils sont listés
    dans L.3.
- **R4 — Polices et marques téléchargées depuis le cloud.**
  - Sources épinglées (URL, version, SHA-256) dans `Resources/Fonts/README.md`.
  - Échec réseau : arrêt de la tâche, jamais de substitution.
  - Les marques viennent du Figma (exports vectoriels), ce qui évite de passer par les portails
    des marques.
- **R5 — API iOS 26 et cible iOS 17.**
  - La CI n'exécute que le runtime 26.4 : les replis iOS 17 et 18 compilent mais ne s'exécutent
    pas.
  - Garde-fous : `#available` systématique et replis simples (matériaux standard).
  - Le relevé L.3 se fait sur l'iPhone de Raphael. Un appareil sous iOS 17 n'est pas disponible.
    Risque accepté.
- **R6 — Volume de `/image` vers la production.**
  - Un carrousel déclenche une lecture par carte, et le serveur peut résoudre par iTunes.
  - Garde-fous : chargement paresseux, cache mémoire, coalescence et échec mis en cache. Le volume
    reste négligeable pour un appareil.
- **R7 — Qualité des données.**
  - Des teasers sont coupés, et les faits rarement présents (souvent pas de bloc Faits).
  - Affichage tel quel ; correction dans le pipeline, hors plan.
- **R8 — Taxonomie dégradée.**
  - Remplacée le 2026-10-15 par `docs/plans/ios-onboarding-taxonomy.md`.
  - Les 31 « parents » sont calculés sur le cache, avec quelques racines inattendues (Comedy Music,
    Chicago house). C'est accepté pour la V1.
  - La taxonomie serveur (`genre-taxonomy.json`) n'est pas exposée par l'API mobile ; ce serait un
    projet distinct.
- **R9 — Fragilité des XCUITest (TRA-378).**
  - Trois parcours seulement, sans délai fixe : attentes sur identifiants.
  - En cas d'échec, lire l'xcresult avant tout correctif.
- **R10 — Sens analytique.**
  - Sans bouton « Découvrir », `daily_recommendation_opened` est émis à l'affichage de la fiche du
    jour, juste après `viewed`.
  - À reporter dans le plan de mesure à la reprise de TRA-315.
- **R11 — Réponses du gate.**
  - Q1 à Q6 conditionnent B.2, E.2, F.2, F.4, J.2 et K.1.
  - Un refus de Q3 retire K.1 sans impact : l'onglet Genres garde alors `SettingsView` comme
    racine (état de G.1).

## Critères de sortie

1. **Merges.** Sur `main`, la Partie 0 et les tâches A.1 à L.2 sont mergées (K.1 si Q3 est
   validée). `ios-check`, `test`, `lint` et `typecheck` sont verts après le dernier merge.
2. **Smoke Figma** consigné dans `docs/track1-native-release.md`, sur une archive Preview de `main`
   installée sur l'iPhone de Raphael :
   1. Premier lancement : le consentement s'affiche. Après un refus : Welcome (1.1), Genres (1.2,
      CTA désactivé sans sélection), une étape de sous-genres par parent avec « Tous » et le
      compteur, « Terminer », chargement (1.6), puis Aujourd'hui.
   2. Aujourd'hui affiche la date et la fiche du jour : héros, titre, sous-titre, teaser,
      sections, puis l'article et ses sources (D15). Une source s'ouvre dans Safari.
   3. Une chip pousse la fiche liée, avec fil d'Ariane et glow argent. Un crumb ramène en arrière,
      et re-toucher Aujourd'hui ramène à la fiche du jour.
   4. Spotify et Apple Music s'ouvrent depuis la barre d'écoute. Le retour dans track1 conserve la
      fiche. Une fiche genre ou label n'a pas de barre.
   5. La recherche s'ouvre en sheet. « ambient » ouvre une fiche dans l'onglet courant. Un
      résultat sans fiche est désactivé, sans création. Rouvrir la sheet montre la fiche dans les
      récents.
   6. Fermer et relancer le même jour redonne la même fiche. Modifier ses genres depuis l'onglet
      Genres en donne une nouvelle.
   7. En taille de texte XXXL, tous les CTA restent atteignables. Sous Reduce Motion, le fond
      Welcome est figé.
3. **Relevé visuel** des 13 écrans dessinés et retenus : chaque écart est accepté ou suivi par un
   ticket.
4. **Lecture seule (D2).** `ContentReaders` n'a aucun membre d'écriture, et
   `git grep createGeneration ios/Track1` ne trouve rien hors de `ios/Track1/API/APIClient.swift`.
5. **Jetons.** `test/ios-design-tokens.test.ts` et `test/ios-node-page-spec.test.ts` passent.
6. **Linear.** Les tickets en pause ont le sort indiqué. TRA-373, TRA-372, TRA-367 et TRA-374 sont
   amendés et fermés. TRA-347 est réécrit et fermé.
