import type { ModeContext, ModeName, RideMode } from './types';

/**
 * FLIGHT (stub): free 3D flight — pitch and yaw like StarFox 64's
 * all-range mode. Not implemented yet; this stub exists to prove the
 * Ride Mode architecture holds a second exotic mode.
 *
 * When built, this mode will own: 6-DOF-ish control (pitch/yaw, roll
 * cosmetic), its own gravity model (none, or gentle sink), a trailing
 * flight camera, and entry/exit transitions from designated track zones.
 */
export class FlightMode implements RideMode {
  readonly name = 'FLIGHT';
  readonly overridesCamera = true;

  enter(): void {}

  step(_ctx: ModeContext): ModeName | null {
    return 'hover'; // unimplemented: bail straight back to hover
  }

  updateCamera(): void {}

  exit(): void {}
}
