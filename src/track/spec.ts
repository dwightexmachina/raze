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
) & {
  label?: string;
  /** Wall heights per side — the cross-section profile. 0 = flat deck edge;
   *  ~6-7 = ridable wall. Both sides raised = half-pipe channel. Values
   *  ease in over the segment like roll does. */
  wallL?: number;
  wallR?: number;
  /** Full-tube radius: the cross-section closes into a cylinder of this
   *  radius (rider rides the inside). Morphs in/out over the segment. */
  tube?: number;
  /** Extra roll applied linearly across the segment, degrees — corkscrews.
   *  Inside a tube the geometry is invariant; the seam and dashes spiral. */
  twist?: number;
};

export type Attachment =
  | { kind: 'boost'; at: number; length: number }
  | { kind: 'pylon'; at: number; offset: number }
  | { kind: 'gate'; at: number; opening: number }
  | { kind: 'rail'; at: number; length: number; offset: number; height?: number };

export interface TrackSpec {
  name: string;
  width: number;
  baseY: number;     // deck height above the void grid
  start: number;     // start-line arclength (timer begins; lap line on circuits)
  finish: number;    // finish-line arclength (ignored on circuits)
  /** Closed course: the spline must return to its start pose (equal
   *  opposing straights + arcs summing to 360°, elevation net zero).
   *  The seam is welded, progress wraps, and timing becomes laps. */
  circuit?: boolean;
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

/** Second map: wall-rides, a half-pipe with a lip rail, and grind rails.
 *  Exercises the cross-section profile system end to end. */
export const PIPELINE: TrackSpec = {
  name: 'PIPELINE',
  width: 16,
  baseY: 8,
  start: 12,
  finish: 815,
  segments: [
    { kind: 'straight', length: 60, label: 'start straight' },                      //   0- 60
    { kind: 'straight', length: 60, wallR: 7, label: 'wall alley' },                //  60-120
    { kind: 'arc', radius: 100, angle: 35, wallR: 7, label: 'wall carve L' },       // 120-181
    { kind: 'straight', length: 40, label: 'wall release' },                        // 181-221
    { kind: 'straight', length: 70, wallL: 6, wallR: 6, label: 'half-pipe' },       // 221-291
    { kind: 'straight', length: 30, label: 'pipe exit' },                           // 291-321
    { kind: 'straight', length: 25, label: 'tube approach' },                       // 321-346
    { kind: 'straight', length: 40, tube: 7, label: 'tube mouth' },                 // 346-386
    { kind: 'straight', length: 70, tube: 7, twist: 360, label: 'corkscrew' },      // 386-456
    { kind: 'arc', radius: 80, angle: -30, tube: 7, label: 'tube bend R' },         // 456-498
    { kind: 'straight', length: 30, label: 'tube exit' },                           // 498-528
    { kind: 'ramp', length: 20, rise: 3.5, label: 'kicker' },                       // 528-548
    { kind: 'gap', length: 16, label: 'void gap 1' },                               // 548-564
    { kind: 'straight', length: 50, label: 'landing + rail' },                      // 564-614
    { kind: 'arc', radius: 90, angle: -45, roll: -24, label: 'banked sweeper R' },  // 614-685
    { kind: 'straight', length: 40, label: 'run-up' },                              // 685-725
    { kind: 'ramp', length: 24, rise: 5, label: 'big air' },                        // 725-749
    { kind: 'gap', length: 22, label: 'void gap 2' },                               // 749-771
    { kind: 'straight', length: 70, label: 'finish straight' },                     // 771-841
  ],
  attachments: [
    { kind: 'boost', at: 38, length: 10 },
    { kind: 'rail', at: 234, length: 46, offset: -8, height: 6.4 },  // half-pipe lip grind
    { kind: 'rail', at: 572, length: 34, offset: 5, height: 0.8 },   // landing ground rail
    { kind: 'boost', at: 700, length: 10 },
    { kind: 'pylon', at: 785, offset: -3.5 },
    { kind: 'pylon', at: 799, offset: 3.5 },
  ],
};

/** Loop gym: nothing but straights and full tubes. If something breaks
 *  here, it's the tube system and only the tube system. */
export const LOOPER: TrackSpec = {
  name: 'LOOPER',
  width: 16,
  baseY: 8,
  start: 12,
  finish: 410,
  // Design rule: twist only on segments whose tube is already fully formed
  // (give every twisted tube an untwisted mouth segment) — twisting the
  // open-mouth morph corkscrews the half-formed shell.
  segments: [
    { kind: 'straight', length: 50, label: 'start straight' },                     //   0- 50
    { kind: 'straight', length: 50, tube: 7, label: 'tube A' },                    //  50-100
    { kind: 'straight', length: 45, label: 'link 1' },                             // 100-145
    { kind: 'straight', length: 20, tube: 7, label: 'tube B mouth' },              // 145-165
    { kind: 'straight', length: 60, tube: 7, twist: 360, label: 'tube B (corkscrew)' },        // 165-225
    { kind: 'straight', length: 45, label: 'link 2' },                             // 225-270
    { kind: 'straight', length: 20, tube: 7, label: 'tube C mouth' },              // 270-290
    { kind: 'straight', length: 80, tube: 7, twist: 720, label: 'tube C (double corkscrew)' }, // 290-370
    { kind: 'straight', length: 60, label: 'finish straight' },                    // 370-430
  ],
  attachments: [
    { kind: 'boost', at: 26, length: 10 },
  ],
};

/** The everything circuit: a 1.23 km stadium lap — two equal 380 m
 *  straights joined by two 180° banked hairpins (closes exactly by
 *  construction) — carrying every feature in the game. CCW. */
export const OUROBOROS: TrackSpec = {
  name: 'OUROBOROS',
  width: 16,
  baseY: 8,
  start: 8,
  finish: 8,
  circuit: true,
  segments: [
    // ---- front straight (380 m) ----
    { kind: 'straight', length: 40, label: 'start/finish' },                      //    0-  40
    { kind: 'hill', length: 50, height: 2.5, label: 'crest' },                    //   40-  90
    { kind: 'hill', length: 34, height: -1.5, label: 'dip' },                     //   90- 124
    { kind: 'straight', length: 60, label: 'pylon slalom' },                      //  124- 184
    { kind: 'ramp', length: 18, rise: 3, label: 'kicker' },                       //  184- 202
    { kind: 'gap', length: 14, label: 'void gap 1' },                             //  202- 216
    { kind: 'straight', length: 60, label: 'landing + rail' },                    //  216- 276
    { kind: 'straight', length: 34, label: 'pinch gate' },                        //  276- 310
    { kind: 'straight', length: 70, label: 'run-up A' },                          //  310- 380
    { kind: 'arc', radius: 75, angle: 180, roll: 24, label: 'banked hairpin A' }, //  380- 616
    // ---- back straight (380 m) ----
    { kind: 'straight', length: 50, wallR: 7, label: 'wall alley' },              //  616- 666
    { kind: 'straight', length: 20, label: 'wall release' },                      //  666- 686
    { kind: 'straight', length: 70, wallL: 6, wallR: 6, label: 'half-pipe' },     //  686- 756
    { kind: 'straight', length: 24, label: 'pipe exit' },                         //  756- 780
    { kind: 'straight', length: 20, tube: 7, label: 'tube mouth' },               //  780- 800
    { kind: 'straight', length: 70, tube: 7, twist: 360, label: 'corkscrew' },    //  800- 870
    { kind: 'straight', length: 30, label: 'tube exit' },                         //  870- 900
    { kind: 'ramp', length: 24, rise: 5, label: 'big air' },                      //  900- 924
    { kind: 'gap', length: 22, label: 'void gap 2' },                             //  924- 946
    { kind: 'straight', length: 50, label: 'landing B' },                         //  946- 996
    { kind: 'arc', radius: 75, angle: 180, roll: 24, label: 'banked hairpin B' }, //  996-1231
  ],
  attachments: [
    { kind: 'boost', at: 20, length: 10 },
    { kind: 'pylon', at: 134, offset: -3.5 },
    { kind: 'pylon', at: 148, offset: 3.5 },
    { kind: 'pylon', at: 162, offset: -3.5 },
    { kind: 'pylon', at: 176, offset: 3.5 },
    { kind: 'rail', at: 224, length: 34, offset: 5, height: 0.8 },   // landing grind
    { kind: 'gate', at: 292, opening: 7 },
    { kind: 'rail', at: 700, length: 40, offset: -8, height: 6.4 },  // half-pipe lip
    { kind: 'boost', at: 958, length: 10 },
  ],
};
