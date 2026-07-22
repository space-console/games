# Yardline RC — vendored build

This folder is a **built artifact**, not source. Yardline RC is a Babylon.js +
Havok + React + Vite game; its source lives in a separate repo. The Space Console
hosts the compiled bundle here (the zero-build `games` collection can't build it
itself).

## Rebuilding

In the Yardline RC source repo:

```bash
npm install
npm run build          # tsc -b && vite build  (vite.config: base: './')
```

`base: './'` is required so assets resolve under `games/yardline-rc/`. Then copy
`dist/` over this folder.

## Pruned for the console embed

The full build is ~138 MB, mostly the Quaternius Downtown MegaKit (153 models)
and custom props that only populate the **map editor** palette. The console only
ever plays the fixed `construction-loop` preset, so editor-only assets are pruned
to ~64 MB. Kept: everything the preset places + all cars + opponents + particles.
Dropped from `assets/quaternius/downtown-city/`: every model except the two placed
road pieces (`Street_2Lane`, `Street_Curve_2Lane`) and their glTF-referenced
textures; plus unused `custom/houses`, `custom/street`, and `kenney` props.

If the preset (`map-presets/construction-loop-kit.json` in the source repo) is
ever changed to place a different kit asset, re-copy the full `dist/` (or restore
that asset's files) before pruning again.
