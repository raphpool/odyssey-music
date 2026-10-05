# Track1 — builds natifs et exploitation des rappels

État capturé le **2026-10-05** pour TRA-353. La cible officielle est désormais le client
iOS natif sous `ios/`, dont le projet et les archives sont livrés par les tâches natives
suivantes. Le client Expo/React Native sous `mobile/` est gelé comme référence historique.
Il n'existe pas de build Expo public ou de preuve TestFlight/App Store Connect dans les
éléments vérifiés ci-dessous.

## Cible officielle iOS

- Un seul client officiel : `ios/` (SwiftUI, minimum iOS 17 dans le plan natif).
- Les builds EAS ci-dessous sont des artefacts de développement internes. Ils ne prouvent
  ni le fonctionnement Swift ni une sortie publique.
- Les profils, caches et demandes locales des testeurs Expo ne sont pas migrés vers le
  client natif. Une réinitialisation locale est attendue à l'installation native ; aucun
  transfert de données n'est ajouté par TRA-353.
- L'archivage et la fermeture du chemin Expo sont une étape ultérieure et contrôlée
  (P6.3 / TRA-354). Jusqu'à sa vérification, conserver les sources et les scénarios utiles,
  sans présenter Expo comme une deuxième application officielle.

## Artefacts Expo historiques de TRA-290

Source de configuration et de preuves : branche
`rdoulonne/tra-290-distribuer-des-builds-natifs-de-developpement-sur-les-deux`, commit
`ca57d01cc6035d1a035ee49fed393f6ee1a8ab56`. Le projet EAS est `@track1app/track1`
(`4635ac06-d13d-43ac-98fa-593fa4cd4252`), propriété de l'organisation `track1app`.
Les identifiants publics vérifiés sont `com.dropcliffs.track1` en production,
`com.dropcliffs.track1.development` en développement et
`com.dropcliffs.track1.preview` en prévisualisation. Expo SDK 57, iOS 16.4 minimum et
Android API 24 minimum étaient configurés ; SecureStore et Notifications étaient les seuls
plugins natifs déclarés, sans permission audio.

| SHA du code | Profil | Plateforme | Version / build | Artefact vérifié | Résultat observé |
| --- | --- | --- | --- | --- | --- |
| `5c452d8e7ec5bfe2cf5a79d2d41ca8acf30fe406` | development | iOS | `1.0.0 (1)` | [Build EAS](https://expo.dev/accounts/track1app/projects/track1/builds/2787eeb9-719a-4400-abf5-96b6961015b9) · [IPA](https://expo.dev/artifacts/eas/az2QmmUHb49ev2AIxrrZRxoZPSwg0u2D_oKIbZeKVKs.ipa) | Build `2787eeb9-719a-4400-abf5-96b6961015b9` terminé le 2026-09-28 ; installation iPhone et ouverture des trois onglets validées via Metro tunnel avec les variables publiques requises. |
| `88acd880e0d8ffcf9bd8b924b4f4c91c6ae6271f` | development | Android | `1.0.0 (1)` | [Build EAS](https://expo.dev/accounts/track1app/projects/track1/builds/2ee0cbc2-31ff-4097-a0c9-319658fcce29) · [APK](https://expo.dev/artifacts/eas/0-Bq5K9ciOV1p0cvATVU2D8MSRLTSteraRA00KTi7o4.apk) | Build `2ee0cbc2-31ff-4097-a0c9-319658fcce29` terminé le 2026-09-27 ; installation et vérification des trois onglets sur appareil Android non exécutées. |

Les assets réutilisables de cette branche sont `mobile/assets/icon.png` et
`mobile/assets/notification-icon.png`, introduits par `88acd88`. Aucun certificat, clé
privée, credential ou fichier de signature n'est versionné. La fiche App Store Connect,
un bundle TestFlight distribué ou une URL de sortie publique n'ont pas été trouvés dans la
preuve accessible : ces éléments restent à établir dans les tickets natifs de publication,
sans transformer leur absence en réussite.

## Rappels et transport historique

Les rappels Expo restent désactivés par défaut et ne constituent pas le transport du client
officiel. Le serveur ne démarre le scheduler historique que si `MOBILE_PUSH_ENABLED=true` et
`EXPO_ACCESS_TOKEN` sont tous deux présents dans `/etc/odyssey-music.env`. Ces valeurs sont
des secrets serveur : elles ne vont jamais dans le projet Expo, dans une réponse HTTP ou dans
les journaux. TRA-353 ne les active ni ne les désactive.

Le registre `MOBILE_STATE_DIR` est `/var/lib/track1-mobile` en production. Il est créé avec
des droits `0700` et exclu du rsync de déploiement : le remplacer viderait les réservations
et ferait perdre la preuve qu'une date locale a déjà été traitée. Le service reste
mono-process ; ne pas lancer une seconde unité serveur ni un cron parallèle.

Le scheduler s'exécute chaque minute et réserve avant tout appel Expo. Il n'envoie qu'entre
09:00 inclus et 10:00 exclu dans le fuseau de chaque téléphone ; il ne rattrape jamais une
date après 10:00. Au redémarrage, une réservation durable n'est pas rejouée. Les tickets et
receipts sont purgés après 24 heures ; l'historique borné de 40 dates reste avec l'abonnement
pour prévenir un doublon lors d'un changement de fuseau. Le transport APNs natif et sa
recette sont définis séparément dans P3.

Pour arrêter les nouveaux rappels historiques sans toucher aux lectures musicales ni aux
abonnements, retirer `MOBILE_PUSH_ENABLED=true` (ou mettre `false`) dans
`/etc/odyssey-music.env`, puis redémarrer `odyssey-server.service`. Conserver
`MOBILE_STATE_DIR` : le supprimer est une perte de l'historique de déduplication et exige une
décision opérationnelle explicite.
