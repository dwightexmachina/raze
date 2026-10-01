import * as THREE from 'three';
import { BOOST_DRAIN, METER_GRIND } from '../rider';
import { FIXED_DT, type ModeContext, type ModeName, type RideMode } from './types';

const RIDE = 0.55;          // board height above the tube's interior surface
const PHI_RATE = 1.7;       // rad/s circumference speed at full steer
const PHI_BLEND = 0.15;     // per-step blend toward the steer target
const S_ACCEL = 40;         // m/s² thrust along the tube
const S_BOOST = 45;         // extra m/s² while boosting
const S_DRAG = 0.12;        // 1/s mild longitudinal drag
const S_MIN = 4;            // the tube never lets you stall
const S_MAX = 62;
const UNWIND_RATE = 6;      // 1/s: φ decays toward the floor in the exit zone
const CAM_BACK = 8;         // camera sits on the axis this far behind the rider

const Y = new THREE.Vector3(0, 1, 0);

// scratch pool — step runs 60×/s, updateCamera every render frame
const _r0 = new THREE.Vector3();
const _u0 = new THREE.Vector3();
const _center = new THREE.Vector3();
const _radial = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _upB = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _back = new THREE.Vector3();
const _x = new THREE.Vector3();
const _upT = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _qd = new THREE.Quaternion();
const _zero = new THREE.Vector3();

/**
 * TUBE (surface-lock): inside a closed tube, gravity is replaced by a
 * surface lock. The rider lives in (s, φ) — arclength along the axis and
 * angle around the circumference (φ=0 bottom, ±π ceiling). Steering moves
 * around the circumference and HOLDS position anywhere, ceiling included.
 * The camera sits ON the tube axis watching the rider orbit. Approaching
 * the tube's exit morph, φ auto-unwinds to the floor so the rider leaves
 * right-side-up, then control returns to HOVER.
 */
export class TubeMode implements RideMode {
  readonly overridesCamera = true;

  /** RIDER (default): camera rolls so the rider is always at the bottom of
   *  the screen — inverted rider means the whole level renders upside down.
   *  AXIS: roll locked to the world (stable horizon). V toggles; every tube
   *  entry resets to RIDER. */
  private camVariant: 'axis' | 'rider' = 'rider';

  get name(): string {
    return this.camVariant === 'rider' ? 'TUBE·RIDER' : 'TUBE·AXIS';
  }

  cycleCamera(): void {
    this.camVariant = this.camVariant === 'axis' ? 'rider' : 'axis';
  }

  /** Set by the coordinator before switching: nearest-sample index. */
  pendingIdx = 0;

  private engaged = false;
  private s = 0;
  private phi = 0;
  private sSpeed = 0;
  private phiSpeed = 0;
  private camBlend = 0;
  private camStart = new THREE.Vector3();
  private camStartQ = new THREE.Quaternion();
  private camUp = new THREE.Vector3(0, 1, 0); // smoothed roll-up vector

  /** Unrolled frame → writes into the module scratch _r0/_u0. */
  private static frame0(tangent: THREE.Vector3): void {
    _r0.crossVectors(tangent, Y).normalize();
    _u0.crossVectors(_r0, tangent).normalize();
  }

  enter(ctx: ModeContext): void {
    const smp = ctx.track.samples[this.pendingIdx];
    TubeMode.frame0(smp.tangent);
    const R = smp.tubeR;
    _center.copy(smp.pos).addScaledVector(_u0, R);
    const rel = ctx.rider.position.sub(_center);
    this.phi = Math.atan2(rel.dot(_r0), -rel.dot(_u0));

    const vel = ctx.rider.body.linvel();
    _pos.set(vel.x, vel.y, vel.z); // borrow scratch for velocity
    const along = _pos.dot(smp.tangent);
    const sign = along >= 0 ? 1 : -1;
    this.sSpeed = sign * Math.max(Math.abs(along), 6);
    _radial.copy(_r0).multiplyScalar(Math.cos(this.phi))
      .addScaledVector(_u0, Math.sin(this.phi)); // dP/dφ direction
    this.phiSpeed = _pos.dot(_radial) / Math.max(R - RIDE, 1);

    this.s = smp.s;
    this.engaged = true;
    this.camVariant = 'rider'; // every tube entry starts rider-pinned
    this.camBlend = 0;
    this.camStart.copy(ctx.chase.camera.position);
    this.camStartQ.copy(ctx.chase.camera.quaternion);
    this.camUp.copy(_u0);
    ctx.rider.clearAir();
    ctx.rider.toKinematic();
  }

  step(ctx: ModeContext): ModeName | null {
    if (!this.engaged) return 'hover';
    const rider = ctx.rider;
    const input = ctx.input;
    const f = ctx.track.frameAt(this.s);

    // exit zone: the tube is morphing open — unwind φ to the floor so the
    // rider corkscrews down the wall and leaves right-side-up
    if (f.tubeAmt < 0.98) {
      this.phi *= Math.exp(-UNWIND_RATE * FIXED_DT);
      this.phiSpeed *= Math.exp(-8 * FIXED_DT);
    }
    if (f.tubeAmt < 0.7 || (f.tubeAmt < 0.97 && Math.abs(this.phi) < 0.12)) {
      return this.leave(ctx, f.tangent);
    }

    // circumference control: steer moves around the tube; released, you
    // hold position — ceiling included (no gravity in here)
    const targetPhiV = -input.steer * PHI_RATE;
    this.phiSpeed += (targetPhiV - this.phiSpeed) * PHI_BLEND;
    this.phi += this.phiSpeed * FIXED_DT;
    if (this.phi > Math.PI) this.phi -= Math.PI * 2;
    if (this.phi < -Math.PI) this.phi += Math.PI * 2;

    // longitudinal control
    let accel = input.thrust * S_ACCEL;
    rider.boosting = input.boost && rider.meter > 0;
    if (rider.boosting) {
      rider.meter = Math.max(0, rider.meter - BOOST_DRAIN * FIXED_DT);
      accel += S_BOOST;
    }
    this.sSpeed += accel * FIXED_DT;
    this.sSpeed -= this.sSpeed * S_DRAG * FIXED_DT;
    const sign = this.sSpeed >= 0 ? 1 : -1;
    this.sSpeed = sign * THREE.MathUtils.clamp(Math.abs(this.sSpeed), S_MIN, S_MAX);
    this.s += this.sSpeed * FIXED_DT;
    const sEnd = ctx.track.samples[ctx.track.samples.length - 1].s;
    this.s = THREE.MathUtils.clamp(this.s, 1, sEnd - 1);

    // drive the body to the constraint pose (all scratch, no allocations)
    const f2 = ctx.track.frameAt(this.s);
    TubeMode.frame0(f2.tangent);
    const R = f2.tubeR;
    _center.copy(f2.pos).addScaledVector(_u0, R);
    _radial.copy(_r0).multiplyScalar(Math.sin(this.phi))
      .addScaledVector(_u0, -Math.cos(this.phi)); // φ=0 → straight down to the floor
    _pos.copy(_center).addScaledVector(_radial, R - RIDE);
    _upB.copy(_radial).negate(); // board up points at the axis
    _fwd.copy(f2.tangent).multiplyScalar(sign);
    _fwd.addScaledVector(_upB, -_fwd.dot(_upB)).normalize();
    _back.copy(_fwd).negate();
    _x.crossVectors(_upB, _back).normalize();
    _qd.setFromRotationMatrix(_m.makeBasis(_x, _upB, _back));
    rider.driveKinematic(_pos, _qd, Math.abs(this.sSpeed));
    rider.clearAir();
    rider.meterCharge(METER_GRIND * FIXED_DT); // riding the ceiling pays
    return null;
  }

  /**
   * Fixed-axis turret: position = axis point at the rider's axial distance
   * (trailing CAM_BACK), orientation = dead along the tangent with roll
   * locked to the unrolled frame. No lookAt — the rider's φ changes where
   * he appears on the screen circle, never where the camera points, so
   * every cross-section renders as a perfect centered circle.
   */
  updateCamera(ctx: ModeContext, dt: number): void {
    const cam = ctx.chase.camera;
    const sign = this.sSpeed >= 0 ? 1 : -1;
    const backS = THREE.MathUtils.clamp(
      this.s - CAM_BACK * sign, 1,
      ctx.track.samples[ctx.track.samples.length - 1].s - 1,
    );
    const f = ctx.track.frameAt(backS);
    TubeMode.frame0(f.tangent);
    _center.copy(f.pos).addScaledVector(_u0, f.tubeR); // axis position

    // roll: AXIS = world-locked (u0); RIDER = away from the rider, pinning
    // him to the bottom of the screen (inverted rider → inverted level)
    if (this.camVariant === 'rider') {
      _upT.copy(_r0).multiplyScalar(-Math.sin(this.phi)).addScaledVector(_u0, Math.cos(this.phi));
    } else {
      _upT.copy(_u0);
    }
    this.camUp.lerp(_upT, 1 - Math.exp(-dt * 6));
    if (this.camUp.lengthSq() < 1e-4) this.camUp.copy(_r0); // 180° flip guard
    this.camUp.normalize();

    _fwd.copy(f.tangent).multiplyScalar(sign);
    _qd.setFromRotationMatrix(_m.lookAt(_zero.set(0, 0, 0), _fwd, this.camUp));

    this.camBlend = Math.min(1, this.camBlend + dt * 2.5);
    cam.position.copy(_pos.copy(this.camStart).lerp(_center, this.camBlend));
    cam.quaternion.copy(this.camStartQ).slerp(_qd, this.camBlend);
    cam.up.copy(this.camUp);
    cam.fov += (74 - cam.fov) * (1 - Math.exp(-dt * 4));
    cam.updateProjectionMatrix();
  }

  exit(ctx: ModeContext): void {
    if (this.engaged) this.leave(ctx, ctx.track.frameAt(this.s).tangent);
  }

  private leave(ctx: ModeContext, tangent: THREE.Vector3): ModeName {
    this.engaged = false;
    const vel = tangent.clone().multiplyScalar(this.sSpeed);
    ctx.rider.toDynamic(vel);
    // right-side-up, facing travel
    const sign = this.sSpeed >= 0 ? 1 : -1;
    const yaw = Math.atan2(-tangent.x * sign, -tangent.z * sign);
    const q = new THREE.Quaternion().setFromAxisAngle(Y, yaw);
    ctx.rider.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    ctx.chase.resyncFromCamera(ctx.rider.position);
    return 'hover';
  }
}
