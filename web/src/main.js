import './style.css'
import { APPROACH, DEBUG, DISTANCE, EXTEND_HAND, GESTURE, GLASS, LED, STORY } from './config.js'
import { createStateMachine, STATE } from './state.js'
import { startCamera } from './vision/camera.js'
import {
  createGestureRecognizer,
  FINGERTIPS,
  fingerProfile,
  handSize,
  pointingFingerCount,
} from './vision/gesture.js'
import {
  POSE_LANDMARKS,
  createPoseLandmarker,
  personDistance,
  shoulderSpan,
} from './vision/pose.js'
import { createFaceLandmarker, FACE_REGIONS, FACE_TRIANGLES } from './vision/face.js'
import { createRenderer } from './scene/renderer.js'
import { createPersona } from './scene/persona.js'
import { createTextOverlay } from './scene/textOverlay.js'
import { createGlassBreak } from './scene/effects/glassBreak.js'
import { createAudioEngine } from './audio/engine.js'
import { createDirector } from './audio/director.js'
import { AUDIO_ASSETS } from './audio/assets.js'
import { createLedLink } from './firmware.js'

const app = document.querySelector('#app')

// Temporary vision readout, drawn over the scene while the loop is calibrated. Toggled by
// DEBUG.readout in config.js; strip this and the `#debug` styles once the prop is tuned.
let readout = null
if (DEBUG.readout) {
  readout = document.createElement('pre')
  readout.id = 'debug'
  readout.className = 'debug'
  readout.textContent = 'booting…'
  app.appendChild(readout)
}

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
 * Live face-dust tuning sliders. Each writes straight into the persona's mutable `face` spec,
 * which `persona.update()` re-applies every frame. `faceDustCount` is structural, so it needs a
 * reload.
 */
const FACE_DUST_SLIDERS = [
  { key: 'faceDustOpacity', label: 'opacity', min: 0, max: 1, step: 0.01 },
  { key: 'faceDustSize', label: 'point size', min: 1, max: 20, step: 0.5 },
  { key: 'faceDustDrift', label: 'drift', min: 0, max: 0.1, step: 0.001 },
  { key: 'faceDustRise', label: 'rise', min: 0, max: 0.05, step: 0.001 },
  { key: 'faceCarveSoftness', label: 'carve softness', min: 0, max: 0.2, step: 0.005 },
  { key: 'faceDepth', label: 'depth', min: -0.2, max: 0.3, step: 0.01 },
]

/**
 * Live torso-tuning sliders, writing straight into the persona's mutable `torso` spec (the dust
 * cloud). `particleCount` and the colours are structural / init-time values, so they're excluded.
 */
const TORSO_SLIDERS = [
  { key: 'dustOpacity', label: 'dust opacity', min: 0, max: 1, step: 0.01 },
  { key: 'dustSpread', label: 'dust spread', min: 0.5, max: 2.5, step: 0.01 },
  { key: 'waistPinch', label: 'waist pinch', min: 0, max: 0.8, step: 0.01 },
  { key: 'depth', label: 'depth', min: 0, max: 0.6, step: 0.01 },
  { key: 'drift', label: 'drift', min: 0, max: 0.3, step: 0.005 },
  { key: 'rise', label: 'rise', min: 0, max: 0.2, step: 0.005 },
  { key: 'particleRadius', label: 'dust size', min: 1, max: 20, step: 0.5 },
]

/**
 * Live hand-dust sliders, writing straight into the persona's mutable `hand` spec. `handParticleCount`
 * and the colour are structural / init-time values, so they're excluded.
 */
const HAND_SLIDERS = [
  { key: 'handDustOpacity', label: 'dust opacity', min: 0, max: 1, step: 0.01 },
  { key: 'handDustSpread', label: 'dust spread', min: 0.5, max: 3, step: 0.01 },
  { key: 'handArmThickness', label: 'arm thickness', min: 0.02, max: 0.6, step: 0.01 },
  { key: 'handArmElbowTaper', label: 'elbow taper', min: 0.05, max: 1, step: 0.01 },
  { key: 'handArmTaper', label: 'arm taper', min: 0.05, max: 1, step: 0.01 },
  { key: 'handCapOpacity', label: 'hand opacity', min: 0, max: 1, step: 0.01 },
  { key: 'handCapSize', label: 'hand size', min: 1, max: 20, step: 0.5 },
  { key: 'handCapSpread', label: 'hand spread', min: 0.5, max: 3, step: 0.01 },
  { key: 'handDepth', label: 'depth', min: 0, max: 0.4, step: 0.01 },
  { key: 'handDrift', label: 'drift', min: 0, max: 0.2, step: 0.005 },
  { key: 'handRise', label: 'rise', min: 0, max: 0.1, step: 0.005 },
  { key: 'handEdgeSoftness', label: 'edge softness', min: 0, max: 1, step: 0.01 },
  { key: 'handRagged', label: 'ragged edge', min: 0, max: 0.8, step: 0.01 },
  { key: 'handClump', label: 'clump', min: 0, max: 1, step: 0.01 },
  { key: 'handFlicker', label: 'flicker', min: 0, max: 1, step: 0.01 },
  { key: 'handFlickerSpeed', label: 'flicker speed', min: 0, max: 5, step: 0.1 },
  { key: 'handStream', label: 'stream', min: 0, max: 0.1, step: 0.002 },
  { key: 'handParticleRadius', label: 'dust size', min: 1, max: 20, step: 0.5 },
  { key: 'handMinSpan', label: 'min span', min: 0, max: 0.5, step: 0.01 },
]

/**
 * Live head-dust sliders, writing straight into the persona's mutable `head` spec. `headDustCount`
 * and `headDustColor` are structural / init-time values, so they're excluded.
 */
const HEAD_DUST_SLIDERS = [
  { key: 'headDustOpacity', label: 'opacity', min: 0, max: 1, step: 0.01 },
  { key: 'headDustSpread', label: 'spread', min: 0.5, max: 3, step: 0.01 },
  { key: 'headDustSize', label: 'point size', min: 1, max: 20, step: 0.5 },
  { key: 'headDustDrift', label: 'drift', min: 0, max: 0.3, step: 0.005 },
  { key: 'headDustRise', label: 'rise', min: 0, max: 0.2, step: 0.005 },
  { key: 'headDustTail', label: 'tail length', min: 0, max: 3, step: 0.05 },
  { key: 'headDustTailWidth', label: 'tail width', min: 0.05, max: 0.8, step: 0.01 },
  { key: 'depth', label: 'depth', min: 0, max: 0.6, step: 0.01 },
]

/**
 * Live figure-mapping sliders, writing straight into the persona's mutable `figure` spec.
 * `scale` resizes the whole persona (torso, face, hands, halo) and its dust sprites live.
 * `aspectFit` is a string mode, so it stays a config value rather than a slider.
 */
const FIGURE_SLIDERS = [
  { key: 'scale', label: 'figure scale', min: 0.2, max: 4, step: 0.01 },
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
  getDebugStack().appendChild(createSliderPanel('face', FACE_DUST_SLIDERS, persona.face))
}

function createTorsoControls(persona) {
  getDebugStack().appendChild(createSliderPanel('torso', TORSO_SLIDERS, persona.torso))
}

function createHandControls(persona) {
  getDebugStack().appendChild(createSliderPanel('hand', HAND_SLIDERS, persona.hand))
}

function createHeadControls(persona) {
  getDebugStack().appendChild(createSliderPanel('head dust', HEAD_DUST_SLIDERS, persona.head))
}

function createFigureControls(persona) {
  getDebugStack().appendChild(createSliderPanel('figure', FIGURE_SLIDERS, persona.figure))
}

const machine = createStateMachine()

// Optional LED link to the Arduino. It reads the live state + brightness on (re)connect so the
// strip syncs immediately, and `sendLed` is called every frame (throttled internally in
// firmware.js) so the APPROACH ramp stays smooth. Unavailable browsers/boards degrade to a
// no-op, so the mirror itself is never blocked by the lights.
let ledBrightness = LED.baseBrightness
const ledLink = createLedLink({
  container: app,
  getLed: () => ({ state: machine.state, brightness: ledBrightness }),
})

// Scene first: the renderer owns the black canvas, and the persona is added before any model
// loads so the mirror is already black (not an empty page) while booting.
const renderer = createRenderer({ container: app })
const persona = createPersona({
  // `renderer.view` is the shared mirror-frame metrics object; the persona must not receive the
  // whole renderer API or `halfWidth`/`halfHeight` read as undefined.
  view: renderer.view,
  faceTriangles: FACE_TRIANGLES,
  faceRegions: FACE_REGIONS,
  handCount: GESTURE.numHands,
  pixelRatio: renderer.renderer.getPixelRatio(),
})
renderer.scene.add(persona.group)
if (DEBUG.sliders) {
  createFaceControls(persona)
  createTorsoControls(persona)
  createHandControls(persona)
  createHeadControls(persona)
  createFigureControls(persona)
}

// Story layer: audio buses + the narration sequence, the on-screen text, and the glass-crack
// effect. The director reacts only to the state machine's edge events (see audio/director.js).
const audio = createAudioEngine({ assets: AUDIO_ASSETS })
const text = createTextOverlay({ container: app })
const glass = createGlassBreak({ scene: renderer.scene, view: renderer.view, config: GLASS })
const director = createDirector({ audio, text, glass, config: STORY })

// The AudioContext starts suspended until a user gesture (autoplay policy). The camera-permission
// click or the LED connect button satisfies this in practice; keep listening until a gesture
// actually unlocks it, then stop (and the engine replays any clip that was silenced meanwhile).
const unlockAudio = async () => {
  const unlocked = await audio.unlock()
  if (unlocked) {
    window.removeEventListener('pointerdown', unlockAudio)
    window.removeEventListener('keydown', unlockAudio)
  }
}
window.addEventListener('pointerdown', unlockAudio)
window.addEventListener('keydown', unlockAudio)

/** Fed to the extend-hand detector while the trigger is disabled, so it stays armed. */
const NO_HAND = { landmarks: [], handedness: [] }

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
let lastProximity = 0

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
  const tips = handLandmarks ? FINGERTIPS.filter((index) => handLandmarks[index]).length : 0
  const handConfidence = hand.handedness?.[0]?.[0]?.score ?? 0

  // Per-finger foreshortening: a finger reads as "pointing at the lens" when it has travelled
  // further in depth than in the image plane. The detector now gates on this count, so the
  // readout mirrors the trigger rather than being diagnostics only.
  const fingers = fingerProfile(handLandmarks)
  const pointing = pointingFingerCount(handLandmarks)
  const fingerLine = handLandmarks
    ? fingers
        .map((finger) =>
          finger.inPlane == null
            ? `${finger.label}:—`
            : `${finger.label}:2D${finger.inPlane.toFixed(3)}/z${finger.depth.toFixed(3)}`,
        )
        .join('  ')
    : '—'

  // The extend-hand EXIT trigger is armed only on the prompt step, so a stray reach during the
  // earlier narration cannot cut the story short. While disabled we feed the detector empty
  // results: that keeps it re-armed for the next run instead of leaving a stale trigger latched.
  const triggerEnabled = machine.state === STATE.ENTRY && director.step === STORY.triggerStep
  const extendHand = gesture.detectExtendHand(triggerEnabled ? hand : NO_HAND, timestamp)
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

  // Drive the story from the machine's state + edge events (audio, text, glass, lip-sync).
  director.update({ state, events, timestamp })

  // Proximity: 0 at the far edge of APPROACH, 1 at the edge of ENTRY. It drives both the
  // persona's distance fade-in and the LED's cool-white brightness ramp, so the screen and the
  // strip brighten together as the player closes the gap. Hold the last value through a dropped
  // pose frame so a single missing reading cannot make the figure blink out.
  if (distance != null) {
    const band = APPROACH.approachThreshold - APPROACH.entryThreshold
    const raw = (APPROACH.approachThreshold - distance) / band
    lastProximity = Math.max(0, Math.min(1, raw))
  }
  const proximity = lastProximity

  // Cap the strip while the player is present (APPROACH / ENTRY) so the light cannot flood the
  // webcam's view of the hand; the exposure lock in camera.js is the primary fix.
  const capBrightness = (value) => Math.min(value, LED.trackingMaxBrightness)
  ledBrightness =
    state === STATE.APPROACH
      ? capBrightness(LED.minBrightness + proximity * (LED.maxBrightness - LED.minBrightness))
      : capBrightness(LED.baseBrightness)
  ledLink.sendLed({ state, brightness: ledBrightness })

  const personaFrame = persona.update({
    landmarks,
    faceLandmarks,
    handLandmarks: hand.landmarks,
    state,
    proximity,
    dt,
    mouth: { open: director.mouthOpen },
    shattered: director.shattered,
  })
  glass.update(timestamp)
  renderer.render()

  // Debug readout (DEBUG.readout): skip all the per-frame formatting when it is disabled.
  if (!readout) return

  const distanceLine = distance != null
    ? `${distance.toFixed(2)} m  [apparent ${span.apparent.toFixed(3)} / real ${span.real.toFixed(3)}]`
    : span
      ? `no reading (apparent ${span.apparent.toFixed(3)} < ${DISTANCE.minShoulderWidth})`
      : 'no person'
  // Hold at the true threshold and this is the focalFactor that makes the reading match it.
  const calibrateLine = span
    ? `${(APPROACH.entryThreshold / (span.real / span.apparent)).toFixed(2)} if you stand at ${APPROACH.entryThreshold} m`
    : '—'

  const faceStatus = personaFrame?.face
  const faceBad = faceStatus?.bad
    ? faceStatus.bad.kind === 'view'
      ? `  BAD VIEW halfWidth=${faceStatus.bad.halfWidth} halfHeight=${faceStatus.bad.halfHeight}`
      : `  BAD landmark[${faceStatus.bad.index}].${faceStatus.bad.field}=${String(faceStatus.bad.value)}`
    : ''
  const faceLine = faceStatus
    ? faceStatus.visible
      ? `visible  pts ${faceStatus.written}/${faceStatus.total}  w ${(faceStatus.width ?? 0).toFixed(3)}  h ${(faceStatus.height ?? 0).toFixed(3)}  @ ${(faceStatus.x ?? 0).toFixed(2)},${(faceStatus.y ?? 0).toFixed(2)}${faceBad}`
      : `hidden (${faceStatus.reason})${faceBad}`
    : '—'

  const handsLine = personaFrame?.hands?.length
    ? personaFrame.hands
        .map((handStatus, i) =>
          handStatus.visible
            ? `#${i} ${handStatus.bent ? 'bent' : 'straight'} len ${(handStatus.length ?? 0).toFixed(2)} base ${(handStatus.shoulderThick ?? 0).toFixed(2)} elbow ${(handStatus.elbowThick ?? 0).toFixed(2)} tip ${(handStatus.handThick ?? 0).toFixed(2)} cap ${handStatus.cap ? 'on' : 'off'}`
            : `#${i} ${handStatus.reason ?? 'hidden'}`,
        )
        .join('  ')
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
    `persona   op ${(personaFrame?.opacity ?? 0).toFixed(2)}  ${personaFrame?.visible ? 'shown' : 'hidden'}  ${FACE_REGIONS.length} carve regions`,
    `faceDust  ${faceLine}`,
    `handDust  ${handsLine}`,
    `hand      ${handLandmarks ? `spread ${spread.toFixed(3)} (${tips} tips) / needs ${EXTEND_HAND.minSpread}` : 'none'}`,
    `handConf  ${handLandmarks ? handConfidence.toFixed(2) : '—'}`,
    `fingers   ${fingerLine}${handLandmarks ? `  → pointing ${pointing}/${fingers.length} / needs ${EXTEND_HAND.minPointingFingers}` : ''}`,
    `story     step ${director.step}  ${director.runningAway ? 'running away' : 'present'}  mouth ${director.mouthOpen.toFixed(2)}`,
    `trigger   ${timestamp - lastExtendHandAt < 500 ? `EXTEND_HAND (${extendHandCount})` : triggerEnabled ? `armed (step ${STORY.triggerStep})` : 'disabled'}`,
  ].join('\n')
}

async function boot() {
  showStatus('starting…')
  // Reconnect the LED link in parallel with the camera: it only needs a previously-granted
  // port, and it must not hold up the mirror booting.
  ledLink.autoConnect()
  camera = await startCamera()

  // The browser may negotiate a feed size other than the requested 1280×720, so take the real
  // aspect for the 'contain' mapping rather than trusting the config alone.
  const feed = camera.video
  if (feed?.videoWidth > 0 && feed?.videoHeight > 0) {
    persona.figure.camAspect = feed.videoWidth / feed.videoHeight
  }

  showStatus('loading models…')
  const [poseModel, gestureModel, faceModel] = await Promise.all([
    createPoseLandmarker(),
    createGestureRecognizer(),
    createFaceLandmarker().catch((error) => {
      // The face is one visual layer; if it fails the rest of the prop still runs.
      console.warn('FaceLandmarker failed to load; the face dust will stay hidden.', error)
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
    window.removeEventListener('pointerdown', unlockAudio)
    window.removeEventListener('keydown', unlockAudio)
    director.reset()
    audio.dispose()
    text.dispose()
    glass.dispose()
    persona.dispose()
    renderer.dispose()
    ledLink.dispose()
  })
}
