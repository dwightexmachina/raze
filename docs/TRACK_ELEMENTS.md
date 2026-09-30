# Raze — Track Element Catalog

The design vocabulary for Raze tracks. Every element below reduces to **one
spline with width, roll, and surface-type parameters, plus attachments**
(rails, pads, hazards, gaps) placed along it. The twisting-tube requirement
(see *Wall & Tube*) is what forces the spline to carry full 3D orientation —
roll included — from day one; once it does, banks, wall-rides, corkscrews,
and loops are the same feature at different roll angles.

Phase tags: **P1** = starter track · **P2** = second wave · **P3** = later.

---

## 1. Flow elements — the track itself

| Element | Role | Engine implication | Phase |
|---|---|---|---|
| **Straight** | Recovery, top speed, combat aiming | Trivial | P1 |
| **Sweeper** | Long wide-radius curve at full lean — the core carve feel | Spline curvature | P1 |
| **Hairpin** | Tight low-speed drift check | Spline curvature | P2 |
| **Bank / berm** | Tilted corner surface; keep speed through the turn | **Spline roll parameter** | P1 |
| **Chicane** | Quick left-right jink; turn-in rhythm test | Spline curvature | P1 |
| **Crest / dip** | Vertical undulation: crests give free airtime, dips compress the hover springs | Spline elevation | P1 |

## 2. Air elements

| Element | Role | Engine implication | Phase |
|---|---|---|---|
| **Launch ramp** | Controlled air, trick window, landing zone | Pitched segment | P1 |
| **Big-air jump** | Ramp + void: combo hangtime, real miss cost | Segment + kill zone | P1 |
| **Step-down / drop** | Track falls away, no ramp; landing recovery test | Elevation discontinuity | P2 |
| **Gap jump** | Void in the track; jump or die | Segment gap + kill zone | P1 |
| **Trick bowl** | Basin with kickers on all sides; mid-track free-play | Custom mesh zone | P3 |

## 3. Grind elements

| Element | Role | Engine implication | Phase |
|---|---|---|---|
| **Rail line** | Grindable rail: shortcut, gap crossing, or score line | Rail attachment + grind mechanic | P1 geometry, P2 mechanic |
| **Ledge grind** | The track's own lip as a grindable surface | Edge detection | P2 |
| **Rail transfer** | Hop between adjacent rails mid-grind; expert lines | Grind mechanic v2 | P3 |

## 4. Wall & tube elements — where gravity gets interesting

| Element | Role | Engine implication | Phase |
|---|---|---|---|
| **Wall-ride** | Brief vertical panel riding; gateway to the pipe | Surface-relative hover | P2 |
| **Half-pipe** | U-channel: climb transitions, carve wall-to-wall, air off the lip | Surface-relative hover + camera roll | P2 |
| **Twisting tube / full-pipe** | The Sonic 2 special-stage fantasy: the track becomes a tube that corkscrews, banks past vertical, dives and climbs while the rider carves its inner surface, momentum pinning them to the wall. The game's signature spectacle. | **Surface-relative gravity**: hover along local surface normal, "down" = track under you + centripetal force, camera rolls with the tube. Must be designed in, not bolted on — hence the roll-bearing spline from day one. | P2 |
| **Loop** | Full vertical circle | Free once tubes work (a pipe with 360° of pitch) | P3 |

## 5. Hazards & gates

| Element | Role | Engine implication | Phase |
|---|---|---|---|
| **Pylon / obstacle** | Static object to thread; collision costs speed | Static collider | P1 |
| **Pinch gate** | Narrowing that forces a line; combat chokepoint | Static colliders | P1 |
| **Moving hazard** | Sweepers, crushers, traffic; timing puzzles | Kinematic bodies | P3 |
| **Kill zone** | Void / off-track; falling out resets to track | **Respawn system** | P1 |

## 6. Pickups & pads

| Element | Role | Engine implication | Phase |
|---|---|---|---|
| **Boost pad** | Free speed on (or deliberately off) the racing line | Trigger volume | P1 |
| **Trick zone** | Scoring-multiplier stretch rewarding airtime routes | Trigger volume + scoring | P3 |
| **Weapon / item node** | Combat-layer pickup, placed to create contention | Trigger volume + items | P3 |

## 7. Routing structure

| Element | Role | Engine implication | Phase |
|---|---|---|---|
| **Fork / rejoin** | Alternate lines (safe / rail / jump) with measurable trade-offs | Multi-spline graph | P2 |
| **Shortcut** | Hidden or high-skill connection | Multi-spline graph | P3 |
| **Vertical layering** | Track crossing over itself; upper line via ramp or pipe lip | 3D spline (already supported) | P3 |

---

## Starter track proposal — "Gauntlet+"

**Selection rule:** every included element either (a) tests a mechanic the
sandbox already has, or (b) forces exactly **one** new system into existence —
never two at once.

New systems the starter track forces, deliberately:

1. **The roll-bearing spline track builder** — forced by including one banked
   sweeper. The bank isn't there for fun; it's there to push the roll
   parameter through the entire pipeline (geometry, collider, rendering) while
   the angle is still mild. This is the keystone decision that makes
   half-pipes and Sonic tubes a P2 content problem instead of a rewrite.
2. **Trigger volumes** — forced by one boost pad (also the basis for every
   later pickup).
3. **Respawn / kill zones** — forced the moment the track is a ribbon with
   edges instead of an infinite plane.

**Composition, in ride order** (~1.3 km):

| # | Element | Why here |
|---|---|---|
| 1 | Start straight | Baseline speed, spawn |
| 2 | Boost pad | First trigger volume, immediately felt |
| 3 | Crest + dip | Suspension feel; free from spline elevation |
| 4 | Sweeper L | First real carve on a bounded track |
| 5 | **Banked sweeper R (30°)** | The keystone: roll through the pipeline |
| 6 | Chicane | Turn-in rhythm after the banks |
| 7 | Launch ramp → gap jump | Jump arc + landing + first kill zone |
| 8 | Rail line (straight, beside track) | Geometry now, grind mechanic P2 |
| 9 | Pylon slalom | Collision feel at speed |
| 10 | Pinch gate | Line pressure; combat chokepoint preview |
| 11 | Big-air ramp | Hangtime finale; trick-system test bed later |
| 12 | Finish | Timing gate — lap/segment times make all tuning measurable |

**Explicitly deferred:** hairpins (need drift tuning first), half-pipes and
tubes (P2 — needs surface-relative gravity, but the spline is ready for
them), forks (routing matters once times matter), moving hazards, trick
bowls, items.
