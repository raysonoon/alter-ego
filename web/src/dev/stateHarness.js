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
 * The timestamps assume the `APPROACH` config's `debounceMs` and `lostMs` are 400, with
 * `approachThreshold` 2.0, `entryThreshold` 1.2 and `hysteresis` 0.3 (so APPROACH is left above
 * 2.3 m and ENTRY above 1.5 m).
 */
const scenarios = [
  {
    name: 'happy path: approach, enter, extend, then leaving the frame resets',
    steps: [
      { t: 0, distance: 3.0, extendHand: false, expect: STATE.IDLE },
      { t: 100, distance: 1.8, extendHand: false, expect: STATE.IDLE }, // in range, not yet debounced
      { t: 500, distance: 1.8, extendHand: false, expect: STATE.APPROACH, expectEvent: EVENT.ENTER_APPROACH },
      { t: 600, distance: 1.8, extendHand: false, expect: STATE.APPROACH }, // still the outer band
      { t: 700, distance: 1.0, extendHand: false, expect: STATE.APPROACH }, // entry timer starts
      { t: 1100, distance: 1.0, extendHand: false, expect: STATE.ENTRY, expectEvent: EVENT.ENTER_ENTRY },
      { t: 1200, distance: 1.0, extendHand: true, expect: STATE.EXIT, expectEvent: EVENT.ENTER_EXIT },
      { t: 2000, distance: 1.0, extendHand: false, expect: STATE.EXIT }, // holds while present
      { t: 2100, distance: 3.0, extendHand: false, expect: STATE.EXIT }, // distance alone does not reset
      { t: 2200, distance: 1.0, extendHand: false, expect: STATE.EXIT },
      { t: 2600, distance: null, extendHand: false, expect: STATE.EXIT }, // lost, timer starts
      { t: 2900, distance: null, extendHand: false, expect: STATE.EXIT }, // within lostMs
      { t: 3100, distance: null, extendHand: false, expect: STATE.IDLE, expectEvent: EVENT.ENTER_IDLE },
    ],
  },
  {
    name: 'extend-hand is ignored until the player has entered',
    steps: [
      { t: 0, distance: 3.0, extendHand: true, expect: STATE.IDLE }, // far: ignored
      { t: 1000, distance: 1.8, extendHand: true, expect: STATE.IDLE }, // in range, debounce unmet
      { t: 1400, distance: 1.8, extendHand: true, expect: STATE.APPROACH, expectEvent: EVENT.ENTER_APPROACH }, // ignored in APPROACH
      { t: 1500, distance: 1.8, extendHand: true, expect: STATE.APPROACH },
      { t: 1600, distance: 1.0, extendHand: true, expect: STATE.APPROACH }, // entry timer starts
      { t: 2000, distance: 1.0, extendHand: true, expect: STATE.ENTRY, expectEvent: EVENT.ENTER_ENTRY },
      { t: 2001, distance: 1.0, extendHand: true, expect: STATE.EXIT, expectEvent: EVENT.ENTER_EXIT },
    ],
  },
  {
    name: 'hysteresis stops flicker at the ENTRY and APPROACH boundaries',
    steps: [
      { t: 0, distance: 1.8, extendHand: false, expect: STATE.IDLE },
      { t: 400, distance: 1.8, extendHand: false, expect: STATE.APPROACH, expectEvent: EVENT.ENTER_APPROACH },
      { t: 401, distance: 1.0, extendHand: false, expect: STATE.APPROACH }, // entry timer starts
      { t: 801, distance: 1.0, extendHand: false, expect: STATE.ENTRY, expectEvent: EVENT.ENTER_ENTRY },
      { t: 900, distance: 1.4, extendHand: false, expect: STATE.ENTRY }, // above 1.2, below leave line 1.5
      { t: 1000, distance: 1.6, extendHand: false, expect: STATE.ENTRY }, // leave timer starts
      { t: 1100, distance: 1.4, extendHand: false, expect: STATE.ENTRY }, // dips back: timer cleared
      { t: 1200, distance: 1.6, extendHand: false, expect: STATE.ENTRY }, // restarts
      { t: 1600, distance: 1.6, extendHand: false, expect: STATE.APPROACH, expectEvent: EVENT.ENTER_APPROACH },
      { t: 1700, distance: 2.2, extendHand: false, expect: STATE.APPROACH }, // below leave line 2.3
      { t: 1800, distance: 2.4, extendHand: false, expect: STATE.APPROACH }, // leave timer starts
      { t: 1900, distance: 2.2, extendHand: false, expect: STATE.APPROACH }, // dips back: timer cleared
      { t: 2000, distance: 2.4, extendHand: false, expect: STATE.APPROACH }, // restarts
      { t: 2400, distance: 2.4, extendHand: false, expect: STATE.IDLE, expectEvent: EVENT.ENTER_IDLE },
    ],
  },
  {
    name: 'a player already inside ENTRY enters it directly',
    steps: [
      { t: 0, distance: 1.0, extendHand: false, expect: STATE.IDLE },
      { t: 400, distance: 1.0, extendHand: false, expect: STATE.ENTRY, expectEvent: EVENT.ENTER_ENTRY },
    ],
  },
  {
    name: 'a single dropped pose frame does not reset EXIT',
    steps: [
      { t: 0, distance: 1.8, extendHand: false, expect: STATE.IDLE },
      { t: 400, distance: 1.8, extendHand: false, expect: STATE.APPROACH, expectEvent: EVENT.ENTER_APPROACH },
      { t: 401, distance: 1.0, extendHand: false, expect: STATE.APPROACH },
      { t: 801, distance: 1.0, extendHand: false, expect: STATE.ENTRY, expectEvent: EVENT.ENTER_ENTRY },
      { t: 900, distance: 1.0, extendHand: true, expect: STATE.EXIT, expectEvent: EVENT.ENTER_EXIT },
      { t: 1000, distance: null, extendHand: false, expect: STATE.EXIT }, // missing, timer starts
      { t: 1200, distance: 1.0, extendHand: false, expect: STATE.EXIT }, // back within lostMs: cleared
      { t: 1300, distance: null, extendHand: false, expect: STATE.EXIT }, // missing again
      { t: 1600, distance: null, extendHand: false, expect: STATE.EXIT }, // within lostMs
      { t: 1701, distance: null, extendHand: false, expect: STATE.IDLE, expectEvent: EVENT.ENTER_IDLE },
    ],
  },
  {
    name: 'leaving the frame during APPROACH returns to IDLE',
    steps: [
      { t: 0, distance: 1.8, extendHand: false, expect: STATE.IDLE },
      { t: 400, distance: 1.8, extendHand: false, expect: STATE.APPROACH, expectEvent: EVENT.ENTER_APPROACH },
      { t: 500, distance: null, extendHand: false, expect: STATE.APPROACH },
      { t: 1000, distance: null, extendHand: false, expect: STATE.IDLE, expectEvent: EVENT.ENTER_IDLE },
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
