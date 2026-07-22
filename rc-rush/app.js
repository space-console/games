// RC Rush — pseudo-3D renderer + input + audio + shell wiring. Projects the
// segment ribbon from engine.js with a chase camera for a behind-the-car view,
// and paints the road, room walls, boosters, rival cars, and the player's RC.

import { Race, SEG, ROAD, WALL_H, CAM_HEIGHT, LAPS, THEMES } from "./engine.js?v=ba40ea1b-ba9e-440b-b26a-94527815dafb";
import { Input } from "../assets/js/shared/input.js?v=ba40ea1b-ba9e-440b-b26a-94527815dafb";
import { Controls } from "../assets/js/shared/controls.js?v=ba40ea1b-ba9e-440b-b26a-94527815dafb";
import { Stats } from "../assets/js/shared/stats.js?v=ba40ea1b-ba9e-440b-b26a-94527815dafb";
import { Sound } from "../assets/js/shared/sound.js?v=ba40ea1b-ba9e-440b-b26a-94527815dafb";

const canvas = document.getElementById("view");
const ctx = canvas.getContext("2d");
const race = new Race();
const input = new Input();
const sound = new Sound();

const el = {
  lap: document.getElementById("lap"), pos: document.getElementById("pos"),
  time: document.getElementById("time"), speed: document.getElementById("speed"),
  room: document.getElementById("room"), boost: document.getElementById("boostFill"),
  count: document.getElementById("count"), overlay: document.getElementById("overlay"),
  results: document.getElementById("results"), resultList: document.getElementById("resultList"),
  cta: document.getElementById("cta"), mute: document.getElementById("mute"),
};

const FOV = 100;
const CAM_DEPTH = 1 / Math.tan((FOV / 2) * Math.PI / 180);
const PLAYER_Z = CAM_HEIGHT * CAM_DEPTH;
const RENDER_DIST = 150;         // segments drawn (fog hides the cut)
const CAR_W = 950;               // sprite car width (world units)
const HAZE = [12, 16, 30];

let W = 0, H = 0, dpr = 1, t = 0;
let shake = 0;

function resize() {
  dpr = Math.min(2, window.devicePixelRatio || 1);
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = Math.floor(W * dpr); canvas.height = Math.floor(H * dpr);
  canvas.style.width = W + "px"; canvas.style.height = H + "px";
}
window.addEventListener("resize", resize); resize();

// ---- Input ----------------------------------------------------------------
const keys = {};
window.addEventListener("keydown", (e) => { keys[e.code] = true; });
window.addEventListener("keyup", (e) => { keys[e.code] = false; });
const phone = { gas: false, brake: false, steerL: false, steerR: false, drift: false };
const pulse = { up: 0, down: 0, left: 0, right: 0 };
const held = (d) => performance.now() - pulse[d] < 170;

input.on((intent) => {
  if (intent === "enter") return onEnter();
  if (intent === "back") { if (!input.embedded) location.href = "../"; return; }
  if (intent.endsWith(":release")) { const b = intent.slice(0, -8); if (b in phone) phone[b] = false; return; }
  if (intent in phone) { phone[intent] = true; return; }
  if (intent in pulse) pulse[intent] = performance.now();
});

function readControls() {
  const up = keys.ArrowUp || keys.KeyW || phone.gas || held("up");
  const down = keys.ArrowDown || keys.KeyS || phone.brake || held("down");
  const left = keys.ArrowLeft || keys.KeyA || phone.steerL || held("left");
  const right = keys.ArrowRight || keys.KeyD || phone.steerR || held("right");
  return { throttle: (up ? 1 : 0) - (down ? 1 : 0), steer: (right ? 1 : 0) - (left ? 1 : 0) };
}

function onEnter() {
  sound.resume(); startEngine();
  if (race.state === "ready") { race.start(); hide(el.overlay); }
  else if (race.state === "finished") { race.reset(); hide(el.results); show(el.overlay); }
}

// ---- Audio ----------------------------------------------------------------
let engine = null;
function startEngine() {
  if (engine || !sound.ctx) return;
  try {
    const o = sound.ctx.createOscillator(), g = sound.ctx.createGain();
    o.type = "sawtooth"; o.frequency.value = 60; g.gain.value = 0.0001;
    o.connect(g); g.connect(sound.master); o.start();
    engine = { o, g };
  } catch { engine = null; }
}
function engineTone() {
  if (!engine || !sound.ctx) return;
  const c = sound.ctx.currentTime;
  const p = race.player;
  engine.o.frequency.setTargetAtTime(58 + (p.speed / (SEG * 62)) * 240 + (p.boost > 0 ? 60 : 0), c, 0.05);
  engine.g.gain.setTargetAtTime(sound.muted ? 0 : (race.state === "racing" ? 0.05 : 0.02), c, 0.1);
}
race.addEventListener("beep", (e) => sound._blip(e.detail.go ? 880 : 440, e.detail.go ? 0.25 : 0.12, "square", 0, 0.5));
race.addEventListener("lap", () => sound._blip(660, 0.12, "triangle", 0, 0.5));
race.addEventListener("crash", () => { sound._blip(70, 0.14, "sawtooth", 0, 0.55); shake = Math.min(1, shake + 0.6); });
race.addEventListener("boost", () => sound._seq([440, 660, 880], 0.09, "square", 0.04, 0.5));
race.addEventListener("finish", (e) => { sound._seq([523, 659, 784, 1047], 0.14, "square", 0.08, 0.55); showResults(e.detail.place, e.detail.time); reportScore(e.detail.place, e.detail.time); });
el.mute.addEventListener("click", () => { const m = sound.toggleMute(); el.mute.textContent = m ? "🔇" : "🔊"; });

// ---- Projection -----------------------------------------------------------
function project(p, camX, camY, camZ) {
  const dz = p.z - camZ;
  const scale = CAM_DEPTH / (dz <= 0 ? 0.0001 : dz);
  p.screen.scale = scale;
  p.screen.x = W / 2 - scale * camX * W / 2;
  p.screen.y = H / 2 - scale * (p.y - camY) * H / 2;
  p.screen.w = scale * ROAD * W / 2;
  p.camz = dz;
}

// ---- Game loop ------------------------------------------------------------
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now; t = now / 1000;
  if (race.state === "racing" || race.state === "countdown") race.update(dt, readControls());
  shake *= Math.pow(0.02, dt);
  render();
  updateHud();
  engineTone();
  requestAnimationFrame(frame);
}

// ---- Rendering ------------------------------------------------------------
function render() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const sx = (Math.random() - 0.5) * shake * 14, sy = (Math.random() - 0.5) * shake * 14;
  ctx.save(); ctx.translate(sx, sy);

  const segs = race.segments, N = segs.length, pos = race.player.z;
  const base = race.findSegment(pos);
  const basePercent = (pos % SEG) / SEG;
  const pSeg = race.findSegment(pos + PLAYER_Z);
  const pPercent = ((pos + PLAYER_Z) % SEG) / SEG;
  const playerY = pSeg.p1.y + (pSeg.p2.y - pSeg.p1.y) * pPercent;
  const camY = playerY + CAM_HEIGHT;
  const px = race.player.x + race.player.bump * 0.15;

  drawBackground(base.theme, px);

  // Forward pass: project + accumulate curve.
  let x = 0, dx = -(base.curve * basePercent);
  const vis = [];
  for (let n = 0; n < RENDER_DIST; n++) {
    const seg = segs[(base.index + n) % N];
    const looped = seg.index < base.index;
    const camZ = pos - (looped ? race.trackLength : 0);
    project(seg.p1, px * ROAD - x, camY, camZ);
    project(seg.p2, px * ROAD - x - dx, camY, camZ);
    x += dx; dx += seg.curve;
    seg.fog = 1 / Math.exp((n / RENDER_DIST) * (n / RENDER_DIST) * 4.5);
    if (seg.p1.camz > CAM_DEPTH * 0.6) vis.push(seg);
  }
  // Map rival cars to their segment for the sprite pass.
  const carsBySeg = new Map();
  for (const a of race.actors) {
    if (a.isPlayer) continue;
    const s = race.findSegment(a.z);
    if (!carsBySeg.has(s.index)) carsBySeg.set(s.index, []);
    carsBySeg.get(s.index).push(a);
  }

  // Ground + road + walls, far → near (painter's order for tall walls).
  for (let k = vis.length - 1; k >= 0; k--) drawSegment(vis[k], segs, N);
  // Sprites (boosters, props, rivals), far → near.
  for (let k = vis.length - 1; k >= 0; k--) drawSprites(vis[k], carsBySeg.get(vis[k].index));

  drawPlayerCar();
  ctx.restore();
}

function drawBackground(theme, px) {
  const th = THEMES[theme];
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, mix(th.wallAlt, "#05060f", 0.55));
  g.addColorStop(0.5, mix(th.wall, "#0a0e1c", 0.35));
  g.addColorStop(1, mix(th.grass, "#0a0e1c", 0.2));
  ctx.fillStyle = g; ctx.fillRect(-20, -20, W + 40, H + 40);
  // Parallax back wall band.
  ctx.fillStyle = "rgba(0,0,0,0.15)";
  ctx.fillRect(-20 - px * 40, H * 0.42, W + 40, 3);
}

function poly(x1, y1, x2, y2, x3, y3, x4, y4, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineTo(x3, y3); ctx.lineTo(x4, y4);
  ctx.closePath(); ctx.fill();
}

function drawSegment(seg, segs, N) {
  const p1 = seg.p1.screen, p2 = seg.p2.screen;
  if (p1.y <= p2.y) return;
  const th = THEMES[seg.theme];
  const alt = Math.floor(seg.index / 3) % 2 === 0;
  const fog = seg.fog;

  // Room floor (full width band).
  ctx.fillStyle = mixRgb(alt ? th.grass : th.grassAlt, HAZE, 1 - fog);
  ctx.fillRect(0, p2.y, W, p1.y - p2.y + 1);

  // Road.
  poly(p1.x - p1.w, p1.y, p1.x + p1.w, p1.y, p2.x + p2.w, p2.y, p2.x - p2.w, p2.y, mixRgb(alt ? th.floor : th.floorAlt, HAZE, 1 - fog));
  // Rumble strips.
  const r1 = p1.w * 0.12, r2 = p2.w * 0.12;
  const rc = mixRgb(alt ? th.rumble : "#c0392b", HAZE, 1 - fog);
  poly(p1.x - p1.w, p1.y, p1.x - p1.w + r1, p1.y, p2.x - p2.w + r2, p2.y, p2.x - p2.w, p2.y, rc);
  poly(p1.x + p1.w, p1.y, p1.x + p1.w - r1, p1.y, p2.x + p2.w - r2, p2.y, p2.x + p2.w, p2.y, rc);
  // Lane dashes.
  if (alt) {
    const l1 = p1.w * 0.03, l2 = p2.w * 0.03;
    poly(p1.x - l1, p1.y, p1.x + l1, p1.y, p2.x + l2, p2.y, p2.x - l2, p2.y, mixRgb(th.lane, HAZE, 1 - fog));
  }

  // Room walls (skip at a doorway — where the theme changes).
  const prev = segs[(seg.index - 1 + N) % N];
  if (prev.theme === seg.theme) {
    drawWall(seg, -1, th, fog);
    drawWall(seg, 1, th, fog);
  }
}

function drawWall(seg, side, th, fog) {
  const p1 = seg.p1.screen, p2 = seg.p2.screen;
  const WALLX = 1.5;
  const bx1 = p1.x + side * p1.w * WALLX, bx2 = p2.x + side * p2.w * WALLX;
  const h1 = WALL_H * p1.scale * H / 2, h2 = WALL_H * p2.scale * H / 2;
  const alt = Math.floor(seg.index / 2) % 2 === 0;
  poly(bx1, p1.y, bx1, p1.y - h1, bx2, p2.y - h2, bx2, p2.y, mixRgb(alt ? th.wall : th.wallAlt, HAZE, 1 - fog));
  // Top trim (baseboard/cornice highlight).
  const tt = p1.w * 0.06;
  poly(bx1, p1.y - h1, bx1, p1.y - h1 - tt * 8, bx2, p2.y - h2 - tt * 8 * (h2 / (h1 || 1)), bx2, p2.y - h2, mixRgb(th.wallTop, HAZE, 1 - fog));
}

function drawSprites(seg, cars) {
  const p1 = seg.p1.screen;
  const scale = p1.scale, baseY = p1.y, w = p1.w;
  // Boosters (turbo pads).
  for (const b of seg.boosters) {
    if (b.taken > 0) continue;
    drawBooster(p1.x + b.x * w, baseY, scale);
  }
  // Roadside props.
  for (const s of seg.sprites) drawProp(s.kind, p1.x + s.x * w, baseY, scale);
  // Rival cars.
  if (cars) for (const c of cars) drawCarSprite(p1.x + c.x * w, baseY, Math.min(W * 0.4, scale * CAR_W * W / 2), c.color, c.boost > 0);
}

function drawBooster(x, y, scale) {
  const s = Math.min(H * 0.16, scale * ROAD * W / 2 * 0.24);
  if (s < 3) return;
  const bob = Math.sin(t * 6 + x * 0.01) * s * 0.15;
  // Floor pad.
  ctx.fillStyle = "rgba(108,224,255,0.25)";
  ctx.beginPath(); ctx.ellipse(x, y, s * 0.9, s * 0.35, 0, 0, Math.PI * 2); ctx.fill();
  // Floating chevrons.
  ctx.fillStyle = "#6ce0ff";
  for (let i = 0; i < 3; i++) {
    const yy = y - s * 0.5 - i * s * 0.4 + bob;
    ctx.globalAlpha = 1 - i * 0.28;
    ctx.beginPath();
    ctx.moveTo(x, yy - s * 0.35); ctx.lineTo(x + s * 0.5, yy); ctx.lineTo(x + s * 0.28, yy);
    ctx.lineTo(x, yy - s * 0.14); ctx.lineTo(x - s * 0.28, yy); ctx.lineTo(x - s * 0.5, yy);
    ctx.closePath(); ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawProp(kind, x, y, scale) {
  const s = Math.min(H * 0.22, scale * 360 * W / 2);
  if (s < 2) return;
  const colors = { box: "#b07d3a", plant: "#3f9a4e", cone: "#ff7a1a", ball: "#e0445a", book: "#4f8cff" };
  ctx.fillStyle = colors[kind] || "#888";
  if (kind === "plant") {
    ctx.fillStyle = "#6b4a2a"; ctx.fillRect(x - s * 0.18, y - s * 0.5, s * 0.36, s * 0.5);
    ctx.fillStyle = "#3f9a4e"; ctx.beginPath(); ctx.arc(x, y - s * 0.7, s * 0.5, 0, Math.PI * 2); ctx.fill();
  } else if (kind === "ball") {
    ctx.beginPath(); ctx.arc(x, y - s * 0.5, s * 0.5, 0, Math.PI * 2); ctx.fill();
  } else if (kind === "cone") {
    ctx.beginPath(); ctx.moveTo(x, y - s); ctx.lineTo(x + s * 0.5, y); ctx.lineTo(x - s * 0.5, y); ctx.closePath(); ctx.fill();
  } else {
    ctx.fillRect(x - s * 0.5, y - s, s, s);
  }
}

// Rear-view RC car sprite.
function drawCarSprite(x, y, w, color, boosting) {
  if (w < 4) return;
  const h = w * 0.72;
  ctx.save(); ctx.translate(x, y);
  // Shadow.
  ctx.fillStyle = "rgba(0,0,0,0.3)"; ctx.beginPath(); ctx.ellipse(0, 0, w * 0.55, w * 0.14, 0, 0, Math.PI * 2); ctx.fill();
  // Boost flames.
  if (boosting) {
    ctx.fillStyle = "rgba(255,180,60,0.9)";
    for (const sx of [-0.28, 0.28]) { ctx.beginPath(); ctx.ellipse(x * 0 + sx * w, -h * 0.1, w * 0.1, w * 0.22 + Math.random() * w * 0.1, 0, 0, Math.PI * 2); ctx.fill(); }
  }
  // Wheels.
  ctx.fillStyle = "#14161f";
  ctx.fillRect(-w * 0.55, -h * 0.5, w * 0.16, h * 0.5);
  ctx.fillRect(w * 0.39, -h * 0.5, w * 0.16, h * 0.5);
  // Body.
  const g = ctx.createLinearGradient(0, -h, 0, 0);
  g.addColorStop(0, shade(color, 1.25)); g.addColorStop(1, shade(color, 0.85));
  ctx.fillStyle = g; roundRect(-w * 0.42, -h, w * 0.84, h, w * 0.12); ctx.fill();
  // Rear window + lights.
  ctx.fillStyle = "rgba(15,20,35,0.85)"; roundRect(-w * 0.3, -h * 0.85, w * 0.6, h * 0.4, w * 0.08); ctx.fill();
  ctx.fillStyle = "#ff5a5a"; ctx.fillRect(-w * 0.36, -h * 0.2, w * 0.12, h * 0.14); ctx.fillRect(w * 0.24, -h * 0.2, w * 0.12, h * 0.14);
  ctx.restore();
}

function drawPlayerCar() {
  const p = race.player;
  const w = W * 0.16, h = w * 0.66;
  const cx = W / 2 + (p.steer || 0) * 0 + p.bump * 30 + Math.sin(t * 3) * 2;
  const lean = p.x * 8;
  const cy = H * 0.84 + Math.sin(t * 8) * (p.speed > 0 ? 2 : 0);
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(lean * 0.002);
  ctx.fillStyle = "rgba(0,0,0,0.35)"; ctx.beginPath(); ctx.ellipse(0, h * 0.4, w * 0.6, w * 0.14, 0, 0, Math.PI * 2); ctx.fill();
  if (p.boost > 0) {
    ctx.fillStyle = "rgba(255,190,70,0.92)";
    for (const sx of [-0.3, 0.3]) { ctx.beginPath(); ctx.ellipse(sx * w, h * 0.2, w * 0.11, w * 0.26 + Math.random() * w * 0.12, 0, 0, Math.PI * 2); ctx.fill(); }
  }
  // Wheels.
  ctx.fillStyle = "#14161f";
  ctx.fillRect(-w * 0.58, -h * 0.4, w * 0.18, h * 0.6);
  ctx.fillRect(w * 0.4, -h * 0.4, w * 0.18, h * 0.6);
  // Body.
  const g = ctx.createLinearGradient(0, -h, 0, h * 0.3);
  g.addColorStop(0, "#5cf0a8"); g.addColorStop(1, "#1f9c63");
  ctx.fillStyle = g; roundRect(-w * 0.45, -h, w * 0.9, h * 1.1, w * 0.14); ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.35)"; ctx.lineWidth = 2; ctx.stroke();
  // Rear window.
  ctx.fillStyle = "rgba(15,20,35,0.85)"; roundRect(-w * 0.32, -h * 0.9, w * 0.64, h * 0.45, w * 0.08); ctx.fill();
  // Tail lights.
  ctx.fillStyle = "#ff5a5a"; ctx.fillRect(-w * 0.4, -h * 0.15, w * 0.14, h * 0.16); ctx.fillRect(w * 0.26, -h * 0.15, w * 0.14, h * 0.16);
  // Antenna.
  ctx.strokeStyle = "#e8e8f0"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(-w * 0.3, -h); ctx.lineTo(-w * 0.4, -h * 1.5); ctx.stroke();
  ctx.fillStyle = "#6ce0ff"; ctx.beginPath(); ctx.arc(-w * 0.4, -h * 1.5, w * 0.03, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// ---- HUD ------------------------------------------------------------------
function updateHud() {
  const p = race.player;
  el.lap.textContent = Math.min(LAPS, p.laps + 1);
  el.pos.textContent = p.place;
  el.time.textContent = race.time.toFixed(1);
  el.speed.textContent = Math.round(p.speed / (SEG * 62) * 260);
  const seg = race.findSegment(p.z + PLAYER_Z);
  el.room.textContent = THEMES[seg.theme].name;
  el.boost.style.width = Math.max(0, Math.min(1, p.boost / 2.4)) * 100 + "%";
  if (race.state === "countdown") { el.count.hidden = false; el.count.textContent = race.countdown > 0 ? race.countdown : "GO!"; el.count.className = "count" + (race.countdown > 0 ? "" : " count--go"); }
  else el.count.hidden = true;
}

function showResults(place, time) {
  const order = [...race.actors].sort((a, b) => b._dist - a._dist);
  const ord = ["1st", "2nd", "3rd", "4th"];
  el.resultList.innerHTML = order.map((c, i) => `<li class="${c.isPlayer ? "is-you" : ""}"><span class="rl__pos">${ord[i]}</span><span class="rl__dot" style="background:${c.color}"></span><span class="rl__name">${c.name}</span></li>`).join("");
  el.results.querySelector(".results__head").textContent = place === 1 ? "You Win! 🏆" : `You finished ${ord[place - 1]}`;
  el.results.querySelector(".results__time").textContent = `Time ${time.toFixed(1)}s`;
  show(el.results);
}
function reportScore(place, time) {
  const base = { 1: 1000, 2: 600, 3: 350, 4: 150 }[place] || 100;
  Stats.score(base + Math.max(0, Math.round(3000 - time * 8)));
}

// ---- Helpers --------------------------------------------------------------
function show(n) { n.hidden = false; n.classList.remove("is-hidden"); }
function hide(n) { n.classList.add("is-hidden"); setTimeout(() => { n.hidden = true; }, 220); }
function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
function shade(hex, f) { const n = parseInt(hex.slice(1), 16); return `rgb(${Math.min(255, ((n >> 16) & 255) * f) | 0},${Math.min(255, ((n >> 8) & 255) * f) | 0},${Math.min(255, (n & 255) * f) | 0})`; }
function hexRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function mix(a, b, t2) { const A = hexRgb(a), B = hexRgb(b); return `rgb(${A[0] + (B[0] - A[0]) * t2 | 0},${A[1] + (B[1] - A[1]) * t2 | 0},${A[2] + (B[2] - A[2]) * t2 | 0})`; }
function mixRgb(a, arr, t2) { const A = hexRgb(a); return `rgb(${A[0] + (arr[0] - A[0]) * t2 | 0},${A[1] + (arr[1] - A[1]) * t2 | 0},${A[2] + (arr[2] - A[2]) * t2 | 0})`; }

// ---- Boot -----------------------------------------------------------------
el.cta.addEventListener("click", onEnter);
Controls.define({
  profile: "buttons",
  buttons: [
    { id: "steerL", label: "◀", hold: true },
    { id: "gas", label: "Gas", hold: true },
    { id: "brake", label: "Brake", hold: true },
    { id: "steerR", label: "▶", hold: true },
  ],
});
input.start();
requestAnimationFrame(frame);
