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
  /**
   * Lock the camera's exposure so bright LED light cannot make the webcam's auto-exposure swing
   * and wash out the hand mid-reach. Chromium exposes manual exposure through the track;
   * unsupported webcams keep their auto settings and the prop still runs. `exposureTime` is the
   * value to lock to (platform units) — `null` locks to whatever the camera chose at boot, under
   * the ambient light, which is usually the right call. The console logs the usable range.
   */
  lockExposure: true,
  exposureTime: null,
}

/**
 * LED LINK: the state push to the Arduino UNO R4 WiFi driving the addressable strip.
 *
 * The browser (Web Serial, Chromium only) sends a two-byte frame over the Arduino's native USB
 * port on every state transition and, while the player is approaching, whenever the brightness
 * changes: `[command, brightness]`. `commands` maps each state to the first byte; the firmware
 * turns it into a solid strip colour (IDLE red / APPROACH cool white / ENTRY blue / EXIT green)
 * and applies the brightness byte (0 = off, 255 = full).
 */
export const SERIAL = {
  baudRate: 9600,
  commands: {
    IDLE: 'I',
    APPROACH: 'A',
    ENTRY: 'N',
    EXIT: 'E',
  },
}

/**
 * APPROACH cue: the strip is a cool white that is faint at the far edge of APPROACH and grows
 * brighter as the player closes the gap to ENTRY. The ramp spans the APPROACH band
 * (`APPROACH.approachThreshold` → `APPROACH.entryThreshold`).
 */
export const LED = {
  /** Brightness (0–1) for the solid IDLE / ENTRY / EXIT colours (the old global 64/255). */
  baseBrightness: 64 / 255,
  /**
   * Brightness (0–1) at the far edge of APPROACH (the player just stepped within range).
   *
   * The ramp tops out at `maxBrightness`, kept deliberately low: cool white is the worst case
   * for a WS2812 strip, and running it near full pulls enough current that the 5 V rail sags and
   * the white drifts pink → red as it brightens. Lower `maxBrightness` further if it still
   * colours, or fix the supply (≥3.6 A, power injection) before raising it.
   */
  minBrightness: 0.1,
  /** Brightness (0–1) at the near edge of APPROACH (about to cross into ENTRY). */
  maxBrightness: 0.3,
  /**
   * Hard ceiling on strip brightness while the player is present (APPROACH / ENTRY), where hand
   * tracking has to keep working. The APPROACH ramp can otherwise reach full and flood the
   * webcam's view of the hand; lower this if tracking still drops under the lights.
   */
  trackingMaxBrightness: 0.1,
  /** How often a brightness update may be streamed, in milliseconds (≈20 Hz). */
  streamIntervalMs: 50,
}

export const POSE = {
  numPoses: 1,
  minPoseDetectionConfidence: 0.5,
  minPosePresenceConfidence: 0.5,
  minTrackingConfidence: 0.5,
}

/**
 * APPROACH: the distance-to-camera estimate that drives the IDLE → APPROACH → ENTRY ladder.
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
  focalFactor: 0.55,
  /**
   * Narrowest apparent shoulder width we still trust. Below this the pose is edge-on or too
   * far away and the ratio would blow up, so the frame reports "no reading".
   */
  minShoulderWidth: 0.02,
}

export const APPROACH = {
  /**
   * The outer edge of APPROACH, in metres. The player enters APPROACH once the distance reads
   * at or below this, and leaves it again above `approachThreshold + hysteresis`.
   */
  approachThreshold: 2,
  /**
   * The edge of ENTRY, in metres. Within this the player counts as present at the mirror and
   * the current ≤1.2 m logic (persona, extend-hand → EXIT) applies. ENTRY is left again above
   * `entryThreshold + hysteresis`.
   */
  entryThreshold: 1.2,
  /**
   * Leave a zone only once the distance reads above its threshold + hysteresis, so jitter
   * around the line cannot thrash the state.
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
  dustOpacity: 1,
  /** Dust may spill past the hand's bounding box so the edge reads as unravelling. */
  dustSpread: 1.35,
  /**
   * The dust runs continuously from the torso down the arm as two capsules — shoulder→elbow and
   * elbow→hand — so a bent arm reads naturally. `armThickness` is the base (shoulder-end) radius
   * as a fraction of shoulder width, `armElbowTaper` the elbow radius as a fraction of that base,
   * and `armTaper` the hand-end radius as a fraction of the base.
   */
  armThickness: 0.21,
  armElbowTaper: 0.75,
  armTaper: 0.55,
  /**
   * A distinct hand cap sits over the hand at the end of the arm: denser, larger particles and a
   * brighter colour so the hand reads as its own silhouette instead of just the tip of the arm.
   */
  capCount: 180,
  capSize: 6,
  capOpacity: 0.9,
  capColor: 0x9fd8ff,
  capSpread: 1.1,
  /** Cloud thickness / z-offset in front of the torso. */
  depth: 0.04,
  drift: 0.05,
  rise: 0.03,
  /**
   * Wisp shaping. The hand is seeded in a box, so without these it reads as a rigid rectangle.
   * `edgeSoftness` is the feather width: 0 keeps a crisp edge and 1 fades out from the centre,
   * `ragged` perturbs that edge with noise so it frays irregularly, and `clump` breaks the
   * uniform interior into drifting strands. `flicker` and `flickerSpeed` make individual motes
   * twinkle in and out like dust. All are live-tunable.
   */
  edgeSoftness: 0.5,
  ragged: 0.25,
  clump: 0.5,
  flicker: 0.8,
  flickerSpeed: 1.5,
  /** Slow, bounded upward drift so wisps lift and trail instead of shivering in place. */
  stream: 0.02,
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
 *   - foreshortening: each finger's tip sits at a clearly different depth from its knuckle when
 *     the fingers point at the lens. A flat open palm keeps every landmark at ~one depth
 *     whatever its distance, so this is what separates an extend from an open palm held just as
 *     close. The gate is loosened to a per-finger count: a minority of pointing fingers is
 *     enough, because the per-landmark z is the noisiest output under bright light;
 *   - stillness, then a hold duration.
 *
 * Every gate must hold simultaneously for `holdMs`. The spread threshold is a placeholder —
 * calibrate against the live readout, which prints it.
 */
export const EXTEND_HAND = {
  /**
   * Largest fingertip-to-fingertip distance, normalised. Below this the hand isn't "reached
   * out". Measured across the fingertips only, because the palm drops out of frame first when
   * a hand reaches at the mirror-mounted camera.
   */
  minSpread: 0.1,
  /**
   * Foreshortening gate, loosened: a finger "points at the lens" when its tip→knuckle depth is
   * greater than `pointingRatio` × its in-plane length. The trigger passes once at least
   * `minPointingFingers` fingers read as pointing — a minority is enough, so one noisy or
   * partly occluded finger cannot reject an otherwise valid reach under bright light.
   */
  minPointingFingers: 0,
  pointingRatio: 1.5,
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
  dustColor: 0x8fb4e0,
  faceColor: 0x9fd8ff,

  /** Peak alphas for each layer, before the materialise/dissolve ramp. */
  dustOpacity: 0.55,

  /** Dust cloud. */
  particleCount: 900,
  particleRadius: 4.5,
  /** Dust may spill past the silhouette edge so the body reads as unravelling. */
  dustSpread: 1.22,
  /**
   * Subtle waist pinch: the fraction the silhouette narrows around the chest. 0 makes the torso a
   * straight taper hip→shoulder; higher values curve the sides in for an organic body shape.
   */
  waistPinch: 0.25,
  /** Torso thickness and per-particle drift, in mirror-frame world units. */
  depth: 0.22,
  drift: 0.05,
  rise: 0.07,

  /**
   * Head dust: a second cloud seeded in a ring around the face so the dust spreads around the
   * head too, plus a downward plume that trails toward the shoulders. Positions are seeded at
   * 0.55–1.0 of the face radius, then pushed out by `spread`. `headDustTail` is how far the plume
   * hangs below the face centre as a fraction of the face radius, and `headDustTailWidth` its
   * half-width at the tip (also a fraction of the radius), so the head reads as connected to the
   * body.
   */
  headDustCount: 260,
  headDustSpread: 1.5,
  headDustSize: 5,
  headDustOpacity: 0.5,
  headDustDrift: 0.15,
  headDustRise: 0.06,
  headDustColor: 0x8fb4e0,
  headDustTail: 0.4,
  headDustTailWidth: 0.7,

  /** Opacity ramp time constants (seconds) for appearing and dissolving. */
  appearTau: 0.5,
  disappearTau: 0.7,

  /**
   * Face dust: a filled point cloud seeded across the face mesh, drifting like the torso dust and
   * carved around the eyes/nose/mouth. `faceCarveSoftness` is the world-unit falloff at a carved
   * feature's edge (0 = hard cut), so the empty shapes read as soft voids rather than stamps.
   */
  faceDustCount: 750,
  faceDustSize: 4.25,
  faceDustOpacity: 0.55,
  faceDustDrift: 0.015,
  faceDustRise: 0.006,
  faceCarveSoftness: 0.005,

  /** How far in front of the torso the face sits. */
  faceDepth: 0.06,

  /**
   * Figure scale: a uniform multiplier on the whole persona (torso, face, hands and halo) and on
   * the dust point sizes. 1 sizes the figure to the frame; <1 shrinks it, >1 grows it.
   *
   * Currently set for the landscape monitor (1). A portrait panel needed ~2.5 with 'contain'.
   */
  scale: 1.4,

  /**
   * How the normalised camera frame maps onto the mirror frame:
   *   - 'fill' maps x/y straight onto the frame (stretches to fit) — the landscape behaviour;
   *   - 'contain' keeps the camera's aspect, so the figure is never stretched; it fits inside
   *     the frame and is letterboxed on the long axis. Required for a portrait monitor.
   *
   * Currently the landscape monitor, so 'fill'. Switch to 'contain' (and raise `scale`) when a
   * portrait panel is back.
   */
  aspectFit: 'fill',
}
