import type { Rider } from '../rider';
import type { Track, RailLine } from '../track/builder';
import type { Input } from '../input';
import type { ChaseCamera } from '../camera';

export const FIXED_DT = 1 / 60;

export type ModeName = 'hover' | 'grind' | 'tube' | 'flight';

export interface ModeContext {
  rider: Rider;
  track: Track;
  rails: RailLine[];
  input: Input;
  chase: ChaseCamera;
}

/**
 * A Ride Mode owns the full traversal contract while active: physics
 * stepping, what input means, camera behavior, and its own entry/exit
 * cleanup. Transitions: step() returns the next mode's name after the
 * mode has restored any state it hijacked (body type, camera), or the
 * coordinator forces 'hover' on reset/respawn via exit().
 */
export interface RideMode {
  readonly name: string;
  /** When true the coordinator calls updateCamera instead of the chase rig. */
  readonly overridesCamera: boolean;
  enter(ctx: ModeContext): void;
  step(ctx: ModeContext, padBoost: boolean): ModeName | null;
  updateCamera(ctx: ModeContext, dt: number): void;
  /** Optional: cycle between the mode's own camera variants (V key). */
  cycleCamera?(): void;
  /** Idempotent: restore anything hijacked (called on forced resets). */
  exit(ctx: ModeContext): void;
}
