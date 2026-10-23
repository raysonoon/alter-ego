import * as THREE from 'three'
import { PERSONA } from '../config.js'
import { POSE_LANDMARKS } from '../vision/pose.js'

/** The debug geometry scan is scaffolding; keep it out of the production build. */
const DEV = Boolean(import.meta.env?.DEV)

/**
 * The persona: a wispy, dusty silhouette that mirrors the player.
 *
 * Three layers share the frame and one opacity ramp:
 *   - `body`   — a shoulder→hip mesh whose fragment shader burns the silhouette into animated
 *                noise, so the torso reads as smoke rather than a solid shape;
 *   - `dust`   — points seeded through the same volume, drifting on their own noise, so the
 *                smoke looks like it is unravelling into particles;
 *   - `face`   — the FaceLandmarker's face-oval contour, drawn as line segments just in front
 *                of the body in a slightly brighter cool tone.
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

const BODY_VERTEX = /* glsl */ `
  varying vec2 vUv;

  uniform float uTime;
  uniform float uShoulderWidth;
  uniform float uHipWidth;
  uniform float uTorsoHeight;
  uniform float uNoise;
  uniform float uDisplace;

  ${NOISE_GLSL}

  void main() {
    vUv = uv;

    // uv.y is 0 at the hips and 1 at the shoulders, so the trapezoid narrows or widens
    // between the two measured spans.
    float width = mix(uHipWidth, uShoulderWidth, uv.y);

    vec3 p;
    p.x = position.x * width;
    p.y = position.y * uTorsoHeight;
    p.z = 0.0;

    // Slow billow so the silhouette is never a flat cut-out.
    float n = fbm(vec2(position.x, position.y) * uNoise - vec2(0.0, uTime * 0.15));
    p.z += (n - 0.5) * uDisplace;
    p.x += (n - 0.5) * uDisplace * 0.6;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`

const BODY_FRAGMENT = /* glsl */ `
  varying vec2 vUv;

  uniform float uTime;
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uDissolve;
  uniform float uSoftness;
  uniform vec2 uNoiseScale;

  ${NOISE_GLSL}

  void main() {
    vec2 uv = vUv;

    // Two octave sets drift in opposite directions so the fringe never repeats visibly.
    float n = fbm(uv * uNoiseScale + vec2(0.0, -uTime * 0.13));
    n = n * 0.7 + fbm(uv * uNoiseScale * 2.4 + vec2(uTime * 0.09, 0.0)) * 0.3;

    // Soft falloff toward the silhouette boundary, so the mesh melts into black rather than
    // ending on a hard edge.
    float edgeX = smoothstep(0.0, 0.22, uv.x) * (1.0 - smoothstep(0.78, 1.0, uv.x));
    float edgeY = smoothstep(0.0, 0.10, uv.y) * (1.0 - smoothstep(0.88, 1.0, uv.y));

    // Carve holes out of the low-noise regions; feathering the cut is what makes it wispy.
    float burn = smoothstep(uDissolve, uDissolve + uSoftness, n);

    float alpha = uOpacity * edgeX * edgeY * burn;
    alpha *= mix(0.35, 1.0, n);
    // Denser at the shoulders, dusting away toward the hips.
    alpha *= mix(0.55, 1.0, uv.y);

    if (alpha < 0.004) discard;
    gl_FragColor = vec4(uColor, alpha);
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

  ${NOISE_GLSL}

  void main() {
    float t = position.y + 0.5;
    float width = mix(uHipWidth, uShoulderWidth, t) * uSpread;

    vec3 p;
    p.x = position.x * width;
    p.y = position.y * uTorsoHeight;
    p.z = position.z * uDepth;

    // Independent drift per particle, with the seed decorrelating neighbours.
    float n1 = valueNoise(p.xy * 1.7 + vec2(uTime * 0.22, 0.0) + aSeed);
    float n2 = valueNoise(p.xy * 1.4 - vec2(0.0, uTime * 0.18) + aSeed * 1.7 + 4.2);
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

function createBody(spec) {
  const uniforms = {
    uTime: { value: 0 },
    uColor: { value: new THREE.Color(spec.bodyColor) },
    uOpacity: { value: 0 },
    uShoulderWidth: { value: 0.5 },
    uHipWidth: { value: 0.4 },
    uTorsoHeight: { value: 0.5 },
    uDissolve: { value: spec.dissolveAtZero },
    uSoftness: { value: spec.dissolveSoftness },
    uNoiseScale: { value: new THREE.Vector2(...spec.noiseScale) },
    uNoise: { value: spec.noiseScale[0] },
    uDisplace: { value: spec.displace },
  }

  const geometry = new THREE.PlaneGeometry(1, 1, spec.columns, spec.rows)
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: BODY_VERTEX,
    fragmentShader: BODY_FRAGMENT,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'body'
  mesh.frustumCulled = false // the shader moves vertices well past the unit bounding sphere
  mesh.renderOrder = 0

  return { mesh, uniforms }
}

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

function createFaceContour(faceOval, spec) {
  const count = Math.max(faceOval.length * 2, 2)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3))

  const material = new THREE.LineBasicMaterial({
    color: spec.faceColor,
    transparent: true,
    opacity: 0,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })

  const line = new THREE.LineSegments(geometry, material)
  line.name = 'face'
  line.frustumCulled = false
  line.renderOrder = 2
  line.visible = false

  return { line, material, geometry }
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

function updateTorso(landmarks, view, torso, bodyUniforms, dustUniforms) {
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

  for (const uniforms of [bodyUniforms, dustUniforms]) {
    uniforms.uShoulderWidth.value = shoulderWidth
    uniforms.uHipWidth.value = hipWidth
    uniforms.uTorsoHeight.value = torsoHeight
  }
}

function updateFaceContour(faceLandmarks, faceOval, view, contour, depth) {
  if (!faceOval.length) {
    contour.line.visible = false
    return { visible: false, reason: 'no-oval', landmarks: 0, segments: 0, bad: null }
  }
  if (!faceLandmarks) {
    contour.line.visible = false
    return { visible: false, reason: 'no-face', landmarks: 0, segments: faceOval.length, bad: null }
  }

  // Distinguish a bad view from a bad landmark: a non-finite aspect poisons every mapped point
  // (and also stops the torso shaping), so name the actual value rather than blaming a landmark.
  const halfWidth = view?.halfWidth
  const halfHeight = view?.halfHeight
  if (!Number.isFinite(halfWidth) || !Number.isFinite(halfHeight)) {
    contour.line.visible = false
    return {
      visible: false,
      reason: `non-finite view: halfWidth=${halfWidth} halfHeight=${halfHeight}`,
      landmarks: faceLandmarks.length,
      segments: faceOval.length,
      bad: { kind: 'view', halfWidth, halfHeight, view },
    }
  }

  const positions = contour.geometry.attributes.position
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  let written = 0
  let badCount = 0
  let bad = null

  for (let i = 0; i < faceOval.length; i += 1) {
    const { start, end } = faceOval[i]
    const a = faceLandmarks[start]
    const b = faceLandmarks[end]
    if (!a || !b) {
      contour.line.visible = false
      return {
        visible: false,
        reason: `missing index ${!a ? start : end}`,
        landmarks: faceLandmarks.length,
        segments: faceOval.length,
        bad: null,
      }
    }

    // Record the exact culprit the first time it appears, but keep drawing the rest of the
    // contour — one bad landmark should not blank the whole face while we diagnose it.
    if (
      !Number.isFinite(a.x) || !Number.isFinite(a.y) ||
      !Number.isFinite(b.x) || !Number.isFinite(b.y)
    ) {
      badCount += 1
      if (!bad) {
        const useA = !Number.isFinite(a.x) || !Number.isFinite(a.y)
        const index = useA ? start : end
        const landmark = useA ? a : b
        const field = !Number.isFinite(landmark.x) ? 'x' : 'y'
        bad = { kind: 'landmark', index, field, value: landmark[field], raw: landmark }
      }
      continue
    }

    const pa = toWorld(a, view)
    const pb = toWorld(b, view)
    if (!pa || !pb) {
      badCount += 1
      continue
    }

    positions.setXYZ(i * 2, pa.x, pa.y, depth)
    positions.setXYZ(i * 2 + 1, pb.x, pb.y, depth)

    minX = Math.min(minX, pa.x, pb.x)
    maxX = Math.max(maxX, pa.x, pb.x)
    minY = Math.min(minY, pa.y, pb.y)
    maxY = Math.max(maxY, pa.y, pb.y)
    written += 1
  }

  positions.needsUpdate = written > 0
  contour.line.visible = written > 0

  if (written === 0) {
    return {
      visible: false,
      reason: bad
        ? `non-finite landmark ${bad.index}.${bad.field}=${bad.value}`
        : 'no segments written',
      landmarks: faceLandmarks.length,
      segments: faceOval.length,
      bad,
      badCount,
    }
  }

  // World-space bounds, so the readout shows whether the contour is on-frame and what size it
  // actually is rather than just "visible".
  return {
    visible: true,
    reason: bad
      ? `partial: ${badCount} bad (e.g. ${bad.index}.${bad.field}=${bad.value})`
      : 'ok',
    landmarks: faceLandmarks.length,
    segments: faceOval.length,
    written,
    bad,
    badCount,
    width: maxX - minX,
    height: maxY - minY,
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
  }
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
 * @param {Array<{ start: number, end: number }>} options.faceOval face-oval landmark connections
 * @param {typeof PERSONA} [options.spec]
 * @param {number} [options.pixelRatio] device pixel ratio for point sizing
 */
export function createPersona({
  view,
  faceOval = [],
  spec = PERSONA,
  pixelRatio = Math.min(globalThis.devicePixelRatio || 1, 2),
}) {
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

  const body = createBody(spec)
  const dust = createDust(spec, pixelRatio)
  torso.add(body.mesh)
  torso.add(dust.points)

  const contour = createFaceContour(faceOval, spec)
  root.add(contour.line)

  const layers = [
    { name: 'body', object: body.mesh },
    { name: 'dust', object: dust.points },
    { name: 'face', object: contour.line },
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

    body.uniforms.uTime.value = time
    dust.uniforms.uTime.value = time

    body.uniforms.uOpacity.value = opacity * spec.bodyOpacity
    dust.uniforms.uOpacity.value = opacity * spec.dustOpacity
    contour.material.opacity = opacity * spec.faceOpacity

    // As it coalesces the smoke closes up; on the way out it thins into wisps.
    body.uniforms.uDissolve.value = THREE.MathUtils.lerp(spec.dissolveAtZero, spec.dissolve, opacity)

    if (!root.visible) {
      return { visible: false, opacity, contour: { visible: false, reason: 'persona-hidden' } }
    }

    if (landmarks) updateTorso(landmarks, view, torso, body.uniforms, dust.uniforms)
    const contourStatus = updateFaceContour(faceLandmarks, faceOval, view, contour, spec.faceDepth)

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

    return { visible: root.visible, opacity, contour: contourStatus }
  }

  function dispose() {
    body.mesh.geometry.dispose()
    body.mesh.material.dispose()
    dust.points.geometry.dispose()
    dust.points.material.dispose()
    contour.geometry.dispose()
    contour.material.dispose()
  }

  return { group: root, update, dispose }
}
