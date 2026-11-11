# AGENTS.md

## What this is
Interactive "Magic Mirror" escape-room prop. A black-background web page renders Three.js
visuals on a monitor behind mirrored acrylic; the app runs on an external laptop driving
the monitor plus a USB webcam (see `README.md`).

Interaction loop (IDLE → APPROACH → EXIT TRIGGER) and hardware/optics details live in
`README.md`; the week-by-week plan is in `TODO.md`.

## Current state — read before editing `src/`
- The `vision/` layer is built: `camera.js` (getUserMedia), `pose.js` (PoseLandmarker plus
  `personDistance`, the metres-to-camera estimate), `gesture.js` (GestureRecognizer + the
  EXTEND_HAND trigger), `face.js` (FaceLandmarker plus the face tesselation and carve regions),
  and `fileset.js`,
  which shares one WASM runtime across all three models instead of letting each instantiate its
  own copy. Tunables live in `src/config.js` (`POSE`, `GESTURE`, `FACE`, `PERSONA`).
- `src/state.js` holds the IDLE → APPROACH → EXIT state machine. It is pure and
  framework-free: it reads a distance, an extend-hand boolean and a timestamp per frame and
  returns the state plus edge events, so it is verified with no camera by
  `src/dev/stateHarness.js`, which replays scripted input timelines and prints a PASS/FAIL
  report to the console under `npm run dev`.
- `src/main.js` boots the camera + the pose, gesture and face models, wires the pose distance
  and the extend-hand trigger into the state machine, and drives the scene each frame.
- The `scene/` layer is built: `renderer.js` owns the black canvas and an orthographic camera
  aligned to the mirror; `persona.js` renders the wispy, dusty figure — a curved, waist-pinched
  shoulder→hip dust cloud, a filled face-dust cloud carved around the eyes/nose/mouth, and a
  head-dust halo with a downward plume that trails toward the shoulders — and
  only shows outside IDLE. It consumes normalised landmarks only (flipped horizontally to
  match the mirror) and is tuned through `PERSONA` in `src/config.js`. `src/audio/` and
  `scene/effects/glassBreak.js` are still to be written and will hang off the state machine's
  events.
- Single-package Vite app, no framework. `src/main.js` is the entry (referenced by
  `index.html`); styles live in `src/style.css`.

## Commands
- `npm run dev` — Vite dev server. Open via `localhost` (see secure-context note below).
- `npm run build` — build to `dist/`.
- `npm run preview` — serve the built output.
- No tests, lint, or typecheck are configured. Do not invent those commands.
- Node requirement from Vite 8: `^20.19.0 || >=22.12.0`.

## MediaPipe / assets (non-obvious)
Model and runtime files are vendored locally so the prop works offline:
- `public/models/pose_landmarker_lite.task`, `public/models/gesture_recognizer.task`,
  `public/models/face_landmarker.task`
- `public/wasm/vision_wasm_*` — the MediaPipe tasks-vision WASM runtime

Load these local copies instead of the usual CDN URLs, e.g.
`FilesetResolver.forVisionTasks('/wasm')` and
`modelAssetPath: '/models/pose_landmarker_lite.task'`. Vite serves `public/` at the web root,
so the paths are absolute `/models/...` and `/wasm`.

Camera access (`getUserMedia`) requires a secure context: use `localhost` in dev, or HTTPS.

## Conventions
- ESM only (`"type": "module"` in `package.json`).
- Keep the page background pure black (`#000000`): black reads as the physical mirror, while
  bright/neon visuals mask reflections. Don't add a light background or chrome around the scene.
