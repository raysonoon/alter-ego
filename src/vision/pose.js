import { PoseLandmarker } from '@mediapipe/tasks-vision'
import { DELEGATE, DISTANCE, MODEL_PATHS, POSE } from '../config.js'
import { getVisionFileset } from './fileset.js'

/** BlazePose landmark indices, named for the landmarks the interaction loop reads. */
export const POSE_LANDMARKS = {
  NOSE: 0,
  LEFT_EYE: 2,
  RIGHT_EYE: 5,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
}

/**
 * The player's shoulder span as the pair of readings the distance model needs:
 * `{ apparent, real }`.
 *
 *   - `apparent` — shoulder width in normalised image space (from `landmarks`), which shrinks
 *     as the player steps back;
 *   - `real` — the same shoulders in metres (from `worldLandmarks`), which stays constant for
 *     a given body and so self-adjusts the model for different body sizes.
 *
 * Returns `null` when either shoulder is untracked. Horizontal only for `apparent`: `x` and
 * `y` are normalised by different dimensions, so folding `y` into a width would distort it.
 *
 * @param {Array<{x:number,y:number,z:number}>|undefined} landmarks
 * @param {Array<{x:number,y:number,z:number}>|undefined} worldLandmarks
 */
export function shoulderSpan(landmarks, worldLandmarks) {
  const left = landmarks?.[POSE_LANDMARKS.LEFT_SHOULDER]
  const right = landmarks?.[POSE_LANDMARKS.RIGHT_SHOULDER]
  const realLeft = worldLandmarks?.[POSE_LANDMARKS.LEFT_SHOULDER]
  const realRight = worldLandmarks?.[POSE_LANDMARKS.RIGHT_SHOULDER]
  if (!left || !right || !realLeft || !realRight) return null

  return {
    apparent: Math.abs(left.x - right.x),
    real: Math.hypot(
      realLeft.x - realRight.x,
      realLeft.y - realRight.y,
      realLeft.z - realRight.z,
    ),
  }
}

/**
 * Distance from the camera to the player, in metres, or `null` when the pose cannot supply a
 * trustworthy reading.
 *
 * `worldLandmarks` are hip-origin, so on their own they give the shoulder width in real metres
 * but no camera distance; the normalised `landmarks` give the same shoulders' apparent width
 * in the image. Real width / apparent width is therefore proportional to distance, and
 * `DISTANCE.focalFactor` converts it to metres. Because the real width is measured rather than
 * assumed, the reading self-adjusts for body size; the focal constant is the only calibration.
 *
 * Assumes the player faces the camera — a player turned side-on reads as further away.
 */
export function personDistance(landmarks, worldLandmarks) {
  const span = shoulderSpan(landmarks, worldLandmarks)
  if (!span || span.apparent < DISTANCE.minShoulderWidth) return null

  return (span.real / span.apparent) * DISTANCE.focalFactor
}

/**
 * Builds the pose model used for the IDLE distance check and the APPROACH gaze/head
 * tracking.
 *
 * `runningMode: 'VIDEO'` means callers must pass strictly increasing timestamps and must
 * not re-submit a frame they already submitted, or MediaPipe throws.
 */
export async function createPoseLandmarker() {
  const fileset = await getVisionFileset()

  const build = (delegate) =>
    PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_PATHS.pose, delegate },
      runningMode: 'VIDEO',
      numPoses: POSE.numPoses,
      minPoseDetectionConfidence: POSE.minPoseDetectionConfidence,
      minPosePresenceConfidence: POSE.minPosePresenceConfidence,
      minTrackingConfidence: POSE.minTrackingConfidence,
    })

  let landmarker
  try {
    landmarker = await build(DELEGATE)
  } catch (error) {
    if (DELEGATE === 'CPU') throw error
    console.warn(`Pose: ${DELEGATE} delegate failed, falling back to CPU.`, error)
    landmarker = await build('CPU')
  }

  return {
    /** @param {HTMLVideoElement} video @param {number} timestamp strictly increasing, in ms */
    detect(video, timestamp) {
      return landmarker.detectForVideo(video, timestamp)
    },
    close() {
      landmarker.close()
    },
  }
}
