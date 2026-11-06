import * as THREE from 'three'
import { HAND, PERSONA } from '../config.js'
import { POSE_LANDMARKS } from '../vision/pose.js'

/** The debug geometry scan is scaffolding; keep it out of the production build. */
const DEV = Boolean(import.meta.env?.DEV)

/**
 * Default tunables for the face-dust layer (the filled, carved point cloud). These mirror
 * `PERSONA` so the current values stay the defaults, but they are exposed as the overridable
 * `face` parameter of `createPersona` — pass e.g. `face: { faceDustDrift: 0.02 }` at the call site.
 */
export const FACE_DUST_DEFAULTS = {
  faceColor: PERSONA.faceColor,
  faceDustCount: PERSONA.faceDustCount,
  faceDustSize: PERSONA.faceDustSize,
  faceDustOpacity: PERSONA.faceDustOpacity,
  faceDustDrift: PERSONA.faceDustDrift,
  faceDustRise: PERSONA.faceDustRise,
  faceCarveSoftness: PERSONA.faceCarveSoftness,
  faceDepth: PERSONA.faceDepth,
}

/**
 * Default tunables for the torso dust cloud. They mirror `PERSONA` so the current values stay the
 * defaults, but they are also exposed as the overridable `torso` parameter of `createPersona` —
 * pass e.g. `torso: { drift: 0.1 }` to adjust at the call site.
 */
export const TORSO_DEFAULTS = {
  particleCount: PERSONA.particleCount,
  particleRadius: PERSONA.particleRadius,
  dustColor: PERSONA.dustColor,
  dustOpacity: PERSONA.dustOpacity,
  dustSpread: PERSONA.dustSpread,
  depth: PERSONA.depth,
  drift: PERSONA.drift,
  rise: PERSONA.rise,
}

/**
 * Default tunables for the per-hand dust cloud. They mirror `HAND` so the current values stay
 * the defaults, but they are also exposed as the overridable `hand` parameter of `createPersona`.
 */
export const HAND_DEFAULTS = {
  handParticleCount: HAND.particleCount,
  handParticleRadius: HAND.particleRadius,
  handDustColor: HAND.dustColor,
  handDustOpacity: HAND.dustOpacity,
  handDustSpread: HAND.dustSpread,
  handArmThickness: HAND.armThickness,
  handArmElbowTaper: HAND.armElbowTaper,
  handArmTaper: HAND.armTaper,
  handCapCount: HAND.capCount,
  handCapSize: HAND.capSize,
  handCapOpacity: HAND.capOpacity,
  handCapColor: HAND.capColor,
  handCapSpread: HAND.capSpread,
  handDepth: HAND.depth,
  handDrift: HAND.drift,
  handRise: HAND.rise,
  handMinSpan: HAND.minSpan,
}

/**
 * The persona: a wispy, dusty silhouette that mirrors the player.
 *
 * Layers share the frame and one opacity ramp:
 *   - `dust`   — points seeded across the shoulder→hip volume, drifting on their own noise so the
 *                torso reads as a wispy, dusty silhouette;
 *   - `hand`   — one small dust cloud per tracked hand, seeded across that hand's bounding box;
 *   - `face`   — a filled, drifting point cloud across the whole face, with the eyes, nose and
 *                mouth carved out as empty space.
 *   - `headDust` — a halo of dust around the face.
 *
 * Only normalised landmark coordinates are used for geometry: they are what the mirror shows,
 * so mapping them straight onto the orthographic frame keeps the figure aligned with the
 * player's reflection. (Aspect handling lives in `toWorld`, so x and y map at the same scale.)
 */

/**
 * 3D value noise. The extra axis lets time be a real dimension, so dissolve patterns morph in
 * place instead of scrolling a 2D slice across the surface. Same ~[0, 0.94] range as `fbm`, so
 * existing dissolve thresholds carry over.
 */
const NOISE3D_GLSL = /* glsl */ `
  float hash31(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  float valueNoise3(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);

    // Blend the 8 corners of the cube the sample falls inside.
    return mix(
      mix(mix(hash31(i + vec3(0.0, 0.0, 0.0)), hash31(i + vec3(1.0, 0.0, 0.0)), f.x),
          mix(hash31(i + vec3(0.0, 1.0, 0.0)), hash31(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
      mix(mix(hash31(i + vec3(0.0, 0.0, 1.0)), hash31(i + vec3(1.0, 0.0, 1.0)), f.x),
          mix(hash31(i + vec3(0.0, 1.0, 1.0)), hash31(i + vec3(1.0, 1.0, 1.0)), f.x), f.y),
      f.z);
  }

  float fbm3(vec3 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 4; i++) {
      value += amplitude * valueNoise3(p);
      p = p * 2.02 + 7.13;
      amplitude *= 0.5;
    }
    return value;
  }
`

const DUST_VERTEX = /* glsl */ `
  attribute float aSeed;
  attribute float aSize;

  uniform float uTime;
  uniform float uShoulderWidth;
  uniform float uHipWidth;
  uniform float uTorsoHeight;
  uniform float uSpread;
  uniform float uDepth;
  uniform float uDrift;
  uniform float uRise;
  uniform float uPointScale;
  uniform float uOpacity;

  ${NOISE3D_GLSL}

  void main() {
    float t = position.y + 0.5;
    float width = mix(uHipWidth, uShoulderWidth, t) * uSpread;

    vec3 p;
    p.x = position.x * width;
    p.y = position.y * uTorsoHeight;
    p.z = position.z * uDepth;

    // Independent drift per particle; time is the third axis so neighbours flow together.
    float n1 = valueNoise3(vec3(p.xy * 1.7 + aSeed, uTime * 0.22));
    float n2 = valueNoise3(vec3(p.xy * 1.4 + aSeed * 1.7, uTime * 0.18 + 4.2));
    p.x += (n1 - 0.5) * uDrift;
    p.y += (n2 - 0.5) * uDrift;
    p.z += (n1 - 0.5) * uDepth;
    p.y += sin(uTime * 0.6 + aSeed * 6.2831) * uRise;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = aSize * uPointScale * clamp(uOpacity * 1.5, 0.0, 1.0);
  }
`

const DUST_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;

  void main() {
    // Soft round sprite, no texture needed.
    float d = length(gl_PointCoord - 0.5);
    float alpha = (1.0 - smoothstep(0.0, 0.5, d)) * uOpacity;
    if (alpha < 0.003) discard;
    gl_FragColor = vec4(uColor, alpha);
  }
`

/**
 * Arm dust: a particle cloud seeded in a unit box that the shader stretches into a straight
 * tapered capsule from the shoulder (local x = -0.5) to the hand (local x = +0.5). The radius
 * tapers from `uShoulderThick` to `uHandThick`, so the same dust that forms the torso also runs
 * continuously down the arm and gathers on the hand.
 */
const HAND_ARM_VERTEX = /* glsl */ `
  attribute float aSeed;
  attribute float aSize;

  uniform float uTime;
  uniform float uLength;
  uniform float uShoulderThick;
  uniform float uHandThick;
  uniform float uDepth;
  uniform float uSpread;
  uniform float uDrift;
  uniform float uRise;
  uniform float uPointScale;
  uniform float uOpacity;

  ${NOISE3D_GLSL}

  void main() {
    // position.x runs -0.5 (shoulder) → +0.5 (hand); position.yz is the round cross-section.
    float t = position.x + 0.5;
    float radius = mix(uShoulderThick, uHandThick, t) * uSpread;

    vec3 p;
    p.x = position.x * uLength;
    p.y = position.y * radius;
    p.z = position.z * radius * uDepth;

    // Independent drift per particle; time is the third axis so neighbours flow together.
    float n1 = valueNoise3(vec3(p.xy * 1.7 + aSeed, uTime * 0.22));
    float n2 = valueNoise3(vec3(p.xy * 1.4 + aSeed * 1.7, uTime * 0.18 + 4.2));
    p.x += (n1 - 0.5) * uDrift;
    p.y += (n2 - 0.5) * uDrift;
    p.z += (n1 - 0.5) * uDepth;
    p.y += sin(uTime * 0.6 + aSeed * 6.2831) * uRise;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = aSize * uPointScale * clamp(uOpacity * 1.5, 0.0, 1.0);
  }
`

/**
 * Hand cap: a small, dense cloud seeded over the hand's bounding box. It sits at the end of the
 * arm capsule, brighter and denser than the arm, so the hand reads as a distinct silhouette
 * rather than just the tapered tip of the arm.
 */
const HAND_CAP_VERTEX = /* glsl */ `
  attribute float aSeed;
  attribute float aSize;

  uniform float uTime;
  uniform float uWidth;
  uniform float uHeight;
  uniform float uDepth;
  uniform float uSpread;
  uniform float uDrift;
  uniform float uRise;
  uniform float uPointScale;
  uniform float uOpacity;

  ${NOISE3D_GLSL}

  void main() {
    vec3 p;
    p.x = position.x * uWidth * uSpread;
    p.y = position.y * uHeight * uSpread;
    p.z = position.z * uDepth;

    // Independent drift per particle; time is the third axis so neighbours flow together.
    float n1 = valueNoise3(vec3(p.xy * 1.7 + aSeed, uTime * 0.22));
    float n2 = valueNoise3(vec3(p.xy * 1.4 + aSeed * 1.7, uTime * 0.18 + 4.2));
    p.x += (n1 - 0.5) * uDrift;
    p.y += (n2 - 0.5) * uDrift;
    p.z += (n1 - 0.5) * uDepth;
    p.y += sin(uTime * 0.6 + aSeed * 6.2831) * uRise;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = aSize * uPointScale * clamp(uOpacity * 1.5, 0.0, 1.0);
  }
`

/**
 * Head dust: a halo of particles whose rest positions are a unit annulus around the face. The
 * shader scales that ring by the measured face radius and lets it drift/shift upward, so the
 * same dust that lifts off the body also gathers around the head.
 */
const HEAD_DUST_VERTEX = /* glsl */ `
  attribute float aSeed;
  attribute float aSize;

  uniform float uTime;
  uniform float uRadius;
  uniform float uSpread;
  uniform float uDepth;
  uniform float uDrift;
  uniform float uRise;
  uniform float uPointScale;
  uniform float uOpacity;

  ${NOISE3D_GLSL}

  void main() {
    // position.xy is seeded in a unit annulus; scale it to the face radius, then overshoot so
    // the dust hugs and spills past the outline rather than filling the face.
    vec3 p;
    p.x = position.x * uRadius * uSpread;
    p.y = position.y * uRadius * uSpread;
    p.z = position.z * uDepth;

    // Independent drift per particle, plus a slow rise so dust lifts off the head.
    float n1 = valueNoise3(vec3(p.xy * 2.2 + aSeed, uTime * 0.22));
    float n2 = valueNoise3(vec3(p.xy * 1.7 + aSeed * 1.7, uTime * 0.18 + 4.2));
    p.x += (n1 - 0.5) * uDrift;
    p.y += (n2 - 0.5) * uDrift;
    p.y += sin(uTime * 0.55 + aSeed * 6.2831) * uRise;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = aSize * uPointScale * clamp(uOpacity * 1.5, 0.0, 1.0);
  }
`

/**
 * Face dust: a filled point cloud seeded across the face mesh. Positions are written on the CPU
 * every frame (barycentric interpolation of the live landmarks, plus drift), so this shader only
 * has to size the sprite and pass the per-particle carve mask through. `aMask` is 0 over the
 * eyes/nose/mouth holes and 1 over the skin, with a soft edge — that is what keeps those
 * features as empty space rather than dust.
 */
const FACE_DUST_VERTEX = /* glsl */ `
  attribute float aSize;
  attribute float aMask;

  uniform float uPointScale;
  uniform float uOpacity;

  varying float vMask;

  void main() {
    vMask = aMask;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uPointScale * clamp(uOpacity * 1.5, 0.0, 1.0);
  }
`

const FACE_DUST_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;

  varying float vMask;

  void main() {
    // Soft round sprite, faded by the carve mask so feature holes stay empty.
    float d = length(gl_PointCoord - 0.5);
    float alpha = (1.0 - smoothstep(0.0, 0.5, d)) * uOpacity * vMask;
    if (alpha < 0.003) discard;
    gl_FragColor = vec4(uColor, alpha);
  }
`

function createDust(spec, pixelRatio) {
  const count = spec.particleCount
  const positions = new Float32Array(count * 3)
  const seeds = new Float32Array(count)
  const sizes = new Float32Array(count)

  for (let i = 0; i < count; i += 1) {
    positions[i * 3] = Math.random() - 0.5
    positions[i * 3 + 1] = Math.random() - 0.5
    positions[i * 3 + 2] = Math.random() - 0.5
    seeds[i] = Math.random()
    sizes[i] = 0.4 + Math.random() * 0.9
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1))
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))

  const uniforms = {
    uTime: { value: 0 },
    uColor: { value: new THREE.Color(spec.dustColor) },
    uOpacity: { value: 0 },
    uShoulderWidth: { value: 0.5 },
    uHipWidth: { value: 0.4 },
    uTorsoHeight: { value: 0.5 },
    uSpread: { value: spec.dustSpread },
    uDepth: { value: spec.depth },
    uDrift: { value: spec.drift },
    uRise: { value: spec.rise },
    uPointScale: { value: spec.particleRadius * pixelRatio },
  }

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: DUST_VERTEX,
    fragmentShader: DUST_FRAGMENT,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })

  const points = new THREE.Points(geometry, material)
  points.name = 'dust'
  points.frustumCulled = false
  points.renderOrder = 1

  return { points, uniforms }
}

function createHandArm(spec, pixelRatio) {
  const count = spec.handParticleCount
  const positions = new Float32Array(count * 3)
  const seeds = new Float32Array(count)
  const sizes = new Float32Array(count)

  for (let i = 0; i < count; i += 1) {
    // Seed a unit box; the shader stretches it into the shoulder→hand arm capsule each frame.
    positions[i * 3] = Math.random() - 0.5
    positions[i * 3 + 1] = Math.random() - 0.5
    positions[i * 3 + 2] = Math.random() - 0.5
    seeds[i] = Math.random()
    sizes[i] = 0.4 + Math.random() * 0.9
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1))
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))

  const uniforms = {
    uTime: { value: 0 },
    uColor: { value: new THREE.Color(spec.handDustColor) },
    uOpacity: { value: 0 },
    uLength: { value: 0.3 },
    uShoulderThick: { value: 0.1 },
    uHandThick: { value: 0.05 },
    uDepth: { value: spec.handDepth },
    uSpread: { value: spec.handDustSpread },
    uDrift: { value: spec.handDrift },
    uRise: { value: spec.handRise },
    uPointScale: { value: spec.handParticleRadius * pixelRatio },
  }

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: HAND_ARM_VERTEX,
    fragmentShader: DUST_FRAGMENT,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })

  const points = new THREE.Points(geometry, material)
  points.name = 'handArm'
  points.frustumCulled = false
  points.renderOrder = 1
  points.visible = false

  return { points, uniforms }
}

function createHandCap(spec, pixelRatio) {
  const count = spec.handCapCount
  const positions = new Float32Array(count * 3)
  const seeds = new Float32Array(count)
  const sizes = new Float32Array(count)

  for (let i = 0; i < count; i += 1) {
    // Seed a unit box; the shader scales it to the hand's bounding box each frame.
    positions[i * 3] = Math.random() - 0.5
    positions[i * 3 + 1] = Math.random() - 0.5
    positions[i * 3 + 2] = Math.random() - 0.5
    seeds[i] = Math.random()
    // Larger sprites than the arm so the hand reads denser and more prominent.
    sizes[i] = 0.7 + Math.random() * 1.1
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1))
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))

  const uniforms = {
    uTime: { value: 0 },
    uColor: { value: new THREE.Color(spec.handCapColor) },
    uOpacity: { value: 0 },
    uWidth: { value: 0.2 },
    uHeight: { value: 0.2 },
    uDepth: { value: spec.handDepth },
    uSpread: { value: spec.handCapSpread },
    uDrift: { value: spec.handDrift },
    uRise: { value: spec.handRise },
    uPointScale: { value: spec.handCapSize * pixelRatio },
  }

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: HAND_CAP_VERTEX,
    fragmentShader: DUST_FRAGMENT,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })

  const points = new THREE.Points(geometry, material)
  points.name = 'handCap'
  points.frustumCulled = false
  points.renderOrder = 2 // above the arm, so the hand reads as the front layer
  points.visible = false

  return { points, uniforms }
}

function createHeadDust(spec, pixelRatio) {
  const count = spec.headDustCount
  const positions = new Float32Array(count * 3)
  const seeds = new Float32Array(count)
  const sizes = new Float32Array(count)

  for (let i = 0; i < count; i += 1) {
    // Seed an annulus (0.55–1.0 of the unit radius) so the halo hugs and spreads past the face.
    const angle = Math.random() * Math.PI * 2
    const radius = 0.55 + Math.random() * 0.45
    positions[i * 3] = Math.cos(angle) * radius
    positions[i * 3 + 1] = Math.sin(angle) * radius
    positions[i * 3 + 2] = Math.random() - 0.5
    seeds[i] = Math.random()
    sizes[i] = 0.4 + Math.random() * 0.9
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1))
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))

  const uniforms = {
    uTime: { value: 0 },
    uColor: { value: new THREE.Color(spec.headDustColor) },
    uOpacity: { value: 0 },
    uRadius: { value: 0.2 },
    uSpread: { value: spec.headDustSpread },
    uDepth: { value: spec.depth },
    uDrift: { value: spec.headDustDrift },
    uRise: { value: spec.headDustRise },
    uPointScale: { value: spec.headDustSize * pixelRatio },
  }

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: HEAD_DUST_VERTEX,
    fragmentShader: DUST_FRAGMENT,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })

  const points = new THREE.Points(geometry, material)
  points.name = 'headDust'
  points.frustumCulled = false
  points.renderOrder = 1
  points.visible = false

  return { points, uniforms }
}

/**
 * Face dust: sample particles uniformly across the face tesselation. Each particle stores the
 * triangle it landed in plus barycentric weights, so its world position can be rebuilt from the
 * live landmarks every frame — which is what keeps the fill glued to the moving face.
 *
 * The eyes/nose/mouth are not excluded here: the tesselation covers them too, and they are
 * punched out later by the carve mask. That keeps the seeding a single uniform pass.
 */
function createFaceDust(triangles, spec, pixelRatio) {
  const triangleCount = Math.floor(triangles.length / 3)
  const count = triangleCount ? spec.faceDustCount : 0

  const positions = new Float32Array(count * 3)
  const sizes = new Float32Array(count)
  const masks = new Float32Array(count)
  const seeds = new Float32Array(count)
  const baryU = new Float32Array(count)
  const baryV = new Float32Array(count)
  const triangle = new Uint16Array(count)

  for (let i = 0; i < count; i += 1) {
    // Uniform barycentric point inside a randomly chosen triangle.
    triangle[i] = Math.floor(Math.random() * triangleCount)
    let u = Math.random()
    let v = Math.random()
    if (u + v > 1) {
      u = 1 - u
      v = 1 - v
    }
    baryU[i] = u
    baryV[i] = v

    seeds[i] = Math.random()
    sizes[i] = 0.6 + Math.random() * 0.8
    masks[i] = 1
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))
  geometry.setAttribute('aMask', new THREE.BufferAttribute(masks, 1))

  const uniforms = {
    uTime: { value: 0 },
    uColor: { value: new THREE.Color(spec.faceColor) },
    uOpacity: { value: 0 },
    uPointScale: { value: spec.faceDustSize * pixelRatio },
  }

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: FACE_DUST_VERTEX,
    fragmentShader: FACE_DUST_FRAGMENT,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })

  const points = new THREE.Points(geometry, material)
  points.name = 'faceDust'
  points.frustumCulled = false
  points.renderOrder = 3
  points.visible = false

  return {
    points,
    geometry,
    uniforms,
    count,
    triangleCount,
    triangles,
    layout: { triangle, baryU, baryV, seeds },
    // Scratch buffers for the per-frame landmark projection, grown on demand.
    worldX: new Float32Array(0),
    worldY: new Float32Array(0),
  }
}

const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

/** Shader-style smoothstep, used for the soft carve edge around a feature. */
function smoothstep01(t) {
  const x = Math.min(Math.max(t, 0), 1)
  return x * x * (3 - 2 * x)
}

/** Even-odd point-in-polygon test over a flat [x0, y0, x1, y1, …] array. */
function pointInPolygon(x, y, polygon) {
  let inside = false
  for (let i = 0, j = polygon.length - 2; i < polygon.length; j = i, i += 2) {
    const xi = polygon[i]
    const yi = polygon[i + 1]
    const xj = polygon[j]
    const yj = polygon[j + 1]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

/** Squared distance from a point to a segment (avoids a sqrt per edge). */
function distanceToSegmentSq(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const lenSq = dx * dx + dy * dy
  let t = lenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0
  t = Math.min(Math.max(t, 0), 1)
  const ex = px - (ax + t * dx)
  const ey = py - (ay + t * dy)
  return ex * ex + ey * ey
}

/** Convex hull (monotone chain) of [x, y] points, returned as a flat polygon. */
function convexHull(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o, a, b) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

  const lower = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop()
    }
    lower.push(p)
  }

  const upper = []
  for (let i = pts.length - 1; i >= 0; i -= 1) {
    const p = pts[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop()
    }
    upper.push(p)
  }

  lower.pop()
  upper.pop()
  return lower.concat(upper).flatMap((p) => [p[0], p[1]])
}

/**
 * Build the carve polygons in world space from the live landmarks. A region with a missing or
 * non-finite vertex is skipped, so one bad landmark cannot blank the whole face.
 */
function buildCarveRegions(regions, worldX, worldY) {
  const polygons = []

  for (const region of regions) {
    const points = []
    let valid = true
    for (const index of region.indices) {
      const x = worldX[index]
      const y = worldY[index]
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        valid = false
        break
      }
      points.push([x, y])
    }
    if (!valid || points.length < 3) continue

    const polygon = region.hull ? convexHull(points) : points.flatMap((p) => p)
    if (polygon.length < 6) continue

    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (let i = 0; i < polygon.length; i += 2) {
      minX = Math.min(minX, polygon[i])
      maxX = Math.max(maxX, polygon[i])
      minY = Math.min(minY, polygon[i + 1])
      maxY = Math.max(maxY, polygon[i + 1])
    }
    polygons.push({ points: polygon, minX, maxX, minY, maxY })
  }

  return polygons
}

/** 1 over skin, 0 inside a carved feature, with a soft falloff of `softness` at its edge. */
function carveMask(px, py, polygons, softness) {
  let mask = 1
  for (const polygon of polygons) {
    // Bounding-box prune: points well outside a feature can't be affected by it.
    if (
      px < polygon.minX - softness ||
      px > polygon.maxX + softness ||
      py < polygon.minY - softness ||
      py > polygon.maxY + softness
    ) {
      continue
    }
    if (pointInPolygon(px, py, polygon.points)) return 0

    let nearestSq = Infinity
    const points = polygon.points
    for (let i = 0, j = points.length - 2; i < points.length; j = i, i += 2) {
      const d = distanceToSegmentSq(px, py, points[j], points[j + 1], points[i], points[i + 1])
      if (d < nearestSq) nearestSq = d
    }

    const distance = Math.sqrt(nearestSq)
    const edge = softness > 1e-6
      ? smoothstep01(distance / softness)
      : distance > 1e-6
        ? 1
        : 0
    if (edge < mask) mask = edge
  }
  return mask
}

/**
 * Normalised image coords → mirror-frame world coords.
 *
 * `x` is flipped (`0.5 - x`) because the persona replaces the player's *mirror* image, and
 * scaled by the full frame width so it matches the orthographic frustum. `y` is flipped for
 * the same reason: image space grows downward, world space grows upward.
 */
function toWorld(landmark, view) {
  if (!landmark) return null

  const { x, y } = landmark
  const halfWidth = view?.halfWidth
  const halfHeight = view?.halfHeight

  // A single non-finite landmark coordinate, or a zero-size viewport that made the aspect
  // non-finite, would poison a position buffer and make the renderer's bounding-sphere pass
  // (used for depth sorting) log "Computed radius is NaN". Treat those frames as "not yet".
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  if (!Number.isFinite(halfWidth) || !Number.isFinite(halfHeight)) return null

  return {
    x: (0.5 - x) * halfWidth * 2,
    y: (0.5 - y) * halfHeight * 2,
  }
}

function updateTorso(landmarks, view, torso, dustUniforms) {
  const left = toWorld(landmarks[POSE_LANDMARKS.LEFT_SHOULDER], view)
  const right = toWorld(landmarks[POSE_LANDMARKS.RIGHT_SHOULDER], view)
  if (!left || !right) return

  const leftHip = toWorld(landmarks[POSE_LANDMARKS.LEFT_HIP], view)
  const rightHip = toWorld(landmarks[POSE_LANDMARKS.RIGHT_HIP], view)

  const shoulderMid = midpoint(left, right)
  const shoulderWidth = distance(left, right)
  if (shoulderWidth < 1e-4) return

  let hipMid = null
  let hipWidth = 0
  if (leftHip && rightHip) {
    const candidateMid = midpoint(leftHip, rightHip)
    const candidateWidth = distance(leftHip, rightHip)
    // Reject a degenerate or inverted hip estimate (cropped hips often collapse onto each other).
    if (candidateWidth > shoulderWidth * 0.2 && candidateMid.y < shoulderMid.y) {
      hipMid = candidateMid
      hipWidth = candidateWidth
    }
  }
  if (!hipMid) {
    // A mirror-mounted camera often crops the hips. Extrapolate a plausible waist below the
    // shoulders rather than falling back to a generic torso parked at the origin.
    hipMid = { x: shoulderMid.x, y: shoulderMid.y - shoulderWidth * 1.1 }
    hipWidth = shoulderWidth * 0.8
  }

  const center = midpoint(shoulderMid, hipMid)
  const torsoHeight = distance(shoulderMid, hipMid)

  torso.position.set(center.x, center.y, 0)

  // Follow the shoulder tilt. Normalise the horizontal direction so the mesh can never flip a
  // half-turn (which would put the shoulders at the hips).
  let dx = right.x - left.x
  let dy = right.y - left.y
  if (dx < 0) {
    dx = -dx
    dy = -dy
  }
  torso.rotation.z = Math.atan2(dy, dx)

  dustUniforms.uShoulderWidth.value = shoulderWidth
  dustUniforms.uHipWidth.value = hipWidth
  dustUniforms.uTorsoHeight.value = torsoHeight
}

function updateHeadDust(faceStatus, headDust, depth) {
  const radius = faceStatus?.visible
    ? Math.max(faceStatus.width, faceStatus.height) * 0.5
    : 0

  if (!(radius > 1e-4)) {
    headDust.points.visible = false
    return
  }

  // Reuse the face bounds: x/y is the face centre, width/height its world size.
  headDust.points.position.set(faceStatus.x, faceStatus.y, depth)
  headDust.uniforms.uRadius.value = radius
  headDust.points.visible = true
}

/**
 * Drive the face-dust point cloud: rebuild every particle's world position from the live
 * barycentric weights, drift it, and carve the eye/nose/mouth holes through its mask.
 *
 * Everything happens on the CPU so the carve tests the exact position that gets rendered. Returns
 * the face bounds so the head halo can follow it.
 */
function updateFaceDust(faceLandmarks, faceDust, regions, view, depth, time, spec) {
  const { points, geometry, count, layout } = faceDust

  if (!count) {
    points.visible = false
    return { visible: false, reason: 'no-particles', total: 0 }
  }
  if (!faceLandmarks) {
    points.visible = false
    return { visible: false, reason: 'no-face', total: count }
  }

  const halfWidth = view?.halfWidth
  const halfHeight = view?.halfHeight
  if (!Number.isFinite(halfWidth) || !Number.isFinite(halfHeight)) {
    points.visible = false
    return { visible: false, reason: 'non-finite view', total: count }
  }

  // Project every landmark once; the particles reuse these.
  const landmarkCount = faceLandmarks.length
  if (faceDust.worldX.length < landmarkCount) {
    faceDust.worldX = new Float32Array(landmarkCount)
    faceDust.worldY = new Float32Array(landmarkCount)
  }
  const worldX = faceDust.worldX
  const worldY = faceDust.worldY
  const fullWidth = halfWidth * 2
  const fullHeight = halfHeight * 2

  for (let i = 0; i < landmarkCount; i += 1) {
    const landmark = faceLandmarks[i]
    if (!landmark || !Number.isFinite(landmark.x) || !Number.isFinite(landmark.y)) {
      worldX[i] = NaN
      worldY[i] = NaN
      continue
    }
    worldX[i] = (0.5 - landmark.x) * fullWidth
    worldY[i] = (0.5 - landmark.y) * fullHeight
  }

  const polygons = buildCarveRegions(regions, worldX, worldY)
  const softness = spec.faceCarveSoftness
  const drift = spec.faceDustDrift
  const rise = spec.faceDustRise

  const positions = geometry.attributes.position.array
  const masks = geometry.attributes.aMask.array
  const triangles = faceDust.triangles
  const { triangle, baryU, baryV, seeds } = layout

  let written = 0
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity

  for (let i = 0; i < count; i += 1) {
    const t = triangle[i] * 3
    const a = triangles[t]
    const b = triangles[t + 1]
    const c = triangles[t + 2]
    const ax = worldX[a]
    const ay = worldY[a]
    const bx = worldX[b]
    const by = worldY[b]
    const cx = worldX[c]
    const cy = worldY[c]

    if (
      !Number.isFinite(ax) || !Number.isFinite(ay) ||
      !Number.isFinite(bx) || !Number.isFinite(by) ||
      !Number.isFinite(cx) || !Number.isFinite(cy)
    ) {
      masks[i] = 0
      continue
    }

    const u = baryU[i]
    const v = baryV[i]
    const w0 = 1 - u - v

    let x = w0 * ax + u * bx + v * cx
    let y = w0 * ay + u * by + v * cy

    // Per-particle drift, so the face breathes like the torso dust. Sinusoids with a per-particle
    // phase read as organic smoke and are far cheaper than a full CPU noise field each frame.
    const phase = seeds[i] * Math.PI * 2
    x += Math.sin(time * 0.6 + phase) * drift
    x += Math.sin(time * 1.7 + phase * 1.3) * drift * 0.35
    y += Math.cos(time * 0.5 + phase * 0.7) * drift
    y += Math.sin(time * 1.3 + phase * 2.1) * rise

    const mask = polygons.length ? carveMask(x, y, polygons, softness) : 1
    masks[i] = mask
    positions[i * 3] = x
    positions[i * 3 + 1] = y
    positions[i * 3 + 2] = depth

    if (mask > 0.01) {
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
      written += 1
    }
  }

  geometry.attributes.position.needsUpdate = written > 0
  geometry.attributes.aMask.needsUpdate = true
  points.visible = written > 0

  if (!written) {
    return { visible: false, reason: 'all-carved', total: count }
  }

  return {
    visible: true,
    reason: 'ok',
    total: count,
    written,
    width: maxX - minX,
    height: maxY - minY,
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
  }
}

/** World-space bounding box of a hand's 21 landmarks, or null when it cannot be measured. */
function handBounds(handLandmarks, view) {
  const halfWidth = view?.halfWidth
  const halfHeight = view?.halfHeight
  if (!Number.isFinite(halfWidth) || !Number.isFinite(halfHeight)) return null

  const fullWidth = halfWidth * 2
  const fullHeight = halfHeight * 2

  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  let written = 0

  for (const landmark of handLandmarks) {
    if (!landmark) continue
    const { x, y } = landmark
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue

    const worldX = (0.5 - x) * fullWidth
    const worldY = (0.5 - y) * fullHeight
    minX = Math.min(minX, worldX)
    maxX = Math.max(maxX, worldX)
    minY = Math.min(minY, worldY)
    maxY = Math.max(maxY, worldY)
    written += 1
  }

  if (written < 2) return null

  return {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    width: maxX - minX,
    height: maxY - minY,
    radius: Math.max(maxX - minX, maxY - minY) / 2,
    written,
  }
}

/**
 * Point one dust capsule from `from` to `to`, tapering its radius from `fromThick` to `toThick`.
 *
 * The cloud is a unit box stretched along its local x-axis and rotated to the segment vector, so
 * local -x lands on `from` and local +x lands on `to`. Two of these — shoulder→elbow and
 * elbow→hand — make one continuous arm that bends at the elbow.
 */
function updateArmSegment(from, to, fromThick, toThick, arm, spec) {
  const points = arm.points
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy)

  if (length < 1e-4 || fromThick < 1e-4) {
    points.visible = false
    return { visible: false, length: 0 }
  }

  points.position.set((from.x + to.x) / 2, (from.y + to.y) / 2, spec.handDepth)
  points.rotation.z = Math.atan2(dy, dx)

  arm.uniforms.uLength.value = length
  arm.uniforms.uShoulderThick.value = fromThick
  arm.uniforms.uHandThick.value = toThick
  points.visible = true

  return { visible: true, length }
}

/** Position the bright hand cap over the hand's bounding box at the end of the arm. */
function updateHandCap(handBox, handCap, spec) {
  const points = handCap.points

  if (handBox.width < 1e-4 && handBox.height < 1e-4) {
    points.visible = false
    return false
  }

  points.position.set(handBox.x, handBox.y, spec.handDepth)
  handCap.uniforms.uWidth.value = handBox.width
  handCap.uniforms.uHeight.value = handBox.height
  points.visible = true
  return true
}

/**
 * Drive every hand's arm and hand cap, attaching each tracked hand to its nearest pose shoulder.
 *
 * Each arm is two capsules — shoulder→elbow and elbow→hand — so it bends naturally at the elbow;
 * when the elbow is missing it falls back to a single straight shoulder→hand capsule.
 *
 * Two hands can both be tracked, so shoulders are claimed greedily: once an arm has taken a
 * shoulder the other hand picks the remaining one, which keeps the two arms from collapsing
 * onto the same side of the body.
 */
function updateHands(landmarks, handLandmarks, handUnits, view, spec) {
  const statuses = handUnits.map(() => ({ visible: false, reason: 'no-hand', cap: false }))
  if (!handUnits.length) return statuses

  for (const unit of handUnits) {
    for (const arm of unit.arms) arm.points.visible = false
    unit.cap.points.visible = false
  }

  const left = toWorld(landmarks?.[POSE_LANDMARKS.LEFT_SHOULDER], view)
  const right = toWorld(landmarks?.[POSE_LANDMARKS.RIGHT_SHOULDER], view)
  if (!left || !right) {
    return statuses.map(() => ({ visible: false, reason: 'no-shoulders', cap: false }))
  }

  const shoulders = [left, right]
  const elbows = [
    toWorld(landmarks?.[POSE_LANDMARKS.LEFT_ELBOW], view),
    toWorld(landmarks?.[POSE_LANDMARKS.RIGHT_ELBOW], view),
  ]
  const shoulderWidth = distance(left, right)
  const claimed = new Set()

  for (let i = 0; i < handUnits.length; i += 1) {
    const unit = handUnits[i]
    const hand = handLandmarks?.[i]
    if (!hand) continue

    const box = handBounds(hand, view)
    if (!box) {
      statuses[i] = { visible: false, reason: 'no-hand-bounds', cap: false }
      continue
    }

    // Nearest unclaimed shoulder; fall back to the nearest overall if both are already taken.
    let best = -1
    let bestDist = Infinity
    for (let s = 0; s < shoulders.length; s += 1) {
      if (claimed.has(s)) continue
      const d = Math.hypot(box.x - shoulders[s].x, box.y - shoulders[s].y)
      if (d < bestDist) {
        bestDist = d
        best = s
      }
    }
    if (best < 0) {
      for (let s = 0; s < shoulders.length; s += 1) {
        const d = Math.hypot(box.x - shoulders[s].x, box.y - shoulders[s].y)
        if (d < bestDist) {
          bestDist = d
          best = s
        }
      }
    }
    if (best < 0) {
      statuses[i] = { visible: false, reason: 'no-shoulder', cap: false }
      continue
    }

    claimed.add(best)

    const shoulder = shoulders[best]
    const elbow = elbows[best]
    const handPoint = { x: box.x, y: box.y }

    const shoulderThick = shoulderWidth * spec.handArmThickness
    const elbowThick = shoulderThick * spec.handArmElbowTaper
    const handThick = shoulderThick * spec.handArmTaper

    // Bend only when the elbow is tracked and its two segments are a plausible arm. A missing or
    // wildly misplaced elbow (cropped, or behind the shoulder) falls back to one straight capsule.
    const armSpan = Math.hypot(handPoint.x - shoulder.x, handPoint.y - shoulder.y)
    let useElbow = false
    if (elbow && armSpan > spec.handMinSpan) {
      const upper = Math.hypot(elbow.x - shoulder.x, elbow.y - shoulder.y)
      const fore = Math.hypot(handPoint.x - elbow.x, handPoint.y - elbow.y)
      useElbow = upper > 1e-3 && fore > 1e-3 && upper + fore < armSpan * 2.5
    }

    let upperVisible = false
    let foreVisible = false
    let totalLength = 0
    if (useElbow) {
      const up = updateArmSegment(shoulder, elbow, shoulderThick, elbowThick, unit.arms[0], spec)
      const fore = updateArmSegment(elbow, handPoint, elbowThick, handThick, unit.arms[1], spec)
      upperVisible = up.visible
      foreVisible = fore.visible
      totalLength = up.length + fore.length
    } else {
      const up = updateArmSegment(shoulder, handPoint, shoulderThick, handThick, unit.arms[0], spec)
      upperVisible = up.visible
      totalLength = up.length
    }

    const capVisible = updateHandCap(box, unit.cap, spec)
    statuses[i] = {
      visible: upperVisible || foreVisible || capVisible,
      bent: useElbow,
      length: totalLength,
      shoulderThick,
      elbowThick,
      handThick,
      cap: capVisible,
    }
  }

  return statuses
}

/**
 * DEV-only guard: the renderer computes each geometry's bounding sphere for depth sorting, so a
 * single non-finite position produces the vague "Computed radius is NaN" warning. Walk the
 * position buffers just before the frame is rendered and name the offending layer and vertex.
 */
function findNonFiniteVertex(geometry) {
  const position = geometry?.attributes?.position
  if (!position) return null

  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i)
    const y = position.getY(i)
    const z = position.getZ(i)
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      return { index: i, x, y, z }
    }
  }
  return null
}

/**
 * @param {object} options
 * @param {{ halfWidth: number, halfHeight: number }} options.view mutable mirror-frame metrics
 * @param {Uint16Array|number[]} [options.faceTriangles] tesselation triangle indices
 * @param {Array<{ name: string, indices: number[], hull?: boolean }>} [options.faceRegions]
 *   closed landmark loops carved out of the face dust (eyes, nose, mouth)
 * @param {typeof PERSONA} [options.spec]
 * @param {Partial<typeof FACE_DUST_DEFAULTS>} [options.face] per-call face overrides
 * @param {Partial<typeof TORSO_DEFAULTS>} [options.torso] per-call torso-layer overrides
 * @param {Partial<typeof HAND_DEFAULTS>} [options.hand] per-call hand-dust overrides
 * @param {number} [options.handCount] number of hand-dust clouds to preallocate (one per hand)
 * @param {number} [options.pixelRatio] device pixel ratio for point sizing
 */
export function createPersona({
  view,
  faceTriangles = [],
  faceRegions = [],
  spec = PERSONA,
  face = {},
  torso: torsoOverrides = {},
  hand: handOverrides = {},
  handCount = 2,
  pixelRatio = Math.min(globalThis.devicePixelRatio || 1, 2),
}) {
  // Face/torso/hand layers read from a merged spec so any value can be overridden at the call
  // site, while everything not passed falls back to the current config values.
  const faceSpec = { ...FACE_DUST_DEFAULTS, ...face }
  const torsoSpec = { ...TORSO_DEFAULTS, ...torsoOverrides }
  const handSpec = { ...HAND_DEFAULTS, ...handOverrides }
  // Guard against passing the renderer API instead of its `view` metrics (a silent mismatch:
  // halfWidth/halfHeight read as undefined and nothing maps).
  if (!Number.isFinite(view?.halfWidth) || !Number.isFinite(view?.halfHeight)) {
    console.warn(
      'persona: view metrics missing — pass renderer.view (an object with halfWidth/halfHeight).',
    )
  }

  const root = new THREE.Group()
  root.visible = false

  const torso = new THREE.Group()
  root.add(torso)

  const dust = createDust(torsoSpec, pixelRatio)
  torso.add(dust.points)

  const faceDust = createFaceDust(faceTriangles, faceSpec, pixelRatio)
  root.add(faceDust.points)

  // A separate halo around the head; it lives in root (not the torso group) because it follows
  // the face, not the shoulders.
  const headDust = createHeadDust(spec, pixelRatio)
  root.add(headDust.points)

  // Two arm capsules (upper, forearm) plus one bright hand cap per hand, preallocated so a hand
  // entering/leaving the frame just toggles visibility instead of reallocating geometry.
  const handUnits = []
  for (let i = 0; i < handCount; i += 1) {
    const upper = createHandArm(handSpec, pixelRatio)
    upper.points.name = `handArmUpper${i}`
    root.add(upper.points)

    const fore = createHandArm(handSpec, pixelRatio)
    fore.points.name = `handArmFore${i}`
    root.add(fore.points)

    const cap = createHandCap(handSpec, pixelRatio)
    cap.points.name = `handCap${i}`
    root.add(cap.points)

    handUnits.push({ arms: [upper, fore], cap })
  }

  const layers = [
    { name: 'dust', object: dust.points },
    { name: 'headDust', object: headDust.points },
    ...handUnits.flatMap(({ arms, cap }, i) => [
      { name: `handArmUpper${i}`, object: arms[0].points },
      { name: `handArmFore${i}`, object: arms[1].points },
      { name: `handCap${i}`, object: cap.points },
    ]),
    { name: 'faceDust', object: faceDust.points },
  ]
  const reported = new Set()

  let opacity = 0
  let time = 0

  /** Runs immediately before `main.js` calls `view.render()` for this frame. */
  function debugCheckGeometry() {
    if (!DEV) return

    for (const { name, object } of layers) {
      const bad = findNonFiniteVertex(object.geometry)
      if (bad) {
        // Log once per layer until it recovers, so a bad run doesn't flood the console.
        if (!reported.has(name)) {
          reported.add(name)
          console.warn(`persona/${name}: non-finite position (vertex ${bad.index})`, bad)
        }
      } else {
        reported.delete(name)
      }
    }
  }

  /**
   * Advance the persona. Called every frame with the latest vision readings.
   *
   * @param {object} frame
   * @param {Array<{x:number,y:number,z:number}>} [frame.landmarks] pose landmarks (normalised)
   * @param {Array<{x:number,y:number,z:number}>} [frame.faceLandmarks] face-mesh landmarks
   * @param {Array<Array<{x:number,y:number,z:number}>>} [frame.handLandmarks] per-hand landmark sets
   * @param {string} frame.state current IDLE / APPROACH / EXIT state
   * @param {number} [frame.dt] seconds since the previous frame
   */
  function update({ landmarks, faceLandmarks, handLandmarks, state, dt = 0 } = {}) {
    const step = Math.min(Math.max(dt, 0), 0.25)
    time += step

    // The figure exists only at the mirror; IDLE is the black mirror itself.
    const active = state === 'IDLE' ? 0 : 1
    const tau = active > opacity ? spec.appearTau : spec.disappearTau
    opacity += (active - opacity) * (1 - Math.exp(-step / tau))
    if (opacity < 0.002) opacity = 0
    if (opacity > 0.998) opacity = 1

    root.visible = opacity > 0.002

    dust.uniforms.uTime.value = time
    headDust.uniforms.uTime.value = time
    faceDust.uniforms.uTime.value = time

    dust.uniforms.uOpacity.value = opacity * torsoSpec.dustOpacity
    headDust.uniforms.uOpacity.value = opacity * spec.headDustOpacity
    faceDust.uniforms.uOpacity.value = opacity * faceSpec.faceDustOpacity

    for (const { arms, cap } of handUnits) {
      for (const arm of arms) {
        arm.uniforms.uTime.value = time
        arm.uniforms.uOpacity.value = opacity * handSpec.handDustOpacity
      }
      cap.uniforms.uTime.value = time
      cap.uniforms.uOpacity.value = opacity * handSpec.handCapOpacity
    }

    // Re-apply the dust uniforms every frame so the debug sliders can tune them live.
    // `particleCount` and the colours are structural / init-time values.
    dust.uniforms.uSpread.value = torsoSpec.dustSpread
    dust.uniforms.uDepth.value = torsoSpec.depth
    dust.uniforms.uDrift.value = torsoSpec.drift
    dust.uniforms.uRise.value = torsoSpec.rise
    dust.uniforms.uPointScale.value = torsoSpec.particleRadius * pixelRatio

    // Re-apply the hand uniforms every frame so the debug sliders can tune them live. Counts and
    // colours are structural / init-time values.
    for (const { arms, cap } of handUnits) {
      for (const arm of arms) {
        arm.uniforms.uColor.value.set(handSpec.handDustColor)
        arm.uniforms.uSpread.value = handSpec.handDustSpread
        arm.uniforms.uDepth.value = handSpec.handDepth
        arm.uniforms.uDrift.value = handSpec.handDrift
        arm.uniforms.uRise.value = handSpec.handRise
        arm.uniforms.uPointScale.value = handSpec.handParticleRadius * pixelRatio
      }

      cap.uniforms.uColor.value.set(handSpec.handCapColor)
      cap.uniforms.uSpread.value = handSpec.handCapSpread
      cap.uniforms.uDepth.value = handSpec.handDepth
      cap.uniforms.uDrift.value = handSpec.handDrift
      cap.uniforms.uRise.value = handSpec.handRise
      cap.uniforms.uPointScale.value = handSpec.handCapSize * pixelRatio
    }

    // Re-apply the face uniforms every frame so the debug sliders can tune them live. Structural
    // values (`faceDustCount`) still need a reload.
    faceDust.uniforms.uPointScale.value = faceSpec.faceDustSize * pixelRatio
    faceDust.uniforms.uColor.value.set(faceSpec.faceColor)

    if (!root.visible) {
      const hidden = { visible: false, reason: 'persona-hidden' }
      return {
        visible: false,
        opacity,
        face: hidden,
        hands: handUnits.map(() => ({ visible: false, reason: 'persona-hidden', cap: false })),
      }
    }

    if (landmarks) updateTorso(landmarks, view, torso, dust.uniforms)

    const faceStatus = updateFaceDust(
      faceLandmarks,
      faceDust,
      faceRegions,
      view,
      faceSpec.faceDepth,
      time,
      faceSpec,
    )

    updateHeadDust(faceStatus, headDust, faceSpec.faceDepth)
    const hands = updateHands(landmarks, handLandmarks, handUnits, view, handSpec)

    debugCheckGeometry()

    return {
      visible: root.visible,
      opacity,
      face: faceStatus,
      hands,
    }
  }

  function dispose() {
    dust.points.geometry.dispose()
    dust.points.material.dispose()
    headDust.points.geometry.dispose()
    headDust.points.material.dispose()
    for (const { arms, cap } of handUnits) {
      for (const arm of arms) {
        arm.points.geometry.dispose()
        arm.points.material.dispose()
      }
      cap.points.geometry.dispose()
      cap.points.material.dispose()
    }
    faceDust.geometry.dispose()
    faceDust.points.material.dispose()
  }

  // `face` / `torso` / `hand` are the live, mutable specs: the debug sliders write straight into
  // them and the next `update()` picks the values up.
  return { group: root, face: faceSpec, torso: torsoSpec, hand: handSpec, update, dispose }
}
