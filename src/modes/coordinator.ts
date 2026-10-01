import { FIXED_DT, type ModeContext, type ModeName, type RideMode } from './types';
import { HoverMode } from './hover';
import { GrindMode } from './grind';
import { TubeMode } from './tube';
import { FlightMode } from './flight';

/**
 * Owns the active Ride Mode and all transitions. Modes hand control back
 * by returning the next mode's name from step() (after restoring whatever
 * they hijacked); the coordinator decides entries out of HOVER (tube
 * sensors, rail snaps) and forces HOVER on resets/respawns.
 */
export class ModeCoordinator {
  readonly ctx: ModeContext;

  private hover = new HoverMode();
  private grind = new GrindMode();
  private tube = new TubeMode();
  private flight = new FlightMode();
  private active: RideMode = this.hover;
  private nearHint = 0;

  constructor(ctx: ModeContext) {
    this.ctx = ctx;
  }

  get modeName(): string {
    return this.active.name;
  }

  get cameraOverridden(): boolean {
    return this.active.overridesCamera;
  }

  fixedStep(padBoost: boolean): void {
    this.grind.tickCooldown(FIXED_DT);

    const req = this.active.step(this.ctx, padBoost);
    if (req) {
      this.switchTo(req);
      return;
    }

    if (this.active === this.hover) {
      // tube sensor: fully-closed tube at the rider's track position
      const near = this.ctx.track.nearest(this.ctx.rider.position, this.nearHint);
      this.nearHint = near.idx;
      const smp = this.ctx.track.samples[near.idx];
      if (smp.tubeAmt > 0.95 && near.dist < smp.tubeR * 2.2) {
        this.tube.pendingIdx = near.idx;
        this.switchTo('tube');
        return;
      }
      // rail snap
      const snap = this.grind.trySnap(this.ctx);
      if (snap) {
        this.grind.pendingSnap = snap;
        this.switchTo('grind');
      }
    }
  }

  /** Per-render-frame camera hook. Returns true if the mode drove the camera. */
  frameCamera(dt: number): boolean {
    if (!this.active.overridesCamera) return false;
    this.active.updateCamera(this.ctx, dt);
    return true;
  }

  /** Hard reset (R, respawn): always back to HOVER, cleanly. */
  forceHover(): void {
    if (this.active !== this.hover) {
      this.active.exit(this.ctx);
      this.active = this.hover;
      this.hover.enter(this.ctx);
    }
    this.nearHint = 0;
  }

  private switchTo(name: ModeName): void {
    const target: RideMode =
      name === 'grind' ? this.grind :
      name === 'tube' ? this.tube :
      name === 'flight' ? this.flight :
      this.hover;
    this.active = target;
    target.enter(this.ctx);
  }
}
