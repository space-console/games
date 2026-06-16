// Space Tower for Space Console — entry point.
// Wires input to the pure engine, runs a fixed-dt accumulator loop, and renders
// the faux-3D tower, the sliding section, the sliced-off falling pieces, the sky
// (which deepens toward space as you climb), and the HUD. The engine owns all
// rules; this file is input + render only (the camera lives here).
//
// Controls: 1-player drops with Space / ↑ / Enter / tap. Two-player co-op takes
// turns — A drops for P1, L for P2; on touch the DROP button drops for whoever's
// turn it is.

import {
  Engine,
  WORLD_W, WORLD_H, BLOCK_H, BASE_Y,
} from "./engine.js";
import { Input } from "../assets/js/shared/input.js";
import { Sound } from "../assets/js/shared/sound.js";

const engine = new Engine(Math.random);
const input = new Input();
const sound = new Sound();

const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");

const els = {
  status: document.getElementById("status"),
  height: document.getElementById("height"),
  score: document.getElementById("score"),
  best: document.getElementById("best"),
  overlay: document.getElementById("overlay"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlayMsg: document.getElementById("overlayMsg"),
  mute: document.getElementById("mute"),
  btn1p: document.getElementById("btn1p"),
  btn2p: document.getElementById("btn2p"),
  btnDrop: document.getElementById("btnDrop"),
};

const BEST_KEY = "spacetower.best";
let best = Number(localStorage.getItem(BEST_KEY) || 0);

const DEPTH = 11;                 // faux-3D block depth (up-right offset)
const PLAYER_TINT = ["#5aa0ff", "#ff7a9c"]; // P1 / P2 turn accents

let camY = 0;                     // world Y shown at the top of the screen
let pieces = [];                  // falling sliced-off chunks (cosmetic)
let popups = [];                  // floating "Perfect!" / combo text
let flash = 0;                    // brief white flash on a perfect

const STEP = 1 / 120;
const MAX_FRAME = 0.05;
let lastTime = 0, acc = 0, animClock = 0;

// ---- Game-state transitions ----------------------------------------------
function startGame(numPlayers) {
  sound.resume();
  sound.start();
  pieces = []; popups = []; flash = 0;
  engine.start(numPlayers);
  camY = targetCamY();           // snap camera so the first section is framed
  hideOverlay();
  setStatus(numPlayers === 2 ? "Co-op — take turns" : "");
  lastTime = performance.now();
  acc = 0;
}

function idleOrOver() { return engine.state === "idle" || engine.state === "over"; }

engine.addEventListener("drop", (e) => {
  const d = e.detail;
  for (const c of d.cuts) pieces.push({ ...c, y: c.yTop, vy: 30, rot: 0, rotV: (c.vx > 0 ? 1 : -1) * 2, age: 0 });
  if (d.perfect) {
    sound.clear(Math.min(4, 1 + d.combo));
    flash = 0.18;
    const m = engine.top;
    popups.push({ text: d.combo > 1 ? `Perfect! x${d.combo}` : "Perfect!", x: m.cx, y: m.yTop - 12, age: 0, ttl: 0.9 });
  } else {
    sound.lock();
  }
});
engine.addEventListener("miss", (e) => {
  const c = e.detail;
  pieces.push({ ...c, y: c.yTop, vy: 20, rot: 0, rotV: 3, age: 0 });
});
engine.addEventListener("gameover", () => {
  sound.gameOver();
  if (engine.score > best) { best = engine.score; localStorage.setItem(BEST_KEY, String(best)); }
  showMenu("Tower Toppled!", `Height ${engine.height} · Score ${engine.score} · Best ${best}`);
  setStatus("Game over");
});

// ---- Input ----------------------------------------------------------------
function dropFor(id) {
  if (idleOrOver()) return;
  sound.resume();
  engine.drop(id);
}

input.on((intent) => {
  if (intent === "back") { location.href = "../"; return; }
  if (intent === "enter") {
    if (idleOrOver()) startGame(1);
    else dropFor(engine.numPlayers === 2 ? engine.turn : 0);
  }
});

window.addEventListener("keydown", (e) => {
  if (idleOrOver()) {
    if (e.key === "1") return startGame(1);
    if (e.key === "2") return startGame(2);
    if (e.key === "Enter" || e.key === " ") return startGame(1);
  }
  switch (e.key) {
    case " ": case "ArrowUp": case "Enter":
      e.preventDefault();
      dropFor(engine.numPlayers === 2 ? engine.turn : 0);
      break;
    case "a": case "A": dropFor(0); break;   // P1 (co-op)
    case "l": case "L": dropFor(1); break;   // P2 (co-op)
  }
});

canvas.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  if (idleOrOver()) startGame(1);
  else dropFor(engine.numPlayers === 2 ? engine.turn : 0);
});
els.btn1p.addEventListener("pointerdown", (e) => { e.preventDefault(); startGame(1); });
els.btn2p.addEventListener("pointerdown", (e) => { e.preventDefault(); startGame(2); });
els.btnDrop.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  if (idleOrOver()) startGame(1);
  else dropFor(engine.numPlayers === 2 ? engine.turn : 0);
});

// ---- Loop -----------------------------------------------------------------
function targetCamY() {
  // Keep the active (top + sliding) section ~42% down the screen.
  const topY = engine.moving ? engine.moving.yTop : engine.top.yTop;
  return topY - WORLD_H * 0.42;
}

function loop(now) {
  let frame = (now - lastTime) / 1000;
  lastTime = now;
  if (frame > MAX_FRAME) frame = MAX_FRAME;
  animClock += frame;

  acc += frame;
  while (acc >= STEP) { engine.step(STEP); acc -= STEP; }

  // Ease the camera toward its target (only really moves while playing).
  if (engine.state === "playing") {
    const t = targetCamY();
    camY += (t - camY) * Math.min(1, frame * 6);
  }

  // Advance falling pieces + popups + flash.
  for (const p of pieces) { p.age += frame; p.vy += 900 * frame; p.y += p.vy * frame; p.cx += (p.vx || 0) * frame; p.rot += p.rotV * frame; }
  pieces = pieces.filter((p) => p.y - camY < WORLD_H + 200 && p.age < 4);
  for (const pu of popups) { pu.age += frame; pu.y -= 28 * frame; }
  popups = popups.filter((pu) => pu.age < pu.ttl);
  if (flash > 0) flash = Math.max(0, flash - frame);

  draw();
  requestAnimationFrame(loop);
}

// ---- Rendering ------------------------------------------------------------
let scaleX = 1, scaleY = 1;

function draw() {
  els.height.textContent = engine.height;
  els.score.textContent = engine.score;
  els.best.textContent = Math.max(best, engine.score);

  ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
  drawSky();

  ctx.setTransform(scaleX, 0, 0, scaleY, 0, -camY * scaleY);
  for (const b of engine.blocks) drawBlock(b);
  for (const p of pieces) drawBlock({ cx: p.cx, w: p.w, yTop: p.y, hue: p.hue }, p.rot);
  if (engine.moving) drawBlock(engine.moving, 0, true);
  drawPopups();

  ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
  if (flash > 0) { ctx.fillStyle = `rgba(255,255,255,${flash})`; ctx.fillRect(0, 0, WORLD_W, WORLD_H); }
  drawHud();
}

// Sky that deepens from clear blue toward dusk and space as the tower climbs.
function drawSky() {
  const t = Math.min(1, engine.height / 70);
  const topC = mix([24, 38, 90], [6, 8, 24], t);
  const midC = mix([58, 120, 200], [20, 28, 70], t);
  const botC = mix([150, 205, 240], [42, 60, 120], t);
  const g = ctx.createLinearGradient(0, 0, 0, WORLD_H);
  g.addColorStop(0, rgb(topC));
  g.addColorStop(0.55, rgb(midC));
  g.addColorStop(1, rgb(botC));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);

  // Stars fade in as the sky darkens.
  if (t > 0.25) {
    ctx.fillStyle = `rgba(255,255,255,${(t - 0.25) * 0.9})`;
    for (let i = 0; i < 40; i++) {
      const sx = (i * 97 % WORLD_W);
      const sy = ((i * 131 + Math.floor(camY * 0.2)) % WORLD_H + WORLD_H) % WORLD_H;
      const tw = 0.6 + Math.abs(Math.sin(animClock * 2 + i)) * 1.2;
      ctx.fillRect(sx, sy, tw, tw);
    }
  }

  // Parallax clouds drifting low.
  ctx.fillStyle = `rgba(255,255,255,${0.7 * (1 - t)})`;
  for (let i = 0; i < 3; i++) {
    const cy = 120 + i * 180 + (camY * 0.25) % 540;
    const yy = ((cy % (WORLD_H + 120)) + WORLD_H + 120) % (WORLD_H + 120) - 60;
    const cx = ((i * 170 + animClock * 8 * (i + 1)) % (WORLD_W + 160)) - 80;
    cloud(cx, yy, 34);
  }
}

function cloud(x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.arc(x + r, y + 6, r * 0.8, 0, Math.PI * 2);
  ctx.arc(x - r, y + 8, r * 0.7, 0, Math.PI * 2);
  ctx.arc(x + r * 0.4, y + r * 0.5, r * 0.9, 0, Math.PI * 2);
  ctx.fill();
}

// A faux-3D block: front face + a lighter top face + a darker right side, so the
// tower reads as solid. `moving` blocks get a turn-tinted outline in co-op.
function drawBlock(b, rot = 0, moving = false) {
  const left = b.cx - b.w / 2, right = b.cx + b.w / 2;
  const top = b.yTop, bot = b.yTop + BLOCK_H;
  const front = `hsl(${b.hue},58%,52%)`;
  const topF = `hsl(${b.hue},58%,66%)`;
  const side = `hsl(${b.hue},58%,38%)`;

  ctx.save();
  if (rot) { ctx.translate(b.cx, top + BLOCK_H / 2); ctx.rotate(rot); ctx.translate(-b.cx, -(top + BLOCK_H / 2)); }

  // Right side face.
  ctx.fillStyle = side;
  ctx.beginPath();
  ctx.moveTo(right, top); ctx.lineTo(right + DEPTH, top - DEPTH);
  ctx.lineTo(right + DEPTH, bot - DEPTH); ctx.lineTo(right, bot);
  ctx.closePath(); ctx.fill();

  // Top face.
  ctx.fillStyle = topF;
  ctx.beginPath();
  ctx.moveTo(left, top); ctx.lineTo(right, top);
  ctx.lineTo(right + DEPTH, top - DEPTH); ctx.lineTo(left + DEPTH, top - DEPTH);
  ctx.closePath(); ctx.fill();

  // Front face.
  ctx.fillStyle = front;
  ctx.fillRect(left, top, b.w, BLOCK_H);

  // Brick seams on the front for a built-tower look.
  ctx.strokeStyle = "rgba(0,0,0,0.12)";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(left, top + BLOCK_H / 2); ctx.lineTo(right, top + BLOCK_H / 2); ctx.stroke();
  for (let bx = left + 22; bx < right; bx += 38) {
    const off = 0; // simple grid seams
    ctx.beginPath(); ctx.moveTo(bx, top); ctx.lineTo(bx, top + BLOCK_H / 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(bx + 19, top + BLOCK_H / 2); ctx.lineTo(bx + 19, bot); ctx.stroke();
    void off;
  }

  // Outline (turn-tinted for the live moving section in co-op).
  ctx.lineWidth = moving && engine.numPlayers === 2 ? 3 : 1.5;
  ctx.strokeStyle = moving && engine.numPlayers === 2
    ? PLAYER_TINT[engine.turn]
    : "rgba(0,0,0,0.25)";
  ctx.strokeRect(left, top, b.w, BLOCK_H);
  ctx.restore();
}

function drawPopups() {
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (const pu of popups) {
    const a = 1 - pu.age / pu.ttl;
    ctx.globalAlpha = a;
    ctx.font = "bold 22px 'Segoe UI', sans-serif";
    ctx.lineWidth = 4; ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.strokeText(pu.text, pu.x, pu.y);
    ctx.fillStyle = "#fff7b0";
    ctx.fillText(pu.text, pu.x, pu.y);
  }
  ctx.globalAlpha = 1; ctx.textAlign = "left";
}

function drawHud() {
  ctx.font = "bold 20px 'Segoe UI', sans-serif";
  ctx.textBaseline = "middle";
  const h = "Height " + engine.height;
  ctx.fillStyle = "rgba(0,0,0,0.4)";
  const hw = ctx.measureText(h).width;
  roundRect(WORLD_W / 2 - hw / 2 - 10, 10, hw + 20, 28, 8);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.fillText(h, WORLD_W / 2, 24);
  ctx.textAlign = "left";

  // Co-op turn indicator.
  if (engine.numPlayers === 2 && engine.state === "playing") {
    const label = "P" + (engine.turn + 1) + "'s turn";
    ctx.font = "bold 16px 'Segoe UI', sans-serif";
    const lw = ctx.measureText(label).width;
    const pulse = 0.55 + Math.abs(Math.sin(animClock * 5)) * 0.45;
    ctx.fillStyle = PLAYER_TINT[engine.turn];
    ctx.globalAlpha = pulse;
    roundRect(WORLD_W / 2 - lw / 2 - 10, 44, lw + 20, 24, 7);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.fillText(label, WORLD_W / 2, 56);
    ctx.textAlign = "left";
  }
}

// ---- Helpers --------------------------------------------------------------
function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
function rgb(c) { return `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`; }
function roundRect(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath(); ctx.fill();
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  scaleX = canvas.width / WORLD_W;
  scaleY = canvas.height / WORLD_H;
  draw();
}

function showMenu(title, msg) {
  els.overlayTitle.textContent = title;
  els.overlayMsg.innerHTML = msg;
  els.overlay.classList.remove("overlay--hidden");
}
function hideOverlay() { els.overlay.classList.add("overlay--hidden"); }
function setStatus(text) { els.status.textContent = text; }

function renderMute() { els.mute.textContent = sound.muted ? "🔇" : "🔊"; els.mute.setAttribute("aria-pressed", String(sound.muted)); }
function toggleMute() { sound.toggleMute(); renderMute(); }

function boot() {
  input.start();
  els.best.textContent = best;
  els.mute.addEventListener("click", toggleMute);
  window.addEventListener("keydown", (e) => { if (e.key === "m" || e.key === "M") toggleMute(); });
  window.addEventListener("resize", resize);

  camY = BASE_Y - WORLD_H * 0.42;
  resize();
  showMenu("Space Tower", "Drop each section to build the tower — stack it dead-centre!");
  lastTime = performance.now();
  requestAnimationFrame(loop);
}

boot();
