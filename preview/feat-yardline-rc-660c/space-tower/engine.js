// Space Tower — the pure stacking-game core. No DOM, no rendering, no input.
//
// A crane dangles a house section from a rope high above the tower; the section
// swings side to side. You drop it and it falls onto the building. Sections keep
// their full size (they're houses, not sliced bricks) — what matters is WHERE
// they land:
//   - land a section mostly off the floor below and it slides off → the tower
//     topples.
//   - even when each floor is supported, sloppy stacking drifts the building's
//     centre of mass off the base; once the lean passes the limit the whole
//     tower keels over. Centre your drops (or correct a lean by stacking the
//     other way) to keep climbing.
//
// Two-player is co-operative: players alternate dropping sections to raise one
// shared building for a shared score; a topple ends it for both.
//
// Coordinates: world Y increases DOWNWARD. The base sits low (large y); each new
// floor is one BLOCK_H higher (smaller y). Blocks are {cx, w, yTop, hue}.
//
// Deterministic: the only randomness (starting hue) flows through an injected
// RNG, so a seed reproduces the run (self-test-able without a DOM).

export const WORLD_W = 460;
export const WORLD_H = 680;
export const BLOCK_H = 46;               // a house floor is tall enough for windows
export const BASE_W = 176;               // the foundation floor (a touch wider)
export const FLOOR_W = 124;              // every stacked house floor
export const BASE_Y = WORLD_H - 150;     // top edge of the base

// Crane geometry (world units, relative to the current tower top).
export const DROP_H = 250;               // how high above the tower a section hangs
export const PIVOT_UP = 74;              // crane pivot sits this far above the section

const G = 1750;                          // fall gravity
const AMP_BASE = 110;                    // swing amplitude at the bottom...
const AMP_MAX = 158;                     // ...and its cap as you climb
const AMP_PER = 5;
const SWING_BASE = 1.7;                  // swing speed (rad/s), ramps with height
const SWING_PER = 0.045;
const SWING_MAX = 3.2;

const SLIP = FLOOR_W / 2;                // land farther off than this → it slides off
const MAX_DRIFT = 72;                    // centre-of-mass lean the base can bear
const PERFECT_EPS = 8;                   // centre tolerance for a "perfect" stack

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
    this.numPlayers = 1;
    this.baseHue = Math.floor(this.rng() * 360);
    this.blocks = [{ cx: WORLD_W / 2, w: BASE_W, yTop: BASE_Y, hue: this.baseHue }];
    this.current = null;     // live section: {phase:'aim'|'fall', x, y, w, vy, swingT, hue}
    this.height = 0;
    this.score = 0;
    this.combo = 0;
    this.turn = 0;
    this.drift = 0;          // centre-of-mass offset from the base (signed)
    this.leanFrac = 0;       // drift / MAX_DRIFT, clamped — render leans the tower by this
    this.state = "idle";     // idle | playing | over
  }

  start(numPlayers = 1) {
    this.numPlayers = Math.max(1, Math.min(2, numPlayers));
    this.baseHue = Math.floor(this.rng() * 360);
    this.blocks = [{ cx: WORLD_W / 2, w: BASE_W, yTop: BASE_Y, hue: this.baseHue }];
    this.height = 0;
    this.score = 0;
    this.combo = 0;
    this.turn = 0;
    this.drift = 0;
    this.leanFrac = 0;
    this.state = "playing";
    this._spawn();
  }

  get top() { return this.blocks[this.blocks.length - 1]; }
  get pivotY() { return this.top.yTop - DROP_H - PIVOT_UP; }
  _hueFor(h) { return (this.baseHue + h * 16) % 360; }
  _amp() { return Math.min(AMP_MAX, AMP_BASE + this.height * AMP_PER); }
  _swingSpeed() { return Math.min(SWING_MAX, SWING_BASE + this.height * SWING_PER); }

  // Hang the next section from the crane, swinging.
  _spawn() {
    this.current = {
      phase: "aim",
      x: WORLD_W / 2,
      y: this.top.yTop - DROP_H,
      w: FLOOR_W,
      vy: 0,
      swingT: this.height % 2 ? Math.PI : 0,   // alternate which side it starts from
      hue: this._hueFor(this.height + 1),
    };
  }

  step(dt) {
    if (this.state !== "playing" || !this.current) return;
    const c = this.current;
    if (c.phase === "aim") {
      c.swingT += this._swingSpeed() * dt;
      const amp = this._amp();
      const half = c.w / 2 + 6;
      c.x = Math.max(half, Math.min(WORLD_W - half, WORLD_W / 2 + Math.sin(c.swingT) * amp));
      c.y = this.top.yTop - DROP_H;            // stay at drop height as the tower grows
    } else { // falling
      c.vy += G * dt;
      c.y += c.vy * dt;
      const landY = this.top.yTop - BLOCK_H;
      if (c.y >= landY) { c.y = landY; this._land(); }
    }
  }

  // Drop the live section for player `id` (co-op: only on your turn).
  drop(id = 0) {
    if (this.state !== "playing" || !this.current || this.current.phase !== "aim") return false;
    if (this.numPlayers === 2 && id !== this.turn) return false;
    this.current.phase = "fall";
    this.current.by = id;
    this.dispatchEvent(new CustomEvent("release"));
    return true;
  }

  _land() {
    const c = this.current;
    const below = this.top;
    const dxBelow = c.x - below.cx;

    // Slid off the floor below → topple immediately.
    if (Math.abs(dxBelow) > SLIP) {
      this._topple(Math.sign(dxBelow) || 1, c);
      return;
    }

    const placed = { cx: c.x, w: c.w, yTop: c.y, hue: c.hue };
    this.blocks.push(placed);
    this.height += 1;

    const perfect = Math.abs(dxBelow) <= PERFECT_EPS;
    if (perfect) { this.combo += 1; this.score += 10 + this.combo * 5; }
    else { this.combo = 0; this.score += 10; }

    // Recompute the building's lean from the centre of mass of every floor.
    let sum = 0;
    for (const b of this.blocks) sum += b.cx;
    this.drift = sum / this.blocks.length - WORLD_W / 2;
    this.leanFrac = Math.max(-1, Math.min(1, this.drift / MAX_DRIFT));

    if (this.numPlayers === 2) this.turn = (this.turn + 1) % this.numPlayers;
    this.dispatchEvent(new CustomEvent("place", { detail: { perfect, combo: this.combo, dxBelow } }));

    // Centre of mass wandered past what the base can hold → it keels over.
    if (Math.abs(this.drift) > MAX_DRIFT) {
      this._topple(Math.sign(this.drift), null);
      return;
    }
    this._spawn();
  }

  _topple(dir, fallingPiece) {
    this.current = null;
    this.state = "over";
    this.dispatchEvent(new CustomEvent("topple", { detail: { dir, piece: fallingPiece } }));
    this.dispatchEvent(new CustomEvent("gameover", { detail: { score: this.score, height: this.height } }));
  }
}
