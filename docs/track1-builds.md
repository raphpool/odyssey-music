# Exploitation des rappels track1

Les rappels Expo restent désactivés par défaut. Le serveur ne démarre le scheduler que si
`MOBILE_PUSH_ENABLED=true` et `EXPO_ACCESS_TOKEN` sont tous deux présents dans
`/etc/odyssey-music.env`. Ces deux valeurs sont des secrets serveur : elles ne vont jamais dans
le projet Expo, dans une réponse HTTP ou dans les journaux.

Le registre `MOBILE_STATE_DIR` est `/var/lib/track1-mobile` en production. Il est créé avec des
droits `0700` et exclu du rsync de déploiement : le remplacer viderait les réservations et ferait
perdre la preuve qu'une date locale a déjà été traitée. Le service reste mono-process ; ne pas
lancer une seconde unité serveur ni un cron parallèle.

## Activer après validation Expo

1. Créer ou vérifier les credentials Expo du projet, puis ajouter dans
   `/etc/odyssey-music.env` :

   ```sh
   MOBILE_PUSH_ENABLED=true
   EXPO_ACCESS_TOKEN=...
   ```

2. Déployer normalement avec `bash deploy/deploy-server.sh` et vérifier que
   `systemctl is-active odyssey-server.service` est actif.
3. Consulter `journalctl -u odyssey-server.service` pour les états techniques d'envoi et de
   receipt. Un receipt `ok` confirme seulement l'acceptation APNs/FCM, pas l'affichage ni la
   lecture.

Le scheduler s'exécute chaque minute et réserve avant tout appel Expo. Il n'envoie qu'entre 09:00
inclus et 10:00 exclu dans le fuseau de chaque téléphone ; il ne rattrape jamais une date après
10:00. Au redémarrage, une réservation durable n'est pas rejouée. Les tickets et receipts sont
purgés après 24 heures ; l'historique borné de 40 dates reste avec l'abonnement pour prévenir un
doublon lors d'un changement de fuseau.

## Désactiver ou revenir en arrière

Pour arrêter les nouveaux rappels sans toucher aux lectures musicales ni aux abonnements,
supprimer `MOBILE_PUSH_ENABLED=true` (ou mettre `false`) dans `/etc/odyssey-music.env`, puis
redémarrer `odyssey-server.service`. Conserver `MOBILE_STATE_DIR` : le supprimer est une perte de
l'historique de déduplication et exige une décision opérationnelle explicite.
