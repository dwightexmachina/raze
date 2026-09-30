import * as THREE from 'three';

/**
 * The Gridfire floor: one large plane, all the look in the fragment shader.
 * Magenta minor lines, cyan major lines, distance fade into the horizon
 * color. Line brightness > 1 so the bloom pass ignites them.
 */
export function makeGrid(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(2000, 2000, 1, 1);
  geo.rotateX(-Math.PI / 2);

  const mat = new THREE.ShaderMaterial({
    fog: false,
    uniforms: {
      uCamPos: { value: new THREE.Vector3() },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uCamPos;
      varying vec3 vWorld;

      float gridLine(vec2 p, float spacing, float width) {
        vec2 q = p / spacing;
        vec2 f = abs(fract(q) - 0.5);
        vec2 fw = fwidth(q) * width;
        vec2 a = 1.0 - smoothstep(vec2(0.0), fw, f);
        return max(a.x, a.y);
      }

      void main() {
        vec2 p = vWorld.xz;

        vec3 ground = vec3(0.086, 0.024, 0.180);            // #16062e
        vec3 magenta = vec3(1.0, 0.18, 0.53);
        vec3 cyan = vec3(0.0, 0.94, 1.0);

        float minor = gridLine(p, 4.0, 1.1);
        float major = gridLine(p, 32.0, 1.1);

        vec3 col = ground;
        col = mix(col, magenta * 2.0, minor * 0.9);
        col = mix(col, cyan * 1.5, major * 0.85);

        // distance fade toward the horizon color, hiding the plane edge
        float d = distance(uCamPos.xz, p);
        vec3 horizon = vec3(0.24, 0.055, 0.21);
        col = mix(col, horizon, smoothstep(90.0, 420.0, d));

        // pre-linearize sRGB-authored colors (see sky.ts)
        col = pow(max(col, 0.0), vec3(2.2));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}

export function updateGrid(mesh: THREE.Mesh, camPos: THREE.Vector3): void {
  const mat = mesh.material as THREE.ShaderMaterial;
  (mat.uniforms.uCamPos.value as THREE.Vector3).copy(camPos);
  // keep the plane centered under the camera so it never runs out
  mesh.position.set(camPos.x, 0, camPos.z);
  // ...but keep world-space UVs by NOT moving the grid pattern: the shader
  // uses vWorld, so recentering the plane is invisible. Snap to avoid jitter.
}
