# Yardline RC — vendored build

This folder is a **built artifact**, not source. Yardline RC is a Babylon.js +
Havok + React + Vite game; its source lives in a separate repo. The Space Console
hosts the compiled bundle here (the zero-build `games` collection can't build it).

## Rebuilding
In the source repo (`Artan0/razing`): `npm install && npm run build`, then copy
`dist/` over this folder and prune (see below). `vite.config.ts` sets
`base: './'` (relative entry paths for the subpath embed) and
`resolve.dedupe: ['@babylonjs/core', ...]`.

**Why dedupe matters (fixed 2026-07-23):** the source mixes barrel imports
(`from '@babylonjs/core'`) with deep imports (`from '@babylonjs/core/Misc/...'`),
so without `resolve.dedupe` Rollup bundles Babylon twice; the duplicate class
decorators then throw `Cannot redefine property: onBeforeViewRenderObservable` at
runtime, which aborts model loading — the scene renders but **cars/props never
appear**. After a rebuild, confirm a single entry chunk and no dup:
`ls dist/assets/index-*.js` (expect one).

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

**Phone-controller bridge (patched 2026-07-24):** the source builds embed a
bridge that (a) tells the console shell which phone pad to show per race phase
via `postMessage({type:"sc:controls", …})` and (b) receives the phone's
`sc:analog` driving frames + `sc:intent` button presses back. The 2026-07-23
deduped rebuild came from a source tree WITHOUT that bridge, so the phone fell
back to a d-pad and no input reached the car — the cars rendered but were
undrivable from a phone. Restored here without a rebuild:
- `index.html` carries an inline `<script>` bridge (mirrors the original:
  per-phase `sc:controls`, analog → `setTouchDrive/Brake/Handbrake`, intents →
  reset/powerup/pause/menu-nav).
- `assets/index-*.js` is patched to expose the two runtime instances the bridge
  drives: `window.__scInput=this` in the input-controller constructor and
  `window.__scRace=this` in the race-state-machine constructor.

After ANY rebuild, verify the bridge survives: `grep -c 'sc:analog' index.html`
must be ≥1, and `grep -c 'window.__scInput=this' assets/index-*.js` must be 1
(else re-apply, or — the proper fix — restore the embed bridge in
`Artan0/razing` and rebuild, then drop the inline shim).

**Map editor nav paths (patched 2026-07-30):** the bundle ships two editors — the
2D "Map Workbench" page (route: `location.pathname === '/map-editor'` **or**
`?tool=map-editor`) and a 3D fly-and-edit overlay (`?fly=1`). Their navigation was
emitted as SITE-absolute literals, the same class of bug as the asset paths above:
`` `/?map=construction-loop&editorDraft=1&seed=…` `` (Test drive, ×3),
`` href:`/map-editor` `` (Open 2D editor), and the workbench brand link `` href:`/` ``.
Under `/games/yardline-rc/` those all bounce to the console root instead of the game.
Patched here to `` `./?map=…` ``, `` `./?tool=map-editor` ``, and `` `./` ``.
After ANY rebuild, verify: ``grep -c 'href=`/?map=' assets/index-*.js`` must be 0.
Reach the editor only via the query form (`?tool=map-editor`) — the pathname branch
can't match under the subpath. The proper source-side fix is `import.meta.env.BASE_URL`
on these, same as the runtime model paths.

The console links the workbench from the "Map Workbench" tile in `../index.html`.
Note it needs keyboard + mouse (WASD / ⌘S / right-drag look), so it's a laptop tool,
not a TV-pad one.

## Pruned for the console embed
Full build ~138 MB (Downtown MegaKit + editor-only props). The console only plays
the fixed `construction-loop` preset, so editor-only assets are pruned to ~64 MB.
Kept: everything the preset places + all cars + opponents + particles. If the
preset changes to place a different kit asset, re-copy the full `dist/` first.

This bites the map editor now that it's reachable: its asset palette lists the whole
kit, but only preset-used models are on disk, so placing anything else 404s the model
and drops an invisible object. Re-copy the full `dist/` before authoring maps.
