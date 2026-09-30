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
}

interface BoostZone { from: number; to: number }

export class Track {
  readonly samples: TrackSample[] = [];
  readonly spec: TrackSpec;
  private boostZones: BoostZone[] = [];

  constructor(spec: TrackSpec) {
    this.spec = spec;
    this.sample();
  }

  /** Turtle-walk the segments into world-space samples with rolled frames. */
  private sample(): void {
    const spec = this.spec;
    let x = 0, z = 0, y = 0, yaw = 0, s = 0, roll = 0;
    const raw: Array<{ x: number; y: number; z: number; roll: number; yaw: number; s: number; surfaced: boolean }> = [];
    raw.push({ x, y, z, roll, yaw, s, surfaced: true });

    for (const seg of spec.segments) {
      const rollStart = roll;
      const rollTarget = seg.kind === 'gap' ? roll : ((seg as { roll?: number }).roll ?? 0);
      const length = seg.kind === 'arc'
        ? Math.abs(THREE.MathUtils.degToRad(seg.angle)) * seg.radius
        : seg.length;
      const n = Math.max(2, Math.ceil(length / DS));
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
          y = y0 + seg.rise * (t * t * (3 - 2 * t));
        }
        // roll eases to the segment target over the first half
        const rt = Math.min(1, t / 0.5);
        roll = THREE.MathUtils.lerp(rollStart, THREE.MathUtils.degToRad(rollTarget), rt * rt * (3 - 2 * rt));
        s += ds;
        raw.push({ x, y, z, roll, yaw, s, surfaced: seg.kind !== 'gap' });
      }
      if (seg.kind === 'gap') y = 0; // landings return to deck level
    }

    // build frames (central-difference tangents, then roll about the tangent)
    for (let i = 0; i < raw.length; i++) {
      const a = raw[Math.max(0, i - 1)];
      const b = raw[Math.min(raw.length - 1, i + 1)];
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
      });
    }

    for (const att of this.spec.attachments) {
      if (att.kind === 'boost') this.boostZones.push({ from: att.at, to: att.at + att.length });
    }
  }

  frameAt(s: number): TrackSample {
    let lo = 0, hi = this.samples.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.samples[mid].s < s) lo = mid + 1; else hi = mid;
    }
    return this.samples[lo];
  }

  /** Nearest sample to a world position, searching around a hint index. */
  nearest(pos: THREE.Vector3, hintIdx: number): { idx: number; dist: number } {
    const lo = Math.max(0, hintIdx - 60);
    const hi = Math.min(this.samples.length - 1, hintIdx + 60);
    let best = hintIdx, bestD = Infinity;
    for (let i = lo; i <= hi; i++) {
      const d = this.samples[i].pos.distanceToSquared(pos);
      if (d < bestD) { bestD = d; best = i; }
    }
    return { idx: best, dist: Math.sqrt(bestD) };
  }

  isOnBoost(s: number, lateral: number): boolean {
    const hw = this.spec.width / 2;
    if (Math.abs(lateral) > hw) return false;
    return this.boostZones.some((z) => s >= z.from && s <= z.to);
  }
}

/* ============================ builder ============================ */

export interface BuiltTrack {
  track: Track;
  mesh: THREE.Mesh;
}

export function buildTrack(
  scene: THREE.Scene,
  world: RAPIER_API.World,
  RAPIER: Rapier,
  spec: TrackSpec,
): BuiltTrack {
  const track = new Track(spec);
  const hw = spec.width / 2;
  const S = track.samples;

  // ---- ribbon mesh + trimesh collider over surfaced runs ----
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let vi = 0;
  for (let i = 0; i < S.length; i++) {
    const smp = S[i];
    const L = smp.pos.clone().addScaledVector(smp.right, -hw);
    const R = smp.pos.clone().addScaledVector(smp.right, hw);
    positions.push(L.x, L.y, L.z, R.x, R.y, R.z);
    uvs.push(0, smp.s, 1, smp.s);
    if (i > 0 && smp.surfaced && S[i - 1].surfaced) {
      const a = vi - 2, b = vi - 1, c = vi, d = vi + 1;
      indices.push(a, b, c, b, d, c);
    }
    vi += 2;
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

        // glowing rails at the edges
        float d = min(vUv.x, 1.0 - vUv.x);
        float edge = 1.0 - smoothstep(0.0, 0.05, d);
        vec3 col = mix(surface, cyan * 1.7, edge);

        // magenta center dashes
        float center = 1.0 - smoothstep(0.0, 0.018, abs(vUv.x - 0.5));
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

  // ---- start / finish gates ----
  addGateBar(scene, track, spec.start, new THREE.Color(0.2, 1.8, 2.0));
  addGateBar(scene, track, spec.finish, new THREE.Color(2.0, 0.4, 1.1));

  // ---- attachments ----
  for (const att of spec.attachments) buildAttachment(scene, world, RAPIER, track, att);

  return { track, mesh };
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
    const mid = from.pos.clone().add(to.pos).multiplyScalar(0.5)
      .addScaledVector(from.right, att.offset);
    mid.y += 0.8;
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
    // posts
    for (const t of [0.15, 0.5, 0.85]) {
      const p = from.pos.clone().lerp(to.pos, t).addScaledVector(from.right, att.offset);
      const post = new THREE.Mesh(
        new THREE.BoxGeometry(0.25, 0.8, 0.25),
        new THREE.MeshBasicMaterial({ color: 0x1a0b33 }),
      );
      post.position.copy(p);
      post.position.y += 0.4;
      scene.add(post);
    }
  }
}
