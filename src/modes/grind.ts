import * as THREE from 'three';
import type { RailLine } from '../track/builder';
import { METER_GRIND } from '../rider';
import { FIXED_DT, type ModeContext, type ModeName, type RideMode } from './types';

const SNAP_LATERAL = 0.9;  // max sideways distance to the rail line
const SNAP_ABOVE = 1.6;    // may snap from this far above the rail
const SNAP_BELOW = 0.25;   // ... and barely below it
const MIN_SPEED = 3;       // m/s along the rail to engage/stay
const ALIGN = 0.8;         // |v·dir| / |v| — rejects >~36° approaches
const FRICTION = 1.2;      // m/s² bleed while grinding
const RIDE = 0.34;         // board center above the rail center
const COOLDOWN = 0.5;      // s before re-snap after leaving a rail

export interface RailSnap {
  rail: RailLine;
  t: number;
  dir: 1 | -1;
  speed: number;
}

/** Locked to a rail: ride the line, bleed a little speed, jump or run out. */
export class GrindMode implements RideMode {
  readonly name = 'GRIND';
  readonly overridesCamera = false;

  pendingSnap: RailSnap | null = null;

  private rail: RailLine | null = null;
  private t = 0;
  private dir: 1 | -1 = 1;
  private speed = 0;
  private cooldown = 0;
  private jumpHeld = false;

  tickCooldown(dt: number): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
  }

  /** Entry detection, consulted by the coordinator while HOVER is active. */
  trySnap(ctx: ModeContext): RailSnap | null {
    if (this.cooldown > 0 || ctx.rails.length === 0) return null;
    const vel = ctx.rider.body.linvel();
    const v = new THREE.Vector3(vel.x, vel.y, vel.z);
    if (v.y > 3) return null; // rising fast — don't yank the rider down mid-jump
    const planar = Math.hypot(v.x, v.z);
    if (planar < MIN_SPEED) return null;
    const pv = ctx.rider.position;

    for (const r of ctx.rails) {
      const along = pv.clone().sub(r.start).dot(r.dir);
      if (along < 0.5 || along > r.length - 0.5) continue;
      const closest = r.start.clone().addScaledVector(r.dir, along);
      const lateral = Math.hypot(pv.x - closest.x, pv.z - closest.z);
      const vert = pv.y - closest.y;
      if (lateral > SNAP_LATERAL) continue;
      if (vert < -SNAP_BELOW || vert > SNAP_ABOVE) continue;
      const alongVel = v.dot(r.dir);
      if (Math.abs(alongVel) < MIN_SPEED) continue;
      if (Math.abs(alongVel) / Math.max(planar, 0.1) < ALIGN) continue;
      return { rail: r, t: along, dir: alongVel >= 0 ? 1 : -1, speed: Math.abs(alongVel) };
    }
    return null;
  }

  enter(ctx: ModeContext): void {
    const snap = this.pendingSnap;
    if (!snap) return;
    this.pendingSnap = null;
    this.rail = snap.rail;
    this.t = snap.t;
    this.dir = snap.dir;
    this.speed = snap.speed;
    this.jumpHeld = ctx.input.jump;
    ctx.rider.bankRailLanding(); // landing ON a rail is always styled
    ctx.rider.toKinematic();
  }

  step(ctx: ModeContext): ModeName | null {
    const r = this.rail;
    if (!r) return 'hover';
    const rider = ctx.rider;

    const railVel = (): THREE.Vector3 =>
      r.dir.clone().multiplyScalar(this.dir * this.speed);

    // jump off
    if (ctx.input.jump && !this.jumpHeld) {
      this.leave(ctx, railVel());
      rider.jumpImpulse();
      return 'hover';
    }
    this.jumpHeld = ctx.input.jump;

    this.speed = Math.max(0, this.speed - FRICTION * FIXED_DT);
    this.t += this.dir * this.speed * FIXED_DT;

    // ran off the end (keep velocity) or stalled out
    if (this.t < 0 || this.t > r.length || this.speed < MIN_SPEED * 0.5) {
      this.leave(ctx, railVel());
      return 'hover';
    }

    const pos = r.start.clone().addScaledVector(r.dir, this.t);
    pos.y += RIDE;
    const yaw = Math.atan2(-r.dir.x * this.dir, -r.dir.z * this.dir);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    rider.driveKinematic(pos, q, this.speed);
    rider.meterCharge(METER_GRIND * FIXED_DT);
    return null;
  }

  updateCamera(): void {}

  exit(ctx: ModeContext): void {
    if (this.rail) this.leave(ctx, new THREE.Vector3());
  }

  private leave(ctx: ModeContext, velocity: THREE.Vector3): void {
    this.rail = null;
    this.cooldown = COOLDOWN;
    ctx.rider.toDynamic(velocity);
  }
}
