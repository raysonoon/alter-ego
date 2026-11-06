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
 * MediaPipe's canonical nose outline.
 *
 * tasks-vision exposes the eyes, lips, brows and oval as static connection arrays, but the nose
 * only exists inside the tesselation. These pairs are taken from MediaPipe's `FACEMESH_NOSE`
 * (nose tip `1`, bridge `168 → 6`, nostrils `197`/`195`, alar wings `98`/`327`).
 */
export const FACE_NOSE = [
  [168, 6], [6, 197], [197, 195], [195, 5], [5, 4], [4, 1], [1, 19],
  [19, 94], [94, 2], [98, 97], [97, 2], [2, 326], [326, 327], [327, 294],
  [294, 278], [278, 344], [344, 440], [440, 275], [275, 4], [4, 45],
  [45, 220], [220, 115], [115, 48], [48, 64], [64, 98],
].map(([start, end]) => ({ start, end }))

/**
 * The full face-mesh topology (MediaPipe's `FACEMESH_TESSELATION`).
 *
 * tasks-vision exposes the tesselation as ordered edges in triangle triples — `(a,b), (b,c),
 * (c,a)` — so flattening every third edge's start/end/end yields a triangle index buffer over
 * landmarks 0–467 (852 triangles).
 */
export const FACE_TESSELATION = FaceLandmarker.FACE_LANDMARKS_TESSELATION

export const FACE_TRIANGLES = (() => {
  const edges = FACE_TESSELATION
  const triangles = new Uint16Array(Math.floor(edges.length / 3) * 3)
  for (let e = 0, t = 0; e + 2 < edges.length; e += 3, t += 3) {
    triangles[t] = edges[e].start
    triangles[t + 1] = edges[e].end
    triangles[t + 2] = edges[e + 1].end
  }
  return triangles
})()

/**
 * The contours that make up the ghostly face. They are all baked into one point cloud with one
 * material so they read as a single face, not a separate wireframe per feature.
 */
export const FACE_FEATURES = [
  { name: 'oval', connections: FaceLandmarker.FACE_LANDMARKS_FACE_OVAL },
  { name: 'lips', connections: FaceLandmarker.FACE_LANDMARKS_LIPS },
  { name: 'leftEye', connections: FaceLandmarker.FACE_LANDMARKS_LEFT_EYE },
  { name: 'rightEye', connections: FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE },
  { name: 'nose', connections: FACE_NOSE },
]

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
