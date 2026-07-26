# Sample vector masters

Throwaway artwork for trying the vector source without touching a real brand.

    npm run start -- generate --client "Acme Records" --vectors ./masters --preset full-brand-package

Filename convention: `<asset>.svg`, or `<asset>.<colourway>.svg` for a variant
the designer has drawn themselves.

Note `submark.mono-white.svg` is deliberately absent — the tool should report it
as unresolved rather than inventing it. That behaviour is the point.
