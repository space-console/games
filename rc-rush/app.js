// RC Rush — renderer, input, HUD, audio, and Space Console shell wiring.
// A thin view over engine.js: it reads the race model each frame and paints it,
// full-screen, with a follow camera. Driving uses held key/controller state
// (not the discrete intent stream) for smooth analog-ish control.

import { Race, LAPS, ROAD_HALF } from "./engine.js";
import { Input } from "../assets/js/shared/input.js";
import { Controls } from "../assets/js/shared/controls.js";
import { Stats } from "../assets/js/shared/stats.js";
import { Sound } from "../assets/js/shared/sound.js";

const canvas = document.getElementById("view");
const ctx = canvas.getContext("2d");
const race = new Race();
const input = new Input();
const sound = new Sound();

const el = {
  lap: document.getElementById("lap"), pos: document.getElementById("pos"),
  time: document.getElementById("time"), speed: document.getElementById("speed"),
  count: document.getElementById("count"), overlay: document.getElementById("overlay"),
  title: document.getElementById("title"), sub: document.getElementById("sub"),
  cta: document.getElementById("cta"), mute: document.getElementById("mute"),
  results: document.getElementById("results"), resultList: document.getElementById("resultList"),
};

let sw = 0, sh = 0, dpr = 1;
const cam = { x: race.player.x, y: race.player.y, zoom: 0.6 };
const skids = [];      // {x,y,a,life}
const puffs = [];      // {x,y,vx,vy,life,max,color}

// ---- Track bounds (for the minimap) ---------------------------------------
const bounds = (() => {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const [x, y] of race.track.pts) {
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
  }
  const pad = ROAD_HALF + 60;
  return { minx: minx - pad, miny: miny - pad, maxx: maxx + pad, maxy: maxy + pad };
})();

// ---- Resize (DPR-aware, full-screen) --------------------------------------
function resize() {
  dpr = Math.min(2, window.devicePixelRatio || 1);
  sw = window.innerWidth; sh = window.innerHeight;
  canvas.width = Math.floor(sw * dpr);
  canvas.height = Math.floor(sh * dpr);
  canvas.style.width = sw + "px";
  canvas.style.height = sh + "px";
}
window.addEventListener("resize", resize);
resize();

// ---- Input: held state (keys + phone) -------------------------------------
const keys = {};
window.addEventListener("keydown", (e) => { keys[e.code] = true; });
window.addEventListener("keyup", (e) => { keys[e.code] = false; });

// Phone hold-buttons (reliable press/release) + a decay map for a plain d-pad.
const phone = { gas: false, brake: false, steerL: false, steerR: false, drift: false };
const pulse = { up: 0, down: 0, left: 0, right: 0 };
const held = (dir) => performance.now() - pulse[dir] < 170;

input.on((intent) => {
  if (intent === "enter") { onEnter(); return; }
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
  const hb = keys.Space || keys.ShiftLeft || keys.ShiftRight || phone.drift;
  return { throttle: (up ? 1 : 0) - (down ? 1 : 0), steer: (right ? 1 : 0) - (left ? 1 : 0), handbrake: !!hb };
}

function onEnter() {
  sound.resume(); startEngine();
  if (race.state === "ready") { race.start(); hide(el.overlay); }
  else if (race.state === "finished") { race.reset(); hide(el.results); showStart(); }
}

// ---- Audio: continuous engine + event blips -------------------------------
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
  const t = sound.ctx.currentTime;
  const revs = 55 + Math.min(320, race.player.speed) * 0.62 + (race.player.slip * 0.05);
  engine.o.frequency.setTargetAtTime(revs, t, 0.06);
  const vol = sound.muted ? 0 : (race.state === "racing" ? 0.05 : 0.02);
  engine.g.gain.setTargetAtTime(vol, t, 0.1);
}
race.addEventListener("beep", (e) => sound._blip(e.detail.go ? 880 : 440, e.detail.go ? 0.25 : 0.12, "square", 0, 0.5));
race.addEventListener("lap", () => sound._blip(660, 0.12, "triangle", 0, 0.5));
race.addEventListener("crash", () => sound._blip(70, 0.16, "sawtooth", 0, 0.6));
race.addEventListener("finish", (e) => {
  sound._seq([523, 659, 784, 1047], 0.14, "square", 0.08, 0.55);
  showResults(e.detail.place, e.detail.time);
  reportScore(e.detail.place, e.detail.time);
});

el.mute.addEventListener("click", () => {
  const m = sound.toggleMute();
  el.mute.textContent = m ? "🔇" : "🔊";
  el.mute.setAttribute("aria-pressed", String(m));
});

// ---- Game loop ------------------------------------------------------------
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (race.state === "racing" || race.state === "countdown") race.update(dt, readControls());
  updateEffects(dt);
  updateCamera(dt);
  render();
  updateHud();
  engineTone();
  requestAnimationFrame(frame);
}

function updateCamera(dt) {
  const p = race.player;
  // Look ahead in the direction of travel; ease the camera toward it.
  const lead = Math.min(260, p.speed * 0.5);
  const tx = p.x + Math.cos(p.angle) * lead;
  const ty = p.y + Math.sin(p.angle) * lead;
  const k = 1 - Math.pow(0.001, dt);
  cam.x += (tx - cam.x) * k;
  cam.y += (ty - cam.y) * k;
  const target = Math.min(sw, sh) / 1050 * (1 - Math.min(0.2, p.speed / 5200));
  cam.zoom += (target - cam.zoom) * Math.min(1, dt * 4);
}

function updateEffects(dt) {
  // Skid marks when a car slides on tarmac; dust when off-road.
  for (const car of race.cars) {
    if (car.slip > 70 && !car.onGrass && car.speed > 60) {
      const back = 16;
      for (const side of [-11, 11]) {
        skids.push({
          x: car.x - Math.cos(car.angle) * back - Math.sin(car.angle) * side,
          y: car.y - Math.sin(car.angle) * back + Math.cos(car.angle) * side,
          life: 1,
        });
      }
    }
    if (car.onGrass && car.speed > 120 && Math.random() < 0.5) {
      puffs.push({ x: car.x, y: car.y, vx: (Math.random() - 0.5) * 60, vy: (Math.random() - 0.5) * 60, life: 0.5, max: 0.5, color: "154,120,74" });
    } else if (car.slip > 140 && !car.onGrass && Math.random() < 0.35) {
      puffs.push({ x: car.x, y: car.y, vx: (Math.random() - 0.5) * 40, vy: (Math.random() - 0.5) * 40, life: 0.4, max: 0.4, color: "200,200,210" });
    }
  }
  if (skids.length > 900) skids.splice(0, skids.length - 900);
  for (const s of skids) s.life -= dt * 0.08;
  for (let i = skids.length - 1; i >= 0; i--) if (skids[i].life <= 0) skids.splice(i, 1);
  for (const q of puffs) { q.x += q.vx * dt; q.y += q.vy * dt; q.life -= dt; }
  for (let i = puffs.length - 1; i >= 0; i--) if (puffs[i].life <= 0) puffs.splice(i, 1);
}

// ---- Rendering ------------------------------------------------------------
const W2S = (x, y) => [(x - cam.x) * cam.zoom + sw / 2, (y - cam.y) * cam.zoom + sh / 2];

function render() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, sw, sh);
  drawGrass();
  drawRoad();
  drawStartLine();
  drawSkids();
  for (const car of race.cars) if (!car.isPlayer) drawCar(car);
  drawCar(race.player);
  drawPuffs();
  drawMinimap();
}

function drawGrass() {
  const g = ctx.createLinearGradient(0, 0, 0, sh);
  g.addColorStop(0, "#1f7a3d"); g.addColorStop(1, "#166030");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, sw, sh);
  // Mown stripes in world space for a groundskeeping feel.
  const band = 150;
  const wy0 = cam.y - (sh / 2) / cam.zoom;
  const wy1 = cam.y + (sh / 2) / cam.zoom;
  ctx.fillStyle = "rgba(255,255,255,0.035)";
  for (let by = Math.floor(wy0 / band) * band; by < wy1; by += band * 2) {
    const [, y0] = W2S(0, by);
    ctx.fillRect(0, y0, sw, band * cam.zoom);
  }
}

function strokePath(width, style, dash) {
  const pts = race.track.pts;
  ctx.beginPath();
  for (let i = 0; i <= pts.length; i++) {
    const [x, y] = W2S(pts[i % pts.length][0], pts[i % pts.length][1]);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.lineWidth = width; ctx.strokeStyle = style;
  ctx.setLineDash(dash || []);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawRoad() {
  strokePath((ROAD_HALF + 34) * 2 * cam.zoom, "#3a2b12");            // dirt shoulder
  strokePath(ROAD_HALF * 2 * cam.zoom, "#2b2f3a");                   // asphalt
  strokePath(ROAD_HALF * 2 * cam.zoom - 6 * cam.zoom, "#31353f");    // inner shade
  strokePath(3 * cam.zoom, "rgba(255,220,120,0.55)", [26 * cam.zoom, 26 * cam.zoom]); // centre line
  // Road edge lines.
  ctx.save();
  strokeEdges();
  ctx.restore();
}

function strokeEdges() {
  const pts = race.track.pts, N = pts.length;
  for (const sign of [-1, 1]) {
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const a = pts[i % N], b = pts[(i + 1) % N];
      const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
      const nx = -dy / l, ny = dx / l;
      const [x, y] = W2S(a[0] + nx * sign * ROAD_HALF, a[1] + ny * sign * ROAD_HALF);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.lineWidth = 2 * cam.zoom; ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.stroke();
  }
}

function drawStartLine() {
  const tr = race.track;
  const [cx, cy] = tr.pointAt(0);
  const [ax, ay] = tr.pointAt(12);
  const ang = Math.atan2(ay - cy, ax - cx);
  const nx = -Math.sin(ang), ny = Math.cos(ang);
  const cols = 8, cell = (ROAD_HALF * 2) / cols;
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < cols; c++) {
      if ((r + c) % 2) continue;
      const off = -ROAD_HALF + c * cell;
      const wx = cx + nx * (off + cell / 2) + Math.cos(ang) * (r * cell - cell / 2);
      const wy = cy + ny * (off + cell / 2) + Math.sin(ang) * (r * cell - cell / 2);
      const [sx, sy] = W2S(wx, wy);
      ctx.save(); ctx.translate(sx, sy); ctx.rotate(ang);
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillRect(-cell * cam.zoom / 2, -cell * cam.zoom / 2, cell * cam.zoom, cell * cam.zoom);
      ctx.restore();
    }
  }
}

function drawSkids() {
  for (const s of skids) {
    const [x, y] = W2S(s.x, s.y);
    ctx.fillStyle = `rgba(20,18,24,${0.35 * s.life})`;
    ctx.beginPath();
    ctx.arc(x, y, 3.2 * cam.zoom, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawPuffs() {
  for (const q of puffs) {
    const [x, y] = W2S(q.x, q.y);
    const a = (q.life / q.max) * 0.5;
    ctx.fillStyle = `rgba(${q.color},${a})`;
    ctx.beginPath();
    ctx.arc(x, y, (1 - q.life / q.max) * 16 * cam.zoom + 4 * cam.zoom, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawCar(car) {
  const [x, y] = W2S(car.x, car.y);
  const z = cam.zoom;
  ctx.save();
  ctx.translate(x, y);
  // Shadow.
  ctx.save(); ctx.translate(3 * z, 4 * z); ctx.rotate(car.angle);
  ctx.fillStyle = "rgba(0,0,0,0.3)";
  roundRect(-26 * z, -15 * z, 52 * z, 30 * z, 7 * z); ctx.fill();
  ctx.restore();

  ctx.rotate(car.angle);
  const L = 52 * z, Wd = 30 * z;
  // Wheels (front pair steer).
  ctx.fillStyle = "#14161f";
  for (const [wx, wy, steer] of [[-16, -17, false], [-16, 17, false], [15, -17, true], [15, 17, true]]) {
    ctx.save(); ctx.translate(wx * z, wy * z); if (steer) ctx.rotate(car.steer * 0.5);
    roundRect(-8 * z, -5 * z, 16 * z, 10 * z, 3 * z); ctx.fill(); ctx.restore();
  }
  // Body.
  const body = ctx.createLinearGradient(0, -Wd / 2, 0, Wd / 2);
  body.addColorStop(0, shade(car.color, 1.25));
  body.addColorStop(1, shade(car.color, 0.8));
  ctx.fillStyle = body;
  roundRect(-L / 2, -Wd / 2, L, Wd, 8 * z); ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.35)"; ctx.lineWidth = 1.5 * z; ctx.stroke();
  // Cockpit / windshield.
  ctx.fillStyle = "rgba(15,20,35,0.85)";
  roundRect(-6 * z, -10 * z, 20 * z, 20 * z, 5 * z); ctx.fill();
  // Headlights.
  ctx.fillStyle = "rgba(255,245,200,0.9)";
  ctx.fillRect(L / 2 - 4 * z, -Wd / 2 + 3 * z, 3 * z, 5 * z);
  ctx.fillRect(L / 2 - 4 * z, Wd / 2 - 8 * z, 3 * z, 5 * z);
  // RC antenna.
  ctx.strokeStyle = "#e8e8f0"; ctx.lineWidth = 1.4 * z;
  ctx.beginPath(); ctx.moveTo(-L / 2 + 4 * z, 0); ctx.lineTo(-L / 2 - 10 * z, -10 * z); ctx.stroke();
  ctx.fillStyle = car.isPlayer ? "#6ce0ff" : "#ff5a5a";
  ctx.beginPath(); ctx.arc(-L / 2 - 10 * z, -10 * z, 2.4 * z, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  // Name tag above the car.
  if (car.isPlayer || car.speed > 30) {
    ctx.fillStyle = car.isPlayer ? "#6ce0ff" : "rgba(255,255,255,0.7)";
    ctx.font = `${Math.max(9, 12 * z)}px "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(car.name, x, y - 26 * z);
  }
}

// ---- Minimap --------------------------------------------------------------
function drawMinimap() {
  const mw = Math.min(210, sw * 0.22), mh = mw * ((bounds.maxy - bounds.miny) / (bounds.maxx - bounds.minx));
  const mx = 18, my = sh - mh - 18;
  ctx.save();
  ctx.globalAlpha = 0.92;
  ctx.fillStyle = "rgba(8,10,22,0.7)";
  roundRect(mx - 8, my - 8, mw + 16, mh + 16, 12); ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.12)"; ctx.lineWidth = 1; ctx.stroke();
  const sx = mw / (bounds.maxx - bounds.minx), sy = mh / (bounds.maxy - bounds.miny);
  const m = (x, y) => [mx + (x - bounds.minx) * sx, my + (y - bounds.miny) * sy];
  const pts = race.track.pts;
  ctx.beginPath();
  for (let i = 0; i <= pts.length; i++) { const [px, py] = m(pts[i % pts.length][0], pts[i % pts.length][1]); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
  ctx.closePath();
  ctx.strokeStyle = "rgba(255,255,255,0.4)"; ctx.lineWidth = Math.max(3, mw * 0.05); ctx.stroke();
  for (const car of race.cars) {
    const [px, py] = m(car.x, car.y);
    ctx.beginPath(); ctx.arc(px, py, car.isPlayer ? 4 : 3, 0, Math.PI * 2);
    ctx.fillStyle = car.isPlayer ? "#6ce0ff" : car.color; ctx.fill();
  }
  ctx.restore();
}

// ---- HUD / overlays -------------------------------------------------------
function updateHud() {
  const p = race.player;
  el.lap.textContent = Math.min(LAPS, p.laps + 1);
  el.pos.textContent = p.place;
  el.time.textContent = race.time.toFixed(1);
  el.speed.textContent = Math.round(p.speed * 0.22);
  if (race.state === "countdown") {
    el.count.hidden = false;
    el.count.textContent = race.countdown > 0 ? race.countdown : "GO!";
    el.count.className = "count" + (race.countdown > 0 ? "" : " count--go");
  } else {
    el.count.hidden = true;
  }
}

function showResults(place, time) {
  const order = [...race.cars].sort((a, b) => (b.dist - a.dist));
  const ord = ["1st", "2nd", "3rd", "4th"];
  el.resultList.innerHTML = order.map((c, i) =>
    `<li class="${c.isPlayer ? "is-you" : ""}"><span class="rl__pos">${ord[i]}</span>
     <span class="rl__dot" style="background:${c.color}"></span>
     <span class="rl__name">${c.name}</span></li>`).join("");
  el.results.querySelector(".results__head").textContent =
    place === 1 ? "You Win! 🏆" : `You finished ${ord[place - 1]}`;
  el.results.querySelector(".results__time").textContent = `Time ${time.toFixed(1)}s`;
  show(el.results);
}

function reportScore(place, time) {
  const base = { 1: 1000, 2: 600, 3: 350, 4: 150 }[place] || 100;
  const bonus = Math.max(0, Math.round(3000 - time * 8));
  Stats.score(base + bonus);
}

function showStart() { show(el.overlay); }
function show(node) { node.hidden = false; node.classList.remove("is-hidden"); }
function hide(node) { node.classList.add("is-hidden"); setTimeout(() => { node.hidden = true; }, 220); }

// ---- Helpers --------------------------------------------------------------
function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, ((n >> 16) & 255) * f) | 0;
  const g = Math.min(255, ((n >> 8) & 255) * f) | 0;
  const b = Math.min(255, (n & 255) * f) | 0;
  return `rgb(${r},${g},${b})`;
}

// ---- Boot -----------------------------------------------------------------
el.cta.addEventListener("click", onEnter);
// Declare a phone controller layout (hold buttons for smooth driving); a plain
// d-pad still works via the intent fallback in the input handler above.
Controls.define({
  profile: "buttons",
  buttons: [
    { id: "steerL", label: "◀", hold: true },
    { id: "gas", label: "Gas", hold: true },
    { id: "brake", label: "Brake", hold: true },
    { id: "steerR", label: "▶", hold: true },
    { id: "drift", label: "Drift", hold: true },
  ],
});
input.start();
requestAnimationFrame(frame);
