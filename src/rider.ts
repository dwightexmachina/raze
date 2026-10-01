import * as THREE from 'three';
import type RAPIER_API from '@dimforge/rapier3d-compat';
import { makeGlowTexture } from './matcap';
import type { Input } from './input';

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
const BOOST_MULT = 1.9;
// quadratic aero drag on planar velocity → real terminal speed:
// ~160 km/h flat-out, ~215 km/h boosted
const DRAG_K = 1.35;
const YAW_TORQUE = 950;
const LATERAL_GRIP = 9.0;        // 1/s — how fast sideways velocity dies
const UPRIGHT_K = 620;
const JUMP_IMPULSE = 620;

const CORNERS: Array<[number, number]> = [
  [-BOARD_HALF_LENGTH * 0.75, -BOARD_HALF_WIDTH],
  [-BOARD_HALF_LENGTH * 0.75, BOARD_HALF_WIDTH],
  [BOARD_HALF_LENGTH * 0.75, -BOARD_HALF_WIDTH],
  [BOARD_HALF_LENGTH * 0.75, BOARD_HALF_WIDTH],
];

export class Rider {
  readonly group = new THREE.Group();
  readonly body: RAPIER_API.RigidBody;
  grounded = false;
  speed = 0;

  private world: RAPIER_API.World;
  private RAPIER: Rapier;
  private leanGroup = new THREE.Group();
  private jumpHeld = false;

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

  /** Teleport the rider (spawn/respawn) facing `yaw`, velocities zeroed. */
  setPose(pos: THREE.Vector3, yaw: number): void {
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
    const thrustMag = THRUST * (input.boost ? BOOST_MULT : 1);
    if (input.thrust !== 0 && this.grounded) {
      const f = forward.clone().multiplyScalar(thrustMag * input.thrust);
      body.addForce({ x: f.x, y: f.y, z: f.z }, true);
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
    if (input.steer !== 0) {
      const authority = this.grounded ? 1 : 0.45; // some air control
      // yaw around the BOARD's up axis, so carving works on walls and pipes
      const tq = YAW_TORQUE * input.steer * authority;
      body.addTorque({ x: up.x * tq, y: up.y * tq, z: up.z * tq }, true);
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
  }

  /** Sync visuals to physics, add carve lean. */
  syncVisual(input: Input): void {
    const pos = this.body.translation();
    const rot = this.body.rotation();
    this.group.position.set(pos.x, pos.y, pos.z);
    this.group.quaternion.set(rot.x, rot.y, rot.z, rot.w);

    // cosmetic roll into the carve
    const targetLean = input.steer * Math.min(this.speed / 30, 1) * 0.45;
    this.leanGroup.rotation.z += (targetLean - this.leanGroup.rotation.z) * 0.12;
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
