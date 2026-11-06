import * as THREE from 'three'
import { PERSONA } from '../config.js'
import { POSE_LANDMARKS } from '../vision/pose.js'

/** The debug geometry scan is scaffolding; keep it out of the production build. */
const DEV = Boolean(import.meta.env?.DEV)

/**
 * Default tunables for the face layers. They mirror the `PERSONA` config so the current values
 * stay the defaults, but they are also exposed as the overridable `face` parameter of
 * `createPersona` — pass e.g. `face: { faceOpacity: 0.7 }` to adjust at the call site.
 */
export const FACE_DEFAULTS = {
  faceColor: PERSONA.faceColor,
  faceOpacity: PERSONA.faceOpacity,
  faceSubdiv: PERSONA.faceSubdiv,
  facePointSize: PERSONA.facePointSize,
  faceJitter: PERSONA.faceJitter,
  facePointAlpha: PERSONA.facePointAlpha,
  faceSurfaceOpacity: PERSONA.faceSurfaceOpacity,
  faceDissolve: PERSONA.faceDissolve,
  faceDissolveAtZero: PERSONA.faceDissolveAtZero,
  faceDissolveSoftness: PERSONA.faceDissolveSoftness,
  faceNoiseScale: PERSONA.faceNoiseScale,
  faceNoiseSpeed: PERSONA.faceNoiseSpeed,
  faceFadeStart: PERSONA.faceFadeStart,
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
 * The persona: a wispy, dusty silhouette that mirrors the player.
 *
 * Layers share the frame and one opacity ramp:
 *   - `dust`   — points seeded across the shoulder→hip volume, drifting on their own noise so the
 *                torso reads as a wispy, dusty silhouette;
 *   - `face`   — the tesselated face surface plus the ghost-face contour points, with a dust halo
 *                around the head.
 *
 * Only normalised landmark coordinates are used for geometry: they are what the mirror shows,
 * so mapping them straight onto the orthographic frame keeps the figure aligned with the
 * player's reflection. (Aspect handling lives in `toWorld`, so x and y map at the same scale.)
 */

/** Value noise + fbm, shared by every shader in this module. Returns roughly [0, 1]. */
const NOISE_GLSL = /* glsl */ `
  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 4; i++) {
      value += amplitude * valueNoise(p);
      p = p * 2.02 + 7.13;
      amplitude *= 0.5;
    }
    return value;
  }
`

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
 * The ghost face is a cloud of soft additive points sampled along every face contour. Points
 * (not lines) are what make it read as one ghostly face: sparse, soft sprites pool into glowing
 * strokes instead of hard vector wireframe.
 */
const GHOST_VERTEX = /* glsl */ `
  attribute float aSize;
  attribute float aSeed;

  uniform float uTime;
  uniform float uPointScale;
  uniform float uJitter;

  ${NOISE_GLSL}

  void main() {
    vec3 p = position;

    // Per-point shimmer, so the face drifts like smoke rather than sitting as a rig.
    float n1 = valueNoise(vec2(aSeed * 91.7, uTime * 0.35));
    float n2 = valueNoise(vec2(aSeed * 37.3 + 4.1, uTime * 0.28));
    p.x += (n1 - 0.5) * uJitter;
    p.y += (n2 - 0.5) * uJitter;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = aSize * uPointScale;
  }
`

const GHOST_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uGlow;

  void main() {
    // Soft radial sprite; additive blending lets overlapping points pool into a glow.
    float d = length(gl_PointCoord - 0.5);
    float alpha = (1.0 - smoothstep(0.0, 0.5, d)) * uOpacity * uGlow;
    if (alpha < 0.003) discard;
    gl_FragColor = vec4(uColor, alpha);
  }
`

/**
 * The tesselated face surface: a filled, translucent mask whose alpha is carved by a
 * face-anchored procedural noise field. Raising `uDissolve` burns away the low-noise regions
 * first, so the surface vanishes piece by piece instead of fading uniformly.
 */
const FACE_SURFACE_VERTEX = /* glsl */ `
  attribute vec2 aCoord;
  varying vec2 vUv;
  varying float vEdge;

  uniform vec2 uCenter;
  uniform float uRadius;

  void main() {
    // aCoord is the landmark's normalised image position, so the dissolve pattern sticks to the
    // face as it moves rather than sliding across the mirror.
    vUv = aCoord;

    // Normalised distance from the face centre, used to fade the mask out at its boundary.
    vEdge = uRadius > 0.0 ? distance(position.xy, uCenter) / uRadius : 0.0;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const FACE_SURFACE_FRAGMENT = /* glsl */ `
  varying vec2 vUv;
  varying float vEdge;

  uniform float uTime;
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uDissolve;
  uniform float uSoftness;
  uniform float uNoiseScale;
  uniform float uNoiseSpeed;
  uniform float uFadeStart;

  ${NOISE3D_GLSL}

  void main() {
    // Time is the third axis, so the burn pattern morphs in place instead of sliding across the
    // face as it would with a drifting 2D slice.
    float n = fbm3(vec3(vUv * uNoiseScale, uTime * uNoiseSpeed));
    float burn = smoothstep(uDissolve, uDissolve + uSoftness, n);

    // Solid through the centre, melting to nothing at the face boundary.
    float fade = 1.0 - smoothstep(uFadeStart, 1.0, vEdge);

    float alpha = uOpacity * burn * fade;
    if (alpha < 0.004) discard;
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

function createGhostFace(features, spec, pixelRatio) {
  // Flatten every feature's connections into sampled points. Sampling along each segment (rather
  // than only at its endpoints) is what turns the contour into a continuous soft stroke.
  const start = []
  const end = []
  const t = []
  const featuresPerPoint = []
  const seeds = []
  const sizes = []

  for (let f = 0; f < features.length; f += 1) {
    for (const connection of features[f].connections) {
      for (let k = 0; k < spec.faceSubdiv; k += 1) {
        start.push(connection.start)
        end.push(connection.end)
        t.push((k + 0.5) / spec.faceSubdiv)
        featuresPerPoint.push(f)
        seeds.push(Math.random())
        sizes.push(0.6 + Math.random() * 0.8)
      }
    }
  }

  const count = start.length
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3))
  geometry.setAttribute('aSeed', new THREE.BufferAttribute(Float32Array.from(seeds), 1))
  geometry.setAttribute('aSize', new THREE.BufferAttribute(Float32Array.from(sizes), 1))

  const uniforms = {
    uTime: { value: 0 },
    uColor: { value: new THREE.Color(spec.faceColor) },
    uOpacity: { value: 0 },
    uGlow: { value: spec.facePointAlpha },
    uPointScale: { value: spec.facePointSize * pixelRatio },
    uJitter: { value: spec.faceJitter },
  }

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: GHOST_VERTEX,
    fragmentShader: GHOST_FRAGMENT,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })

  const points = new THREE.Points(geometry, material)
  points.name = 'face'
  points.frustumCulled = false
  points.renderOrder = 3 // above the dissolving surface
  points.visible = false

  return {
    points,
    geometry,
    uniforms,
    featuresCount: features.length,
    layout: {
      count,
      start: Int16Array.from(start),
      end: Int16Array.from(end),
      t: Float32Array.from(t),
      feature: Int8Array.from(featuresPerPoint),
    },
  }
}

function createFaceSurface(triangles, spec) {
  const vertexCount = triangles.length ? Math.max(...triangles) + 1 : 0
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3))
  geometry.setAttribute('aCoord', new THREE.BufferAttribute(new Float32Array(vertexCount * 2), 2))
  geometry.setIndex(new THREE.BufferAttribute(triangles, 1))

  const uniforms = {
    uTime: { value: 0 },
    uColor: { value: new THREE.Color(spec.faceColor) },
    uOpacity: { value: 0 },
    uDissolve: { value: spec.faceDissolveAtZero },
    uSoftness: { value: spec.faceDissolveSoftness },
    uNoiseScale: { value: spec.faceNoiseScale },
    uNoiseSpeed: { value: spec.faceNoiseSpeed },
    uCenter: { value: new THREE.Vector2() },
    uRadius: { value: 0 },
    uFadeStart: { value: spec.faceFadeStart },
  }

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: FACE_SURFACE_VERTEX,
    fragmentShader: FACE_SURFACE_FRAGMENT,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'faceSurface'
  mesh.frustumCulled = false
  mesh.renderOrder = 2
  mesh.visible = false

  return { mesh, geometry, uniforms, vertexCount }
}

const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

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

function updateGhostFace(faceLandmarks, ghost, view, depth) {
  const { points, layout } = ghost
  const total = layout.count

  if (!total) {
    points.visible = false
    return { visible: false, reason: 'no-features', landmarks: 0, total: 0, bad: null }
  }
  if (!faceLandmarks) {
    points.visible = false
    return { visible: false, reason: 'no-face', landmarks: 0, total, bad: null }
  }

  // Distinguish a bad view from a bad landmark: a non-finite aspect poisons every mapped point
  // (and also stops the torso shaping), so name the actual value rather than blaming a landmark.
  const halfWidth = view?.halfWidth
  const halfHeight = view?.halfHeight
  if (!Number.isFinite(halfWidth) || !Number.isFinite(halfHeight)) {
    points.visible = false
    return {
      visible: false,
      reason: `non-finite view: halfWidth=${halfWidth} halfHeight=${halfHeight}`,
      landmarks: faceLandmarks.length,
      total,
      bad: { kind: 'view', halfWidth, halfHeight, view },
    }
  }

  const positions = ghost.geometry.attributes.position
  const fullWidth = halfWidth * 2
  const fullHeight = halfHeight * 2

  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  let written = 0
  let badCount = 0
  let bad = null

  for (let i = 0; i < total; i += 1) {
    const landmarkStart = layout.start[i]
    const landmarkEnd = layout.end[i]
    const a = faceLandmarks[landmarkStart]
    const b = faceLandmarks[landmarkEnd]
    if (!a || !b) {
      badCount += 1
      continue
    }

    const ax = a.x
    const ay = a.y
    const bx = b.x
    const by = b.y

    // Record the exact culprit the first time it appears, but keep drawing the rest of the
    // face — one bad landmark should not blank the whole ghost while we diagnose it.
    if (
      !Number.isFinite(ax) || !Number.isFinite(ay) ||
      !Number.isFinite(bx) || !Number.isFinite(by)
    ) {
      badCount += 1
      if (!bad) {
        const useA = !Number.isFinite(ax) || !Number.isFinite(ay)
        const index = useA ? landmarkStart : landmarkEnd
        const landmark = useA ? a : b
        const field = !Number.isFinite(landmark.x) ? 'x' : 'y'
        bad = { kind: 'landmark', index, field, value: landmark[field], raw: landmark }
      }
      continue
    }

    const t = layout.t[i]
    const x = (0.5 - (ax + (bx - ax) * t)) * fullWidth
    const y = (0.5 - (ay + (by - ay) * t)) * fullHeight

    positions.setXYZ(i, x, y, depth)

    minX = Math.min(minX, x)
    maxX = Math.max(maxX, x)
    minY = Math.min(minY, y)
    maxY = Math.max(maxY, y)
    written += 1
  }

  positions.needsUpdate = written > 0
  points.visible = written > 0

  if (written === 0) {
    return {
      visible: false,
      reason: bad
        ? `non-finite landmark ${bad.index}.${bad.field}=${bad.value}`
        : 'no points written',
      landmarks: faceLandmarks.length,
      total,
      bad,
      badCount,
    }
  }

  // World-space bounds, so the readout shows whether the face is on-frame and what size it is.
  return {
    visible: true,
    reason: bad
      ? `partial: ${badCount} bad (e.g. ${bad.index}.${bad.field}=${bad.value})`
      : 'ok',
    landmarks: faceLandmarks.length,
    total,
    written,
    bad,
    badCount,
    width: maxX - minX,
    height: maxY - minY,
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
  }
}

function updateFaceSurface(faceLandmarks, surface, view, depth) {
  const { mesh, geometry, vertexCount } = surface

  if (!vertexCount) {
    mesh.visible = false
    return { visible: false, reason: 'no-triangles' }
  }
  if (!faceLandmarks) {
    mesh.visible = false
    return { visible: false, reason: 'no-face' }
  }

  const halfWidth = view?.halfWidth
  const halfHeight = view?.halfHeight
  if (!Number.isFinite(halfWidth) || !Number.isFinite(halfHeight)) {
    mesh.visible = false
    return { visible: false, reason: 'non-finite view' }
  }

  const position = geometry.attributes.position
  const coord = geometry.attributes.aCoord
  const fullWidth = halfWidth * 2
  const fullHeight = halfHeight * 2
  let written = 0
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity

  for (let i = 0; i < vertexCount; i += 1) {
    const landmark = faceLandmarks[i]
    if (!landmark) continue

    const { x, y } = landmark
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue

    const worldX = (0.5 - x) * fullWidth
    const worldY = (0.5 - y) * fullHeight
    position.setXYZ(i, worldX, worldY, depth)
    coord.setXY(i, x, y)

    minX = Math.min(minX, worldX)
    maxX = Math.max(maxX, worldX)
    minY = Math.min(minY, worldY)
    maxY = Math.max(maxY, worldY)
    written += 1
  }

  position.needsUpdate = written > 0
  coord.needsUpdate = written > 0
  mesh.visible = written > 0

  // Feed the vertex shader the face centre/radius so the mask can fade out at its own boundary.
  if (written > 0) {
    surface.uniforms.uCenter.value.set((minX + maxX) / 2, (minY + maxY) / 2)
    surface.uniforms.uRadius.value = Math.max(maxX - minX, maxY - minY) / 2
  }

  return { visible: mesh.visible, written, total: vertexCount }
}

function updateHeadDust(faceStatus, headDust, depth) {
  const radius = faceStatus?.visible
    ? Math.max(faceStatus.width, faceStatus.height) * 0.5
    : 0

  if (!(radius > 1e-4)) {
    headDust.points.visible = false
    return
  }

  // Reuse the ghost-face bounds: x/y is the face centre, width/height its world size.
  headDust.points.position.set(faceStatus.x, faceStatus.y, depth)
  headDust.uniforms.uRadius.value = radius
  headDust.points.visible = true
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
 * @param {Array<{ name: string, connections: Array<{start:number,end:number}> }>} options.faceFeatures
 * @param {Uint16Array|number[]} [options.faceTriangles] tesselation triangle indices
 * @param {typeof PERSONA} [options.spec]
 * @param {Partial<typeof FACE_DEFAULTS>} [options.face] per-call face-layer overrides
 * @param {Partial<typeof TORSO_DEFAULTS>} [options.torso] per-call torso-layer overrides
 * @param {number} [options.pixelRatio] device pixel ratio for point sizing
 */
export function createPersona({
  view,
  faceFeatures = [],
  faceTriangles = [],
  spec = PERSONA,
  face = {},
  torso: torsoOverrides = {},
  pixelRatio = Math.min(globalThis.devicePixelRatio || 1, 2),
}) {
  // Face/torso layers read from a merged spec so any value can be overridden at the call site,
  // while everything not passed falls back to the current config values.
  const faceSpec = { ...FACE_DEFAULTS, ...face }
  const torsoSpec = { ...TORSO_DEFAULTS, ...torsoOverrides }
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

  const faceSurface = createFaceSurface(faceTriangles, faceSpec)
  root.add(faceSurface.mesh)

  const ghost = createGhostFace(faceFeatures, faceSpec, pixelRatio)
  root.add(ghost.points)

  // A separate halo around the head; it lives in root (not the torso group) because it follows
  // the face, not the shoulders.
  const headDust = createHeadDust(spec, pixelRatio)
  root.add(headDust.points)

  const layers = [
    { name: 'dust', object: dust.points },
    { name: 'headDust', object: headDust.points },
    { name: 'faceSurface', object: faceSurface.mesh },
    { name: 'face', object: ghost.points },
  ]
  const reported = new Set()

  let opacity = 0
  let time = 0
  let lastContourSignature = null

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
   * @param {string} frame.state current IDLE / APPROACH / EXIT state
   * @param {number} [frame.dt] seconds since the previous frame
   */
  function update({ landmarks, faceLandmarks, state, dt = 0 } = {}) {
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
    faceSurface.uniforms.uTime.value = time
    ghost.uniforms.uTime.value = time

    dust.uniforms.uOpacity.value = opacity * torsoSpec.dustOpacity
    headDust.uniforms.uOpacity.value = opacity * spec.headDustOpacity
    faceSurface.uniforms.uOpacity.value = opacity * faceSpec.faceSurfaceOpacity
    ghost.uniforms.uOpacity.value = opacity * faceSpec.faceOpacity

    // The surface coalesces as it appears and burns away piece by piece as it leaves.
    faceSurface.uniforms.uDissolve.value = THREE.MathUtils.lerp(
      faceSpec.faceDissolveAtZero,
      faceSpec.faceDissolve,
      opacity,
    )

    // Re-apply the dust uniforms every frame so the debug sliders can tune them live.
    // `particleCount` and the colours are structural / init-time values.
    dust.uniforms.uSpread.value = torsoSpec.dustSpread
    dust.uniforms.uDepth.value = torsoSpec.depth
    dust.uniforms.uDrift.value = torsoSpec.drift
    dust.uniforms.uRise.value = torsoSpec.rise
    dust.uniforms.uPointScale.value = torsoSpec.particleRadius * pixelRatio

    // Re-apply the face uniforms every frame so the debug sliders can tune them live. `faceSubdiv`
    // is structural (it sizes the geometry), so it still needs a reload.
    ghost.uniforms.uGlow.value = faceSpec.facePointAlpha
    ghost.uniforms.uPointScale.value = faceSpec.facePointSize * pixelRatio
    ghost.uniforms.uJitter.value = faceSpec.faceJitter
    ghost.uniforms.uColor.value.set(faceSpec.faceColor)

    faceSurface.uniforms.uSoftness.value = faceSpec.faceDissolveSoftness
    faceSurface.uniforms.uNoiseScale.value = faceSpec.faceNoiseScale
    faceSurface.uniforms.uNoiseSpeed.value = faceSpec.faceNoiseSpeed
    faceSurface.uniforms.uFadeStart.value = faceSpec.faceFadeStart
    faceSurface.uniforms.uColor.value.set(faceSpec.faceColor)

    if (!root.visible) {
      return {
        visible: false,
        opacity,
        contour: { visible: false, reason: 'persona-hidden' },
        surface: { visible: false, reason: 'persona-hidden' },
      }
    }

    if (landmarks) updateTorso(landmarks, view, torso, dust.uniforms)
    const surfaceStatus = updateFaceSurface(faceLandmarks, faceSurface, view, faceSpec.faceDepth)
    const contourStatus = updateGhostFace(faceLandmarks, ghost, view, faceSpec.faceDepth)
    updateHeadDust(contourStatus, headDust, faceSpec.faceDepth)

    debugCheckGeometry()

    // Log once whenever the contour's verdict changes (no-face → ok, or a new bad landmark) so
    // the raw offending value is visible in the console without staring at the readout.
    if (DEV) {
      const signature = contourStatus.bad
        ? `${contourStatus.bad.kind} ${contourStatus.bad.index ?? ''}.${contourStatus.bad.field ?? ''}=${contourStatus.bad.value ?? ''}`
        : contourStatus.reason
      if (signature !== lastContourSignature) {
        lastContourSignature = signature
        if (contourStatus.bad?.kind === 'landmark') {
          console.warn(
            `persona/contour: non-finite landmark[${contourStatus.bad.index}].${contourStatus.bad.field} =`,
            contourStatus.bad.value,
            'raw:',
            contourStatus.bad.raw,
          )
        } else if (contourStatus.bad?.kind === 'view') {
          console.warn('persona/contour: non-finite view', {
            halfWidth: contourStatus.bad.halfWidth,
            halfHeight: contourStatus.bad.halfHeight,
          })
        } else {
          console.debug(`persona/contour: ${signature}`)
        }
      }
    }

    return { visible: root.visible, opacity, contour: contourStatus, surface: surfaceStatus }
  }

  function dispose() {
    dust.points.geometry.dispose()
    dust.points.material.dispose()
    headDust.points.geometry.dispose()
    headDust.points.material.dispose()
    faceSurface.geometry.dispose()
    faceSurface.mesh.material.dispose()
    ghost.geometry.dispose()
    ghost.points.material.dispose()
  }

  // `face` / `torso` are the live, mutable specs: the debug sliders write straight into them and
  // the next `update()` picks the values up.
  return { group: root, face: faceSpec, torso: torsoSpec, update, dispose }
}
