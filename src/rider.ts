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
const THRUST = 2600;
const BOOST_MULT = 1.9;
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
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(BOARD_HALF_WIDTH, 0.12, BOARD_HALF_LENGTH)
        .setDensity(60)
        .setFriction(0.1),
      this.body,
    );
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

    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).negate();

    // ---- hover springs at four corners ----
    this.grounded = false;
    const rayDir = { x: 0, y: -1, z: 0 };
    for (const [dz, dx] of CORNERS) {
      const local = new THREE.Vector3(dx, 0, dz).applyQuaternion(q);
      const origin = { x: pos.x + local.x, y: pos.y + local.y + RAY_LIFT, z: pos.z + local.z };
      const ray = new this.RAPIER.Ray(origin, rayDir);
      const hit = this.world.castRay(ray, HOVER_RAY_LENGTH + RAY_LIFT, true, undefined, undefined, undefined, body);
      if (hit) {
        const dist = hit.timeOfImpact - RAY_LIFT; // distance from the board itself
        if (dist < HOVER_RAY_LENGTH) {
          this.grounded = this.grounded || dist < HOVER_REST * 1.4;
          const compression = HOVER_REST - dist;
          // velocity of this corner along the ray
          const av = body.angvel();
          const cornerVel = v.clone().add(
            new THREE.Vector3(av.x, av.y, av.z).cross(local),
          );
          const springForce = SPRING_K * compression - SPRING_DAMP * cornerVel.y;
          if (springForce > 0) {
            const at = { x: pos.x + local.x, y: pos.y + local.y, z: pos.z + local.z };
            body.addForceAtPoint({ x: 0, y: springForce, z: 0 }, at, true);
          }
        }
      }
    }

    // ---- thrust ----
    const thrustMag = THRUST * (input.boost ? BOOST_MULT : 1);
    if (input.thrust !== 0 && this.grounded) {
      const f = forward.clone().multiplyScalar(thrustMag * input.thrust);
      body.addForce({ x: f.x, y: 0, z: f.z }, true);
    }

    // ---- boost pad: free speed regardless of input ----
    if (padBoost && this.grounded) {
      const f = forward.clone().multiplyScalar(THRUST * 1.4);
      body.addForce({ x: f.x, y: 0, z: f.z }, true);
    }

    // ---- carve steering: torque + speed-scaled effectiveness ----
    const planarSpeed = Math.hypot(v.x, v.z);
    this.speed = planarSpeed;
    if (input.steer !== 0) {
      const authority = this.grounded ? 1 : 0.45; // some air control
      body.addTorque({ x: 0, y: YAW_TORQUE * input.steer * authority, z: 0 }, true);
    }

    // ---- lateral grip: carve, don't slide ----
    if (this.grounded) {
      const latVel = right.dot(v);
      const gripForce = right.clone().multiplyScalar(-latVel * LATERAL_GRIP * mass);
      body.addForce({ x: gripForce.x, y: 0, z: gripForce.z }, true);
    }

    // ---- upright stabilization ----
    const correction = new THREE.Vector3().crossVectors(up, new THREE.Vector3(0, 1, 0));
    body.addTorque(
      { x: correction.x * UPRIGHT_K, y: 0, z: correction.z * UPRIGHT_K },
      true,
    );

    // ---- jump (edge-triggered) ----
    if (input.jump && !this.jumpHeld && this.grounded) {
      body.applyImpulse({ x: 0, y: JUMP_IMPULSE, z: 0 }, true);
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

  get heading(): THREE.Vector3 {
    const r = this.body.rotation();
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    f.y = 0;
    return f.lengthSq() > 1e-6 ? f.normalize() : new THREE.Vector3(0, 0, -1);
  }
}
