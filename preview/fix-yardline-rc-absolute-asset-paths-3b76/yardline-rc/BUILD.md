# Yardline RC — vendored build

This folder is a **built artifact**, not source. Yardline RC is a Babylon.js +
Havok + React + Vite game; its source lives in a separate repo. The Space Console
hosts the compiled bundle here (the zero-build `games` collection can't build it).

## Rebuilding
In the source repo: `npm install && npm run build` (vite.config sets `base: './'`),
then copy `dist/` over this folder and prune (see below).

Asset paths must be RELATIVE (`assets/...`, not `/assets/...`) so they resolve
under this subpath. Do not reintroduce leading-slash asset paths.

**Gotcha (fixed 2026-07-23):** `base: './'` only rewrites Vite's own entry
imports (JS/CSS in `index.html`). It does NOT touch model/texture paths the game
code loads at runtime via Babylon `ImportMeshAsync(rootUrl, …)` / `new Texture()`.
Those were emitted as absolute `` `/assets/…` `` literals in the bundle, which
resolve to the SITE root (`/assets/…` → 404) once embedded under
`/games/yardline-rc/` — engine and HUD run, but no track/cars/props render.
Patched here by stripping the leading slash (`` `/assets/ `` → `` `assets/ ``) in
`assets/index-*.js`. The proper source-side fix: prefix those runtime model paths
with `import.meta.env.BASE_URL` (or a relative base) so a rebuild stays correct.
After ANY rebuild, verify no `` `/assets/ `` remain:
`grep -c '`/assets/' assets/index-*.js` must be 0.

## Pruned for the console embed
Full build ~138 MB (Downtown MegaKit + editor-only props). The console only plays
the fixed `construction-loop` preset, so editor-only assets are pruned to ~64 MB.
Kept: everything the preset places + all cars + opponents + particles. If the
preset changes to place a different kit asset, re-copy the full `dist/` first.
