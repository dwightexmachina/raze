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

  /** AXIS: roll locked to the world (stable horizon). RIDER: camera rolls
   *  so the rider is always at the bottom of the screen — inverted rider
   *  means the whole level renders upside down. V toggles. */
  private camVariant: 'axis' | 'rider' = 'axis';

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

  private static frame0(tangent: THREE.Vector3): { r0: THREE.Vector3; u0: THREE.Vector3 } {
    const r0 = new THREE.Vector3().crossVectors(tangent, Y).normalize();
    const u0 = new THREE.Vector3().crossVectors(r0, tangent).normalize();
    return { r0, u0 };
  }

  enter(ctx: ModeContext): void {
    const smp = ctx.track.samples[this.pendingIdx];
    const { r0, u0 } = TubeMode.frame0(smp.tangent);
    const R = smp.tubeR;
    const center = smp.pos.clone().addScaledVector(u0, R);
    const rel = ctx.rider.position.sub(center);
    this.phi = Math.atan2(rel.dot(r0), -rel.dot(u0));

    const vel = ctx.rider.body.linvel();
    const v = new THREE.Vector3(vel.x, vel.y, vel.z);
    const along = v.dot(smp.tangent);
    const sign = along >= 0 ? 1 : -1;
    this.sSpeed = sign * Math.max(Math.abs(along), 6);
    const dPhiDir = r0.clone().multiplyScalar(Math.cos(this.phi))
      .addScaledVector(u0, Math.sin(this.phi));
    this.phiSpeed = v.dot(dPhiDir) / Math.max(R - RIDE, 1);

    this.s = smp.s;
    this.engaged = true;
    this.camBlend = 0;
    this.camStart.copy(ctx.chase.camera.position);
    this.camStartQ.copy(ctx.chase.camera.quaternion);
    this.camUp.copy(u0);
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

    // drive the body to the constraint pose
    const f2 = ctx.track.frameAt(this.s);
    const { r0, u0 } = TubeMode.frame0(f2.tangent);
    const R = f2.tubeR;
    const center = f2.pos.clone().addScaledVector(u0, R);
    const radial = r0.clone().multiplyScalar(Math.sin(this.phi))
      .addScaledVector(u0, -Math.cos(this.phi)); // φ=0 → straight down to the floor
    const pos = center.clone().addScaledVector(radial, R - RIDE);
    const upB = radial.clone().negate(); // board up points at the axis
    const fwd = f2.tangent.clone().multiplyScalar(sign);
    fwd.addScaledVector(upB, -fwd.dot(upB)).normalize();
    const back = fwd.clone().negate();
    const xAxis = new THREE.Vector3().crossVectors(upB, back).normalize();
    const q = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(xAxis, upB, back),
    );
    rider.driveKinematic(pos, q, Math.abs(this.sSpeed));
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
    const { r0, u0 } = TubeMode.frame0(f.tangent);
    const axisPos = f.pos.clone().addScaledVector(u0, f.tubeR); // ON the axis

    // roll: AXIS = world-locked (u0); RIDER = away from the rider, pinning
    // him to the bottom of the screen (inverted rider → inverted level)
    const upTarget = this.camVariant === 'rider'
      ? r0.clone().multiplyScalar(-Math.sin(this.phi)).addScaledVector(u0, Math.cos(this.phi))
      : u0;
    this.camUp.lerp(upTarget, 1 - Math.exp(-dt * 6));
    if (this.camUp.lengthSq() < 1e-4) this.camUp.copy(r0); // 180° flip guard
    this.camUp.normalize();

    const fwd = f.tangent.clone().multiplyScalar(sign);
    const qT = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().lookAt(new THREE.Vector3(), fwd, this.camUp),
    );

    this.camBlend = Math.min(1, this.camBlend + dt * 2.5);
    cam.position.copy(this.camStart.clone().lerp(axisPos, this.camBlend));
    cam.quaternion.copy(this.camStartQ).slerp(qT, this.camBlend);
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
