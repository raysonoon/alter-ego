import { FaceLandmarker } from '@mediapipe/tasks-vision'
import { DELEGATE, FACE, MODEL_PATHS } from '../config.js'
import { getVisionFileset } from './fileset.js'

/**
 * The face-oval contour, as MediaPipe's list of landmark-index connections.
 *
 * BlazePose only reports ~11 face points, which cannot outline a face. The FaceLandmarker
 * returns the full 478-point mesh, and this oval is the boundary of it: the jaw, cheeks and
 * forehead in one closed chain. The persona draws it as line segments, so the connection pairs
 * can be used directly without re-ordering them.
 */
export const FACE_OVAL = FaceLandmarker.FACE_LANDMARKS_FACE_OVAL

/**
 * Builds the face model behind the persona's contour.
 *
 * Reuses the shared tasks-vision WASM runtime (see `fileset.js`) and the same VIDEO-mode
 * contract as the pose and hand models: strictly increasing timestamps, never re-submitting a
 * frame. Falls back to CPU if the preferred delegate fails to initialise.
 */
export async function createFaceLandmarker() {
  const fileset = await getVisionFileset()

  const build = (delegate) =>
    FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_PATHS.face, delegate },
      runningMode: 'VIDEO',
      numFaces: FACE.numFaces,
      minFaceDetectionConfidence: FACE.minFaceDetectionConfidence,
      minFacePresenceConfidence: FACE.minFacePresenceConfidence,
      minTrackingConfidence: FACE.minTrackingConfidence,
    })

  let landmarker
  try {
    landmarker = await build(DELEGATE)
  } catch (error) {
    if (DELEGATE === 'CPU') throw error
    console.warn(`Face: ${DELEGATE} delegate failed, falling back to CPU.`, error)
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
