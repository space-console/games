// Icy Tower for Space Console — entry point.
// Wires input to the pure engine, runs a fixed-dt accumulator loop, and renders
// the brick tower, icy platforms, the climber, and the HUD/combo popups. The
// engine owns all rules + physics; this file is input + render only.
//
// Movement needs smooth held-key control, so the physical keys are read directly
// here: ← / → run, ↑ / Space jump. The shared Input layer handles Back (→ menu)
// and touch taps; on-screen buttons cover touch.

import {
  Engine,
  WORLD_W, WORLD_H,
  WALL, PLAY_L, PLAY_R,
  GROUND_Y, FLOOR_GAP,
  PLAYER_W, PLAYER_H,
} from "./engine.js?v=36cab9b8-1f60-4318-ac58-33473316838a";
import { Input } from "../assets/js/shared/input.js?v=36cab9b8-1f60-4318-ac58-33473316838a";
import { Sound } from "../assets/js/shared/sound.js?v=36cab9b8-1f60-4318-ac58-33473316838a";

const engine = new Engine(Math.random);
const input = new Input();
const sound = new Sound();

const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");

const els = {
  status: document.getElementById("status"),
  score: document.getElementById("score"),
  floor: document.getElementById("floor"),
  best: document.getElementById("best"),
  overlay: document.getElementById("overlay"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlayMsg: document.getElementById("overlayMsg"),
  mute: document.getElementById("mute"),
  btnLeft: document.getElementById("btnLeft"),
  btnRight: document.getElementById("btnRight"),
  btnJump: document.getElementById("btnJump"),
};

const BEST_KEY = "icytower.best";
let best = Number(localStorage.getItem(BEST_KEY) || 0);

const held = { left: false, right: false, jump: false };

// Floating combo popups (cosmetic, lives only in the renderer).
const popups = [];
// Combo praise tiers (plain words, chosen by floors climbed in the chain).
const TIERS = [
  [2, "Good!"], [4, "Great!"], [7, "Amazing!"], [10, "Wonderful!"],
  [15, "Extreme!"], [20, "Fantastic!"], [28, "Unbelievable!"],
];
function tierWord(floors) {
  let w = "Good!";
  for (const [n, word] of TIERS) if (floors >= n) w = word;
  return w;
}

const STEP = 1 / 120;
const MAX_FRAME = 0.05;
let lastTime = 0;
let acc = 0;
let animClock = 0;

// ---- Game-state transitions ----------------------------------------------
function startGame() {
  sound.resume();
  sound.start();
  held.left = held.right = held.jump = false;
  popups.length = 0;
  engine.start();
  hideOverlay();
  setStatus("");
  lastTime = performance.now();
  acc = 0;
}

function idleOrOver() { return engine.state === "idle" || engine.state === "over"; }

engine.addEventListener("jump", () => sound.move());
engine.addEventListener("wall", () => sound.rotate());
engine.addEventListener("land", (e) => { if (e.detail.climbed >= 4) sound.lock(); });
engine.addEventListener("combo", (e) => {
  const p = engine.player;
  spawnPopup(tierWord(e.detail.floors) + " " + e.detail.floors, p.x, p.y - 50, "#7fe3ff", 22);
});
engine.addEventListener("comboend", (e) => {
  const p = engine.player;
  spawnPopup("+" + e.detail.bonus, p.x, p.y - 60, "#ffd23f", 26);
  sound.clear(Math.min(4, Math.ceil(e.detail.floors / 5)));
});
engine.addEventListener("gameover", () => {
  sound.gameOver();
  if (engine.score > best) { best = engine.score; localStorage.setItem(BEST_KEY, String(best)); }
  showOverlay("Game Over", `Score ${engine.score} · Floor ${engine.maxFloor} · Best ${best}<br>Tap or press <kbd>Enter</kbd> to climb again`);
  setStatus("Game over");
});

function spawnPopup(text, x, y, color, size) {
  popups.push({ text, x, y, vy: -40, age: 0, ttl: 1.1, color, size });
}

// ---- Input ----------------------------------------------------------------
input.on((intent) => {
  if (intent === "back") { location.href = "../"; return; }
  if (intent === "enter") {
    if (idleOrOver()) startGame();
    else { sound.resume(); engine.jump(); }
  }
});

window.addEventListener("keydown", (e) => {
  if (idleOrOver() && (e.key === "Enter" || e.key === " ")) { startGame(); return; }
  switch (e.key) {
    case "ArrowLeft": case "a": case "A": held.left = true; e.preventDefault(); break;
    case "ArrowRight": case "d": case "D": held.right = true; e.preventDefault(); break;
    case "ArrowUp": case " ": case "w": case "W":
      held.jump = true; engine.jump(); e.preventDefault(); break;
  }
});
window.addEventListener("keyup", (e) => {
  switch (e.key) {
    case "ArrowLeft": case "a": case "A": held.left = false; break;
    case "ArrowRight": case "d": case "D": held.right = false; break;
    case "ArrowUp": case " ": case "w": case "W": held.jump = false; break;
  }
});

canvas.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  if (idleOrOver()) startGame(); else { sound.resume(); engine.jump(); }
});

function holdButton(el, set) {
  el.addEventListener("pointerdown", (e) => { e.preventDefault(); set(true); });
  el.addEventListener("pointerup", (e) => { e.preventDefault(); set(false); });
  el.addEventListener("pointerleave", () => set(false));
  el.addEventListener("pointercancel", () => set(false));
}
holdButton(els.btnLeft, (v) => (held.left = v));
holdButton(els.btnRight, (v) => (held.right = v));
// Hold the JUMP button to keep auto-jumping (start the game on the first tap).
els.btnJump.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  if (idleOrOver()) { startGame(); return; }
  sound.resume();
  held.jump = true;
});
els.btnJump.addEventListener("pointerup", (e) => { e.preventDefault(); held.jump = false; });
els.btnJump.addEventListener("pointerleave", () => (held.jump = false));
els.btnJump.addEventListener("pointercancel", () => (held.jump = false));

// ---- Loop -----------------------------------------------------------------
function loop(now) {
  let frame = (now - lastTime) / 1000;
  lastTime = now;
  if (frame > MAX_FRAME) frame = MAX_FRAME;
  animClock += frame;

  engine.setMove((held.right ? 1 : 0) - (held.left ? 1 : 0));
  // Holding jump re-arms the jump each frame; the engine only acts on it when
  // grounded, so you auto-bounce on every landing.
  if (held.jump) engine.jump();
  acc += frame;
  while (acc >= STEP) { engine.step(STEP); acc -= STEP; }

  // Advance popups.
  for (const pu of popups) { pu.age += frame; pu.y += pu.vy * frame; }
  for (let i = popups.length - 1; i >= 0; i--) if (popups[i].age >= popups[i].ttl) popups.splice(i, 1);

  draw();
  requestAnimationFrame(loop);
}

// ---- Rendering ------------------------------------------------------------
let scaleX = 1, scaleY = 1;

function draw() {
  els.score.textContent = engine.score;
  els.floor.textContent = engine.maxFloor;
  els.best.textContent = Math.max(best, engine.score);

  const cam = engine.camTop;

  // 1) Background + side walls (screen-fixed, with parallax scroll).
  ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
  drawBackground(cam);

  // 2) World objects (platforms, player, popups) under the camera transform.
  ctx.setTransform(scaleX, 0, 0, scaleY, 0, -cam * scaleY);
  drawPlatforms();
  drawPlayer();
  drawPopups();

  // 3) Walls drawn over the world edges, then HUD (screen-fixed).
  ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
  drawWalls(cam);
  drawHud();
}

function drawBackground(cam) {
  const g = ctx.createLinearGradient(0, 0, 0, WORLD_H);
  g.addColorStop(0, "#101a3a");
  g.addColorStop(0.5, "#1c3168");
  g.addColorStop(1, "#244a8c");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);

  // Faint, parallax brick courses on the back wall so the tower reads as moving.
  const bh = 34, bw = 64;
  const off = ((-cam * 0.5) % bh + bh) % bh;
  ctx.strokeStyle = "rgba(255,255,255,0.04)";
  ctx.lineWidth = 2;
  for (let y = -bh + off; y < WORLD_H + bh; y += bh) {
    ctx.beginPath(); ctx.moveTo(WALL, y); ctx.lineTo(WORLD_W - WALL, y); ctx.stroke();
    const row = Math.round((y - off) / bh);
    const stagger = row % 2 ? bw / 2 : 0;
    for (let x = WALL + stagger; x < WORLD_W - WALL; x += bw) {
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + bh); ctx.stroke();
    }
  }

  // Soft vignette.
  const v = ctx.createRadialGradient(WORLD_W / 2, WORLD_H * 0.4, WORLD_H * 0.2, WORLD_W / 2, WORLD_H * 0.5, WORLD_H * 0.75);
  v.addColorStop(0, "rgba(0,0,0,0)");
  v.addColorStop(1, "rgba(0,0,0,0.35)");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);
}

// Stone side walls with brick courses, scrolling with the camera.
function drawWalls(cam) {
  const bh = 30;
  const off = ((-cam) % bh + bh) % bh;
  for (const wx of [0, WORLD_W - WALL]) {
    const g = ctx.createLinearGradient(wx, 0, wx + WALL, 0);
    g.addColorStop(0, "#46506a");
    g.addColorStop(0.5, "#697594");
    g.addColorStop(1, "#39425a");
    ctx.fillStyle = g;
    ctx.fillRect(wx, 0, WALL, WORLD_H);
    ctx.strokeStyle = "rgba(0,0,0,0.3)";
    ctx.lineWidth = 1.5;
    for (let i = 0, y = -bh + off; y < WORLD_H + bh; y += bh, i++) {
      ctx.beginPath(); ctx.moveTo(wx, y); ctx.lineTo(wx + WALL, y); ctx.stroke();
      const mx = (i % 2) ? wx + WALL / 2 : wx + WALL / 2; // single seam, alternating handled by row
      ctx.beginPath(); ctx.moveTo(mx, y); ctx.lineTo(mx, y + bh); ctx.stroke();
    }
    // Inner highlight edge.
    ctx.fillStyle = "rgba(255,255,255,0.10)";
    ctx.fillRect(wx === 0 ? WALL - 3 : WORLD_W - WALL, 0, 3, WORLD_H);
  }
}

// Icy ledges: a rounded slab with a snowy/icy top cap, a shaded underside, and
// the floor number stamped on it. The ground floor is a chunkier stone slab.
function drawPlatforms() {
  for (const f of engine.floors) {
    const x = f.x, y = f.y, w = f.w;
    if (f.ground) {
      ctx.fillStyle = "#6a5436";
      roundRect(x, y, w, 70, 6);
      ctx.fillStyle = "#caa56a";
      roundRect(x, y, w, 12, 6);
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.fillRect(x + 4, y, w - 8, 3);
      continue;
    }
    const h = 18;
    // Underside / body.
    const body = ctx.createLinearGradient(0, y, 0, y + h);
    body.addColorStop(0, "#bfeaff");
    body.addColorStop(1, "#5fa9d6");
    ctx.fillStyle = body;
    roundRect(x, y, w, h, 7);
    // Icy top cap.
    ctx.fillStyle = "#eaf8ff";
    roundRect(x, y, w, 7, 7);
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillRect(x + 5, y + 1, w - 10, 2);
    // Edge outline.
    ctx.strokeStyle = "rgba(20,60,90,0.45)";
    ctx.lineWidth = 1.5;
    roundRectStroke(x, y, w, h, 7);

    // Floor number.
    ctx.fillStyle = "rgba(15,45,70,0.65)";
    ctx.font = "bold 11px 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(f.n), x + w / 2, y + h / 2 + 1);
    ctx.textAlign = "left";
  }
}

// An original cartoon climber: baggy hoodie, a beanie cap, big sneakers, a round
// face. Leans into the run, tucks legs when airborne.
function drawPlayer() {
  const p = engine.player;
  const speed = Math.abs(p.vx);
  const lean = clamp(p.vx / 600, -0.4, 0.4);
  const airborne = !engine.onGround;
  const run = engine.onGround && speed > 30;
  const step = Math.sin(animClock * 18) * (speed / 260);

  ctx.save();
  ctx.translate(p.x, p.y);          // feet origin
  ctx.rotate(lean * 0.35);

  // Shadow on the ground.
  if (engine.onGround) {
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.beginPath(); ctx.ellipse(0, 1, 14, 4, 0, 0, Math.PI * 2); ctx.fill();
  }

  const hoodie = "#ff7a3c", hoodieDark = "#d8551c";
  const pants = "#2f3a57", skin = "#f6c49b", beanie = "#36c2a6";

  // Legs / sneakers.
  const legSwing = airborne ? 5 : (run ? step * 4 : 0);
  ctx.fillStyle = pants;
  roundRect(-8 + legSwing, -14, 7, 14, 3);
  roundRect(1 - legSwing, -14, 7, 14, 3);
  ctx.fillStyle = "#f2f4fa";
  roundRect(-11 + legSwing, -5, 11, 5, 2.5);
  roundRect(0 - legSwing, -5, 11, 5, 2.5);
  ctx.fillStyle = hoodie;
  ctx.fillRect(-11 + legSwing, -5, 11, 2);
  ctx.fillRect(0 - legSwing, -5, 11, 2);

  // Baggy hoodie torso.
  ctx.fillStyle = hoodie;
  roundRect(-13, -34, 26, 22, 8);
  ctx.fillStyle = hoodieDark;
  roundRect(-13, -34, 26, 5, 4);          // hood collar
  ctx.fillStyle = "rgba(255,255,255,0.25)";
  ctx.fillRect(-1, -32, 2, 18);            // zipper

  // Arms (swing with the run / raise when airborne).
  ctx.strokeStyle = hoodie; ctx.lineWidth = 6; ctx.lineCap = "round";
  const armA = airborne ? -10 : step * 6;
  ctx.beginPath(); ctx.moveTo(-10, -30); ctx.lineTo(-15, -22 + armA); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(10, -30); ctx.lineTo(15, -22 - armA); ctx.stroke();
  ctx.fillStyle = skin;
  dot(-15, -22 + armA, 3); dot(15, -22 - armA, 3);

  // Head + beanie + face.
  ctx.fillStyle = skin; dot(0, -40, 10);
  ctx.fillStyle = beanie;
  ctx.beginPath(); ctx.arc(0, -42, 10, Math.PI * 1.0, Math.PI * 2.0); ctx.closePath(); ctx.fill();
  ctx.fillRect(-10, -43, 20, 4);
  ctx.fillStyle = "#27d3b0"; dot(0, -52, 2.5);    // bobble
  const look = Math.sign(p.vx) * 1.6;
  ctx.fillStyle = "#fff"; dot(-3.5 + look, -39, 2.6); dot(3.5 + look, -39, 2.6);
  ctx.fillStyle = "#27313f"; dot(-3.5 + look * 1.4, -38.6, 1.3); dot(3.5 + look * 1.4, -38.6, 1.3);
  ctx.strokeStyle = "#9a4a36"; ctx.lineWidth = 1.3;
  ctx.beginPath(); ctx.arc(1, -35, 2.6, 0.1 * Math.PI, 0.9 * Math.PI); ctx.stroke();

  ctx.restore();
}

function drawPopups() {
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const pu of popups) {
    const t = pu.age / pu.ttl;
    const alpha = 1 - t * t;
    const pop = 1 + Math.min(0.3, pu.age * 2);
    ctx.globalAlpha = alpha;
    ctx.font = `bold ${Math.round(pu.size * pop)}px 'Segoe UI', sans-serif`;
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.strokeText(pu.text, pu.x, pu.y);
    ctx.fillStyle = pu.color;
    ctx.fillText(pu.text, pu.x, pu.y);
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = "left";
}

// ---- HUD ------------------------------------------------------------------
function drawHud() {
  // Floor counter, top-left.
  ctx.font = "bold 18px 'Segoe UI', sans-serif";
  ctx.textBaseline = "middle";
  const ftxt = "Floor " + engine.maxFloor;
  ctx.fillStyle = "rgba(0,0,0,0.4)";
  const fw = ctx.measureText(ftxt).width;
  roundRect(WALL + 6, 8, fw + 16, 26, 7);
  ctx.fillStyle = "#eaf8ff";
  ctx.fillText(ftxt, WALL + 14, 22);

  // Live combo meter, top-right, while a chain is building.
  if (engine.comboActive && engine.comboFloors >= 2) {
    const ctxt = "COMBO " + engine.comboFloors;
    ctx.font = "bold 18px 'Segoe UI', sans-serif";
    const cw = ctx.measureText(ctxt).width;
    const x = WORLD_W - WALL - 6 - cw - 16;
    const pulse = 0.5 + Math.abs(Math.sin(animClock * 8)) * 0.5;
    ctx.fillStyle = `rgba(255,140,40,${0.35 + pulse * 0.4})`;
    roundRect(x, 8, cw + 16, 26, 7);
    ctx.fillStyle = "#fff";
    ctx.fillText(ctxt, x + 8, 22);
  }
}

// ---- Canvas helpers -------------------------------------------------------
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
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
function roundRectStroke(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
  ctx.stroke();
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

// ---- Overlay helpers ------------------------------------------------------
function showOverlay(title, msg) {
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
  els.best.textContent = best;
  els.mute.addEventListener("click", toggleMute);
  window.addEventListener("keydown", (e) => { if (e.key === "m" || e.key === "M") toggleMute(); });
  window.addEventListener("resize", resize);

  resize();
  showOverlay("Icy Tower", "Run fast to jump high — chain floors for combos!<br>Tap or press <kbd>Space</kbd> to climb");
  lastTime = performance.now();
  requestAnimationFrame(loop);
}

boot();
