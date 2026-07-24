# games

The game collection for **Space Console** — 30+ self-contained games that run on
the launcher (the TV/screen). Each lives in its own folder (`tetris/`, `snake/`,
`chess/`, `poker/`, `minesweeper/`, `yardline-rc/`, …) and is launched into the
launcher's persistent iframe shell.

Every game is driven by the shared **intent vocabulary**
(`up/down/left/right/enter/back`) the launcher and controller already speak, so
the same game works from a keyboard, a TV remote, a gamepad, or a phone controller
relaying those intents — the game is a pure consumer of the stream. Steering games
additionally accept continuous **analog** driving frames.

Zero-build, zero-backend static site — plain ES modules, no bundler, no
framework. Open any game's `index.html` and it runs.

```sh
npm install      # dev tooling only
npm run dev      # http://localhost:5175 (auto-reload) — serves the folder
```

## Embedding contract

Shared helpers live in `assets/js/shared/` (`input.js`, `controls.js`,
`roster.js`, `stats.js`, `sound.js`, `touch.js`). A game subscribes to the intent
stream via the shared `Input` layer and talks to the launcher shell over
`postMessage`:

| Direction | Message | Meaning |
| --- | --- | --- |
| shell → game | `sc:intent {intent, player}` | a button press, tagged with the sender's seat |
| shell → game | `sc:analog {steer, throttle, brake, handbrake, player}` | a driving frame (steering games) |
| shell → game | `sc:players {players}` | the current roster |
| game → shell | `sc:controls {profile, buttons}` | which phone pad to show (`dpad` / `buttons` / `analog` + aux) |
| game → shell | `sc:gameover {kind, …}` | report a score / 2-player result to the stats store |
| game → shell | `sc:back` | exit to the menu |

Most games are plain ES modules with no build step. The one exception is
`yardline-rc`, a **prebuilt** Babylon.js/Vite 3D bundle: it's copied verbatim and
NOT cache-busted (see `scripts/stamp.mjs` `NO_STAMP`, and `yardline-rc/BUILD.md`).
`rc-rush` is a plain-canvas pseudo-3D racer, no build needed.

## Documentation

All docs live in the **wiki** repo (the org-wide hub), not here:

- Service docs: `wiki/docs/services/games/`
- How we build, deploy, and review across repos: `wiki/docs/way-of-working.md`

Published site: `main` deploys to the Pages root; feature branches get a preview
at `/preview/<branch-slug>-<hash>/`. Scripts are cache-busted at deploy time
(`npm run build` → `_dist/`), except the prebuilt bundle noted above; local
`npm run dev` stays build-free.
