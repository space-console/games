// Bubble Trouble engine — the pure game core. No DOM, no rendering, no input:
// it owns one or two players, the bouncing balls, the harpoons, per-player
// lives/score/level, the per-level timer, and all the rules (ball physics +
// wall/floor bounces, the harpoon's vertical cut, splitting a hit ball into two
// smaller ones, popping the smallest, getting hit → lose a life + respawn, and
// level progression). app.js drives it from input + a fixed-dt accumulator and
// renders it.
//
// Two-player is co-operative: both players share the bubble field and the score
// but each has their own lives. A hit costs that player a life and a brief
// invulnerable respawn; the other keeps playing. The game ends only when every
// player is out of lives. (Single-player is just the one-player case.)
//
// Deterministic by construction: step() takes the elapsed time (dt, seconds);
// the only randomness is cosmetic and flows through an injected RNG, so a given
// seed always produces the same run (self-test-able without a DOM).

// ---- World ----------------------------------------------------------------
export const WORLD_W = 640;
export const WORLD_H = 480;

export const WALL = 12;
export const PLAY_L = WALL;
export const PLAY_R = WORLD_W - WALL;
export const FLOOR_H = 40;
export const FLOOR_Y = WORLD_H - FLOOR_H;
export const CEIL_Y = 0;

// ---- Player ---------------------------------------------------------------
export const PLAYER_W = 38;
export const PLAYER_H = 52;
const PLAYER_SPEED = 285;
const HIT_INSET_X = 9;
const HIT_INSET_Y = 8;

// ---- Harpoon --------------------------------------------------------------
const HARPOON_SPEED = 640;
export const MAX_HARPOONS = 1;          // per player: one rope out at a time

// ---- Balls ----------------------------------------------------------------
export const BALL_R = [13, 20, 30, 44];
const GRAVITY = 520;
const BOUNCE_PEAK = [150, 215, 290, 360];
const BOUNCE_V = BOUNCE_PEAK.map((h) => Math.sqrt(2 * GRAVITY * h));
const BALL_VX = [122, 106, 92, 80];
const SPLIT_UP = 0.62;
const POINTS = [60, 40, 30, 20];

// Interlude / respawn timings (seconds).
const CLEAR_PAUSE = 1.4;
const READY_PAUSE = 0.9;
const RESPAWN_PAUSE = 1.4;              // invulnerable blink after a hit

const START_LIVES = 3;
const LEVEL_TIME = 60;

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

function buildLevel(n) {
  const presets = [
    [{ size: 3, x: 0.50, dir: 1 }],
    [{ size: 2, x: 0.30, dir: -1 }, { size: 2, x: 0.70, dir: 1 }],
    [{ size: 3, x: 0.50, dir: 1 }, { size: 1, x: 0.20, dir: -1 }, { size: 1, x: 0.80, dir: 1 }],
    [{ size: 3, x: 0.28, dir: 1 }, { size: 3, x: 0.72, dir: -1 }],
    [{ size: 2, x: 0.22, dir: 1 }, { size: 2, x: 0.50, dir: -1 }, { size: 2, x: 0.78, dir: 1 }],
    [{ size: 3, x: 0.30, dir: 1 }, { size: 3, x: 0.70, dir: -1 }, { size: 1, x: 0.50, dir: 1 }],
  ];

  let spec;
  if (n < presets.length) {
    spec = presets[n];
  } else {
    spec = [];
    const big = 2 + Math.floor((n - presets.length) / 2);
    for (let i = 0; i < big; i++) spec.push({ size: 3, x: (i + 1) / (big + 1), dir: i % 2 ? 1 : -1 });
    if (n % 2) spec.push({ size: 2, x: 0.5, dir: 1 });
  }

  return spec.map((s) => ({
    size: s.size, r: BALL_R[s.size],
    x: s.x * WORLD_W, y: 130,
    vx: BALL_VX[s.size] * s.dir, vy: 0,
  }));
}

export class Engine extends EventTarget {
  constructor(rng = makeRng(1)) {
    super();
    this.rng = rng;
    this.reset();
  }

  reset() {
    this.numPlayers = 1;
    this.level = 0;
    this.score = 0;
    this.players = [];
    this.balls = [];
    this.harpoons = [];
    this.timeLeft = this.levelTime = LEVEL_TIME;
    this.state = "idle";          // idle | ready | playing | clear | over
    this.freeze = 0;
  }

  _spawnX(id) {
    if (this.numPlayers <= 1) return WORLD_W / 2;
    return id === 0 ? WORLD_W * 0.30 : WORLD_W * 0.70;
  }

  _makePlayer(id) {
    return {
      id,
      x: this._spawnX(id),
      facing: id === 1 ? -1 : 1,
      bob: 0,
      lives: START_LIVES,
      out: false,
      cooldown: 0,     // >0 = invulnerable respawn (frozen, blinking)
      moveDir: 0,      // set by app each frame
    };
  }

  // Begin a fresh game with 1 or 2 players.
  start(numPlayers = 1) {
    this.numPlayers = Math.max(1, Math.min(2, numPlayers));
    this.level = 0;
    this.score = 0;
    this.players = [];
    for (let i = 0; i < this.numPlayers; i++) this.players.push(this._makePlayer(i));
    this._loadLevel(0);
    this.state = "ready";
    this.freeze = READY_PAUSE;
    this.dispatchEvent(new CustomEvent("levelstart", { detail: { level: this.level } }));
  }

  _loadLevel(n) {
    this.balls = buildLevel(n);
    this.harpoons = [];
    this.timeLeft = this.levelTime = LEVEL_TIME;
    for (const p of this.players) {
      if (p.out) continue;
      p.x = this._spawnX(p.id);
      p.facing = p.id === 1 ? -1 : 1;
      p.cooldown = 0;
      p.moveDir = 0;
    }
  }

  // Fire player `id`'s harpoon, if they're active and have a free slot.
  fire(id = 0) {
    if (this.state !== "playing") return false;
    const p = this.players[id];
    if (!p || p.out || p.cooldown > 0) return false;
    if (this.harpoons.filter((h) => h.owner === id).length >= MAX_HARPOONS) return false;
    this.harpoons.push({ x: p.x, tipY: FLOOR_Y - 6, owner: id });
    this.dispatchEvent(new CustomEvent("shoot", { detail: { id } }));
    return true;
  }

  step(dt) {
    if (this.state === "ready" || this.state === "clear") {
      this.freeze -= dt;
      if (this.freeze <= 0) this._endInterlude();
      return;
    }
    if (this.state !== "playing") return;

    // --- Timer. On timeout, every active player loses a life; clock resets. ---
    this.timeLeft -= dt;
    if (this.timeLeft <= 0) {
      for (const p of this.players) if (!p.out && p.cooldown <= 0) this._hitPlayer(p, "time");
      this.timeLeft = this.levelTime;
      if (this._allOut()) return this._gameOver();
    }

    // --- Players: tick respawn cooldown, else move (clamped to walls). ---
    for (const p of this.players) {
      if (p.out) continue;
      if (p.cooldown > 0) { p.cooldown -= dt; p.bob = 0; continue; }
      if (p.moveDir) p.facing = p.moveDir;
      p.x += p.moveDir * PLAYER_SPEED * dt;
      const half = PLAYER_W / 2;
      if (p.x < PLAY_L + half) p.x = PLAY_L + half;
      if (p.x > PLAY_R - half) p.x = PLAY_R - half;
      p.bob = p.moveDir ? p.bob + dt * 14 : 0;
    }

    // --- Harpoons rise; retire those that reach the ceiling. ---
    for (const h of this.harpoons) h.tipY -= HARPOON_SPEED * dt;
    this.harpoons = this.harpoons.filter((h) => {
      if (h.tipY <= CEIL_Y) { this.dispatchEvent(new CustomEvent("rope")); return false; }
      return true;
    });

    // --- Ball physics: gravity, integrate, bounce off walls/floor/ceiling. ---
    for (const b of this.balls) {
      b.vy += GRAVITY * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (b.x - b.r < PLAY_L) { b.x = PLAY_L + b.r; b.vx = Math.abs(b.vx); }
      if (b.x + b.r > PLAY_R) { b.x = PLAY_R - b.r; b.vx = -Math.abs(b.vx); }
      if (b.y + b.r >= FLOOR_Y) { b.y = FLOOR_Y - b.r; b.vy = -BOUNCE_V[b.size]; }
      if (b.y - b.r < CEIL_Y) { b.y = CEIL_Y + b.r; b.vy = Math.abs(b.vy); }
    }

    // --- Harpoon hits: a rope cuts any ball overlapping its vertical column. ---
    const hits = [];
    for (const h of this.harpoons) {
      for (const b of this.balls) {
        if (Math.abs(b.x - h.x) <= b.r && b.y + b.r >= h.tipY) { hits.push({ h, b }); break; }
      }
    }
    if (hits.length) {
      const usedH = new Set();
      for (const { h, b } of hits) {
        if (usedH.has(h) || !this.balls.includes(b)) continue;
        usedH.add(h);
        this._splitBall(b);
      }
      this.harpoons = this.harpoons.filter((h) => !usedH.has(h));
    }

    // --- Death: a ball touching an active, non-invulnerable player. ---
    for (const p of this.players) {
      if (p.out || p.cooldown > 0) continue;
      const px = p.x - PLAYER_W / 2 + HIT_INSET_X;
      const py = FLOOR_Y - PLAYER_H + HIT_INSET_Y;
      const pw = PLAYER_W - HIT_INSET_X * 2;
      const ph = PLAYER_H - HIT_INSET_Y;
      for (const b of this.balls) {
        if (circleHitsRect(b.x, b.y, b.r, px, py, pw, ph)) { this._hitPlayer(p, "hit"); break; }
      }
    }
    if (this._allOut()) return this._gameOver();

    // --- Level cleared. ---
    if (this.balls.length === 0) {
      this.state = "clear";
      this.freeze = CLEAR_PAUSE;
      this.dispatchEvent(new CustomEvent("levelclear", { detail: { level: this.level } }));
    }
  }

  _splitBall(b) {
    const i = this.balls.indexOf(b);
    if (i === -1) return;
    this.balls.splice(i, 1);
    this.score += POINTS[b.size];
    this.dispatchEvent(new CustomEvent("pop", { detail: { size: b.size } }));
    if (b.size > 0) {
      const ns = b.size - 1;
      const up = -BOUNCE_V[ns] * SPLIT_UP;
      for (const dir of [-1, 1]) {
        this.balls.push({ size: ns, r: BALL_R[ns], x: b.x, y: b.y, vx: BALL_VX[ns] * dir, vy: up });
      }
      this.dispatchEvent(new CustomEvent("split", { detail: { size: ns } }));
    }
  }

  _hitPlayer(p, cause) {
    p.lives -= 1;
    this.harpoons = this.harpoons.filter((h) => h.owner !== p.id);
    this.dispatchEvent(new CustomEvent("die", { detail: { id: p.id, cause, lives: p.lives } }));
    if (p.lives <= 0) {
      p.out = true;
    } else {
      p.cooldown = RESPAWN_PAUSE;
      p.x = this._spawnX(p.id);
      p.facing = p.id === 1 ? -1 : 1;
      p.moveDir = 0;
    }
  }

  _allOut() {
    return this.players.length > 0 && this.players.every((p) => p.out);
  }

  _gameOver() {
    this.state = "over";
    this.dispatchEvent(new CustomEvent("gameover", { detail: { score: this.score, level: this.level } }));
  }

  _endInterlude() {
    if (this.state === "ready") { this.state = "playing"; return; }
    if (this.state === "clear") {
      this.level += 1;
      this._loadLevel(this.level);
      this.state = "ready";
      this.freeze = READY_PAUSE;
      this.dispatchEvent(new CustomEvent("levelstart", { detail: { level: this.level } }));
    }
  }
}

function circleHitsRect(cx, cy, r, rx, ry, rw, rh) {
  const nx = Math.max(rx, Math.min(cx, rx + rw));
  const ny = Math.max(ry, Math.min(cy, ry + rh));
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy <= r * r;
}
