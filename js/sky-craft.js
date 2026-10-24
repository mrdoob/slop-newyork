import * as THREE from 'three/webgpu';
import { uniform, vec3, positionLocal } from 'three/tsl';

// js/sky-craft.js
// Models for the player's UFO and rocket (js/simple-vehicles.js flies them): a flying saucer with a spinning rim of
// lights and a tractor beam, and a rocket with a flame, a launch pad and a smoke trail. Pure invention for fun: none of
// this is map data. City-agnostic: colours come in through the arguments.
//
// Both are built facing -z (as the car and plane); the rocket's nose points +y so its group pitches it over.

function std(colour, roughness = 0.5, metalness = 0) {
  return new THREE.MeshStandardNodeMaterial({ color: colour, roughness, metalness });
}

// Flying saucer: a lens-shaped hull, glass dome, rim lights (glow at night) and a beam cone below (beam(length, on))
function ufoModel(colour = 0xb8c2cc) {
  const g = new THREE.Group();
  const tilt = new THREE.Group(); // leans with the motion
  g.add(tilt);
  const hullMat = std(colour, 0.25, 0.85);
  const hull = new THREE.Mesh(new THREE.SphereGeometry(6, 32, 12).scale(1, 0.22, 1), hullMat);
  const skirt = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 4.4, 1.0, 32), std(0x5a6470, 0.4, 0.6));
  skirt.position.y = -1.1;
  const dome = new THREE.Mesh(new THREE.SphereGeometry(2.4, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardNodeMaterial({ color: 0x9fe6d8, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.7 }));
  dome.position.y = 0.9;
  const ring = new THREE.Group(); // spins
  const night = uniform(0);
  const lampMat = new THREE.MeshStandardNodeMaterial({ color: 0x223040, roughness: 0.3 });
  lampMat.emissiveNode = vec3(0.35, 1.0, 0.75).mul(night.mul(2.6).add(0.6));
  const lampGeo = new THREE.SphereGeometry(0.28, 10, 8);
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const lamp = new THREE.Mesh(lampGeo, lampMat);
    lamp.position.set(Math.cos(a) * 5.6, -0.15, Math.sin(a) * 5.6);
    ring.add(lamp);
  }
  // Beam: a cone from the hull to the ground, glowing at its core, fading out downwards
  const beamMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  const beamOn = uniform(0);
  beamMat.colorNode = vec3(0.45, 1.0, 0.8);
  beamMat.opacityNode = positionLocal.y.add(1).pow(1.5).mul(0.55).mul(beamOn); // the cone runs y -1 (ground) .. 0 (hull)
  const beam = new THREE.Mesh(new THREE.ConeGeometry(4.5, 1, 32, 1, true).translate(0, -0.5, 0), beamMat); // apex y 0, base y -1
  beam.visible = false;
  tilt.add(hull, skirt, dome, ring);
  g.add(beam);
  for (const m of [hull, skirt, dome]) m.castShadow = true;
  return {
    group: g, tilt, ring,
    setNight(f) { night.value = f; },
    beam(lengthM, strength) {
      beam.visible = strength > 0.01 && lengthM > 1;
      beam.scale.set(1 + lengthM / 40, lengthM, 1 + lengthM / 40);
      beam.position.y = -1.2;
      beamOn.value = strength;
    }
  };
}

// Rocket: body, nose cone, fins, a flame scaled by thrust (flame(f)), standing on its tail (nose +y)
function rocketModel(colour = 0xf2f2ee, accent = 0xc8261e) {
  const g = new THREE.Group();
  const body = std(colour, 0.35, 0.3), red = std(accent, 0.4, 0.2), dark = std(0x2a3036, 0.6, 0.4);
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.3, 16, 20), body);
  tube.position.y = 9;
  const band = new THREE.Mesh(new THREE.CylinderGeometry(1.22, 1.22, 1.4, 20), red);
  band.position.y = 13;
  const nose = new THREE.Mesh(new THREE.ConeGeometry(1.2, 4.5, 20), red);
  nose.position.y = 19.25;
  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 1.1, 1.2, 16), dark);
  nozzle.position.y = 0.6;
  const window = new THREE.Mesh(new THREE.CircleGeometry(0.45, 16), std(0x6fb4e0, 0.05, 0.6));
  window.position.set(0, 14.6, -1.22);
  window.rotation.y = Math.PI;
  g.add(tube, band, nose, nozzle, window);
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.18, 3.6, 2.4), red);
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    fin.position.set(Math.cos(a) * 1.8, 2.4, Math.sin(a) * 1.8);
    fin.rotation.y = -a;
    g.add(fin);
  }
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  // Flame: additive cone below the nozzle, white-hot at its root
  const flameMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const hot = positionLocal.y.add(0.5); // 1 at the nozzle .. 0 at the tip
  flameMat.colorNode = vec3(1.0, 0.45, 0.1).add(vec3(0.0, 0.5, 0.8).mul(hot.pow(3)));
  flameMat.opacityNode = hot.mul(0.9);
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.95, 1, 16, 1, true).rotateX(Math.PI), flameMat);
  flame.visible = false;
  g.add(flame);
  return {
    group: g,
    flame(f, t) {
      flame.visible = f > 0.02;
      const len = 3 + f * 14 * (1 + 0.12 * Math.sin(t * 47) + 0.08 * Math.sin(t * 71));
      flame.scale.set(0.8 + f * 0.4, len, 0.8 + f * 0.4);
      flame.position.y = -len / 2;
    }
  };
}

// A launch pad: a concrete disc with a painted ring and a service tower
function launchPad() {
  const g = new THREE.Group();
  const slab = new THREE.Mesh(new THREE.CylinderGeometry(9, 9.5, 0.6, 32), std(0x9a9a94, 0.9));
  slab.position.y = 0.3;
  const ring = new THREE.Mesh(new THREE.RingGeometry(5, 5.6, 40).rotateX(-Math.PI / 2), std(0xe0b020, 0.8));
  ring.position.y = 0.62;
  const tower = new THREE.Mesh(new THREE.BoxGeometry(1.6, 24, 1.6), std(0xc8261e, 0.6, 0.3));
  tower.position.set(5.5, 12, 0);
  const arm = new THREE.Mesh(new THREE.BoxGeometry(4, 0.6, 0.8), std(0x6a6f75, 0.6, 0.4));
  arm.position.set(3.4, 17, 0);
  g.add(slab, ring, tower, arm);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

// Smoke: a pool of puffs that grow, drift up and shrink away; emit(x, y, z) starts one
function smokeTrail(scene, count = 220) {
  const mat = new THREE.MeshStandardNodeMaterial({ color: 0xd8d8d4, roughness: 1 });
  const mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), mat, count);
  mesh.frustumCulled = false;
  mesh.count = 0;
  scene.add(mesh);
  const puffs = [];
  let next = 0;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
  const LIFE = 5;
  return {
    mesh,
    emit(x, y, z, size = 1) {
      puffs[next] = { x, y, z, age: 0, size, spin: Math.random() * 6 };
      next = (next + 1) % count;
    },
    update(dt) {
      let n = 0;
      for (const f of puffs) {
        if (!f || f.age > LIFE) continue;
        f.age += dt;
        f.y += dt * 1.2;
        const t = f.age / LIFE;
        const r = f.size * (1 + t * 5) * (t > 0.7 ? (1 - t) / 0.3 : 1);
        m.compose(p.set(f.x, f.y, f.z), q.setFromAxisAngle(s.set(0, 1, 0), f.spin), s.setScalar(Math.max(0.001, r)));
        mesh.setMatrixAt(n++, m);
      }
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
    }
  };
}

export { ufoModel, rocketModel, launchPad, smokeTrail };
