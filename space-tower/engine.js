// Space Tower — the pure stacking-game core. No DOM, no rendering, no input:
// it owns the stacked tower of sections, the single section sliding back and
// forth at the top, the drop/overlap/slice rule, perfect-drop combos, the
// score/height, and (for co-op) whose turn it is. app.js drives it from input +
// a fixed-dt accumulator and renders its state; the camera is purely a render
// concern and lives there.
//
// Drop rule (classic stacker): when you drop the moving section, only the part
// that overlaps the section below survives — the overhang is sliced off and
// falls away, so the tower narrows toward the sky. Drop it dead-centre for a
// "perfect" (no width lost, builds a combo). Miss the tower entirely and it
// topples — game over.
//
// Two-player is co-operative: players ALTERNATE dropping sections to build one
// shared tower for a shared score; a single miss ends it for both.
//
// Coordinates: world Y increases DOWNWARD. The base sits low (large y); each new
// section is one BLOCK_H higher (smaller y). Sections are {cx, w, yTop, hue}.
//
// Deterministic: the only randomness is the starting colour hue (injected RNG),
// so a given seed reproduces the same run (self-test-able without a DOM).

export const WORLD_W = 460;
export const WORLD_H = 680;
export const BLOCK_H = 36;
export const BASE_W = 210;
export const BASE_Y = WORLD_H - 130;     // top edge of the base section

const BASE_SPEED = 150;                  // section slide speed (units/s)
const SPEED_STEP = 4;                    // ramps with height
const MAX_SPEED = 360;
const PERFECT_EPS = 5;                   // centre tolerance for a "perfect" drop

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
    this.moving = null;
    this.speed = BASE_SPEED;
    this.height = 0;       // sections stacked above the base
    this.score = 0;
    this.combo = 0;
    this.turn = 0;         // whose turn to drop (co-op)
    this.state = "idle";   // idle | playing | over
  }

  start(numPlayers = 1) {
    this.numPlayers = Math.max(1, Math.min(2, numPlayers));
    this.baseHue = Math.floor(this.rng() * 360);
    this.blocks = [{ cx: WORLD_W / 2, w: BASE_W, yTop: BASE_Y, hue: this.baseHue }];
    this.speed = BASE_SPEED;
    this.height = 0;
    this.score = 0;
    this.combo = 0;
    this.turn = 0;
    this.state = "playing";
    this._spawn();
  }

  get top() { return this.blocks[this.blocks.length - 1]; }

  _hueFor(h) { return (this.baseHue + h * 14) % 360; }

  // Spawn the next sliding section above the tower, entering from an alternating
  // side at the current width.
  _spawn() {
    const top = this.top;
    const w = top.w;
    const fromLeft = this.height % 2 === 0;
    this.moving = {
      cx: fromLeft ? w / 2 : WORLD_W - w / 2,
      w,
      yTop: top.yTop - BLOCK_H,
      hue: this._hueFor(this.height + 1),
      dir: fromLeft ? 1 : -1,
    };
    this.speed = Math.min(MAX_SPEED, BASE_SPEED + this.height * SPEED_STEP);
  }

  step(dt) {
    if (this.state !== "playing" || !this.moving) return;
    const m = this.moving;
    m.cx += m.dir * this.speed * dt;
    const lo = m.w / 2, hi = WORLD_W - m.w / 2;
    if (m.cx <= lo) { m.cx = lo; m.dir = 1; }
    else if (m.cx >= hi) { m.cx = hi; m.dir = -1; }
  }

  // Drop the moving section for player `id`. In co-op only the player whose turn
  // it is may drop. Returns true if a drop was processed.
  drop(id = 0) {
    if (this.state !== "playing" || !this.moving) return false;
    if (this.numPlayers === 2 && id !== this.turn) return false;

    const m = this.moving;
    const top = this.top;
    const left = Math.max(top.cx - top.w / 2, m.cx - m.w / 2);
    const right = Math.min(top.cx + top.w / 2, m.cx + m.w / 2);
    const overlap = right - left;

    // Total miss → topple.
    if (overlap <= 0) {
      this.moving = null;
      this.state = "over";
      this.dispatchEvent(new CustomEvent("miss", { detail: { cx: m.cx, w: m.w, yTop: m.yTop, hue: m.hue } }));
      this.dispatchEvent(new CustomEvent("gameover", { detail: { score: this.score, height: this.height } }));
      return true;
    }

    const perfect = Math.abs(m.cx - top.cx) <= PERFECT_EPS;
    const cuts = [];
    let placed;

    if (perfect) {
      // Snap, keep full width, build a combo.
      placed = { cx: top.cx, w: top.w, yTop: m.yTop, hue: m.hue };
      this.combo += 1;
      this.score += 10 + this.combo * 5;
    } else {
      this.combo = 0;
      placed = { cx: (left + right) / 2, w: overlap, yTop: m.yTop, hue: m.hue };
      this.score += 10;
      // Overhang piece(s) that get sliced off and fall.
      const ml = m.cx - m.w / 2, mr = m.cx + m.w / 2;
      if (ml < left) cuts.push({ cx: (ml + left) / 2, w: left - ml, yTop: m.yTop, hue: m.hue, vx: -120 });
      if (mr > right) cuts.push({ cx: (right + mr) / 2, w: mr - right, yTop: m.yTop, hue: m.hue, vx: 120 });
    }

    this.blocks.push(placed);
    this.height += 1;
    if (this.numPlayers === 2) this.turn = (this.turn + 1) % this.numPlayers;
    this.dispatchEvent(new CustomEvent("drop", { detail: { perfect, combo: this.combo, cuts, by: id } }));
    this._spawn();
    return true;
  }
}
