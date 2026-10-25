import * as THREE from 'three/webgpu';

// A pair of low beams that light the street ahead at night: aimed 2° down so the brightest of the beam lands on the
// road 15-30 m on, ±15° wide with a soft edge, and a gentler fall-off than inverse-square (decay 1.4), which left the
// road past the bonnet black (the beams used to be ±8°, aimed 8° down: they hit the road 5 m ahead, under the
// bonnet from the chase camera). Keep these ordinary, unshadowed spots so they stay in the clustered lighting path.
const HEADLIGHTS = {
  color: 0xfff8ec,
  intensity: 2200,
  busIntensity: 2800,
  distance: 75,
  angle: 0.26,
  penumbra: 0.6,
  decay: 1.4,
  pitch: 0.035,
  toeOut: 0.01,
  noseOffset: 0.08
};

function createVehicleHeadlight() {
  return new THREE.SpotLight(HEADLIGHTS.color, 0, HEADLIGHTS.distance, HEADLIGHTS.angle, HEADLIGHTS.penumbra, HEADLIGHTS.decay);
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

export { HEADLIGHTS, createVehicleHeadlight, placeVehicleHeadlight };
