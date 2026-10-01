import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { Input } from './input';
import { ModeCoordinator } from './modes/coordinator';
import { makeChromeMatcap } from './matcap';
import { makeSky } from './sky';
import { makeGrid, updateGrid } from './grid';
import { buildTrack, updateTrack } from './track/builder';
import { GAUNTLET_PLUS, LOOPER, OUROBOROS, PIPELINE } from './track/spec';
import { Rider } from './rider';
import { ChaseCamera } from './camera';

const FIXED_DT = 1 / 60;
const _diff = new THREE.Vector3(); // trackLogic scratch

export async function startGame(): Promise<void> {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -19.6, z: 0 }); // 2g: arcade gravity

  // ---- renderer ----
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const chase = new ChaseCamera(window.innerWidth / window.innerHeight);

  // ---- world ----
  scene.add(makeSky());
  const grid = makeGrid();
  scene.add(grid);
  // map select: ?map=gauntlet | looper | pipeline; OUROBOROS (the circuit)
  // is the default
  const mapParam = new URLSearchParams(location.search).get('map');
  const spec =
    mapParam === 'gauntlet' ? GAUNTLET_PLUS :
    mapParam === 'looper' ? LOOPER :
    mapParam === 'pipeline' ? PIPELINE :
    OUROBOROS;
  const isCircuit = !!spec.circuit;
  const { track, mesh: trackMesh, rails } = buildTrack(scene, world, RAPIER, spec);

  const matcap = makeChromeMatcap();
  const input = new Input();
  const rider = new Rider(scene, world, RAPIER, matcap);

  // ---- ride modes: HOVER / GRIND / TUBE (+ FLIGHT stub) ----
  const coordinator = new ModeCoordinator({ rider, track, rails, input, chase });

  // ---- track progress, respawn, timing ----
  const SPAWN_S = 4;
  let nearIdx = 0;
  let checkpointS = SPAWN_S;
  let progressS = 0;
  let runStart: number | null = null;
  let lastMs: number | null = null;
  let bestMs: number | null = null;
  let lapCount = 0;
  let onBoostPad = false;
  let camRadiusClamp = 0; // tighten the chase orbit inside tubes
  const riderTrackInfo = {
    s: 0,             // arclength along the track, meters
    segment: '-',     // named segment at that arclength
    lateral: 0,       // signed offset from centerline (+ = right)
    aboveDeck: 0,     // height above the deck surface along its normal
    distToTrack: 0,   // distance to nearest centerline sample
    offTrack: false,
    rideMode: 'HOVER',
    checkpointS: 0,
  };

  function spawnAt(s: number): void {
    const f = track.frameAt(s);
    const yaw = Math.atan2(-f.tangent.x, -f.tangent.z);
    rider.setPose(f.pos.clone().addScaledVector(f.up, 1.8), yaw);
    // forceHover AFTER the teleport so its nearHint resync (and the HOVER
    // mode it restores) both reflect where the rider actually landed
    coordinator.forceHover();
    nearIdx = 0;
    progressS = s;
  }
  spawnAt(SPAWN_S);

  const FALL_MARGIN = 5; // meters below the local deck (along its normal)
  const MAX_SURFACE_SCAN = 200; // samples to walk back looking for deck

  /** A stumble, not a crash: teleport to the nearest rideable point on the
   *  deck (walking back from a void-gap landing to its takeoff edge) and
   *  keep some forward speed, so recovering from a small mistake is a
   *  near-instant bump-back rather than a trip to the last checkpoint. */
  function recoverLocally(near: { idx: number; branch: number }, priorSpeed: number): void {
    const pool = near.branch < 0 ? track.samples : track.forkBranches[near.branch].samples;
    let idx = near.idx;
    let steps = 0;
    while (!pool[idx].surfaced && steps < MAX_SURFACE_SCAN) {
      idx = idx > 0 ? idx - 1 : pool.length - 1;
      steps++;
    }
    if (!pool[idx].surfaced) {
      // degenerate case (no deck found nearby) — fall back to the checkpoint
      spawnAt(Math.max(SPAWN_S, checkpointS - 4));
      return;
    }
    const smp = pool[idx];
    const yaw = Math.atan2(-smp.tangent.x, -smp.tangent.z);
    rider.setPose(smp.pos.clone().addScaledVector(smp.up, 1.8), yaw);
    const keepSpeed = THREE.MathUtils.clamp(priorSpeed * 0.6, 6, 20);
    rider.body.setLinvel(
      { x: smp.tangent.x * keepSpeed, y: 0, z: smp.tangent.z * keepSpeed },
      true,
    );
    coordinator.forceHover();
    // nearIdx/checkpointS live in MAIN-TRUNK arclength space — only
    // update nearIdx when we actually recovered onto the trunk; when
    // recovering onto a branch, bank the branch's fork point instead so
    // a degenerate fallback still lands somewhere sane.
    if (near.branch < 0) {
      nearIdx = idx;
      checkpointS = smp.s;
    } else {
      checkpointS = track.forkBranches[near.branch].forkAt;
    }
  }

  function trackLogic(): void {
    const pos = rider.position;
    const near = track.nearest(pos, nearIdx);
    const smp = track.resolveSample(near);
    const onBranch = near.branch >= 0;
    const branchWidth = onBranch ? track.forkBranches[near.branch].width : track.spec.width;
    if (near.dist < branchWidth * 1.5) {
      // progress/lap-timing live in MAIN-TRUNK arclength space — freeze
      // them while on a branch (they resume correctly once back on the
      // trunk); checkpoint still banks, but to the branch's fork point
      const lateral = _diff.copy(pos).sub(smp.pos).dot(smp.right);
      if (!onBranch) {
        nearIdx = near.idx;
        const prevS = progressS;
        progressS = smp.s;
        if (smp.surfaced && pos.y > smp.pos.y - 1 && near.dist < branchWidth * 0.7) {
          checkpointS = smp.s;
        }
        // timing gates
        if (isCircuit) {
          // the lap line: first crossing starts lap 1; each later crossing
          // banks a lap and restarts the clock (|Δs| guard skips the wrap
          // jump and respawn teleports)
          if (prevS < spec.start && progressS >= spec.start && Math.abs(progressS - prevS) < 30) {
            const now = performance.now();
            if (runStart !== null) {
              lastMs = now - runStart;
              if (bestMs === null || lastMs < bestMs) bestMs = lastMs;
              lapCount++;
            }
            runStart = now;
          }
        } else {
          if (prevS < track.spec.start && progressS >= track.spec.start) {
            runStart = performance.now();
            lastMs = null;
          }
          if (runStart !== null && prevS < track.spec.finish && progressS >= track.spec.finish) {
            lastMs = performance.now() - runStart;
            if (bestMs === null || lastMs < bestMs) bestMs = lastMs;
            runStart = null;
          }
        }
        onBoostPad = track.isOnBoost(smp.s, lateral);
        const seg = track.segmentAt(smp.s);
        riderTrackInfo.s = Math.round(smp.s * 10) / 10;
        riderTrackInfo.segment = `${seg.label} [#${seg.index} ${seg.kind} ${Math.round(seg.from)}-${Math.round(seg.to)}m]`;
      } else {
        const b = track.forkBranches[near.branch];
        if (smp.surfaced && pos.y > smp.pos.y - 1 && near.dist < branchWidth * 0.7) {
          checkpointS = b.forkAt;
        }
        const hw = b.width / 2;
        onBoostPad = Math.abs(lateral) <= hw && b.boostZones.some((z) => smp.s >= z.from && smp.s <= z.to);
        riderTrackInfo.s = Math.round((b.forkAt + smp.s) * 10) / 10;
        riderTrackInfo.segment = `fork: ${b.label} [${Math.round(smp.s)}m]`;
      }

      camRadiusClamp = smp.tubeAmt > 0.5 ? smp.tubeR * 0.85 : 0;
      riderTrackInfo.lateral = Math.round(lateral * 10) / 10;
      riderTrackInfo.aboveDeck = Math.round(_diff.copy(pos).sub(smp.pos).dot(smp.up) * 10) / 10;
      riderTrackInfo.distToTrack = Math.round(near.dist * 10) / 10;
      riderTrackInfo.offTrack = false;
    } else {
      onBoostPad = false;
      riderTrackInfo.offTrack = true;
      riderTrackInfo.distToTrack = Math.round(near.dist * 10) / 10;
    }
    riderTrackInfo.rideMode = coordinator.modeName;
    riderTrackInfo.checkpointS = Math.round(checkpointS * 10) / 10;
    // fell below the LOCAL deck (measured along its normal, so banked
    // turns and the tall tube sections don't need a one-size threshold —
    // only applies in HOVER: GRIND/TUBE own their own transitions)
    if (coordinator.modeName === 'HOVER') {
      const belowDeck = _diff.copy(pos).sub(smp.pos).dot(smp.up);
      if (belowDeck < -FALL_MARGIN) {
        recoverLocally(near, rider.speed);
      }
    }
    // manual reset → back to the start line
    if (input.consumeReset()) {
      spawnAt(SPAWN_S);
      checkpointS = SPAWN_S;
      runStart = null;
      lastMs = null;
      lapCount = 0;
    }
  }

  // ---- post stack: bloom is the whole Gridfire look ----
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, chase.camera));
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.45,  // strength
    0.5,   // radius
    0.78,  // threshold
  );
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
    chase.resize(window.innerWidth / window.innerHeight);
  });

  // ---- camera orbit controls: drag to orbit, wheel to zoom, C resets ----
  const canvas = renderer.domElement;
  canvas.style.cursor = 'grab';
  let dragging = false;
  canvas.addEventListener('pointerdown', (e) => {
    if (coordinator.cameraOverridden) return; // mode owns the camera
    dragging = true;
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
  });
  canvas.addEventListener('pointermove', (e) => {
    if (dragging) chase.orbitBy(e.movementX, e.movementY);
  });
  const endDrag = (e: PointerEvent): void => {
    dragging = false;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    canvas.style.cursor = 'grab';
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (coordinator.cameraOverridden) return;
    chase.zoomBy(e.deltaY);
  }, { passive: false });
  // ---- pause (physics + timer freeze; rendering and camera stay live) ----
  let paused = false;
  let pauseStart = 0;
  const pausedEl = document.getElementById('paused')!;
  function togglePause(): void {
    paused = !paused;
    pausedEl.classList.toggle('on', paused);
    if (paused) {
      pauseStart = performance.now();
    } else if (runStart !== null) {
      runStart += performance.now() - pauseStart; // paused time doesn't count
    }
  }

  // ---- pose preview (number keys): freezes physics and poses the Herald
  // by hand so motions can be eyeballed before they're wired to real
  // physics triggers. 0 (or the digit of the currently-active pose)
  // exits back to the normal rest stance / live control. ----
  const poseEl = document.getElementById('pose')!;
  function updatePoseHud(): void {
    const info = rider.debugPoseInfo;
    poseEl.textContent = info.index === 0 ? '' : `POSE PREVIEW: ${info.name} · PRESS 0 TO EXIT`;
    poseEl.classList.toggle('on', info.index !== 0);
  }

  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyC') chase.resetOffsets();
    if (e.code === 'KeyV') {
      if (coordinator.cameraOverridden) coordinator.cycleCameraVariant();
      else chase.cycleMode();
    }
    if (e.code === 'KeyP') togglePause();
  });

  // debug handle for tuning + headless stepping from the console. render()
  // forces a repaint without going through rAF — background/hidden tabs
  // (as under automated browser control) suspend rAF entirely, so this is
  // the only way to see a visual change take effect in that situation.
  (window as unknown as { __raze: object }).__raze = {
    chase, rider, track, world, input, coordinator, trackLogic, riderTrackInfo,
    render: () => composer.render(),
  };

  // ---- camera metadata panel + clipboard copy ----
  const cammetaEl = document.getElementById('cammeta')!;
  const copyBtn = document.getElementById('copycam') as HTMLButtonElement;
  copyBtn.addEventListener('click', async () => {
    const meta = { ...chase.meta(rider.position, rider.speed), track: { ...riderTrackInfo } };
    try {
      await navigator.clipboard.writeText(JSON.stringify(meta, null, 2));
      copyBtn.textContent = 'COPIED ✓';
      copyBtn.classList.add('done');
      setTimeout(() => {
        copyBtn.textContent = 'COPY METADATA';
        copyBtn.classList.remove('done');
      }, 1200);
    } catch {
      copyBtn.textContent = 'COPY FAILED';
      setTimeout(() => { copyBtn.textContent = 'COPY METADATA'; }, 1200);
    }
  });

  let metaClock = 0;
  function updateMetaPanel(dt: number): void {
    metaClock += dt;
    if (metaClock < 0.1) return; // 10 Hz is plenty for a readout
    metaClock = 0;
    const m = chase.meta(rider.position, rider.speed);
    const v3 = (v: [number, number, number]): string =>
      `${v[0].toFixed(1)}, ${v[1].toFixed(1)}, ${v[2].toFixed(1)}`;
    cammetaEl.innerHTML =
      `mode    <b>${m.preset}${m.manual ? ' +manual' : ''}</b>\n` +
      `radius  <b>${m.radius.toFixed(1)}</b>\n` +
      `azimuth <b>${m.azimuthDeg.toFixed(1)}°</b>\n` +
      `polar   <b>${m.polarDeg.toFixed(1)}°</b>\n` +
      `fov     <b>${m.fov.toFixed(1)}°</b>\n` +
      `cam     <b>${v3(m.cameraPos)}</b>\n` +
      `look    <b>${v3(m.lookTarget)}</b>\n` +
      `rider   <b>${v3(m.riderPos)}</b>\n` +
      `seg     <b>${riderTrackInfo.offTrack ? 'OFF TRACK' : riderTrackInfo.segment.split(' [')[0]}${riderTrackInfo.rideMode !== 'HOVER' ? ' · ' + riderTrackInfo.rideMode : ''}</b>\n` +
      `s / lat <b>${riderTrackInfo.s.toFixed(1)} / ${riderTrackInfo.lateral > 0 ? '+' : ''}${riderTrackInfo.lateral.toFixed(1)}</b>\n` +
      `deck    <b>${riderTrackInfo.aboveDeck > 0 ? '+' : ''}${riderTrackInfo.aboveDeck.toFixed(1)}</b>`;
  }

  // ---- HUD ----
  const speedEl = document.getElementById('speed')!;
  const fpsEl = document.getElementById('fps')!;
  const timeEl = document.getElementById('time')!;
  const boostFill = document.getElementById('boostfill')!;
  const trickEl = document.getElementById('trick')!;
  let trickTimer: ReturnType<typeof setTimeout> | undefined;
  let frames = 0;
  let fpsClock = 0;

  function fmt(ms: number): string {
    return (ms / 1000).toFixed(2);
  }

  // ---- fixed-timestep loop: physics at 60 Hz, render at rAF ----
  let last = performance.now();
  let accumulator = 0;

  function frame(now: number): void {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;

    const digit = input.consumeDigit();
    if (digit !== null) {
      // pressing the already-active pose's digit exits back to rest (0)
      rider.setDebugPose(digit === rider.debugPoseInfo.index ? 0 : digit);
      updatePoseHud();
    }
    const posePreview = rider.debugPoseInfo.index !== 0;

    if (!paused && !posePreview) {
      accumulator += dt;
      trackLogic();
      while (accumulator >= FIXED_DT) {
        coordinator.fixedStep(onBoostPad);
        world.timestep = FIXED_DT;
        world.step();
        accumulator -= FIXED_DT;
      }
    } else {
      accumulator = 0;
    }

    rider.syncVisual(input, dt, coordinator.modeName);
    if (!coordinator.frameCamera(dt)) {
      chase.update(
        dt, rider.position, rider.heading, rider.speed,
        rider.boardUp, rider.travelHeading, !rider.grounded, camRadiusClamp,
      );
    }
    updateGrid(grid, chase.camera.position);
    updateTrack(trackMesh, chase.camera.position);
    updateMetaPanel(dt);

    composer.render();

    speedEl.textContent = String(Math.round(rider.speed * 3.6));
    boostFill.style.width = `${rider.meter}%`;
    boostFill.classList.toggle('boosting', rider.boosting);

    const trick = rider.consumeTrick();
    if (trick) {
      const prefix = trick.quality === 'CLEAN' ? '' : trick.quality + ' ';
      trickEl.innerHTML = `${prefix}${trick.label}${trick.gain > 0 ? `<small>+${trick.gain} BOOST</small>` : ''}`;
      trickEl.className = 'show' + (trick.quality === 'SKETCHY' ? ' sketchy' : trick.quality === 'BAIL' ? ' bail' : '');
      clearTimeout(trickTimer);
      trickTimer = setTimeout(() => { trickEl.className = ''; }, 1500);
    }
    if (isCircuit) {
      if (runStart !== null) {
        const clock = paused ? pauseStart : performance.now();
        timeEl.textContent = `LAP ${lapCount + 1} · ${fmt(clock - runStart)}`
          + (lastMs !== null ? `  LAST ${fmt(lastMs)}` : '')
          + (bestMs !== null ? `  BEST ${fmt(bestMs)}` : '');
      } else {
        timeEl.textContent = 'CROSS THE LINE TO START LAP 1';
      }
    } else if (runStart !== null) {
      const clock = paused ? pauseStart : performance.now();
      timeEl.textContent = `TIME ${fmt(clock - runStart)}${bestMs !== null ? '  BEST ' + fmt(bestMs) : ''}`;
    } else if (lastMs !== null) {
      timeEl.textContent = `RUN ${fmt(lastMs)}  BEST ${fmt(bestMs ?? lastMs)}`;
    } else {
      timeEl.textContent = bestMs !== null ? `BEST ${fmt(bestMs)}` : 'CROSS THE START LINE';
    }
    frames += 1;
    fpsClock += dt;
    if (fpsClock >= 0.5) {
      fpsEl.textContent = `${Math.round(frames / fpsClock)} fps`;
      frames = 0;
      fpsClock = 0;
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);

  // the game is live — fade out the boot shell
  const loader = document.getElementById('loading');
  if (loader) {
    loader.classList.add('done');
    setTimeout(() => loader.remove(), 700);
  }
}

