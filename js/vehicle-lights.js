import * as THREE from 'three/webgpu';

// A restrained pair of low beams. Intensity is calibrated for inverse-square decay (the previous lights used 1.22).
// Keep these ordinary, unshadowed spots so they stay in the clustered lighting path.
const HEADLIGHTS = {
  color: 0xfff8ec,
  intensity: 700,
  busIntensity: 900,
  distance: 36,
  angle: 0.14,
  penumbra: 0.85,
  decay: 2,
  pitch: 0.145,
  toeOut: 0.005,
  noseOffset: 0.08
};

function createVehicleHeadlight() {
  return new THREE.SpotLight(HEADLIGHTS.color, 0, HEADLIGHTS.distance, HEADLIGHTS.angle, HEADLIGHTS.penumbra, HEADLIGHTS.decay);
}

// A pool of `size` headlights in `group`, parked out of sight until traffic hands them out
function createHeadlightPool(group, size) {
  const pool = [];
  for (let i = 0; i < size; i++) {
    const spot = createVehicleHeadlight();
    spot.position.set(0, -1000, 0);
    spot.target.position.set(0, -1001, 0);
    group.add(spot, spot.target);
    pool.push(spot);
  }
  return pool;
}

// Switches off and parks the pool's lights from index `from` on
function parkHeadlights(pool, from) {
  for (let i = from; i < pool.length; i++) {
    pool[i].intensity = 0;
    pool[i].position.set(0, -1000, 0);
  }
}

// How strongly headlights shine for the city's interior glow (cityUniforms.uInteriorGlow): off during Midday (0.24) &
// Golden Hour (0.48), fading in for Dusk (1.25) & Night (1.55)
function headlightBeamScale(glow) {
  return Math.max(0.0, Math.min(1.28, (glow - 0.60) * 1.45));
}

// How far a vehicle `distance` m from the camera ranks for a headlight from the pool: those behind or beside the
// camera (`ahead`: its distance along the camera's forward direction) count as farther
function headlightDistance(distance, ahead) {
  return distance + Math.max(0, 5.0 - ahead) * 3.2;
}

function placeVehicleHeadlight(spot, spec, side, matrix = null) {
  const x = side * spec.headlight[0];
  const y = spec.headlight[1];
  const z = spec.zFront + HEADLIGHTS.noseOffset;
  const aim = 10;
  spot.position.set(x, y, z);
  // The upper cone edge stays just below the vehicle's horizon. A soft circular cone approximates a low beam;
  // it is not a projector cutoff. Aim relative to the chassis so bumps, banking and highway slopes carry the beam.
  spot.target.position.set(x + side * aim * HEADLIGHTS.toeOut, y - aim * Math.tan(HEADLIGHTS.pitch), z + aim);
  if (matrix) {
    spot.position.applyMatrix4(matrix);
    spot.target.position.applyMatrix4(matrix);
  }
}

export {
  HEADLIGHTS,
  createVehicleHeadlight,
  placeVehicleHeadlight,
  createHeadlightPool,
  parkHeadlights,
  headlightBeamScale,
  headlightDistance
};
