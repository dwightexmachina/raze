import * as THREE from 'three';

/**
 * Gridfire sky: inverted sphere with a gradient dusk, a striped sun
 * low on the horizon, and a magenta horizon glow. All emissive —
 * bright enough for the bloom pass to catch the sun.
 */
export function makeSky(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(900, 32, 24);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uSunDir: { value: new THREE.Vector3(0, 0.12, -1).normalize() },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir;
      varying vec3 vDir;

      void main() {
        vec3 d = normalize(vDir);
        float h = clamp(d.y, -1.0, 1.0);

        // dusk gradient: deep violet up top, hot magenta at the horizon
        vec3 top = vec3(0.051, 0.020, 0.141);     // #0d0524
        vec3 mid = vec3(0.129, 0.043, 0.231);     // darker violet
        vec3 hor = vec3(0.541, 0.118, 0.431);     // #8a1e6e
        vec3 col = mix(mid, top, smoothstep(0.08, 0.55, h));
        col = mix(hor, col, smoothstep(0.0, 0.14, h));

        // below horizon: fade to the ground void
        col = mix(vec3(0.051, 0.020, 0.141), col, smoothstep(-0.12, 0.0, h));

        // striped sun
        float sunAmt = dot(d, uSunDir);
        float disc = smoothstep(0.9955, 0.9985, sunAmt);
        // horizontal stripe cutouts, thicker toward the bottom of the disc
        float band = sin((d.y - uSunDir.y) * 260.0);
        float stripes = smoothstep(-0.3, 0.3, band + (d.y - uSunDir.y) * 26.0 + 0.55);
        vec3 sunCol = mix(vec3(1.0, 0.18, 0.53), vec3(1.0, 0.83, 0.30),
                          smoothstep(-0.02, 0.05, d.y - uSunDir.y + 0.03));
        col = mix(col, sunCol * 1.6, disc * stripes);

        // sun halo
        float halo = pow(max(sunAmt, 0.0), 80.0) * 0.3;
        col += vec3(1.0, 0.18, 0.53) * halo;

        // horizon line glow
        float hglow = exp(-abs(h) * 26.0) * 0.35;
        col += vec3(1.0, 0.18, 0.53) * hglow;

        // colors above are authored in sRGB; pre-linearize so the
        // renderer's output encoding restores the authored look
        col = pow(max(col, 0.0), vec3(2.2));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}
