import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';

// js/city-uniforms.js
// Live uniforms shared by the city's materials and set by the lighting / time-of-day presets (lighting.js). Kept apart
// from tsl-materials.js so models that only need these (actor-models.js) can load without a city's map data.

// Shared live uniforms controlled by lighting / time-of-day presets
const cityUniforms = {
  uSunColor: uniform(new THREE.Color(0xffca92)),
  uSkyTopColor: uniform(new THREE.Color(0x2c568c)),
  uSkyHorizonColor: uniform(new THREE.Color(0xebd1b5)),
  uSkySunDir: uniform(new THREE.Vector3(-0.66, 0.34, -0.67).normalize()),
  uInteriorGlow: uniform(0.78),
  uRoadWetness: uniform(0.38),
  uCanyonBounce: uniform(0.52)
};

export { cityUniforms };
