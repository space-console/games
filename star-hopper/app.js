// Star Hopper for Space Console — entry point.
// Wires input to the pure engine, runs a fixed-dt loop, and renders the
// side-scrolling world (parallax sky, tiles, coins, enemies, the hero, the goal
// flag) with a horizontally-following camera. The engine owns all rules +
// physics; this file is input + render only.
//
// Controls: ← / → run, Space / ↑ / Z jump (hold for a higher jump).

import { Engine, TILE, PW, PH } from "./engine.js?v=5f45cf0e-18e1-45f6-8078-fe425c1f5555";
import { Input } from "../assets/js/shared/input.js?v=5f45cf0e-18e1-45f6-8078-fe425c1f5555";
import { Sound } from "../assets/js/shared/sound.js?v=5f45cf0e-18e1-45f6-8078-fe425c1f5555";

const VIEW_W = 512, VIEW_H = 448;

const engine = new Engine();
const input = new Input();
const sound = new Sound();

const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");

const els = {
  status: document.getElementById("status"),
  coins: document.getElementById("coins"),
  lives: document.getElementById("lives"),
  best: document.getElementById("best"),
  overlay: document.getElementById("overlay"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlayMsg: document.getElementById("overlayMsg"),
  mute: document.getElementById("mute"),
  bLeft: document.getElementById("bLeft"),
  bRight: document.getElementById("bRight"),
  bJump: document.getElementById("bJump"),
};

const BEST_KEY = "starhopper.best";
let best = Number(localStorage.getItem(BEST_KEY) || 0);

const held = { left: false, right: false, jump: false };
let parts = [];          // coin sparkles / stomp puffs / +1 popups
let camX = 0;
let flash = 0;
let prevGround = true;   // for detecting a landing (→ squash + dust)
let landSquash = 0;

const STEP = 1 / 120, MAX_FRAME = 0.05;
let lastTime = 0, acc = 0, animClock = 0;

// ---- Flow -----------------------------------------------------------------
function startGame() {
  sound.resume(); sound.start();
  held.left = held.right = held.jump = false;
  parts = []; flash = 0;
  engine.start();
  camX = 0;
  hideOverlay(); setStatus("Reach the flag!");
  lastTime = performance.now(); acc = 0;
}
function idleOrOver() { return engine.state === "idle" || engine.state === "over" || engine.state === "won"; }

engine.addEventListener("jump", () => sound.move());
engine.addEventListener("coin", (e) => { sound.rotate(); popCoin(e.detail.x, e.detail.y); });
engine.addEventListener("stomp", (e) => { sound.lock(); puff(e.detail.x, e.detail.y); });
engine.addEventListener("die", () => { sound.drop(); flash = 0.35; });
engine.addEventListener("gameover", () => {
  sound.gameOver();
  if (engine.coins > best) { best = engine.coins; localStorage.setItem(BEST_KEY, String(best)); }
  showOverlay("Game Over", `Coins ${engine.coins} · Best ${best}<br>Press <kbd>Enter</kbd> to try again`);
  setStatus("Game over");
});
engine.addEventListener("win", () => {
  sound.levelUp();
  if (engine.coins > best) { best = engine.coins; localStorage.setItem(BEST_KEY, String(best)); }
  showOverlay("You reached the flag!", `Coins ${engine.coins} · Lives left ${engine.lives}<br>Press <kbd>Enter</kbd> to play again`);
  setStatus("Level clear!");
});

function popCoin(x, y) {
  parts.push({ kind: "text", text: "+1", x, y, vy: -40, age: 0, ttl: 0.7 });
  for (let i = 0; i < 5; i++) parts.push({ kind: "spark", x, y, vx: (Math.random() - 0.5) * 120, vy: -60 - Math.random() * 60, age: 0, ttl: 0.5, c: "#ffd23f" });
}
function puff(x, y) {
  for (let i = 0; i < 7; i++) parts.push({ kind: "spark", x, y, vx: (Math.random() - 0.5) * 160, vy: -Math.random() * 80, age: 0, ttl: 0.4, c: "#cfe" });
}

// ---- Input ----------------------------------------------------------------
input.on((intent) => {
  if (intent === "back") { location.href = "../"; return; }
  if (intent === "enter" && idleOrOver()) startGame();
});
window.addEventListener("keydown", (e) => {
  if (idleOrOver() && (e.key === "Enter" || e.key === " ")) { startGame(); return; }
  switch (e.key) {
    case "ArrowLeft": case "a": case "A": held.left = true; e.preventDefault(); break;
    case "ArrowRight": case "d": case "D": held.right = true; e.preventDefault(); break;
    case "ArrowUp": case " ": case "w": case "W": case "z": case "Z":
      held.jump = true; e.preventDefault(); break;
  }
});
window.addEventListener("keyup", (e) => {
  switch (e.key) {
    case "ArrowLeft": case "a": case "A": held.left = false; break;
    case "ArrowRight": case "d": case "D": held.right = false; break;
    case "ArrowUp": case " ": case "w": case "W": case "z": case "Z": held.jump = false; break;
  }
});
canvas.addEventListener("pointerdown", (e) => { e.preventDefault(); if (idleOrOver()) startGame(); else held.jump = true; });
canvas.addEventListener("pointerup", () => { held.jump = false; });

function hold(el, key) {
  el.addEventListener("pointerdown", (e) => { e.preventDefault(); held[key] = true; });
  el.addEventListener("pointerup", (e) => { e.preventDefault(); held[key] = false; });
  el.addEventListener("pointerleave", () => (held[key] = false));
  el.addEventListener("pointercancel", () => (held[key] = false));
}
hold(els.bLeft, "left"); hold(els.bRight, "right"); hold(els.bJump, "jump");

// ---- Loop -----------------------------------------------------------------
function loop(now) {
  let frame = (now - lastTime) / 1000; lastTime = now;
  if (frame > MAX_FRAME) frame = MAX_FRAME;
  animClock += frame;

  engine.setMove((held.right ? 1 : 0) - (held.left ? 1 : 0));
  engine.setJump(held.jump);
  acc += frame;
  while (acc >= STEP) { engine.step(STEP); acc -= STEP; }

  // Landing detection → squash + a dust puff.
  if (engine.state === "play") {
    if (engine.hero.onGround && !prevGround) { landSquash = 0.13; puff(engine.hero.x + PW / 2, engine.hero.y + PH); }
    prevGround = engine.hero.onGround;
  }
  if (landSquash > 0) landSquash = Math.max(0, landSquash - frame);

  // Camera follows the hero, clamped to the level.
  const target = engine.hero.x + PW / 2 - VIEW_W / 2;
  camX = clamp(target, 0, Math.max(0, engine.levelW - VIEW_W));

  if (flash > 0) flash = Math.max(0, flash - frame);
  for (const p of parts) { p.age += frame; p.x += (p.vx || 0) * frame; p.y += (p.vy || 0) * frame; if (p.kind === "spark") p.vy += 300 * frame; }
  parts = parts.filter((p) => p.age < p.ttl);

  draw();
  requestAnimationFrame(loop);
}

// ---- Rendering ------------------------------------------------------------
let scaleX = 1, scaleY = 1;

function draw() {
  els.coins.textContent = engine.coins;
  els.lives.textContent = Math.max(0, engine.lives);
  els.best.textContent = Math.max(best, engine.coins);

  ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
  drawSky();

  ctx.setTransform(scaleX, 0, 0, scaleY, -camX * scaleX, 0);
  drawTiles();
  drawCoins();
  drawGoal();
  drawEnemies();
  drawHero();
  drawParts();

  ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
  if (flash > 0) { ctx.fillStyle = `rgba(255,60,60,${flash})`; ctx.fillRect(0, 0, VIEW_W, VIEW_H); }
}

function drawSky() {
  const g = ctx.createLinearGradient(0, 0, 0, VIEW_H);
  g.addColorStop(0, "#5cc6ff"); g.addColorStop(0.7, "#9bdcff"); g.addColorStop(1, "#d6f0ff");
  ctx.fillStyle = g; ctx.fillRect(0, 0, VIEW_W, VIEW_H);

  // Parallax hills.
  hills(VIEW_H - 120, "#bfe79a", 0.25, 150, 80);
  hills(VIEW_H - 80, "#9bd56f", 0.45, 120, 60);
  // Clouds.
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  for (let i = 0; i < 4; i++) {
    const cx = ((i * 180 - camX * 0.2 + animClock * 6) % (VIEW_W + 160) + VIEW_W + 160) % (VIEW_W + 160) - 80;
    cloud(cx, 60 + (i % 2) * 50, 26);
  }
}
function hills(baseY, color, par, span, amp) {
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.moveTo(0, VIEW_H);
  const off = (camX * par) % span;
  for (let x = -off; x <= VIEW_W + span; x += 8) {
    const y = baseY - Math.abs(Math.sin((x + off) / span * Math.PI)) * amp;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(VIEW_W, VIEW_H); ctx.closePath(); ctx.fill();
}
function cloud(x, y, r) {
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.arc(x + r, y + 4, r * 0.8, 0, Math.PI * 2);
  ctx.arc(x - r, y + 6, r * 0.7, 0, Math.PI * 2); ctx.arc(x + r * 0.4, y + r * 0.5, r * 0.9, 0, Math.PI * 2); ctx.fill();
}

function drawTiles() {
  const c0 = Math.max(0, Math.floor(camX / TILE));
  const c1 = Math.min(engine.cols - 1, Math.floor((camX + VIEW_W) / TILE) + 1);
  for (let ty = 0; ty < engine.rows; ty++) {
    for (let tx = c0; tx <= c1; tx++) {
      const ch = engine.grid[ty][tx];
      if (ch === " ") continue;
      const x = tx * TILE, y = ty * TILE;
      if (ch === "X") drawGround(x, y, !engine.solid(tx, ty - 1));
      else if (ch === "=") drawPlatform(x, y);
      else if (ch === "Q") drawCrate(x, y, false);
      else if (ch === "U") drawCrate(x, y, true);
    }
  }
}
function drawGround(x, y, top) {
  ctx.fillStyle = "#7a4e2b"; ctx.fillRect(x, y, TILE, TILE);
  ctx.fillStyle = "rgba(0,0,0,0.12)";
  ctx.fillRect(x, y, 2, TILE); ctx.fillRect(x + TILE - 2, y, 2, TILE);
  if (top) {
    ctx.fillStyle = "#4caf50"; ctx.fillRect(x, y, TILE, 9);
    ctx.fillStyle = "#3d9140"; ctx.fillRect(x, y + 9, TILE, 3);
    ctx.fillStyle = "#69c46d";
    for (let i = 0; i < 4; i++) ctx.fillRect(x + 3 + i * 8, y + 2, 3, 4);
  }
  ctx.fillStyle = "rgba(255,255,255,0.05)"; ctx.fillRect(x + 5, y + 16, 4, 4); ctx.fillRect(x + 20, y + 22, 4, 4);
}
function drawPlatform(x, y) {
  ctx.fillStyle = "#9a6a3a"; roundRect(x, y, TILE, TILE - 8, 4);
  ctx.fillStyle = "#5fd06a"; roundRect(x, y, TILE, 7, 4);
  ctx.fillStyle = "rgba(0,0,0,0.15)"; ctx.fillRect(x, y + TILE - 10, TILE, 2);
}
function drawCrate(x, y, used) {
  const g = ctx.createLinearGradient(x, y, x, y + TILE);
  g.addColorStop(0, used ? "#7d6a44" : "#e3a93b"); g.addColorStop(1, used ? "#5e4f33" : "#bd812a");
  ctx.fillStyle = g; roundRect(x + 1, y + 1, TILE - 2, TILE - 2, 5);
  ctx.strokeStyle = "rgba(0,0,0,0.35)"; ctx.lineWidth = 2; roundRectStroke(x + 1, y + 1, TILE - 2, TILE - 2, 5);
  // Star (bright if active, dim if used).
  ctx.fillStyle = used ? "rgba(255,255,255,0.25)" : "#fff7c0";
  star(x + TILE / 2, y + TILE / 2 + (used ? 0 : Math.sin(animClock * 4) * 1.5), 7, 3.2);
}

function drawCoins() {
  for (const c of engine.coinList) {
    if (c.got) continue;
    const sw = Math.abs(Math.cos(animClock * 4 + c.x * 0.05)); // spin
    ctx.save(); ctx.translate(c.x, c.y); ctx.scale(0.35 + sw * 0.65, 1);
    ctx.fillStyle = "#ffd23f"; ctx.beginPath(); ctx.arc(0, 0, 9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#ffe98a"; ctx.beginPath(); ctx.arc(0, 0, 5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#c8951f"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, 9, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
}

function drawGoal() {
  const x = engine.goalX;
  const top = 3 * TILE, bottomRow = 12 * TILE;
  ctx.fillStyle = "#cfd6e6"; ctx.fillRect(x - 2, top, 4, bottomRow - top);
  ctx.fillStyle = "#ffd23f"; ctx.beginPath(); ctx.arc(x, top, 6, 0, Math.PI * 2); ctx.fill();
  // Waving flag.
  const wave = Math.sin(animClock * 4) * 4;
  ctx.fillStyle = "#ff5a5a";
  ctx.beginPath(); ctx.moveTo(x + 2, top + 6);
  ctx.lineTo(x + 40 + wave, top + 16); ctx.lineTo(x + 2, top + 28); ctx.closePath(); ctx.fill();
  ctx.fillStyle = "#fff"; star(x + 20, top + 17, 4, 1.8);
}

function drawEnemies() {
  for (const e of engine.enemyList) {
    if (!e.alive && e.squash <= 0) continue;
    const cx = e.x + 13, by = e.y + 24;
    const squash = e.squash > 0 ? 0.35 : 1 + Math.sin(animClock * 6 + e.x) * 0.07;
    ctx.save(); ctx.translate(cx, by); ctx.scale(1 + (1 - squash) * 0.5, squash);
    // Slime body.
    const g = ctx.createLinearGradient(0, -24, 0, 0);
    g.addColorStop(0, "#7be06a"); g.addColorStop(1, "#3fa83a");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-14, 0); ctx.quadraticCurveTo(-16, -20, 0, -22); ctx.quadraticCurveTo(16, -20, 14, 0); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.4)"; ctx.beginPath(); ctx.ellipse(-5, -14, 4, 6, 0, 0, Math.PI * 2); ctx.fill();
    if (e.squash <= 0) {
      // Eyes.
      const dir = Math.sign(e.vx) || 1;
      ctx.fillStyle = "#fff"; dot(dir * 3 - 4, -12, 3.2); dot(dir * 3 + 4, -12, 3.2);
      ctx.fillStyle = "#15301a"; dot(dir * 4 - 4, -12, 1.5); dot(dir * 4 + 4, -12, 1.5);
    }
    ctx.restore();
  }
}

// An original platformer-mascot hero: a little humanoid with a cap, dungarees,
// gloves and boots. Animated — a run cycle (swinging legs/arms + lean), a tuck
// while airborne, and squash/stretch on jump and landing. All original art.
const HERO = {
  skin: "#f6c49b", cap: "#16b1a1", capDark: "#0f8678",
  shirt: "#ffd23f", overall: "#3f72d6", overallDark: "#2c54a6",
  boot: "#5d3a1f", glove: "#fbfdff",
};
function drawHero() {
  const h = engine.hero;
  if (engine.invuln > 0 && Math.floor(animClock * 20) % 2 === 0) return; // blink while hurt
  const cx = h.x + PW / 2, by = h.y + PH, f = h.dir;
  const onG = h.onGround;
  const run = onG && Math.abs(h.vx) > 20;
  const t = run ? animClock * 16 : 0;
  const sw = Math.sin(t);                    // stride / swing phase

  // Shadow (flat on the ground, drawn unscaled).
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.beginPath(); ctx.ellipse(cx, by + 1, 12, 3.5, 0, 0, Math.PI * 2); ctx.fill();

  // Squash & stretch.
  let sx = 1, sy = 1;
  if (landSquash > 0) { const k = landSquash / 0.13; sx = 1 + 0.22 * k; sy = 1 - 0.22 * k; }
  else if (!onG) { if (h.vy < 0) { sx = 0.9; sy = 1.14; } else { sx = 1.05; sy = 0.97; } }

  ctx.save();
  ctx.translate(cx, by);
  ctx.rotate(f * (run ? 0.06 : 0));          // lean into the run (forward both ways)
  ctx.scale(f, 1);                            // flip to face direction
  ctx.scale(sx, sy);
  // From here +x is "forward".

  const C = HERO;
  const legSwing = run ? sw * 4 : 0;
  const tuck = onG ? 0 : 3;                   // pull feet up a little when airborne

  // Legs + boots.
  ctx.fillStyle = C.overallDark;
  roundRect(-6 - legSwing * 0.6, -14 + tuck, 6, 9, 2);
  roundRect(0 + legSwing * 0.6, -14 + tuck, 6, 9, 2);
  ctx.fillStyle = C.boot;
  roundRect(-8 - legSwing, -6 + tuck, 9, 6, 2);
  roundRect(-1 + legSwing, -6 + tuck, 10, 6, 2);

  // Torso: shirt then dungarees with a bib + straps.
  ctx.fillStyle = C.shirt;
  roundRect(-9, -27, 18, 16, 6);
  ctx.fillStyle = C.overall;
  roundRect(-9, -20, 18, 10, 4);
  roundRect(-6, -27, 12, 8, 3);
  ctx.fillRect(-7, -28, 3, 9); ctx.fillRect(4, -28, 3, 9);
  ctx.fillStyle = "#ffe27a"; dot(-4, -18, 1.6); dot(4, -18, 1.6);

  // Arms (swing while running, raise while airborne).
  const arm = run ? -sw * 5 : (!onG ? -7 : 1);
  ctx.strokeStyle = C.shirt; ctx.lineWidth = 5; ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(-6, -25); ctx.lineTo(-9, -18 + arm * 0.5); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(6, -25); ctx.lineTo(10, -18 - arm); ctx.stroke();
  ctx.fillStyle = C.glove; dot(-9, -18 + arm * 0.5, 3); dot(10, -18 - arm, 3);

  // Head + face.
  ctx.fillStyle = C.skin; dot(2, -32, 9);
  ctx.fillStyle = "#e8a877"; dot(9, -31, 2.3);        // little nose
  ctx.fillStyle = "#fff"; dot(4, -34, 3);
  ctx.fillStyle = "#27313f"; dot(5.6, -34, 1.6);
  ctx.fillStyle = "rgba(255,140,120,0.45)"; dot(-1, -29, 2);  // cheek

  // Cap: dome, band, forward bill, star emblem.
  ctx.fillStyle = C.cap;
  ctx.beginPath(); ctx.arc(2, -34, 9.5, Math.PI, 0); ctx.closePath(); ctx.fill();
  ctx.fillRect(-7.5, -34, 19, 3);
  ctx.fillStyle = C.capDark;
  roundRect(6, -35, 11, 4, 2);
  ctx.fillStyle = "#ffd23f"; star(0, -37, 3, 1.4);

  ctx.restore();
}

function drawParts() {
  for (const p of parts) {
    const a = 1 - p.age / p.ttl;
    if (p.kind === "text") {
      ctx.globalAlpha = a; ctx.font = "bold 14px 'Segoe UI',sans-serif"; ctx.textAlign = "center";
      ctx.fillStyle = "#fff7b0"; ctx.fillText(p.text, p.x, p.y); ctx.globalAlpha = 1; ctx.textAlign = "left";
    } else {
      ctx.globalAlpha = a; ctx.fillStyle = p.c; dot(p.x, p.y, 3); ctx.globalAlpha = 1;
    }
  }
}

// ---- Canvas helpers -------------------------------------------------------
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function dot(x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
function star(cx, cy, R, r) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const ang = -Math.PI / 2 + i * Math.PI / 5; const rad = i % 2 ? r : R;
    ctx.lineTo(cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad);
  }
  ctx.closePath(); ctx.fill();
}
function roundRect(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2); ctx.beginPath(); ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr); ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr); ctx.arcTo(x, y, x + w, y, rr); ctx.closePath(); ctx.fill();
}
function roundRectStroke(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2); ctx.beginPath(); ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr); ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr); ctx.arcTo(x, y, x + w, y, rr); ctx.closePath(); ctx.stroke();
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  scaleX = canvas.width / VIEW_W; scaleY = canvas.height / VIEW_H;
  draw();
}

function showOverlay(t, m) { els.overlayTitle.textContent = t; els.overlayMsg.innerHTML = m; els.overlay.classList.remove("overlay--hidden"); }
function hideOverlay() { els.overlay.classList.add("overlay--hidden"); }
function setStatus(t) { els.status.textContent = t; }
function renderMute() { els.mute.textContent = sound.muted ? "🔇" : "🔊"; els.mute.setAttribute("aria-pressed", String(sound.muted)); }
function toggleMute() { sound.toggleMute(); renderMute(); }

function boot() {
  input.start();
  els.best.textContent = best;
  els.mute.addEventListener("click", toggleMute);
  window.addEventListener("keydown", (e) => { if (e.key === "m" || e.key === "M") toggleMute(); });
  window.addEventListener("resize", resize);
  resize();
  showOverlay("Star Hopper", "Run and jump to the flag — stomp the slimes, grab the coins!<br>Press <kbd>Enter</kbd> to start");
  lastTime = performance.now();
  requestAnimationFrame(loop);
}

boot();
