// Icy Tower-style engine — the pure game core. No DOM, no rendering, no input:
// it owns the climber (position + velocity), the procedurally generated tower of
// one-way platforms, the rising camera, the momentum-based jump + wall bounces,
// floor/combo scoring, and game over. app.js drives it from input + a fixed-dt
// accumulator and renders its state.
//
// The signature feel: horizontal running builds speed, and the faster you're
// moving when you jump the higher you fly; side walls bounce you (keeping most
// of your speed) so you can zig-zag up; clearing 2+ floors in a single jump
// chains a combo whose bonus grows with the floors climbed. The camera scrolls
// ever upward — fall below the bottom and it's over.
//
// Coordinates: world Y increases DOWNWARD (screen-like). Climbing means y gets
// smaller. `camTop` is the world Y shown at the top of the screen; it only ever
// moves up (decreases). Height/score is measured in floors above the ground.
//
// Deterministic given a seed: all randomness (platform layout) flows through an
// injected RNG, so the same seed reproduces the same tower (self-test-able).

// ---- World ----------------------------------------------------------------
export const WORLD_W = 460;
export const WORLD_H = 680;
export const WALL = 26;                 // side-wall thickness (also play bound)
export const PLAY_L = WALL;
export const PLAY_R = WORLD_W - WALL;
export const FLOOR_GAP = 62;            // vertical spacing between floors
export const GROUND_Y = WORLD_H - 56;   // top surface of the ground floor

// ---- Player ---------------------------------------------------------------
export const PLAYER_W = 30;
export const PLAYER_H = 42;
const MOVE_ACCEL_G = 2500;              // ground horizontal acceleration
const MOVE_ACCEL_A = 1500;             // (reduced) air control
const FRICTION_G = 2000;               // ground decel when no input
const MAX_VX = 440;                    // top running speed
const GRAVITY = 2200;
const JUMP_V = 760;                    // base jump launch speed
const JUMP_BOOST = 0.62;              // extra launch per unit of |vx| (the hook)
const WALL_BOUNCE = 0.86;             // speed kept on a wall bounce
const COYOTE = 0.08;                  // grace window to jump just after leaving a floor

// ---- Camera / difficulty --------------------------------------------------
const CAM_FOLLOW = 0.58;              // keep the player ~58% down the screen
const SCROLL_BASE = 26;              // forced upward scroll once you start (u/s)
const SCROLL_PER_FLOOR = 1.5;       // ramps with height
const SCROLL_MAX = 280;
const DEATH_MARGIN = 30;            // how far below the bottom edge is fatal

// ---- Platforms ------------------------------------------------------------
const PLAT_MIN_W = 72;
const PLAT_MAX_W = 150;
const PLAT_MAX_DX = 210;             // keep consecutive platforms reachable

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
  constructor(rng = makeRng(1)) {
    super();
    this.rng = rng;
    this.reset();
  }

  reset() {
    this.player = { x: WORLD_W / 2, y: GROUND_Y, vx: 0, vy: 0 };
    this.floors = [];
    this.nextN = 1;                  // next floor number to generate (0 = ground)
    this.camTop = GROUND_Y + 56 - WORLD_H; // ground sits near the bottom edge
    this.onGround = true;
    this.coyote = 0;
    this.started = false;           // forced scroll begins on the first jump
    this.moveDir = 0;
    this.jumpQueued = false;

    this.maxFloor = 0;
    this.lastLandFloor = 0;
    this.comboFloors = 0;
    this.comboActive = false;
    this.bestCombo = 0;
    this.score = 0;
    this.state = "idle";            // idle | playing | over

    // Ground floor spans the whole play area.
    this.floors.push({ n: 0, x: PLAY_L, w: PLAY_R - PLAY_L, y: GROUND_Y, ground: true });
    this._prevX = WORLD_W / 2;
    this._generate();
  }

  start() {
    this.reset();
    this.state = "playing";
  }

  setMove(dir) { this.moveDir = dir; }
  jump() { if (this.state === "playing") this.jumpQueued = true; }

  // Generate platforms upward until they cover above the visible top.
  _generate() {
    while (GROUND_Y - this.nextN * FLOOR_GAP > this.camTop - 140) {
      const n = this.nextN++;
      const w = PLAT_MIN_W + this.rng() * (PLAT_MAX_W - PLAT_MIN_W);
      // Bias x near the previous platform so the climb stays reachable.
      const minX = Math.max(PLAY_L, this._prevX - PLAT_MAX_DX);
      const maxX = Math.min(PLAY_R - w, this._prevX + PLAT_MAX_DX);
      const lo = Math.min(minX, maxX);
      const hi = Math.max(minX, maxX);
      const x = lo + this.rng() * (hi - lo);
      this.floors.push({ n, x, w, y: GROUND_Y - n * FLOOR_GAP, ground: false });
      this._prevX = x + w / 2;
    }
  }

  step(dt) {
    if (this.state !== "playing") return;
    const p = this.player;

    // --- Horizontal: accelerate with input, else friction on the ground. ---
    if (this.moveDir !== 0) {
      p.vx += this.moveDir * (this.onGround ? MOVE_ACCEL_G : MOVE_ACCEL_A) * dt;
    } else if (this.onGround) {
      const s = Math.sign(p.vx);
      p.vx -= s * FRICTION_G * dt;
      if (Math.sign(p.vx) !== s) p.vx = 0;
    }
    p.vx = clamp(p.vx, -MAX_VX, MAX_VX);

    // --- Jump: the faster you run, the higher you launch. ---
    if (this.jumpQueued && (this.onGround || this.coyote > 0)) {
      p.vy = -(JUMP_V + Math.min(Math.abs(p.vx), MAX_VX) * JUMP_BOOST);
      this.onGround = false;
      this.coyote = 0;
      this.started = true;
      this.dispatchEvent(new CustomEvent("jump", { detail: { power: Math.abs(p.vx) / MAX_VX } }));
    }
    this.jumpQueued = false;

    // --- Gravity + integrate X with wall bounces. ---
    p.vy += GRAVITY * dt;
    const prevFeet = p.y;
    p.x += p.vx * dt;
    const half = PLAYER_W / 2;
    if (p.x < PLAY_L + half) {
      p.x = PLAY_L + half;
      if (Math.abs(p.vx) > 40) this.dispatchEvent(new CustomEvent("wall"));
      p.vx = -p.vx * WALL_BOUNCE;
    } else if (p.x > PLAY_R - half) {
      p.x = PLAY_R - half;
      if (Math.abs(p.vx) > 40) this.dispatchEvent(new CustomEvent("wall"));
      p.vx = -p.vx * WALL_BOUNCE;
    }

    // --- Integrate Y, then resolve one-way platform landing (only falling). ---
    p.y += p.vy * dt;
    const wasGround = this.onGround;
    this.onGround = false;
    if (p.vy >= 0) {
      let best = null;
      for (const f of this.floors) {
        const top = f.y;
        if (prevFeet <= top + 1 && p.y >= top &&
            p.x + half > f.x && p.x - half < f.x + f.w) {
          if (!best || top < best.y) best = f;   // first surface met from above
        }
      }
      if (best) {
        p.y = best.y;
        p.vy = 0;
        this.onGround = true;
        if (!wasGround) this._land(best.n);
      }
    }
    this.coyote = this.onGround ? COYOTE : Math.max(0, this.coyote - dt);

    // --- Camera: follow up, plus a forced rising scroll once started. ---
    if (this.started) {
      const scroll = Math.min(SCROLL_MAX, SCROLL_BASE + this.maxFloor * SCROLL_PER_FLOOR);
      this.camTop -= scroll * dt;
    }
    const follow = p.y - WORLD_H * CAM_FOLLOW;
    if (follow < this.camTop) this.camTop = follow;

    this._generate();
    this._cull();

    // --- Death: fell below the visible bottom. ---
    if (p.y - this.camTop > WORLD_H + DEATH_MARGIN) {
      this.state = "over";
      if (this.comboActive) this._endCombo();
      this.dispatchEvent(new CustomEvent("gameover", { detail: { score: this.score, floor: this.maxFloor } }));
    }
  }

  // Landed on floor n: update height score and the running combo.
  _land(n) {
    if (n > this.maxFloor) {
      this.score += (n - this.maxFloor) * 10;
      this.maxFloor = n;
    }
    const climbed = n - this.lastLandFloor;
    this.lastLandFloor = n;
    this.dispatchEvent(new CustomEvent("land", { detail: { floor: n, climbed } }));

    if (climbed >= 2) {
      this.comboActive = true;
      this.comboFloors += climbed;
      this.dispatchEvent(new CustomEvent("combo", { detail: { floors: this.comboFloors, climbed } }));
    } else if (this.comboActive) {
      this._endCombo();
    }
  }

  _endCombo() {
    const floors = this.comboFloors;
    if (floors >= 2) {
      const bonus = Math.round(floors * (floors + 1) * 3);
      this.score += bonus;
      if (floors > this.bestCombo) this.bestCombo = floors;
      this.dispatchEvent(new CustomEvent("comboend", { detail: { floors, bonus } }));
    }
    this.comboFloors = 0;
    this.comboActive = false;
  }

  // Drop platforms that have scrolled well below the view (keeps the list small).
  _cull() {
    const limit = this.camTop + WORLD_H + 240;
    if (this.floors.length > 40) {
      this.floors = this.floors.filter((f) => f.y < limit || f.n >= this.maxFloor - 2);
    }
  }
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
