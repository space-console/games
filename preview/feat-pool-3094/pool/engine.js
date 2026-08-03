// 8-Ball Pool for Space Console — pure simulation + rules, no DOM, no rendering.
//
// Two layers live here:
//   1. Physics — balls roll with rolling friction, bounce off cushions (which
//      have gaps at the pocket mouths so a ball can actually drop), collide
//      elastically with each other, and fall in when they reach a pocket. The
//      cue ball also carries english: top/back spin kicks in on the first
//      object-ball contact, side spin curves the roll and grabs on the rails.
//   2. Rules — standard 8-ball: break, open table, group assignment on the
//      first legal pot, fouls (scratch / no contact / wrong ball first / no
//      rail after contact) giving ball-in-hand, and the 8-ball ending the game
//      the right way or the wrong way.
//
// The app layer owns input and pixels; it never reaches into the maths here.
// Everything is expressed in TABLE UNITS (the playing surface is 1000 × 500),
// so the renderer can scale to any screen without the physics noticing.

export const TABLE_W = 1000;              // cushion-to-cushion playing surface
export const TABLE_H = 500;
export const BALL_R = 11;                 // ball radius (≈ real 2:1 table ratio)
export const POCKET_R = 23;               // a ball whose centre reaches here drops
export const MOUTH = 31;                  // half-width of the gap in a cushion at a pocket
export const HEAD_STRING = TABLE_W * 0.25; // break line — cue ball starts behind it
export const FOOT_SPOT = TABLE_W * 0.75;   // apex of the rack

// Six pockets: four corners plus the two side pockets on the long rails.
export const POCKETS = [
  { x: 0, y: 0 }, { x: TABLE_W / 2, y: 0 }, { x: TABLE_W, y: 0 },
  { x: 0, y: TABLE_H }, { x: TABLE_W / 2, y: TABLE_H }, { x: TABLE_W, y: TABLE_H },
];

export const PHYS_DT = 1 / 480;           // fixed physics step (fast balls stay solid)
export const MAX_SPEED = 1500;            // speed of a full-power strike

const FRICTION = 265;                     // rolling deceleration, units/s²
const STOP_SPEED = 7;                     // below this a ball is parked
const BALL_E = 0.95;                      // ball-to-ball restitution
const CUSHION_E = 0.74;                   // rail restitution
const CUSHION_GRIP = 0.94;                // tangential damping on a rail
const SPIN_FOLLOW = 0.5;                  // how hard top/back spin pushes the cue ball
const SPIN_CURVE = 1.5;                   // rad/s of curve at full side spin
const SPIN_DECAY = 1.9;                   // spin bleed per second

/** Ball groups. The cue ball and the 8 are their own thing. */
export const SOLID = "solid";
export const STRIPE = "stripe";

/** Group a numbered ball belongs to. */
export function groupOf(id) {
  if (id === 0) return "cue";
  if (id === 8) return "eight";
  return id < 8 ? SOLID : STRIPE;
}

export class Engine {
  constructor() {
    this.balls = [];
    this.reset();
  }

  /** Rack them up and hand the break to `breaker` (seat 1 or 2). */
  reset(breaker = 1) {
    this.balls = [makeBall(0, HEAD_STRING * 0.72, TABLE_H / 2)];
    for (const { id, x, y } of rackPositions()) this.balls.push(makeBall(id, x, y));

    this.turn = breaker;
    this.groups = { 1: null, 2: null };   // seat → SOLID / STRIPE / null while open
    this.phase = "break";                 // "break" until the opening shot is taken
    this.gameOver = false;
    this.winner = null;
    this.ballInHand = true;               // the breaker places the cue ball…
    this.kitchen = true;                  // …but only behind the head string
    this.shot = newShotRecord(true);
  }

  get cue() { return this.balls[0]; }

  /** Every ball still on the table (the cue ball included). */
  active() { return this.balls.filter((b) => !b.potted); }

  /** True while anything is still rolling. */
  get moving() { return this.balls.some((b) => !b.potted && (b.vx !== 0 || b.vy !== 0)); }

  /** How many of a group are left on the table. */
  remaining(group) { return this.balls.filter((b) => !b.potted && b.group === group).length; }

  /** Balls of a group already pocketed, in the order they went down. */
  pocketed(group) { return this.balls.filter((b) => b.potted && b.group === group); }

  /**
   * Which balls this seat may legally hit FIRST:
   * "any" while the table is open, its own group once assigned, the 8 once that
   * group is cleared.
   */
  legalTarget(seat = this.turn) {
    const group = this.groups[seat];
    if (!group) return "any";
    return this.remaining(group) === 0 ? "eight" : group;
  }

  /** Is `ball` a legal first contact for the seat to move? */
  isLegalTarget(ball, seat = this.turn) {
    const want = this.legalTarget(seat);
    if (want === "any") return ball.group !== "eight";
    if (want === "eight") return ball.group === "eight";
    return ball.group === want;
  }

  // ---- Cue-ball placement (ball in hand) ----------------------------------
  /** True if the cue ball may legally sit at (x, y) right now. */
  canPlace(x, y) {
    if (x < BALL_R || x > TABLE_W - BALL_R || y < BALL_R || y > TABLE_H - BALL_R) return false;
    if (this.kitchen && x > HEAD_STRING) return false;
    for (const p of POCKETS) if (dist(p.x, p.y, x, y) < POCKET_R + BALL_R) return false;
    for (const b of this.balls) {
      if (b.id === 0 || b.potted) continue;
      if (dist(b.x, b.y, x, y) < BALL_R * 2 + 0.5) return false;
    }
    return true;
  }

  /** Move the cue ball if the spot is legal. Returns whether it took. */
  placeCue(x, y) {
    if (!this.canPlace(x, y)) return false;
    const cue = this.cue;
    cue.x = x;
    cue.y = y;
    cue.vx = cue.vy = 0;
    cue.potted = false;
    return true;
  }

  /** Drop ball-in-hand once the player is happy with the spot. */
  settleCue() {
    this.ballInHand = false;
    this.kitchen = false;
  }

  // ---- Taking a shot -------------------------------------------------------
  /**
   * Strike the cue ball.
   * @param {number} angle  direction in radians
   * @param {number} power  0..1 of MAX_SPEED
   * @param {{x: number, y: number}} spin  side (-1..1) and top/back (-1..1) english
   */
  strike(angle, power, spin = { x: 0, y: 0 }) {
    const cue = this.cue;
    const speed = clamp(power, 0, 1) * MAX_SPEED;
    cue.vx = Math.cos(angle) * speed;
    cue.vy = Math.sin(angle) * speed;
    cue.spinSide = clamp(spin.x, -1, 1);
    cue.spinVert = clamp(spin.y, -1, 1);
    this.ballInHand = false;
    this.kitchen = false;
    this.shot = newShotRecord(this.phase === "break");
    this.shot.clearedBefore = this.legalTarget() === "eight";
  }

  /**
   * Advance the simulation one fixed step. Returns the events that happened, so
   * the app can play a click, a rail thump or a pot chime without polling state.
   */
  step(dt) {
    const events = [];
    const live = this.active();

    for (const b of live) {
      const speed = Math.hypot(b.vx, b.vy);
      if (speed === 0) continue;

      // Rolling friction: a constant deceleration, parked below a threshold.
      const next = speed - FRICTION * dt;
      if (next <= STOP_SPEED) {
        b.vx = b.vy = 0;
        b.spinSide = b.spinVert = 0;
        continue;
      }
      const k = next / speed;
      b.vx *= k;
      b.vy *= k;

      // Side spin bends the roll a little, and fades as the ball loses it.
      if (b.spinSide) {
        const turn = SPIN_CURVE * b.spinSide * dt * (next / MAX_SPEED);
        const cos = Math.cos(turn);
        const sin = Math.sin(turn);
        const vx = b.vx * cos - b.vy * sin;
        b.vy = b.vx * sin + b.vy * cos;
        b.vx = vx;
        b.spinSide -= b.spinSide * SPIN_DECAY * dt;
      }

      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.roll += next * dt;          // distance rolled, for the rolling-stripe look
    }

    this._pockets(live, events);
    this._cushions(live, events);
    this._collisions(live, events);
    return events;
  }

  // A ball whose centre reaches a pocket drops. Anything that somehow slips past
  // a cushion gap without being captured is treated as pocketed too, so nothing
  // can ever escape the table.
  _pockets(live, events) {
    for (const b of live) {
      if (b.potted) continue;
      const escaped = b.x < -BALL_R || b.x > TABLE_W + BALL_R ||
                      b.y < -BALL_R || b.y > TABLE_H + BALL_R;
      let dropped = escaped;
      if (!dropped) {
        for (const p of POCKETS) {
          if (dist(p.x, p.y, b.x, b.y) <= POCKET_R) { dropped = true; break; }
        }
      }
      if (!dropped) continue;
      b.potted = true;
      b.vx = b.vy = 0;
      this.shot.potted.push(b.id);
      if (b.id === 0) this.shot.cueScratch = true;
      events.push({ type: "pot", id: b.id, group: b.group });
    }
  }

  // Cushions, minus a gap at every pocket mouth (otherwise balls bounce off the
  // jaws instead of dropping). Side spin grabs the rail and skews the rebound.
  _cushions(live, events) {
    for (const b of live) {
      if (b.potted) continue;
      let hit = 0;

      if (b.y < BALL_R && b.vy < 0 && !inMouth(b.x, [0, TABLE_W / 2, TABLE_W])) {
        b.y = BALL_R;
        b.vy = -b.vy * CUSHION_E;
        b.vx = b.vx * CUSHION_GRIP + b.spinSide * 40;
        hit = Math.abs(b.vy);
      } else if (b.y > TABLE_H - BALL_R && b.vy > 0 && !inMouth(b.x, [0, TABLE_W / 2, TABLE_W])) {
        b.y = TABLE_H - BALL_R;
        b.vy = -b.vy * CUSHION_E;
        b.vx = b.vx * CUSHION_GRIP - b.spinSide * 40;
        hit = Math.abs(b.vy);
      }

      if (b.x < BALL_R && b.vx < 0 && !inMouth(b.y, [0, TABLE_H])) {
        b.x = BALL_R;
        b.vx = -b.vx * CUSHION_E;
        b.vy = b.vy * CUSHION_GRIP - b.spinSide * 40;
        hit = Math.max(hit, Math.abs(b.vx));
      } else if (b.x > TABLE_W - BALL_R && b.vx > 0 && !inMouth(b.y, [0, TABLE_H])) {
        b.x = TABLE_W - BALL_R;
        b.vx = -b.vx * CUSHION_E;
        b.vy = b.vy * CUSHION_GRIP + b.spinSide * 40;
        hit = Math.max(hit, Math.abs(b.vx));
      }

      if (hit > 0) {
        if (this.shot.firstContact !== null) this.shot.railAfterContact = true;
        events.push({ type: "rail", id: b.id, speed: hit });
      }
    }
  }

  // Elastic ball-to-ball collisions, plus the follow/draw kick the cue ball gets
  // from top/back spin on its first contact.
  _collisions(live, events) {
    for (let i = 0; i < live.length; i++) {
      const a = live[i];
      if (a.potted) continue;
      for (let j = i + 1; j < live.length; j++) {
        const b = live[j];
        if (b.potted) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        if (d === 0 || d >= BALL_R * 2) continue;

        const nx = dx / d;
        const ny = dy / d;
        // Push them apart so they don't sink into each other over many steps.
        const overlap = (BALL_R * 2 - d) / 2 + 0.01;
        a.x -= nx * overlap; a.y -= ny * overlap;
        b.x += nx * overlap; b.y += ny * overlap;

        const rvn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (rvn > 0) continue;               // already separating
        const jimp = -(1 + BALL_E) * rvn / 2;
        a.vx -= jimp * nx; a.vy -= jimp * ny;
        b.vx += jimp * nx; b.vy += jimp * ny;

        const cue = a.id === 0 ? a : b.id === 0 ? b : null;
        const object = cue ? (cue === a ? b : a) : null;
        if (cue && this.shot.firstContact === null) {
          this.shot.firstContact = object.id;
          // Follow / draw: shove the cue ball along (or back down) its incoming
          // line once it has transferred the hit.
          if (cue.spinVert) {
            const speed = Math.hypot(cue.vx, cue.vy) + Math.abs(rvn);
            cue.vx += nx * cue.spinVert * SPIN_FOLLOW * speed;
            cue.vy += ny * cue.spinVert * SPIN_FOLLOW * speed;
            cue.spinVert = 0;
          }
        }
        events.push({ type: "click", a: a.id, b: b.id, speed: Math.abs(rvn) });
      }
    }
  }

  // ---- Rules ---------------------------------------------------------------
  /**
   * Score the shot that just finished and advance the game state (turn, groups,
   * ball in hand, win/lose). Returns a summary the UI narrates.
   *
   * @returns {{foul: boolean, reason: string, potted: number[], continueTurn: boolean,
   *            assigned: string|null, rerack: boolean, gameOver: boolean, winner: number|null}}
   */
  resolveShot() {
    const s = this.shot;
    const me = this.turn;
    const opp = other(me);
    const potted = s.potted.filter((id) => id !== 0);
    const eight = potted.includes(8);
    const out = {
      foul: false, reason: "", potted, continueTurn: false,
      assigned: null, rerack: false, gameOver: false, winner: null,
    };

    // --- fouls
    if (s.cueScratch) {
      out.foul = true;
      out.reason = "Scratch — cue ball pocketed";
    } else if (s.firstContact === null) {
      out.foul = true;
      out.reason = "No ball was hit";
    } else {
      const first = this.ball(s.firstContact);
      const want = this.legalTarget(me);
      if (want === "eight" && first.group !== "eight") {
        out.foul = true;
        out.reason = "The 8-ball had to be hit first";
      } else if (want === "any" && first.group === "eight") {
        out.foul = true;
        out.reason = "The 8-ball isn't yours yet";
      } else if ((want === SOLID || want === STRIPE) && first.group !== want) {
        out.foul = true;
        out.reason = `A ${want} had to be hit first`;
      }
    }
    if (!out.foul && potted.length === 0 && !s.railAfterContact) {
      out.foul = true;
      out.reason = "No rail after contact";
    }

    // --- the 8-ball settles everything
    if (eight) {
      if (s.wasBreak) {
        out.rerack = true;
        out.reason = "8-ball on the break — re-rack";
        this.reset(me);
        return out;
      }
      const won = !out.foul && s.clearedBefore;
      out.gameOver = true;
      out.winner = won ? me : opp;
      if (!won && !out.reason) out.reason = "8-ball pocketed too early";
      this.gameOver = true;
      this.winner = out.winner;
      this.turn = out.winner;
      return out;
    }

    // --- group assignment: the table stays open through the break shot
    if (!out.foul && !s.wasBreak && this.groups[me] === null && potted.length) {
      const group = groupOf(potted[0]);
      this.groups[me] = group;
      this.groups[opp] = group === SOLID ? STRIPE : SOLID;
      out.assigned = group;
    }

    // --- keep shooting after potting one of yours (any ball on the break)
    if (!out.foul && potted.length) {
      const mine = this.groups[me];
      out.continueTurn = s.wasBreak || !mine || potted.some((id) => groupOf(id) === mine);
    }

    this.phase = "play";
    if (out.foul) {
      this.turn = opp;
      this.ballInHand = true;
      this.kitchen = false;
      // Bring the cue ball back to a legal spot for the incoming player.
      if (s.cueScratch) this._respotCue();
    } else if (!out.continueTurn) {
      this.turn = opp;
    }
    return out;
  }

  /** Ball by number (0 = cue). */
  ball(id) { return this.balls.find((b) => b.id === id); }

  // After a scratch the cue ball is back in play — park it somewhere legal so
  // ball-in-hand starts from a sane spot even before the player moves it.
  _respotCue() {
    const cue = this.cue;
    cue.potted = false;
    cue.vx = cue.vy = 0;
    cue.spinSide = cue.spinVert = 0;
    const spots = [
      [HEAD_STRING * 0.72, TABLE_H / 2],
      [HEAD_STRING * 0.72, TABLE_H * 0.28],
      [HEAD_STRING * 0.72, TABLE_H * 0.72],
      [TABLE_W * 0.5, TABLE_H * 0.5],
    ];
    for (const [x, y] of spots) {
      if (this.canPlace(x, y)) { cue.x = x; cue.y = y; return; }
    }
    cue.x = HEAD_STRING * 0.72;
    cue.y = TABLE_H / 2;
  }
}

// ---- Aim prediction ---------------------------------------------------------
/**
 * Trace where the cue ball would go along `angle`: the first ball it would touch
 * (with the ghost-ball contact point and the line that ball would take), or the
 * cushion it would reach. Used to draw the aim guides — pure geometry, no state
 * change.
 *
 * @returns {{contact: {x,y}, target: object|null, targetDir: {x,y}|null}}
 */
export function predictShot(engine, angle) {
  const cue = engine.cue;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  let best = null;

  for (const b of engine.active()) {
    if (b.id === 0) continue;
    // Ray/circle intersection against a circle of radius 2R (ghost ball).
    const ox = b.x - cue.x;
    const oy = b.y - cue.y;
    const proj = ox * dx + oy * dy;
    if (proj <= 0) continue;                       // behind the cue ball
    const perp2 = ox * ox + oy * oy - proj * proj;
    const r2 = (BALL_R * 2) ** 2;
    if (perp2 > r2) continue;                      // misses
    const t = proj - Math.sqrt(r2 - perp2);
    if (t < 0) continue;
    if (!best || t < best.t) best = { t, ball: b };
  }

  // How far the ray runs before it meets a cushion (pocket gaps ignored — the
  // guide is a hint, not a promise).
  let railT = Infinity;
  if (dx > 0) railT = Math.min(railT, (TABLE_W - BALL_R - cue.x) / dx);
  if (dx < 0) railT = Math.min(railT, (BALL_R - cue.x) / dx);
  if (dy > 0) railT = Math.min(railT, (TABLE_H - BALL_R - cue.y) / dy);
  if (dy < 0) railT = Math.min(railT, (BALL_R - cue.y) / dy);
  railT = Math.max(0, railT);

  if (!best || best.t > railT) {
    return { contact: { x: cue.x + dx * railT, y: cue.y + dy * railT }, target: null, targetDir: null };
  }

  const contact = { x: cue.x + dx * best.t, y: cue.y + dy * best.t };
  const nx = best.ball.x - contact.x;
  const ny = best.ball.y - contact.y;
  const n = Math.hypot(nx, ny) || 1;
  return { contact, target: best.ball, targetDir: { x: nx / n, y: ny / n } };
}

// ---- Computer opponent ------------------------------------------------------
/**
 * Pick a shot for the seat to move: every legal ball into every pocket is
 * scored on cut angle, distance and whether both paths are clear; the best one
 * wins, with a wobble scaled by `skill` (0..1, higher = steadier). When nothing
 * is on, it plays a soft legal safety instead of fouling.
 *
 * With ball in hand it first samples spots on the table and keeps the one that
 * opens up the best shot — the same thing a human does with the cue ball.
 *
 * @returns {{angle: number, power: number, spin: {x,y}, place: {x,y}|null}}
 */
export function planShot(engine, skill = 0.72) {
  let place = null;
  if (engine.ballInHand) {
    place = bestPlacement(engine);
    if (place) { engine.cue.x = place.x; engine.cue.y = place.y; }
  }

  const shot = bestShot(engine) || safetyShot(engine);
  // Steadier hands aim closer to the ideal line; a shaky one drifts.
  const wobble = (1 - skill) * 0.075 * (Math.random() * 2 - 1);
  return {
    angle: shot.angle + wobble,
    power: clamp(shot.power, 0.12, 1),
    spin: { x: 0, y: 0 },
    place,
  };
}

function bestShot(engine) {
  const cue = engine.cue;
  const targets = engine.active().filter((b) => b.id !== 0 && engine.isLegalTarget(b));
  let best = null;

  for (const ball of targets) {
    for (const pocket of POCKETS) {
      const px = pocket.x - ball.x;
      const py = pocket.y - ball.y;
      const pd = Math.hypot(px, py);
      if (pd < 1) continue;
      const ux = px / pd;
      const uy = py / pd;

      // Ghost ball: where the cue ball must be at contact to send the object
      // ball straight at the pocket.
      const gx = ball.x - ux * BALL_R * 2;
      const gy = ball.y - uy * BALL_R * 2;
      const ax = gx - cue.x;
      const ay = gy - cue.y;
      const ad = Math.hypot(ax, ay);
      if (ad < BALL_R) continue;

      const cut = (ax / ad) * ux + (ay / ad) * uy;   // cos of the cut angle
      if (cut < 0.28) continue;                       // thinner than ~74°: forget it
      if (!pathClear(engine, cue.x, cue.y, gx, gy, [0, ball.id])) continue;
      if (!pathClear(engine, ball.x, ball.y, pocket.x, pocket.y, [ball.id])) continue;

      // Prefer straight, short shots; the 8-ball is worth reaching for.
      const score = cut * 2.2 - ad / TABLE_W - pd / TABLE_W + (ball.group === "eight" ? 0.5 : 0);
      if (!best || score > best.score) {
        const need = (ad + pd) / TABLE_W;            // rough power for the distance
        best = {
          score,
          angle: Math.atan2(ay, ax),
          power: clamp(0.3 + need * 0.42 + (1 - cut) * 0.3, 0.25, 0.95),
        };
      }
    }
  }
  return best;
}

// Nothing potable: roll gently into the nearest legal ball so the shot is at
// least legal (contact + the object ball almost always finds a rail).
function safetyShot(engine) {
  const cue = engine.cue;
  const targets = engine.active().filter((b) => b.id !== 0 && engine.isLegalTarget(b));
  let pick = null;
  for (const b of targets) {
    const d = dist(cue.x, cue.y, b.x, b.y);
    const clear = pathClear(engine, cue.x, cue.y, b.x, b.y, [0, b.id]);
    const score = (clear ? 0 : 4000) + d;
    if (!pick || score < pick.score) pick = { score, ball: b, d };
  }
  if (!pick) return { angle: 0, power: 0.5 };
  return {
    angle: Math.atan2(pick.ball.y - cue.y, pick.ball.x - cue.x),
    power: clamp(0.3 + pick.d / TABLE_W * 0.45, 0.3, 0.7),
  };
}

// Sample the table for a ball-in-hand spot that leaves the best shot.
function bestPlacement(engine) {
  const cue = engine.cue;
  const from = { x: cue.x, y: cue.y };
  let best = null;
  const cols = 11;
  const rows = 6;
  for (let i = 1; i < cols; i++) {
    for (let j = 1; j < rows; j++) {
      const x = (TABLE_W * i) / cols;
      const y = (TABLE_H * j) / rows;
      if (!engine.canPlace(x, y)) continue;
      cue.x = x;
      cue.y = y;
      const shot = bestShot(engine);
      const score = shot ? shot.score : -99;
      if (!best || score > best.score) best = { score, x, y };
    }
  }
  cue.x = from.x;
  cue.y = from.y;
  return best ? { x: best.x, y: best.y } : null;
}

// Is the corridor between two points free of other balls? (A ball needs two
// radii of clearance to squeeze past.)
function pathClear(engine, x1, y1, x2, y2, ignore) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return true;
  const ux = dx / len;
  const uy = dy / len;
  for (const b of engine.active()) {
    if (ignore.includes(b.id)) continue;
    const t = (b.x - x1) * ux + (b.y - y1) * uy;
    if (t <= 0 || t >= len) continue;
    const perp = Math.abs((b.x - x1) * -uy + (b.y - y1) * ux);
    if (perp < BALL_R * 2) return false;
  }
  return true;
}

// ---- Internals --------------------------------------------------------------
function makeBall(id, x, y) {
  return {
    id,
    group: groupOf(id),
    x, y,
    vx: 0, vy: 0,
    potted: false,
    roll: 0,            // total distance rolled (drives the rolling-ball look)
    spinSide: 0,
    spinVert: 0,
  };
}

function newShotRecord(wasBreak) {
  return {
    wasBreak,
    clearedBefore: false,   // was the shooter already on the 8 before this shot?
    firstContact: null,     // id of the first ball the cue ball touched
    railAfterContact: false,
    potted: [],
    cueScratch: false,
  };
}

// Standard rack: apex on the foot spot, the 8 in the middle of the third row,
// and one solid / one stripe in the back corners. Everything else is shuffled.
function rackPositions() {
  const gap = BALL_R * 2 + 0.35;
  const solids = shuffle([1, 2, 3, 4, 5, 6, 7]);
  const stripes = shuffle([9, 10, 11, 12, 13, 14, 15]);
  const slots = new Array(15).fill(0);
  slots[4] = 8;                       // centre of the third row
  slots[10] = solids.pop();           // back-left corner
  slots[14] = stripes.pop();          // back-right corner
  const rest = shuffle([...solids, ...stripes]);
  for (let i = 0; i < slots.length; i++) if (!slots[i]) slots[i] = rest.pop();

  const out = [];
  let n = 0;
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col <= row; col++) {
      out.push({
        id: slots[n++],
        x: FOOT_SPOT + row * gap * 0.866,
        y: TABLE_H / 2 + (col - row / 2) * gap,
      });
    }
  }
  return out;
}

// Is this coordinate inside a pocket mouth (i.e. a gap in the cushion)?
function inMouth(v, pocketCoords) {
  return pocketCoords.some((c) => Math.abs(v - c) < MOUTH);
}

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function dist(x1, y1, x2, y2) { return Math.hypot(x2 - x1, y2 - y1); }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function other(seat) { return seat === 1 ? 2 : 1; }
