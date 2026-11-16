# track1 — partage d'une œuvre par lien (reporté)

Extrait le 2026-11-16 de `docs/plans/track1-v1.md` sur arbitrage de Raphael : le partage avec lien
(P2) sort du plan v1 et attend un domaine. **Aucun ticket Linear n'existe pour ce plan.** Le texte
ci-dessous est celui du plan v1 au moment de l'extraction, sans modification ; les numéros de
tâches (`5.8`, `5.9`) renvoient au plan v1.

## Ce qui bloque

- Aucun domaine n'est choisi (Q8 du plan v1 : « pas de domaine pour l'instant »). La racine du
  domaine doit pouvoir servir `/.well-known/apple-app-site-association`.
- Un nouveau profil de provisionnement avec la capacité Associated Domains sera à fournir.
- Le lecteur de la v1 (`PlayerView`) est livré sans bouton partager ; il prend déjà une identité de
  nœud, ce qui permet au lien entrant d'ouvrir la même destination.

## Décision d'archi

### Partage : lien universel `https` vers une page web servie par le serveur

Le lien partagé est une URL `https://<hôte>/…/s/<type>/<slug>` : sans l'app, elle affiche une page
web avec le contenu du nœud ; avec l'app, iOS l'ouvre dans le lecteur (Associated Domains).
`ShareLink` (dans `Track1Core`) construit et relit l'URL ; une URL entrante est une donnée non
fiable, validée avant usage.

**Rejeté :** schéma `track1://` (illisible sans l'app, non cliquable dans la plupart des
messageries, aucune page de repli alors que la spec demande « une page avec ce contenu ») ; un
service tiers de liens (dépendance et données de partage chez un tiers).

## Découpage

### Partie unique — Partage avec lien

Incrément : le bouton partager du lecteur envoie un lien qui ouvre une page web, ou l'app si elle
est installée. Prérequis : domaine et fichier `apple-app-site-association` (Q8).

- [ ] TRA-? **8.1 — Core · Construire et relire un lien de partage `ShareLink`** — P2, tier/2, 1 pt, ∥.
  - Portée : créer `ios/Track1Core/Sources/Track1Core/Navigation/ShareLink.swift` et son test ;
    `ios/Track1Core/Sources/Track1Core/App/AppConfiguration.swift` (`shareBaseURL`, clé
    `Track1ShareBaseURL`, mêmes règles `https` que l'URL d'API).
  - Contrat : `public enum ShareLink { public static func url(for: NodeIdentity, base: URL) -> URL?; public static func identity(from: URL, base: URL) -> NodeIdentity? }`
    — chemin `/s/<type>/<slug>` ; `nil` hors projets et morceaux, hôte différent, chemin inattendu.
- [ ] TRA-? **8.2 — Serveur · Rendu HTML de la page de partage** — P2, tier/2, 2 pts, ∥.
  - Portée : créer `src/mobile/share-page.ts` et `test/mobile/share-page.test.ts` : fonction pure
    nœud → HTML (titre, artistes, pochette, phrases de l'article, liens d'écoute), tout échappé,
    URLs validées par hôte.
- [ ] TRA-? **8.3 — Serveur · Route publique de la page de partage** — P2, tier/3, 2 pts. Dépend de 8.2.
  - Portée : `src/mobile/router.ts`, `docs/track1-api.md` ; `404` pour un nœud inconnu ou d'un
    autre type.
- [ ] TRA-? **8.4 — Infra · Servir `apple-app-site-association`** — P2, tier/3, 1 pt. Dépend de Q8.
  - Portée : `deploy/` (configuration du serveur frontal) ou route serveur, selon l'hébergement.
- [ ] TRA-? **8.5 — iOS · Capacité Associated Domains** — P2, tier/3, 1 pt. Dépend de 8.4.
  - Portée : créer `ios/Track1/Resources/Track1.entitlements` (`04B1`), `CODE_SIGN_ENTITLEMENTS`
    dans `ios/Configurations/Production.xcconfig`, `Info.plist` (`Track1ShareBaseURL`) ; nouveau
    profil App Store à fournir par Raphael.
- [ ] TRA-? **8.6 — iOS · Bouton partager du lecteur** — P2, tier/2, 1 pt. Dépend de 8.1, 5.8.
  - Portée : `ios/Track1/Features/Node/PlayerView.swift` (Figma `338:2561`, feuille de partage
    système avec l'URL de `ShareLink` et le titre ; identifiant `player-share`).
- [ ] TRA-? **8.7 — iOS · Ouvrir un lien entrant dans le lecteur** — P2, tier/2, 2 pts. Dépend de 8.1, 5.9, 8.5.
  - Portée : `ios/Track1/App/Track1App.swift`, `RootView.swift`, `AppRouter.swift` : URL validée
    par `ShareLink.identity`, onglet Aujourd'hui, `.player` poussé ; pendant l'onboarding le lien
    attend l'arrivée des onglets ; URL refusée → rien.
