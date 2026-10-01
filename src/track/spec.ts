/**
 * Track data format. A track is one spline described as a turtle walk
 * (segments), plus attachments placed by arclength. Segments may carry a
 * roll target — the keystone decision from docs/TRACK_ELEMENTS.md: the
 * spline bears full 3D orientation so banks now and twisting tubes later
 * are the same feature at different roll angles.
 *
 * Arclength (`at`) counts along the centerline INCLUDING gaps.
 * Arc angle sign: positive = left turn. Roll sign: positive raises the
 * right edge (so a right-hand banked turn wants negative roll).
 */
export type Segment = (
  | { kind: 'straight'; length: number; roll?: number }
  | { kind: 'arc'; radius: number; angle: number; roll?: number }
  | { kind: 'hill'; length: number; height: number }
  | { kind: 'ramp'; length: number; rise: number }
  | { kind: 'gap'; length: number }
) & { label?: string };

export type Attachment =
  | { kind: 'boost'; at: number; length: number }
  | { kind: 'pylon'; at: number; offset: number }
  | { kind: 'gate'; at: number; opening: number }
  | { kind: 'rail'; at: number; length: number; offset: number };

export interface TrackSpec {
  name: string;
  width: number;
  baseY: number;     // deck height above the void grid
  start: number;     // start-line arclength (timer begins)
  finish: number;    // finish-line arclength (timer ends)
  segments: Segment[];
  attachments: Attachment[];
}

/** Starter track per docs/TRACK_ELEMENTS.md — every element tests an
 *  existing mechanic or forces exactly one new system. */
export const GAUNTLET_PLUS: TrackSpec = {
  name: 'GAUNTLET+',
  width: 16,
  baseY: 8,
  start: 12,
  finish: 753,
  segments: [
    { kind: 'straight', length: 80, label: 'start straight' },        //   0- 80
    { kind: 'hill', length: 52, height: 2.5, label: 'crest' },        //  80-132 (eased for top speed)
    { kind: 'hill', length: 34, height: -1.5, label: 'dip' },         // 132-166
    { kind: 'straight', length: 14, label: 'approach' },              // 166-180
    { kind: 'arc', radius: 110, angle: 45, label: 'sweeper L' },      // 180-266
    { kind: 'straight', length: 20, label: 'link' },                  // 266-286
    { kind: 'arc', radius: 90, angle: -60, roll: -28, label: 'banked sweeper R' }, // 286-380
    { kind: 'straight', length: 30, label: 'roll-out' },              // 380-410
    { kind: 'arc', radius: 70, angle: 22, label: 'chicane L' },       // 410-437
    { kind: 'arc', radius: 70, angle: -22, label: 'chicane R' },      // 437-464
    { kind: 'straight', length: 40, label: 'run-up' },                // 464-504
    { kind: 'ramp', length: 18, rise: 3, label: 'launch ramp' },      // 504-522
    { kind: 'gap', length: 14, label: 'void gap 1' },                 // 522-536
    { kind: 'straight', length: 60, label: 'landing + rail' },        // 536-596
    { kind: 'straight', length: 50, label: 'pylon slalom' },          // 596-646
    { kind: 'straight', length: 25, label: 'pinch gate' },            // 646-671
    { kind: 'ramp', length: 22, rise: 4.5, label: 'big air' },        // 671-693
    { kind: 'gap', length: 20, label: 'void gap 2' },                 // 693-713
    { kind: 'straight', length: 80, label: 'finish straight' },       // 713-793
  ],
  attachments: [
    { kind: 'boost', at: 50, length: 10 },
    { kind: 'rail', at: 545, length: 45, offset: 6.5 },
    { kind: 'pylon', at: 602, offset: -3.5 },
    { kind: 'pylon', at: 614, offset: 3.5 },
    { kind: 'pylon', at: 626, offset: -3.5 },
    { kind: 'pylon', at: 638, offset: 3.5 },
    { kind: 'gate', at: 658, opening: 7 },
  ],
};
