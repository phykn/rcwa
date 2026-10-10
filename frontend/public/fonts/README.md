# Self-hosted fonts

These three upright Latin variable WOFF2 files are copied without modification
from Fontsource's official npm packages at version `5.3.0`:

- [Outfit](https://fontsource.org/fonts/outfit), `@fontsource-variable/outfit`
- [Inter](https://fontsource.org/fonts/inter), `@fontsource-variable/inter`
- [Source Code Pro](https://fontsource.org/fonts/source-code-pro), `@fontsource-variable/source-code-pro`

Each package's complete SIL Open Font License 1.1 and attribution is preserved in
the adjacent `<family>-OFL.txt` file. Keep those files when redistributing the
fonts. Font files and package archives are recorded with hashes and exact source
URLs in `manifest.json`. The archive SHA-512 integrity values were checked against
the npm package metadata before these files were copied.

The assets total 102,592 bytes (100.2 KiB). Outfit and Inter cover weights 100–900;
Source Code Pro covers 200–900. The UI uses a subset of those ranges. Only normal,
Latin-subset files are shipped; unsupported scripts or italics use the CSS font
stack/browser fallback. The original upstream subset unicode ranges are kept in
`src/fonts.css`.

## Integration

Import `./fonts.css` once from the frontend entrypoint, or use an `@import` at the
start of `styles.css`. Use the CSS families `"Outfit"`, `"Inter"`, and
`"Source Code Pro"`, followed by appropriate system fallbacks.

The `/fonts/…` CSS source URLs are intentional Vite public-directory references.
Vite rewrites them relative to the generated CSS with the project's `base: "./"`,
so a GitHub Pages repository subpath works. Deploy the entire built `dist`
directory, including its `fonts` directory. Do not copy `fonts.css` directly into
the built site without Vite processing it.

All font requests stay on the application's own origin. Font loading does not
require Google Fonts, a font CDN, the npm registry, or an Internet connection
when serving the application locally. This does not introduce service-worker
caching or guarantee an offline reload of a previously visited remote website.

## Reproduce and verify

Use `npm pack --ignore-scripts` for the exact package versions above in a temporary
directory. Verify each tarball against `packageIntegrity` in `manifest.json`,
extract it, and copy `package/files/<file>` and `package/LICENSE`. Do not install
these packages as application dependencies merely to serve the vendored assets.

Validate the copied fonts using the SHA-256 values in `manifest.json`. The fonts
were also read successfully by Fontconfig/FreeType, including their variable
weight instances. An isolated Vite build verifies relative asset paths without
modifying the main application's build output.
