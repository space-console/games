// RC Rush — pseudo-3D racing model (behind-the-car view). The world is a ribbon
// of segments with curve + elevation; the renderer in app.js projects them with
// a chase camera. The car races an indoor circuit that threads room to room,
// picking up turbo boosters. Pure logic here — no DOM/canvas.
//
// The projection maths (segment ribbon + perspective) is the classic pseudo-3D
// technique; the physics, AI, rooms, boosters, and art are original.

export const SEG = 200;              // world-z length of one segment
export const ROAD = 2000;            // road half-width (world x)
export const WALL_H = 2700;          // room wall height (world y)
export const CAM_HEIGHT = 1000;
export const DRAW_DIST = 200;        // segments drawn ahead
export const LAPS = 3;

const MAX_SPEED = SEG * 62;          // top speed (world-z per second)
const ACCEL = MAX_SPEED / 4.2;
const BRAKE = MAX_SPEED / 1.6;
const DECEL = MAX_SPEED / 6;
const OFFROAD_DECEL = MAX_SPEED / 1.4;
const OFFROAD_LIMIT = MAX_SPEED / 3.4;
const CENTRIFUGAL = 0.32;
const WALL_X = 1.55;                 // how far past the road edge the walls sit
const AI_COUNT = 3;
const BOOST_TIME = 2.4;
const BOOST_MULT = 1.55;

export const CAR_COLORS = ["#39d98a", "#ff5a5a", "#ffcf3f", "#6ca8ff"];
export const CAR_NAMES = ["You", "Blaze", "Bolt", "Nitro"];

// Themed "rooms" the track passes through — each a stretch of the circuit with
// its own floor, wall, and rail colours, so the lap reads as room → room.
export const THEMES = [
  { name: "Kitchen", floor: "#5566d9", floorAlt: "#4b5ac2", grass: "#c8cfd8", grassAlt: "#bcc4cf", rumble: "#eef2f8", lane: "#f2f5fb", wall: "#3f7f8e", wallAlt: "#2f606c", wallTop: "#8fd0dc" },
  { name: "Play Room", floor: "#b8478f", floorAlt: "#a53d80", grass: "#f0d9a8", grassAlt: "#e6cd98", rumble: "#fff2d6", lane: "#fff6e2", wall: "#e08a3c", wallAlt: "#c4762f", wallTop: "#ffcf8f" },
  { name: "Garage", floor: "#4b5566", floorAlt: "#424b5a", grass: "#8a929e", grassAlt: "#7d8590", rumble: "#c7ced8", lane: "#dfe4ec", wall: "#586273", wallAlt: "#464f5e", wallTop: "#9aa4b4" },
  { name: "Garden", floor: "#7a5a3c", floorAlt: "#6d5035", grass: "#3f9a4e", grassAlt: "#379047", rumble: "#e8e2c8", lane: "#f2eede", wall: "#2f7d3e", wallAlt: "#256733", wallTop: "#7fd08a" },
];

// ---- Track construction ---------------------------------------------------
const easeIn = (a, b, p) => a + (b - a) * p * p;
const easeInOut = (a, b, p) => a + (b - a) * (-2 * p * p * p + 3 * p * p);

class TrackBuilder {
  constructor() { this.segments = []; this.theme = 0; }
  lastY() { const s = this.segments; return s.length ? s[s.length - 1].p2.y : 0; }
  add(curve, y) {
    const n = this.segments.length;
    this.segments.push({
      index: n, curve, theme: this.theme,
      p1: { x: 0, y: this.lastY(), z: n * SEG, screen: {}, camz: 0 },
      p2: { x: 0, y, z: (n + 1) * SEG, screen: {}, camz: 0 },
      sprites: [], boosters: [],
    });
  }
  road(enter, hold, leave, curve, height) {
    const startY = this.lastY(), endY = startY + height * SEG;
    const total = enter + hold + leave;
    let n;
    for (n = 0; n < enter; n++) this.add(easeIn(0, curve, n / enter), easeInOut(startY, endY, n / total));
    for (n = 0; n < hold; n++) this.add(curve, easeInOut(startY, endY, (enter + n) / total));
    for (n = 0; n < leave; n++) this.add(easeInOut(curve, 0, n / leave), easeInOut(startY, endY, (enter + hold + n) / total));
  }
  straight(n, h = 0) { this.road(n, n, n, 0, h); }
  curve(n, c, h = 0) { this.road(n, n, n, c, h); }
  setTheme(t) { this.theme = t % THEMES.length; }
}

function buildTrack() {
  const b = new TrackBuilder();
  const ROOM = 96; // segments between doorways (theme changes)
  const plan = [
    () => b.straight(16),
    () => b.curve(18, 3, 0),
    () => b.straight(12, 1.5),
    () => b.curve(16, -4, 0),
    () => b.straight(10, -1.5),
    () => b.curve(20, 2.5, 0),
    () => b.curve(18, -5, 0),
    () => b.straight(12),
    () => b.curve(18, 4, 2),
    () => b.curve(16, -3, -2),
    () => b.straight(10),
    () => b.curve(22, -4.5, 0),
    () => b.curve(14, 5, 0),
    () => b.straight(12),
    () => b.curve(16, -3.5, 1.2),
    () => b.straight(14, -1.2),
  ];
  let nextRoom = ROOM;
  for (const step of plan) {
    step();
    // Flip to the next room theme roughly every ROOM segments (a doorway).
    while (b.segments.length > nextRoom) { b.setTheme(b.theme + 1); nextRoom += ROOM; }
  }
  b.straight(8); // close the loop smoothly
  return b.segments;
}

// ---- Movable actors -------------------------------------------------------
class Actor {
  constructor(index) {
    this.i = index;
    this.isPlayer = index === 0;
    this.color = CAR_COLORS[index % 4];
    this.name = CAR_NAMES[index % 4];
    this.z = 0;              // position along the track (world z)
    this.x = 0;              // lateral position, −1..1 (fraction of ROAD)
    this.speed = 0;
    this.laps = 0;
    this.place = index + 1;
    this.boost = 0;
    this.finished = false; this.finishTime = 0;
    this.skill = 0.9 + index * 0.03;
    this.bump = 0;           // steering kick from a wall/car hit (for view)
  }
  get dist() { return this.laps * 0 + this.z; } // set properly by race via total
}

// ---- Race -----------------------------------------------------------------
export class Race extends EventTarget {
  constructor() {
    super();
    this.segments = buildTrack();
    this.trackLength = this.segments.length * SEG;
    this.state = "ready";
    this.countdown = 3; this._cd = 0; this.time = 0;
    this._scatter();
    this.reset();
  }

  findSegment(z) { return this.segments[Math.floor(z / SEG) % this.segments.length]; }

  _scatter() {
    // Turbo boosters down the middle-ish of the track, and roadside props.
    const N = this.segments.length;
    this.boosterList = [];
    for (let i = 24; i < N - 12; i += 22) {
      const seg = this.segments[i];
      const b = { x: ((i / 22) % 3 - 1) * 0.5, taken: 0 };
      seg.boosters.push(b);
      this.boosterList.push(b);
    }
    const props = ["box", "plant", "cone", "ball", "book"];
    for (let i = 8; i < N; i += 7) {
      const seg = this.segments[i];
      const side = (i % 2 ? 1 : -1) * (1.15 + (i % 3) * 0.12);
      seg.sprites.push({ x: side, kind: props[i % props.length] });
    }
  }

  reset() {
    const actors = [];
    for (let i = 0; i < AI_COUNT + 1; i++) {
      const a = new Actor(i);
      a.z = (this.trackLength - (i + 1) * SEG * 1.4) % this.trackLength;
      a.x = (i % 2 ? 1 : -1) * 0.35;
      a._prevZ = a.z;
      a._dist = 0;
      actors.push(a);
    }
    this.actors = actors;
    this.player = actors[0];
    this.state = "ready";
    this.countdown = 3; this._cd = 0; this.time = 0;
    this.finishOrder = [];
    for (const seg of this.segments) for (const b of seg.boosters) b.taken = 0;
  }

  start() { if (this.state === "ready") { this.state = "countdown"; this.countdown = 3; this._cd = 0; } }

  update(dt, controls) {
    dt = Math.min(dt, 0.045);
    if (this.state === "countdown") {
      this._cd += dt;
      const c = 3 - Math.floor(this._cd);
      if (c !== this.countdown) { this.countdown = c; if (c > 0) this.dispatchEvent(new CustomEvent("beep", { detail: { go: false } })); }
      if (this._cd >= 3) { this.state = "racing"; this.time = 0; this.dispatchEvent(new CustomEvent("beep", { detail: { go: true } })); }
      return;
    }
    if (this.state !== "racing") return;
    this.time += dt;
    for (const b of this.boosterList) if (b.taken > 0) b.taken -= dt; // respawn timers
    this._drive(this.player, controls, dt);
    for (const a of this.actors) if (!a.isPlayer) this._drive(a, this._ai(a), dt);
    this._carCollisions();
    this._standings();
  }

  _drive(a, ctl, dt) {
    if (a.finished) { a.speed *= Math.pow(0.6, dt * 60); this._advance(a, a.speed * dt); return; }
    const seg = this.findSegment(a.z + CAM_HEIGHT); // segment under the car
    const spd = a.speed / MAX_SPEED;
    const dx = dt * 2.4 * spd;
    if (ctl.steer < 0) a.x -= dx; else if (ctl.steer > 0) a.x += dx;
    a.x -= dx * spd * seg.curve * CENTRIFUGAL;      // pushed to the outside of bends

    if (a.boost > 0) a.boost -= dt;
    const top = MAX_SPEED * (a.boost > 0 ? BOOST_MULT : 1);
    if (ctl.throttle > 0) a.speed += (a.boost > 0 ? ACCEL * 1.5 : ACCEL) * dt;
    else if (ctl.throttle < 0) a.speed -= BRAKE * dt;
    else a.speed -= DECEL * dt;

    const offroad = a.x < -1 || a.x > 1;
    if (offroad && a.speed > OFFROAD_LIMIT) a.speed -= OFFROAD_DECEL * dt;
    a.speed = Math.max(0, Math.min(top, a.speed));

    // Room walls: bounce back in, scrub speed.
    if (a.x < -WALL_X) { a.x = -WALL_X; a.speed *= 0.93; a.bump = -1; if (a.isPlayer) this.dispatchEvent(new CustomEvent("crash", {})); }
    else if (a.x > WALL_X) { a.x = WALL_X; a.speed *= 0.93; a.bump = 1; if (a.isPlayer) this.dispatchEvent(new CustomEvent("crash", {})); }
    a.bump *= Math.pow(0.02, dt);

    this._advance(a, a.speed * dt);
    this._pickups(a);
  }

  _advance(a, ds) {
    a.z += ds;
    while (a.z >= this.trackLength) {
      a.z -= this.trackLength; a.laps++;
      if (a.isPlayer && a.laps < LAPS) this.dispatchEvent(new CustomEvent("lap", { detail: { lap: a.laps + 1 } }));
      if (a.laps >= LAPS && !a.finished) {
        a.finished = true; a.finishTime = this.time; this.finishOrder.push(a);
        if (a.isPlayer) { this.state = "finished"; this.dispatchEvent(new CustomEvent("finish", { detail: { place: a.place, time: this.time } })); }
      }
    }
    a._dist = a.laps * this.trackLength + a.z;
  }

  _pickups(a) {
    const seg = this.findSegment(a.z + CAM_HEIGHT);
    for (const b of seg.boosters) {
      if (b.taken > 0) continue;
      if (Math.abs(b.x - a.x) < 0.45) {
        b.taken = 6;                        // seconds until respawn
        a.boost = BOOST_TIME;
        if (a.isPlayer) this.dispatchEvent(new CustomEvent("boost", {}));
      }
    }
  }

  _ai(a) {
    const seg = this.findSegment(a.z + CAM_HEIGHT);
    // Hug the inside of the bend; ease off the throttle for sharp curves.
    const targetX = Math.max(-0.7, Math.min(0.7, -seg.curve * 0.12));
    const steer = targetX > a.x + 0.02 ? 1 : targetX < a.x - 0.02 ? -1 : 0;
    const targetSpeed = MAX_SPEED * a.skill * (1 - Math.min(0.42, Math.abs(seg.curve) * 0.06));
    const gap = (this.player._dist - a._dist) / 4000;
    const throttle = a.speed < targetSpeed * (1 + Math.max(-0.1, Math.min(0.14, gap))) ? 1 : -0.3;
    return { steer, throttle };
  }

  _carCollisions() {
    const A = this.actors;
    for (let i = 0; i < A.length; i++) for (let j = i + 1; j < A.length; j++) {
      const a = A[i], c = A[j];
      let dz = a.z - c.z; if (dz > this.trackLength / 2) dz -= this.trackLength; else if (dz < -this.trackLength / 2) dz += this.trackLength;
      if (Math.abs(dz) < SEG * 1.2 && Math.abs(a.x - c.x) < 0.42) {
        const push = (0.42 - Math.abs(a.x - c.x)) * (a.x < c.x ? -1 : 1) * 0.5;
        a.x += push; c.x -= push;
        const sl = Math.min(a.speed, c.speed) * 0.6;
        a.speed = c.speed = sl;
      }
    }
  }

  _standings() {
    const order = [...this.actors].sort((p, q) => q._dist - p._dist);
    order.forEach((a, i) => { a.place = i + 1; });
  }
}
