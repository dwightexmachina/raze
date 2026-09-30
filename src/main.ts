import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { Input } from './input';
import { makeChromeMatcap } from './matcap';
import { makeSky } from './sky';
import { makeGrid, updateGrid } from './grid';
import { buildPark } from './park';
import { Rider } from './rider';
import { ChaseCamera } from './camera';

const FIXED_DT = 1 / 60;

async function boot(): Promise<void> {
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
  buildPark(scene, world, RAPIER);

  const matcap = makeChromeMatcap();
  const input = new Input();
  const rider = new Rider(scene, world, RAPIER, matcap);

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
    chase.zoomBy(e.deltaY);
  }, { passive: false });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyC') chase.resetOffsets();
    if (e.code === 'KeyV') chase.cycleMode();
  });

  // debug handle for tuning from the console
  (window as unknown as { __raze: object }).__raze = { chase, rider };

  // ---- camera metadata panel + clipboard copy ----
  const cammetaEl = document.getElementById('cammeta')!;
  const copyBtn = document.getElementById('copycam') as HTMLButtonElement;
  copyBtn.addEventListener('click', async () => {
    const meta = chase.meta(rider.position, rider.speed);
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
      `rider   <b>${v3(m.riderPos)}</b>`;
  }

  // ---- HUD ----
  const speedEl = document.getElementById('speed')!;
  const fpsEl = document.getElementById('fps')!;
  let frames = 0;
  let fpsClock = 0;

  // ---- fixed-timestep loop: physics at 60 Hz, render at rAF ----
  let last = performance.now();
  let accumulator = 0;

  function frame(now: number): void {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    accumulator += dt;

    while (accumulator >= FIXED_DT) {
      rider.step(input);
      world.timestep = FIXED_DT;
      world.step();
      accumulator -= FIXED_DT;
    }

    rider.syncVisual(input);
    chase.update(dt, rider.position, rider.heading, rider.speed);
    updateGrid(grid, chase.camera.position);
    updateMetaPanel(dt);

    composer.render();

    speedEl.textContent = String(Math.round(rider.speed * 3.6));
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
}

boot();
