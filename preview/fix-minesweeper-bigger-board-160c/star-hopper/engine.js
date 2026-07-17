// Star Hopper — an original side-scrolling platformer core. No DOM, no
// rendering, no input: it owns the tile level, the hero's run/variable-jump
// physics + tile collision, walking enemies (stomp from above to beat them),
// coins + bump-crates, pits, lives, and the goal flag. app.js drives it from
// input + a fixed-dt loop and renders its state (the camera lives there).
//
// Mechanics only — original character/enemies/art, no copyrighted assets.
//
// Coordinates: world pixels, Y down. The level is a tile grid (TILE px). Solid
// terrain lives in the grid; coins / enemies / goal / spawn are separate lists.

export const TILE = 32;
export const PW = 22, PH = 28;            // hero box
const EW = 26, EH = 24;                    // enemy box

const GRAVITY = 2000, MAX_FALL = 780;
const ACCEL_G = 1600, ACCEL_A = 950, FRICTION = 1500, MAX_VX = 250;
const JUMP_V = 620, JUMP_CUT = 0.45;
const COYOTE = 0.09, BUFFER = 0.10;
const STOMP_BOUNCE = 440;
const ENEMY_VX = 60;
const INVULN = 1.8;
const START_LIVES = 3;

export function makeRng(seed = 1) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Engine extends EventTarget {
  constructor() {
    super();
    this.reset();
  }

  reset() {
    this._build();
    this.lives = START_LIVES;
    this.coins = 0;
    this.state = "idle";          // idle | play | over | won
    this.moveDir = 0;             // -1 / 0 / +1
    this.jumpHeld = false;
    this._jumpBuf = 0;
    this._coyote = 0;
    this.invuln = 0;
    this._spawnHero();
  }

  start() {
    this.reset();
    this.state = "play";
  }

  // ---- Level ---------------------------------------------------------------
  _build() {
    const W = 132, H = 14;
    const g = Array.from({ length: H }, () => new Array(W).fill(" "));
    this.cols = W; this.rows = H;

    // Ground segments (columns with floor on rows 12–13); gaps between = pits.
    const ground = [[0, 13], [17, 29], [33, 51], [55, 78], [83, 131]];
    for (const [a, b] of ground) for (let c = a; c <= b; c++) { g[12][c] = "X"; g[13][c] = "X"; }

    // Floating platforms [col, row, length].
    const plats = [[20, 9, 3], [26, 8, 3], [38, 9, 4], [44, 7, 3], [50, 5, 3],
      [62, 9, 4], [69, 7, 3], [90, 9, 3], [97, 7, 4], [112, 9, 3], [118, 6, 3]];
    for (const [c, r, l] of plats) for (let i = 0; i < l; i++) g[r][c + i] = "=";

    // Bump-crates [col, row] (a coin pops when you head-butt them).
    const crates = [[40, 6], [41, 6], [42, 6], [70, 5], [97, 5], [98, 5], [99, 5]];
    for (const [c, r] of crates) g[r][c] = "Q";

    this.grid = g;
    this.levelW = W * TILE;
    this.levelH = H * TILE;
    this.startX = 2 * TILE;
    this.startY = 11 * TILE - (PH - TILE);   // feet on the ground row
    this.goalX = 128 * TILE;

    // Coins.
    this.coinList = [];
    const coin = (c, r) => this.coinList.push({ x: c * TILE + TILE / 2, y: r * TILE + TILE / 2, got: false });
    for (const [c, r, l] of plats) for (let i = 0; i < l; i++) coin(c + i, r - 1);
    for (const [a, b] of [[14, 16], [30, 32], [52, 54], [79, 82]]) for (let c = a; c <= b; c++) coin(c, 9);
    for (const [c, r] of [[6, 11], [8, 11], [59, 10], [60, 10], [61, 10], [105, 10], [108, 10], [122, 10]]) coin(c, r);

    // Enemies (drop onto the ground/platform under their spawn).
    this.enemyList = [];
    for (const [c, r] of [[10, 11], [22, 7], [40, 11], [47, 5], [64, 7], [74, 11], [92, 7], [110, 11], [120, 8]]) {
      this.enemyList.push({ x: c * TILE + 3, y: r * TILE, vx: (r % 2 ? 1 : -1) * ENEMY_VX, vy: 0, alive: true, squash: 0 });
    }
  }

  _spawnHero() {
    this.hero = { x: this.startX, y: this.startY, vx: 0, vy: 0, dir: 1, onGround: false };
  }

  // grid solidity (out-of-bounds: left/right walls solid, top open, below = pit).
  solid(tx, ty) {
    if (tx < 0) return true;
    if (ty < 0) return false;
    if (ty >= this.rows || tx >= this.cols) return false;
    const c = this.grid[ty][tx];
    return c === "X" || c === "=" || c === "Q" || c === "U";
  }

  // ---- Input surface -------------------------------------------------------
  setMove(d) { this.moveDir = d; }
  setJump(held) {
    if (held && !this.jumpHeld) this._jumpBuf = BUFFER;   // edge → buffer a jump
    this.jumpHeld = held;
  }

  // ---- Simulation ----------------------------------------------------------
  step(dt) {
    if (this.state !== "play") return;
    const h = this.hero;

    // Horizontal accel / friction.
    if (this.moveDir) {
      h.vx += this.moveDir * (h.onGround ? ACCEL_G : ACCEL_A) * dt;
      h.dir = this.moveDir;
    } else if (h.onGround) {
      const s = Math.sign(h.vx); h.vx -= s * FRICTION * dt;
      if (Math.sign(h.vx) !== s) h.vx = 0;
    }
    h.vx = clamp(h.vx, -MAX_VX, MAX_VX);

    // Jump (with coyote time + input buffer); release early to cut height.
    this._jumpBuf = Math.max(0, this._jumpBuf - dt);
    this._coyote = h.onGround ? COYOTE : Math.max(0, this._coyote - dt);
    if (this._jumpBuf > 0 && this._coyote > 0) {
      h.vy = -JUMP_V; h.onGround = false; this._coyote = 0; this._jumpBuf = 0;
      this.dispatchEvent(new CustomEvent("jump"));
    }
    if (!this.jumpHeld && h.vy < 0) h.vy *= JUMP_CUT;

    // Gravity + integrate with tile collision.
    h.vy = Math.min(MAX_FALL, h.vy + GRAVITY * dt);
    this._moveHero(dt);

    if (this.invuln > 0) this.invuln -= dt;

    // Enemies.
    for (const e of this.enemyList) {
      if (e.squash > 0) { e.squash -= dt; continue; }
      if (e.alive) this._stepEnemy(e, dt);
    }
    this._heroVsEnemies();
    this._heroVsCoins();

    // Pit / fell out of the world.
    if (h.y > this.levelH + 40) { this._die("pit"); return; }

    // Goal.
    if (h.x + PW / 2 >= this.goalX) { this.state = "won"; this.dispatchEvent(new CustomEvent("win", { detail: { coins: this.coins, lives: this.lives } })); }
  }

  _moveHero(dt) {
    const h = this.hero;
    // Horizontal.
    h.x += h.vx * dt;
    let minTy = Math.floor(h.y / TILE), maxTy = Math.floor((h.y + PH - 1) / TILE);
    if (h.vx > 0) {
      const col = Math.floor((h.x + PW - 1) / TILE);
      for (let ty = minTy; ty <= maxTy; ty++) if (this.solid(col, ty)) { h.x = col * TILE - PW; h.vx = 0; break; }
    } else if (h.vx < 0) {
      const col = Math.floor(h.x / TILE);
      for (let ty = minTy; ty <= maxTy; ty++) if (this.solid(col, ty)) { h.x = (col + 1) * TILE; h.vx = 0; break; }
    }
    // Vertical.
    h.y += h.vy * dt;
    h.onGround = false;
    const minTx = Math.floor(h.x / TILE), maxTx = Math.floor((h.x + PW - 1) / TILE);
    if (h.vy > 0) {
      const row = Math.floor((h.y + PH - 1) / TILE);
      for (let tx = minTx; tx <= maxTx; tx++) if (this.solid(tx, row)) { h.y = row * TILE - PH; h.vy = 0; h.onGround = true; break; }
    } else if (h.vy < 0) {
      const row = Math.floor(h.y / TILE);
      for (let tx = minTx; tx <= maxTx; tx++) if (this.solid(tx, row)) {
        if (this.grid[row] && this.grid[row][tx] === "Q") this._bump(tx, row);
        h.y = (row + 1) * TILE; h.vy = 0; break;
      }
    }
  }

  _bump(tx, row) {
    this.grid[row][tx] = "U";
    this.coins += 1;
    this.dispatchEvent(new CustomEvent("coin", { detail: { from: "crate", x: tx * TILE + TILE / 2, y: row * TILE } }));
  }

  _stepEnemy(e, dt) {
    e.vy = Math.min(MAX_FALL, e.vy + GRAVITY * dt);
    // Horizontal + wall reverse.
    e.x += e.vx * dt;
    let minTy = Math.floor(e.y / TILE), maxTy = Math.floor((e.y + EH - 1) / TILE);
    if (e.vx > 0) {
      const col = Math.floor((e.x + EW - 1) / TILE);
      for (let ty = minTy; ty <= maxTy; ty++) if (this.solid(col, ty)) { e.x = col * TILE - EW; e.vx = -e.vx; break; }
    } else {
      const col = Math.floor(e.x / TILE);
      for (let ty = minTy; ty <= maxTy; ty++) if (this.solid(col, ty)) { e.x = (col + 1) * TILE; e.vx = -e.vx; break; }
    }
    // Vertical.
    e.y += e.vy * dt;
    let onGround = false;
    const minTx = Math.floor(e.x / TILE), maxTx = Math.floor((e.x + EW - 1) / TILE);
    if (e.vy > 0) {
      const row = Math.floor((e.y + EH - 1) / TILE);
      for (let tx = minTx; tx <= maxTx; tx++) if (this.solid(tx, row)) { e.y = row * TILE - EH; e.vy = 0; onGround = true; break; }
    }
    // Don't walk off ledges: probe the floor just ahead.
    if (onGround) {
      const aheadX = e.vx > 0 ? e.x + EW + 1 : e.x - 1;
      const belowTy = Math.floor((e.y + EH + 2) / TILE);
      if (!this.solid(Math.floor(aheadX / TILE), belowTy)) e.vx = -e.vx;
    }
  }

  _heroVsEnemies() {
    const h = this.hero;
    for (const e of this.enemyList) {
      if (!e.alive || e.squash > 0) continue;
      if (!aabb(h.x, h.y, PW, PH, e.x, e.y, EW, EH)) continue;
      // Stomp if falling onto its top half.
      if (h.vy > 0 && (h.y + PH) - e.y < 18) {
        e.alive = false; e.squash = 0.35;
        h.vy = -STOMP_BOUNCE;
        this.coins += 1;
        this.dispatchEvent(new CustomEvent("stomp", { detail: { x: e.x + EW / 2, y: e.y } }));
      } else if (this.invuln <= 0) {
        this._die("hit");
        return;
      }
    }
  }

  _heroVsCoins() {
    const h = this.hero;
    for (const c of this.coinList) {
      if (c.got) continue;
      if (aabb(h.x, h.y, PW, PH, c.x - 9, c.y - 9, 18, 18)) {
        c.got = true; this.coins += 1;
        this.dispatchEvent(new CustomEvent("coin", { detail: { from: "coin", x: c.x, y: c.y } }));
      }
    }
  }

  _die(cause) {
    this.lives -= 1;
    this.dispatchEvent(new CustomEvent("die", { detail: { cause, lives: this.lives } }));
    if (this.lives <= 0) {
      this.state = "over";
      this.dispatchEvent(new CustomEvent("gameover", { detail: { coins: this.coins } }));
      return;
    }
    // Respawn at the start; the level (coins/enemies) stays as-is.
    this._spawnHero();
    this.invuln = INVULN;
  }
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function aabb(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}
