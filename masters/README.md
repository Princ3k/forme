# Sample vector masters — Nightjar Records

A fictional record label, used to exercise the vector source without touching a
real client's brand. Four lockups, three colourways, one deliberate gap.

```
logo-primary        mark stacked above wordmark
logo-horizontal     mark beside wordmark
submark             the mark alone
wordmark            type alone
```

Each exists as `full-colour`, `mono-black` and `mono-white`, except one — see
below.

## Filename convention

```
<asset>.svg                  the base / full-colour artwork
<asset>.<colourway>.svg      a colourway the designer has drawn themselves
```

So `logo-primary.mono-white.svg` is the mono-white variant of `logo-primary`.
This is the same idea as the Figma `@export/logo-primary/mono-white` layer
convention, just expressed in filenames.

## `wordmark.mono-white.svg` is missing on purpose

Do not add it. It is there to demonstrate invariant 3: the tool reports the
gap and tells you what to name the file, rather than auto-recolouring the SVG
to fill it. Every run should end with:

```
1 variants had no matching asset:
  wordmark / mono-white
```

Automated recolouring breaks on gradients, embedded images and clipping masks,
and a mangled logo reaching a client is worse than a missing file.

## palette.json

Optional. An SVG folder carries no design system, so this supplies the colour
and type tokens that Figma would otherwise provide. Delete it and the package
still builds — the palette files just come out empty.

Note the values are RGB. CMYK and Pantone equivalents cannot be derived
automatically with any accuracy; see invariant 4.

## Try it

```bash
npm run start -- generate --client "Nightjar Records" \
  --vectors ./masters --preset full-brand-package
```

Requires `cairosvg` and `ghostscript` for the print formats — run
`npm run doctor` first. Use `--preset standard-brand-package` to skip them.
