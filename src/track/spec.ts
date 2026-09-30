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
export type Segment =
  | { kind: 'straight'; length: number; roll?: number }
  | { kind: 'arc'; radius: number; angle: number; roll?: number }
  | { kind: 'hill'; length: number; height: number }
  | { kind: 'ramp'; length: number; rise: number }
  | { kind: 'gap'; length: number };

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
    { kind: 'straight', length: 80 },                    //   0- 80 start straight
    { kind: 'hill', length: 40, height: 2.5 },           //  80-120 crest
    { kind: 'hill', length: 30, height: -1.5 },          // 120-150 dip
    { kind: 'straight', length: 30 },                    // 150-180
    { kind: 'arc', radius: 110, angle: 45 },             // 180-266 sweeper L
    { kind: 'straight', length: 20 },                    // 266-286
    { kind: 'arc', radius: 90, angle: -60, roll: -28 },  // 286-380 banked sweeper R
    { kind: 'straight', length: 30 },                    // 380-410 roll eases out
    { kind: 'arc', radius: 70, angle: 22 },              // 410-437 chicane L
    { kind: 'arc', radius: 70, angle: -22 },             // 437-464 chicane R
    { kind: 'straight', length: 40 },                    // 464-504
    { kind: 'ramp', length: 18, rise: 3 },               // 504-522 launch ramp
    { kind: 'gap', length: 14 },                         // 522-536 void gap
    { kind: 'straight', length: 60 },                    // 536-596 landing + rail
    { kind: 'straight', length: 50 },                    // 596-646 pylon slalom
    { kind: 'straight', length: 25 },                    // 646-671 pinch gate
    { kind: 'ramp', length: 22, rise: 4.5 },             // 671-693 big air
    { kind: 'gap', length: 20 },                         // 693-713 void gap
    { kind: 'straight', length: 80 },                    // 713-793 landing + finish
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
