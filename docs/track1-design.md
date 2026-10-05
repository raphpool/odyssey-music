# Track1 — handoff iOS natif

Statut : handoff documentaire figé pour **TRA-327**, capturé le 5 octobre 2026.

Ce document transpose le fichier Figma validé vers les conventions iOS natives. Il ne
constitue ni une nouvelle conception, ni une licence d'assets, ni une spécification de
faits musicaux. Les captures associées sont des preuves datées de la référence visuelle;
le code Swift devra utiliser les composants système et les données du serveur.

## Source et périmètre

- Fichier Figma en lecture seule : [Track1 Design System](https://www.figma.com/design/phudxrQNlzQJafXLma4FyX/Track1-Design-System?node-id=28-3)
- Fichier : `phudxrQNlzQJafXLma4FyX`
- Matrice : `28:3` sur la page `28:2` (`Screens — iOS`)
- Patterns : `30:2`; barre : `30:72`; revue clair/sombre : `37:16`
- Manifeste et exports vérifiés : [`docs/design/track1/manifest.json`](design/track1/manifest.json)
- Captures : [`docs/design/track1/exports/`](design/track1/exports/)

La matrice contient seize frames iPhone de 393 × 852 points, avec leur étiquette de
référence. Les PNG du manifeste sont rendus `contentsOnly`, 421 × 914 pixels, le
05/10/2026 à 17:16 UTC. Leurs SHA-256, chemins et IDs Figma sont dans le manifeste;
la présence et le contenu non vide ont été contrôlés depuis le worktree.

## Inventaire 16/16

Chaque écran ci-dessous a un node ID, un export daté, un thème et un état. Les textes et
faits musicaux visibles dans les captures restent des fixtures de démonstration tant
qu'une réponse API ne les fournit pas.

| # | Écran / état figé | Node Figma | Thème de référence | Export |
| ---: | --- | --- | --- | --- |
| 1 | Consentement — `consent-choice` | `31:2` | Clair | [`01-consentement.png`](design/track1/exports/01-consentement.png) |
| 2 | Goûts musicaux — `taste-selection` | `31:27` | Clair | [`02-gouts.png`](design/track1/exports/02-gouts.png) |
| 3 | Invitation notifications — `notification-invitation-sheet` | `31:69` | Clair | [`03-invitation-push.png`](design/track1/exports/03-invitation-push.png) |
| 4 | Aujourd'hui — `today-ready` | `32:35` | Clair | [`04-aujourdhui.png`](design/track1/exports/04-aujourdhui.png) |
| 5 | Recherche — `search-results` | `32:69` | Clair | [`05-recherche.png`](design/track1/exports/05-recherche.png) |
| 6 | Réglages — `settings-profile-present` | `32:136` | Clair | [`06-reglages.png`](design/track1/exports/06-reglages.png) |
| 7 | Fiche artiste — `artist-detail-ready` | `34:144` | Clair | [`07-artiste.png`](design/track1/exports/07-artiste.png) |
| 8 | Fiche album — `album-detail-ready` | `34:197` | Clair | [`08-album.png`](design/track1/exports/08-album.png) |
| 9 | Fiche titre — `track-detail-ready` | `34:246` | Clair | [`09-titre.png`](design/track1/exports/09-titre.png) |
| 10 | Fiche genre — `genre-detail-ready` | `34:294` | Clair | [`10-genre.png`](design/track1/exports/10-genre.png) |
| 11 | Fiche label — `label-detail-ready` | `34:338` | Clair | [`11-label.png`](design/track1/exports/11-label.png) |
| 12 | Génération en cours — `generation-pending` | `35:260` | Clair | [`12-generation.png`](design/track1/exports/12-generation.png) |
| 13 | Chargement — `today-loading` | `35:275` | Clair | [`13-chargement.png`](design/track1/exports/13-chargement.png) |
| 14 | Hors ligne — `offline-with-local-cache` | `35:286` | Clair | [`14-hors-ligne.png`](design/track1/exports/14-hors-ligne.png) |
| 15 | Erreur génération — `generation-failed` | `35:308` | Clair | [`15-erreur-generation.png`](design/track1/exports/15-erreur-generation.png) |
| 16 | Profil absent — `profile-missing` | `35:326` | Clair | [`16-profil-absent.png`](design/track1/exports/16-profil-absent.png) |

Le fichier Figma expose une revue séparée de la barre dans les deux thèmes :
[`tabbar-review-light.png`](design/track1/exports/tabbar-review-light.png) (`37:17`)
et [`tabbar-review-dark.png`](design/track1/exports/tabbar-review-dark.png) (`37:18`).
Les écrans de la matrice sont des références clair; le mode sombre se déduit des tokens
sémantiques ci-dessous et doit être vérifié sur appareil, sans recolorer arbitrairement
la matrice.

## Tokens et adaptation SwiftUI

### Couleurs sémantiques

Les valeurs ci-dessous sont les fallbacks clair observés dans Figma. Le code iOS doit
référencer des rôles sémantiques (`Color.primary`, `Color.secondary`,
`Color(.systemBackground)`, etc.) afin que le mode sombre, le contraste augmenté et la
transparence réduite restent cohérents. Une valeur hexadécimale de la capture ne doit
pas devenir une couleur globale codée en dur.

| Token Figma | Clair observé | Adaptation native |
| --- | --- | --- |
| `theme.color.background.base` | `#ffffff` | `Color(.systemBackground)` |
| `theme.color.background.subtle` | `#f7f7f8` | `Color(.secondarySystemBackground)` ou surface de section |
| `theme.color.background.elevated` | `#ffffff` | surface de sheet native |
| `theme.color.surface.default` | `#ffffff` | `Color(.systemBackground)` |
| `theme.color.surface.selected` | `#d9ecff` | surface sélectionnée sémantique, jamais un tint arbitraire |
| `theme.color.surface.pressed` | `#efeff1` | `Color(.tertiarySystemFill)` |
| `theme.color.action.primary` | `#0d0d0f` | action principale contrastée; conserver le rôle |
| `theme.color.action.secondary` | `#efeff1` | bouton secondaire système |
| `theme.color.action.disabled` / `border.default` | `#dedee2` | état désactivé / bordure faible système |
| `theme.color.action.ghost` | transparent | `Button` borderless/ghost natif |
| `theme.color.border.strong` | `#a2a2a8` | bordure forte, à contrôler en contraste |
| `theme.color.border.focus` | `#0a84ff` | focus clavier/VoiceOver visible |
| `theme.color.text.primary` | `#0d0d0f` | `Color.primary` |
| `theme.color.text.secondary` | `#5e5e66` | `Color.secondary` |
| `theme.color.text.tertiary` | `#7c7c84` | `Color(.tertiaryLabel)` |
| `theme.color.text.action` | `#0073e6` | tint sémantique de l'action |
| `theme.color.text.inverse` | `#ffffff` | label sur action sombre |
| `theme.color.status.success-*` | `#dff8e9` / `#219a42` | `Label`/alerte de succès avec paire contrastée |
| `theme.color.status.danger-*` | `#ffe2e0` / `#d9342b` | erreur; ne parler de crédits que si l'API le confirme |
| `theme.color.overlay.scrim` | `rgba(0,0,0,.54)` | scrim de sheet système |

La revue `37:16` confirme pour la barre sombre un bord `rgba(255,255,255,.26)`, une
surface sélectionnée `rgba(255,255,255,.26)`, un texte actif `#7fc0ff` et un texte
secondaire `#c7c7cc`. Pour la barre claire, la surface de la barre est `#ffffffc7`
(environ `.78`), tandis que la surface sélectionnée et la bordure sont `#ffffff85`
(environ `.52`); le texte actif reste `#0073e6`. Ces valeurs restent des preuves du
token Liquid Glass; elles ne justifient pas une implémentation manuelle du verre.

### Espacements, tailles et rayons

- Espacements employés : `2`, `4`, `6`, `8`, `10`, `12`, `16`, `20`, `24`, `32`,
  `40`, `48` et `64` points.
- Rayons : `12`, `16`, `20` et `full`; le composant TabBar utilise une surface de
  `34` et des segments de `28`.
- Artwork : `48` points (petit), `96` points (grand); le cercle est réservé aux
  identités/artistes et le carré aux sorties ou états indisponibles.
- Cibles tactiles : chaque action atteint au moins `44 × 44` points. Les boutons
  visuels de `52` ou `60` points, les ChoiceChips de `44` et les segments de `56`
  respectent déjà ce minimum; une zone de hit native ne doit pas être réduite pour
  suivre un glyph visuel.
- Les cartes et listes restent dans les conteneurs système afin que Dynamic Type,
  RTL et les textes longs puissent augmenter leur hauteur.

### Typographie et symboles

Figma emploie Inter pour les styles nommés. La cible iOS est explicitement la police
système et Dynamic Type; cette substitution est une adaptation native du ticket, pas un
redesign. Correspondance de départ :

| Style Figma | Mesure observée | SwiftUI sémantique |
| --- | --- | --- |
| `Title/1` | 28 / 34, gras | `.title` avec poids `.bold` |
| `Title/2` | 22 / 28, gras | `.title2` avec poids `.bold` |
| `Body/Large` | 17 / 25 | `.body` |
| `Body/Medium` | 15 / 22 | `.subheadline` |
| `Body/Small` | 13 / 18 | `.footnote` |
| `Label/Large` | 17 / 22, semi-gras | `.headline` |
| `Label/Medium` | 15 / 20, semi-gras | `.subheadline.weight(.semibold)` |
| `Label/Small` | 13 / 16, semi-gras | `.footnote.weight(.semibold)` |
| `Caption/Regular` | 12 / 16 | `.caption` |

Les icônes sont des noms SF Symbols, jamais des codepoints ni des SVG distants dans le
client : `face.smiling` (Aujourd'hui), `magnifyingglass` (Recherche),
`slider.horizontal.3` (Réglages), `chevron.right` (relation), `ellipsis` (action
secondaire) et `music.note` (fallback Artwork). Le pictogramme de confidentialité
`31:7` est une illustration Figma de référence; sa licence de redistribution n'est
pas établie et il ne doit pas être transformé en asset de production par ce ticket.
Le manifeste liste les sources et le statut de droits.

## Composants et primitives natives

Les IDs des composants sont ceux exposés par le nœud Patterns `30:2` ou par la matrice.
Le composant SwiftUI conserve le rôle et l'accessibilité; il ne recopie pas le JSX ou
les positions absolues de l'export.

| Composant Figma | Node | Adaptation native figée |
| --- | --- | --- |
| `Button` | `16:20` | `Button` SwiftUI, label explicite, style primary/secondary/ghost; hit target ≥ 44 |
| `ChoiceChip` | `30:10` | groupe de `Button`/`Picker` sélectionnable, état vocalisé, 44 points |
| `Card` | `19:101` | carte dans le flux; artwork dynamique fourni par le catalogue, pas la fixture Figma |
| `Artwork` | `18:2` | `AsyncImage`/placeholder déterministe, états default/loading/unavailable |
| `TabBar` | `30:72` | `TabView` avec trois destinations et état de sélection natif |
| `SearchField` | `30:21` | `.searchable` ou `TextField` natif selon la route; focus et clavier système |
| `ListItem` | `22:142` | `List`/`NavigationLink` selon la présence d'une relation; pas de chevron inventé |
| `_Icon` | `14:2` | SF Symbols nommés ci-dessus, avec label VoiceOver adapté |
| `Toggle` | `30:26` | `Toggle` SwiftUI; le rappel reste indépendant de l'analytics et du profil |
| `DetailHero` | `33:14` | en-tête de fiche avec Artwork, type, titre et sous-titre; Dynamic Type |

Sur iOS 26+, `TabView`, `Toolbar`, `sheet` et les contrôles système reçoivent leurs
matériaux natifs. Sur iOS 17/18, conserver exactement la structure et les états, avec
`Material`/surface standard disponible sur la version, sans shader ni faux verre. Si
`Reduce Transparency` est actif, préférer une surface opaque lisible et une bordure
visible. La barre garde sa zone sûre de `393 × 83` points dans les deux variantes.

### Contrat d'interaction par composant

Cette table complète la table de mapping : elle donne le comportement attendu sans
ajouter de mouvement au design. Toute durée indique le maximum visuel; une opération
réseau reste pilotée par son état réel.

| Composant | Déclencheur | État final | Interruption | Durée / courbe | Variante accessible et repli iOS 17/18 |
| --- | --- | --- | --- | --- | --- |
| `Button` | tap, clavier ou VoiceOver | action effectuée ou route poussée | relâchement annule le press; route interactive annulable | press `150 ms easeOut`; navigation système | label vocalisé, ≥ 44 pt; `Button` standard |
| `ChoiceChip` | tap/activation en mode goûts multi-sélection | le seul chip ciblé est ajouté ou retiré et le compteur est mis à jour; les autres choix restent inchangés | une activation interrompue conserve l'ensemble précédent; aucun autre chip n'est retiré | `150 ms easeOut` | trait `.isSelected`, texte agrandi; `Button` natif avec sélection additive (un `Picker` mono uniquement pour un filtre explicitement configuré ainsi) |
| `Card` | tap seulement si la carte est annoncée actionable | détail de la recommandation ouvert | retour ou swipe-back annule la transition | transition `NavigationStack` système | titre, type et source dans l'accessibility label; `NavigationLink` |
| `Artwork` | apparition et réponse de l'image | image autorisée, fallback ou unavailable | annulation de tâche retire la réponse tardive | fondu d'état `200 ms easeInOut` | label d'image/fallback; `AsyncImage` disponible dès iOS 15 |
| `TabBar` | tap d'un onglet | sélection et pile de l'onglet restaurées | la dernière sélection explicite gagne | `TabView` système | rôles d'onglet et état sélectionné; `TabView` iOS 17 |
| `SearchField` | focus, saisie, validation ou effacement | résultats filtrés localement ou en ligne | effacement/annulation invalide la recherche en vol | changement de résultats `200 ms easeInOut` | label, focus et bouton clear; `.searchable` iOS 17 |
| `ListItem` | tap seulement avec relation ou destination | fiche destination ouverte | swipe-back/retour annule | navigation système | ligne et chevron vocalisés; `List`/`NavigationLink` |
| `_Icon` | activation seulement s'il porte une action | action du propriétaire déclenchée | relâchement annule le press | `150 ms easeOut` si press visible | nom SF Symbol et label; rendu SF Symbols iOS 17 |
| `Toggle` | tap/activation clavier ou VoiceOver | préférence persistée on/off | réponse ou effacement local peut rétablir l'état | changement système | `Toggle` avec valeur annoncée; contrôle iOS 17 |
| `DetailHero` | entrée dans la fiche ou scroll | titre, type, artwork et sous-titre visibles | retour annule l'entrée interactive | entrée système; pas de parallaxe | ordre VoiceOver et Dynamic Type; `VStack`/`ScrollView` |

## Navigation et états

### Parcours

1. `Consentement` collecte séparément la mesure d'usage; accepter ou continuer sans
   partager ne bloque pas la suite et reste modifiable dans `Réglages`.
2. `Goûts musicaux` persiste les genres sur l'iPhone. Trois genres sont le minimum
   lorsque le catalogue en propose assez; `Explorer sans profil` mène à Recherche.
3. Après la première découverte, `Invitation notifications` est une vraie `sheet`
   native. Activer le rappel demande ensuite la permission système; refuser ou choisir
   « Plus tard » laisse Aujourd'hui utilisable.
4. `TabView` expose les piles indépendantes `Aujourd'hui`, `Recherche` et `Réglages`.
   Un changement d'onglet conserve la pile de l'onglet quitté.
5. Les fiches artiste/album/titre/genre/label utilisent une `NavigationStack` et des
   `List`/`NavigationLink` pour les relations. Les liens Spotify/Apple Music sont
   validés par l'API et l'hôte autorisé avant ouverture externe.
6. Une fiche absente peut ouvrir le suivi de génération. Le suivi reprend après
   fermeture; un cache local permet de relire les fiches déjà acquises hors ligne.

### Correspondance des états

| État | Source visuelle | Contrat natif |
| --- | --- | --- |
| Profil absent | `35:326` | choix des goûts ou recherche; aucune création de compte imposée |
| Aujourd'hui prêt | `32:35` | recommandation reçue; le texte explicatif vient de la donnée réelle |
| Chargement | `35:275` | skeleton et message court; aucune progression fictive ni boucle décorative |
| Génération en cours | `35:260` | état serveur `pending`/progression réellement fournie; quitter laisse la tâche suivre |
| Génération interrompue | `35:308` | erreur serveur typée, retry idempotent; le mot « crédits » seulement si le code réel le confirme |
| Hors ligne | `35:286` | découverte et dernières fiches conservées lisibles; recherche locale autorisée; création interdite hors réseau |
| Recherche | `32:69` | résultats du catalogue local ou distant; « 8 résultats » est une fixture, pas un seuil |
| Consentement / réglages | `31:2`, `32:136` | préférences indépendantes; effacement explicite et réversible avant confirmation |

Les chaînes telles que « Kind of Blue », « Miles Davis », « In a Silent Way », les
années, le nombre de résultats et « Étape 2 sur 3 » sont des exemples de composition
Figma. Elles ne doivent pas devenir des constantes de recommandation, des étapes
obligatoires ou une progression serveur. Le serveur est la source des identités,
relations, descriptions, codes d'erreur et états de génération.

## Mouvements et variantes accessibles

Le design ne fournit pas de timeline d'animation. Les règles ci-dessous figent donc les
adaptations natives convenues; elles ne demandent pas de nouvelle validation Figma.

| Composant / mouvement | Déclencheur | État final | Interruption | Normal | Reduce Motion / transparence réduite | Repli iOS 17/18 |
| --- | --- | --- | --- | --- | --- | --- |
| Navigation `NavigationStack` | tap d'une relation, retour, swipe-back | fiche/pile cible ou pile précédente | geste inverse annule; nouvelle intention remplace la précédente | transition système Apple, courbe système | fondu `100 ms` ou immédiat; pas de déplacement décoratif | `NavigationStack` standard, même pile et mêmes labels |
| Sheet notification | tap de l'invitation | sheet présentée, puis permission système si activée | drag ou « Plus tard » ferme; permission refusée laisse la route | présentation/dismiss système | fondu `100 ms` ou immédiat | `.sheet` standard avec handle et scrim système |
| TabBar / changement d'onglet | tap d'un des trois onglets | destination sélectionnée, pile conservée | dernière sélection explicite gagne | `TabView` + matériau natif; aucune animation custom | changement immédiat; surface opaque si transparence réduite | `TabView` standard avec `Material` standard |
| ChoiceChip / Toggle / Button | tap ou activation clavier/VoiceOver | sélection, valeur ou état pressé visible | relâchement ou nouvelle valeur gagne | micro-interaction `150 ms`, `easeOut` | `100 ms` ou immédiat, sans boucle | contrôles SwiftUI natifs |
| Transition d'état (loading → ready/error) | réponse serveur/couche cache | contenu final correspondant à l'état réel | nouvelle réponse remplace l'ancienne; annulation invalide la tâche locale | fondu `200 ms`, `easeInOut` | fondu `100 ms` ou remplacement immédiat | `withAnimation` conditionné à `accessibilityReduceMotion` |
| Skeleton | entrée en chargement | placeholder stable jusqu'à réponse | réponse/annulation retire le skeleton | aucune pulsation obligatoire; si utilisée, courte et bornée | statique, sans boucle | rectangles statiques et accessibles |
| Liquid Glass | composition de la TabBar | surface lisible, segment actif élevé | changement de thème/onglet recalcule le rôle | matériau iOS 26 natif | opaque/moins translucide selon réglage | `ultraThinMaterial` ou surface système, sans shader |

Les boutons principaux et les rows restent atteignables à `44 pt` minimum avec VoiceOver,
Switch Control, clavier et texte agrandi. Les titres et descriptions peuvent se développer
verticalement; aucune position absolue de l'export ne doit couper le contenu. Le contraste
doit être contrôlé avec les rôles clair/sombre et `Increase Contrast`; les couleurs
présentées dans le tableau des tokens sont des références, pas une dispense de test dans
le client.

## Assets, provenance et droits

Le manifeste est l'index unique des exports et des composants. Les captures ont été
téléchargées depuis le rendu Figma du node indiqué, vérifiées par type PNG, dimensions et
SHA-256, puis conservées sous `docs/design/track1/exports/`. Les URLs `/api/mcp/asset/`
Figma sont temporaires et ne sont pas référencées par le code.

Le téléchargement de la matrice a trouvé zéro image source brute et des SVG temporaires
pour les glyphs/illustrations. Cela ne donne aucun droit de redistribution. Les références
musicales visibles servent à vérifier hiérarchie et états; les pochettes de production
devront venir d'une source HTTPS autorisée, validée par l'API et par le ticket de droits
approprié. Un lien tiers non validé ne doit jamais être placé dans un `href`.

Le code natif réutilise les SF Symbols nommés et les composants système, pas les PNG de
preuve ni une URL Figma. L'illustration de confidentialité peut rester une forme système
accessible jusqu'à ce qu'un asset sous licence soit fourni; elle ne doit pas être extraite
de cette capture pour contourner la procédure de droits.

## Vérifications documentaires réalisées

- Les 16 node IDs imposés par TRA-327 ont été lus depuis la matrice et figurent une seule
  fois dans `manifest.json`.
- Les 16 exports datés et les deux captures de revue clair/sombre existent, sont non vides,
  en PNG, avec leurs dimensions et SHA-256 dans le manifeste.
- Le composant TabBar et ses trois états de sélection ont été confrontés aux revues
  `37:17`/`37:18`; les tokens clair/sombre sont explicités.
- Les cibles de boutons, chips, segments et rows ont été vérifiées dans les dimensions
  Figma; la règle native de hit target `44 pt` et le support du texte agrandi sont écrits
  pour la réalisation Swift.
- Les transitions, interruptions, durées/courbes, variantes Reduce Motion/Transparency et
  replis iOS 17/18 sont couverts par le tableau des mouvements.
- Aucun fichier Swift, Figma ou site n'a été modifié; aucun fait musical de la matrice n'est
  déclaré comme règle produit.
