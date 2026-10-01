import type { ModeContext, ModeName, RideMode } from './types';

/** Normal riding: the surface-relative hover physics owned by Rider. */
export class HoverMode implements RideMode {
  readonly name = 'HOVER';
  readonly overridesCamera = false;

  enter(_ctx: ModeContext): void {}

  step(ctx: ModeContext, padBoost: boolean): ModeName | null {
    ctx.rider.stepHover(ctx.input, padBoost);
    return null; // transitions out of hover are decided by the coordinator
  }

  updateCamera(): void {}

  exit(): void {}
}
