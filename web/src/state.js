import { APPROACH } from './config.js'

/** The Core Interaction Loop's states. */
export const STATE = {
  IDLE: 'IDLE',
  APPROACH: 'APPROACH',
  ENTRY: 'ENTRY',
  EXIT: 'EXIT',
}

/**
 * Edge events, emitted on the single frame a transition happens.
 *
 * The state machine never reaches into scene/ or audio/; it returns these and the caller maps
 * each one to the visual or sound it should start. That keeps the loop's timing testable with
 * no browser and no rendering.
 */
export const EVENT = {
  ENTER_APPROACH: 'enterApproach',
  ENTER_ENTRY: 'enterEntry',
  ENTER_EXIT: 'enterExit',
  ENTER_IDLE: 'enterIdle',
}

/**
 * The IDLE → APPROACH → ENTRY → EXIT TRIGGER loop.
 *
 * Pure and framework-free, like the extend-hand detector: it reads only a distance, a boolean
 * and a timestamp each frame and returns the new state plus any edge events, so it can be
 * driven by the live camera or by a scripted input sequence with no camera at all.
 *
 * The ladder has two distance zones. APPROACH is the outer band — the player is within
 * `approachThreshold` but still more than `entryThreshold` away — and is the "someone is coming"
 * cue. ENTRY is the inner zone (within `entryThreshold`), where the player counts as present at
 * the mirror and the previous ≤1.2 m logic lives: the persona materialises and the extend-hand
 * trigger fires the EXIT.
 *
 * This is where the loop's *policy* lives — the distance thresholds and their hysteresis, how
 * long a range change must hold, how long the player must be gone before the mirror resets —
 * while vision/ only reports raw readings and geometry.
 *
 * EXIT latches: once the extend-hand trigger fires, the state holds however the distance
 * changes, and resets to IDLE only when the player leaves the frame. IDLE ignores extend-hand
 * events entirely, and ENTRY only fires on the frame the trigger arrives.
 *
 * @param {typeof APPROACH} [config]
 */
export function createStateMachine(config = APPROACH) {
  const approachEnter = config.approachThreshold
  const approachLeave = config.approachThreshold + config.hysteresis
  const entryEnter = config.entryThreshold
  const entryLeave = config.entryThreshold + config.hysteresis

  let state = STATE.IDLE
  let approachRangeSince = null
  let entryRangeSince = null
  let approachLeaveSince = null
  let entryLeaveSince = null
  let missingSince = null

  const enterEvent = {
    [STATE.APPROACH]: EVENT.ENTER_APPROACH,
    [STATE.ENTRY]: EVENT.ENTER_ENTRY,
    [STATE.EXIT]: EVENT.ENTER_EXIT,
    [STATE.IDLE]: EVENT.ENTER_IDLE,
  }

  const clearTimers = () => {
    approachRangeSince = null
    entryRangeSince = null
    approachLeaveSince = null
    entryLeaveSince = null
    missingSince = null
  }

  const transitionTo = (next, events) => {
    state = next
    // The frame that caused the transition must not also start the next state's timers.
    clearTimers()
    events.push(enterEvent[next])
  }

  /**
   * @param {{ distance: number|null, extendHand: boolean, timestamp: number }} input
   *   `distance` is metres from the camera, or `null` when no reading is available.
   * @returns {{ state: string, events: string[] }}
   */
  function update({ distance, extendHand, timestamp }) {
    const events = []
    const hasPerson = distance != null

    if (state === STATE.IDLE) {
      if (!hasPerson) {
        approachRangeSince = null
        entryRangeSince = null
      } else if (distance <= entryEnter) {
        // A player already inside ENTRY (e.g. at boot) enters it directly, keeping the old
        // ≤1.2 m responsiveness instead of detouring through APPROACH first.
        approachRangeSince = null
        entryRangeSince ??= timestamp
        if (timestamp - entryRangeSince >= config.debounceMs) transitionTo(STATE.ENTRY, events)
      } else if (distance <= approachEnter) {
        entryRangeSince = null
        approachRangeSince ??= timestamp
        if (timestamp - approachRangeSince >= config.debounceMs) transitionTo(STATE.APPROACH, events)
      } else {
        approachRangeSince = null
        entryRangeSince = null
      }
    } else if (state === STATE.APPROACH) {
      if (!hasPerson) {
        missingSince ??= timestamp
        if (timestamp - missingSince >= config.lostMs) transitionTo(STATE.IDLE, events)
      } else {
        missingSince = null
        if (distance <= entryEnter) {
          entryRangeSince ??= timestamp
          if (timestamp - entryRangeSince >= config.debounceMs) transitionTo(STATE.ENTRY, events)
        } else {
          entryRangeSince = null
          if (distance > approachLeave) {
            approachLeaveSince ??= timestamp
            if (timestamp - approachLeaveSince >= config.debounceMs) transitionTo(STATE.IDLE, events)
          } else {
            approachLeaveSince = null
          }
        }
      }
    } else if (state === STATE.ENTRY) {
      if (extendHand) {
        transitionTo(STATE.EXIT, events)
      } else if (!hasPerson) {
        missingSince ??= timestamp
        if (timestamp - missingSince >= config.lostMs) transitionTo(STATE.IDLE, events)
      } else {
        missingSince = null
        if (distance > entryLeave) {
          entryLeaveSince ??= timestamp
          if (timestamp - entryLeaveSince >= config.debounceMs) transitionTo(STATE.APPROACH, events)
        } else {
          entryLeaveSince = null
        }
      }
    } else if (state === STATE.EXIT) {
      if (hasPerson) {
        missingSince = null
      } else {
        missingSince ??= timestamp
        if (timestamp - missingSince >= config.lostMs) transitionTo(STATE.IDLE, events)
      }
    }

    return { state, events }
  }

  return {
    update,
    get state() {
      return state
    },
    reset() {
      state = STATE.IDLE
      clearTimers()
    },
  }
}
