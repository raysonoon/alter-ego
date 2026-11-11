# alter-ego

An interactive, automated "Magic Mirror" escape room prop
* **Hardware & Optics:** A fully assembled Philips 234E5QHAB 23" LCD monitor framed with a 5mm black foam board light-mask and clamped between a clear acrylic back plate and a front acrylic sheet coated with 15% VLT silver mirror film using M3 bolts/standoffs. A light-shrouded USB webcam is mounted behind the acrylic at the top.
* **System Architecture:** The app runs externally on my laptop (external processing power). The screen background is pure black (#000000) so bright white/neon Three.js visuals drown out reflections while black areas act as a physical mirror.
* **Core Interaction Loop:** 
  1. IDLE: Mirror mode (black display). Continuous distance tracking via MediaPipe Pose.
  2. APPROACH: Player steps within 2.0m -> the persona fades in as they close the gap, and the LED strip glows a faint cool white that brightens with proximity.
  3. ENTRY: Player reaches within 1.2m -> the persona fully materialises and tracks the player's gaze/head motion; the strip turns blue.
  4. EXIT TRIGGER: Player extends a hand toward the mirror (fingers pointing at the camera) and holds it still, detected from hand landmarks via MediaPipe -> Triggers a glass-break visual, Nietzsche quote, and voiceover audio.

## Dependencies
- three.js
- MediaPipe Task Vision

## File Structure
The `vision/` layer is implemented (`camera.js`, `pose.js`, `gesture.js`, `face.js`, plus
`fileset.js` for the shared WASM runtime) along with `config.js` and the `state.js` state
machine. The `scene/` layer now renders the persona: `renderer.js` owns the black canvas and an
orthographic camera, and `persona.js` draws the wispy shoulder→hip dust silhouette plus a
filled face-dust cloud carved around the eyes, nose and mouth. `main.js` boots the
models and drives the persona from the state machine. `audio/` is still to be written. Each
concern — vision, state machine, scene, audio — lives in its own folder so the interaction
loop can be traced from one file to the next.

```
alter-ego/
├── index.html                  # single entry page, pure-black background
├── public/                     # served at web root (/models, /wasm)
│   ├── models/                 # vendored MediaPipe task files
│   │   ├── pose_landmarker_lite.task
│   │   ├── gesture_recognizer.task
│   │   └── face_landmarker.task
│   ├── wasm/                   # vendored tasks-vision WASM runtime
│   └── audio/                  # voiceover clips + Nietzsche quote
├── src/
│   ├── main.js                 # entry: bootstraps the app, wires modules together
│   ├── style.css               # global styles (black page, fullscreen canvas)
│   ├── config.js               # tunables: 1.2m/2.0m thresholds, model paths, timings
│   ├── state.js                # IDLE → APPROACH → ENTRY → EXIT TRIGGER state machine
│   ├── vision/
│   │   ├── camera.js           # getUserMedia setup + video element
│   │   ├── fileset.js          # shared tasks-vision WASM runtime, loaded once
│   │   ├── pose.js             # PoseLandmarker + personDistance (metres to camera)
│   │   ├── gesture.js          # GestureRecognizer + EXTEND_HAND (closeness/depth/stillness) trigger
│   │   └── face.js             # FaceLandmarker + tesselation and carve regions
│   ├── dev/
│   │   └── stateHarness.js     # camera-free state-machine verification (scripted timelines)
│   ├── scene/
│   │   ├── renderer.js         # Three.js renderer, orthographic camera, resize
│   │   ├── persona.js          # shoulder→hip dust + carved face dust + hand/head dust
│   │   └── effects/
│   │       └── glassBreak.js   # glass-break visual effect (not written yet)
│   └── audio/
│       └── voiceover.js        # audio playback for the exit trigger
└── diagrams/
    └── alter_ego_system_diagram.jpg
```

Notes:
- Model and WASM paths are absolute (`/models/...`, `/wasm`) because Vite serves `public/`
  at the web root; keep the vendored copies so the prop runs offline.
- `state.js` is the spine of the Core Interaction Loop — it reads `vision/` readings each frame
  and returns edge events (`enterApproach`, `enterEntry`, `enterExit`, `enterIdle`) that `scene/`
  and `audio/` will hang off. It is pure (no DOM, no MediaPipe, no Three.js), which is what lets
  `dev/stateHarness.js` verify it without a camera.
- `scene/persona.js` maps normalised landmarks onto an orthographic frame (flipped horizontally
  to line up with the mirror) and fades in across APPROACH, fully present outside IDLE: a
  shoulder→hip dust cloud forms the torso silhouette, and a drifting face-dust cloud is carved
  around the eyes, nose and mouth in front of it. All colours, opacity, drift and ramp timings
  live in `PERSONA` in `config.js`.
- The extend-hand trigger needs only a minority of fingers (≥ `EXTEND_HAND.minPointingFingers`)
  to read as foreshortened, not a large global z-spread, because the per-landmark z is the
  noisiest MediaPipe output under bright light. Camera exposure is locked at boot
  (`CAMERA.lockExposure`) and the strip is capped during tracking (`LED.trackingMaxBrightness`)
  so bright LEDs cannot wash out the hand. If tracking still drops, lower the cap and re-tune
  `CAMERA.exposureTime` using the range logged to the console at boot.
- Keep the page background pure black (`#000000`); no HTML chrome around the canvas.