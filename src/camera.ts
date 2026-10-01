import * as THREE from 'three';

const MIN_POLAR = 0.25;
const MAX_POLAR = 1.5;
const MIN_RADIUS = 4;
const MAX_RADIUS = 45;

export interface CameraPreset {
  name: string;
  radius: number;
  polarDeg: number;    // from vertical; 90° = level with the rider
  azimuthDeg: number;  // 0 = directly behind the heading
  lookAhead: number;
  baseFov: number;
  fovKick: number;
  followRate: number;  // higher = tighter follow
  fpv?: boolean;
}

/**
 * Cycled with V. Drag/wheel apply manual offsets ON TOP of the active
 * preset; C clears the offsets back to the preset's stock framing.
 */
export const PRESETS: CameraPreset[] = [
  { name: 'CHASE',   radius: 12, polarDeg: 69, azimuthDeg: 0,  lookAhead: 6, baseFov: 62, fovKick: 18, followRate: 5 },
  { name: 'LOW',     radius: 8,  polarDeg: 84, azimuthDeg: 0,  lookAhead: 9, baseFov: 66, fovKick: 26, followRate: 7 },
  { name: 'HIGH',    radius: 18, polarDeg: 50, azimuthDeg: 0,  lookAhead: 4, baseFov: 58, fovKick: 10, followRate: 3.5 },
  { name: 'PROFILE', radius: 10, polarDeg: 80, azimuthDeg: 90, lookAhead: 2, baseFov: 60, fovKick: 12, followRate: 6 },
  { name: 'BOARD',   radius: 0,  polarDeg: 0,  azimuthDeg: 0,  lookAhead: 30, baseFov: 80, fovKick: 15, followRate: 20, fpv: true },
];

// TODO(air cam): event-driven preset override while airborne — drop low,
// tilt up so the rider hangs against the sky; snap back on landing.
// TODO(idle orbit): after ~5 s without input, slow cinematic orbit
// around the rider (attract/podium mode).

export interface CameraMeta {
  preset: string;
  manual: boolean;
  radius: number;
  azimuthDeg: number;
  polarDeg: number;
  fov: number;
  cameraPos: [number, number, number];
  lookTarget: [number, number, number];
  riderPos: [number, number, number];
  riderSpeedKmh: number;
}

export class ChaseCamera {
  readonly camera: THREE.PerspectiveCamera;

  private modeIndex = 0;
  /** Manual offsets on top of the active preset. */
  private azimuthOffset = 0;
  private polarOffset = 0;
  private radiusScale = 1;

  private currentPos = new THREE.Vector3(0, 6, 40);
  private currentLook = new THREE.Vector3();
  // smoothed surface up — the camera rolls with walls and pipes
  private effUp = new THREE.Vector3(0, 1, 0);
  // effective values from the last update, for the metadata readout
  private effAzimuth = 0;
  private effPolar = 0;
  private effRadius = 0;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(PRESETS[0].baseFov, aspect, 0.1, 2000);
    this.camera.position.copy(this.currentPos);
  }

  get preset(): CameraPreset {
    return PRESETS[this.modeIndex];
  }

  cycleMode(): void {
    this.modeIndex = (this.modeIndex + 1) % PRESETS.length;
    this.resetOffsets();
  }

  orbitBy(dxPx: number, dyPx: number): void {
    this.azimuthOffset -= dxPx * 0.005;
    if (this.azimuthOffset > Math.PI) this.azimuthOffset -= Math.PI * 2;
    if (this.azimuthOffset < -Math.PI) this.azimuthOffset += Math.PI * 2;
    this.polarOffset = THREE.MathUtils.clamp(this.polarOffset - dyPx * 0.004, -1.2, 1.2);
  }

  zoomBy(wheelDeltaY: number): void {
    this.radiusScale = THREE.MathUtils.clamp(
      this.radiusScale * Math.exp(wheelDeltaY * 0.001),
      0.35,
      3.5,
    );
  }

  resetOffsets(): void {
    this.azimuthOffset = 0;
    this.polarOffset = 0;
    this.radiusScale = 1;
  }

  get isManual(): boolean {
    return (
      Math.abs(this.azimuthOffset) > 0.02 ||
      Math.abs(this.polarOffset) > 0.02 ||
      Math.abs(this.radiusScale - 1) > 0.02
    );
  }

  update(
    dt: number,
    target: THREE.Vector3,
    heading: THREE.Vector3,
    speed: number,
    surfaceUp?: THREE.Vector3,
  ): void {
    const p = this.preset;
    let desired: THREE.Vector3;
    let look: THREE.Vector3;

    // roll the whole rig with the riding surface (mostly — keep a bias
    // toward world-up so mild banks don't feel like the world is tilting)
    const targetUp = surfaceUp
      ? surfaceUp.clone().lerp(new THREE.Vector3(0, 1, 0), 0.3).normalize()
      : new THREE.Vector3(0, 1, 0);
    this.effUp.lerp(targetUp, 1 - Math.exp(-dt * 3.5)).normalize();
    const frameQ = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0), this.effUp,
    );

    if (p.fpv) {
      // board cam: perched above the nose, looking down the line of travel;
      // drag offsets rotate the gaze instead of orbiting
      const gaze = heading.clone()
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), this.azimuthOffset);
      gaze.y += this.polarOffset * 0.8;
      gaze.normalize();
      desired = target.clone()
        .add(new THREE.Vector3(0, 1.5, 0))
        .addScaledVector(heading, 1.0);
      look = desired.clone().addScaledVector(gaze, p.lookAhead);
      this.effAzimuth = this.azimuthOffset;
      this.effPolar = 0;
      this.effRadius = 0;
    } else {
      const azimuth = THREE.MathUtils.degToRad(p.azimuthDeg) + this.azimuthOffset;
      const polar = THREE.MathUtils.clamp(
        THREE.MathUtils.degToRad(p.polarDeg) + this.polarOffset,
        MIN_POLAR,
        MAX_POLAR,
      );
      const radius = THREE.MathUtils.clamp(p.radius * this.radiusScale, MIN_RADIUS, MAX_RADIUS);
      this.effAzimuth = azimuth;
      this.effPolar = polar;
      this.effRadius = radius;

      const baseA = Math.atan2(-heading.x, -heading.z);
      const a = baseA + azimuth;
      const sinP = Math.sin(polar);
      const offset = new THREE.Vector3(
        Math.sin(a) * sinP * radius,
        Math.cos(polar) * radius,
        Math.cos(a) * sinP * radius,
      ).applyQuaternion(frameQ); // orbit in the rolled frame
      desired = target.clone().add(offset);

      // look ahead when behind the rider, at the rider when off to the side
      const aheadAmount = Math.max(Math.cos(azimuth), 0) * p.lookAhead;
      look = target.clone()
        .addScaledVector(heading, aheadAmount)
        .addScaledVector(this.effUp, 1.2);
    }

    const followRate = this.isManual && !p.fpv ? Math.max(p.followRate, 12) : p.followRate;
    const posAlpha = 1 - Math.exp(-dt * followRate);
    const lookAlpha = 1 - Math.exp(-dt * (p.fpv ? 20 : 8));
    this.currentPos.lerp(desired, posAlpha);
    this.currentLook.lerp(look, lookAlpha);

    this.camera.position.copy(this.currentPos);
    this.camera.up.copy(this.effUp);
    this.camera.lookAt(this.currentLook);

    const targetFov = p.baseFov + Math.min(speed / 45, 1) * p.fovKick;
    this.camera.fov += (targetFov - this.camera.fov) * (1 - Math.exp(-dt * 4));
    this.camera.updateProjectionMatrix();
  }

  meta(riderPos: THREE.Vector3, riderSpeed: number): CameraMeta {
    const r = (v: number): number => Math.round(v * 100) / 100;
    return {
      preset: this.preset.name,
      manual: this.isManual,
      radius: r(this.effRadius),
      azimuthDeg: r(THREE.MathUtils.radToDeg(this.effAzimuth)),
      polarDeg: r(THREE.MathUtils.radToDeg(this.effPolar)),
      fov: r(this.camera.fov),
      cameraPos: [r(this.camera.position.x), r(this.camera.position.y), r(this.camera.position.z)],
      lookTarget: [r(this.currentLook.x), r(this.currentLook.y), r(this.currentLook.z)],
      riderPos: [r(riderPos.x), r(riderPos.y), r(riderPos.z)],
      riderSpeedKmh: Math.round(riderSpeed * 3.6),
    };
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}
