import './style.css'
import { APPROACH, DISTANCE, EXTEND_HAND } from './config.js'
import { createStateMachine } from './state.js'
import { startCamera } from './vision/camera.js'
import {
  createGestureRecognizer,
  FINGERTIPS,
  fingerProfile,
  handSize,
  handZSpread,
} from './vision/gesture.js'
import {
  POSE_LANDMARKS,
  createPoseLandmarker,
  personDistance,
  shoulderSpan,
} from './vision/pose.js'
import { createFaceLandmarker, FACE_FEATURES, FACE_TRIANGLES } from './vision/face.js'
import { createRenderer } from './scene/renderer.js'
import { createPersona } from './scene/persona.js'

const app = document.querySelector('#app')

// Temporary vision readout, drawn over the scene while the loop is calibrated. Strip this and
// the `#debug` styles once the prop is tuned.
const readout = document.createElement('pre')
readout.id = 'debug'
readout.className = 'debug'
readout.textContent = 'booting…'
app.appendChild(readout)

// The state machine is pure, so it is verified against scripted input timelines with no camera
// at all. DEV-only, so it is stripped from the production build.
if (import.meta.env.DEV) {
  import('./dev/stateHarness.js')
    .then(({ runStateHarness }) => {
      const { report, failed } = runStateHarness()
      console[failed ? 'error' : 'log'](report)
    })
    .catch((error) => console.error('state harness failed to load', error))
}

/** Transient boot/error text. Removed once the mirror is live, so no chrome sits over the scene. */
function showStatus(text, isError = false) {
  let status = document.querySelector('#status')
  if (!status) {
    status = document.createElement('pre')
    status.id = 'status'
    status.className = 'status'
    app.appendChild(status)
  }
  status.textContent = text
  status.classList.toggle('status-error', isError)
}

function clearStatus() {
  document.querySelector('#status')?.remove()
}

/**
 * Live face-tuning sliders. Each writes straight into the persona's mutable `face` spec, which
 * `persona.update()` re-applies every frame. Structural values (`faceSubdiv`) and the colour are
 * deliberately excluded — they need a rebuild / a different control.
 */
const FACE_SLIDERS = [
  { key: 'faceOpacity', label: 'opacity', min: 0, max: 1, step: 0.01 },
  { key: 'faceSurfaceOpacity', label: 'surface', min: 0, max: 1, step: 0.01 },
  { key: 'faceDissolve', label: 'dissolve', min: 0, max: 1, step: 0.01 },
  { key: 'faceDissolveAtZero', label: 'dissolve 0', min: 0, max: 1, step: 0.01 },
  { key: 'faceDissolveSoftness', label: 'softness', min: 0.01, max: 1, step: 0.01 },
  { key: 'faceNoiseScale', label: 'noise scale', min: 0.5, max: 12, step: 0.1 },
  { key: 'faceNoiseSpeed', label: 'noise speed', min: 0, max: 0.5, step: 0.005 },
  { key: 'faceFadeStart', label: 'fade start', min: 0, max: 1, step: 0.01 },
  { key: 'facePointSize', label: 'point size', min: 1, max: 20, step: 0.5 },
  { key: 'facePointAlpha', label: 'point alpha', min: 0, max: 1, step: 0.01 },
  { key: 'faceJitter', label: 'jitter', min: 0, max: 0.05, step: 0.001 },
  { key: 'faceDepth', label: 'depth', min: -0.2, max: 0.3, step: 0.01 },
]

/**
 * Live torso-tuning sliders, writing straight into the persona's mutable `torso` spec (the dust
 * cloud). `particleCount` and the colours are structural / init-time values, so they're excluded.
 */
const TORSO_SLIDERS = [
  { key: 'dustOpacity', label: 'dust opacity', min: 0, max: 1, step: 0.01 },
  { key: 'dustSpread', label: 'dust spread', min: 0.5, max: 2.5, step: 0.01 },
  { key: 'depth', label: 'depth', min: 0, max: 0.6, step: 0.01 },
  { key: 'drift', label: 'drift', min: 0, max: 0.3, step: 0.005 },
  { key: 'rise', label: 'rise', min: 0, max: 0.2, step: 0.005 },
  { key: 'particleRadius', label: 'dust size', min: 1, max: 20, step: 0.5 },
]

/**
 * Build a collapsible panel of sliders over a mutable spec. Each slider writes into `spec[key]`
 * by default, or through `get`/`set` for nested values (e.g. `noiseScale[0]`). The persona's
 * `update()` re-applies these uniforms every frame, so changes are live.
 */
function createSliderPanel(title, sliders, spec) {
  const panel = document.createElement('details')
  panel.className = 'debug-panel'
  panel.open = true

  const summary = document.createElement('summary')
  summary.textContent = title
  panel.appendChild(summary)

  for (const slider of sliders) {
    const read = slider.get ?? ((target) => target[slider.key])
    const write = slider.set ?? ((target, value) => {
      target[slider.key] = value
    })

    const row = document.createElement('label')
    row.className = 'debug-row'

    const name = document.createElement('span')
    name.textContent = slider.label

    const input = document.createElement('input')
    input.type = 'range'
    input.min = slider.min
    input.max = slider.max
    input.step = slider.step
    input.value = read(spec)

    const output = document.createElement('output')
    output.textContent = Number(input.value).toFixed(3)

    input.addEventListener('input', () => {
      const value = Number(input.value)
      write(spec, value)
      output.textContent = value.toFixed(3)
    })

    row.append(name, input, output)
    panel.appendChild(row)
  }

  return panel
}

/** The fixed column that holds every debug panel; created on first use. */
let debugStack = null
function getDebugStack() {
  if (!debugStack) {
    debugStack = document.createElement('div')
    debugStack.className = 'debug-stack'
    app.appendChild(debugStack)
  }
  return debugStack
}

function createFaceControls(persona) {
  getDebugStack().appendChild(createSliderPanel('face', FACE_SLIDERS, persona.face))
}

function createTorsoControls(persona) {
  getDebugStack().appendChild(createSliderPanel('torso', TORSO_SLIDERS, persona.torso))
}

const machine = createStateMachine()

// Scene first: the renderer owns the black canvas, and the persona is added before any model
// loads so the mirror is already black (not an empty page) while booting.
const renderer = createRenderer({ container: app })
const persona = createPersona({
  // `renderer.view` is the shared mirror-frame metrics object; the persona must not receive the
  // whole renderer API or `halfWidth`/`halfHeight` read as undefined.
  view: renderer.view,
  faceFeatures: FACE_FEATURES,
  faceTriangles: FACE_TRIANGLES,
  pixelRatio: renderer.renderer.getPixelRatio(),
})
renderer.scene.add(persona.group)
createFaceControls(persona)
createTorsoControls(persona)

let camera
let pose
let gesture
let face
let running = false
let lastFrame = -1
let lastTimestamp = performance.now()
let lastExtendHandAt = -Infinity
let extendHandCount = 0
let stateChangedAt = performance.now()
let lastTransition = '—'

const format = (landmark) =>
  landmark
    ? `x ${landmark.x.toFixed(3)}  y ${landmark.y.toFixed(3)}  z ${landmark.z.toFixed(3)}`
    : 'n/a'

function tick() {
  if (!running) return
  requestAnimationFrame(tick)

  const { video } = camera

  // VIDEO running mode rejects repeated or non-increasing timestamps, so skip frames the
  // browser has not advanced and drive all three models from one shared clock.
  if (video.currentTime === lastFrame) return
  lastFrame = video.currentTime

  const timestamp = performance.now()
  const dt = Math.min((timestamp - lastTimestamp) / 1000, 0.25)
  lastTimestamp = timestamp

  const poseResult = pose.detect(video, timestamp)
  const hand = gesture.recognize(video, timestamp)
  const faceResult = face?.detect(video, timestamp)

  const landmarks = poseResult.landmarks?.[0]
  const worldLandmarks = poseResult.worldLandmarks?.[0]
  const faceLandmarks = faceResult?.faceLandmarks?.[0]

  const span = shoulderSpan(landmarks, worldLandmarks)
  const distance = personDistance(landmarks, worldLandmarks)

  const handLandmarks = hand.landmarks?.[0]
  const spread = handSize(handLandmarks)
  const zSpread = handZSpread(handLandmarks)
  const tips = handLandmarks ? FINGERTIPS.filter((index) => handLandmarks[index]).length : 0

  // Diagnostics only — the trigger does not read any of this. A finger reads as "pointing at
  // the lens" when it has travelled further in depth than in the image plane.
  const fingers = fingerProfile(handLandmarks)
  const pointing = fingers.filter(
    (finger) => finger.depth != null && finger.depth > 1.5 * finger.inPlane,
  ).length
  const fingerLine = handLandmarks
    ? fingers
        .map((finger) =>
          finger.inPlane == null
            ? `${finger.label}:—`
            : `${finger.label}:2D${finger.inPlane.toFixed(3)}/z${finger.depth.toFixed(3)}`,
        )
        .join('  ')
    : '—'

  const extendHand = gesture.detectExtendHand(hand, timestamp)
  if (extendHand) {
    lastExtendHandAt = timestamp
    extendHandCount += 1
  }

  const previousState = machine.state
  const { state, events } = machine.update({ distance, extendHand, timestamp })
  if (state !== previousState) {
    stateChangedAt = timestamp
    lastTransition = events.join(', ')
  }

  const personaFrame = persona.update({ landmarks, faceLandmarks, state, dt })
  renderer.render()

  const distanceLine = distance != null
    ? `${distance.toFixed(2)} m  [apparent ${span.apparent.toFixed(3)} / real ${span.real.toFixed(3)}]`
    : span
      ? `no reading (apparent ${span.apparent.toFixed(3)} < ${DISTANCE.minShoulderWidth})`
      : 'no person'
  // Hold at the true threshold and this is the focalFactor that makes the reading match it.
  const calibrateLine = span
    ? `${(APPROACH.distanceThreshold / (span.real / span.apparent)).toFixed(2)} if you stand at ${APPROACH.distanceThreshold} m`
    : '—'

  const contour = personaFrame?.contour
  const contourBad = contour?.bad
    ? contour.bad.kind === 'view'
      ? `  BAD VIEW halfWidth=${contour.bad.halfWidth} halfHeight=${contour.bad.halfHeight}`
      : `  BAD landmark[${contour.bad.index}].${contour.bad.field}=${String(contour.bad.value)}`
    : ''
  const contourLine = contour
    ? contour.visible
      ? `visible  pts ${contour.written}/${contour.total}  lm ${contour.landmarks}  w ${contour.width.toFixed(3)}  h ${contour.height.toFixed(3)}  @ ${contour.x.toFixed(2)},${contour.y.toFixed(2)}${contourBad}`
      : `hidden (${contour.reason})  pts ${contour.total ?? '?'}  lm ${contour.landmarks ?? 0}${contourBad}`
    : '—'

  const surface = personaFrame?.surface
  const surfaceLine = surface
    ? surface.visible
      ? `visible  verts ${surface.written}/${surface.total}`
      : `hidden (${surface.reason})`
    : '—'

  readout.textContent = [
    `state     ${state}  (${((timestamp - stateChangedAt) / 1000).toFixed(1)}s)`,
    `events    ${lastTransition}`,
    `distance  ${distanceLine}`,
    `calibrate ${calibrateLine}`,
    `pose      ${landmarks ? `tracked (${landmarks.length} landmarks)` : 'no person'}`,
    `nose      ${format(landmarks?.[POSE_LANDMARKS.NOSE])}`,
    `shoulder  ${format(landmarks?.[POSE_LANDMARKS.LEFT_SHOULDER])}`,
    `face      ${faceLandmarks ? `tracked (${faceLandmarks.length} landmarks)` : face ? 'no face' : 'model off'}`,
    `persona   op ${(personaFrame?.opacity ?? 0).toFixed(2)}  ${personaFrame?.visible ? 'shown' : 'hidden'}  ${FACE_FEATURES.length} features`,
    `contour   ${contourLine}`,
    `surface   ${surfaceLine}`,
    `hand      ${handLandmarks ? `spread ${spread.toFixed(3)} (${tips} tips) / needs ${EXTEND_HAND.minSpread}` : 'none'}`,
    `depth     ${handLandmarks ? `z-spread ${zSpread.toFixed(3)} / needs ${EXTEND_HAND.minZSpread}` : '—'}`,
    `fingers   ${fingerLine}${handLandmarks ? `  → pointing ${pointing}/4` : ''}`,
    `trigger   ${timestamp - lastExtendHandAt < 500 ? `EXTEND_HAND (${extendHandCount})` : '—'}`,
  ].join('\n')
}

async function boot() {
  showStatus('starting…')
  camera = await startCamera()

  showStatus('loading models…')
  const [poseModel, gestureModel, faceModel] = await Promise.all([
    createPoseLandmarker(),
    createGestureRecognizer(),
    createFaceLandmarker().catch((error) => {
      // The face contour is one visual layer; if it fails the rest of the prop still runs.
      console.warn('FaceLandmarker failed to load; the face contour will stay hidden.', error)
      return null
    }),
  ])
  pose = poseModel
  gesture = gestureModel
  face = faceModel

  clearStatus()
  running = true
  lastTimestamp = performance.now()
  requestAnimationFrame(tick)
}

boot().catch((error) => {
  console.error(error)
  running = false
  camera?.stop()
  showStatus(error instanceof Error ? error.message : String(error), true)
})

// Without this, every HMR update leaks another set of WASM model instances, a live camera
// track and a WebGL context.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    running = false
    pose?.close()
    gesture?.close()
    face?.close()
    camera?.stop()
    persona.dispose()
    renderer.dispose()
  })
}
