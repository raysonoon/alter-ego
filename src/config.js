// Central tunables for the Magic Mirror prop

/**
 * Both the models and the WASM runtime are vendored locally so the prop runs offline.
 */
export const WASM_PATH = '/wasm'

export const MODEL_PATHS = {
  pose: '/models/pose_landmarker_lite.task',
  gesture: '/models/gesture_recognizer.task',
  face: '/models/face_landmarker.task',
}

/**
 * Preferred inference backend. The prop runs on an external laptop we don't fully control,
 * so every model creation falls back to 'CPU' if the GPU/WebGL path fails to initialise.
 */
export const DELEGATE = 'GPU'

export const CAMERA = {
  width: 1280,
  height: 720,
  facingMode: 'user',
  /** Debug aid: render the live feed as a corner thumbnail. Off in the final prop. */
  preview: true,
}

export const POSE = {
  numPoses: 1,
  minPoseDetectionConfidence: 0.5,
  minPosePresenceConfidence: 0.5,
  minTrackingConfidence: 0.5,
}

/**
 * APPROACH: the distance-to-camera estimate that drives the IDLE → APPROACH transition.
 *
 * MediaPipe's `worldLandmarks` are hip-origin, so they describe the player's pose in real
 * metres but carry no camera-distance signal — `nose.z` reads near zero however close the
 * player stands. A real metre reading needs both outputs combined (see `personDistance`):
 * the shoulder width in metres from `worldLandmarks`, which self-adjusts per body size,
 * divided by the same shoulders' apparent width in the image, which shrinks with distance.
 */
export const DISTANCE = {
  /**
   * Focal constant for the webcam: how image-space width maps to metres. It depends only on
   * the lens field of view, not on the player, so it is calibrated once — stand at a known
   * distance, read the reported value, and scale this until it matches.
   */
  focalFactor: 0.87,
  /**
   * Narrowest apparent shoulder width we still trust. Below this the pose is edge-on or too
   * far away and the ratio would blow up, so the frame reports "no reading".
   */
  minShoulderWidth: 0.02,
}

export const APPROACH = {
  /** Metres from the camera within which the player counts as present at the mirror. */
  distanceThreshold: 1.2,
  /**
   * Leave APPROACH only once the distance reads above `distanceThreshold + hysteresis`, so
   * jitter around the line cannot thrash the state.
   */
  hysteresis: 0.3,
  /** How long a range change must hold before the state machine acts on it. */
  debounceMs: 400,
  /** How long the pose must be absent before the player counts as having left the frame. */
  lostMs: 400,
}

export const GESTURE = {
  numHands: 2,
  minHandDetectionConfidence: 0.5,
  minHandPresenceConfidence: 0.5,
  minTrackingConfidence: 0.5,
}

/**
 * HAND DUST: the dust cloud that clings to each tracked hand.
 *
 * It mirrors the torso cloud but is seeded across the hand's bounding box instead. 
 * Values are in mirror-frame world units; the hand is small on a mirror-mounted camera, so its point
 * size and spread are deliberately larger-relative than the torso's.
 */
export const HAND = {
  /** Particles per hand. Two clouds are live whenever both hands are tracked. */
  particleCount: 220,
  /** Sprite radius in px, before the device pixel ratio. */
  particleRadius: 4,
  dustColor: 0x8fb4e0,
  dustOpacity: 0.75,
  /** Dust may spill past the hand's bounding box so the edge reads as unravelling. */
  dustSpread: 1.35,
  /**
   * The dust runs continuously from the torso down the arm as two capsules — shoulder→elbow and
   * elbow→hand — so a bent arm reads naturally. `armThickness` is the base (shoulder-end) radius
   * as a fraction of shoulder width, `armElbowTaper` the elbow radius as a fraction of that base,
   * and `armTaper` the hand-end radius as a fraction of the base.
   */
  armThickness: 0.22,
  armElbowTaper: 0.75,
  armTaper: 0.55,
  /**
   * A distinct hand cap sits over the hand at the end of the arm: denser, larger particles and a
   * brighter colour so the hand reads as its own silhouette instead of just the tip of the arm.
   */
  capCount: 180,
  capSize: 6,
  capOpacity: 0.95,
  capColor: 0xcfe8ff,
  capSpread: 1.5,
  /** Cloud thickness / z-offset in front of the torso. */
  depth: 0.04,
  drift: 0.015,
  rise: 0.008,
  /**
   * Smallest hand bounding-box span (world units) we still draw. A cropped, partially-tracked
   * hand would otherwise collapse to a point and flash a dot at the frame edge.
   */
  minSpan: 0.05,
}

/**
 * The persona's face mesh. BlazePose only reports a handful of face points (nose, eyes, ears,
 * mouth), which is not enough to fill a face, so a dedicated FaceLandmarker supplies the
 * 478-point face mesh and its tesselation.
 */
export const FACE = {
  numFaces: 1,
  minFaceDetectionConfidence: 0.5,
  minFacePresenceConfidence: 0.5,
  minTrackingConfidence: 0.5,
}

/**
 * EXIT TRIGGER: the player extends a hand toward the mirror — fingers pointing at the camera —
 * and holds it still.
 *
 * The canned classifier has no category for this, and a hand's `worldLandmarks` are
 * origin-centred on the hand itself, so they carry no camera-distance signal. The trigger is
 * therefore built from:
 *   - closeness: apparent hand size, measured across the fingertips only (a reaching hand
 *     loses its palm first, which is why a wrist→MCP reading collapsed);
 *   - foreshortening: the fingertips sit at a clearly different depth from the wrist when the
 *     fingers point at the lens. A flat open palm keeps every landmark at ~one depth whatever
 *     its distance, so this is what separates an extend from an open palm held just as close;
 *   - stillness, then a hold duration.
 *
 * Every gate must hold simultaneously for `holdMs`. The spread and z-spread thresholds are
 * placeholders — calibrate against the live readout, which prints both.
 */
export const EXTEND_HAND = {
  /**
   * Largest fingertip-to-fingertip distance, normalised. Below this the hand isn't "reached
   * out". Measured across the fingertips only, because the palm drops out of frame first when
   * a hand reaches at the mirror-mounted camera.
   */
  minSpread: 0.45,
  /**
   * Minimum depth range across the hand's landmarks, normalised. A flat open palm reads near
   * zero at any distance; a hand pointing at the camera reads well above it.
   */
  minZSpread: 0.22,
  /**
   * Max fingertip-centroid travel allowed across the stillness window, as a fraction of the
   * current spread: a close, large hand is allowed proportionally more jitter, so a slightly
   * trembling hand doesn't keep restarting the hold timer.
   */
  stillness: 0.15,
  /**
   * The reach is left only once the spread drops below `minSpread * this`, so flicker across
   * the threshold cannot reset the hold timer.
   */
  spreadHysteresis: 0.7,
  /** Length of the rolling fingertip-history window used to judge stillness. */
  stillnessWindowMs: 200,
  /** How long every gate must stay satisfied before the trigger fires. */
  holdMs: 1200,
  /** Minimum gap between triggers. */
  cooldownMs: 1500,
}

/**
 * PERSONA: the figure that materialises while the player is at the mirror.
 *
 * A dust cloud seeded across the shoulder→hip volume forms the wispy torso silhouette; a filled,
 * carved face-dust point cloud sits in front, with a dust halo around the head.
 *
 * The colours are deliberately low-luminance to replace the reflection
 */
export const PERSONA = {
  dustColor: 0x6f8fc4,
  faceColor: 0x9fd8ff,

  /** Peak alphas for each layer, before the materialise/dissolve ramp. */
  dustOpacity: 0.9,

  /** Dust cloud. */
  particleCount: 900,
  particleRadius: 7,
  /** Dust may spill past the silhouette edge so the body reads as unravelling. */
  dustSpread: 1.22,
  /** Torso thickness and per-particle drift, in mirror-frame world units. */
  depth: 0.22,
  drift: 0.05,
  rise: 0.04,

  /**
   * Head dust: a second cloud seeded in a ring around the face so the dust spreads around the
   * head too. Positions are seeded at 0.55–1.0 of the face radius, then pushed out by `spread`.
   */
  headDustCount: 260,
  headDustSpread: 1.5,
  headDustSize: 5,
  headDustOpacity: 0.5,
  headDustDrift: 0.15,
  headDustRise: 0.04,
  headDustColor: 0x8fb4e0,

  /** Opacity ramp time constants (seconds) for appearing and dissolving. */
  appearTau: 0.5,
  disappearTau: 0.7,

  /**
   * Face dust: a filled point cloud seeded across the face mesh, drifting like the torso dust and
   * carved around the eyes/nose/mouth. `faceCarveSoftness` is the world-unit falloff at a carved
   * feature's edge (0 = hard cut), so the empty shapes read as soft voids rather than stamps.
   */
  faceDustCount: 750,
  faceDustSize: 5,
  faceDustOpacity: 0.55,
  faceDustDrift: 0.012,
  faceDustRise: 0.006,
  faceCarveSoftness: 0.02,

  /** How far in front of the torso the face sits. */
  faceDepth: 0.06,
}
