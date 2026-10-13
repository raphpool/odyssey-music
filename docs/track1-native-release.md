# Track1 iOS — installer la V1 sur l'iPhone et consigner la preuve

Recette de TRA-374 (L.3, parent TRA-337) : archiver une build Preview de `main`, l'installer sur
l'iPhone de Raphael, puis consigner le smoke Figma, le relevé visuel des 13 écrans et la preuve.
Les cellules à remplir sont **vides à dessein** : seules des valeurs réellement observées y vont, et
la PR n'est mergée qu'une fois le document rempli.

Plans : `docs/plans/track1-ios-figma.md` (L.3, critères de sortie) et `docs/plans/track1-ios-v1-basic.md`
(partie 5). Contrôles CI : `docs/track1-builds.md`.

## 1. Prérequis (Raphael)

1. **Compte Apple Developer** connecté dans Xcode : Xcode > Settings > Accounts, bouton `+`. L'équipe
   doit apparaître dans la liste.
2. **Team ID** : 10 caractères A-Z et 0-9, affichés sur developer.apple.com > Account > Membership
   details, et dans Xcode > Settings > Accounts en sélectionnant l'équipe.
3. **iPhone enregistré dans l'équipe.** Le brancher, le déverrouiller, accepter « Faire confiance à
   cet ordinateur », puis ouvrir Xcode > Window > Devices and Simulators : il doit apparaître sans
   avertissement. Avec la signature automatique, Xcode l'enregistre dans l'équipe à l'archive.
4. **Mode développeur sur l'iPhone** : Réglages > Confidentialité et sécurité > Mode développeur,
   activer, redémarrer, confirmer (la ligne n'apparaît qu'après un branchement à Xcode). iOS 17 minimum.
5. **Xcode** : la version exacte de `ios/.xcode-version` (`Xcode 26.4 (17E192)`), sinon le script
   s'arrête (`xcode-select -p` indique l'Xcode actif).
6. **Dépôt propre sur `main` à jour** : `git checkout main && git pull`, sans fichier modifié ni non
   suivi. Le SHA archivé est celui de `HEAD`.
7. **URL de l'API** : `https://dropcliffs.com/api/odyssey/mobile/v1` (doit finir par `/mobile/v1`).

## 2. Archive

Depuis la racine du dépôt :

```sh
TRACK1_TEAM_ID=<Team ID> TRACK1_API_BASE_URL=https://dropcliffs.com/api/odyssey/mobile/v1 ios/scripts/archive.sh
```

Argument optionnel : un dossier de sortie hors du dépôt (par défaut `${TMPDIR}`). Le script ne lit
aucun secret ; l'URL est injectée dans l'`Info.plist` à l'archive, jamais écrite dans le dépôt.

Le script valide le Team ID, l'URL, la version d'Xcode et la propreté de l'arbre, puis lance
`xcodebuild archive` (schéma `Track1Preview`, configuration `Preview`, signature automatique,
`-allowProvisioningUpdates`) et `xcodebuild -exportArchive` (méthode `release-testing`, c'est-à-dire
ad hoc, avec `-allowProvisioningUpdates`). Le numéro de build est `date -u +%Y%m%d%H%M`. Il vérifie
enfin l'IPA : bundle `com.dropcliffs.track1.preview`, Team ID de la signature, URL embarquée.

**Durée.** Non mesurée (aucune archive exécutée à la rédaction) : quelques minutes, plus la première
résolution des paquets Swift. À renseigner au §6. **Sorties.** Un dossier neuf `track1-archive.XXXXXX` sous le dossier de sortie, contenant
`Track1Preview.xcarchive`, `export/<nom>.ipa` et `ExportOptions-Preview.plist`. En cas de succès, les
cinq dernières lignes affichées sont :

```text
Git SHA:  <sha de HEAD>
Version:  <CFBundleShortVersionString>
Build:    <CFBundleVersion>
API URL:  <URL embarquée>
IPA:      <chemin complet de l'.ipa>
```

**Erreurs courantes.**

| Message ou symptôme | Remède |
| --- | --- |
| `TRACK1_TEAM_ID is required…` ou `TRACK1_API_BASE_URL must …` | Variable absente ou mal formée : recopier le Team ID et l'URL du §1. |
| `Expected Xcode 26.4 (17E192) but xcodebuild selected …` | Sélectionner le bon Xcode : `sudo xcode-select -s /Applications/<Xcode>.app`. |
| `The git working tree has uncommitted changes` | Committer, ou `git stash -u`, ou archiver depuis un clone propre. |
| Profil de provisioning manquant, « No profiles for … », appareil absent du profil | `-allowProvisioningUpdates` est déjà passé aux deux appels `xcodebuild` : Xcode crée et met à jour le profil seul, à condition que le compte soit connecté (§1.1) et l'iPhone branché et connu de l'équipe (§1.3). Relancer après correction. |
| `Expected exactly one IPA in …` | L'export a échoué avant l'IPA : lire les messages `xcodebuild -exportArchive` juste au-dessus. |
| `signed as …` ou `signed by team …` incohérent | Mauvais Team ID ou mauvais compte actif dans Xcode : recommencer avec le bon. |
Remèdes Apple (compte, appareil, profil) non exécutés : à compléter au besoin.

## 3. Installation sur l'iPhone

**Avec Xcode.** iPhone branché et déverrouillé : Window > Devices and Simulators > Devices, choisir
l'iPhone, puis glisser l'`.ipa` (chemin affiché par le script) dans la liste « Installed Apps », ou
bouton `+` et sélection du fichier. L'app « track1 » apparaît sur l'écran d'accueil.

**Avec Apple Configurator** (App Store Mac) : double-cliquer l'iPhone, Add > Apps > Choose from my
Mac, sélectionner l'`.ipa`. Si l'app est déjà installée, Configurator propose de la remplacer.

**Premier lancement.** Si iOS refuse l'ouverture (« Développeur d'entreprise non approuvé » ou
équivalent) : Réglages > Général > VPN et gestion de l'appareil, toucher le profil développeur, puis
« Faire confiance ». Si l'iPhone demande le mode développeur, voir §1.4.
Pour rejouer le premier lancement, supprimer d'abord l'app de l'iPhone (une réinstallation garde ses données).

## 4. Smoke Figma

À exécuter sur l'app installée, dans l'ordre. Une étape est OK ou KO ; chaque KO obtient un ticket
de bug (colonne « ticket »). Les colonnes « observé », « OK/KO » et « ticket » sont à remplir.

| # | Étape | Attendu | Observé | OK/KO | Ticket |
| --- | --- | --- | --- | --- | --- |
| 1 | Premier lancement, puis refus | Le choix analytics s'affiche ; après le refus, l'app reste utilisable (Welcome 1.1). | | | |
| 2 | Onboarding 1.2 | Genres affichés ; CTA désactivé sans sélection. Choisir 3 genres. | | | |
| 3 | Onboarding 1.3 → 1.4 | Une étape de sous-genres par parent, « Tous » et compteur ; « Terminer » à la fin. | | | |
| 4 | Chargement 1.6 | L'écran de chargement s'affiche, puis Aujourd'hui. | | | |
| 5 | Fiche du jour | Date, héros, titre, sous-titre, teaser, sections, puis article et sources ; la découverte donne ses raisons. | | | |
| 6 | Source | Toucher une source ouvre Safari ; le retour ramène dans track1. | | | |
| 7 | Relation | Une chip pousse la fiche liée, avec fil d'Ariane et glow argent. | | | |
| 8 | Retour | Un crumb ramène en arrière ; re-toucher Aujourd'hui ramène à la fiche du jour. | | | |
| 9 | Spotify et Apple Music | Chacun s'ouvre dans l'application installée, ou sur le site sinon ; le retour conserve la fiche. | | | |
| 10 | Genre ou label | Une fiche genre ou label n'a pas de barre d'écoute. | | | |
| 11 | Recherche (sheet) | La recherche s'ouvre en sheet ; « ambient » (filtre Genres) ouvre une fiche dans l'onglet courant. | | | |
| 12 | Résultat sans fiche | Il est désactivé et signalé, sans création. | | | |
| 13 | Récents | Rouvrir la sheet montre la fiche ouverte dans les récents. | | | |
| 14 | Onglet Genres | La grille montre les genres parents du profil. | | | |
| 15 | Relance le même jour | Fermer l'app (la balayer) et la relancer redonne la même découverte. | | | |
| 16 | Modifier les genres | « Modifier mes genres » rouvre 1.2 → 1.4 avec « Enregistrer » ; Aujourd'hui donne une nouvelle découverte. | | | |
| 17 | Texte XXXL | Réglages > Accessibilité > Taille du texte : tous les CTA restent atteignables. | | | |
| 18 | Reduce Motion | Réglages > Accessibilité > Mouvement : le fond de Welcome est figé. | | | |

**Lecture seule (D2).** `git grep createGeneration ios/Track1` ne doit rien trouver (le pathspec
exclut `ios/Track1Core`, où vit `APIClient`). Sur `5439b7a` à la rédaction : aucune ligne. À refaire
sur le SHA archivé : sortie observée : ........ (vide si conforme) ; SHA : ........

## 5. Relevé visuel des 13 écrans

Fichier Figma `phudxrQNlzQJafXLma4FyX` ; URL d'un écran :
`https://www.figma.com/design/phudxrQNlzQJafXLma4FyX/track1?node-id=<id avec - au lieu de :>`.
Pour chaque écran : comparer la capture de l'iPhone au Figma, puis écrire « conforme » ou l'écart.
Un écart est accepté par Raphael (le dire) ou suivi par un ticket.

| Écran | Node-id Figma | Capture (iPhone) | Conforme, ou écart constaté | Accepté / ticket |
| --- | --- | --- | --- | --- |
| 1.1 Welcome | `176:56` | | | |
| 1.2a Genres | `176:80` | | | |
| 1.2b Genres | `176:122` | | | |
| 1.3 Sous-genres | `176:166` | | | |
| 1.4 Sous-genres | `176:223` | | | |
| 1.6 Chargement | `176:326` | | | |
| 2.1 | `177:22` | | | |
| 2.2 | `177:266` | | | |
| 2.3 | `177:417` | | | |
| 2.4 | `177:685` | | | |
| 2.5 | `177:931` | | | |
| 3.1 Recherche | `178:68` | | | |
| 3.2 Navigation | `178:610` | | | |

Node-ids tirés de `docs/plans/track1-ios-figma.md` ; les intitulés des écrans 2.x sont dans le Figma.

### Points à regarder en priorité

Écarts connus de la nuit du 2026-10-13, **acceptés par défaut** : à confirmer à l'œil, ou à
transformer en ticket.

| Point | Écart accepté par défaut | Vu sur l'iPhone | Décision |
| --- | --- | --- | --- |
| Bouton Secondary | Contraste du bouton et état désactivé à 42 %. | | |
| Fond de Welcome | Voile à 62 %. | | |
| Héros | Glyphes du disque et du boîtier redessinés. | | |
| Logos Apple Music et Spotify | Aux couleurs de marque (provisoires, voir TRA-439). | | |
| Chips | Hauteur de 34 pt contre 36 pt au Figma. | | |
| Interligne | Appliqué sur une seule ligne. | | |

## 6. Tableau de preuve

Valeurs tirées du script, de l'iPhone ou de `git` ; aucune n'est préremplie.

| Champ | Valeur observée |
| --- | --- |
| Date et heure (UTC) | |
| SHA de `main` archivé (`Git SHA` du script) | |
| Ce SHA contient le merge de L.2 (oui/non) | |
| Version (`Version`) | |
| Build (`Build`) | |
| Bundle | |
| Team ID | |
| URL d'API embarquée (`API URL`) | |
| Durée de l'archive | |
| Modèle d'iPhone | |
| Version d'iOS | |
| Chemin de l'IPA | |

Ne jamais ajouter au dépôt de `.p8`, `.p12`, `.mobileprovision` ni de bloc de clé privée : le script
ne lit ni n'écrit aucun secret, et l'IPA reste hors du dépôt.

## 7. Renouvellement

- **Profils.** Gérés par Xcode : `-allowProvisioningUpdates` (archive et export) crée et renouvelle
  les profils automatiquement, tant que le compte est connecté.
- **Expiration.** Un profil ad hoc (`release-testing`) expire (le délai dépend du compte Apple) ;
  l'app installée cesse alors de s'ouvrir. Remède : relancer le script (§2) et réinstaller l'IPA (§3).
- **Nouvel appareil.** Le brancher et l'enregistrer dans l'équipe (§1.3), puis refaire une archive :
  un profil existant ne couvre pas un appareil ajouté ensuite.
- **Changement d'hôte d'API.** Nouvelle archive avec un autre `TRACK1_API_BASE_URL`, sans changement
  de code. L'URL doit rester en `https`, sur un hôte à points, et finir par `/mobile/v1`.

## 8. Absences volontaires de la V1

- **APNs** : pas de notifications push ni de rappels dans cette build.
- **TestFlight** : pas de distribution TestFlight ni App Store Connect ; installation ad hoc.
- **Clé Segment** : l'`Info.plist` ne porte aucune clé `Track1SegmentWriteKey`, donc l'adaptateur
  Segment n'est pas créé et la build n'envoie aucun événement, même si le choix analytics s'affiche.
  La clé sera fournie plus tard, par un ticket dédié.
