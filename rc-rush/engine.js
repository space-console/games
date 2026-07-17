// RC Rush — race model: track geometry, arcade car physics, AI, and race state.
// Pure logic (no DOM/canvas) so the renderer in app.js is a thin view over it.
//
// World units are "centimetres-ish"; the renderer scales them to pixels. The
// car is modelled with a simple forward/lateral grip split so it drifts under
// the handbrake and grips on the racing line — the classic arcade feel.

export const LAPS = 3;
export const ROAD_HALF = 165;          // half road width (full grip band)
const SHOULDER = 95;                    // grass margin beyond the road before a wall
const WALL_HALF = ROAD_HALF + SHOULDER; // hard wall distance from centreline
const AI_COUNT = 3;
const CAR_RADIUS = 34;                  // for car-car separation

export const CAR_COLORS = ["#39d98a", "#ff5a5a", "#ffcf3f", "#6ca8ff"];
export const CAR_NAMES = ["You", "Blaze", "Bolt", "Nitro"];

// Hand-authored circuit centreline (closed loop, clockwise). Catmull-Rom smooths
// these into a dense polyline used for rendering, grip, laps, and AI targets.
const CONTROL = [
  [720, 540], [1250, 470], [1760, 660], [2260, 470], [2830, 520], [3320, 700],
  [3500, 1060], [3440, 1520], [3520, 2010],
  [3200, 2360], [2600, 2420], [2300, 2080], [1870, 2400], [1260, 2400], [790, 2280],
  [520, 1900], [600, 1400], [480, 900],
];

// ---- Track construction ---------------------------------------------------
function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return [
    0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
    0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
  ];
}

function buildTrack(control, steps = 16) {
  const n = control.length;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const p0 = control[(i - 1 + n) % n], p1 = control[i], p2 = control[(i + 1) % n], p3 = control[(i + 2) % n];
    for (let j = 0; j < steps; j++) pts.push(catmull(p0, p1, p2, p3, j / steps));
  }
  const N = pts.length;
  const seglen = new Array(N), cum = new Array(N);
  let total = 0;
  for (let i = 0; i < N; i++) {
    const a = pts[i], b = pts[(i + 1) % N];
    cum[i] = total;
    seglen[i] = Math.hypot(b[0] - a[0], b[1] - a[1]);
    total += seglen[i];
  }
  return { pts, seglen, cum, length: total };
}

export class Track {
  constructor() {
    const t = buildTrack(CONTROL);
    this.pts = t.pts;
    this.seglen = t.seglen;
    this.cum = t.cum;
    this.length = t.length;
    this.roadHalf = ROAD_HALF;
    this.wallHalf = WALL_HALF;
  }

  // Nearest point on the centreline to (x,y). Returns arc-length s, the signed
  // lateral offset (left −, right + relative to travel), and the outward unit
  // normal from centreline to the car — everything grip/lap/wall logic needs.
  project(x, y) {
    const pts = this.pts, N = pts.length;
    let best = Infinity, bi = 0, bt = 0, bpx = 0, bpy = 0, btx = 1, bty = 0;
    for (let i = 0; i < N; i++) {
      const a = pts[i], b = pts[(i + 1) % N];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy || 1;
      let t = ((x - a[0]) * dx + (y - a[1]) * dy) / len2;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const px = a[0] + dx * t, py = a[1] + dy * t;
      const d2 = (x - px) * (x - px) + (y - py) * (y - py);
      if (d2 < best) { best = d2; bi = i; bt = t; bpx = px; bpy = py; btx = dx; bty = dy; }
    }
    const tl = Math.hypot(btx, bty) || 1;
    const tx = btx / tl, ty = bty / tl;           // unit tangent (travel direction)
    // Lateral offset: cross product sign of tangent × (car − proj).
    const ox = x - bpx, oy = y - bpy;
    const cross = tx * oy - ty * ox;               // + = right of travel
    const dist = Math.hypot(ox, oy);
    const s = this.cum[bi] + bt * this.seglen[bi];
    return { s, lateral: cross, dist, px: bpx, py: bpy, tx, ty, nx: dist ? ox / dist : 0, ny: dist ? oy / dist : 0 };
  }

  pointAt(s) {
    const L = this.length;
    s = ((s % L) + L) % L;
    const pts = this.pts, N = pts.length;
    // Binary-ish scan (linear is fine at this resolution).
    let i = 0;
    while (i < N - 1 && this.cum[i + 1] <= s) i++;
    const t = this.seglen[i] ? (s - this.cum[i]) / this.seglen[i] : 0;
    const a = pts[i], b = pts[(i + 1) % N];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }
}

// ---- Car ------------------------------------------------------------------
class Car {
  constructor(x, y, angle, index) {
    this.i = index;
    this.isPlayer = index === 0;
    this.color = CAR_COLORS[index % CAR_COLORS.length];
    this.name = CAR_NAMES[index % CAR_NAMES.length];
    this.x = x; this.y = y;
    this.angle = angle;
    this.vx = 0; this.vy = 0;
    this.steer = 0;              // smoothed steering, for wheel rendering
    this.slip = 0;              // |lateral velocity|, drives skids/smoke
    this.onGrass = false;
    this.s = 0; this.prevS = 0; this.dist = 0; this.laps = 0;
    this.place = index + 1;
    this.finished = false; this.finishTime = 0;
    this.aiSkill = 0.86 + index * 0.045;  // rivals vary a touch
    this.aiJitter = 0;
  }
  get speed() { return Math.hypot(this.vx, this.vy); }
}

// ---- Race -----------------------------------------------------------------
export class Race extends EventTarget {
  constructor() {
    super();
    this.track = new Track();
    this.state = "ready";        // ready → countdown → racing → finished
    this.countdown = 3;
    this._cd = 0;
    this.time = 0;
    this.cars = [];
    this.reset();
  }

  reset() {
    const tr = this.track;
    // Grid: line the cars up just behind the start/finish (s = 0), staggered.
    const cars = [];
    for (let i = 0; i < AI_COUNT + 1; i++) {
      const back = 70 + Math.floor(i / 2) * 150;
      const sPos = ((-back) % tr.length + tr.length) % tr.length;
      const [cx, cy] = tr.pointAt(sPos);
      const [ax, ay] = tr.pointAt(sPos + 8);
      const ang = Math.atan2(ay - cy, ax - cx);
      const nx = -Math.sin(ang), ny = Math.cos(ang);
      const lane = (i % 2 === 0 ? -1 : 1) * 55;
      const car = new Car(cx + nx * lane, cy + ny * lane, ang, i);
      const p = tr.project(car.x, car.y);
      car.s = p.s; car.prevS = p.s; car.dist = 0;
      cars.push(car);
    }
    this.cars = cars;
    this.player = cars[0];
    this.state = "ready";
    this.countdown = 3; this._cd = 0; this.time = 0;
    this.finishOrder = [];
  }

  start() {
    if (this.state !== "ready") return;
    this.state = "countdown";
    this.countdown = 3; this._cd = 0;
  }

  update(dt, playerControls) {
    dt = Math.min(dt, 0.045);
    if (this.state === "countdown") {
      this._cd += dt;
      const c = 3 - Math.floor(this._cd);
      if (c !== this.countdown) {
        this.countdown = c;
        if (c > 0) this.dispatchEvent(new CustomEvent("beep", { detail: { go: false } }));
      }
      if (this._cd >= 3) {
        this.state = "racing"; this.time = 0;
        this.dispatchEvent(new CustomEvent("beep", { detail: { go: true } }));
      }
      // Cars idle on the grid during the countdown.
      for (const car of this.cars) this._integrate(car, { throttle: 0, steer: 0, handbrake: true }, dt);
      return;
    }
    if (this.state !== "racing") return;

    this.time += dt;
    for (const car of this.cars) {
      if (car.finished) { this._integrate(car, { throttle: 0, steer: 0, handbrake: false }, dt); }
      else {
        const controls = car.isPlayer ? playerControls : this._ai(car);
        this._integrate(car, controls, dt);
      }
      this._trackContact(car);
      this._progress(car);
    }
    this._separate();
    this._standings();
  }

  // ---- Physics ------------------------------------------------------------
  _integrate(car, ctl, dt) {
    const cos = Math.cos(car.angle), sin = Math.sin(car.angle);
    let vf = car.vx * cos + car.vy * sin;      // forward speed
    let vs = -car.vx * sin + car.vy * cos;     // lateral (rightward) speed

    const ENGINE = 3050, BRAKE = 4200, REVERSE = 1500;
    const throttle = ctl.throttle || 0;
    if (throttle > 0) vf += ENGINE * throttle * dt;
    else if (throttle < 0) {
      if (vf > 5) vf -= BRAKE * (-throttle) * dt;
      else vf += REVERSE * throttle * dt;
    }

    // Drag + rolling resistance (grass adds a lot). Terminal speed emerges here.
    const grass = car.onGrass;
    const linDrag = grass ? 3.4 : 1.15;
    const quadDrag = grass ? 0.0012 : 0.00055;
    vf -= (vf * linDrag + Math.sign(vf) * vf * vf * quadDrag) * dt;

    // Lateral grip: how much sideways velocity is retained per frame. Lower =
    // grippier. Handbrake and grass loosen it so the tail steps out (drift).
    const speed = Math.hypot(vf, vs);
    let retain = grass ? 0.90 : 0.80;
    if (ctl.handbrake) retain = 0.975;
    vs *= Math.pow(retain, dt * 60);
    car.slip = Math.abs(vs);

    // Steering: scales in with speed (can't turn parked) and reverses in reverse.
    const steerLock = 3.0;
    const gripSteer = Math.min(1, speed / 210);
    const dir = vf >= 0 ? 1 : -1;
    const steer = ctl.steer || 0;
    car.steer += (steer - car.steer) * Math.min(1, dt * 12); // smooth for wheels
    car.angle += steer * steerLock * gripSteer * dir * dt;

    // Reassemble world velocity.
    const c2 = Math.cos(car.angle), s2 = Math.sin(car.angle);
    car.vx = vf * c2 - vs * s2;
    car.vy = vf * s2 + vs * c2;
    car.x += car.vx * dt;
    car.y += car.vy * dt;
  }

  _trackContact(car) {
    const p = this.track.project(car.x, car.y);
    car.onGrass = p.dist > this.track.roadHalf;
    if (p.dist > this.track.wallHalf) {
      // Push back to the wall and kill outward velocity (a soft bounce).
      const overshoot = p.dist - this.track.wallHalf;
      car.x -= p.nx * overshoot;
      car.y -= p.ny * overshoot;
      const vn = car.vx * p.nx + car.vy * p.ny;   // outward velocity component
      if (vn > 0) {
        car.vx -= p.nx * vn * 1.4;
        car.vy -= p.ny * vn * 1.4;
        if (vn > 140 && car.isPlayer) this.dispatchEvent(new CustomEvent("crash", { detail: { speed: vn } }));
      }
    }
    car._proj = p;
  }

  _progress(car) {
    const L = this.track.length;
    const s = car._proj ? car._proj.s : car.s;
    let ds = s - car.prevS;
    if (ds > L / 2) ds -= L; else if (ds < -L / 2) ds += L;
    car.dist += ds;
    car.prevS = s; car.s = s;
    const laps = Math.floor(car.dist / L);
    if (laps > car.laps && car.dist > 0) {
      car.laps = laps;
      if (car.isPlayer && car.laps < LAPS) this.dispatchEvent(new CustomEvent("lap", { detail: { lap: car.laps + 1 } }));
    }
    if (!car.finished && car.dist >= L * LAPS) {
      car.finished = true; car.finishTime = this.time;
      this.finishOrder.push(car);
      if (car.isPlayer) {
        this.state = "finished";
        this.dispatchEvent(new CustomEvent("finish", { detail: { place: car.place, time: this.time } }));
      }
    }
  }

  // Pure-pursuit AI: aim at a point down the racing line, ease off for bends,
  // and rubber-band gently so the pack stays close.
  _ai(car) {
    const tr = this.track;
    const look = 240 + car.speed * 0.42;
    const [tx, ty] = tr.pointAt(car.s + look);
    let da = Math.atan2(ty - car.y, tx - car.x) - car.angle;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    const steer = Math.max(-1, Math.min(1, da * 2.2));
    // Slow for sharp corrections; rubber-band vs. the player.
    let throttle = 1 - Math.min(0.72, Math.abs(da) * 1.15);
    const gap = (this.player.dist - car.dist) / 1000;
    throttle *= car.aiSkill + Math.max(-0.12, Math.min(0.18, gap * 0.12));
    if (car.speed < 40) throttle = 1;
    const handbrake = Math.abs(da) > 1.15 && car.speed > 320;
    return { throttle: Math.max(0, Math.min(1, throttle)), steer, handbrake };
  }

  _separate() {
    const cars = this.cars;
    for (let a = 0; a < cars.length; a++) {
      for (let b = a + 1; b < cars.length; b++) {
        const A = cars[a], B = cars[b];
        const dx = B.x - A.x, dy = B.y - A.y;
        const d = Math.hypot(dx, dy) || 1;
        const min = CAR_RADIUS * 2;
        if (d < min) {
          const nx = dx / d, ny = dy / d, push = (min - d) / 2;
          A.x -= nx * push; A.y -= ny * push;
          B.x += nx * push; B.y += ny * push;
          // Trade a little velocity along the contact normal.
          const va = A.vx * nx + A.vy * ny, vb = B.vx * nx + B.vy * ny;
          const t = (vb - va) * 0.5;
          A.vx += nx * t; A.vy += ny * t;
          B.vx -= nx * t; B.vy -= ny * t;
        }
      }
    }
  }

  _standings() {
    const order = [...this.cars].sort((a, b) => b.dist - a.dist);
    order.forEach((c, i) => { c.place = i + 1; });
  }
}
