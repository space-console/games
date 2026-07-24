// Imposter — the pure game core for a single-player social-deduction round. No
// DOM, no rendering, no input: it owns the crew (you + AI), free movement on a
// walled map, the task list + crew task progress, the imposter AI (isolate a
// victim, kill on cooldown when unwitnessed, leave a body), body reporting + the
// emergency button, the meeting/voting phase, and the win/lose checks. app.js
// drives it from input + a fixed-dt loop and renders its state.
//
// You are always a crewmate (player 0); one of the AI is the imposter. Win by
// finishing all crew tasks or voting out the imposter; lose if the imposter is
// killed... err — lose if the imposter kills enough crew (or kills you).
//
// Deterministic given a seed (roles, spawns, AI choices flow through an injected
// RNG), so a run is reproducible / self-test-able without a DOM.

export const WORLD_W = 680;
export const WORLD_H = 460;
export const WALL = 18;                       // border thickness
export const P_R = 12;                        // crew body radius

const SPEED = 122;                            // your move speed (units/s)
const AI_SPEED = 104;
const KILL_R = 22;                            // imposter must be this close to kill
const KILL_CD = 22;                           // seconds between kills
const KILL_GRACE = 10;                        // cooldown at round/meeting start
const WITNESS_R = 135;                        // a kill within this of another crew is seen
const TASK_R = 30;                            // how close to a station to work it
const TASK_TIME = 1.1;                        // seconds to complete one task
const TASKS_EACH = 4;                         // tasks per crewmate
const REPORT_R = 34;                          // how close to a body to report it
const BUTTON_R = 34;                          // how close to the emergency button
const MEETING_TIME = 16;                      // discussion/vote seconds
const AI_TASK_MIN = 5, AI_TASK_MAX = 11;      // AI crew finish a task every N seconds

export const COLORS = [
  { id: "cyan", hex: "#3fd6e0" },
  { id: "red", hex: "#ff5a5a" },
  { id: "blue", hex: "#4f7bff" },
  { id: "green", hex: "#46e07a" },
  { id: "yellow", hex: "#ffd23f" },
  { id: "purple", hex: "#b14bff" },
  { id: "orange", hex: "#ff9a3c" },
  { id: "pink", hex: "#ff7ac0" },
];
export const NAMES = ["You", "Red", "Blue", "Green", "Yellow", "Purple", "Orange", "Pink"];

export function makeRng(seed = 1) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Engine extends EventTarget {
  constructor(rng = makeRng((Math.random() * 1e9) | 0)) {
    super();
    this.rng = rng;
    this.reset();
  }

  reset() {
    this.numPlayers = 6;
    this.state = "idle";          // idle | play | meeting | over
    this.players = [];
    this.bodies = [];
    this.stations = this._makeStations();
    this.button = { x: WORLD_W / 2, y: WORLD_H / 2 };
    this.taskTotal = 0;
    this.taskDone = 0;
    this.killCd = KILL_GRACE;
    this.meeting = null;
    this.result = null;           // 'crew' | 'imposter' | 'dead'
    this.humanSaw = null;         // imposter id the human witnessed killing, or null
    this.doing = 0;               // human task-in-progress timer
    this.moveX = 0; this.moveY = 0; // human intent each frame
  }

  _makeStations() {
    // Eight consoles spread around the room (decor + task targets).
    const m = 64;
    const xs = [m, WORLD_W / 2, WORLD_W - m];
    const ys = [m, WORLD_H - m];
    const pts = [];
    for (const y of ys) for (const x of xs) pts.push({ x, y });
    pts.push({ x: m, y: WORLD_H / 2 }, { x: WORLD_W - m, y: WORLD_H / 2 });
    return pts.map((p, i) => ({ id: i, x: p.x, y: p.y }));
  }

  start() {
    this.reset();
    const N = this.numPlayers;
    const imposter = 1 + Math.floor(this.rng() * (N - 1));   // never the human
    const crewCount = N - 1;
    this.taskTotal = crewCount * TASKS_EACH;
    this.taskDone = 0;

    // Spawn in a ring around the button.
    for (let i = 0; i < N; i++) {
      const ang = (i / N) * Math.PI * 2;
      const c = COLORS[i];
      this.players.push({
        id: i, name: NAMES[i], color: c.id, hex: c.hex,
        x: WORLD_W / 2 + Math.cos(ang) * 70,
        y: WORLD_H / 2 + Math.sin(ang) * 70,
        dir: 1, moving: false,
        alive: true,
        imposter: i === imposter,
        human: i === 0,
        // AI bits:
        goal: null, dwell: 0, taskTimer: rand(this.rng, AI_TASK_MIN, AI_TASK_MAX), tasksLeft: TASKS_EACH,
        suspect: null,
        // human task list: which stations you must work.
        tasks: i === 0 ? this._pickTasks() : null,
      });
    }
    this.state = "play";
  }

  _pickTasks() {
    const ids = this.stations.map((s) => s.id);
    shuffle(ids, this.rng);
    return ids.slice(0, TASKS_EACH).map((sid) => ({ station: sid, done: false }));
  }

  get human() { return this.players[0]; }
  aliveImposters() { return this.players.filter((p) => p.alive && p.imposter).length; }
  aliveCrew() { return this.players.filter((p) => p.alive && !p.imposter).length; }
  get progress() { return this.taskTotal ? this.taskDone / this.taskTotal : 0; }

  setMove(x, y) { this.moveX = x; this.moveY = y; }

  // The human's context action: report an adjacent body, press the emergency
  // button, or work a nearby unfinished task. Returns what happened.
  action() {
    if (this.state !== "play") return null;
    const h = this.human;
    if (!h.alive) return null;

    // Report a body in reach.
    for (const b of this.bodies) {
      if (dist(h, b) <= REPORT_R) { this._startMeeting(0, "report"); return "report"; }
    }
    // Emergency button.
    if (dist(h, this.button) <= BUTTON_R) { this._startMeeting(0, "button"); return "button"; }
    return null;
  }

  // ---- Simulation ---------------------------------------------------------
  step(dt) {
    if (this.state === "meeting") {
      this.meeting.timer -= dt;
      if (this.meeting.timer <= 0) this._resolveMeeting();
      return;
    }
    if (this.state !== "play") return;

    this.killCd = Math.max(0, this.killCd - dt);

    // Human movement.
    const h = this.human;
    if (h.alive) {
      const len = Math.hypot(this.moveX, this.moveY) || 1;
      const mv = Math.hypot(this.moveX, this.moveY) > 0.01;
      h.moving = mv;
      if (mv) { h.dir = this.moveX < 0 ? -1 : this.moveX > 0 ? 1 : h.dir; }
      this._moveBy(h, (this.moveX / len) * SPEED * dt, (this.moveY / len) * SPEED * dt);

      // Work a task you're standing on.
      const t = h.tasks.find((t) => !t.done && dist(h, this.stations[t.station]) <= TASK_R);
      if (t && mv === false) {
        this.doing += dt;
        if (this.doing >= TASK_TIME) { t.done = true; this.doing = 0; this._completeTask(); }
      } else {
        this.doing = 0;
      }
    }

    // AI.
    for (const p of this.players) {
      if (!p.alive || p.human) continue;
      if (p.imposter) this._aiImposter(p, dt);
      else this._aiCrew(p, dt);
    }

    this._checkWin();
  }

  _completeTask() {
    this.taskDone += 1;
    this.dispatchEvent(new CustomEvent("task", { detail: { done: this.taskDone, total: this.taskTotal } }));
  }

  // Crew AI: wander between random points; auto-finish tasks on a timer; report
  // a body if they wander onto one.
  _aiCrew(p, dt) {
    this._wander(p, dt, AI_SPEED);
    if (p.tasksLeft > 0) {
      p.taskTimer -= dt;
      if (p.taskTimer <= 0) { p.tasksLeft -= 1; p.taskTimer = rand(this.rng, AI_TASK_MIN, AI_TASK_MAX); this._completeTask(); }
    }
    for (const b of this.bodies) {
      if (dist(p, b) <= REPORT_R) { this._startMeeting(p.id, "report"); return; }
    }
  }

  // Imposter AI: stalk the nearest crew; kill when close, off cooldown, and no
  // other crewmate is within witness range; otherwise behave like crew.
  _aiImposter(p, dt) {
    let target = null, best = Infinity;
    for (const q of this.players) {
      if (!q.alive || q.imposter) continue;
      const d = dist(p, q);
      if (d < best) { best = d; target = q; }
    }
    if (target && best > KILL_R) {
      p.goal = { x: target.x, y: target.y };
      this._stepToGoal(p, dt, AI_SPEED);
    } else {
      this._wander(p, dt, AI_SPEED);
    }

    if (target && best <= KILL_R && this.killCd <= 0) {
      // Witnesses = any other living crew near the kill spot.
      let witnessed = false;
      for (const q of this.players) {
        if (!q.alive || q.imposter || q === target) continue;
        if (dist(p, q) <= WITNESS_R) {
          witnessed = true;
          if (q.human) this.humanSaw = p.id; else q.suspect = p.id;
        }
      }
      if (!witnessed) this._kill(p, target);
    }
  }

  _kill(imp, victim) {
    victim.alive = false;
    this.bodies.push({ x: victim.x, y: victim.y, hex: victim.hex, color: victim.color });
    this.killCd = KILL_CD;
    this.dispatchEvent(new CustomEvent("kill", { detail: { victim: victim.id, human: victim.human } }));
    if (victim.human) { this.result = "dead"; this.state = "over"; this.dispatchEvent(new CustomEvent("gameover", { detail: { result: this.result } })); }
  }

  _wander(p, dt, speed) {
    if (p.dwell > 0) { p.dwell -= dt; p.moving = false; return; }
    if (!p.goal || dist(p, p.goal) < 8) {
      p.goal = { x: rand(this.rng, WALL + 24, WORLD_W - WALL - 24), y: rand(this.rng, WALL + 24, WORLD_H - WALL - 24) };
      if (this.rng() < 0.3) { p.dwell = rand(this.rng, 0.4, 1.4); return; }
    }
    this._stepToGoal(p, dt, speed);
  }

  _stepToGoal(p, dt, speed) {
    const dx = p.goal.x - p.x, dy = p.goal.y - p.y;
    const len = Math.hypot(dx, dy) || 1;
    if (dx < -1) p.dir = -1; else if (dx > 1) p.dir = 1;
    p.moving = true;
    this._moveBy(p, (dx / len) * speed * dt, (dy / len) * speed * dt);
  }

  // Move with simple wall clamping (border-only map → no pathfinding needed).
  _moveBy(p, dx, dy) {
    p.x = clamp(p.x + dx, WALL + P_R, WORLD_W - WALL - P_R);
    p.y = clamp(p.y + dy, WALL + P_R, WORLD_H - WALL - P_R);
  }

  // ---- Meetings / voting --------------------------------------------------
  _startMeeting(reporter, cause) {
    this.bodies = [];
    this.state = "meeting";
    const alive = this.players.filter((p) => p.alive).map((p) => p.id);
    this.meeting = { reporter, cause, timer: MEETING_TIME, alive, votes: {}, resolved: false };
    // AI lock in their votes immediately (revealed at resolve).
    for (const p of this.players) {
      if (p.alive && !p.human) this.meeting.votes[p.id] = this._aiVote(p);
    }
    this.dispatchEvent(new CustomEvent("meeting", { detail: { reporter, cause } }));
  }

  _aiVote(p) {
    const alive = this.meeting.alive.filter((id) => id !== p.id);
    if (p.imposter) {
      // Frame a random crewmate (never another imposter — there's only one here).
      const crew = alive.filter((id) => !this.players[id].imposter);
      return crew.length && this.rng() < 0.8 ? pick(this.rng, crew) : "skip";
    }
    // Crew: vote a witnessed suspect if alive, else mostly skip / sometimes guess.
    if (p.suspect != null && this.players[p.suspect].alive) return p.suspect;
    if (this.rng() < 0.45) return pick(this.rng, alive);
    return "skip";
  }

  // The human casts their vote, which resolves the meeting.
  castVote(target) {
    if (this.state !== "meeting" || this.meeting.resolved) return;
    this.meeting.votes[0] = target;       // 'skip' or a player id
    this._resolveMeeting();
  }

  _resolveMeeting() {
    if (this.meeting.resolved) return;
    this.meeting.resolved = true;
    const tally = {};
    for (const id of Object.keys(this.meeting.votes)) {
      const v = this.meeting.votes[id];
      const key = v === "skip" ? "skip" : String(v);
      tally[key] = (tally[key] || 0) + 1;
    }
    // Highest vote wins; a tie (including with "skip") ejects nobody.
    let top = null, topN = -1, tie = false;
    for (const k of Object.keys(tally)) {
      if (tally[k] > topN) { top = k; topN = tally[k]; tie = false; }
      else if (tally[k] === topN) tie = true;
    }
    let ejected = null;
    if (!tie && top && top !== "skip") {
      const id = Number(top);
      this.players[id].alive = false;
      ejected = id;
    }

    // Clear per-round witness memory and reset kill cooldown.
    this.humanSaw = null;
    for (const p of this.players) p.suspect = null;
    this.killCd = KILL_GRACE;
    this.bodies = [];

    this.dispatchEvent(new CustomEvent("ejected", {
      detail: ejected == null
        ? { skipped: true, tally }
        : { id: ejected, name: this.players[ejected].name, wasImposter: this.players[ejected].imposter, tally },
    }));

    this.state = "play";
    this.meeting = null;
    this._checkWin();
  }

  _checkWin() {
    if (this.state === "over") return;
    if (!this.human.alive) { this._end("dead"); return; }
    if (this.aliveImposters() === 0) { this._end("crew"); return; }
    if (this.progress >= 1) { this._end("crew"); return; }
    if (this.aliveImposters() >= this.aliveCrew()) { this._end("imposter"); return; }
  }

  _end(result) {
    this.result = result;
    this.state = "over";
    this.dispatchEvent(new CustomEvent("gameover", { detail: { result } }));
  }
}

// ---- helpers --------------------------------------------------------------
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function rand(rng, lo, hi) { return lo + rng() * (hi - lo); }
function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}
