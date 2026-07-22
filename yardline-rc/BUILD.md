# Yardline RC — vendored build

This folder is a **built artifact**, not source. Yardline RC is a Babylon.js +
Havok + React + Vite game; its source lives in a separate repo. The Space Console
hosts the compiled bundle here (the zero-build `games` collection can't build it).

## Rebuilding
In the source repo: `npm install && npm run build` (vite.config sets `base: './'`),
then copy `dist/` over this folder and prune (see below).

Asset paths are RELATIVE (`assets/...`, not `/assets/...`) so they resolve under
this subpath. Do not reintroduce leading-slash asset paths.

## Pruned for the console embed
Full build ~138 MB (Downtown MegaKit + editor-only props). The console only plays
the fixed `construction-loop` preset, so editor-only assets are pruned to ~64 MB.
Kept: everything the preset places + all cars + opponents + particles. If the
preset changes to place a different kit asset, re-copy the full `dist/` first.
