import { GestureRecognizer } from '@mediapipe/tasks-vision'
import { DELEGATE, EXTEND_HAND, GESTURE, MODEL_PATHS } from '../config.js'
import { getVisionFileset } from './fileset.js'

/** Fingertip landmark indices: thumb, index, middle, ring, pinky. */
export const FINGERTIPS = [4, 8, 12, 16, 20]

/**
 * Apparent hand size in normalised image units: the largest distance between any two
 * fingertips, i.e. the diameter of the tip set.
 *
 * Only the fingertips are used. A hand reaching at the mirror-mounted camera loses its palm
 * first — the wrist and MCPs slide off-frame or get hidden behind the back of the hand — so
 * measuring wrist→middle-MCP under-reads to near zero exactly when the player reaches, which
 * kept the closeness gate shut. Fingertips stay in frame and hold a wide, stable separation
 * for the whole reach.
 */
export function handSize(landmarks) {
  const tips = FINGERTIPS.map((index) => landmarks?.[index]).filter(Boolean)

  let diameter = 0
  for (let i = 0; i < tips.length; i += 1) {
    for (let j = i + 1; j < tips.length; j += 1) {
      diameter = Math.max(diameter, Math.hypot(tips[i].x - tips[j].x, tips[i].y - tips[j].y))
    }
  }
  return diameter
}

/**
 * Mean fingertip position.
 *
 * The stillness anchor: the wrist is the least reliable landmark in a close reach, and its
 * jitter used to flicker the size reading and keep resetting the hold timer.
 */
export function fingertipCentroid(landmarks) {
  const tips = FINGERTIPS.map((index) => landmarks?.[index]).filter(Boolean)
  if (!tips.length) return null

  return {
    x: tips.reduce((sum, tip) => sum + tip.x, 0) / tips.length,
    y: tips.reduce((sum, tip) => sum + tip.y, 0) / tips.length,
  }
}

/**
 * Depth range across the hand's landmarks: `max(z) - min(z)`.
 *
 * This is what tells the two "wide hand" poses apart, and it is distance-independent. A hand
 * pointing at the camera is foreshortened — the fingertips sit at a clearly different depth
 * from the wrist — whereas a flat open palm keeps every landmark at roughly one depth however
 * close it is held. So an open palm held as close as an extend still reads near zero here.
 */
export function handZSpread(landmarks) {
  const zs = (landmarks ?? [])
    .map((landmark) => landmark?.z)
    .filter((z) => typeof z === 'number')
  if (zs.length < 2) return 0
  return Math.max(...zs) - Math.min(...zs)
}

/**
 * The four non-thumb fingers, as MCP (knuckle) and tip landmark indices.
 *
 * The thumb is excluded: it is not a "pointing" finger, and its landmarks are the least
 * stable of the five.
 */
export const FINGERS = [
  { label: 'I', mcp: 5, tip: 8 }, // index
  { label: 'M', mcp: 9, tip: 12 }, // middle
  { label: 'R', mcp: 13, tip: 16 }, // ring
  { label: 'P', mcp: 17, tip: 20 }, // pinky
]

/**
 * Per-finger foreshortening profile, for diagnosing the poses that currently false-positive.
 *
 * Each finger is measured against *its own* knuckle rather than against the other fingertips:
 *   - `inPlane` — tip→MCP distance in the image plane;
 *   - `depth` — tip→MCP distance along z.
 *
 * A finger pointing at the lens is foreshortened: small `inPlane`, large `depth`. An open palm
 * is the opposite (large `inPlane`, small `depth`), and a curled finger (fist) is small on both
 * — which is why neither the spread nor the z-spread gate can tell them apart.
 */
export function fingerProfile(landmarks) {
  return FINGERS.map(({ label, mcp, tip }) => {
    const knuckle = landmarks?.[mcp]
    const fingertip = landmarks?.[tip]
    if (!knuckle || !fingertip) return { label, inPlane: null, depth: null }

    return {
      label,
      inPlane: Math.hypot(fingertip.x - knuckle.x, fingertip.y - knuckle.y),
      depth: Math.abs(fingertip.z - knuckle.z),
    }
  })
}

/**
 * The EXIT TRIGGER: hand extended toward the mirror (closeness + foreshortening) + held steady
 * (stillness) + long enough (hold duration).
 *
 * A reach is a state over time, not a single-frame pose, so this holds the small amount of
 * history the gates need. Edge-triggered: it returns true for exactly one frame per completed
 * extend, and re-arms only after the hand leaves the frame or is pulled back out of reach, so
 * one held hand cannot fire repeatedly.
 *
 * Exported so the gate logic can be exercised without a camera.
 */
export function createExtendHandDetector() {
  let samples = []
  let holdStartedAt = null
  let armed = true
  let reached = false
  let lastFiredAt = -Infinity

  const reset = () => {
    samples = []
    holdStartedAt = null
  }

  /**
   * True when the fingertip centroid stayed inside a box scaled to the hand's apparent size,
   * so a close (large) hand is allowed proportionally more jitter than a distant one.
   */
  const isStill = (spread) => {
    const tolerance = EXTEND_HAND.stillness * spread
    const xs = samples.map((sample) => sample.x)
    const ys = samples.map((sample) => sample.y)
    return (
      Math.max(...xs) - Math.min(...xs) <= tolerance &&
      Math.max(...ys) - Math.min(...ys) <= tolerance
    )
  }

  return function detectExtendHand(result, timestamp) {
    const hand = result.landmarks?.[0]
    const confidence = result.handedness?.[0]?.[0]?.score ?? 0

    if (!hand || confidence < GESTURE.minHandDetectionConfidence) {
      reset()
      armed = true // hand left the frame: ready to fire again
      reached = false
      return false
    }

    const spread = handSize(hand)

    // Hysteresis: enter the reach at `minSpread`, leave only below `minSpread * hysteresis`, so
    // a spread hovering around the threshold cannot keep resetting the hold timer.
    if (spread < EXTEND_HAND.minSpread * EXTEND_HAND.spreadHysteresis) {
      reset()
      armed = true // pulled back out of reach: ready to fire again
      reached = false
      return false
    }
    if (spread >= EXTEND_HAND.minSpread) reached = true
    if (!reached) {
      reset()
      return false
    }

    // A flat open palm is just as wide and can be held just as close; only the depth range
    // separates it from a hand whose fingers point at the camera.
    if (handZSpread(hand) < EXTEND_HAND.minZSpread) {
      reset()
      return false
    }

    const centroid = fingertipCentroid(hand)
    if (!centroid) {
      reset()
      return false
    }

    samples.push({ t: timestamp, x: centroid.x, y: centroid.y })
    samples = samples.filter((sample) => timestamp - sample.t <= EXTEND_HAND.stillnessWindowMs)

    // Need a full window of history before stillness means anything.
    if (samples.length < 2 || !isStill(spread)) {
      holdStartedAt = null
      return false
    }

    holdStartedAt ??= timestamp

    const heldLongEnough = timestamp - holdStartedAt >= EXTEND_HAND.holdMs
    const readyToFire = armed && timestamp - lastFiredAt >= EXTEND_HAND.cooldownMs
    if (!heldLongEnough || !readyToFire) return false

    armed = false
    lastFiredAt = timestamp
    reset()
    return true
  }
}

/**
 * Builds the hand model behind the EXIT TRIGGER.
 *
 * Same VIDEO-mode contract as the pose model: strictly increasing timestamps, no
 * re-submitted frames.
 *
 * The canned gesture categories in `recognize().gestures` are deliberately unused — the
 * extend-hand trigger is derived from `landmarks`/`handedness`, which this model already
 * returns, so no separate HandLandmarker asset is needed.
 */
export async function createGestureRecognizer() {
  const fileset = await getVisionFileset()

  const build = (delegate) =>
    GestureRecognizer.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_PATHS.gesture, delegate },
      runningMode: 'VIDEO',
      numHands: GESTURE.numHands,
      minHandDetectionConfidence: GESTURE.minHandDetectionConfidence,
      minHandPresenceConfidence: GESTURE.minHandPresenceConfidence,
      minTrackingConfidence: GESTURE.minTrackingConfidence,
    })

  let recognizer
  try {
    recognizer = await build(DELEGATE)
  } catch (error) {
    if (DELEGATE === 'CPU') throw error
    console.warn(`Gesture: ${DELEGATE} delegate failed, falling back to CPU.`, error)
    recognizer = await build('CPU')
  }

  const detectExtendHand = createExtendHandDetector()

  return {
    /** @param {HTMLVideoElement} video @param {number} timestamp strictly increasing, in ms */
    recognize(video, timestamp) {
      return recognizer.recognizeForVideo(video, timestamp)
    },
    /**
     * Feed the most recent `recognize()` result. Returns true on the single frame an
     * extend-hand completes.
     *
     * @param {import('@mediapipe/tasks-vision').GestureRecognizerResult} result
     * @param {number} timestamp same clock passed to `recognize()`
     */
    detectExtendHand(result, timestamp) {
      return detectExtendHand(result, timestamp)
    },
    close() {
      recognizer.close()
    },
  }
}
