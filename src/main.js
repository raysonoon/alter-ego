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
import { createFaceLandmarker, FACE_OVAL } from './vision/face.js'
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

const machine = createStateMachine()

// Scene first: the renderer owns the black canvas, and the persona is added before any model
// loads so the mirror is already black (not an empty page) while booting.
const renderer = createRenderer({ container: app })
const persona = createPersona({
  // `renderer.view` is the shared mirror-frame metrics object; the persona must not receive the
  // whole renderer API or `halfWidth`/`halfHeight` read as undefined.
  view: renderer.view,
  faceOval: FACE_OVAL,
  pixelRatio: renderer.renderer.getPixelRatio(),
})
renderer.scene.add(persona.group)

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
      ? `visible  seg ${contour.written}/${contour.segments}  lm ${contour.landmarks}  w ${contour.width.toFixed(3)}  h ${contour.height.toFixed(3)}  @ ${contour.x.toFixed(2)},${contour.y.toFixed(2)}${contourBad}`
      : `hidden (${contour.reason})  seg ${contour.segments ?? '?'}  lm ${contour.landmarks ?? 0}${contourBad}`
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
    `persona   op ${(personaFrame?.opacity ?? 0).toFixed(2)}  ${personaFrame?.visible ? 'shown' : 'hidden'}  oval ${FACE_OVAL.length}`,
    `contour   ${contourLine}`,
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
