import * as THREE from 'three';
import type RAPIER_API from '@dimforge/rapier3d-compat';

type Rapier = typeof RAPIER_API;

/**
 * The skatepark: ramps, banked berms, emissive obstacles, and one long rail.
 * Every feature is a box mesh + matching static Rapier cuboid, with neon
 * edge lines bright enough to bloom.
 */
export function buildPark(
  scene: THREE.Scene,
  world: RAPIER_API.World,
  RAPIER: Rapier,
): void {
  const deckMat = new THREE.MeshBasicMaterial({ color: 0x1a0b33 });
  const edgeCyan = new THREE.LineBasicMaterial({ color: 0x00f0ff });
  const edgeMagenta = new THREE.LineBasicMaterial({ color: 0xff2e88 });

  function box(
    size: [number, number, number],
    pos: [number, number, number],
    eulerY = 0,
    eulerX = 0,
    edgeMat: THREE.LineBasicMaterial = edgeCyan,
    fillMat: THREE.MeshBasicMaterial = deckMat,
  ): void {
    const geo = new THREE.BoxGeometry(...size);
    const mesh = new THREE.Mesh(geo, fillMat);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(eulerX, eulerY, 0));
    mesh.position.set(...pos);
    mesh.quaternion.copy(q);
    scene.add(mesh);

    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat);
    edges.position.copy(mesh.position);
    edges.quaternion.copy(q);
    scene.add(edges);

    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(pos[0], pos[1], pos[2])
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }),
    );
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(size[0] / 2, size[1] / 2, size[2] / 2),
      body,
    );
  }

  // ground collider (the visual grid plane is in grid.ts)
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
  world.createCollider(RAPIER.ColliderDesc.cuboid(1000, 0.5, 1000), ground);

  // launch ramp, dead ahead: near edge buried, rises away from the rider
  box([14, 1, 18], [0, -0.1, -60], 0, 0.22);

  // bigger ramp further out
  box([18, 1, 26], [45, 0.2, -140], 0.3, 0.3);

  // banked berms left and right
  box([30, 1, 12], [-55, 0.6, -90], 0.5, 0, edgeMagenta);
  (function () {
    // opposite bank: roll instead of pitch — build with explicit quaternion
    const geo = new THREE.BoxGeometry(30, 1, 12);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -0.5, 0.35));
    const mesh = new THREE.Mesh(geo, deckMat);
    mesh.position.set(60, 1.2, -40);
    mesh.quaternion.copy(q);
    scene.add(mesh);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMagenta);
    edges.position.copy(mesh.position);
    edges.quaternion.copy(q);
    scene.add(edges);
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(60, 1.2, -40).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }),
    );
    world.createCollider(RAPIER.ColliderDesc.cuboid(15, 0.5, 6), body);
  })();

  // scattered emissive obstacle pylons
  const pylonMat = new THREE.MeshBasicMaterial({ color: 0x2b1152 });
  const positions: Array<[number, number]> = [
    [-20, -30], [25, -85], [-40, -160], [15, -200], [-70, -220], [80, -180], [-15, -120],
  ];
  for (const [x, z] of positions) {
    const h = 3 + ((Math.abs(x * 7 + z * 13) % 50) / 10);
    box([3, h, 3], [x, h / 2, z], 0.3, 0, edgeCyan, pylonMat);
  }

  // one long grind rail on posts
  const railMat = new THREE.MeshBasicMaterial({ color: 0x00f0ff });
  const rail = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.3, 40), railMat);
  rail.position.set(-18, 1.6, -180);
  scene.add(rail);
  const railBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(-18, 1.6, -180));
  world.createCollider(RAPIER.ColliderDesc.cuboid(0.2, 0.15, 20), railBody);
  const postGeo = new THREE.BoxGeometry(0.3, 1.6, 0.3);
  const postMat = new THREE.MeshBasicMaterial({ color: 0x1a0b33 });
  for (const dz of [-16, 0, 16]) {
    const post = new THREE.Mesh(postGeo, postMat);
    post.position.set(-18, 0.8, -180 + dz);
    scene.add(post);
  }
}
