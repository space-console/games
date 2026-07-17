// Tic-Tac-Toe for Space Console — entry point.
// Wires the shared intent stream to the engine, moves a cursor over a DOM 3×3
// grid, renders the marks / cursor / winning line / scoreboard, and manages the
// game states (idle → playing → over). The engine owns all board logic; this
// file is input + render only.

import { Engine } from "./engine.js?v=01ea6d18-d8db-4db1-a5cb-6f524be4ad3b";
import { Input, isTouchDevice } from "../assets/js/shared/input.js?v=01ea6d18-d8db-4db1-a5cb-6f524be4ad3b";
import { Sound } from "../assets/js/shared/sound.js?v=01ea6d18-d8db-4db1-a5cb-6f524be4ad3b";
import { Stats } from "../assets/js/shared/stats.js?v=01ea6d18-d8db-4db1-a5cb-6f524be4ad3b";
import { Roster } from "../assets/js/shared/roster.js?v=01ea6d18-d8db-4db1-a5cb-6f524be4ad3b";

const engine = new Engine();
const input = new Input();
const sound = new Sound();

const els = {
  status: document.getElementById("status"),
  grid: document.getElementById("grid"),
  winsX: document.getElementById("winsX"),
  winsO: document.getElementById("winsO"),
  draws: document.getElementById("draws"),
  overlay: document.getElementById("overlay"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlayMsg: document.getElementById("overlayMsg"),
  mute: document.getElementById("mute"),
};

// idle | playing | over
let state = "idle";
let cursor = 4;                 // grid index 0..8 the cursor hovers (centre to start)
let winLine = null;            // winning triple to highlight, or null
const score = { X: 0, O: 0, draws: 0 };

// Same-screen 2-player: seat 1 (the first phone) plays X, seat 2 plays O. We
// don't know up front how many phones joined, so we learn it — every intent
// carries its sender's seat. Until we've seen a second seat send input, ONE
// controller (or the local keyboard) drives both marks (classic pass-and-play);
// once a second phone acts, each seat may only move on its own mark's turn.
const seenSeats = new Set();
function twoPlayer() { return seenSeats.size >= 2; }
function seatToMove() { return engine.current === "X" ? 1 : 2; } // X→P1, O→P2
function seatOfMark(mark) { return mark === "X" ? 1 : 2; }
// A seat's display name (from the launcher roster) or a fallback like "P1".
function who(seat) { return Roster.name(seat) || `P${seat}`; }

// Build the nine cells once; we only update their text/classes thereafter.
const cells = [];
for (let i = 0; i < 9; i++) {
  const cell = document.createElement("div");
  cell.className = "cell";
  cell.setAttribute("role", "gridcell");
  // Touch: cells handle their own taps, so keep the global gesture layer out.
  cell.setAttribute("data-touch-ignore", "");
  // Tapping a cell moves the cursor there and places a mark (same path as
  // moving the cursor over it and pressing Enter). pointerdown covers
  // mouse/touch/pen; click would also work but pointerdown feels snappier.
  cell.addEventListener("pointerdown", () => tapCell(i));
  els.grid.appendChild(cell);
  cells.push(cell);
}

// Tap handler for a board cell: in play, jump the cursor to the tapped cell and
// place; when the round is over, any tap starts the next round.
function tapCell(i) {
  if (state === "over" || state === "idle") { startRound(); return; }
  if (state !== "playing") return;
  cursor = i;
  placeCursor();
}

// ---- Game-state transitions ----------------------------------------------
function startRound() {
  sound.resume();   // first key press unlocks audio (autoplay policy)
  sound.start();
  engine.reset();
  state = "playing";
  cursor = 4;
  winLine = null;
  hideOverlay();
  draw();
}

function endRound() {
  const { player, line } = engine.winner();
  state = "over";
  if (player) {
    winLine = line;
    score[player] += 1;
    sound.levelUp();
    const winner = twoPlayer() ? `${who(seatOfMark(player))} (${player})` : player;
    showOverlay(`${winner} wins!`, nextRoundMsg());
    setStatus(`${winner} wins`);
    // Report the outcome for the console's 2-player records (X→seat 1, O→seat 2).
    Stats.result({ outcome: "win", winnerSlot: seatOfMark(player) });
  } else {
    score.draws += 1;
    sound.move();
    showOverlay("Draw", nextRoundMsg());
    setStatus("Draw");
    Stats.result({ outcome: "draw" });
  }
  draw();
}

// Place the current player's mark at the cursor, then advance the round. Shared
// by the Enter intent and by tapping a cell, so both behave identically.
function placeCursor() {
  if (state !== "playing") return;
  if (engine.place(cursor)) {
    sound.lock();
    // A placement may end the round (a win or a full-board draw).
    if (engine.winner().player || engine.isDraw()) { endRound(); return; }
  }
  draw();
}

// ---- Intent handling ------------------------------------------------------
input.on((intent, player = 1) => {
  seenSeats.add(player);

  // Back always exits to the hub, from any seat, in any state.
  if (intent === "back") { location.href = "../"; return; }

  if (state === "playing") {
    // With two phones, a seat may only act on its own mark's turn — P2 can't
    // move X's cursor. With one controller it drives both (pass-and-play).
    if (twoPlayer() && player !== seatToMove()) return;
    switch (intent) {
      // Arrows move the cursor over the 3×3 grid, wrapping at the edges.
      case "left": cursor = cursor - (cursor % 3 === 0 ? -2 : 1); break;
      case "right": cursor = cursor + (cursor % 3 === 2 ? -2 : 1); break;
      case "up": cursor = (cursor + 6) % 9; break;
      case "down": cursor = (cursor + 3) % 9; break;
      case "enter":
        placeCursor();
        return;
    }
    draw();
    return;
  }

  // Not playing: Enter starts the next round (either seat).
  if (intent === "enter" && (state === "idle" || state === "over")) startRound();
});

// ---- Rendering ------------------------------------------------------------
function draw() {
  els.winsX.textContent = score.X;
  els.winsO.textContent = score.O;
  els.draws.textContent = score.draws;

  const winSet = winLine ? new Set(winLine) : null;
  for (let i = 0; i < 9; i++) {
    const mark = engine.board[i];
    const cell = cells[i];
    cell.textContent = mark || "";
    cell.classList.toggle("cell--x", mark === "X");
    cell.classList.toggle("cell--o", mark === "O");
    // Show the cursor only while the round is live.
    cell.classList.toggle("cell--cursor", state === "playing" && i === cursor);
    cell.classList.toggle("cell--win", !!winSet && winSet.has(i));
  }

  if (state === "playing") {
    setStatus(twoPlayer()
      ? `${who(seatToMove())}'s turn (${engine.current})`
      : `${engine.current}'s turn`);
  }
}

// A name may arrive (or change) after the board is already drawn — repaint the
// turn label when the launcher pushes a new roster.
Roster.onChange(() => { if (state === "playing") draw(); });

// ---- Copy helpers (touch vs keyboard) -------------------------------------
// On touch devices the prompts speak taps; otherwise they speak keys.
function startMsg() {
  return isTouchDevice() ? "Tap a square to start" : "Press <kbd>Enter</kbd> to start";
}
function nextRoundMsg() {
  return isTouchDevice() ? "Tap to play again" : "Press <kbd>Enter</kbd> for next round";
}

// ---- Overlay helpers ------------------------------------------------------
function showOverlay(title, msg) {
  els.overlayTitle.textContent = title;
  els.overlayMsg.innerHTML = msg;
  els.overlay.classList.remove("overlay--hidden");
}
function hideOverlay() {
  els.overlay.classList.add("overlay--hidden");
}
function setStatus(text) {
  els.status.textContent = text;
}

// ---- Mute control (meta, deliberately outside the gameplay intent layer) ---
function renderMute() {
  els.mute.textContent = sound.muted ? "🔇" : "🔊";
  els.mute.setAttribute("aria-pressed", String(sound.muted));
}
function toggleMute() {
  sound.toggleMute();
  renderMute();
}

// ---- Boot -----------------------------------------------------------------
function boot() {
  input.start();
  els.mute.addEventListener("click", toggleMute);
  window.addEventListener("keydown", (e) => {
    if (e.key === "m" || e.key === "M") toggleMute();
  });
  draw();             // render the empty board behind the start overlay
  setStatus(isTouchDevice() ? "Tap a square to start" : "Press Enter to start");
  showOverlay("Tic-Tac-Toe", startMsg());
}

boot();
