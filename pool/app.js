// 8-Ball Pool for Space Console — entry point.
// Owns input, the canvas render and the game flow; engine.js owns the physics
// and every rule. States: menu → aim → shooting → (inhand) → over.
//
// Aiming has three interchangeable paths, so the same table plays well on a TV,
// a laptop and a phone:
//   • held ← / → (keyboard, or the phone pad's hold buttons) rotate the cue,
//     slowly at first and faster the longer you hold — coarse then fine,
//   • dragging anywhere on the table points the cue at your finger, and
//     pulling back from the cue ball sets power and releases the shot,
//   • holding Space / SHOOT charges the power meter and releases on let-go.
// Spin (side + top/back english) is set on the little cue-ball widget, with
// ↑ / ↓ for follow/draw and a Spin button that cycles presets on the phone.
//
// Two players share the screen: seats come from the launcher (P1/P2), so each
// phone may only shoot on its own turn. Solo play racks up against the computer.

import {
  Engine, predictShot, planShot,
  TABLE_W, TABLE_H, BALL_R, POCKET_R, POCKETS, PHYS_DT, HEAD_STRING, SOLID, STRIPE,
} from "./engine.js?v=5f45cf0e-18e1-45f6-8078-fe425c1f5555";
import { Input, isTouchDevice } from "../assets/js/shared/input.js?v=5f45cf0e-18e1-45f6-8078-fe425c1f5555";
import { Sound } from "../assets/js/shared/sound.js?v=5f45cf0e-18e1-45f6-8078-fe425c1f5555";
import { Controls } from "../assets/js/shared/controls.js?v=5f45cf0e-18e1-45f6-8078-fe425c1f5555";
import { Stats } from "../assets/js/shared/stats.js?v=5f45cf0e-18e1-45f6-8078-fe425c1f5555";
import { Roster } from "../assets/js/shared/roster.js?v=5f45cf0e-18e1-45f6-8078-fe425c1f5555";

const engine = new Engine();
const input = new Input();
const sound = new Sound();

const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");

const els = {
  status: document.getElementById("status"),
  overlay: document.getElementById("overlay"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlayMsg: document.getElementById("overlayMsg"),
  menu: document.getElementById("menu"),
  toast: document.getElementById("toast"),
  powerFill: document.getElementById("powerFill"),
  powerValue: document.getElementById("powerValue"),
  spinPad: document.getElementById("spinPad"),
  spinDot: document.getElementById("spinDot"),
  turnName: document.getElementById("turnName"),
  turnGroup: document.getElementById("turnGroup"),
  cards: [null, document.getElementById("p1card"), document.getElementById("p2card")],
  names: [null, document.getElementById("p1name"), document.getElementById("p2name")],
  groups: [null, document.getElementById("p1group"), document.getElementById("p2group")],
  racks: [null, document.getElementById("p1rack"), document.getElementById("p2rack")],
  touchControls: document.getElementById("touchControls"),
  mute: document.getElementById("mute"),
};

// Ball colours (standard pool set); stripes reuse the 1–7 colours.
const BALL_COLOURS = {
  0: "#f6f2e4",
  1: "#f2c53d", 2: "#2f6bd8", 3: "#d8442f", 4: "#7b3fc4", 5: "#ef8420",
  6: "#1f9153", 7: "#8d3030", 8: "#15171f",
  9: "#f2c53d", 10: "#2f6bd8", 11: "#d8442f", 12: "#7b3fc4", 13: "#ef8420",
  14: "#1f9153", 15: "#8d3030",
};

const RAIL = 42;                     // rail width, in table units
const WORLD_W = TABLE_W + RAIL * 2;
const WORLD_H = TABLE_H + RAIL * 2;

const CHARGE_MS = 1150;              // hold time from zero to full power
const AIM_SLOW = 0.45;               // rad/s while a rotate has just started
const AIM_FAST = 2.1;                // rad/s once it's been held a moment
const AIM_RAMP = 700;                // ms to go from slow to fast
const NUDGE = 0.012;                 // rad per discrete ←/→ intent (gamepad, remote)
const PLACE_STEP = 13;               // table units per discrete move while placing
const MAX_FRAME = 0.05;              // clamp huge dt after a tab switch

const SPIN_PRESETS = [
  { x: 0, y: 0, label: "Centre" },
  { x: 0, y: 1, label: "Follow" },
  { x: 0, y: -1, label: "Draw" },
  { x: -0.9, y: 0, label: "Left english" },
  { x: 0.9, y: 0, label: "Right english" },
];

// menu | aim | shooting | inhand | over
let state = "menu";
let mode = "two";                    // "two" (same screen) or "ai"
const HUMAN = 1;                     // in AI mode the human is seat 1
let aimAngle = 0;
let power = 0;
let charging = false;
let chargeStart = 0;
let spin = { x: 0, y: 0 };
let spinPreset = 0;
const aimHeld = { left: 0, right: 0 };  // timestamp the rotate started, or 0
let lastTime = 0;
let acc = 0;
let placeValid = true;               // is the cue ball on a legal spot right now?
const effects = [];                  // pot rings / rail sparks
let ai = null;                       // { phase, until, plan } while the computer shoots
let lastNudge = { dir: 0, at: 0 };   // for accelerating repeated placement taps

// Same-screen seats: we learn how many phones are in play from the intents they
// send (identical to the other 2-player games). One controller drives both
// seats (pass-and-play); once a second phone acts, each seat shoots its own turn.
const seenSeats = new Set();
function twoPhones() { return seenSeats.size >= 2; }
function nameOf(seat) {
  if (mode === "ai" && seat !== HUMAN) return "Computer";
  return Roster.name(seat) || `Player ${seat}`;
}

// ---- View: world ⇄ screen ---------------------------------------------------
// On a portrait phone the table is drawn rotated a quarter turn, so a 2:1 table
// still fills the screen. Everything else — physics, pointer maths, rendering —
// works in table units and never knows.
const view = { scale: 1, ox: 0, oy: 0, rotated: false };

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  view.rotated = canvas.height > canvas.width;
  // After the quarter turn the world's x runs down the screen, so the axes swap.
  const availX = view.rotated ? canvas.height : canvas.width;
  const availY = view.rotated ? canvas.width : canvas.height;
  view.scale = Math.min(availX / WORLD_W, availY / WORLD_H);
  view.ox = (availX - WORLD_W * view.scale) / 2;
  view.oy = (availY - WORLD_H * view.scale) / 2;
  draw();
}

// Put the context in table coordinates: (0,0) is the top-left of the felt.
function applyView() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (view.rotated) {
    ctx.translate(canvas.width, 0);
    ctx.rotate(Math.PI / 2);
  }
  ctx.translate(view.ox, view.oy);
  ctx.scale(view.scale, view.scale);
  ctx.translate(RAIL, RAIL);
}

/** Table coordinates for a pointer event (inverse of applyView). */
function worldFromEvent(e) {
  const rect = canvas.getBoundingClientRect();
  const px = (e.clientX - rect.left) * (canvas.width / rect.width);
  const py = (e.clientY - rect.top) * (canvas.height / rect.height);
  const a = view.rotated ? py : px;
  const b = view.rotated ? canvas.width - px : py;
  return {
    x: (a - view.ox) / view.scale - RAIL,
    y: (b - view.oy) / view.scale - RAIL,
  };
}

// ---- Menus ------------------------------------------------------------------
// One data-driven menu serves both the opening screen and the game-over screen:
// arrows move the highlight, Enter (or a tap) runs the item.
let menuItems = [];
let menuIndex = 0;

function showMenu(title, msg, items) {
  state = "menu";
  menuItems = items;
  menuIndex = 0;
  els.overlayTitle.textContent = title;
  els.overlayMsg.innerHTML = msg;
  els.menu.innerHTML = "";
  items.forEach((item, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "menu__item";
    b.setAttribute("role", "menuitem");
    b.setAttribute("data-touch-ignore", "");
    b.textContent = item.label;
    b.addEventListener("pointerdown", (e) => { e.preventDefault(); menuIndex = i; runMenuItem(); });
    els.menu.appendChild(b);
  });
  renderMenu();
  els.menu.hidden = false;
  els.overlay.classList.remove("overlay--hidden");
  syncControls();
  updateHud();
}

function renderMenu() {
  [...els.menu.children].forEach((el, i) => {
    el.classList.toggle("menu__item--active", i === menuIndex);
  });
}

function runMenuItem() {
  const item = menuItems[menuIndex];
  if (item) item.run();
}

function openingMenu() {
  engine.reset(1);                   // a fresh rack behind the card, no stale winner
  effects.length = 0;
  showMenu("8-Ball Pool", "Rack 'em up — pot your group, then sink the 8.", [
    { label: "2 Players", run: () => startGame("two") },
    { label: "vs Computer", run: () => startGame("ai") },
  ]);
}

// ---- Game flow --------------------------------------------------------------
function startGame(chosenMode) {
  sound.resume();                    // first gesture unlocks audio
  sound.start();
  mode = chosenMode;
  engine.reset(1);
  effects.length = 0;
  spin = { x: 0, y: 0 };
  spinPreset = 0;
  power = 0;
  charging = false;
  ai = null;
  els.menu.hidden = true;
  els.overlay.classList.add("overlay--hidden");
  beginTurn(true);
}

/** Hand the table to whoever is up: place-the-cue-ball first, or straight to aim. */
function beginTurn(isBreak = false) {
  power = 0;
  charging = false;
  aimHeld.left = aimHeld.right = 0;
  if (engine.ballInHand) {
    state = "inhand";
    placeValid = true;
    setStatus(`${nameOf(engine.turn)} — place the cue ball`);
  } else {
    state = "aim";
    setStatus(turnLine());
  }
  faceNearestTarget();
  if (isBreak) toast(`${nameOf(engine.turn)} breaks`, "info");
  syncControls();
  updateHud();
  updatePowerBar();
  if (isComputerTurn()) startComputerTurn();
}

function turnLine() {
  const target = engine.legalTarget();
  const what = target === "eight" ? "on the 8-ball"
    : target === "any" ? "table is open"
      : `on ${target}s`;
  return `${nameOf(engine.turn)} — ${what}`;
}

/** Point the cue at the closest ball this player is allowed to hit. */
function faceNearestTarget() {
  const cue = engine.cue;
  let best = null;
  for (const b of engine.active()) {
    if (b.id === 0 || !engine.isLegalTarget(b)) continue;
    const d = Math.hypot(b.x - cue.x, b.y - cue.y);
    if (!best || d < best.d) best = { d, b };
  }
  if (best) aimAngle = Math.atan2(best.b.y - cue.y, best.b.x - cue.x);
}

function isComputerTurn() {
  return mode === "ai" && engine.turn !== HUMAN && !engine.gameOver;
}

/** May this seat act right now? */
function seatMayAct(seat) {
  if (mode === "ai") return engine.turn === HUMAN;
  if (!twoPhones()) return true;      // single controller drives both seats
  return seat === engine.turn;
}

function startCharge() {
  if (state !== "aim" || charging) return;
  sound.resume();
  charging = true;
  chargeStart = performance.now();
}

function fireShot() {
  if (state === "inhand") { confirmPlacement(); return; }
  if (state !== "aim") return;
  const p = charging ? currentCharge() : power;
  charging = false;
  if (p < 0.06) { power = 0; updatePowerBar(); return; }   // a tap isn't a shot
  power = p;
  engine.strike(aimAngle, power, spin);
  sound.drop();
  state = "shooting";
  ai = null;
  lastTime = performance.now();
  acc = 0;
  setStatus("");
  syncControls();
  updatePowerBar();
}

function currentCharge() {
  return Math.min(1, (performance.now() - chargeStart) / CHARGE_MS);
}

function confirmPlacement() {
  if (state !== "inhand") return;
  if (!engine.canPlace(engine.cue.x, engine.cue.y)) { toast("Not a legal spot", "bad"); return; }
  engine.settleCue();
  state = "aim";
  faceNearestTarget();
  setStatus(turnLine());
  syncControls();
  updateHud();
}

/** The table has stopped — score the shot and narrate what happened. */
function finishShot() {
  const shooter = engine.turn;
  const result = engine.resolveShot();

  if (result.rerack) {
    toast("8-ball on the break — re-rack", "info");
    beginTurn(true);
    return;
  }

  if (result.gameOver) {
    endGame(result);
    return;
  }

  if (result.assigned) {
    toast(`${nameOf(shooter)} is ${result.assigned}s`, "good");
  } else if (result.foul) {
    toast(`Foul — ${result.reason}`, "bad");
    sound.lock();
  } else if (result.potted.length) {
    toast(result.potted.length > 1 ? `${result.potted.length} down!` : "Potted!", "good");
  } else {
    toast("Miss", "info");
  }

  power = 0;
  spin = { x: 0, y: 0 };
  spinPreset = 0;
  renderSpin();
  beginTurn(false);
}

function endGame(result) {
  state = "over";
  const winner = result.winner;
  const won = mode !== "ai" || winner === HUMAN;
  if (won) sound.levelUp(); else sound.gameOver();
  power = 0;
  charging = false;
  updatePowerBar();
  updateHud();
  setStatus(`${nameOf(winner)} wins`);

  // Console records: only the real 2-player table keeps a win/loss row.
  if (mode === "two") Stats.result({ outcome: "win", winnerSlot: winner });

  // A clean win reads plainly; an early 8-ball explains itself.
  const why = result.reason ? `${result.reason} — the 8-ball settled it.` : "The 8-ball is down.";
  showMenu(`${nameOf(winner)} wins!`, why, [
    { label: "Rematch", run: () => startGame(mode) },
    { label: "Change mode", run: () => openingMenu() },
  ]);
}

// ---- The computer's turn ----------------------------------------------------
// Thinks for a beat, walks the cue ball to its chosen spot if it has ball in
// hand, then draws the cue back on screen before striking — so a watching
// player can read the shot rather than seeing balls teleport.
function startComputerTurn() {
  const plan = planShot(engine, 0.74);
  ai = { phase: "think", until: performance.now() + 700, plan };
  setStatus(`${nameOf(engine.turn)} is lining up…`);
}

function stepComputer(now) {
  if (!ai) return;
  if (now < ai.until) {
    if (ai.phase === "pull") {
      power = Math.min(ai.plan.power, power + 0.9 * (1 / 60));
      updatePowerBar();
    }
    return;
  }
  if (ai.phase === "think") {
    if (engine.ballInHand && ai.plan.place) {
      engine.placeCue(ai.plan.place.x, ai.plan.place.y);
      engine.settleCue();
      state = "aim";
      updateHud();
    }
    aimAngle = ai.plan.angle;
    power = 0;
    ai.phase = "pull";
    ai.until = now + 620;
    return;
  }
  // "pull" is over — take the shot.
  power = ai.plan.power;
  spin = ai.plan.spin;
  engine.strike(aimAngle, power, spin);
  sound.drop();
  state = "shooting";
  ai = null;
  updatePowerBar();
}

// ---- Intents ----------------------------------------------------------------
input.on((intent, player = 1) => {
  seenSeats.add(player);

  if (intent === "back") { location.href = "../"; return; }

  if (state === "menu") {
    switch (intent) {
      case "up": case "left":
        menuIndex = (menuIndex + menuItems.length - 1) % menuItems.length; renderMenu(); return;
      case "down": case "right":
        menuIndex = (menuIndex + 1) % menuItems.length; renderMenu(); return;
      case "enter": runMenuItem(); return;
    }
    return;
  }

  if (state === "over" || state === "shooting") return;
  if (!seatMayAct(player)) return;

  if (state === "inhand") {
    switch (intent) {
      case "left": nudgeCue(-1, 0); return;
      case "right": nudgeCue(1, 0); return;
      case "up": nudgeCue(0, -1); return;
      case "down": nudgeCue(0, 1); return;
      case "place": case "enter": confirmPlacement(); return;
    }
    return;
  }

  // Aiming.
  switch (intent) {
    // Held rotate from the phone pad (press … release).
    case "aim-left": aimHeld.left = performance.now(); return;
    case "aim-left:release": aimHeld.left = 0; return;
    case "aim-right": aimHeld.right = performance.now(); return;
    case "aim-right:release": aimHeld.right = 0; return;
    // Discrete rotate: gamepad d-pad, TV remote, and keyboard auto-repeat on
    // top of the smooth hold below — a fine trim either way.
    case "left": aimAngle -= NUDGE; return;
    case "right": aimAngle += NUDGE; return;
    case "up": setSpin(spin.x, clamp(spin.y + 0.25, -1, 1)); return;
    case "down": setSpin(spin.x, clamp(spin.y - 0.25, -1, 1)); return;
    case "spin": cycleSpin(); return;
    // Charge on press, shoot on release. A controller that only sends presses
    // (gamepad A) charges on the first and fires on the second.
    case "shoot": case "enter":
      if (charging) fireShot(); else startCharge();
      return;
    case "shoot:release": case "enter:release":
      fireShot();
      return;
  }
});

function nudgeCue(dx, dy) {
  const now = performance.now();
  const dir = dx * 2 + dy;
  // Repeated taps (or a held key's auto-repeat) glide instead of crawling.
  const fast = lastNudge.dir === dir && now - lastNudge.at < 140;
  lastNudge = { dir, at: now };
  const step = fast ? PLACE_STEP * 2.4 : PLACE_STEP;
  const cue = engine.cue;
  const x = cue.x + dx * step;
  const y = cue.y + dy * step;
  if (engine.placeCue(x, y)) placeValid = true;
}

// ---- Keyboard (held keys the discrete intent layer can't express) -----------
window.addEventListener("keydown", (e) => {
  if (e.key === "m" || e.key === "M") { toggleMute(); return; }
  if (state !== "aim" || e.repeat) return;
  if (e.key === "ArrowLeft") aimHeld.left = performance.now();
  else if (e.key === "ArrowRight") aimHeld.right = performance.now();
});
window.addEventListener("keyup", (e) => {
  if (e.key === "ArrowLeft") aimHeld.left = 0;
  else if (e.key === "ArrowRight") aimHeld.right = 0;
  else if ((e.key === " " || e.key === "Enter") && charging) fireShot();
});

// ---- Pointer on the table ---------------------------------------------------
// Drag anywhere to aim at your finger; start the drag on the cue ball to pull
// the stick back — distance is power, letting go takes the shot. While placing
// the cue ball, the drag carries it and releasing drops it.
let drag = null;
const PULL_GRAB = BALL_R * 4;        // how close to the cue ball a pull starts
const PULL_FULL = 190;               // drag length (table units) for full power

canvas.addEventListener("pointerdown", (e) => {
  if (state === "menu" || state === "over") return;
  if (isComputerTurn()) return;      // hands off while the computer shoots
  const p = worldFromEvent(e);
  canvas.setPointerCapture(e.pointerId);
  if (state === "inhand") {
    drag = { kind: "place" };
    movePlacement(p);
    return;
  }
  if (state !== "aim") return;
  const cue = engine.cue;
  const d = Math.hypot(p.x - cue.x, p.y - cue.y);
  if (d < PULL_GRAB) {
    drag = { kind: "pull", from: p };
    sound.resume();
  } else {
    drag = { kind: "aim" };
    aimAngle = Math.atan2(p.y - cue.y, p.x - cue.x);
  }
});

canvas.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const p = worldFromEvent(e);
  const cue = engine.cue;
  if (drag.kind === "place") { movePlacement(p); return; }
  if (drag.kind === "aim") {
    aimAngle = Math.atan2(p.y - cue.y, p.x - cue.x);
    return;
  }
  // Pull-back: the shot flies opposite the drag, power grows with the pull.
  const dx = cue.x - p.x;
  const dy = cue.y - p.y;
  const len = Math.hypot(dx, dy);
  if (len > BALL_R) aimAngle = Math.atan2(dy, dx);
  power = clamp((len - BALL_R) / PULL_FULL, 0, 1);
  updatePowerBar();
});

function endDrag() {
  if (!drag) return;
  const kind = drag.kind;
  drag = null;
  if (kind === "place") { confirmPlacement(); return; }
  if (kind === "pull") {
    if (power >= 0.06) fireShot();
    else { power = 0; updatePowerBar(); }
  }
}
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);

function movePlacement(p) {
  const x = clamp(p.x, BALL_R, TABLE_W - BALL_R);
  const y = clamp(p.y, BALL_R, TABLE_H - BALL_R);
  placeValid = engine.canPlace(x, y);
  if (placeValid) engine.placeCue(x, y);
  else { engine.cue.x = x; engine.cue.y = y; }   // show it, refuse to settle it
}

// ---- Spin widget ------------------------------------------------------------
function setSpin(x, y) {
  spin = { x: clamp(x, -1, 1), y: clamp(y, -1, 1) };
  renderSpin();
}

function cycleSpin() {
  spinPreset = (spinPreset + 1) % SPIN_PRESETS.length;
  const p = SPIN_PRESETS[spinPreset];
  setSpin(p.x, p.y);
  toast(p.label, "info");
}

function renderSpin() {
  els.spinDot.style.left = `${50 + spin.x * 34}%`;
  els.spinDot.style.top = `${50 - spin.y * 34}%`;
}

function spinFromPointer(e) {
  const r = els.spinPad.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width - 0.5) * 2.4;
  const y = -((e.clientY - r.top) / r.height - 0.5) * 2.4;
  const len = Math.hypot(x, y);
  const k = len > 1 ? 1 / len : 1;                // keep the tip on the ball
  setSpin(x * k, y * k);
}

els.spinPad.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  els.spinPad.setPointerCapture(e.pointerId);
  spinFromPointer(e);
});
els.spinPad.addEventListener("pointermove", (e) => {
  if (els.spinPad.hasPointerCapture(e.pointerId)) spinFromPointer(e);
});

// ---- Phone / on-screen controls --------------------------------------------
// The phone pad changes with the state: rotate + shoot while aiming, a d-pad
// while walking the cue ball around after a foul, OK on the menus.
function syncControls() {
  if (state === "inhand") {
    Controls.define({ profile: "dpad", buttons: [{ id: "place", label: "Place" }] });
  } else if (state === "aim") {
    Controls.define({
      profile: "buttons",
      buttons: [
        { id: "aim-left", label: "◀ Aim", hold: true },
        { id: "shoot", label: "SHOOT", hold: true },
        { id: "aim-right", label: "Aim ▶", hold: true },
        { id: "spin", label: "Spin" },
      ],
    });
  } else {
    Controls.define({ profile: "dpad", buttons: [{ id: "enter", label: "OK" }] });
  }

  // The on-screen pad follows the same shape: rotate + spin only make sense
  // while aiming, and the big button says what it currently does.
  const aiming = state === "aim";
  for (const b of [touchBtns.aimL, touchBtns.aimR, touchBtns.spin]) b.hidden = !aiming;
  touchBtns.shoot.textContent =
    state === "inhand" ? "PLACE" : state === "menu" ? "START" : "SHOOT";
  touchBtns.shoot.hidden = state === "shooting";
}

// Built by hand (not via the shared makeButton) because aim and shoot need
// press/release semantics rather than a repeating tap.
const touchBtns = {};
function buildTouchControls() {
  const make = (label, aria, onDown, onUp, cls) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = ("tbtn " + (cls || "")).trim();
    b.textContent = label;
    b.setAttribute("data-touch-ignore", "");
    b.setAttribute("aria-label", aria);
    b.addEventListener("pointerdown", (e) => { e.preventDefault(); onDown(); });
    if (onUp) {
      b.addEventListener("pointerup", (e) => { e.preventDefault(); onUp(); });
      b.addEventListener("pointerleave", () => onUp());
      b.addEventListener("pointercancel", () => onUp());
    }
    els.touchControls.appendChild(b);
    return b;
  };

  touchBtns.aimL = make("◀", "Aim left",
    () => { aimHeld.left = performance.now(); }, () => { aimHeld.left = 0; }, "aim");
  touchBtns.shoot = make("SHOOT", "Charge and shoot", () => {
    if (state === "inhand") confirmPlacement();
    else if (state === "menu") runMenuItem();
    else startCharge();
  }, () => { if (charging) fireShot(); }, "shoot");
  touchBtns.aimR = make("▶", "Aim right",
    () => { aimHeld.right = performance.now(); }, () => { aimHeld.right = 0; }, "aim");
  touchBtns.spin = make("↻", "Cycle spin", () => cycleSpin(), null, "spin");
}

// ---- Loop -------------------------------------------------------------------
function loop(now) {
  const dt = Math.min((now - lastTime) / 1000 || 0, MAX_FRAME);
  lastTime = now;

  if (state === "aim") {
    applyHeldAim(now, dt);
    if (charging) { power = currentCharge(); updatePowerBar(); }
  }

  if (ai) stepComputer(now);

  if (state === "shooting") {
    acc += dt;
    let steps = 0;
    while (acc >= PHYS_DT && steps < 900) {
      processEvents(engine.step(PHYS_DT));
      acc -= PHYS_DT;
      steps++;
    }
    if (!engine.moving) { acc = 0; finishShot(); }
  }

  for (let i = effects.length - 1; i >= 0; i--) {
    effects[i].t += dt;
    if (effects[i].t >= effects[i].life) effects.splice(i, 1);
  }

  draw();
  requestAnimationFrame(loop);
}

// Rotate while ← / → (or the phone's hold buttons) are down: slow for the first
// moment so a tap is a hair's adjustment, then quicker for a big swing.
function applyHeldAim(now, dt) {
  const speed = (startedAt) => {
    const held = now - startedAt;
    const k = Math.min(1, held / AIM_RAMP);
    return AIM_SLOW + (AIM_FAST - AIM_SLOW) * k * k;
  };
  if (aimHeld.left) aimAngle -= speed(aimHeld.left) * dt;
  if (aimHeld.right) aimAngle += speed(aimHeld.right) * dt;
}

// Table sounds, rate-limited so a break doesn't turn into a machine-gun.
let lastClick = 0;
let lastRail = 0;
function processEvents(events) {
  const now = performance.now();
  for (const ev of events) {
    if (ev.type === "click") {
      if (ev.speed > 25 && now - lastClick > 28) {
        lastClick = now;
        if (ev.speed > 320) sound.lock(); else sound.move();
      }
    } else if (ev.type === "rail") {
      if (ev.speed > 90 && now - lastRail > 45) { lastRail = now; sound.rotate(); }
    } else if (ev.type === "pot") {
      sound.clear(1);
      const ball = engine.ball(ev.id);
      const pocket = nearestPocket(ball);
      effects.push({ kind: "pot", x: pocket.x, y: pocket.y, t: 0, life: 0.55, colour: BALL_COLOURS[ev.id] });
      updateHud();
    }
  }
}

function nearestPocket(ball) {
  let best = POCKETS[0];
  let bd = Infinity;
  for (const p of POCKETS) {
    const d = Math.hypot(p.x - ball.x, p.y - ball.y);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

// ---- Rendering --------------------------------------------------------------
function draw() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  applyView();

  drawRails();
  drawFelt();
  drawPockets();
  if (state === "inhand" && engine.kitchen) drawHeadString();
  if (state === "aim" || (ai && ai.phase === "pull")) drawGuides();
  for (const b of engine.balls) if (!b.potted) drawBall(b);
  if (state === "inhand") drawPlacementGhost();
  if (state === "aim" || (ai && ai.phase === "pull")) drawCue();
  drawEffects();
}

function drawRails() {
  const r = 18;
  const wood = ctx.createLinearGradient(-RAIL, -RAIL, TABLE_W + RAIL, TABLE_H + RAIL);
  wood.addColorStop(0, "#4a2f1d");
  wood.addColorStop(0.5, "#7a4c2a");
  wood.addColorStop(1, "#3a2416");
  ctx.fillStyle = wood;
  roundRect(-RAIL, -RAIL, WORLD_W, WORLD_H, r);
  ctx.fill();

  // Inner bevel where the cushion meets the felt.
  ctx.strokeStyle = "rgba(0,0,0,0.45)";
  ctx.lineWidth = 3;
  roundRect(-3, -3, TABLE_W + 6, TABLE_H + 6, 6);
  ctx.stroke();

  // Rail sights (the little diamonds real tables use for aiming banks).
  ctx.fillStyle = "rgba(240, 226, 200, 0.75)";
  for (let i = 1; i < 8; i++) {
    if (i === 4) continue;                        // the side pocket sits here
    const x = (TABLE_W * i) / 8;
    diamond(x, -RAIL / 2, 4.5);
    diamond(x, TABLE_H + RAIL / 2, 4.5);
  }
  for (let i = 1; i < 4; i++) {
    const y = (TABLE_H * i) / 4;
    diamond(-RAIL / 2, y, 4.5);
    diamond(TABLE_W + RAIL / 2, y, 4.5);
  }
}

function drawFelt() {
  const g = ctx.createRadialGradient(
    TABLE_W * 0.5, TABLE_H * 0.35, TABLE_H * 0.1,
    TABLE_W * 0.5, TABLE_H * 0.5, TABLE_W * 0.72
  );
  g.addColorStop(0, "#1b6f68");
  g.addColorStop(0.55, "#125148");
  g.addColorStop(1, "#0a332f");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, TABLE_W, TABLE_H);

  // Foot spot, so the rack reads as a rack.
  ctx.fillStyle = "rgba(255,255,255,0.12)";
  ctx.beginPath();
  ctx.arc(TABLE_W * 0.75, TABLE_H / 2, 2.4, 0, Math.PI * 2);
  ctx.fill();
}

function drawPockets() {
  for (const p of POCKETS) {
    const g = ctx.createRadialGradient(p.x, p.y, POCKET_R * 0.25, p.x, p.y, POCKET_R * 1.5);
    g.addColorStop(0, "#000000");
    g.addColorStop(0.62, "#05070c");
    g.addColorStop(1, "rgba(3, 6, 10, 0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, POCKET_R * 1.5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#03050a";
    ctx.beginPath();
    ctx.arc(p.x, p.y, POCKET_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(228, 212, 180, 0.35)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function drawHeadString() {
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.28)";
  ctx.setLineDash([8, 8]);
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(HEAD_STRING, 0);
  ctx.lineTo(HEAD_STRING, TABLE_H);
  ctx.stroke();
  ctx.restore();
}

// Aim assist: the line the cue ball travels, a ghost ball at contact, and the
// line the struck ball would take — plus the cue's own tangent path.
function drawGuides() {
  const cue = engine.cue;
  const p = predictShot(engine, aimAngle);

  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.setLineDash([10, 9]);
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(cue.x + Math.cos(aimAngle) * BALL_R, cue.y + Math.sin(aimAngle) * BALL_R);
  ctx.lineTo(p.contact.x, p.contact.y);
  ctx.stroke();
  ctx.setLineDash([]);

  if (p.target) {
    const legal = engine.isLegalTarget(p.target);
    const tint = legal ? "rgba(120, 255, 190, 0.9)" : "rgba(255, 120, 120, 0.85)";

    // Ghost ball: where the cue ball sits at the moment of contact.
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(p.contact.x, p.contact.y, BALL_R, 0, Math.PI * 2);
    ctx.stroke();

    // Where the object ball goes.
    ctx.strokeStyle = tint;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(p.target.x, p.target.y);
    ctx.lineTo(p.target.x + p.targetDir.x * 92, p.target.y + p.targetDir.y * 92);
    ctx.stroke();

    // …and the tangent the cue ball peels off along.
    const side = Math.sign(
      Math.cos(aimAngle) * -p.targetDir.y + Math.sin(aimAngle) * p.targetDir.x
    ) || 1;
    const tx = -p.targetDir.y * side;
    const ty = p.targetDir.x * side;
    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    ctx.lineWidth = 1.6;
    ctx.setLineDash([6, 7]);
    ctx.beginPath();
    ctx.moveTo(p.contact.x, p.contact.y);
    ctx.lineTo(p.contact.x + tx * 58, p.contact.y + ty * 58);
    ctx.stroke();
  }
  ctx.restore();
}

// The stick, pulled back by however much power is loaded.
function drawCue() {
  const cue = engine.cue;
  const shown = charging ? currentCharge() : power;
  const back = BALL_R + 10 + shown * 105;
  const dx = Math.cos(aimAngle);
  const dy = Math.sin(aimAngle);
  const x0 = cue.x - dx * back;
  const y0 = cue.y - dy * back;
  const len = 300;
  const x1 = x0 - dx * len;
  const y1 = y0 - dy * len;

  ctx.save();
  ctx.lineCap = "round";
  // Shadow on the felt.
  ctx.strokeStyle = "rgba(0,0,0,0.28)";
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(x0 + 3, y0 + 4);
  ctx.lineTo(x1 + 3, y1 + 4);
  ctx.stroke();

  const wood = ctx.createLinearGradient(x0, y0, x1, y1);
  wood.addColorStop(0, "#e9d6b0");
  wood.addColorStop(0.22, "#c99a5c");
  wood.addColorStop(1, "#3b2415");
  ctx.strokeStyle = wood;
  ctx.lineWidth = 5.4;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();

  // Ferrule + tip.
  ctx.strokeStyle = "#f4f1e6";
  ctx.lineWidth = 5.6;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x0 - dx * 9, y0 - dy * 9);
  ctx.stroke();
  ctx.strokeStyle = "#2f7fb8";
  ctx.lineWidth = 5.6;
  ctx.beginPath();
  ctx.moveTo(x0 + dx * 2.5, y0 + dy * 2.5);
  ctx.lineTo(x0 - dx * 1.5, y0 - dy * 1.5);
  ctx.stroke();
  ctx.restore();
}

function drawBall(b) {
  const r = BALL_R;
  const colour = BALL_COLOURS[b.id];

  // Contact shadow.
  ctx.fillStyle = "rgba(0,0,0,0.38)";
  ctx.beginPath();
  ctx.ellipse(b.x + 2.6, b.y + 3.4, r * 1.02, r * 0.92, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.save();
  ctx.beginPath();
  ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
  ctx.clip();

  const striped = b.group === STRIPE;
  const base = striped ? "#f4efe2" : colour;
  const g = ctx.createRadialGradient(b.x - r * 0.38, b.y - r * 0.42, r * 0.12, b.x, b.y, r * 1.05);
  g.addColorStop(0, mix(base, "#ffffff", 0.55));
  g.addColorStop(0.55, base);
  g.addColorStop(1, mix(base, "#000000", 0.45));
  ctx.fillStyle = g;
  ctx.fillRect(b.x - r, b.y - r, r * 2, r * 2);

  if (striped) {
    // The band rolls with the ball — cheap, but it sells the motion.
    const angle = b.roll / (r * 2.2) + b.id;
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(angle);
    const bg = ctx.createLinearGradient(0, -r * 0.6, 0, r * 0.6);
    bg.addColorStop(0, mix(colour, "#000000", 0.25));
    bg.addColorStop(0.4, mix(colour, "#ffffff", 0.25));
    bg.addColorStop(1, mix(colour, "#000000", 0.3));
    ctx.fillStyle = bg;
    ctx.fillRect(-r, -r * 0.62, r * 2, r * 1.24);
    ctx.restore();
  }

  if (b.id !== 0) {
    ctx.fillStyle = "#fbf8ef";
    ctx.beginPath();
    ctx.arc(b.x, b.y, r * 0.44, 0, Math.PI * 2);
    ctx.fill();
    // Numbers stay upright even when the whole table is turned a quarter turn.
    ctx.save();
    ctx.translate(b.x, b.y);
    if (view.rotated) ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = "#14161f";
    ctx.font = `700 ${r * 0.66}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(b.id), 0, r * 0.03);
    ctx.restore();
  } else if (spin.x || spin.y) {
    // Show where the tip will strike the cue ball.
    ctx.fillStyle = "rgba(220, 60, 60, 0.85)";
    ctx.beginPath();
    ctx.arc(b.x + spin.x * r * 0.55, b.y - spin.y * r * 0.55, r * 0.19, 0, Math.PI * 2);
    ctx.fill();
  }

  // Gloss.
  ctx.fillStyle = "rgba(255,255,255,0.4)";
  ctx.beginPath();
  ctx.ellipse(b.x - r * 0.34, b.y - r * 0.4, r * 0.3, r * 0.2, -0.7, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle = "rgba(0,0,0,0.28)";
  ctx.lineWidth = 0.9;
  ctx.beginPath();
  ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
  ctx.stroke();
}

function drawPlacementGhost() {
  const cue = engine.cue;
  ctx.save();
  ctx.setLineDash([6, 6]);
  ctx.lineWidth = 2;
  ctx.strokeStyle = placeValid ? "rgba(120, 255, 190, 0.9)" : "rgba(255, 110, 110, 0.95)";
  ctx.beginPath();
  ctx.arc(cue.x, cue.y, BALL_R + 6, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawEffects() {
  for (const fx of effects) {
    const k = fx.t / fx.life;
    ctx.save();
    ctx.globalAlpha = 1 - k;
    ctx.strokeStyle = fx.colour || "#ffffff";
    ctx.lineWidth = 3 * (1 - k) + 1;
    ctx.beginPath();
    ctx.arc(fx.x, fx.y, POCKET_R * (0.6 + k * 1.4), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

// ---- HUD --------------------------------------------------------------------
let rackSignature = "";

function updateHud() {
  for (const seat of [1, 2]) {
    els.names[seat].textContent = nameOf(seat);
    const group = engine.groups[seat];
    els.groups[seat].textContent = group
      ? (engine.remaining(group) === 0 ? "8-ball" : group === SOLID ? "Solids" : "Stripes")
      : "Open";
    els.cards[seat].classList.toggle("pcard--active", engine.turn === seat && state !== "menu");
    els.cards[seat].classList.toggle("pcard--won", engine.gameOver && engine.winner === seat);
  }

  els.turnName.textContent = state === "menu" ? "—" : nameOf(engine.turn);
  const target = engine.legalTarget();
  // On a phone the top-bar prompt is hidden, so this line carries ball-in-hand.
  els.turnGroup.textContent = state === "menu" ? "—"
    : state === "inhand" ? "Ball in hand — place it"
      : target === "any" ? "Open table"
        : target === "eight" ? "8-ball"
          : target === SOLID ? "Solids" : "Stripes";

  // Ball racks — rebuilt only when something actually went down.
  const sig = engine.balls.map((b) => (b.potted ? "1" : "0")).join("") +
    engine.groups[1] + engine.groups[2];
  if (sig !== rackSignature) {
    rackSignature = sig;
    for (const seat of [1, 2]) {
      const group = engine.groups[seat];
      const ids = group === SOLID ? [1, 2, 3, 4, 5, 6, 7]
        : group === STRIPE ? [9, 10, 11, 12, 13, 14, 15]
          : [];
      const rack = els.racks[seat];
      rack.innerHTML = "";
      if (!ids.length) {
        const hint = document.createElement("span");
        hint.className = "rack__hint";
        hint.textContent = "group not assigned";
        rack.appendChild(hint);
        continue;
      }
      for (const id of ids) {
        const pip = document.createElement("i");
        const ball = engine.ball(id);
        pip.className = "pip" + (ball.potted ? " pip--down" : "") +
          (id > 8 ? " pip--stripe" : "");
        pip.style.setProperty("--c", BALL_COLOURS[id]);
        pip.title = `Ball ${id}`;
        rack.appendChild(pip);
      }
      const eight = document.createElement("i");
      eight.className = "pip pip--eight" + (engine.remaining(group) === 0 ? " pip--live" : "");
      eight.style.setProperty("--c", BALL_COLOURS[8]);
      eight.title = "8-ball";
      rack.appendChild(eight);
    }
  }
}

function updatePowerBar() {
  const p = charging ? currentCharge() : power;
  els.powerFill.style.width = `${Math.round(p * 100)}%`;
  els.powerValue.textContent = `${Math.round(p * 100)}%`;
}

// ---- Chrome -----------------------------------------------------------------
let toastTimer = null;
function toast(text, kind = "info") {
  els.toast.textContent = text;
  els.toast.className = `toast toast--${kind} toast--show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.className = "toast"; }, 2200);
}

function setStatus(text) { els.status.textContent = text; }

function renderMute() {
  els.mute.textContent = sound.muted ? "🔇" : "🔊";
  els.mute.setAttribute("aria-pressed", String(sound.muted));
}
function toggleMute() { sound.toggleMute(); renderMute(); }

// ---- Small helpers ----------------------------------------------------------
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function diamond(x, y, r) {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r * 0.62, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r * 0.62, y);
  ctx.closePath();
  ctx.fill();
}

// Blend two #rrggbb colours — used for the ball gradients.
function mix(a, b, k) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (shift) => {
    const va = (pa >> shift) & 255;
    const vb = (pb >> shift) & 255;
    return Math.round(va + (vb - va) * k);
  };
  return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
}

// ---- Boot -------------------------------------------------------------------
function boot() {
  input.start();
  buildTouchControls();
  renderSpin();
  updatePowerBar();
  renderMute();
  els.mute.addEventListener("click", toggleMute);
  window.addEventListener("resize", resize);
  // The table box also changes when the control pad swaps buttons per state, so
  // watch the element itself rather than only the window.
  if (window.ResizeObserver) new ResizeObserver(() => resize()).observe(canvas.parentElement);
  // Names can arrive (or change) after the break — repaint the labels.
  Roster.onChange(() => updateHud());

  resize();
  openingMenu();
  setStatus(isTouchDevice() ? "Pick a mode to break" : "Pick a mode · Enter");
  lastTime = performance.now();
  requestAnimationFrame(loop);
}

boot();
