## TODO

### Week 1
- [x] Check school materials
- [x] Disassemble monitor
  - [x] Measure monitor size
- [x] Order materials
- [x] Set up MediaPipe
  - [x] Track user's nose/shoulders
  - [x] Track distance between user and camera
- [x] State machine logic

### Week 2
- [x] Laser cut acrylic
  - [x] Measure dimensions
  - [x] Measure holes
- [x] Apply mirror film
- [x] Cut foam board
- [ ] Align components and Assemble
- [ ] Three.js persona
  - [ ] Fine tune face parameters
  - [ ] Tune torso parameters
- [x] Gaze tracking

```
  faceOpacity: 0.02 (keep really low 0.00 - 0.03)

  // these 4 not important now
  faceSubdiv: 3,
  facePointSize: 5,
  faceJitter: 0.008,
  facePointAlpha: 0.6,

  /**
   * Face surface: the tesselated face mesh, dissolved by procedural noise so it vanishes piece
   * by piece. `faceDissolve` is the burn threshold at full opacity, `faceDissolveAtZero` at
   * zero opacity (higher = more holes while materialising/dissolving).
   */
  faceSurfaceOpacity: keep in the middle e.g. 0.600 - 0.700
  faceDissolve: 0.2, // keeep low 0.1 - 0.2
  faceDissolveAtZero: 1,
  faceDissolveSoftness: 0.3, // keep low middle 0.4 - 0.5
  faceNoiseScale: 3.5, // keep low 2.5 - 3
  faceNoiseSpeed: 0.06, // keep low for moving effect 0.1 - 0.2
  /** Fraction of the face radius that stays solid before the edge fade begins (0–1). */
  faceFadeStart: 0.3, // keep in middle 0.5 - 0.6

  /** How far in front of the torso the face sits. */
  faceDepth: 0.06, // not important now
```

### Week 3
- [ ] Gesture trigger
  > Test false positive for exit trigger: use pose and/or finger pointing
- [ ] Calibrate distance (focalFactor)
- [ ] Glass break effect
- [ ] Voiceover
- [ ] Nietzsche quote

### Week 4
- [ ] Prep submission stuff
- [ ] Test
- [ ] Bonus: lighting & microcontroller

