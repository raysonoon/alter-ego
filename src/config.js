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
  numHands: 1,
  minHandDetectionConfidence: 0.5,
  minHandPresenceConfidence: 0.5,
  minTrackingConfidence: 0.5,
}

/**
 * The persona's face contour. BlazePose only reports a handful of face points (nose, eyes,
 * ears, mouth), which is not enough to outline a face, so a dedicated FaceLandmarker supplies
 * the 478-point face mesh and its `FACE_LANDMARKS_FACE_OVAL` contour.
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
 * Two layers share one silhouette:
 *   - a coarse shoulder→hip mesh whose fragment shader burns its edges into animated noise,
 *     giving the smoky body;
 *   - a dust cloud of points seeded across the same volume, drifting on their own noise, so
 *     the body looks like it is unravelling into particles.
 * The FaceLandmarker's face-oval contour then sits just in front as a dim cool line.
 *
 * The colours are deliberately low-luminance to replace the reflection
 */
export const PERSONA = {
  bodyColor: 0x2b3550,
  dustColor: 0x6f8fc4,
  faceColor: 0x9fd8ff,

  /** Peak alphas for each layer, before the materialise/dissolve ramp. */
  bodyOpacity: 0.55,
  dustOpacity: 0.5,
  faceOpacity: 0.9,

  /** Torso mesh subdivision. More cells = a smoother dissolve, at a vertex cost. */
  columns: 24,
  rows: 32,

  /** Dust cloud. */
  particleCount: 900,
  particleRadius: 7,
  /** Dust may spill past the silhouette edge so the body reads as unravelling. */
  dustSpread: 1.22,
  /** Torso thickness and per-particle drift, in mirror-frame world units. */
  depth: 0.22,
  drift: 0.06,
  rise: 0.04,

  /** Noise look: spatial frequency (x, y) for the fringe, and animation speed. */
  noiseScale: [3.0, 6.0],
  /** Fraction of the noise field burned away at full opacity. Higher = thinner smoke. */
  dissolve: 0.18,
  /** At zero opacity the smoke is almost all holes, so it coalesces as it appears. */
  dissolveAtZero: 0.6,
  dissolveSoftness: 0.35,
  /** Vertex billow amplitude, in world units. */
  displace: 0.05,

  /** Opacity ramp time constants (seconds) for appearing and dissolving. */
  appearTau: 0.5,
  disappearTau: 0.7,

  /** How far in front of the torso the face contour sits. */
  faceDepth: 0.06,
}
