import * as THREE from 'three/webgpu';
import { PersonCrowd, PersonRig } from './pedestrians.js';

// js/player-actors.js
// The player's walker and cyclist for footprint cities (js/simple-vehicles.js moves them): a skinned person whose rig
// plants its feet on the ground (pedestrians.js), and a bicycle with a rider posed on it, hands on the grips and feet on
// the pedals. Ported from the NYC cyclist (js/controllers.js) with plain materials, so nothing here loads NYC data.
// City-agnostic: the frame colour comes in through options.
//
// Both face +z when built; their `heading` follows js/simple-vehicles.js (forward = (-sin h, 0, -cos h)).

function std(colour, roughness = 0.6, metalness = 0) {
  return new THREE.MeshStandardNodeMaterial({ color: colour, roughness, metalness });
}

// A walking person: call pose(dt, x, z, heading, ground) once per frame while shown
function createWalker(scene) {
  const crowd = new PersonCrowd(1, { farDistance: Infinity });
  scene.add(...crowd.meshes);
  const rig = new PersonRig({ seed: 4.2, scale: 1.0, girth: 1.02, hair: 0.18, armSwing: 1.0 });
  return {
    meshes: crowd.meshes,
    set visible(on) { for (const m of crowd.meshes) m.visible = on; },
    pose(dt, x, z, heading, ground) {
      rig.update(dt, x, z, heading + Math.PI, ground, null); // rig headings point along +z
      crowd.begin();
      crowd.add(rig, 0);
      crowd.end();
    }
  };
}

// A bicycle and its rider: pose(dt, x, y, z, heading, speed, lean, pedalling) once per frame while shown; lean > 0 leans
// into a left turn; the cranks turn only while pedalling (freewheel otherwise)
function createCyclist(scene, { frameColour = 0xf0b400 } = {}) {
  const root = new THREE.Group();
  root.name = 'player-cyclist';
  const leanPivot = new THREE.Group();
  root.add(leanPivot);

  const frameMat = std(frameColour, 0.35, 0.2);
  const tireMat = std(0x181a1e, 0.6);
  const chromeMat = std(0xe0e8f0, 0.16, 0.78);
  const darkMat = std(0x1c2028, 0.55);
  const helmetMat = std(0xf4f7fb, 0.22, 0.25);

  const tyre = new THREE.TorusGeometry(0.35, 0.038, 12, 24).rotateY(Math.PI * 0.5);
  const rim = new THREE.TorusGeometry(0.31, 0.018, 8, 24).rotateY(Math.PI * 0.5);
  const wheel = (z) => {
    const w = new THREE.Mesh(tyre, tireMat);
    w.add(new THREE.Mesh(rim, chromeMat));
    w.position.set(0, 0.38, z);
    leanPivot.add(w);
    return w;
  };
  const frontWheel = wheel(0.58), rearWheel = wheel(-0.58);
  const tube = (r0, r1, len, mat, rx, [x, y, z], rz = 0) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r0, r1, len, 10), mat);
    m.rotation.set(rx, 0, rz);
    m.position.set(x, y, z);
    leanPivot.add(m);
    return m;
  };
  tube(0.022, 0.022, 0.72, frameMat, Math.PI * 0.46, [0, 0.78, 0.04]); // top tube
  tube(0.026, 0.026, 0.78, frameMat, Math.PI * 0.28, [0, 0.58, 0.16]); // down tube
  tube(0.022, 0.022, 0.64, frameMat, -0.22, [0, 0.66, -0.22]); // seat tube
  tube(0.02, 0.016, 0.68, chromeMat, -0.24, [0, 0.68, 0.48]); // fork
  tube(0.018, 0.018, 0.48, chromeMat, 0, [0, 0.98, 0.4], Math.PI * 0.5); // handlebar
  const saddle = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.16, 8, 10), darkMat);
  saddle.rotation.x = Math.PI * 0.5;
  saddle.scale.set(1.15, 1.0, 0.55);
  saddle.position.set(0, 0.96, -0.28);
  leanPivot.add(saddle);
  const basket = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.2, 0.26), frameMat); // a city bike's front basket
  basket.position.set(0, 0.92, 0.62);
  leanPivot.add(basket);
  const tailLed = new THREE.Mesh(new THREE.SphereGeometry(0.032, 8, 8), new THREE.MeshBasicNodeMaterial({ color: 0xff1e26 }));
  tailLed.position.set(0, 0.86, -0.32);
  leanPivot.add(tailLed);

  // Cranks at the bottom bracket turn with the pedal phase; the pedals stay level
  const bikeFrame = { seat: new THREE.Vector3(0, 0.98, -0.28), bars: new THREE.Vector3(0, 0.98, 0.4), gripHalf: 0.22, bracket: new THREE.Vector3(0, 0.34, -0.145), crankLength: 0.17 };
  const crankPivot = new THREE.Group();
  crankPivot.position.copy(bikeFrame.bracket);
  const crankGeo = new THREE.BoxGeometry(0.016, bikeFrame.crankLength, 0.03).translate(0, -bikeFrame.crankLength / 2, 0);
  const pedalGeo = new THREE.BoxGeometry(0.09, 0.018, 0.07);
  const pedals = [];
  for (const side of [1, -1]) {
    const arm = new THREE.Group();
    arm.rotation.x = side > 0 ? 0 : Math.PI;
    const crank = new THREE.Mesh(crankGeo, chromeMat);
    crank.position.x = side * 0.065;
    const pedal = new THREE.Mesh(pedalGeo, tireMat);
    pedal.position.set(side * 0.1, -bikeFrame.crankLength, 0);
    arm.add(crank, pedal);
    crankPivot.add(arm);
    pedals.push(pedal);
  }
  leanPivot.add(crankPivot);
  for (const m of [...leanPivot.children]) m.traverse((o) => { if (o.isMesh) o.castShadow = true; });

  // Headlamp: a small spotlight, lit at night (setLight)
  const headLight = new THREE.SpotLight(0xf2f7ff, 0, 22, 0.34, 0.76, 1.25);
  headLight.position.set(0, 1.0, 0.7);
  headLight.target.position.set(0, 0, 7.6);
  leanPivot.add(headLight, headLight.target);

  const riderCrowd = new PersonCrowd(1, { farDistance: Infinity });
  const riderRig = new PersonRig({ seed: 12.8, scale: 1.0, girth: 0.97, hair: 0.1 });
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.125, 14, 12), helmetMat);
  helmet.scale.set(0.95, 0.68, 1.28);
  helmet.castShadow = true;
  scene.add(root, helmet, ...riderCrowd.meshes);

  let spin = 0, phase = 0;
  return {
    root,
    set visible(on) { root.visible = helmet.visible = on; for (const m of riderCrowd.meshes) m.visible = on; },
    setLight(intensity) { headLight.intensity = intensity; },
    pose(dt, x, y, z, heading, speed, lean, pedalling) {
      root.position.set(x, y, z);
      root.rotation.set(0, heading + Math.PI, 0); // built facing +z
      leanPivot.rotation.z = -lean;
      spin += (speed * dt) / 0.38;
      frontWheel.rotation.x = rearWheel.rotation.x = spin;
      if (pedalling && speed > 0) phase += ((speed * dt) / 0.38) / 3.2; // through the gears, as js/controllers.js
      crankPivot.rotation.x = phase;
      for (const p of pedals) p.rotation.x = -phase;
      riderRig.ride(leanPivot, phase, bikeFrame);
      riderCrowd.begin();
      riderCrowd.add(riderRig, 0);
      riderCrowd.end();
      helmet.quaternion.copy(riderRig.headQuaternion);
      helmet.position.set(0, 0.175, -0.012).applyQuaternion(helmet.quaternion).add(riderRig.headPosition);
    }
  };
}

export { createWalker, createCyclist };
