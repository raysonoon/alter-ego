# alter-ego

An interactive, automated "Magic Mirror" escape room prop
* **Hardware & Optics:** A fully assembled Philips 234E5QHAB 23" LCD monitor framed with a 5mm black foam board light-mask and clamped between a clear acrylic back plate and a front acrylic sheet coated with 15% VLT silver mirror film using M3 bolts/standoffs. A light-shrouded USB webcam is mounted behind the acrylic at the top.
* **System Architecture:** The app runs externally on my laptop (external processing power). The screen background is pure black (#000000) so bright white/neon Three.js visuals drown out reflections while black areas act as a physical mirror.
* **Core Interaction Loop:** 
  1. IDLE: Mirror mode (black display). Continuous distance tracking via MediaPipe Pose.
  2. APPROACH: Player steps within 1.5m -> Persona materializes in Three.js and tracks player's gaze/head motion.
  3. EXIT TRIGGER: Player extends a hand toward the mirror (fingers pointing at the camera) and holds it still, detected from hand landmarks via MediaPipe -> Triggers a glass-break visual, Nietzsche quote, and voiceover audio.

## Dependencies
- three.js
- MediaPipe Task Vision

## File Structure
The `vision/` layer is implemented (`camera.js`, `pose.js`, `gesture.js`, plus `fileset.js`
for the shared WASM runtime) along with `config.js` and the `state.js` state machine;
`main.js` boots those models, wires them into the state machine, and shows a temporary debug
readout so the loop can be verified. `scene/` and `audio/` are still to be written. Each
concern — vision, state machine, scene, audio — lives in its own folder so the interaction
loop can be traced from one file to the next.

```
alter-ego/
├── index.html                  # single entry page, pure-black background
├── public/                     # served at web root (/models, /wasm)
│   ├── models/                 # vendored MediaPipe task files
│   │   ├── pose_landmarker_lite.task
│   │   └── gesture_recognizer.task
│   ├── wasm/                   # vendored tasks-vision WASM runtime
│   └── audio/                  # voiceover clips + Nietzsche quote
├── src/
│   ├── main.js                 # entry: bootstraps the app, wires modules together
│   ├── style.css               # global styles (black page, fullscreen canvas)
│   ├── config.js               # tunables: 1.5m threshold, model paths, timings
│   ├── state.js                # IDLE → APPROACH → EXIT TRIGGER state machine
│   ├── vision/
│   │   ├── camera.js           # getUserMedia setup + video element
│   │   ├── fileset.js          # shared tasks-vision WASM runtime, loaded once
│   │   ├── pose.js             # PoseLandmarker + personDistance (metres to camera)
│   │   └── gesture.js          # GestureRecognizer + EXTEND_HAND (closeness/depth/stillness) trigger
│   ├── dev/
│   │   └── stateHarness.js     # camera-free state-machine verification (scripted timelines)
│   ├── scene/
│   │   ├── renderer.js         # Three.js renderer, camera, render loop
│   │   ├── persona.js          # the materializing figure + gaze mirroring
│   │   └── effects/
│   │       └── glassBreak.js   # glass-break visual effect
│   └── audio/
│       └── voiceover.js        # audio playback for the exit trigger
└── diagrams/
    └── alter_ego_system_diagram.jpg
```

Notes:
- Model and WASM paths are absolute (`/models/...`, `/wasm`) because Vite serves `public/`
  at the web root; keep the vendored copies so the prop runs offline.
- `state.js` is the spine of the Core Interaction Loop — it reads `vision/` readings each frame
  and returns edge events (`enterApproach`, `enterExit`, `enterIdle`) that `scene/` and
  `audio/` will hang off. It is pure (no DOM, no MediaPipe, no Three.js), which is what lets
  `dev/stateHarness.js` verify it without a camera.
- Keep the page background pure black (`#000000`); no HTML chrome around the canvas.