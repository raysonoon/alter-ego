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

const app = document.querySelector('#app')

// Temporary bring-up readout, replaced once scene/ takes over the canvas.
app.innerHTML = '<pre id="debug" class="debug">booting…</pre>'
const readout = document.querySelector('#debug')

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

const machine = createStateMachine()

let camera
let pose
let gesture
let running = false
let lastFrame = -1
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
  // browser has not advanced and drive both models from one shared clock.
  if (video.currentTime === lastFrame) return
  lastFrame = video.currentTime
  const timestamp = performance.now()

  const { landmarks, worldLandmarks } = pose.detect(video, timestamp)
  const hand = gesture.recognize(video, timestamp)

  const person = landmarks[0]
  const span = shoulderSpan(person, worldLandmarks?.[0])
  const distance = personDistance(person, worldLandmarks?.[0])

  const handLandmarks = hand.landmarks?.[0]
  const spread = handSize(handLandmarks)
  const zSpread = handZSpread(handLandmarks)
  const tips = handLandmarks ? FINGERTIPS.filter((index) => handLandmarks[index]).length : 0

  // Diagnostics only — the trigger does not read any of this. A finger reads as "pointing at
  // the lens" when it has travelled further in depth than in the image plane.
  const fingers = fingerProfile(handLandmarks)
  const pointing = fingers.filter((finger) => finger.depth != null && finger.depth > 1.5 * finger.inPlane).length
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
    // scene/ and audio/ hang off these events once they exist: ENTER_EXIT starts the
    // glass-break + Nietzsche voiceover, ENTER_IDLE resets the mirror.
  }

  const distanceLine = distance != null
    ? `${distance.toFixed(2)} m  [apparent ${span.apparent.toFixed(3)} / real ${span.real.toFixed(3)}]`
    : span
      ? `no reading (apparent ${span.apparent.toFixed(3)} < ${DISTANCE.minShoulderWidth})`
      : 'no person'
  // Hold at the true threshold and this is the focalFactor that makes the reading match it.
  const calibrateLine = span
    ? `${(APPROACH.distanceThreshold / (span.real / span.apparent)).toFixed(2)} if you stand at ${APPROACH.distanceThreshold} m`
    : '—'

  readout.textContent = [
    `state     ${state}  (${((timestamp - stateChangedAt) / 1000).toFixed(1)}s)`,
    `events    ${lastTransition}`,
    `distance  ${distanceLine}`,
    `calibrate ${calibrateLine}`,
    `pose      ${person ? `tracked (${person.length} landmarks)` : 'no person'}`,
    `nose      ${format(person?.[POSE_LANDMARKS.NOSE])}`,
    `shoulder  ${format(person?.[POSE_LANDMARKS.LEFT_SHOULDER])}`,
    `hand      ${handLandmarks ? `spread ${spread.toFixed(3)} (${tips} tips) / needs ${EXTEND_HAND.minSpread}` : 'none'}`,
    `depth     ${handLandmarks ? `z-spread ${zSpread.toFixed(3)} / needs ${EXTEND_HAND.minZSpread}` : '—'}`,
    `fingers   ${fingerLine}${handLandmarks ? `  → pointing ${pointing}/4` : ''}`,
    `trigger   ${timestamp - lastExtendHandAt < 500 ? `EXTEND_HAND (${extendHandCount})` : '—'}`,
  ].join('\n')
}

async function boot() {
  readout.textContent = 'requesting camera…'
  camera = await startCamera()

  readout.textContent = 'loading models…'
  ;[pose, gesture] = await Promise.all([createPoseLandmarker(), createGestureRecognizer()])

  running = true
  requestAnimationFrame(tick)
}

boot().catch((error) => {
  console.error(error)
  readout.classList.add('debug-error')
  readout.textContent = `${error instanceof Error ? error.message : error}`
})

// Without this, every HMR update leaks another pair of WASM model instances and a live
// camera track.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    running = false
    pose?.close()
    gesture?.close()
    camera?.stop()
  })
}
