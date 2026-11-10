import { FaceLandmarker } from '@mediapipe/tasks-vision'
import { DELEGATE, FACE, MODEL_PATHS } from '../config.js'
import { getVisionFileset } from './fileset.js'

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
 * Turn a MediaPipe contour connection list into an ordered list of landmark indices.
 *
 * The contour arrays are `(start, end)` pairs in ring order, but walking the adjacency (rather
 * than trusting the pairs' order/orientation) keeps this robust to either direction and returns
 * every point exactly once. Open paths simply terminate at their endpoint.
 */
function orderedRing(connections) {
  if (!connections.length) return []

  const neighbours = new Map()
  for (const { start, end } of connections) {
    if (!neighbours.has(start)) neighbours.set(start, [])
    if (!neighbours.has(end)) neighbours.set(end, [])
    neighbours.get(start).push(end)
    neighbours.get(end).push(start)
  }

  const ring = []
  const seen = new Set()
  let prev = null
  let current = connections[0].start

  while (current != null && !seen.has(current)) {
    ring.push(current)
    seen.add(current)
    const around = neighbours.get(current) ?? []
    const next = around.find((index) => index !== prev)
    prev = current
    current = next
  }

  return ring
}

/**
 * The regions carved out of the face dust, as closed polygons of landmark indices.
 *
 * The eyes and lips are already closed contours. The nose is not (MediaPipe only exposes it as a
 * tangled set of segments, with the tip shared by several), so `hull` tells the renderer to take
 * the convex hull of its landmarks instead — a stable closed outline that still hugs the nose.
 */
export const FACE_REGIONS = [
  { name: 'leftEye', indices: orderedRing(FaceLandmarker.FACE_LANDMARKS_LEFT_EYE) },
  { name: 'rightEye', indices: orderedRing(FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE) },
  { name: 'lips', indices: orderedRing(FaceLandmarker.FACE_LANDMARKS_LIPS) },
  {
    name: 'nose',
    indices: [...new Set(FACE_NOSE.flatMap(({ start, end }) => [start, end]))],
    hull: true,
  },
]

/**
 * Builds the face model that supplies the persona's face mesh.
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
