# Track1 — mode d'emploi TestFlight

Ce document est la liste de ce que Raphael prépare côté Apple et côté GitHub, parce qu'aucun
agent ne peut le créer (certificat, profil, clé d'API, Environment, secrets, groupes de
testeurs). C'est aussi la référence de l'agent qui lance les envois. Il ne contient aucune
valeur de secret et aucune URL d'API réelle : partout où une valeur est attendue, il écrit un
nom ou un `<repère>`.

Décisions (plan `track1-v1`, D5, arbitrage de Raphael du 2026-11-16) :

- Signature **manuelle** : certificat Apple Distribution et profil App Store dans un trousseau
  temporaire du runner, envoi par une clé d'API App Store Connect. Ni signature automatique, ni
  `fastlane`.
- L'Environment GitHub `testflight` **n'a pas de relecteur requis** et **n'accepte que des
  déploiements depuis `main`**.
- Deux groupes TestFlight : un groupe **interne** (Raphael, builds disponibles sans revue Apple)
  et un groupe **externe** (amis, lien public, après la revue bêta d'Apple). Raphael teste
  d'abord sur le groupe interne.

Ordre à suivre : sections 1 à 3, **puis** section 4. En particulier, créer l'Environment
`testflight` (3.1) avant le premier lancement du workflow.

Les noms de menus Apple ci-dessous suivent l'interface en anglais. Apple les renomme parfois :
si un libellé a changé, suivre l'intitulé le plus proche et corriger ce document.

## 1. Côté Apple

Prérequis : un compte du programme Apple Developer actif. Le rôle Account Holder ou Admin est
nécessaire pour créer le certificat et la clé d'API.

### 1.1 Team ID

1. Ouvrir <https://developer.apple.com/account> et se connecter.
2. Cliquer sur **Membership details** (ou **Membership**).
3. Relever **Team ID** : 10 caractères, majuscules et chiffres. Il servira à la variable
   `TRACK1_TEAM_ID` (section 3).

### 1.2 Identifiant d'app et fiche App Store Connect

1. Sur <https://developer.apple.com/account>, ouvrir **Certificates, Identifiers & Profiles**,
   puis **Identifiers**.
2. Cliquer sur **+**, choisir **App IDs**, puis **Continue**, puis **App**, puis **Continue**.
3. Renseigner **Description** (par exemple `Track1`).
4. Dans **Bundle ID**, choisir **Explicit** et saisir `com.dropcliffs.track1`.
5. Ne cocher aucune capability, sauf si un ticket l'exige (les rappels de v1 sont des
   notifications locales : aucune capability n'est requise). Cliquer sur **Continue**, puis
   **Register**.
6. Ouvrir <https://appstoreconnect.apple.com>, puis **Apps**.
7. Cliquer sur **+**, puis **New App**.
8. Renseigner : **Platforms** = iOS ; **Name** = le nom affiché dans l'App Store (unique sur
   toute l'App Store : Apple peut le refuser, en choisir alors un autre) ; **Primary
   Language** = French ; **Bundle ID** = `com.dropcliffs.track1` (liste déroulante, alimentée
   par l'étape 5) ; **SKU** = une chaîne libre et unique (par exemple `track1-ios`) ; **User
   Access** = Full Access.
9. Cliquer sur **Create**.

### 1.3 Certificat Apple Distribution (`.p12`)

Ces étapes se font sur un Mac, dans l'application **Keychain Access**.

1. Ouvrir **Keychain Access**, menu **Keychain Access**, puis **Certificate Assistant**, puis
   **Request a Certificate From a Certificate Authority…**.
2. Renseigner **User Email Address** et **Common Name**. Laisser **CA Email Address** vide.
   Choisir **Saved to disk**, puis **Continue**, et enregistrer le fichier `.certSigningRequest`.
3. Sur <https://developer.apple.com/account>, ouvrir **Certificates, Identifiers & Profiles**,
   puis **Certificates**.
4. Cliquer sur **+**, choisir **Apple Distribution** (pas **Apple Development**), puis
   **Continue**.
5. Cliquer sur **Choose File**, sélectionner le fichier `.certSigningRequest`, puis **Continue**.
6. Cliquer sur **Download** : on obtient un fichier `.cer`.
7. Double-cliquer sur le `.cer` pour l'installer dans le trousseau **login**.
8. Dans **Keychain Access**, ouvrir **login**, puis la catégorie **My Certificates**.
9. Repérer **Apple Distribution: <nom>** et le déplier : une clé privée doit apparaître en
   dessous. Sans clé privée, l'export est inutilisable : refaire l'étape 1 sur ce Mac.
10. Clic droit sur le certificat (la ligne du certificat, pas la clé), puis **Export…**.
11. Choisir le format **Personal Information Exchange (.p12)** et enregistrer.
12. Saisir un mot de passe d'export. Il servira au secret `IOS_DIST_CERT_PASSWORD` (section 3) :
    le garder dans un gestionnaire de mots de passe, il n'est pas récupérable.

Un certificat Apple Distribution expire après un an. Noter la date d'expiration : à cette date,
les envois échoueront (section 6).

### 1.4 Profil de provisionnement App Store

1. Sur <https://developer.apple.com/account>, ouvrir **Certificates, Identifiers & Profiles**,
   puis **Profiles**.
2. Cliquer sur **+**.
3. Sous **Distribution**, choisir **App Store Connect**, puis **Continue**.
4. Dans **App ID**, choisir `com.dropcliffs.track1`, puis **Continue**.
5. Cocher le certificat Apple Distribution créé en 1.3, puis **Continue**.
6. Dans **Provisioning Profile Name**, saisir un nom sans ambiguïté, par exemple
   `Track1 App Store`, puis **Generate**.
7. Cliquer sur **Download** : on obtient un fichier `.mobileprovision`.
8. **Relever le nom exact**, caractère pour caractère (casse, espaces). Il servira à la variable
   `TRACK1_APPSTORE_PROFILE_NAME` (section 3) ; un nom légèrement différent fait échouer la
   signature (section 6).

Si le certificat est révoqué ou recréé, le profil devient invalide : le régénérer (ouvrir le
profil, **Edit**, recocher le nouveau certificat, **Save**, retélécharger) et remettre à jour le
secret `IOS_APPSTORE_PROFILE_BASE64`.

### 1.5 Clé d'API App Store Connect (rôle App Manager)

1. Ouvrir <https://appstoreconnect.apple.com>, puis **Users and Access**.
2. Ouvrir l'onglet **Integrations**, puis **App Store Connect API**, puis **Team Keys**. Si la
   page demande de **Request Access**, le faire (action réservée à l'Account Holder).
3. Cliquer sur **+** (ou **Generate API Key**).
4. Renseigner **Name** (par exemple `track1-github-actions`) et **Access** = **App Manager**,
   puis **Generate**.
5. Relever le **Key ID** de la nouvelle ligne : il servira au secret `ASC_API_KEY_ID`.
6. Relever l'**Issuer ID**, affiché en haut de la page : il servira au secret
   `ASC_API_ISSUER_ID`.
7. Cliquer sur **Download API Key** : on obtient `AuthKey_<Key ID>.p8`. **Le téléchargement n'est
   possible qu'une seule fois** ; sauvegarder le fichier dans un gestionnaire de mots de passe.

## 2. Groupes TestFlight

Dans <https://appstoreconnect.apple.com>, ouvrir **Apps**, puis l'app Track1, puis l'onglet
**TestFlight**.

### 2.1 Groupe interne, distribution automatique

1. Dans la barre latérale, à côté de **Internal Testing**, cliquer sur **+**.
2. Saisir le nom `Interne` (ou un nom équivalent).
3. Cocher **Enable automatic distribution** (si la case n'est pas proposée à la création, ouvrir
   le groupe, onglet **Builds**, et l'activer là). Chaque build traitée est alors disponible dans
   ce groupe sans revue Apple.
4. Ouvrir le groupe, section **Testers**, cliquer sur **+**, cocher Raphael et valider. Un testeur
   interne doit être un utilisateur de l'équipe App Store Connect (**Users and Access**).
5. Sur l'iPhone de Raphael, installer l'app **TestFlight** et se connecter avec le même Apple ID.

### 2.2 Groupe externe, vide

1. Dans la barre latérale, à côté de **External Testing**, cliquer sur **+**.
2. Saisir le nom `Amis` (ou un nom équivalent) et valider.
3. **Ne rien ajouter** : ni testeur, ni build. Ce groupe s'ouvre à la section 5.

### 2.3 Informations de test

1. Dans la barre latérale de l'onglet **TestFlight**, ouvrir **Test Information**.
2. Renseigner **Beta App Description** : ce que fait Track1 et ce qu'on attend des testeurs.
3. Renseigner **Feedback Email** : l'adresse où les testeurs écrivent.
4. Renseigner les champs de contact demandés (prénom, nom, téléphone, e-mail) et, si Apple le
   demande, les informations de connexion de test. Si l'app n'a pas de connexion (profil
   local), l'indiquer : aucune connexion n'est requise.
5. Cliquer sur **Save**. Ces informations sont exigées avant la revue bêta (section 5).

## 3. Côté GitHub

Dépôt : `raphpool/odyssey-music`.

### 3.1 Environment `testflight`

À créer **avant** le premier lancement du workflow. Si le workflow tourne d'abord, GitHub crée
l'Environment tout seul, sans la règle « `main` seulement ».

1. Ouvrir le dépôt sur GitHub, puis **Settings**, puis **Environments**.
2. Cliquer sur **New environment**, saisir `testflight`, puis **Configure environment**.
3. **Ne pas cocher** **Required reviewers**. Décision D5 : l'Environment n'a pas de relecteur
   requis, pour que l'agent lance les envois lui-même.
4. Laisser **Wait timer** désactivé.
5. Dans **Deployment branches and tags**, ouvrir la liste et choisir **Selected branches and
   tags**.
6. Cliquer sur **Add deployment branch or tag rule**, choisir **Ref type** = **Branch**, saisir
   le motif `main`, puis **Add rule**.
7. Vérifier que `main` est la seule règle. Sans relecteur, les secrets ne sont protégés que par
   trois choses : l'Environment n'accepte que `main`, le workflow n'a que `workflow_dispatch`, et
   toute PR sous `.github/` passe la review profonde. Ne retirer aucune des trois.

### 3.2 Les six secrets

Dans l'Environment `testflight`, section **Environment secrets**, cliquer sur **Add environment
secret** pour chacun des six noms ci-dessous. Les noms doivent être exacts.

| Secret | Contenu |
| --- | --- |
| `IOS_DIST_CERT_P12_BASE64` | Le `.p12` de 1.3, encodé en base64 |
| `IOS_DIST_CERT_PASSWORD` | Le mot de passe d'export choisi en 1.3 (étape 12) |
| `IOS_APPSTORE_PROFILE_BASE64` | Le `.mobileprovision` de 1.4, encodé en base64 |
| `ASC_API_KEY_P8_BASE64` | Le `.p8` de 1.5, encodé en base64 |
| `ASC_API_KEY_ID` | Le Key ID de 1.5 |
| `ASC_API_ISSUER_ID` | L'Issuer ID de 1.5 |

Ne jamais mettre ces valeurs dans un fichier du dépôt, une issue, un ticket ou un message.

### 3.3 Les trois variables

Dans l'Environment `testflight`, section **Environment variables**, cliquer sur **Add environment
variable** pour chacune.

| Variable | Contenu |
| --- | --- |
| `TRACK1_TEAM_ID` | Le Team ID de 1.1 (10 caractères, majuscules et chiffres) |
| `TRACK1_API_BASE_URL` | L'URL de base de l'API, en `https://`, **terminée par `/mobile/v1`** |
| `TRACK1_APPSTORE_PROFILE_NAME` | Le nom exact du profil relevé en 1.4 (étape 8) |

`TRACK1_API_BASE_URL` a la forme `https://<hôte-de-l-api>/mobile/v1` : sans port, sans
identifiants, sans paramètre de requête, sans domaine en `.example`. L'application refuse au
lancement tout autre chemin, après avoir été archivée et signée : le script d'envoi la refuse
donc avant.

### 3.4 Encoder les fichiers en base64

Depuis un terminal macOS, dans le dossier qui contient les fichiers. Chaque commande copie le
résultat dans le presse-papiers sans l'afficher, sur une seule ligne ; coller ensuite dans le
champ **Value** du secret.

```sh
# IOS_DIST_CERT_P12_BASE64
base64 -i <certificat>.p12 | tr -d '\n' | pbcopy

# IOS_APPSTORE_PROFILE_BASE64
base64 -i <profil>.mobileprovision | tr -d '\n' | pbcopy

# ASC_API_KEY_P8_BASE64
base64 -i AuthKey_<Key ID>.p8 | tr -d '\n' | pbcopy
```

Les secrets `IOS_DIST_CERT_PASSWORD`, `ASC_API_KEY_ID` et `ASC_API_ISSUER_ID` se collent tels
quels, sans encodage. Une fois les trois secrets créés, supprimer le contenu du presse-papiers et
ne pas laisser de copie des fichiers hors du gestionnaire de mots de passe.

### 3.5 Réglage du dépôt : approbation des contributeurs externes

1. Ouvrir **Settings**, puis **Actions**, puis **General**.
2. Dans **Fork pull request workflows from outside collaborators**, choisir **Require approval
   for all external contributors**, puis **Save**. Le dépôt est public : sans ce réglage, une PR
   de fork peut lancer des workflows sans approbation. Les workflows de PR ont été réactivés par
   `enable-workflows.yml` (TRA-784) : faire ce réglage maintenant, s'il ne l'est pas déjà. L'état
   courant des workflows se lit dans **Actions** ou avec `gh workflow list --all`.

## 4. Lancer un envoi

Le workflow `ios-testflight` (`.github/workflows/ios-testflight.yml`, tickets TRA-729 et
TRA-775) est sur `main`. Il n'a que le déclencheur `workflow_dispatch`, sans entrée. Son job
`testflight` ne s'exécute que sur `main` (`github.ref == 'refs/heads/main'`). Il utilise
l'Environment `testflight` et tourne sur `macos-26`. Il n'attend aucune approbation : l'Environment
n'a pas de relecteur requis. Un seul run à la fois : un second lancement attend la fin du
premier. Ne pas en lancer un troisième pendant ce temps : GitHub annule le run en attente.

Préconditions :

- les sections 1 à 3 sont terminées ;
- l'Environment `testflight` existe, avec la règle `main` seulement, ses six secrets et ses trois
  variables (3.1 à 3.3) : il doit être créé **avant** le premier lancement ;
- le code à envoyer est sur `main`.

Le job enchaîne cinq étapes :

1. **Select Xcode** : sélectionne le Xcode épinglé dans `ios/.xcode-version` et refuse un autre.
2. **Install signing material** : crée un trousseau temporaire, importe le certificat, installe le
   profil et la clé d'API.
3. **Archive and upload** : lance `ios/scripts/testflight.sh` avec `TRACK1_UPLOAD=1`. Le script
   archive l'app en Production, contrôle l'`.app` de l'archive, puis exporte et envoie la build à
   App Store Connect.
4. **Remove signing material** : supprime le trousseau, le `.p12`, la clé et le profil. Cette
   étape s'exécute même si une étape précédente a échoué.
5. **Job summary** : écrit le résumé du run.

### 4.1 Par l'agent

1. Appeler l'outil MCP GitHub `actions_run_trigger` avec `method` = `run_workflow`,
   `owner` = `raphpool`, `repo` = `odyssey-music`, `workflow_id` = `ios-testflight.yml`,
   `ref` = `main`. Ne passer aucune entrée.
2. Suivre le run avec `actions_list` (`list_workflow_runs`, puis `list_workflow_jobs`).

### 4.2 Par Raphael

1. Ouvrir le dépôt sur GitHub, puis **Actions**.
2. Choisir **ios-testflight** dans la liste de gauche.
3. Cliquer sur **Run workflow**, laisser **Branch: main**, puis **Run workflow**.

### 4.3 Lire le résultat

1. Ouvrir le run, puis le job `testflight`. Il est coupé au bout de 60 minutes (`timeout-minutes`).
   La durée réelle n'est pas encore mesurée : le premier run la donne.
2. Ouvrir le **Summary** du run, titre « TestFlight upload ». Il liste trois valeurs : **Git SHA**
   (le commit envoyé), **Version** (la version de l'app) et **Build** (le numéro de build). Le
   numéro de build est un horodatage UTC `YYYYMMDDHHMM` : deux envois dans la même minute auraient
   le même numéro et le second serait refusé. Si une valeur manque dans le résumé, la lire dans le
   journal de l'étape « Archive and upload » (lignes `Git SHA:`, `Version:`, `Build:`).
3. Un run vert signifie que l'envoi à App Store Connect est accepté, pas que la build est
   installable. Apple traite ensuite la build : compter quelques minutes, parfois plus.
4. Si la build reste en **Missing Compliance**, elle n'est pas proposée aux testeurs. L'`Info.plist`
   déclare pourtant `ITSAppUsesNonExemptEncryption` à `false` (TRA-707). Ouvrir un ticket. En
   attendant, répondre à la question à la main sur la build, dans App Store Connect.
5. Dans App Store Connect, onglet **TestFlight**, la build apparaît sous **Builds**, puis dans le
   groupe interne (distribution automatique). Elle est alors installable depuis l'app **TestFlight**
   de Raphael, sans revue Apple.

## 5. Ouvrir le groupe externe

À faire seulement après que Raphael a installé et testé la build sur le groupe interne.

1. Dans App Store Connect, ouvrir l'app Track1, onglet **TestFlight**.
2. Ouvrir le groupe externe (`Amis`, section 2.2).
3. Ouvrir l'onglet **Builds**, cliquer sur **+**, choisir **la build testée** (même numéro que sur
   le groupe interne), puis **Next**.
4. Renseigner **What to Test** : ce que les amis doivent essayer.
5. Vérifier que **Test Information** (section 2.3) est complet, puis cliquer sur **Submit for
   Review** (revue bêta d'Apple). Le statut passe à **Waiting for Review**, puis **In Review**,
   puis **Approved**.
6. Attendre **Approved**. Tant que la revue n'est pas terminée, les testeurs externes ne reçoivent
   pas la build.
7. Quand la build est approuvée, ouvrir le groupe externe, section **Public Link**, cliquer sur
   **Enable Public Link**.
8. Fixer le nombre maximal de testeurs (**Tester Limit**) et valider.
9. Copier le lien public (de la forme `https://testflight.apple.com/join/<code>`) et le partager.
   Ne pas le publier dans le dépôt.
10. Pour couper l'accès : ouvrir le groupe externe, **Public Link**, puis **Disable Public Link**.

## 6. Lire un échec

Ouvrir le run en échec, puis le job `testflight`, puis l'étape en rouge. Les messages exacts
varient selon la version de Xcode : les formulations ci-dessous sont indicatives.

### 6.1 Le job ne démarre pas

| Symptôme | À vérifier |
| --- | --- |
| Le job est ignoré (`skipped`) | Le run a été lancé depuis une autre branche que `main` : la garde du job le saute. |
| Le job est rejeté avec un message sur la branche ou l'Environment | La règle de déploiement de l'Environment `testflight` (3.1, étapes 5 à 7) : elle doit autoriser `main`. |
| Le job attend une approbation | Quelqu'un a coché **Required reviewers** sur l'Environment : le décocher (décision D5). |
| Le run échoue sur des valeurs vides (import du `.p12`, `decoded to an empty file`, `... is required`) | L'Environment a peut-être été créé par GitHub au premier run : il n'a alors ni secrets, ni variables, ni règle `main`. Ouvrir **Settings**, **Environments**, `testflight` : ajouter la règle `main` (3.1, étapes 5 à 7), créer les secrets et les variables (3.2, 3.3), puis relancer. |
| Un secret est vide dans les journaux | Le secret a été créé au niveau du dépôt et non de l'Environment, ou son nom est écrit différemment : 3.2. |

### 6.2 Refus avant la compilation

Les messages ci-dessous sortent de l'étape « Select Xcode » ou du script d'envoi
(`ios/scripts/testflight.sh`, tickets TRA-718 et TRA-764). Le script refuse un lancement mal
configuré en nommant la variable fautive, avant de compiler.

| Message | À vérifier |
| --- | --- |
| `TRACK1_API_BASE_URL must end with /mobile/v1` | La variable `TRACK1_API_BASE_URL` de l'Environment (3.3). |
| `TRACK1_API_BASE_URL must not end with .example` | La variable porte encore une valeur de substitution. |
| `TRACK1_API_BASE_URL is required.` | La variable est absente ou vide dans l'Environment (3.3). |
| Autre message `TRACK1_API_BASE_URL must ...` | L'URL doit être en `https://`, avec un hôte à points, sans identifiants, sans port, sans paramètre de requête, sans fragment, avec un chemin simple (3.3). |
| `TRACK1_TEAM_ID is required and must be a 10-character Apple Team ID` | Exactement 10 caractères A-Z et 0-9 (1.1). |
| `TRACK1_PROFILE_NAME is required` | La variable `TRACK1_APPSTORE_PROFILE_NAME` est absente ou vide (3.3). Le script l'appelle `TRACK1_PROFILE_NAME`. |
| `TRACK1_PROFILE_NAME must not contain a dollar sign` | Le nom du profil contient un `$` : renommer le profil (1.4) et corriger la variable. |
| `ASC_KEY_ID is required` ou `ASC_ISSUER_ID is required` | Le secret `ASC_API_KEY_ID` ou `ASC_API_ISSUER_ID` est absent ou vide (3.2). |
| `The git working tree has uncommitted changes` | Une étape précédente a modifié un fichier : ouvrir un ticket. |
| `<app> not found for the pin` ou `the pin is '...' but ...` (« Select Xcode »), ou `Expected Xcode ... but xcodebuild selected ...` | L'image `macos-26` n'a plus le Xcode épinglé : ouvrir un ticket pour déplacer le pin. Le pin est dans `ios/.xcode-version`, actuellement `Xcode 26.4.1 (17E202)` (TRA-787). |
| `cannot read an Xcode version from ios/.xcode-version` (« Select Xcode ») | Le fichier `ios/.xcode-version` est mal formé : ouvrir un ticket. |

Après l'archive et avant l'export, le script contrôle l'`.app` de l'archive. Il vérifie
l'identifiant signé, l'équipe signataire et l'URL d'API embarquée. Un échec arrête le run avant
tout envoi.

| Message | À vérifier |
| --- | --- |
| `The archived app is signed as '<id>', expected 'com.dropcliffs.track1'` | Le profil et l'identifiant d'app (1.2, 1.4). |
| `The archived app is signed by team '<équipe>', expected '<Team ID>'` | `TRACK1_TEAM_ID` est l'équipe qui possède le certificat et le profil (1.1). |
| `The archived app embeds API URL '<url>', expected '<url>'` | Défaut de l'app ou du script : ouvrir un ticket. |
| `Expected exactly one .app in <archive>` | L'archive est vide ou inattendue : ouvrir un ticket. |

### 6.3 Erreurs de signature

À l'étape « Install signing material » ou à l'étape « Archive and upload ».

| Message | À vérifier |
| --- | --- |
| `the profile or the API key decoded to an empty file` | Le secret `IOS_APPSTORE_PROFILE_BASE64` ou `ASC_API_KEY_P8_BASE64` est vide, ou n'est pas dans l'Environment (3.2, 3.4). |
| Import du `.p12` refusé, `MAC verification failed`, mot de passe incorrect ou secret vide | `IOS_DIST_CERT_PASSWORD` correspond au mot de passe saisi à l'export (1.3, étape 12) ; le secret base64 n'est pas tronqué (une seule ligne, sans espace). |
| `No signing certificate "Apple Distribution" found` | Le `.p12` contient bien un certificat **Apple Distribution** (pas **Apple Development**) **et sa clé privée** : l'export doit partir de **My Certificates** (1.3, étapes 8 à 11). |
| Certificat expiré ou révoqué | Date d'expiration du certificat (1.3). En créer un nouveau, régénérer le profil (1.4), remplacer les secrets. |
| `Code signing is required for product type 'Application'` | Le `.p12` n'a pas été importé : voir les deux lignes précédentes. |

### 6.4 Erreurs de profil

L'étape « Install signing material » écrit le profil sous le nom `track1-appstore.mobileprovision`
dans les deux dossiers :

- `~/Library/MobileDevice/Provisioning Profiles` ;
- `~/Library/Developer/Xcode/UserData/Provisioning Profiles`.

Xcode 16 a déplacé les profils vers `UserData` et peut encore lire l'ancien dossier : le workflow
installe donc les deux. L'étape « Remove signing material » supprime le profil des deux dossiers.
Le nom du fichier est sans effet : `TRACK1_APPSTORE_PROFILE_NAME` désigne le nom du profil dans le
portail Apple (1.4, étape 6).

| Message | À vérifier |
| --- | --- |
| `No profile for team '<Team ID>' matching '<nom>' found` | `TRACK1_APPSTORE_PROFILE_NAME` est identique, caractère pour caractère, au nom du profil (1.4, étape 8) ; `IOS_APPSTORE_PROFILE_BASE64` est le profil à jour. |
| `No profile for team '<Team ID>' matching '<nom>' found`, alors que le nom est exact | Vérifier que « Install signing material » est vert. L'installation dans les deux dossiers n'a pas encore tourné sur un Mac hébergé : le premier run la confirme. Si l'erreur reste, ouvrir un ticket avec le message. |
| `Provisioning profile "<nom>" doesn't include signing certificate` | Le profil n'a pas été généré avec le certificat présent dans le `.p12` : régénérer le profil avec le bon certificat (1.4). |
| `doesn't match the bundle identifier` | Le profil a été créé pour un autre identifiant que `com.dropcliffs.track1` (1.2, 1.4). |
| Profil expiré ou `Invalid` | Ouvrir le profil dans le portail Apple, **Edit**, **Save**, retélécharger, remplacer `IOS_APPSTORE_PROFILE_BASE64`. |
| `Team ID` du profil différent | `TRACK1_TEAM_ID` ne correspond pas à l'équipe qui possède le profil (1.1). |

### 6.5 Erreurs de validation ou d'envoi App Store Connect

À l'étape « Archive and upload », pendant l'export : avec l'envoi, la même commande exporte et
envoie la build. Le script a contrôlé l'`.app` de l'archive, pas le binaire envoyé : l'export
re-signe l'app.

| Message | À vérifier |
| --- | --- |
| `401`, `Authentication credentials are missing or invalid` | `ASC_API_KEY_ID` et `ASC_API_ISSUER_ID` ne sont pas inversés ; la clé n'est pas révoquée (**Users and Access**, **Integrations**) ; son rôle est **App Manager** ; le `.p8` est celui de ce Key ID. |
| `No app found with the specified bundle identifier` | La fiche App Store Connect existe pour `com.dropcliffs.track1` (1.2, étapes 6 à 9). |
| `The bundle version must be higher than the previously uploaded version` | Deux envois dans la même minute, ou un numéro de build déjà pris : relancer une minute plus tard. |
| `ITMS-90xxx` ou `ITMS-91xxx` (`Missing ...`, `Invalid ...`) | Le code `ITMS` désigne la règle d'Apple ; lire le texte qui suit. Les causes courantes : clé manquante dans l'`Info.plist`, manifeste de confidentialité incomplet (TRA-707 en a ajouté un), icône manquante ou invalide. C'est un défaut de l'app, pas de la configuration : ouvrir un ticket avec le code. |
| L'envoi réussit mais la build n'apparaît pas | Attendre le traitement d'Apple ; chercher un e-mail d'Apple dans la boîte de l'Account Holder (rejet après traitement). |
| La build apparaît mais pas dans le groupe interne | La distribution automatique est cochée sur le groupe interne (2.1, étape 3) et Raphael y est testeur (2.1, étape 4). |

### 6.6 Après un échec

1. Corriger la cause dans la configuration (sections 1 à 3) quand c'est une configuration, ou
   ouvrir un ticket quand c'est le code ou le workflow.
2. Relancer l'envoi (section 4). Ne pas contourner : ni relecteur ou branche ajoutés à
   l'Environment, ni lancement depuis une autre branche, ni secret collé hors de l'Environment.
