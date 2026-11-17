# Polices embarquées (TRA-384, TRA-724)

Sept fichiers, tous sous licence SIL Open Font License 1.1 (`OFL-JetBrainsMono.txt`, `OFL-Roboto.txt`).
Le nom PostScript est la valeur brute de `Track1FontFace`. Le test `test/ios-fonts.test.ts` recalcule
le SHA-256 de chaque `.ttf` et le compare à ce tableau : une police ajoutée ou modifiée sans mise à jour
de ce fichier fait échouer `npm run check`.

| Fichier | Nom PostScript | SHA-256 |
| --- | --- | --- |
| `JetBrainsMono-Regular.ttf` | `JetBrainsMono-Regular` | `a0bf60ef0f83c5ed4d7a75d45838548b1f6873372dfac88f71804491898d138f` |
| `JetBrainsMono-Medium.ttf` | `JetBrainsMono-Medium` | `31c92d01a8a08528b718a43addf0ad3df0af2ca4b7b3290a452f70f358e14d3d` |
| `JetBrainsMono-Bold.ttf` | `JetBrainsMono-Bold` | `5590990c82e097397517f275f430af4546e1c45cff408bde4255dad142479dcb` |
| `Roboto-Regular.ttf` | `Roboto-Regular` | `15256405ecb0d880678833a582760efad538ab2932318b52c8105b267d159459` |
| `Roboto-Medium.ttf` | `Roboto-Medium` | `64ef7cb83e2a0c8c3592cbb2d3d9d7aa1185adcf885152776984d89706a61c8a` |
| `Roboto-SemiBold.ttf` | `Roboto-SemiBold` | `32fe2086b0e54eca85a68eb74e3d89bb16a7ffe59085d6dc7d079f5b3c26d6ab` |
| `RobotoCondensed-Medium.ttf` | `RobotoCondensed-Medium` | `2a3a4ba8f16701b263c79482d8fb440a7e2ae06bb0ec14d3244776fb6acb741e` |

## Sources

- **JetBrains Mono 2.304** : release GitHub officielle
  <https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip>
  (SHA-256 de l'archive `6f6376c6ed2960ea8a963cd7387ec9d76e3f629125bc33d1fdcd7eb7012f7bbf`),
  fichiers `fonts/ttf/JetBrainsMono-{Regular,Medium,Bold}.ttf` copiés tels quels. `OFL.txt` de l'archive
  est copié en `OFL-JetBrainsMono.txt`.
- **Roboto 3.015 et Roboto Condensed** : distribution Google Fonts de la famille Roboto
  (`https://fonts.google.com/download/list?family=Roboto`, fichiers `static/`, polices servies par
  `fonts.gstatic.com/s/roboto/v51/`). `OFL.txt` de la distribution est copié en `OFL-Roboto.txt`.
  - `static/Roboto-Regular.ttf` devient `Roboto-Regular.ttf` ;
  - `static/Roboto-SemiBold.ttf` devient `Roboto-SemiBold.ttf` ;
  - `static/Roboto_Condensed-Medium.ttf` devient `RobotoCondensed-Medium.ttf` (renommé sans le tiret
    bas, comme dans le ticket ; le nom PostScript interne est inchangé).

- **Roboto Medium 3.015 (TRA-724)** : ce fichier ne vient **pas** de la distribution Google Fonts des autres
  Roboto du dépôt (`fonts.google.com` est refusé par le proxy du cloud, 2026-11-17), mais de la release GitHub
  `googlefonts/roboto-3-classic` v3.015 :
  - URL : <https://github.com/googlefonts/roboto-3-classic/releases/download/v3.015/Roboto_v3.015.zip>
    (SHA-256 de l'archive `bee3e9334ea86dd63e184598f31fb16750881c2da1a6f097a66e0f66a95b3d54`) ;
  - variante `web/static/Roboto-Medium.ttf`, copiée telle quelle sous le même nom ;
  - nom PostScript `Roboto-Medium`, version interne `Version 3.015; 2026`.

  Cette variante n'est pas octet pour octet celle des autres fichiers : aucun des `Roboto-Regular.ttf` de la
  release (`android`, `chromeos`, `web`, `hinted`, `unhinted`) n'a le SHA-256 de celui du dépôt. On a donc
  comparé (fontTools 4.68, 2026-11-17) le `Roboto-Regular.ttf` du dépôt et celui de `web/static`, la seule
  graisse que les deux sources ont en commun (la release n'a pas de SemiBold) :
  - métriques verticales identiques, tableau ci-dessous, de même que celles du `Roboto-SemiBold.ttf` du dépôt
    et du `Roboto-Medium.ttf` retenu ;
  - même table `cmap` (927 points de code) et même nombre de glyphes (1326) ;
  - mêmes largeurs d'avance et mêmes coordonnées de contours pour les 927 points de code ;
  - tables `GPOS` (crénage) et `GSUB` identiques (même empreinte de leur export XML).

  Parmi les tables comparées (`head`, `maxp`, `cmap`, `hmtx`, `glyf`, `GPOS`, `GSUB`), seule `head` diffère ;
  le hinting et les noms n'ont pas été comparés. Les sauts de ligne, les largeurs de mots et le crénage de
  `Roboto-Medium` sont donc ceux de la famille du dépôt, au poids près.

  | Métrique | Valeur (les quatre fichiers) |
  | --- | --- |
  | `unitsPerEm` | 2048 |
  | `hhea.ascent` / `descent` / `lineGap` | 1900 / -500 / 0 |
  | `OS/2.sTypoAscender` / `sTypoDescender` / `sTypoLineGap` | 1536 / -512 / 102 |
  | `OS/2.usWinAscent` / `usWinDescent` | 1946 / 512 |

  La même licence OFL 1.1 s'applique (`OFL-Roboto.txt`). Si Raphael remplace ce fichier par celui de la
  distribution Google Fonts, mettre à jour le SHA-256 ci-dessus et cette section.

Les autres fichiers sont les TTF statiques d'origine, sans sous-ensemble ni modification ; `Roboto-Medium.ttf`
l'est aussi (copié tel quel depuis la release).
