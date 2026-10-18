import { APPROACH } from './config.js'

/** The Core Interaction Loop's states. */
export const STATE = {
  IDLE: 'IDLE',
  APPROACH: 'APPROACH',
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
  ENTER_EXIT: 'enterExit',
  ENTER_IDLE: 'enterIdle',
}

/**
 * The IDLE → APPROACH → EXIT TRIGGER loop.
 *
 * Pure and framework-free, like the extend-hand detector: it reads only a distance, a boolean
 * and a timestamp each frame and returns the new state plus any edge events, so it can be
 * driven by the live camera or by a scripted input sequence with no camera at all.
 *
 * This is where the loop's *policy* lives — the distance threshold and its hysteresis, how long
 * a range change must hold, how long the player must be gone before the mirror resets — while
 * vision/ only reports raw readings and geometry.
 *
 * EXIT latches: once the extend-hand trigger fires, the state holds however the distance
 * changes, and resets to IDLE only when the player leaves the frame. IDLE ignores extend-hand
 * events entirely, and APPROACH only fires on the frame the trigger arrives.
 *
 * @param {typeof APPROACH} [config]
 */
export function createStateMachine(config = APPROACH) {
  const enterThreshold = config.distanceThreshold
  const leaveThreshold = config.distanceThreshold + config.hysteresis

  let state = STATE.IDLE
  let enterRangeSince = null
  let leaveRangeSince = null
  let missingSince = null

  const enterEvent = {
    [STATE.APPROACH]: EVENT.ENTER_APPROACH,
    [STATE.EXIT]: EVENT.ENTER_EXIT,
    [STATE.IDLE]: EVENT.ENTER_IDLE,
  }

  const clearTimers = () => {
    enterRangeSince = null
    leaveRangeSince = null
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
      if (hasPerson && distance <= enterThreshold) {
        enterRangeSince ??= timestamp
        if (timestamp - enterRangeSince >= config.debounceMs) transitionTo(STATE.APPROACH, events)
      } else {
        enterRangeSince = null
      }
    } else if (state === STATE.APPROACH) {
      if (extendHand) {
        transitionTo(STATE.EXIT, events)
      } else if (!hasPerson) {
        missingSince ??= timestamp
        if (timestamp - missingSince >= config.lostMs) transitionTo(STATE.IDLE, events)
      } else {
        missingSince = null
        if (distance > leaveThreshold) {
          leaveRangeSince ??= timestamp
          if (timestamp - leaveRangeSince >= config.debounceMs) transitionTo(STATE.IDLE, events)
        } else {
          leaveRangeSince = null
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
