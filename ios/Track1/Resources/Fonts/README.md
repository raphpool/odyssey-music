# Polices embarquées (TRA-384)

Six fichiers, tous sous licence SIL Open Font License 1.1 (`OFL-JetBrainsMono.txt`, `OFL-Roboto.txt`).
Le nom PostScript est la valeur brute de `Track1FontFace`. Le test `test/ios-fonts.test.ts` recalcule
le SHA-256 de chaque `.ttf` et le compare à ce tableau : une police ajoutée ou modifiée sans mise à jour
de ce fichier fait échouer `npm run check`.

| Fichier | Nom PostScript | SHA-256 |
| --- | --- | --- |
| `JetBrainsMono-Regular.ttf` | `JetBrainsMono-Regular` | `a0bf60ef0f83c5ed4d7a75d45838548b1f6873372dfac88f71804491898d138f` |
| `JetBrainsMono-Medium.ttf` | `JetBrainsMono-Medium` | `31c92d01a8a08528b718a43addf0ad3df0af2ca4b7b3290a452f70f358e14d3d` |
| `JetBrainsMono-Bold.ttf` | `JetBrainsMono-Bold` | `5590990c82e097397517f275f430af4546e1c45cff408bde4255dad142479dcb` |
| `Roboto-Regular.ttf` | `Roboto-Regular` | `15256405ecb0d880678833a582760efad538ab2932318b52c8105b267d159459` |
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

Les fichiers sont les TTF statiques d'origine, sans sous-ensemble ni modification.
