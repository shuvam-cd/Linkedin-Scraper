# Fonts

The brand guidelines name two faces and forbid substituting system fonts:
**Montserrat** for display, **Google Sans** for everything else. An extension
page cannot reach a font CDN — MV3's default content security policy blocks it,
and the popup has to render offline — so both roles are served from files that
ship inside the extension.

| File | Family | Weights | Licence |
| --- | --- | --- | --- |
| `montserrat-latin.woff2`, `montserrat-latin-ext.woff2` | Montserrat (variable) | 100–900 | SIL Open Font License 1.1 |
| `dmsans-latin.woff2`, `dmsans-latin-ext.woff2` | DM Sans (variable) | 400–700 | SIL Open Font License 1.1 |

Both are the Google Fonts latin / latin-ext subsets, ~164 KB in total.

## Why DM Sans is in here

Google Sans is proprietary and is not licensed for redistribution, so it cannot
be committed to a repository or bundled into a `.crx`. The body face is
therefore declared as:

```css
src: local("Google Sans"), local("Google Sans Text"), local("Product Sans"),
     url("fonts/dmsans-latin.woff2") format("woff2");
```

A machine with the licensed font installed — which the guidelines say is how
the brand is distributed internally — renders the real Google Sans. Everywhere
else falls back to DM Sans, the closest open geometric-humanist face to it:
same low stroke contrast, same near-circular bowls, same open apertures.

If a licensed webfont build of Google Sans is available, drop it in here and
put its `url()` ahead of the DM Sans one. Nothing else needs to change.

## Regenerating

The families are declared in `ui/tokens.css` as `CD Display` and `CD Text` so
the rest of the stylesheet never names a vendor. To refresh:

```
curl "https://fonts.googleapis.com/css2?family=Montserrat:wght@400..900&family=DM+Sans:wght@400..700"
```

and download the `latin` and `latin-ext` `woff2` URLs it returns.
