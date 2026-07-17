// Space Tower for Space Console — entry point.
// Wires input to the pure engine, runs a fixed-dt accumulator loop, and renders
// the crane + rope, the swinging/falling house section, the building of houses
// (with windows), and the leaning tower. The engine owns all rules; this file is
// input + render only (the camera lives here).
//
// Controls: 1-player drops with Space / ↑ / Enter / tap. Two-player co-op takes
// turns — A drops for P1, L for P2; on touch the DROP button drops for whoever's
// turn it is.

import {
  Engine,
  WORLD_W, WORLD_H, BLOCK_H, BASE_Y,
  DROP_H, PIVOT_UP,
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

const DEPTH = 9;                          // faux-3D depth of a house
const MAX_LEAN = 0.13;                    // radians the building leans at full drift
const PLAYER_TINT = ["#5aa0ff", "#ff7a9c"];

let camY = 0;
let popups = [];
let debris = [];                  // collapsing house floors after a loss
let toppleDir = 1;               // which way the building was leaning when it fell
let edgePiece = null;            // the section that slid off (gross-miss topple)
let overlayTimer = null;

const DEBRIS_G = 1500;

const STEP = 1 / 120;
const MAX_FRAME = 0.05;
let lastTime = 0, acc = 0, animClock = 0;

// ---- Game-state transitions ----------------------------------------------
function targetCamY() { return engine.pivotY - 24; }

function startGame(numPlayers) {
  sound.resume();
  sound.start();
  popups = [];
  debris = [];
  edgePiece = null;
  if (overlayTimer) { clearTimeout(overlayTimer); overlayTimer = null; }
  engine.start(numPlayers);
  camY = targetCamY();
  hideOverlay();
  setStatus(numPlayers === 2 ? "Co-op — take turns" : "");
  lastTime = performance.now();
  acc = 0;
}

function idleOrOver() { return engine.state === "idle" || engine.state === "over"; }

engine.addEventListener("release", () => sound.drop());
engine.addEventListener("place", (e) => {
  const d = e.detail;
  if (d.perfect) {
    sound.clear(Math.min(4, 1 + d.combo));
    const t = engine.top;
    popups.push({ text: d.combo > 1 ? `Perfect! x${d.combo}` : "Perfect!", x: t.cx, y: t.yTop - 10, age: 0, ttl: 0.9 });
  } else {
    sound.lock();
  }
});
engine.addEventListener("topple", (e) => {
  toppleDir = e.detail.dir || 1;
  edgePiece = e.detail.piece || null;
});
engine.addEventListener("gameover", () => {
  sound.gameOver();
  if (engine.score > best) { best = engine.score; localStorage.setItem(BEST_KEY, String(best)); }
  spawnDebris();
  // Let the building crumble before the overlay drops in.
  overlayTimer = setTimeout(() => {
    showMenu("Tower Toppled!", `Height ${engine.height} · Score ${engine.score} · Best ${best}`);
  }, 1200);
  setStatus("Toppled!");
});

// Turn the stacked floors (and any slid-off piece) into debris that falls and
// scatters — the foundation stays put. No rigid spin, just a crumble.
function spawnDebris() {
  debris = [];
  const blocks = engine.blocks;
  const n = blocks.length;
  for (let i = 1; i < n; i++) {            // keep the base (i = 0) standing
    const b = blocks[i];
    const f = i / n;                       // higher floors fly further
    debris.push({
      cx: b.cx, yTop: b.yTop, w: b.w, hue: b.hue,
      vx: toppleDir * (30 + f * 130) + ((i * 53) % 40 - 20),
      vy: -(30 + f * 70),
      rot: 0,
      rotV: toppleDir * (0.8 + f * 1.6) * ((i % 2) ? 1 : -1),
    });
  }
  if (edgePiece) {
    debris.push({
      cx: edgePiece.cx, yTop: edgePiece.yTop, w: edgePiece.w, hue: edgePiece.hue,
      vx: toppleDir * 160, vy: -40, rot: 0, rotV: toppleDir * 3,
    });
  }
}

// ---- Input ----------------------------------------------------------------
function dropFor(id) { if (!idleOrOver()) { sound.resume(); engine.drop(id); } }

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
      e.preventDefault(); dropFor(engine.numPlayers === 2 ? engine.turn : 0); break;
    case "a": case "A": dropFor(0); break;
    case "l": case "L": dropFor(1); break;
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
function loop(now) {
  let frame = (now - lastTime) / 1000;
  lastTime = now;
  if (frame > MAX_FRAME) frame = MAX_FRAME;
  animClock += frame;

  acc += frame;
  while (acc >= STEP) { engine.step(STEP); acc -= STEP; }

  if (engine.state === "playing") {
    camY += (targetCamY() - camY) * Math.min(1, frame * 6);
  }
  for (const pu of popups) { pu.age += frame; pu.y -= 26 * frame; }
  popups = popups.filter((pu) => pu.age < pu.ttl);
  for (const d of debris) { d.vy += DEBRIS_G * frame; d.cx += d.vx * frame; d.yTop += d.vy * frame; d.rot += d.rotV * frame; }

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

  if (debris.length) {
    // After a loss the building has crumbled: the foundation stays, the floors
    // tumble away as debris.
    drawHouse(engine.blocks[0], 0);
    for (const d of debris) drawDebris(d);
  } else {
    // The placed building leans about its base as the centre of mass drifts.
    const lean = engine.leanFrac * MAX_LEAN;
    const base = engine.blocks[0];
    const pivotX = base.cx, pivotYw = base.yTop + BLOCK_H;
    ctx.save();
    ctx.translate(pivotX, pivotYw);
    ctx.rotate(lean);
    ctx.translate(-pivotX, -pivotYw);
    for (let i = 0; i < engine.blocks.length; i++) drawHouse(engine.blocks[i], i);
    ctx.restore();
  }

  // Crane + the live (swinging or falling) section, which are not part of the
  // leaning building.
  if (engine.current) {
    if (engine.current.phase === "aim") drawCrane();
    drawHouse({ cx: engine.current.x, w: engine.current.w, yTop: engine.current.y, hue: engine.current.hue },
      engine.blocks.length);
  }

  drawPopups();

  ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
  drawHud();
}

// Sky that deepens from clear blue toward dusk/space as the tower climbs.
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

  if (t > 0.2) {
    ctx.fillStyle = `rgba(255,255,255,${(t - 0.2) * 0.9})`;
    for (let i = 0; i < 44; i++) {
      const sx = (i * 97 % WORLD_W);
      const sy = ((i * 131 + Math.floor(camY * 0.25)) % WORLD_H + WORLD_H) % WORLD_H;
      const tw = 0.6 + Math.abs(Math.sin(animClock * 2 + i)) * 1.2;
      ctx.fillRect(sx, sy, tw, tw);
    }
  }
  ctx.fillStyle = `rgba(255,255,255,${0.7 * (1 - t)})`;
  for (let i = 0; i < 3; i++) {
    const cy = 120 + i * 190 + (camY * 0.25) % 570;
    const yy = ((cy % (WORLD_H + 120)) + WORLD_H + 120) % (WORLD_H + 120) - 60;
    const cx = ((i * 170 + animClock * 8 * (i + 1)) % (WORLD_W + 160)) - 80;
    cloud(cx, yy, 32);
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

// The crane: a girder beam across the top, a trolley, and the cable holding the
// swinging section by a little hook.
function drawCrane() {
  const c = engine.current;
  const pivotY = engine.pivotY;
  const beamY = pivotY - 6;
  // Beam.
  ctx.fillStyle = "#3a4256";
  ctx.fillRect(40, beamY - 7, WORLD_W - 80, 9);
  ctx.fillStyle = "#5b6478";
  ctx.fillRect(40, beamY - 7, WORLD_W - 80, 3);
  // Lattice ticks.
  ctx.strokeStyle = "rgba(0,0,0,0.3)"; ctx.lineWidth = 1;
  for (let x = 50; x < WORLD_W - 50; x += 22) {
    ctx.beginPath(); ctx.moveTo(x, beamY - 7); ctx.lineTo(x + 11, beamY + 2); ctx.stroke();
  }
  // Trolley at the pivot.
  ctx.fillStyle = "#ffcf3f";
  roundRect(WORLD_W / 2 - 10, beamY - 3, 20, 8, 2);
  // Cable to the section.
  ctx.strokeStyle = "#2a2f3e"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(WORLD_W / 2, beamY + 4); ctx.lineTo(c.x, c.y - 6); ctx.stroke();
  // Hook.
  ctx.strokeStyle = "#9aa3b8"; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(c.x, c.y - 3, 4, 0.1 * Math.PI, 1.6 * Math.PI); ctx.stroke();
}

// A house section: faux-3D body, rows of windows, and a door on the ground floor.
function drawHouse(b, idx) {
  const left = b.cx - b.w / 2, right = b.cx + b.w / 2;
  const top = b.yTop, bot = b.yTop + BLOCK_H;
  const wall = `hsl(${b.hue},42%,64%)`;
  const wallTop = `hsl(${b.hue},42%,76%)`;
  const wallSide = `hsl(${b.hue},42%,46%)`;
  const isBase = idx === 0;

  // Right side + top faces (depth).
  ctx.fillStyle = wallSide;
  ctx.beginPath();
  ctx.moveTo(right, top); ctx.lineTo(right + DEPTH, top - DEPTH);
  ctx.lineTo(right + DEPTH, bot - DEPTH); ctx.lineTo(right, bot);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = wallTop;
  ctx.beginPath();
  ctx.moveTo(left, top); ctx.lineTo(right, top);
  ctx.lineTo(right + DEPTH, top - DEPTH); ctx.lineTo(left + DEPTH, top - DEPTH);
  ctx.closePath(); ctx.fill();

  // Front wall.
  ctx.fillStyle = wall;
  ctx.fillRect(left, top, b.w, BLOCK_H);
  ctx.strokeStyle = "rgba(0,0,0,0.22)"; ctx.lineWidth = 1.2;
  ctx.strokeRect(left, top, b.w, BLOCK_H);

  // Windows: a tidy grid, most lit warm, some dark (deterministic per floor).
  const cols = Math.max(2, Math.round(b.w / 42));
  const cellW = b.w / cols;
  const winW = Math.min(16, cellW * 0.5), winH = 16;
  const rows = isBase ? 1 : 2;
  for (let r = 0; r < rows; r++) {
    const wy = top + 8 + r * 19;
    for (let col = 0; col < cols; col++) {
      // ground floor: leave the centre for a door.
      if (isBase && Math.abs(col - (cols - 1) / 2) < 0.6) continue;
      const wx = left + cellW * col + (cellW - winW) / 2;
      const lit = (col + r * 2 + idx * 3) % 3 !== 0;
      ctx.fillStyle = lit ? "#ffe07a" : "#27405e";
      roundRect(wx, wy, winW, winH, 2);
      ctx.strokeStyle = "rgba(0,0,0,0.35)"; ctx.lineWidth = 1;
      ctx.strokeRect(wx, wy, winW, winH);
      ctx.beginPath(); ctx.moveTo(wx + winW / 2, wy); ctx.lineTo(wx + winW / 2, wy + winH);
      ctx.moveTo(wx, wy + winH / 2); ctx.lineTo(wx + winW, wy + winH / 2); ctx.stroke();
    }
  }

  // Door on the ground floor.
  if (isBase) {
    ctx.fillStyle = "#6b4423";
    roundRect(b.cx - 9, bot - 22, 18, 22, 2);
    ctx.fillStyle = "#ffd23f"; dot(b.cx + 4, bot - 11, 1.4);
  }
}

// A tumbling house floor (rotated about its own centre) during the collapse.
function drawDebris(d) {
  ctx.save();
  ctx.translate(d.cx, d.yTop + BLOCK_H / 2);
  ctx.rotate(d.rot);
  ctx.translate(-d.cx, -(d.yTop + BLOCK_H / 2));
  drawHouse({ cx: d.cx, w: d.w, yTop: d.yTop, hue: d.hue }, 1);
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
  ctx.fillStyle = "#fff"; ctx.textAlign = "center";
  ctx.fillText(h, WORLD_W / 2, 24);
  ctx.textAlign = "left";

  // Lean / balance meter — fills toward red as the building tips.
  if (engine.state === "playing") {
    const bw = 150, bx = WORLD_W / 2 - bw / 2, by = 46;
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    roundRect(bx, by, bw, 8, 4);
    const f = Math.abs(engine.leanFrac);
    const col = f < 0.55 ? "#46e0a0" : f < 0.8 ? "#ffd23f" : "#ff5a5a";
    ctx.fillStyle = col;
    // marker grows from the centre toward the leaning side.
    const half = bw / 2;
    const wlen = half * f;
    if (engine.leanFrac >= 0) roundRect(bx + half, by, wlen, 8, 4);
    else roundRect(bx + half - wlen, by, wlen, 8, 4);
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.fillRect(bx + half - 1, by - 2, 2, 12);
  }

  // Co-op turn indicator.
  if (engine.numPlayers === 2 && engine.state === "playing") {
    const label = "P" + (engine.turn + 1) + "'s turn";
    ctx.font = "bold 16px 'Segoe UI', sans-serif";
    const lw = ctx.measureText(label).width;
    ctx.globalAlpha = 0.6 + Math.abs(Math.sin(animClock * 5)) * 0.4;
    ctx.fillStyle = PLAYER_TINT[engine.turn];
    roundRect(WORLD_W / 2 - lw / 2 - 10, 62, lw + 20, 24, 7);
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#fff"; ctx.textAlign = "center";
    ctx.fillText(label, WORLD_W / 2, 74);
    ctx.textAlign = "left";
  }
}

// ---- Helpers --------------------------------------------------------------
function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
function rgb(c) { return `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`; }
function dot(x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }
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
  // Phone controller: one big Drop (also starts the game).
  Controls.define({ profile: "buttons", buttons: [{ id: "enter", label: "Drop" }] });
  els.best.textContent = best;
  els.mute.addEventListener("click", toggleMute);
  window.addEventListener("keydown", (e) => { if (e.key === "m" || e.key === "M") toggleMute(); });
  window.addEventListener("resize", resize);

  camY = (BASE_Y - DROP_H - PIVOT_UP) - 24;
  resize();
  showMenu("Space Tower", "A crane drops houses from the sky — stack them straight or the tower topples!");
  lastTime = performance.now();
  requestAnimationFrame(loop);
}

boot();
