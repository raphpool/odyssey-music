# Brand — logos de services d'écoute

Deux imagesets vectoriels (`preserves-vector-representation`), utilisés par `StreamingButton` sous les
noms `Brand/AppleMusic` et `Brand/Spotify`, affichés à 16 pt (`size/icon-small`).

## Source (TRA-439)

Les deux SVG sont l'export vectoriel, non retouché, des calques « logo » du Figma de Track1 :

| Fichier | Fichier Figma | Nœud | Export | SHA-256 |
| --- | --- | --- | --- | --- |
| `AppleMusic.imageset/AppleMusic.svg` | `phudxrQNlzQJafXLma4FyX` | `169:107` (`Service=Apple Music`) | 2026-10-13, MCP Figma `download_assets`, lecture seule | `b0c61ebee9a3f92edde692bfd135f45391ff4dc6e183f93b42fc4d1b2e95d1c9` |
| `Spotify.imageset/Spotify.svg` | `phudxrQNlzQJafXLma4FyX` | `169:114` (`Service=Spotify`) | 2026-10-13, MCP Figma `download_assets`, lecture seule | `7852ceeaf95751edff18c06e96da17f0d3e7706724d32f138a86c0cca2015a24` |

Un seul tracé par logo : on a gardé le calque vectoriel du logo, pas l'export du nœud entier (qui embarque
le fond et les cadres de contexte du Figma). Aucune image raster, aucun script, aucun lien externe.

Ces fichiers ne sont pas des SVG officiels téléchargés sur les sites de marque : ce sont les logos tels que
Raphael les a insérés dans le Figma (décision du 2026-10-13 sur TRA-439). Pour les régénérer, ré-exporter les
mêmes nœuds en SVG et mettre à jour les SHA-256 ci-dessus (`shasum -a 256`).

## Rendu

Les logos gardent les couleurs du Figma : Apple Music `#FA243C`, Spotify `#1ED760`. Le catalogue les rend en
mode « automatic » (pas de `template-rendering-intent`) et `StreamingButton` ne les teinte pas : aucune
teinte `colorIconSecondary` n'est appliquée. Passer en monochrome demanderait `template-rendering-intent`
dans les deux `Contents.json` et un `foregroundStyle` dans `StreamingButton.swift`.

## À revoir avant une soumission App Store

* Spotify n'autorise son logo qu'en vert Spotify, noir ou blanc. Le vert `#1ED760` du Figma est dans la
  règle ; une teinte beige ou grise (`colorIconSecondary`) ne le serait pas.
* Apple Music a ses propres règles (couleurs, taille minimale, zone de protection) : à vérifier avec les
  consignes de marque d'Apple avant publication.
* Cela ne bloque pas la V1 installée sur l'iPhone (L.3, TRA-374).
