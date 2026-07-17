// Bubble Trouble for Space Console — entry point.
// Wires input to the pure engine, runs a fixed-dt accumulator loop, and renders
// the room, the bouncing balls, one or two player characters, the harpoons, and
// the HUD (timer bar, per-player lives, level). The engine owns all rules +
// physics; this file is input + render only.
//
// Movement needs smooth held-key control, so we read the physical keys directly
// here and feed each player a move direction every frame:
//   Player 1 — ← / → move, ↑ or Space shoot
//   Player 2 — A / D move, W shoot
// The shared Input layer handles Back (→ menu) and touch taps; on-screen buttons
// cover single-player touch.

import {
  Engine,
  WORLD_W, WORLD_H,
  WALL, PLAY_L, PLAY_R, FLOOR_Y,
  PLAYER_W, PLAYER_H,
} from "./engine.js?v=155e6772-d8bf-4116-b9d3-c68c753e9da2";
import { Input } from "../assets/js/shared/input.js?v=155e6772-d8bf-4116-b9d3-c68c753e9da2";
import { Sound } from "../assets/js/shared/sound.js?v=155e6772-d8bf-4116-b9d3-c68c753e9da2";
import { Controls } from "../assets/js/shared/controls.js?v=155e6772-d8bf-4116-b9d3-c68c753e9da2";

const engine = new Engine(Math.random);
const input = new Input();
const sound = new Sound();

const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");

const els = {
  status: document.getElementById("status"),
  score: document.getElementById("score"),
  best: document.getElementById("best"),
  level: document.getElementById("level"),
  overlay: document.getElementById("overlay"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlayMsg: document.getElementById("overlayMsg"),
  mute: document.getElementById("mute"),
  btn1p: document.getElementById("btn1p"),
  btn2p: document.getElementById("btn2p"),
  btnLeft: document.getElementById("btnLeft"),
  btnRight: document.getElementById("btnRight"),
  btnFire: document.getElementById("btnFire"),
};

const BEST_KEY = "bubbletrouble.best";
let best = Number(localStorage.getItem(BEST_KEY) || 0);

// Per-player held-movement state (index 0 = P1, 1 = P2).
const held = [{ left: false, right: false }, { left: false, right: false }];

// Per-player palettes — the character and life icons are tinted from these so
// the two players are instantly distinguishable.
const PALETTES = [
  { suit: "#3a7bd5", suitDark: "#274f96", cap: "#ffd23f", accent: "#ffe27a", name: "P1" },
  { suit: "#e0556b", suitDark: "#a8324a", cap: "#46e0a0", accent: "#7af0c0", name: "P2" },
];

// Ball colour keyed to size, so a split visibly steps down the palette.
const BALL_COLORS = [
  { lit: "#7fe3ff", mid: "#26a9e0", dark: "#0e5f8c" },
  { lit: "#bff36e", mid: "#6fc62f", dark: "#3a7c14" },
  { lit: "#ffd166", mid: "#f5a623", dark: "#a8650a" },
  { lit: "#ff9a8b", mid: "#ff5a5a", dark: "#a81f24" },
];

const STEP = 1 / 120;
const MAX_FRAME = 0.05;
let lastTime = 0;
let acc = 0;
let animClock = 0;

// ---- Game-state transitions ----------------------------------------------
function startGame(numPlayers) {
  sound.resume();
  sound.start();
  held[0].left = held[0].right = held[1].left = held[1].right = false;
  engine.start(numPlayers);
  els.level.textContent = engine.level + 1;
  hideOverlay();
  setStatus(numPlayers === 2 ? "2-player co-op" : "");
  lastTime = performance.now();
  acc = 0;
}

engine.addEventListener("shoot", () => sound.move());
engine.addEventListener("pop", () => sound.rotate());
engine.addEventListener("split", () => sound.lock());
engine.addEventListener("levelclear", () => sound.levelUp());
engine.addEventListener("die", () => sound.drop());
engine.addEventListener("levelstart", () => { els.level.textContent = engine.level + 1; });
engine.addEventListener("gameover", () => {
  sound.gameOver();
  if (engine.score > best) {
    best = engine.score;
    localStorage.setItem(BEST_KEY, String(best));
  }
  showMenu("Game Over", `Score ${engine.score} · Best ${best} · Reached level ${engine.level + 1}`);
  setStatus("Game over");
});

// ---- Input ----------------------------------------------------------------
// A phone controller sends held ◀ / ▶ + Fire as the intents below (see the
// Controls.define in boot); they drive P1's held-move state / fire.
input.on((intent) => {
  switch (intent) {
    case "back": location.href = "../"; return;
    // "enter"/Fire starts a 1-player game or fires P1.
    case "enter":
      if (idleOrOver()) startGame(1);
      else { sound.resume(); engine.fire(0); }
      return;
    case "left": held[0].left = true; return;
    case "left:release": held[0].left = false; return;
    case "right": held[0].right = true; return;
    case "right:release": held[0].right = false; return;
  }
});

function idleOrOver() { return engine.state === "idle" || engine.state === "over"; }

function firePlayer(id) {
  if (idleOrOver()) return;
  sound.resume();
  engine.fire(id);
}

window.addEventListener("keydown", (e) => {
  // Menu shortcuts.
  if (idleOrOver()) {
    if (e.key === "1") { startGame(1); return; }
    if (e.key === "2") { startGame(2); return; }
    if (e.key === "Enter" || e.key === " ") { startGame(1); return; }
  }
  switch (e.key) {
    case "ArrowLeft": held[0].left = true; e.preventDefault(); break;
    case "ArrowRight": held[0].right = true; e.preventDefault(); break;
    case "ArrowUp": case " ": if (!e.repeat) firePlayer(0); e.preventDefault(); break;
    case "a": case "A": held[1].left = true; break;
    case "d": case "D": held[1].right = true; break;
    case "w": case "W": if (!e.repeat) firePlayer(1); break;
  }
});
window.addEventListener("keyup", (e) => {
  switch (e.key) {
    case "ArrowLeft": held[0].left = false; break;
    case "ArrowRight": held[0].right = false; break;
    case "a": case "A": held[1].left = false; break;
    case "d": case "D": held[1].right = false; break;
  }
});

// Tap/click the board shoots for P1 (or starts a 1-player game).
canvas.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  if (idleOrOver()) startGame(1);
  else firePlayer(0);
});

// Menu buttons.
els.btn1p.addEventListener("pointerdown", (e) => { e.preventDefault(); startGame(1); });
els.btn2p.addEventListener("pointerdown", (e) => { e.preventDefault(); startGame(2); });

// On-screen controls (touch) drive P1.
function holdButton(el, set) {
  el.addEventListener("pointerdown", (e) => { e.preventDefault(); set(true); });
  el.addEventListener("pointerup", (e) => { e.preventDefault(); set(false); });
  el.addEventListener("pointerleave", () => set(false));
  el.addEventListener("pointercancel", () => set(false));
}
holdButton(els.btnLeft, (v) => (held[0].left = v));
holdButton(els.btnRight, (v) => (held[0].right = v));
els.btnFire.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  if (idleOrOver()) startGame(1); else firePlayer(0);
});

// ---- Loop -----------------------------------------------------------------
function loop(now) {
  let frame = (now - lastTime) / 1000;
  lastTime = now;
  if (frame > MAX_FRAME) frame = MAX_FRAME;
  animClock += frame;

  for (const p of engine.players) {
    const h = held[p.id];
    p.moveDir = (h.right ? 1 : 0) - (h.left ? 1 : 0);
  }
  acc += frame;
  while (acc >= STEP) { engine.step(STEP); acc -= STEP; }

  draw();
  requestAnimationFrame(loop);
}

// ---- Rendering ------------------------------------------------------------
let scaleX = 1, scaleY = 1;

function draw() {
  els.score.textContent = engine.score;
  els.best.textContent = Math.max(best, engine.score);

  ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
  drawRoom();
  drawBalls();
  drawHarpoons();
  for (const p of engine.players) if (!p.out) drawCharacter(p, PALETTES[p.id]);
  drawHud();
  drawInterlude();
}

function drawRoom() {
  const sky = ctx.createLinearGradient(0, 0, 0, FLOOR_Y);
  sky.addColorStop(0, "#1a2a6c");
  sky.addColorStop(0.55, "#2a6fb0");
  sky.addColorStop(1, "#5bc6e8");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);

  const sx = WORLD_W * 0.5 + Math.sin(animClock * 0.15) * 30;
  const glow = ctx.createRadialGradient(sx, 120, 20, sx, 120, 240);
  glow.addColorStop(0, "rgba(255,240,180,0.55)");
  glow.addColorStop(1, "rgba(255,240,180,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, WORLD_W, FLOOR_Y);

  drawHills(FLOOR_Y - 70, "rgba(40,90,70,0.55)", 90, 0.6);
  drawHills(FLOOR_Y - 36, "rgba(28,70,52,0.8)", 60, 1.0);
  drawWalls();
  drawFloor();
}

function drawHills(baseY, color, amp, phase) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, baseY);
  for (let x = 0; x <= WORLD_W; x += 20) {
    const y = baseY - Math.abs(Math.sin(x * 0.012 + phase)) * amp * 0.5;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(WORLD_W, FLOOR_Y);
  ctx.lineTo(0, FLOOR_Y);
  ctx.closePath();
  ctx.fill();
}

function drawWalls() {
  for (const wx of [0, WORLD_W - WALL]) {
    const g = ctx.createLinearGradient(wx, 0, wx + WALL, 0);
    g.addColorStop(0, "#3a4256");
    g.addColorStop(0.5, "#5b6478");
    g.addColorStop(1, "#2c3242");
    ctx.fillStyle = g;
    ctx.fillRect(wx, 0, WALL, WORLD_H);
    ctx.strokeStyle = "rgba(0,0,0,0.25)";
    ctx.lineWidth = 1;
    for (let y = 0; y < WORLD_H; y += 26) {
      ctx.beginPath(); ctx.moveTo(wx, y); ctx.lineTo(wx + WALL, y); ctx.stroke();
    }
  }
}

function drawFloor() {
  const g = ctx.createLinearGradient(0, FLOOR_Y, 0, WORLD_H);
  g.addColorStop(0, "#caa56a");
  g.addColorStop(1, "#8a6a39");
  ctx.fillStyle = g;
  ctx.fillRect(0, FLOOR_Y, WORLD_W, WORLD_H - FLOOR_Y);
  ctx.fillStyle = "rgba(255,240,200,0.5)";
  ctx.fillRect(0, FLOOR_Y, WORLD_W, 3);
  ctx.strokeStyle = "rgba(70,45,15,0.45)";
  ctx.lineWidth = 2;
  for (let x = 28; x < WORLD_W; x += 56) {
    ctx.beginPath(); ctx.moveTo(x, FLOOR_Y + 4); ctx.lineTo(x, WORLD_H); ctx.stroke();
  }
}

function drawBalls() {
  for (const b of engine.balls) {
    const c = BALL_COLORS[b.size];
    const groundGap = FLOOR_Y - (b.y + b.r);
    if (groundGap < 80) {
      const a = 0.28 * (1 - groundGap / 80);
      ctx.fillStyle = `rgba(0,0,0,${Math.max(0, a)})`;
      ctx.beginPath();
      ctx.ellipse(b.x, FLOOR_Y - 2, b.r * 0.9, b.r * 0.28, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    const g = ctx.createRadialGradient(b.x - b.r * 0.35, b.y - b.r * 0.4, b.r * 0.15, b.x, b.y, b.r);
    g.addColorStop(0, c.lit);
    g.addColorStop(0.5, c.mid);
    g.addColorStop(1, c.dark);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.25)"; ctx.lineWidth = 2; ctx.stroke();

    const hl = 0.75 + Math.sin(animClock * 3 + b.x * 0.05) * 0.1;
    ctx.fillStyle = `rgba(255,255,255,${hl})`;
    ctx.beginPath(); ctx.arc(b.x - b.r * 0.34, b.y - b.r * 0.4, b.r * 0.18, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.beginPath(); ctx.arc(b.x + b.r * 0.18, b.y - b.r * 0.1, b.r * 0.08, 0, Math.PI * 2); ctx.fill();
  }
}

function drawHarpoons() {
  for (const h of engine.harpoons) {
    const pal = PALETTES[h.owner] || PALETTES[0];
    ctx.strokeStyle = pal.accent;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(h.x, FLOOR_Y - 6); ctx.lineTo(h.x, h.tipY + 8); ctx.stroke();
    ctx.strokeStyle = "rgba(0,0,0,0.3)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(h.x, FLOOR_Y - 6); ctx.lineTo(h.x, h.tipY + 8); ctx.stroke();
    // Arrowhead.
    ctx.fillStyle = "#e8edf6";
    ctx.beginPath();
    ctx.moveTo(h.x, h.tipY);
    ctx.lineTo(h.x - 6, h.tipY + 12);
    ctx.lineTo(h.x + 6, h.tipY + 12);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = "#9aa3b8"; ctx.lineWidth = 1; ctx.stroke();
  }
}

// A friendly chibi adventurer: big round head, a peaked cap with a coloured
// band, big expressive eyes that track the facing direction, a rounded jumpsuit,
// and a raised arm holding a blaster. Tinted by the player's palette so the two
// players read clearly. Blinks while in the invulnerable respawn cooldown.
function drawCharacter(p, pal) {
  ctx.save();
  ctx.translate(p.x, FLOOR_Y);
  if (p.cooldown > 0 && Math.floor(animClock * 12) % 2 === 0) ctx.globalAlpha = 0.3;

  const bob = Math.sin(p.bob) * 1.5;
  ctx.translate(0, bob);
  if (p.moveDir) ctx.rotate(p.facing * 0.05);

  const skin = "#f6c49b";
  const { suit, suitDark, cap, accent } = pal;
  const f = p.facing;
  const stride = p.moveDir ? Math.sin(p.bob) * 3 : 0;

  // Shadow.
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.beginPath(); ctx.ellipse(0, 1, 15, 4.5, 0, 0, Math.PI * 2); ctx.fill();

  // Legs + shoes.
  ctx.fillStyle = suitDark;
  roundRect(-7 + stride, -13, 6, 13, 3);
  roundRect(1 - stride, -13, 6, 13, 3);
  ctx.fillStyle = "#eef0f6";
  roundRect(-10 + stride, -4, 10, 5, 2.5);
  roundRect(0 - stride, -4, 10, 5, 2.5);
  ctx.fillStyle = accent;
  ctx.fillRect(-10 + stride, -2.6, 10, 1.5);
  ctx.fillRect(0 - stride, -2.6, 10, 1.5);

  // Torso (rounded jumpsuit) + zipper + collar.
  ctx.fillStyle = suit;
  roundRect(-11, -31, 22, 21, 8);
  ctx.fillStyle = accent;
  ctx.fillRect(-1.2, -30, 2.4, 18);
  ctx.fillStyle = suitDark;
  roundRect(-9, -31, 18, 4, 2);

  // Back arm at side.
  ctx.strokeStyle = suit; ctx.lineWidth = 5.5; ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(-8, -27); ctx.lineTo(-13, -17); ctx.stroke();
  ctx.fillStyle = skin; dot(-13, -17, 3);

  // Front arm raised, holding the blaster up.
  ctx.strokeStyle = suit;
  ctx.beginPath(); ctx.moveTo(8, -27); ctx.lineTo(11, -37); ctx.stroke();
  ctx.fillStyle = skin; dot(11, -37, 3);
  ctx.fillStyle = "#444b5e"; roundRect(8, -51, 7, 14, 2);
  ctx.fillStyle = accent; ctx.fillRect(9, -53, 5, 4);
  ctx.fillStyle = "#5b6478"; ctx.fillRect(8, -45, 7, 2);

  // Head.
  ctx.fillStyle = skin; dot(0, -37, 12);

  // Cap (rounded crown + band + brim toward facing + button).
  ctx.fillStyle = cap;
  ctx.beginPath(); ctx.arc(0, -40, 12, Math.PI * 1.02, Math.PI * 1.98); ctx.closePath(); ctx.fill();
  ctx.fillRect(-12, -41, 24, 4);
  ctx.beginPath();
  ctx.moveTo(f * 2, -41); ctx.lineTo(f * 17, -42); ctx.lineTo(f * 17, -38); ctx.lineTo(f * 2, -37);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = accent; ctx.fillRect(-12, -38, 24, 2);
  ctx.fillStyle = accent; dot(0, -51, 2);

  // Face: big eyes (pupils track facing), sparkle, cheeks, smile.
  const look = f * 1.6;
  ctx.fillStyle = "#fff"; dot(-4 + look, -36, 3); dot(4 + look, -36, 3);
  ctx.fillStyle = "#27313f"; dot(-4 + look * 1.5, -35.5, 1.6); dot(4 + look * 1.5, -35.5, 1.6);
  ctx.fillStyle = "#fff"; dot(-4.8 + look * 1.5, -36.5, 0.6); dot(3.2 + look * 1.5, -36.5, 0.6);
  ctx.fillStyle = "rgba(255,130,130,0.45)"; dot(-7, -32, 2.2); dot(7, -32, 2.2);
  ctx.strokeStyle = "#9a4a36"; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(0, -32, 3, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();

  ctx.restore();
}

// ---- HUD: timer bar, per-player lives, level ------------------------------
function drawHud() {
  const pad = WALL + 6;
  const barW = WORLD_W - pad * 2;
  const barH = 10;
  const y = 8;
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  roundRect(pad, y, barW, barH, 5);
  const frac = engine.levelTime ? Math.max(0, engine.timeLeft / engine.levelTime) : 0;
  ctx.fillStyle = frac > 0.5 ? "#46e0a0" : frac > 0.22 ? "#ffd23f" : "#ff5a5a";
  roundRect(pad, y, Math.max(0, barW * frac), barH, 5);

  const ly = y + barH + 16;
  const p1 = engine.players[0];
  if (p1) for (let i = 0; i < p1.lives; i++) drawLifeIcon(pad + 12 + i * 22, ly, PALETTES[0]);

  if (engine.numPlayers >= 2) {
    const p2 = engine.players[1];
    if (p2) for (let i = 0; i < p2.lives; i++) drawLifeIcon(WORLD_W - pad - 12 - i * 22, ly, PALETTES[1]);
    label("LEVEL " + (engine.level + 1), WORLD_W / 2, ly, "center");
  } else {
    label("LEVEL " + (engine.level + 1), WORLD_W - pad - 8, ly, "right");
  }
}

function drawLifeIcon(x, y, pal) {
  ctx.fillStyle = "#f6c49b"; dot(x, y, 8);
  ctx.fillStyle = pal.cap;
  ctx.beginPath(); ctx.arc(x, y - 1, 8, Math.PI * 1.02, Math.PI * 1.98); ctx.closePath(); ctx.fill();
  ctx.fillRect(x - 8, y - 2, 16, 2.5);
  ctx.fillStyle = "#27313f"; dot(x - 2.6, y + 1, 1.4); dot(x + 2.6, y + 1, 1.4);
}

function label(text, x, y, align) {
  ctx.font = "bold 15px 'Segoe UI', sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = align === "right" ? "right" : "center";
  const tw = ctx.measureText(text).width;
  const bx = align === "right" ? x - tw - 8 : x - tw / 2 - 8;
  ctx.fillStyle = "rgba(0,0,0,0.4)";
  roundRect(bx, y - 11, tw + 16, 22, 6);
  ctx.fillStyle = "#fff";
  ctx.fillText(text, align === "right" ? x : x, y);
  ctx.textAlign = "left";
}

function drawInterlude() {
  let text = null;
  if (engine.state === "ready") text = "Level " + (engine.level + 1);
  else if (engine.state === "clear") text = "Level Cleared!";
  if (!text) return;
  ctx.fillStyle = "rgba(5,8,20,0.45)";
  ctx.fillRect(0, WORLD_H / 2 - 40, WORLD_W, 80);
  ctx.fillStyle = "#fff";
  ctx.font = "bold 40px 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, WORLD_W / 2, WORLD_H / 2);
  ctx.textAlign = "left";
}

// ---- Canvas helpers -------------------------------------------------------
function dot(x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
function roundRect(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
  ctx.fill();
}

// ---- Canvas sizing --------------------------------------------------------
function resize() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  scaleX = canvas.width / WORLD_W;
  scaleY = canvas.height / WORLD_H;
  draw();
}

// ---- Overlay / menu helpers -----------------------------------------------
function showMenu(title, msg) {
  els.overlayTitle.textContent = title;
  els.overlayMsg.innerHTML = msg;
  els.overlay.classList.remove("overlay--hidden");
}
function hideOverlay() { els.overlay.classList.add("overlay--hidden"); }
function setStatus(text) { els.status.textContent = text; }

// ---- Mute -----------------------------------------------------------------
function renderMute() { els.mute.textContent = sound.muted ? "🔇" : "🔊"; els.mute.setAttribute("aria-pressed", String(sound.muted)); }
function toggleMute() { sound.toggleMute(); renderMute(); }

// ---- Boot -----------------------------------------------------------------
function boot() {
  input.start();
  // Phone controller: hold ◀ / ▶ to move, Fire to shoot.
  Controls.define({
    profile: "buttons",
    buttons: [
      { id: "left", label: "◀", hold: true },
      { id: "enter", label: "Fire" },
      { id: "right", label: "▶", hold: true },
    ],
  });
  els.best.textContent = best;
  els.mute.addEventListener("click", toggleMute);
  window.addEventListener("keydown", (e) => { if (e.key === "m" || e.key === "M") toggleMute(); });
  window.addEventListener("resize", resize);

  resize();
  showMenu("Bubble Trouble", "Pop every bubble to clear the level!");
  lastTime = performance.now();
  requestAnimationFrame(loop);
}

boot();
