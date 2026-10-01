import * as THREE from 'three';
import type RAPIER_API from '@dimforge/rapier3d-compat';
import type { TrackSpec, Attachment } from './spec';

type Rapier = typeof RAPIER_API;

const DS = 2; // sample spacing, meters

export interface TrackSample {
  pos: THREE.Vector3;      // world space (baseY applied)
  tangent: THREE.Vector3;
  right: THREE.Vector3;    // rolled
  up: THREE.Vector3;       // rolled
  yaw: number;
  s: number;
  surfaced: boolean;
  wallL: number;           // cross-section wall heights at this sample
  wallR: number;
  tubeAmt: number;         // 0 = open profile, 1 = fully closed tube
  tubeR: number;           // tube radius being morphed toward
  roll: number;            // frame roll, radians (twist spirals the UVs)
  width: number;           // deck width at this sample (eased per segment)
}

/** Cross-section elevation at lateral u ∈ [-1, 1]: flat deck in the middle,
 *  parabolic rise into the walls over the outer 38% of each half. */
export function wallElev(u: number, wallL: number, wallR: number): number {
  const m = Math.abs(u);
  if (m <= 0.62) return 0;
  const k = (m - 0.62) / 0.38;
  return (u < 0 ? wallL : wallR) * k * k;
}

interface BoostZone { from: number; to: number }

export interface SegmentRange {
  index: number;
  kind: string;
  label: string;
  from: number;
  to: number;
}

export class Track {
  readonly samples: TrackSample[] = [];
  readonly spec: TrackSpec;
  readonly segmentRanges: SegmentRange[] = [];
  private boostZones: BoostZone[] = [];

  constructor(spec: TrackSpec) {
    this.spec = spec;
    this.sample();
  }

  /** Turtle-walk the segments into world-space samples with rolled frames. */
  private sample(): void {
    const spec = this.spec;
    let x = 0, z = 0, y = 0, yaw = 0, s = 0, roll = 0, wl = 0, wr = 0, width = spec.width;
    let tubeAmt = 0, tubeR = 7;
    const raw: Array<{ x: number; y: number; z: number; roll: number; yaw: number; s: number; surfaced: boolean; wl: number; wr: number; tubeAmt: number; tubeR: number; width: number }> = [];
    raw.push({ x, y, z, roll, yaw, s, surfaced: true, wl, wr, tubeAmt, tubeR, width });

    for (let si = 0; si < spec.segments.length; si++) {
      const seg = spec.segments[si];
      const rollStart = roll;
      const rollTarget = seg.kind === 'gap' ? roll : ((seg as { roll?: number }).roll ?? 0);
      const twistRad = THREE.MathUtils.degToRad(seg.twist ?? 0);
      const wlStart = wl, wrStart = wr;
      const wlTarget = seg.kind === 'gap' ? wl : (seg.wallL ?? 0);
      const wrTarget = seg.kind === 'gap' ? wr : (seg.wallR ?? 0);
      const widthStart = width;
      const widthTarget = seg.kind === 'gap' ? width : (seg.width ?? spec.width);
      const tubeStart = tubeAmt;
      const tubeTarget = seg.kind === 'gap' ? tubeAmt : (seg.tube ? 1 : 0);
      if (seg.tube) tubeR = seg.tube;
      const length = seg.kind === 'arc'
        ? Math.abs(THREE.MathUtils.degToRad(seg.angle)) * seg.radius
        : seg.length;
      this.segmentRanges.push({
        index: si,
        kind: seg.kind,
        label: seg.label ?? seg.kind,
        from: s,
        to: s + length,
      });
      // curvature-aware density: keep facet fold angles small so the board
      // never lands across a sharp crease (hills/ramps bend vertically,
      // arcs bend by yaw — cap both at roughly a degree per facet)
      let n = Math.max(2, Math.ceil(length / DS));
      if (seg.kind === 'hill' || seg.kind === 'ramp') n = Math.max(n, Math.ceil(length / 0.6));
      if (seg.kind === 'arc') n = Math.max(n, Math.ceil(Math.abs(seg.angle) / 1.2));
      // twist rotates the tube's facet pattern — sample finely so the
      // interior ridges spiral smoothly instead of jumping per ring
      if (seg.twist) n = Math.max(n, Math.ceil(Math.abs(seg.twist) / 1.5));
      const y0 = y;

      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const ds = length / n;
        if (seg.kind === 'arc') {
          yaw += THREE.MathUtils.degToRad(seg.angle) / n;
        }
        x += -Math.sin(yaw) * ds;
        z += -Math.cos(yaw) * ds;
        if (seg.kind === 'hill') {
          const b = Math.sin(Math.PI * t);
          y = y0 + seg.height * b * b;
        } else if (seg.kind === 'ramp') {
          // parabolic kicker: uniform entry curvature (no smoothstep
          // curvature spike at the base) and full slope AT the lip, so
          // launch ramps actually launch
          y = y0 + seg.rise * t * t;
        }
        // roll, walls, and tube morph ease to targets over the first half;
        // twist adds linearly across the whole segment
        const rt = Math.min(1, t / 0.5);
        const ease = rt * rt * (3 - 2 * rt);
        roll = THREE.MathUtils.lerp(rollStart, THREE.MathUtils.degToRad(rollTarget), ease)
          + twistRad * t;
        wl = THREE.MathUtils.lerp(wlStart, wlTarget, ease);
        wr = THREE.MathUtils.lerp(wrStart, wrTarget, ease);
        width = THREE.MathUtils.lerp(widthStart, widthTarget, ease);
        tubeAmt = THREE.MathUtils.lerp(tubeStart, tubeTarget, ease);
        s += ds;
        raw.push({ x, y, z, roll, yaw, s, surfaced: seg.kind !== 'gap', wl, wr, tubeAmt, tubeR, width });
      }
      // keep roll wrapped so a 360° twist doesn't unwind through the
      // next segment's ease back to 0
      roll = Math.atan2(Math.sin(roll), Math.cos(roll));
      if (seg.kind === 'gap') y = 0; // landings return to deck level
    }

    // build frames (central-difference tangents, then roll about the tangent);
    // clamp the difference window to the same surfaced run so gap-edge
    // discontinuities don't tilt the lip/landing frames
    for (let i = 0; i < raw.length; i++) {
      let ia = Math.max(0, i - 1);
      let ib = Math.min(raw.length - 1, i + 1);
      if (raw[i].surfaced) {
        if (!raw[ia].surfaced) ia = i;
        if (!raw[ib].surfaced) ib = i;
      }
      const a = raw[ia];
      const b = raw[ib === ia ? Math.min(raw.length - 1, i + 1) : ib];
      const tangent = new THREE.Vector3(b.x - a.x, b.y - a.y, b.z - a.z).normalize();
      const r0 = new THREE.Vector3().crossVectors(tangent, new THREE.Vector3(0, 1, 0)).normalize();
      const u0 = new THREE.Vector3().crossVectors(r0, tangent).normalize();
      const c = Math.cos(raw[i].roll), sn = Math.sin(raw[i].roll);
      const right = r0.clone().multiplyScalar(c).addScaledVector(u0, sn).normalize();
      const up = u0.clone().multiplyScalar(c).addScaledVector(r0, -sn).normalize();
      this.samples.push({
        pos: new THREE.Vector3(raw[i].x, raw[i].y + this.spec.baseY, raw[i].z),
        tangent, right, up,
        yaw: raw[i].yaw,
        s: raw[i].s,
        surfaced: raw[i].surfaced,
        wallL: raw[i].wl,
        wallR: raw[i].wr,
        tubeAmt: raw[i].tubeAmt,
        tubeR: raw[i].tubeR,
        roll: raw[i].roll,
        width: raw[i].width,
      });
    }

    for (const att of this.spec.attachments) {
      if (att.kind === 'boost') this.boostZones.push({ from: att.at, to: att.at + att.length });
    }

    // circuit: snap the seam exactly and give both end samples wrap-aware
    // frames so the loop is seamless in geometry and in physics
    if (spec.circuit && this.samples.length > 3) {
      const N = this.samples.length;
      const first = this.samples[0];
      const last = this.samples[N - 1];
      last.pos.copy(first.pos);
      const t = new THREE.Vector3()
        .subVectors(this.samples[1].pos, this.samples[N - 2].pos)
        .normalize();
      const r0 = new THREE.Vector3().crossVectors(t, new THREE.Vector3(0, 1, 0)).normalize();
      const u0 = new THREE.Vector3().crossVectors(r0, t).normalize();
      for (const smp of [first, last]) {
        smp.tangent.copy(t);
        smp.right.copy(r0); // roll/walls/tube are all zero at the seam
        smp.up.copy(u0);
      }
    }
  }

  get totalS(): number {
    return this.samples[this.samples.length - 1].s;
  }

  frameAt(s: number): TrackSample {
    let lo = 0, hi = this.samples.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.samples[mid].s < s) lo = mid + 1; else hi = mid;
    }
    return this.samples[lo];
  }

  /** Nearest sample to a world position, searching around a hint index.
   *  On circuits the search window wraps across the seam. */
  nearest(pos: THREE.Vector3, hintIdx: number): { idx: number; dist: number } {
    const N = this.samples.length;
    let best = hintIdx, bestD = Infinity;
    if (this.spec.circuit) {
      for (let k = -60; k <= 60; k++) {
        const i = (((hintIdx + k) % N) + N) % N;
        const d = this.samples[i].pos.distanceToSquared(pos);
        if (d < bestD) { bestD = d; best = i; }
      }
    } else {
      const lo = Math.max(0, hintIdx - 60);
      const hi = Math.min(N - 1, hintIdx + 60);
      for (let i = lo; i <= hi; i++) {
        const d = this.samples[i].pos.distanceToSquared(pos);
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    return { idx: best, dist: Math.sqrt(bestD) };
  }

  segmentAt(s: number): SegmentRange {
    for (const r of this.segmentRanges) {
      if (s >= r.from && s < r.to) return r;
    }
    return this.segmentRanges[this.segmentRanges.length - 1];
  }

  isOnBoost(s: number, lateral: number): boolean {
    const hw = this.spec.width / 2;
    if (Math.abs(lateral) > hw) return false;
    return this.boostZones.some((z) => s >= z.from && s <= z.to);
  }
}

/* ============================ builder ============================ */

export interface RailLine {
  start: THREE.Vector3;
  end: THREE.Vector3;
  dir: THREE.Vector3;
  length: number;
}

export interface BuiltTrack {
  track: Track;
  mesh: THREE.Mesh;
  rails: RailLine[];
}

export function buildTrack(
  scene: THREE.Scene,
  world: RAPIER_API.World,
  RAPIER: Rapier,
  spec: TrackSpec,
): BuiltTrack {
  const track = new Track(spec);
  const S = track.samples;

  // ---- profile-swept mesh + trimesh collider over surfaced runs ----
  // Each sample sweeps a cross-section: flat deck with walls, blended
  // toward a full cylinder when the sample is inside a tube morph.
  // 29 vertices across keeps tube interior facets shallow (~13°).
  const ACROSS = 29;
  // ONE geometry for visual and collider, with the tube portion built in
  // the UNROLLED frame. Two reasons: a twisted POLYGON's interior ridges
  // rotate like an auger (physics must ride a stationary cylinder), and
  // the tube circle's axis sits a radius above the centerline — rolling
  // the frame would crank that axis around the spline and swing the tube
  // away from where physics says it is. Twist instead spirals the UVs,
  // so the seam light and dashes corkscrew while the steel stays put.
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const Y = new THREE.Vector3(0, 1, 0);
  // circuits: drop the duplicate seam ring and weld the last strip to
  // ring 0 — a zero-width crack at the lap line would catch the board
  const ringCount = spec.circuit ? S.length - 1 : S.length;
  for (let i = 0; i < ringCount; i++) {
    const smp = S[i];
    const hw = smp.width / 2;
    const r0 = new THREE.Vector3().crossVectors(smp.tangent, Y).normalize();
    const u0 = new THREE.Vector3().crossVectors(r0, smp.tangent).normalize();
    for (let j = 0; j < ACROSS; j++) {
      const u = (j / (ACROSS - 1)) * 2 - 1;
      const flatLat = u * hw;
      const flatEl = wallElev(u, smp.wallL, smp.wallR);
      const theta = u * Math.PI;
      const tubeLat = Math.sin(theta) * smp.tubeR;
      const tubeEl = (1 - Math.cos(theta)) * smp.tubeR;
      const a = smp.tubeAmt;
      const p = smp.pos.clone()
        .addScaledVector(smp.right, flatLat * (1 - a))
        .addScaledVector(smp.up, flatEl * (1 - a))
        .addScaledVector(r0, tubeLat * a)
        .addScaledVector(u0, tubeEl * a);
      positions.push(p.x, p.y, p.z);
      uvs.push(j / (ACROSS - 1) + (a * smp.roll) / (Math.PI * 2), smp.s);
    }
    if (i > 0 && smp.surfaced && S[i - 1].surfaced) {
      const row = i * ACROSS, prev = (i - 1) * ACROSS;
      for (let j = 0; j < ACROSS - 1; j++) {
        indices.push(prev + j, prev + j + 1, row + j, prev + j + 1, row + j + 1, row + j);
      }
    }
  }

  if (spec.circuit && S[0].surfaced && S[ringCount - 1].surfaced) {
    const prev = (ringCount - 1) * ACROSS;
    for (let j = 0; j < ACROSS - 1; j++) {
      indices.push(prev + j, prev + j + 1, j, prev + j + 1, j + 1, j);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  const mat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: { uCamPos: { value: new THREE.Vector3() } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vWorld;
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uCamPos;
      varying vec2 vUv;
      varying vec3 vWorld;
      void main() {
        vec3 surface = vec3(0.063, 0.039, 0.157);
        vec3 cyan = vec3(0.0, 0.94, 1.0);
        vec3 magenta = vec3(1.0, 0.18, 0.53);

        // glowing rails at the edges (x wraps: twist spirals it around tubes)
        float x = fract(vUv.x);
        float d = min(x, 1.0 - x);
        float edge = 1.0 - smoothstep(0.0, 0.05, d);
        vec3 col = mix(surface, cyan * 1.7, edge);

        // magenta center dashes
        float center = 1.0 - smoothstep(0.0, 0.018, abs(x - 0.5));
        float dash = step(fract(vUv.y / 9.0), 0.5);
        col = mix(col, magenta * 1.1, center * dash * 0.7);

        // faint cross-ticks every 16 m
        float tick = 1.0 - smoothstep(0.0, fwidth(vUv.y) * 1.6, abs(fract(vUv.y / 16.0) - 0.5) * 16.0);
        col = mix(col, magenta, tick * 0.12);

        float dist = distance(uCamPos, vWorld);
        col = mix(col, vec3(0.24, 0.055, 0.21), smoothstep(140.0, 520.0, dist));

        col = pow(max(col, 0.0), vec3(2.2)); // pre-linearize (see sky.ts)
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  scene.add(mesh);

  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(
    RAPIER.ColliderDesc.trimesh(new Float32Array(positions), new Uint32Array(indices)),
    body,
  );

  // seal the collider tube's seam: with the unrolled collider the seam
  // crack sits fixed at the TOP of the tube; thin boxes close it so a
  // rider carving over the top can't slip through the zero-width crack
  for (let i = 1; i < S.length; i++) {
    const smp = S[i], prev = S[i - 1];
    if (!(smp.surfaced && smp.tubeAmt > 0.9 && prev.tubeAmt > 0.9)) continue;
    const segLen = smp.pos.distanceTo(prev.pos);
    const center = smp.pos.clone().add(prev.pos).multiplyScalar(0.5);
    const tanMid = smp.tangent.clone().add(prev.tangent).normalize();
    const r0 = new THREE.Vector3().crossVectors(tanMid, new THREE.Vector3(0, 1, 0)).normalize();
    const u0 = new THREE.Vector3().crossVectors(r0, tanMid).normalize();
    center.addScaledVector(u0, 2 * smp.tubeR); // seam = top of the circle
    const m = new THREE.Matrix4().makeBasis(r0, u0, new THREE.Vector3().crossVectors(r0, u0));
    const q = new THREE.Quaternion().setFromRotationMatrix(m);
    const seamBody = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(center.x, center.y, center.z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }),
    );
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(0.5, 0.08, segLen / 2 + 0.3),
      seamBody,
    );
  }

  // ---- start / finish gates (circuits have one combined lap line) ----
  addGateBar(scene, track, spec.start, new THREE.Color(0.2, 1.8, 2.0));
  if (!spec.circuit) addGateBar(scene, track, spec.finish, new THREE.Color(2.0, 0.4, 1.1));

  // ---- attachments ----
  const rails: RailLine[] = [];
  for (const att of spec.attachments) buildAttachment(scene, world, RAPIER, track, att, rails);

  return { track, mesh, rails };
}

export function updateTrack(mesh: THREE.Mesh, camPos: THREE.Vector3): void {
  const mat = mesh.material as THREE.ShaderMaterial;
  (mat.uniforms.uCamPos.value as THREE.Vector3).copy(camPos);
}

function addGateBar(scene: THREE.Scene, track: Track, at: number, color: THREE.Color): void {
  const f = track.frameAt(at);
  const hw = track.spec.width / 2;
  const barMat = new THREE.MeshBasicMaterial({ color });
  // deck stripe
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(track.spec.width, 0.1, 1.2), barMat);
  stripe.position.copy(f.pos).addScaledVector(f.up, 0.08);
  stripe.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), f.yaw);
  scene.add(stripe);
  // posts + top bar
  const postGeo = new THREE.BoxGeometry(0.5, 7, 0.5);
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(postGeo, barMat);
    post.position.copy(f.pos).addScaledVector(f.right, side * (hw + 0.8));
    post.position.y += 3.5;
    scene.add(post);
  }
  const top = new THREE.Mesh(new THREE.BoxGeometry(track.spec.width + 2.6, 0.5, 0.5), barMat);
  top.position.copy(f.pos);
  top.position.y += 7;
  top.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), f.yaw);
  scene.add(top);
}

function buildAttachment(
  scene: THREE.Scene,
  world: RAPIER_API.World,
  RAPIER: Rapier,
  track: Track,
  att: Attachment,
  rails: RailLine[],
): void {
  const yawQuat = (yaw: number): THREE.Quaternion =>
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);

  function staticBox(size: [number, number, number], pos: THREE.Vector3, yaw: number, color: number): void {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), new THREE.MeshBasicMaterial({ color }));
    mesh.position.copy(pos);
    mesh.quaternion.copy(yawQuat(yaw));
    scene.add(mesh);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(mesh.geometry as THREE.BoxGeometry),
      new THREE.LineBasicMaterial({ color: 0xff2e88 }),
    );
    edges.position.copy(pos);
    edges.quaternion.copy(mesh.quaternion);
    scene.add(edges);
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(pos.x, pos.y, pos.z)
        .setRotation({ x: mesh.quaternion.x, y: mesh.quaternion.y, z: mesh.quaternion.z, w: mesh.quaternion.w }),
    );
    world.createCollider(RAPIER.ColliderDesc.cuboid(size[0] / 2, size[1] / 2, size[2] / 2), body);
  }

  if (att.kind === 'boost') {
    // glowing chevron ribbon lying on the deck; the effect itself is a
    // trigger zone handled in the game loop via track.isOnBoost
    const from = track.frameAt(att.at);
    const to = track.frameAt(att.at + att.length);
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0.3, 1.9, 2.1),
      transparent: true,
      opacity: 0.85,
    });
    const seg = new THREE.Mesh(
      new THREE.BoxGeometry(track.spec.width * 0.55, 0.08, att.length),
      mat,
    );
    seg.position.copy(from.pos).add(to.pos).multiplyScalar(0.5);
    seg.position.y += 0.1;
    seg.quaternion.copy(yawQuat(from.yaw));
    scene.add(seg);
  } else if (att.kind === 'pylon') {
    const f = track.frameAt(att.at);
    const pos = f.pos.clone().addScaledVector(f.right, att.offset).addScaledVector(f.up, 2);
    staticBox([1.6, 4, 1.6], pos, f.yaw, 0x2b1152);
  } else if (att.kind === 'gate') {
    const f = track.frameAt(att.at);
    const hw = track.spec.width / 2;
    const wallW = hw - att.opening / 2;
    for (const side of [-1, 1]) {
      const centerOff = side * (att.opening / 2 + wallW / 2);
      const pos = f.pos.clone().addScaledVector(f.right, centerOff).addScaledVector(f.up, 1.5);
      staticBox([wallW, 3, 1.2], pos, f.yaw, 0x1a0b33);
    }
  } else if (att.kind === 'rail') {
    const from = track.frameAt(att.at);
    const to = track.frameAt(att.at + att.length);
    const h = att.height ?? 0.8;
    const railStart = from.pos.clone().addScaledVector(from.right, att.offset);
    railStart.y += h;
    const railEnd = to.pos.clone().addScaledVector(from.right, att.offset);
    railEnd.y += h;
    const railDir = railEnd.clone().sub(railStart);
    rails.push({
      start: railStart,
      end: railEnd,
      dir: railDir.clone().normalize(),
      length: railDir.length(),
    });
    const mid = from.pos.clone().add(to.pos).multiplyScalar(0.5)
      .addScaledVector(from.right, att.offset);
    mid.y += h;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.35, 0.3, att.length),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0.2, 1.7, 1.9) }),
    );
    mesh.position.copy(mid);
    mesh.quaternion.copy(yawQuat(from.yaw));
    scene.add(mesh);
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(mid.x, mid.y, mid.z)
        .setRotation({ x: mesh.quaternion.x, y: mesh.quaternion.y, z: mesh.quaternion.z, w: mesh.quaternion.w }),
    );
    world.createCollider(RAPIER.ColliderDesc.cuboid(0.18, 0.15, att.length / 2), body);
    // posts reach from the local surface up to the rail
    const hwTrack = track.spec.width / 2;
    const u = THREE.MathUtils.clamp(att.offset / hwTrack, -1, 1);
    for (const t of [0.15, 0.5, 0.85]) {
      const fr = track.frameAt(att.at + att.length * t);
      const surfaceH = wallElev(u, fr.wallL, fr.wallR);
      const postH = Math.max(0.3, h - surfaceH);
      const p = fr.pos.clone().addScaledVector(fr.right, att.offset);
      const post = new THREE.Mesh(
        new THREE.BoxGeometry(0.25, postH, 0.25),
        new THREE.MeshBasicMaterial({ color: 0x1a0b33 }),
      );
      post.position.copy(p);
      post.position.y += surfaceH + postH / 2;
      scene.add(post);
    }
  }
}
