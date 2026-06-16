// Candy Crush for Space Console — entry point.
// Wires the shared intent stream to the engine, renders the 8x8 DOM grid of
// candies, handles tap-select + tap-adjacent (and swipe-a-candy) to swap, plus
// a full keyboard/remote scheme (cursor + Enter to select, then move to an
// adjacent cell to swap). Tracks Score/Target/Moves and shows win + lose
// overlays. The engine owns all game logic; this file is input + render only.

import { Engine, SIZE } from "./engine.js?v=364ea0d7-a68f-4984-bea7-a253b14b54aa";
import { Input, isTouchDevice } from "../assets/js/shared/input.js?v=364ea0d7-a68f-4984-bea7-a253b14b54aa";
import { Sound } from "../assets/js/shared/sound.js?v=364ea0d7-a68f-4984-bea7-a253b14b54aa";

// Six candy colours, indexed by the engine's colour ids (1..6); 0 = empty
// (no entry — never shown once a turn settles). Each carries a glyph so the
// colours stay distinguishable for colour-blind players / monochrome displays.
const CANDIES = [
  null,
  { fill: "#ff5a6e", glyph: "●" }, // 1 red — circle
  { fill: "#ffb13d", glyph: "▲" }, // 2 orange — triangle
  { fill: "#ffe44d", glyph: "★" }, // 3 yellow — star
  { fill: "#46d97a", glyph: "♦" }, // 4 green — diamond
  { fill: "#4f9dff", glyph: "■" }, // 5 blue — square
  { fill: "#b06bff", glyph: "♥" }, // 6 purple — heart
];

const engine = new Engine();
const input = new Input();
const sound = new Sound();

const els = {
  status: document.getElementById("status"),
  grid: document.getElementById("grid"),
  score: document.getElementById("score"),
  target: document.getElementById("target"),
  moves: document.getElementById("moves"),
  overlay: document.getElementById("overlay"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlayMsg: document.getElementById("overlayMsg"),
  mute: document.getElementById("mute"),
  newGame: document.getElementById("newGame"),
};

let cells = [];        // 64 DOM cell nodes (row-major)
let cursor = 0;        // board index 0..63 for the keyboard/remote cursor
let selected = -1;     // index of the selected candy, or -1
let busy = false;      // true while a swap/clear animation is settling (locks input)

const idx = (r, c) => r * SIZE + c;
const rowOf = (i) => Math.floor(i / SIZE);
const colOf = (i) => i % SIZE;

// ---- Board construction ---------------------------------------------------
// Build the 8x8 DOM grid once. Each cell owns its own taps (data-touch-ignore
// keeps the global gesture layer off the board) and reports a swipe direction
// for swap-by-swipe, mirroring the minesweeper/block-blast tappable-cell pattern.
function buildGrid() {
  els.grid.textContent = "";
  cells = [];
  for (let i = 0; i < SIZE * SIZE; i++) {
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.setAttribute("role", "gridcell");
    cell.setAttribute("data-touch-ignore", "");

    // pointerup (not click) keeps selection snappy on touch. We track a press
    // origin on pointerdown so a drag off the cell reads as a directional swipe.
    cell.addEventListener("pointerdown", (e) => onPointerDown(e, i));
    cell.addEventListener("pointerup", (e) => onPointerUp(e, i));

    els.grid.appendChild(cell);
    cells.push(cell);
  }
}

// ---- Pointer: tap-to-select / tap-adjacent / swipe-a-candy ---------------
let press = null;      // { i, x, y } origin of the current pointer press

function onPointerDown(e, i) {
  press = { i, x: e.clientX, y: e.clientY };
}

function onPointerUp(e, i) {
  e.preventDefault();
  if (engine.state !== "playing" || busy) { press = null; return; }

  const start = press;
  press = null;

  // A clear drag off the candy is a swipe → swap with the neighbour in that
  // direction. Otherwise treat it as a tap on cell `i`.
  if (start && start.i === i) {
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) >= 18) {
      const r = rowOf(i), c = colOf(i);
      let nr = r, nc = c;
      if (Math.abs(dx) > Math.abs(dy)) nc += dx > 0 ? 1 : -1;
      else nr += dy > 0 ? 1 : -1;
      if (engine.areAdjacent(r, c, nr, nc)) { attemptSwap(r, c, nr, nc); return; }
    }
  }
  tapCell(i);
}

// Tap logic: first tap selects; a tap on an adjacent candy swaps; a tap on the
// same candy deselects; a tap on a far candy re-selects.
function tapCell(i) {
  cursor = i;
  if (selected < 0) {
    selected = i;
    sound.lock();
    draw();
    setStatus(promptText());
    return;
  }
  if (selected === i) { selected = -1; draw(); setStatus(promptText()); return; }

  const r1 = rowOf(selected), c1 = colOf(selected);
  const r2 = rowOf(i), c2 = colOf(i);
  if (engine.areAdjacent(r1, c1, r2, c2)) {
    attemptSwap(r1, c1, r2, c2);
  } else {
    selected = i;          // not adjacent → move the selection here
    sound.lock();
    draw();
    setStatus(promptText());
  }
}

// ---- Swap + animated resolve ---------------------------------------------
// The engine resolves the whole turn at once, but planSwap records each step so
// we can animate it: the two candies SLIDE into each other's cells, then each
// cascade's matched candies POP (flash + shrink away) before the board collapses.
function attemptSwap(r1, c1, r2, c2) {
  if (busy) return;
  const a = idx(r1, c1), b = idx(r2, c2);
  const preScore = engine.score;
  const plan = engine.planSwap(r1, c1, r2, c2);
  selected = -1;
  busy = true;

  if (!plan.valid) {
    sound.drop();
    if (plan.swapped) {
      // Adjacent but no match: slide the two candies, then bounce them back.
      animateSlide(a, b, true, () => {
        rejectFeedback(a, b);
        draw();
        busy = false;
        setStatus("No match — try another swap");
      });
    } else {
      draw();
      busy = false;
      setStatus("No match — try another swap");
    }
    return;
  }

  if (plan.maxRun >= 3) sound.clear(plan.maxRun);
  else sound.clear(3);
  if (plan.chains >= 2) sound.levelUp();   // a cascade chain

  // Slide the swap, show the swapped board, then play each cascade's pop.
  animateSlide(a, b, false, () => {
    renderBoard(plan.swapped);
    let shown = preScore;
    playSteps(plan.steps, 0,
      (gained) => { shown += gained; els.score.textContent = shown; },
      () => {
        busy = false;
        draw();
        cursor = clamp(cursor, 0, SIZE * SIZE - 1);
        if (engine.state === "won") {
          sound.levelUp();
          showOverlay("You win!", winMsg());
          setStatus(`You win · Score ${engine.score}`);
        } else if (engine.state === "lost") {
          sound.gameOver();
          showOverlay("Out of moves", loseMsg());
          setStatus(`Game over · Score ${engine.score}`);
        } else {
          setStatus(promptText());
        }
      });
  });
}

// Slide the candies in cells a and b into each other's positions. With `bounce`,
// slide there and back (a rejected swap); otherwise the caller swaps the content
// once the slide lands. Uses live rects so it's robust to gap/cell size.
function animateSlide(a, b, bounce, done) {
  const ea = cells[a], eb = cells[b];
  const ra = ea.getBoundingClientRect(), rb = eb.getBoundingClientRect();
  const dx = rb.left - ra.left, dy = rb.top - ra.top;
  ea.style.transition = eb.style.transition = "transform 160ms ease";
  ea.style.zIndex = eb.style.zIndex = "5";
  ea.style.transform = `translate(${dx}px, ${dy}px)`;
  eb.style.transform = `translate(${-dx}px, ${-dy}px)`;
  const cleanup = () => {
    ea.style.transition = eb.style.transition = "";
    ea.style.transform = eb.style.transform = "";
    ea.style.zIndex = eb.style.zIndex = "";
  };
  window.setTimeout(() => {
    if (bounce) {
      ea.style.transform = eb.style.transform = "translate(0px, 0px)";
      window.setTimeout(() => { cleanup(); done(); }, 170);
    } else {
      // cleanup + content swap happen in the same tick → no flicker.
      cleanup();
      done();
    }
  }, 170);
}

// Play the cascade steps in sequence: pop the matched candies, then show the
// collapsed/refilled board, crediting that step's points as it lands.
function playSteps(steps, i, onGain, done) {
  if (i >= steps.length) { done(); return; }
  const step = steps[i];
  for (const [r, c] of step.cells) cells[idx(r, c)].classList.add("cell--clearing");
  window.setTimeout(() => {
    for (const [r, c] of step.cells) cells[idx(r, c)].classList.remove("cell--clearing");
    renderBoard(step.board);
    onGain(step.gained);
    playSteps(steps, i + 1, onGain, done);
  }, 300);
}

// Paint a raw grid snapshot (no score/cursor bookkeeping) — used during animation.
function renderBoard(grid) {
  for (let i = 0; i < cells.length; i++) {
    const candy = CANDIES[grid[rowOf(i)][colOf(i)]] || CANDIES[1];
    cells[i].style.setProperty("--fill", candy.fill);
    cells[i].textContent = candy.glyph;
  }
}

// Shake the two candies of a rejected swap.
function rejectFeedback(a, b) {
  for (const i of [a, b]) {
    const el = cells[i];
    el.classList.remove("cell--reject");
    // Force reflow so the animation re-triggers on a repeat rejection.
    void el.offsetWidth;
    el.classList.add("cell--reject");
    window.setTimeout(() => el.classList.remove("cell--reject"), 240);
  }
}

// ---- Rendering ------------------------------------------------------------
function draw() {
  els.score.textContent = engine.score;
  els.target.textContent = engine.target;
  els.moves.textContent = engine.moves;

  for (let i = 0; i < cells.length; i++) {
    const id = engine.grid[rowOf(i)][colOf(i)];
    const candy = CANDIES[id] || CANDIES[1];
    const cell = cells[i];
    cell.style.setProperty("--fill", candy.fill);
    cell.textContent = candy.glyph;
    cell.classList.toggle("cell--selected", i === selected);
    // Cursor ring only matters for keyboard/remote (no pointer hover).
    cell.classList.toggle(
      "cell--cursor",
      !isTouchDevice() && engine.state === "playing" && i === cursor && i !== selected,
    );
  }
}

// ---- Intent handling (keyboard / remote / gamepad) ------------------------
input.on((intent) => {
  if (intent === "back") { location.href = "../"; return; }
  if (engine.state !== "playing") {
    if (intent === "enter") newGame();
    return;
  }
  if (busy) return;

  switch (intent) {
    case "left": cursor = (colOf(cursor) === 0) ? cursor : cursor - 1; break;
    case "right": cursor = (colOf(cursor) === SIZE - 1) ? cursor : cursor + 1; break;
    case "up": cursor = (cursor < SIZE) ? cursor : cursor - SIZE; break;
    case "down": cursor = (cursor >= SIZE * (SIZE - 1)) ? cursor : cursor + SIZE; break;
    case "enter": tapCell(cursor); return;
  }
  draw();
});

// ---- Game-state transitions ----------------------------------------------
function newGame() {
  sound.resume();   // first gesture unlocks audio (autoplay policy)
  sound.start();
  engine.reset();
  selected = -1;
  cursor = 0;
  busy = false;
  hideOverlay();
  draw();
  setStatus(promptText());
}

// ---- Copy helpers (touch vs keyboard) -------------------------------------
function promptText() {
  if (isTouchDevice()) {
    return selected >= 0
      ? "Tap an adjacent candy to swap"
      : "Tap a candy, then a neighbour";
  }
  return selected >= 0
    ? "Move to a neighbour · Enter swaps"
    : "Arrows move · Enter selects";
}
function winMsg() {
  return isTouchDevice() ? "Tap New game to play again" : "Press <kbd>Enter</kbd> for a new game";
}
function loseMsg() {
  return isTouchDevice() ? "Tap New game to try again" : "Press <kbd>Enter</kbd> to try again";
}

// ---- Overlay helpers ------------------------------------------------------
function showOverlay(title, msg) {
  els.overlayTitle.textContent = title;
  els.overlayMsg.innerHTML = msg;
  els.overlay.classList.remove("overlay--hidden");
}
function hideOverlay() { els.overlay.classList.add("overlay--hidden"); }
function setStatus(text) { els.status.textContent = text; }

// ---- Mute control (meta, deliberately outside the gameplay intent layer) ---
function renderMute() {
  els.mute.textContent = sound.muted ? "🔇" : "🔊";
  els.mute.setAttribute("aria-pressed", String(sound.muted));
}
function toggleMute() { sound.toggleMute(); renderMute(); }

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ---- Boot -----------------------------------------------------------------
function boot() {
  input.start();

  buildGrid();
  draw();
  setStatus(promptText());

  els.newGame.addEventListener("click", newGame);
  els.mute.addEventListener("click", toggleMute);

  window.addEventListener("keydown", (e) => {
    if (e.key === "m" || e.key === "M") { toggleMute(); return; }
    if (e.key === "n" || e.key === "N") { e.preventDefault(); newGame(); }
  });

  // Start overlay so the first gesture unlocks audio.
  showOverlay("Candy Crush", isTouchDevice() ? "Tap a candy to start" : "Press <kbd>Enter</kbd> to start");
}

boot();
