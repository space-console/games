// Imposter for Space Console — entry point.
// Wires input to the pure engine, runs a fixed-dt loop, renders the top-down
// ship (floor, consoles, emergency button, crew + bodies), and drives the
// meeting/voting panel. The engine owns all rules; this file is input + render.
//
// Controls: WASD / arrows move; E / Space "use" (work a task you're standing on,
// report a body, or hit the emergency button). During a meeting, click a crew
// portrait to vote, or Skip.

import {
  Engine, WORLD_W, WORLD_H, WALL, P_R,
} from "./engine.js?v=2372e5f9-2998-4d19-b4c2-053ee870833d";
import { Input } from "../assets/js/shared/input.js?v=2372e5f9-2998-4d19-b4c2-053ee870833d";
import { Sound } from "../assets/js/shared/sound.js?v=2372e5f9-2998-4d19-b4c2-053ee870833d";

const engine = new Engine();
const input = new Input();
const sound = new Sound();

const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");

const els = {
  status: document.getElementById("status"),
  taskFill: document.getElementById("taskFill"),
  alive: document.getElementById("alive"),
  mytasks: document.getElementById("mytasks"),
  role: document.getElementById("role"),
  overlay: document.getElementById("overlay"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlayMsg: document.getElementById("overlayMsg"),
  meeting: document.getElementById("meeting"),
  meetingTitle: document.getElementById("meetingTitle"),
  meetingTimer: document.getElementById("meetingTimer"),
  voteGrid: document.getElementById("voteGrid"),
  voteSkip: document.getElementById("voteSkip"),
  mute: document.getElementById("mute"),
  bUp: document.getElementById("bUp"), bDown: document.getElementById("bDown"),
  bLeft: document.getElementById("bLeft"), bRight: document.getElementById("bRight"),
  bUse: document.getElementById("bUse"),
};

const held = { up: false, down: false, left: false, right: false };
let toast = null;          // { text, sub, age, ttl }

const STEP = 1 / 120;
const MAX_FRAME = 0.05;
let lastTime = 0, acc = 0, animClock = 0;

// ---- Game flow ------------------------------------------------------------
function startGame() {
  sound.resume();
  sound.start();
  held.up = held.down = held.left = held.right = false;
  toast = null;
  engine.start();
  hideMeeting();
  hideOverlay();
  setStatus("Find the Imposter");
  lastTime = performance.now();
  acc = 0;
}

function idleOrOver() { return engine.state === "idle" || engine.state === "over"; }

engine.addEventListener("task", () => sound.lock());
engine.addEventListener("kill", () => { sound.drop(); flash = 0.3; });
engine.addEventListener("meeting", (e) => { sound.levelUp(); openMeeting(e.detail); });
engine.addEventListener("ejected", (e) => {
  const d = e.detail;
  if (d.skipped) toast = { text: "No one was ejected", sub: "(Skipped or tied)", age: 0, ttl: 2.6 };
  else toast = {
    text: `${d.name} was ejected`,
    sub: d.wasImposter ? "…and was The Imposter!" : "…was not the Imposter.",
    age: 0, ttl: 2.8,
  };
  hideMeeting();
});
engine.addEventListener("gameover", (e) => {
  const r = e.detail.result;
  let title, msg;
  if (r === "crew") { title = "Crew Win!"; msg = "The Imposter was defeated. 🎉"; sound.levelUp(); }
  else if (r === "imposter") { title = "Imposter Wins"; msg = "The crew was overwhelmed."; sound.gameOver(); }
  else { title = "You were killed"; msg = "The Imposter got you."; sound.gameOver(); }
  showOverlay(title, msg + "<br>Press <kbd>Enter</kbd> to play again");
  setStatus(title);
});

// ---- Input ----------------------------------------------------------------
input.on((intent) => {
  if (intent === "back") { location.href = "../"; return; }
  if (intent === "enter" && idleOrOver()) startGame();
});

window.addEventListener("keydown", (e) => {
  if (idleOrOver() && (e.key === "Enter" || e.key === " ")) { startGame(); return; }
  switch (e.key) {
    case "ArrowUp": case "w": case "W": held.up = true; e.preventDefault(); break;
    case "ArrowDown": case "s": case "S": held.down = true; e.preventDefault(); break;
    case "ArrowLeft": case "a": case "A": held.left = true; e.preventDefault(); break;
    case "ArrowRight": case "d": case "D": held.right = true; e.preventDefault(); break;
    case "e": case "E": case " ": case "Enter": if (engine.state === "play") engine.action(); break;
  }
});
window.addEventListener("keyup", (e) => {
  switch (e.key) {
    case "ArrowUp": case "w": case "W": held.up = false; break;
    case "ArrowDown": case "s": case "S": held.down = false; break;
    case "ArrowLeft": case "a": case "A": held.left = false; break;
    case "ArrowRight": case "d": case "D": held.right = false; break;
  }
});

canvas.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  if (idleOrOver()) startGame();
  else if (engine.state === "play") engine.action();
});

function hold(el, key) {
  el.addEventListener("pointerdown", (e) => { e.preventDefault(); held[key] = true; });
  el.addEventListener("pointerup", (e) => { e.preventDefault(); held[key] = false; });
  el.addEventListener("pointerleave", () => (held[key] = false));
  el.addEventListener("pointercancel", () => (held[key] = false));
}
hold(els.bUp, "up"); hold(els.bDown, "down"); hold(els.bLeft, "left"); hold(els.bRight, "right");
els.bUse.addEventListener("pointerdown", (e) => { e.preventDefault(); if (engine.state === "play") engine.action(); });

// ---- Meeting UI -----------------------------------------------------------
function openMeeting(detail) {
  els.meetingTitle.textContent = detail.cause === "button" ? "Emergency Meeting" : "Body Reported";
  els.voteGrid.innerHTML = "";
  for (const p of engine.players) {
    if (!p.alive || p.human) continue;     // you can't vote yourself
    const b = document.createElement("button");
    b.className = "vote";
    b.setAttribute("data-touch-ignore", "");
    b.innerHTML = `<span class="vote__dot" style="background:${p.hex}"></span><span>${p.name}</span>`;
    b.addEventListener("pointerdown", (ev) => { ev.preventDefault(); engine.castVote(p.id); });
    els.voteGrid.appendChild(b);
  }
  els.meeting.classList.remove("meeting--hidden");
}
function hideMeeting() { els.meeting.classList.add("meeting--hidden"); }
els.voteSkip.addEventListener("pointerdown", (e) => { e.preventDefault(); engine.castVote("skip"); });

// ---- Loop -----------------------------------------------------------------
let flash = 0;
function loop(now) {
  let frame = (now - lastTime) / 1000;
  lastTime = now;
  if (frame > MAX_FRAME) frame = MAX_FRAME;
  animClock += frame;

  engine.setMove((held.right ? 1 : 0) - (held.left ? 1 : 0), (held.down ? 1 : 0) - (held.up ? 1 : 0));
  acc += frame;
  while (acc >= STEP) { engine.step(STEP); acc -= STEP; }

  if (flash > 0) flash = Math.max(0, flash - frame);
  if (toast) { toast.age += frame; if (toast.age >= toast.ttl) toast = null; }
  if (engine.state === "meeting") els.meetingTimer.textContent = Math.ceil(engine.meeting.timer);

  draw();
  requestAnimationFrame(loop);
}

// ---- Rendering ------------------------------------------------------------
let scaleX = 1, scaleY = 1;

function draw() {
  // HUD.
  els.taskFill.style.width = Math.round(engine.progress * 100) + "%";
  els.alive.textContent = engine.players.filter((p) => p.alive).length;
  if (engine.human && engine.human.tasks) {
    const done = engine.human.tasks.filter((t) => t.done).length;
    els.mytasks.textContent = `${done}/${engine.human.tasks.length}`;
  }

  ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
  drawRoom();
  drawStations();
  drawButton();
  drawBodies();
  drawPlayers();
  drawPrompts();
  if (flash > 0) { ctx.fillStyle = `rgba(255,40,40,${flash})`; ctx.fillRect(0, 0, WORLD_W, WORLD_H); }
  drawToast();
}

function drawRoom() {
  ctx.fillStyle = "#11162b";
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);
  // Floor.
  ctx.fillStyle = "#1b2444";
  ctx.fillRect(WALL, WALL, WORLD_W - WALL * 2, WORLD_H - WALL * 2);
  // Floor tile grid.
  ctx.strokeStyle = "rgba(255,255,255,0.04)";
  ctx.lineWidth = 1;
  for (let x = WALL; x <= WORLD_W - WALL; x += 40) { ctx.beginPath(); ctx.moveTo(x, WALL); ctx.lineTo(x, WORLD_H - WALL); ctx.stroke(); }
  for (let y = WALL; y <= WORLD_H - WALL; y += 40) { ctx.beginPath(); ctx.moveTo(WALL, y); ctx.lineTo(WORLD_W - WALL, y); ctx.stroke(); }
  // Walls.
  ctx.fillStyle = "#2c3766";
  ctx.fillRect(0, 0, WORLD_W, WALL);
  ctx.fillRect(0, WORLD_H - WALL, WORLD_W, WALL);
  ctx.fillRect(0, 0, WALL, WORLD_H);
  ctx.fillRect(WORLD_W - WALL, 0, WALL, WORLD_H);
  ctx.fillStyle = "#3a4a86";
  ctx.fillRect(WALL - 3, WALL - 3, WORLD_W - 2 * (WALL - 3), 3);
}

function drawStations() {
  const tasks = engine.human && engine.human.tasks ? engine.human.tasks : [];
  for (const s of engine.stations) {
    // Console base.
    ctx.fillStyle = "#33406e";
    roundRect(s.x - 17, s.y - 13, 34, 26, 5);
    ctx.fillStyle = "#0f1530";
    roundRect(s.x - 13, s.y - 9, 26, 13, 3);
    ctx.fillStyle = "#5fd6ff";
    for (let i = 0; i < 3; i++) { ctx.fillRect(s.x - 10 + i * 8, s.y - 6, 5, 6); }
    ctx.fillStyle = "#cdd6ff";
    ctx.fillRect(s.x - 13, s.y + 6, 26, 3);

    // Highlight your tasks.
    const t = tasks.find((t) => t.station === s.id);
    if (t) {
      if (t.done) {
        ctx.strokeStyle = "#46e07a"; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(s.x - 6, s.y - 18); ctx.lineTo(s.x - 1, s.y - 13); ctx.lineTo(s.x + 8, s.y - 24); ctx.stroke();
      } else {
        const pulse = 0.5 + Math.abs(Math.sin(animClock * 4)) * 0.5;
        ctx.strokeStyle = `rgba(255,210,63,${pulse})`; ctx.lineWidth = 3;
        roundRectStroke(s.x - 21, s.y - 19, 42, 38, 8);
        ctx.fillStyle = "#ffd23f"; ctx.beginPath(); ctx.arc(s.x, s.y - 24, 4, 0, Math.PI * 2); ctx.fill();
      }
    }
  }
}

function drawButton() {
  const b = engine.button;
  ctx.fillStyle = "#3a2330";
  ctx.beginPath(); ctx.arc(b.x, b.y, 22, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#ff4d4d";
  ctx.beginPath(); ctx.arc(b.x, b.y, 15, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#ff8a8a";
  ctx.beginPath(); ctx.arc(b.x - 4, b.y - 4, 5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#fff"; ctx.font = "bold 9px 'Segoe UI',sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("!", b.x, b.y + 1);
  ctx.textAlign = "left";
}

function drawBodies() {
  for (const b of engine.bodies) {
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.beginPath(); ctx.ellipse(0, 8, 18, 6, 0, 0, Math.PI * 2); ctx.fill();
    // Slumped (lying) crewmate.
    ctx.fillStyle = b.hex;
    roundRect(-16, -4, 30, 16, 8);
    ctx.fillStyle = "#bfe9ff";
    roundRect(2, -1, 12, 8, 4);
    ctx.strokeStyle = "#1a2233"; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(6, 1); ctx.lineTo(9, 4); ctx.moveTo(9, 1); ctx.lineTo(6, 4); ctx.stroke(); // x eye
    ctx.restore();
  }
}

function drawPlayers() {
  // Sort by y so lower crew overlap correctly.
  const order = engine.players.filter((p) => p.alive).sort((a, b) => a.y - b.y);
  for (const p of order) drawAstronaut(p);
}

// An original little astronaut: rounded body, a backpack, a glassy visor that
// faces the move direction, and stubby legs.
function drawAstronaut(p) {
  const x = p.x, y = p.y, f = p.dir;
  const bob = p.moving ? Math.sin(animClock * 12 + p.id) * 1.4 : 0;

  ctx.save();
  ctx.translate(x, y + bob);

  // Shadow.
  ctx.fillStyle = "rgba(0,0,0,0.28)";
  ctx.beginPath(); ctx.ellipse(0, 16, 13, 4.5, 0, 0, Math.PI * 2); ctx.fill();

  // Legs.
  ctx.fillStyle = shade(p.hex, -28);
  const stride = p.moving ? Math.sin(animClock * 12 + p.id) * 3 : 0;
  roundRect(-7 + stride, 10, 6, 7, 2);
  roundRect(1 - stride, 10, 6, 7, 2);

  // Backpack (behind, opposite facing).
  ctx.fillStyle = shade(p.hex, -34);
  roundRect(f > 0 ? -16 : 6, -8, 10, 18, 5);

  // Body.
  const g = ctx.createLinearGradient(0, -16, 0, 14);
  g.addColorStop(0, shade(p.hex, 22));
  g.addColorStop(1, shade(p.hex, -10));
  ctx.fillStyle = g;
  roundRect(-11, -16, 22, 28, 10);
  ctx.strokeStyle = "rgba(0,0,0,0.3)"; ctx.lineWidth = 1.4;
  roundRectStroke(-11, -16, 22, 28, 10);

  // Visor.
  ctx.fillStyle = "#0d1830";
  roundRect(f > 0 ? -3 : -11, -11, 16, 10, 5);
  const vg = ctx.createLinearGradient(0, -11, 0, -1);
  vg.addColorStop(0, "#cdeeff"); vg.addColorStop(1, "#74b8e6");
  ctx.fillStyle = vg;
  roundRect(f > 0 ? -1 : -9, -9, 12, 6, 3);
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  roundRect(f > 0 ? 5 : -7, -8.5, 3, 3, 1.5);

  ctx.restore();

  // Name tag.
  ctx.font = "bold 10px 'Segoe UI',sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  const tw = ctx.measureText(p.name).width;
  roundRect(x - tw / 2 - 4, y - 34, tw + 8, 14, 4);
  ctx.fillStyle = p.human ? "#9fe8ff" : "#fff";
  ctx.fillText(p.name, x, y - 27);
  ctx.textAlign = "left";
}

// Contextual prompts + the task-in-progress ring around the human.
function drawPrompts() {
  const h = engine.human;
  if (!h || !h.alive || engine.state !== "play") return;

  // Task progress ring (you must stand still on a task station).
  if (engine.doing > 0) {
    ctx.strokeStyle = "#ffd23f"; ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(h.x, h.y, P_R + 9, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (engine.doing / 1.1));
    ctx.stroke();
  }

  let prompt = null;
  for (const b of engine.bodies) if (Math.hypot(h.x - b.x, h.y - b.y) <= 34) prompt = "REPORT";
  if (!prompt && Math.hypot(h.x - engine.button.x, h.y - engine.button.y) <= 34) prompt = "EMERGENCY";
  if (!prompt) {
    const t = (h.tasks || []).find((t) => !t.done && Math.hypot(h.x - engine.stations[t.station].x, h.y - engine.stations[t.station].y) <= 30);
    if (t && !h.moving && engine.doing === 0) prompt = "USE";
    else if (t && h.moving) prompt = "stop to USE";
  }
  if (prompt) {
    ctx.font = "bold 11px 'Segoe UI',sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const tw = ctx.measureText(prompt).width;
    ctx.fillStyle = "rgba(20,200,120,0.9)";
    roundRect(h.x - tw / 2 - 7, h.y - 50, tw + 14, 18, 6);
    ctx.fillStyle = "#fff";
    ctx.fillText(prompt, h.x, h.y - 41);
    ctx.textAlign = "left";
  }
}

function drawToast() {
  if (!toast) return;
  const a = toast.age < 0.2 ? toast.age / 0.2 : (1 - Math.max(0, (toast.age - (toast.ttl - 0.4)) / 0.4));
  ctx.globalAlpha = Math.max(0, Math.min(1, a));
  ctx.fillStyle = "rgba(5,8,20,0.85)";
  roundRect(WORLD_W / 2 - 170, WORLD_H / 2 - 34, 340, 68, 10);
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillStyle = "#fff"; ctx.font = "bold 20px 'Segoe UI',sans-serif";
  ctx.fillText(toast.text, WORLD_W / 2, WORLD_H / 2 - 8);
  ctx.fillStyle = "#9aa3c7"; ctx.font = "14px 'Segoe UI',sans-serif";
  ctx.fillText(toast.sub, WORLD_W / 2, WORLD_H / 2 + 14);
  ctx.textAlign = "left";
  ctx.globalAlpha = 1;
}

// ---- Canvas helpers -------------------------------------------------------
function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) + amt, g = ((n >> 8) & 255) + amt, b = (n & 255) + amt;
  r = Math.max(0, Math.min(255, r)); g = Math.max(0, Math.min(255, g)); b = Math.max(0, Math.min(255, b));
  return `rgb(${r},${g},${b})`;
}
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
function roundRectStroke(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath(); ctx.stroke();
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

function showOverlay(title, msg) {
  els.overlayTitle.textContent = title;
  els.overlayMsg.innerHTML = msg;
  els.overlay.classList.remove("overlay--hidden");
}
function hideOverlay() { els.overlay.classList.add("overlay--hidden"); }
function setStatus(t) { els.status.textContent = t; }

function renderMute() { els.mute.textContent = sound.muted ? "🔇" : "🔊"; els.mute.setAttribute("aria-pressed", String(sound.muted)); }
function toggleMute() { sound.toggleMute(); renderMute(); }

function boot() {
  input.start();
  els.mute.addEventListener("click", toggleMute);
  window.addEventListener("keydown", (e) => { if (e.key === "m" || e.key === "M") toggleMute(); });
  window.addEventListener("resize", resize);
  resize();
  showOverlay("Imposter", "Finish your tasks — but one crewmate is the Imposter. Call meetings and vote them out!<br>Press <kbd>Enter</kbd> to start");
  lastTime = performance.now();
  requestAnimationFrame(loop);
}

boot();
