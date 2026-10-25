import * as THREE from 'three/webgpu';
import { attribute, uniform, vec3, float, mod, normalize, cross, length, smoothstep, mix, cameraPosition, abs } from 'three/tsl';

// js/render/rain.js
// Falling rain around the camera: thin streaks in a box that follows it, each drop placed in the vertex shader from
// its seed and the time (nothing moves on the CPU), wrapped round the box so the rain stays put in the world as the
// camera moves through it. They fall at a raindrop's terminal speed (~9 m/s for 2-3 mm drops), slanted by the wind,
// and each streak is as long as a drop moves in a 1/30 s exposure. Density follows the intensity (draw range).

const DROPS = 12000;
const BOX = [64, 36, 64]; // m around the camera (x, y, z)
const FALL = 9; // m/s
const EXPOSURE = 1 / 30; // s: the motion blur of a streak

function buildRainGeometry() {
  // One quad per drop: corner (x -1..1 across, y 0 head .. 1 tail), seed 0..1 per axis
  const corners = new Float32Array(DROPS * 4 * 3);
  const seeds = new Float32Array(DROPS * 4 * 3);
  const index = new Uint32Array(DROPS * 6);
  let h = 1;
  const rand = () => ((h = (h * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < DROPS; i++) {
    const s = [rand(), rand(), rand()];
    [[-1, 0], [1, 0], [1, 1], [-1, 1]].forEach(([cx, cy], k) => {
      corners.set([cx, cy, 0], (i * 4 + k) * 3);
      seeds.set(s, (i * 4 + k) * 3);
    });
    index.set([0, 1, 2, 0, 2, 3].map((k) => i * 4 + k), i * 6);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(corners, 3));
  g.setAttribute('seed', new THREE.BufferAttribute(seeds, 3));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return g;
}

function createRain(scene, nightFactor) {
  const uCenter = uniform(new THREE.Vector3());
  const uVelocity = uniform(new THREE.Vector3(0, -FALL, 0));
  const uTime = uniform(0);
  const uOpacity = uniform(0);

  const corner = attribute('position', 'vec3');
  const seed = attribute('seed', 'vec3');
  const box = vec3(...BOX);
  // the drop's place: its seed in the box, carried along by its fall, wrapped round the box about the camera
  const origin = uCenter.sub(box.mul(0.5));
  const drop = origin.add(mod(seed.mul(box).add(uVelocity.mul(uTime)).sub(origin), box));
  const dir = normalize(uVelocity);
  const side = normalize(cross(dir, drop.sub(cameraPosition)));
  const streak = length(uVelocity).mul(EXPOSURE);
  const material = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  // about a pixel wide at any distance (a drop is 2-3 mm, far below one): a 1.2 mm half-width per metre away
  const halfWidth = length(drop.sub(cameraPosition)).mul(0.0012).add(0.002);
  material.positionNode = drop.sub(dir.mul(streak.mul(corner.y))).add(side.mul(corner.x.mul(halfWidth)));
  // fainter towards the box's faces (no hard edge where drops wrap) and the camera (no big blurs over the view)
  const rel = drop.sub(uCenter).div(box.mul(0.5));
  const edge = smoothstep(1.0, 0.7, abs(rel.x)).mul(smoothstep(1.0, 0.7, abs(rel.y))).mul(smoothstep(1.0, 0.7, abs(rel.z)));
  const near = smoothstep(0.6, 2.5, length(drop.sub(cameraPosition)));
  const across = float(1).sub(abs(corner.x)); // a soft streak, brightest down its middle
  material.colorNode = mix(vec3(0.78, 0.82, 0.88), vec3(0.32, 0.36, 0.42), nightFactor);
  material.opacityNode = uOpacity.mul(edge).mul(near).mul(across.mul(0.6).add(0.4));

  const mesh = new THREE.Mesh(buildRainGeometry(), material);
  mesh.name = 'Rain';
  mesh.frustumCulled = false;
  mesh.renderOrder = 997;
  mesh.visible = false;
  mesh.geometry.setDrawRange(0, 0);
  scene.add(mesh);

  return {
    mesh,
    /**
     * intensity 0..1 (rainIntensity), wind (m/s) toward grid +x / +z, elapsed seconds; the camera it falls around
     */
    update(intensity, windX, windZ, elapsed, camera) {
      const drops = Math.round(DROPS * Math.min(1, intensity * 1.1));
      mesh.visible = drops > 0;
      if (!mesh.visible) return;
      mesh.geometry.setDrawRange(0, drops * 6);
      uCenter.value.copy(camera.position);
      uVelocity.value.set(windX * 0.6, -FALL, windZ * 0.6);
      uTime.value = elapsed % 3600;
      uOpacity.value = 0.18 + 0.22 * intensity;
    }
  };
}

export { createRain };
