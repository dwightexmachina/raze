import * as THREE from 'three';

/**
 * Procedural chrome matcap: a shaded sphere painted onto a canvas.
 * Magenta sky reflection above, dark horizon band, cyan grid reflection
 * below — the Gridfire environment baked into Argent's skin.
 * Zero asset files, zero scene lights.
 */
export function makeChromeMatcap(size = 256): THREE.Texture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d')!;
  const r = size / 2;

  // vertical environment ramp across the sphere
  const g = ctx.createLinearGradient(0, 0, 0, size);
  g.addColorStop(0.0, '#ffe9f6');
  g.addColorStop(0.3, '#cfe0f2');
  g.addColorStop(0.46, '#5e7ba8');
  g.addColorStop(0.52, '#16203a');
  g.addColorStop(0.6, '#7ee8f5');
  g.addColorStop(1.0, '#173b52');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  // spherical shading: darken toward the rim
  const rim = ctx.createRadialGradient(r, r, r * 0.45, r, r, r);
  rim.addColorStop(0, 'rgba(0,0,0,0)');
  rim.addColorStop(1, 'rgba(6,4,20,0.55)');
  ctx.fillStyle = rim;
  ctx.fillRect(0, 0, size, size);

  // hot specular highlight, upper left
  const spec = ctx.createRadialGradient(r * 0.62, r * 0.5, 0, r * 0.62, r * 0.5, r * 0.34);
  spec.addColorStop(0, 'rgba(255,255,255,0.95)');
  spec.addColorStop(0.25, 'rgba(255,255,255,0.4)');
  spec.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = spec;
  ctx.fillRect(0, 0, size, size);

  // faint magenta kicker, lower right rim
  const kick = ctx.createRadialGradient(r * 1.5, r * 1.45, 0, r * 1.5, r * 1.45, r * 0.7);
  kick.addColorStop(0, 'rgba(255,46,136,0.35)');
  kick.addColorStop(1, 'rgba(255,46,136,0)');
  ctx.fillStyle = kick;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Soft radial glow sprite texture for board underglow. */
export function makeGlowTexture(size = 128): THREE.Texture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d')!;
  const r = size / 2;
  const g = ctx.createRadialGradient(r, r, 0, r, r, r);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  return tex;
}
