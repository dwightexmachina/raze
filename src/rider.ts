import * as THREE from 'three';
import type RAPIER_API from '@dimforge/rapier3d-compat';
import { makeGlowTexture } from './matcap';
import type { Input } from './input';
import type { RailLine } from './track/builder';

type Rapier = typeof RAPIER_API;

// The 19' glider: ~5.8 m long in world units.
const BOARD_HALF_LENGTH = 2.9;
const BOARD_HALF_WIDTH = 0.38;

// Hover tuning
const HOVER_REST = 0.9;          // target ride height per corner ray
const HOVER_RAY_LENGTH = 2.2;
// rays start this far above the board so a nose that dips slightly into a
// rising deck still sees the surface and gets pushed back out
const RAY_LIFT = 1.2;
const SPRING_K = 900;            // N/m per corner
const SPRING_DAMP = 130;
// progressive stiffening: spring force multiplies by (1 + PROG·ratio²) as
// compression approaches bottom-out, so high-speed concave transitions and
// hard landings are absorbed instead of slamming the slab into the deck
const SPRING_PROG = 3.5;
const THRUST = 2600;
// quadratic aero drag on planar velocity → real terminal speed:
// ~160 km/h flat-out, ~230 km/h boosted
const DRAG_K = 1.35;

// Boost economy: SHIFT spends the meter, tricks and grinding fill it
const BOOST_FORCE = 3000;        // N along the deck while boosting
const BOOST_DRAIN = 30;          // meter/s while boosting
const METER_GRIND = 9;           // meter/s while grinding
const GRAB_RATE = 18;            // meter/s of grab airtime (on clean landing)
const SPIN_POINTS: Array<[number, number]> = [
  [900, 100], [720, 70], [540, 45], [360, 26], [180, 12],
];
const AIR_SPIN_RATE = 9.5;       // rad/s target while steering in air (~515°/s effective)
const AIR_SPIN_SNAP = 0.45;      // per-step blend toward the target rate
const YAW_TORQUE = 950;
const LATERAL_GRIP = 9.0;        // 1/s — how fast sideways velocity dies
const UPRIGHT_K = 620;
const JUMP_IMPULSE = 620;

// Snap-grind tuning
const GRIND_SNAP_LATERAL = 0.9;  // max sideways distance to the rail line
const GRIND_SNAP_ABOVE = 1.6;    // may snap from this far above the rail
const GRIND_SNAP_BELOW = 0.25;   // ... and barely below it
const GRIND_MIN_SPEED = 3;       // m/s along the rail to engage/stay
const GRIND_ALIGN = 0.8;         // |v·dir| / |v| — rejects >~36° approaches
const GRIND_FRICTION = 1.2;      // m/s² bleed while grinding
const GRIND_RIDE = 0.34;         // board center above the rail center
const GRIND_COOLDOWN = 0.5;      // s before re-snap after leaving a rail
const FIXED_DT = 1 / 60;

const CORNERS: Array<[number, number]> = [
  [-BOARD_HALF_LENGTH * 0.75, -BOARD_HALF_WIDTH],
  [-BOARD_HALF_LENGTH * 0.75, BOARD_HALF_WIDTH],
  [BOARD_HALF_LENGTH * 0.75, -BOARD_HALF_WIDTH],
  [BOARD_HALF_LENGTH * 0.75, BOARD_HALF_WIDTH],
];

export interface TrickEvent {
  label: string;
  gain: number;
  quality: 'CLEAN' | 'SKETCHY' | 'BAIL';
}

export class Rider {
  readonly group = new THREE.Group();
  readonly body: RAPIER_API.RigidBody;
  grounded = false;
  speed = 0;
  /** Boost meter, 0-100. Starts half-charged so boost is discoverable. */
  meter = 50;
  boosting = false;

  private world: RAPIER_API.World;
  private RAPIER: Rapier;
  private leanGroup = new THREE.Group();
  private jumpHeld = false;

  // grind state
  private rails: RailLine[] = [];
  private grindRail: RailLine | null = null;
  private grindT = 0;
  private grindDir = 1;
  private grindSpeed = 0;
  private grindCool = 0;

  // air/trick state
  private wasGrounded = true;
  private airTime = 0;
  private airSpin = 0;      // accumulated yaw while airborne, radians
  private grabTime = 0;
  private grabActive = false;
  private pendingTrick: TrickEvent | null = null;

  constructor(
    scene: THREE.Scene,
    world: RAPIER_API.World,
    RAPIER: Rapier,
    matcap: THREE.Texture,
  ) {
    this.world = world;
    this.RAPIER = RAPIER;

    const chrome = new THREE.MeshMatcapMaterial({ matcap });

    // ---- board: flattened ellipsoid = instant longboard ----
    const board = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), chrome);
    board.scale.set(BOARD_HALF_WIDTH, 0.09, BOARD_HALF_LENGTH);
    this.leanGroup.add(board);

    // fin near the tail
    const fin = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.5, 8), chrome);
    fin.rotation.x = Math.PI; // point down
    fin.position.set(0, -0.3, BOARD_HALF_LENGTH * 0.72);
    this.leanGroup.add(fin);

    // ---- placeholder Herald (real mesh drops in later) ----
    const herald = new THREE.Group();
    // legs
    const legGeo = new THREE.CapsuleGeometry(0.09, 0.55, 4, 10);
    const legL = new THREE.Mesh(legGeo, chrome);
    legL.position.set(-0.12, 0.48, -0.45);
    legL.rotation.x = 0.18;
    herald.add(legL);
    const legR = new THREE.Mesh(legGeo, chrome);
    legR.position.set(0.12, 0.48, 0.45);
    legR.rotation.x = -0.18;
    herald.add(legR);
    // torso
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.5, 4, 12), chrome);
    torso.position.set(0, 1.15, 0);
    torso.rotation.x = 0.1;
    herald.add(torso);
    // arms out, surf stance
    const armGeo = new THREE.CapsuleGeometry(0.06, 0.5, 4, 8);
    const armL = new THREE.Mesh(armGeo, chrome);
    armL.position.set(-0.05, 1.32, -0.42);
    armL.rotation.set(Math.PI / 2.4, 0, 0.3);
    herald.add(armL);
    const armR = new THREE.Mesh(armGeo, chrome);
    armR.position.set(0.05, 1.28, 0.42);
    armR.rotation.set(-Math.PI / 2.6, 0, -0.3);
    herald.add(armR);
    // Helm head: sphere + swept cone fin trailing aft (+Z is the tail)
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 12), chrome);
    head.position.set(0, 1.62, 0);
    herald.add(head);
    const crest = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.42, 10), chrome);
    crest.rotation.x = Math.PI / 2 + 0.25; // sweep back and slightly up
    crest.position.set(0, 1.66, 0.22);
    herald.add(crest);
    this.leanGroup.add(herald);

    // ---- cyan underglow sprite ----
    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: makeGlowTexture(),
        color: 0x00f0ff,
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    glow.scale.set(6.5, 2.2, 1);
    glow.position.y = -0.35;
    this.leanGroup.add(glow);

    this.group.add(this.leanGroup);
    scene.add(this.group);

    // ---- physics body ----
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(0, 2.5, 20)
        .setAngularDamping(3.0)
        .setLinearDamping(0.12)
        .setCcdEnabled(true), // don't tunnel through the thin track shell
    );
    // Rockered hull: a shorter main slab plus upswept nose/tail tips, so
    // rising terrain meets an angled surface that deflects the board up
    // instead of a square edge that acts as a brake (real boards have
    // rocker for exactly this reason).
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(BOARD_HALF_WIDTH, 0.1, BOARD_HALF_LENGTH * 0.8)
        .setDensity(60)
        .setFriction(0.1),
      this.body,
    );
    const ROCKER = 0.38; // rad (~22°) tip upsweep — must out-angle any slope
    for (const end of [-1, 1]) { // -1 = nose (-Z), +1 = tail
      const qr = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -end * ROCKER);
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(BOARD_HALF_WIDTH * 0.9, 0.08, 0.75)
          .setTranslation(0, 0.26, end * (BOARD_HALF_LENGTH * 0.8 + 0.6))
          .setRotation({ x: qr.x, y: qr.y, z: qr.z, w: qr.w })
          .setDensity(30)
          .setFriction(0.05),
        this.body,
      );
    }
  }

  setRails(rails: RailLine[]): void {
    this.rails = rails;
  }

  get grinding(): boolean {
    return this.grindRail !== null;
  }

  /** One-shot trick result for the HUD toast. */
  consumeTrick(): TrickEvent | null {
    const t = this.pendingTrick;
    this.pendingTrick = null;
    return t;
  }

  /** Teleport the rider (spawn/respawn) facing `yaw`, velocities zeroed. */
  setPose(pos: THREE.Vector3, yaw: number): void {
    this.grindRail = null;
    this.grindCool = 0;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.body.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, true);
    this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  /** One fixed physics step's worth of control + hover forces. */
  step(input: Input, padBoost = false): void {
    const body = this.body;
    body.resetForces(true);
    body.resetTorques(true);
    this.grindCool = Math.max(0, this.grindCool - FIXED_DT);

    if (this.grindRail) {
      this.stepGrind(input);
      return;
    }

    const rot = body.rotation();
    const q = new THREE.Quaternion(rot.x, rot.y, rot.z, rot.w);
    const pos = body.translation();
    const vel = body.linvel();
    const v = new THREE.Vector3(vel.x, vel.y, vel.z);
    const mass = body.mass();

    // Board frame — the whole model is SURFACE-RELATIVE, not world-vertical:
    // rays cast along board-down, springs push along board-up, damping only
    // fights along-normal velocity (so climbing a slope isn't punished),
    // and thrust acts along the deck plane.
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(q).normalize();
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
    const av = body.angvel();
    const angvel = new THREE.Vector3(av.x, av.y, av.z);

    // ---- hover springs at four corners, along the board normal ----
    this.grounded = false;
    const rayDir = { x: -up.x, y: -up.y, z: -up.z };
    const normalSum = new THREE.Vector3();
    let hits = 0;
    for (const [dz, dx] of CORNERS) {
      const local = new THREE.Vector3(dx, 0, dz).applyQuaternion(q);
      const origin = {
        x: pos.x + local.x + up.x * RAY_LIFT,
        y: pos.y + local.y + up.y * RAY_LIFT,
        z: pos.z + local.z + up.z * RAY_LIFT,
      };
      const ray = new this.RAPIER.Ray(origin, rayDir);
      const hit = this.world.castRayAndGetNormal(
        ray, HOVER_RAY_LENGTH + RAY_LIFT, true, undefined, undefined, undefined, body,
      );
      if (hit) {
        const dist = hit.timeOfImpact - RAY_LIFT; // distance from the board itself
        if (dist < HOVER_RAY_LENGTH) {
          this.grounded = this.grounded || dist < HOVER_REST * 1.4;
          const n = new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z);
          if (n.dot(up) < 0) n.negate(); // trimesh backface
          normalSum.add(n);
          hits++;
          const compression = HOVER_REST - dist;
          const cornerVel = v.clone().add(angvel.clone().cross(local));
          const ratio = Math.max(0, compression / HOVER_REST);
          const springForce =
            SPRING_K * compression * (1 + SPRING_PROG * ratio * ratio) -
            SPRING_DAMP * cornerVel.dot(up);
          if (springForce > 0) {
            body.addForceAtPoint(
              { x: up.x * springForce, y: up.y * springForce, z: up.z * springForce },
              { x: pos.x + local.x, y: pos.y + local.y, z: pos.z + local.z },
              true,
            );
          }
        }
      }
    }
    const surfaceUp = hits > 0 ? normalSum.normalize() : new THREE.Vector3(0, 1, 0);

    // ---- thrust along the deck plane (climbs hills instead of plowing) ----
    if (input.thrust !== 0 && this.grounded) {
      const f = forward.clone().multiplyScalar(THRUST * input.thrust);
      body.addForce({ x: f.x, y: f.y, z: f.z }, true);
    }

    // ---- boost: spends the meter, earned back by tricks and grinding ----
    this.boosting = input.boost && this.meter > 0;
    if (this.boosting) {
      this.meter = Math.max(0, this.meter - BOOST_DRAIN * FIXED_DT);
      if (this.grounded) {
        const f = forward.clone().multiplyScalar(BOOST_FORCE);
        body.addForce({ x: f.x, y: f.y, z: f.z }, true);
      }
    }

    // ---- boost pad: free speed regardless of input ----
    if (padBoost && this.grounded) {
      const f = forward.clone().multiplyScalar(THRUST * 1.4);
      body.addForce({ x: f.x, y: f.y, z: f.z }, true);
    }

    // ---- aero drag (planar only; mostly off in the air so jumps carry) ----
    const planarSpeed = Math.hypot(v.x, v.z);
    this.speed = planarSpeed;
    if (planarSpeed > 0.5) {
      const k = DRAG_K * (this.grounded ? 1 : 0.2);
      body.addForce(
        { x: -v.x * k * planarSpeed, y: 0, z: -v.z * k * planarSpeed },
        true,
      );
    }

    // ---- carve steering: torque + speed-scaled effectiveness ----
    if (this.grounded) {
      if (input.steer !== 0) {
        // carve: yaw torque around the BOARD's up axis (works on walls/pipes)
        const tq = YAW_TORQUE * input.steer;
        body.addTorque({ x: up.x * tq, y: up.y * tq, z: up.z * tq }, true);
      }
    } else {
      // air spin is rate-controlled, arcade-style: steer drives yaw rate
      // toward ±AIR_SPIN_RATE, release snaps it back to zero — precise
      // 360s instead of fighting the plank's inertia
      const targetW = input.steer * AIR_SPIN_RATE;
      const wUp = angvel.dot(up);
      const newWUp = wUp + (targetW - wUp) * AIR_SPIN_SNAP;
      const w = angvel.clone().addScaledVector(up, newWUp - wUp);
      body.setAngvel({ x: w.x, y: w.y, z: w.z }, true);
    }

    // ---- lateral grip: carve, don't slide ----
    if (this.grounded) {
      const latVel = right.dot(v);
      const gripForce = right.clone().multiplyScalar(-latVel * LATERAL_GRIP * mass);
      body.addForce({ x: gripForce.x, y: gripForce.y, z: gripForce.z }, true);
    }

    // ---- upright stabilization: align to the surface under the board
    // (banks and slopes), or to world-up when airborne ----
    const uprightTarget = this.grounded ? surfaceUp : new THREE.Vector3(0, 1, 0);
    const correction = new THREE.Vector3().crossVectors(up, uprightTarget);
    body.addTorque(
      { x: correction.x * UPRIGHT_K, y: correction.y * UPRIGHT_K, z: correction.z * UPRIGHT_K },
      true,
    );

    // ---- jump (edge-triggered), along the board normal ----
    if (input.jump && !this.jumpHeld && this.grounded) {
      body.applyImpulse(
        { x: up.x * JUMP_IMPULSE, y: up.y * JUMP_IMPULSE, z: up.z * JUMP_IMPULSE },
        true,
      );
    }
    this.jumpHeld = input.jump;

    // ---- air/trick accounting ----
    this.grabActive = false;
    if (!this.grounded) {
      this.airTime += FIXED_DT;
      this.airSpin += av.y * FIXED_DT;
      if (input.jump && this.airTime > 0.15) {
        this.grabTime += FIXED_DT;
        this.grabActive = true;
      }
    } else if (!this.wasGrounded) {
      this.settleAir(false, forward, v, av.y);
    }
    this.wasGrounded = this.grounded;

    this.trySnapToRail(v);
  }

  /** Judge and bank an air on landing (or on snapping to a rail). */
  private settleAir(
    ontoRail: boolean,
    forward?: THREE.Vector3,
    v?: THREE.Vector3,
    spinRate = 0,
  ): void {
    if (this.airTime > 0.35) {
      const deg = Math.abs(this.airSpin) * (180 / Math.PI);
      const spins = Math.floor((deg + 60) / 180) * 180; // generous snap to 180s
      let spinPts = 0;
      for (const [d, pts] of SPIN_POINTS) {
        if (spins >= d) { spinPts = pts; break; }
      }
      const grabPts = Math.round(this.grabTime * GRAB_RATE);

      let quality: TrickEvent['quality'] = 'CLEAN';
      if (!ontoRail && forward && v) {
        const pv = new THREE.Vector3(v.x, 0, v.z);
        if (pv.length() > 4) {
          // |cos| → nose OR tail along travel counts (switch landings are legal)
          const align = Math.abs(pv.normalize()
            .dot(new THREE.Vector3(forward.x, 0, forward.z).normalize()));
          if (align < Math.cos(1.2)) quality = 'BAIL';          // >~70° sideways
          else if (align < Math.cos(0.6) || Math.abs(spinRate) > 3.2) quality = 'SKETCHY';
        }
      }

      let gain = spinPts + grabPts;
      if (quality === 'SKETCHY') gain = Math.round(gain * 0.5);
      if (quality === 'BAIL') {
        gain = 0;
        const vv = this.body.linvel();
        this.body.setLinvel({ x: vv.x * 0.55, y: vv.y, z: vv.z * 0.55 }, true);
      }
      this.meter = Math.min(100, this.meter + gain);

      if (spins >= 180 || grabPts > 0 || quality !== 'CLEAN') {
        const parts: string[] = [];
        if (spins >= 180) parts.push(String(spins));
        if (grabPts > 0) parts.push('GRAB');
        if (ontoRail) parts.push('RAIL');
        this.pendingTrick = {
          label: parts.join(' + ') || 'LANDED',
          gain,
          quality,
        };
      }
    }
    this.airTime = 0;
    this.airSpin = 0;
    this.grabTime = 0;
    this.grabActive = false;
  }

  /** Locked to a rail: ride the line, bleed a little speed, jump or run out. */
  private stepGrind(input: Input): void {
    const r = this.grindRail!;
    const body = this.body;

    if (input.jump && !this.jumpHeld) {
      this.jumpHeld = input.jump;
      this.exitGrind();
      body.applyImpulse({ x: 0, y: JUMP_IMPULSE, z: 0 }, true);
      return;
    }
    this.jumpHeld = input.jump;

    this.grindSpeed = Math.max(0, this.grindSpeed - GRIND_FRICTION * FIXED_DT);
    this.grindT += this.grindDir * this.grindSpeed * FIXED_DT;

    // ran off the end (keep velocity) or stalled out
    if (this.grindT < 0 || this.grindT > r.length || this.grindSpeed < GRIND_MIN_SPEED * 0.5) {
      this.exitGrind();
      return;
    }

    const pos = r.start.clone().addScaledVector(r.dir, this.grindT);
    pos.y += GRIND_RIDE;
    body.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, true);
    const vel = r.dir.clone().multiplyScalar(this.grindDir * this.grindSpeed);
    body.setLinvel({ x: vel.x, y: vel.y, z: vel.z }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    const yaw = Math.atan2(-r.dir.x * this.grindDir, -r.dir.z * this.grindDir);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);

    this.grounded = true;
    this.wasGrounded = true;
    this.speed = this.grindSpeed;
    this.meter = Math.min(100, this.meter + METER_GRIND * FIXED_DT);
  }

  private exitGrind(): void {
    this.grindRail = null;
    this.grindCool = GRIND_COOLDOWN;
  }

  /** Snap on when passing over a rail roughly along its axis. */
  private trySnapToRail(v: THREE.Vector3): void {
    if (this.grindCool > 0 || this.rails.length === 0) return;
    if (v.y > 3) return; // rising fast — don't yank the rider down mid-jump
    const p = this.body.translation();
    const pv = new THREE.Vector3(p.x, p.y, p.z);
    const planar = Math.hypot(v.x, v.z);
    if (planar < GRIND_MIN_SPEED) return;

    for (const r of this.rails) {
      const along = pv.clone().sub(r.start).dot(r.dir);
      if (along < 0.5 || along > r.length - 0.5) continue;
      const closest = r.start.clone().addScaledVector(r.dir, along);
      const lateral = Math.hypot(pv.x - closest.x, pv.z - closest.z);
      const vert = pv.y - closest.y;
      if (lateral > GRIND_SNAP_LATERAL) continue;
      if (vert < -GRIND_SNAP_BELOW || vert > GRIND_SNAP_ABOVE) continue;
      const alongVel = v.dot(r.dir);
      if (Math.abs(alongVel) < GRIND_MIN_SPEED) continue;
      if (Math.abs(alongVel) / Math.max(planar, 0.1) < GRIND_ALIGN) continue;

      this.settleAir(true); // landing ON a rail is always a styled landing
      this.grindRail = r;
      this.grindDir = alongVel >= 0 ? 1 : -1;
      this.grindSpeed = Math.abs(alongVel);
      this.grindT = along;
      return;
    }
  }

  /** Sync visuals to physics, add carve lean. */
  syncVisual(input: Input): void {
    const pos = this.body.translation();
    const rot = this.body.rotation();
    this.group.position.set(pos.x, pos.y, pos.z);
    this.group.quaternion.set(rot.x, rot.y, rot.z, rot.w);

    // cosmetic roll into the carve, tuck pitch while grabbing
    const targetLean = input.steer * Math.min(this.speed / 30, 1) * 0.45;
    this.leanGroup.rotation.z += (targetLean - this.leanGroup.rotation.z) * 0.12;
    const targetTuck = this.grabActive ? -0.32 : 0;
    this.leanGroup.rotation.x += (targetTuck - this.leanGroup.rotation.x) * 0.15;
  }

  get position(): THREE.Vector3 {
    const p = this.body.translation();
    return new THREE.Vector3(p.x, p.y, p.z);
  }

  get boardUp(): THREE.Vector3 {
    const r = this.body.rotation();
    return new THREE.Vector3(0, 1, 0)
      .applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w));
  }

  get heading(): THREE.Vector3 {
    const r = this.body.rotation();
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    f.y = 0;
    return f.lengthSq() > 1e-6 ? f.normalize() : new THREE.Vector3(0, 0, -1);
  }
}
