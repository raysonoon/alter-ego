import { APPROACH } from '../config.js'
import { createStateMachine, EVENT, STATE } from '../state.js'

/**
 * Camera-free verification of the state machine.
 *
 * There is no test runner in this project, so this stands in for one at the logic layer: the
 * machine is pure, so each scenario is just a timeline of `{ t, distance, extendHand }` inputs
 * with the `state` — and, on transition frames, the `expectEvent` — expected afterwards.
 * `main.js` runs it under `npm run dev` and prints the report to the console; the live readout
 * covers the camera side.
 *
 * The timestamps assume the `APPROACH` config's `debounceMs` and `lostMs` are 400.
 */
const scenarios = [
  {
    name: 'happy path: approach, extend, then leaving the frame resets',
    steps: [
      { t: 0, distance: 3.0, extendHand: false, expect: STATE.IDLE },
      { t: 100, distance: 1.2, extendHand: false, expect: STATE.IDLE }, // inside, but not yet debounced
      { t: 500, distance: 1.2, extendHand: false, expect: STATE.APPROACH, expectEvent: EVENT.ENTER_APPROACH },
      { t: 600, distance: 1.2, extendHand: true, expect: STATE.EXIT, expectEvent: EVENT.ENTER_EXIT },
      { t: 2000, distance: 1.2, extendHand: false, expect: STATE.EXIT }, // holds while present
      { t: 2100, distance: 3.0, extendHand: false, expect: STATE.EXIT }, // distance alone does not reset
      { t: 2200, distance: 1.2, extendHand: false, expect: STATE.EXIT },
      { t: 2600, distance: null, extendHand: false, expect: STATE.EXIT }, // lost, timer starts
      { t: 2900, distance: null, extendHand: false, expect: STATE.EXIT }, // within lostMs
      { t: 3100, distance: null, extendHand: false, expect: STATE.IDLE, expectEvent: EVENT.ENTER_IDLE },
    ],
  },
  {
    name: 'extend-hand is ignored until the player has approached',
    steps: [
      { t: 0, distance: 3.0, extendHand: true, expect: STATE.IDLE }, // far: ignored
      { t: 100, distance: 3.0, extendHand: true, expect: STATE.IDLE },
      { t: 1000, distance: 1.2, extendHand: true, expect: STATE.IDLE }, // in range, debounce unmet
      { t: 1500, distance: 1.2, extendHand: true, expect: STATE.APPROACH, expectEvent: EVENT.ENTER_APPROACH },
      { t: 1600, distance: 1.2, extendHand: true, expect: STATE.EXIT, expectEvent: EVENT.ENTER_EXIT },
    ],
  },
  {
    name: 'hysteresis stops flicker around the threshold',
    steps: [
      { t: 0, distance: 1.2, extendHand: false, expect: STATE.IDLE },
      { t: 500, distance: 1.2, extendHand: false, expect: STATE.APPROACH },
      { t: 600, distance: 1.6, extendHand: false, expect: STATE.APPROACH }, // above 1.5, below leave line
      { t: 700, distance: 1.45, extendHand: false, expect: STATE.APPROACH },
      { t: 800, distance: 1.55, extendHand: false, expect: STATE.APPROACH },
      { t: 900, distance: 1.7, extendHand: false, expect: STATE.APPROACH }, // still below 1.8
      { t: 1000, distance: 1.9, extendHand: false, expect: STATE.APPROACH }, // leave timer starts
      { t: 1100, distance: 1.6, extendHand: false, expect: STATE.APPROACH }, // dips back: timer cleared
      { t: 1200, distance: 1.9, extendHand: false, expect: STATE.APPROACH }, // restarts
      { t: 1700, distance: 1.9, extendHand: false, expect: STATE.IDLE, expectEvent: EVENT.ENTER_IDLE },
    ],
  },
  {
    name: 'a single dropped pose frame does not reset EXIT',
    steps: [
      { t: 0, distance: 1.2, extendHand: false, expect: STATE.IDLE },
      { t: 500, distance: 1.2, extendHand: false, expect: STATE.APPROACH },
      { t: 600, distance: 1.2, extendHand: true, expect: STATE.EXIT },
      { t: 700, distance: null, extendHand: false, expect: STATE.EXIT }, // missing, timer starts
      { t: 900, distance: 1.2, extendHand: false, expect: STATE.EXIT }, // back within lostMs: cleared
      { t: 1000, distance: null, extendHand: false, expect: STATE.EXIT }, // missing again
      { t: 1300, distance: null, extendHand: false, expect: STATE.EXIT }, // within lostMs
      { t: 1401, distance: null, extendHand: false, expect: STATE.IDLE, expectEvent: EVENT.ENTER_IDLE },
    ],
  },
  {
    name: 'leaving the frame during APPROACH returns to IDLE',
    steps: [
      { t: 0, distance: 1.2, extendHand: false, expect: STATE.IDLE },
      { t: 500, distance: 1.2, extendHand: false, expect: STATE.APPROACH },
      { t: 600, distance: null, extendHand: false, expect: STATE.APPROACH },
      { t: 1100, distance: null, extendHand: false, expect: STATE.IDLE, expectEvent: EVENT.ENTER_IDLE },
    ],
  },
  {
    name: 'an empty frame stays IDLE',
    steps: [
      { t: 0, distance: null, extendHand: false, expect: STATE.IDLE },
      { t: 1000, distance: null, extendHand: false, expect: STATE.IDLE },
    ],
  },
]

/**
 * Runs every scenario against a fresh machine and returns a `{ passed, failed, report }`
 * summary. Pure: safe to call from the browser or a script with no camera.
 */
export function runStateHarness() {
  const blocks = []
  let passed = 0
  let failed = 0

  for (const scenario of scenarios) {
    const machine = createStateMachine(APPROACH)
    const failures = []

    scenario.steps.forEach((step, index) => {
      const { state, events } = machine.update({
        distance: step.distance,
        extendHand: step.extendHand,
        timestamp: step.t,
      })
      if (state !== step.expect) {
        failures.push(`step ${index} t=${step.t}: expected ${step.expect}, got ${state}`)
      } else if (step.expectEvent && !events.includes(step.expectEvent)) {
        failures.push(
          `step ${index} t=${step.t}: expected event ${step.expectEvent}, got [${events.join(', ') || 'none'}]`,
        )
      }
    })

    if (failures.length) {
      failed += 1
      blocks.push(`✗ ${scenario.name}\n${failures.map((line) => `    ${line}`).join('\n')}`)
    } else {
      passed += 1
      blocks.push(`✓ ${scenario.name}`)
    }
  }

  const summary = `state machine harness: ${passed} passed, ${failed} failed`
  return { passed, failed, summary, report: `${summary}\n${blocks.join('\n')}` }
}
