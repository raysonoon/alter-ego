import { STORY } from '../config.js'
import { EVENT, STATE } from '../state.js'

const clamp01 = (value) => Math.min(1, Math.max(0, value))

/** Smoothstep, so fades ease in/out instead of ramping linearly. */
function smooth(value) {
  const t = clamp01(value)
  return t * t * (3 - 2 * t)
}

/**
 * Story director: walks the scripted narration/sound sequence on top of the state machine.
 *
 * It owns the current step, the narration offset that lets the story resume after the player
 * steps away, the EXIT quote timeline, and the lip-sync mouth envelope. It never touches the
 * state machine's thresholds — it only reacts to the edge events the machine already emits.
 *
 * Timeline (see `config.STORY`):
 *   1 APPROACH  bed drone
 *   2 ENTRY     bed sub-bass + act_1
 *   3 ENTRY     bed rumble  + act_2   (auto-advances `narrationGap` s after act_1 ends)
 *   4 ENTRY     bed rumble  + act_3 + "reach out" prompt (shown at `promptAt`)
 *   5 EXIT      rumble + quote/crack/title timeline, triggered by the extend-hand EXIT
 *
 * Stepping back from ENTRY to APPROACH crossfades the current act into `running_away` and saves
 * the act's playback position; returning to ENTRY resumes it exactly where it stopped. Leaving
 * the frame mid-story leaves the act parked (resume later); leaving after a completed EXIT resets
 * the whole story to step 1 for the next player.
 *
 * @param {{ audio: object, text: object, glass: object, config?: typeof STORY }} options
 */
export function createDirector({ audio, text, glass, config = STORY }) {
  let step = 1
  let bedKey = null
  let narrationKey = null
  let runningAway = false
  let mouthOpen = 0
  let lastTimestamp = null
  let promptOpacity = 0
  /** Seconds elapsed since the current act finished, for the gap before the next one. */
  let gapElapsed = 0

  let exitStartedAt = null
  let suctionFired = false
  let shatterFired = false
  let personaShattered = false

  const stepConfig = (n) => config.steps[n - 1] ?? {}
  const bedFor = (n) => stepConfig(n).bed ?? null
  const narrationFor = (n) => stepConfig(n).narration ?? null
  const promptFor = (n) => stepConfig(n).prompt ?? null

  /** Crossfade the looping bed to `key` (no-op when it is already the live bed). */
  function setBed(key, fade) {
    if (key === bedKey && audio.isPlaying(key)) return
    if (bedKey && bedKey !== key) audio.pause(bedKey, { fadeOut: fade })
    if (key) audio.play(key, { bus: 'sfx', loop: true, fadeIn: fade, volume: config.levels.bed })
    bedKey = key
  }

  /** Crossfade the active narration to `key`; `null` just fades the current one out. */
  function setNarration(key, fade) {
    if (narrationKey && narrationKey !== key) audio.pause(narrationKey, { fadeOut: fade })
    if (key) {
      audio.play(key, {
        bus: 'speech',
        loop: false,
        fadeIn: fade,
        volume: config.levels.narration,
      })
    }
    narrationKey = key
  }

  function resumeNarration(fade) {
    if (!narrationKey) return
    // A finished act stays finished; only a mid-act pause has a position worth resuming.
    if (audio.hasEnded(narrationKey)) return
    audio.resume(narrationKey, { fadeIn: fade, volume: config.levels.narration })
  }

  /**
   * Reveal the step's prompt when its narration reaches `promptAt` (the word "behind" in act_3),
   * then ease it in over `config.fade.prompt`. Ran every frame, so a parked story that resumes
   * past the offset fades in immediately instead of waiting for the word again.
   */
  function updatePrompt(dt, state) {
    const prompt = promptFor(step)
    if (!prompt || state !== STATE.ENTRY || runningAway) {
      promptOpacity = 0
      return
    }

    const at = stepConfig(step).promptAt ?? 0
    const played = narrationKey ? audio.position(narrationKey) : 0
    if (played < at) {
      promptOpacity = 0
      return
    }

    const fade = config.fade.prompt
    promptOpacity = fade > 0 ? Math.min(1, promptOpacity + dt / fade) : 1
    text.setPrimary(prompt, smooth(promptOpacity) * 0.95, { prompt: true })
  }

  /** Jump to a step, swapping the bed and narration with a crossfade. */
  function enterStep(n, { fade = config.fade.narration } = {}) {
    step = n
    const bed = bedFor(n)
    if (bed) setBed(bed, config.fade.bed)
    setNarration(narrationFor(n), fade)
    text.clear()
    promptOpacity = 0
    gapElapsed = 0
  }

  /**
   * Advance 2 → 3 → 4 once the current act has finished and `config.narrationGap` seconds of
   * silence have passed. Measuring the gap in whole frames keeps the pause independent of the
   * clip's duration (and of file metadata arriving late).
   */
  function maybeAdvance(dt) {
    if (step < 2 || step > 3) return // step 4 waits for the EXIT trigger
    const key = narrationFor(step)
    if (!key) return

    const remaining = audio.timeRemaining(key)
    const finished = audio.hasEnded(key) || (remaining != null && remaining <= 0)
    if (!finished) {
      gapElapsed = 0
      return
    }

    gapElapsed += dt
    if (gapElapsed >= (config.narrationGap ?? 0)) {
      enterStep(step + 1, { fade: config.fade.narration })
    }
  }

  function startExit(timestamp) {
    step = 5
    exitStartedAt = timestamp
    suctionFired = false
    shatterFired = false
    personaShattered = false

    if (narrationKey) {
      audio.stop(narrationKey, { fadeOut: config.fade.duck })
      narrationKey = null
    }
    if (runningAway) {
      audio.stop(config.runningAway, { fadeOut: config.fade.duck })
      runningAway = false
    }
    setBed(bedFor(5), config.fade.bed)
    text.clear()
    promptOpacity = 0
  }

  /** Drive the quote/crack/title timeline, in seconds from the EXIT frame. */
  function updateExit(timestamp) {
    const quote = config.quote
    const t = (timestamp - exitStartedAt) / 1000

    const fadeOut = 1 - smooth((t - quote.fadeOutAt) / quote.fadeOutDur)
    const lineA = smooth((t - quote.lineAAt) / quote.lineDur) * fadeOut
    const lineB = smooth((t - quote.lineBAt) / quote.lineDur) * fadeOut

    text.setPrimary(quote.lineA, clamp01(lineA), { prompt: false })
    text.setSecondary(quote.lineB, clamp01(lineB))

    // Suction first: the persona stops tracking and is pulled away, then the mirror breaks.
    if (!suctionFired && t >= quote.suctionAt) {
      suctionFired = true
      personaShattered = true
      audio.play(config.suction, { bus: 'sfx', volume: config.levels.sfx, fadeIn: 0 })
    }

    // Crack + shatter land as the suction finishes and the final "you" is on screen.
    if (!shatterFired && t >= quote.crackAt) {
      shatterFired = true
      glass.trigger({ x: 0, y: 0 })
      audio.play(config.shatter, { bus: 'sfx', volume: config.levels.sfx, fadeIn: 0 })
    }

    text.setTitle(quote.title, clamp01(smooth((t - quote.titleAt) / quote.titleDur)))
  }

  /** Loudness → jaw opening envelope for the persona's carved mouth. */
  function updateMouth(dt) {
    const target = Math.min(config.mouth.max, audio.getSpeechLevel() * config.mouth.gain)
    const tau = target > mouthOpen ? config.mouth.attack : config.mouth.release
    if (dt > 0) mouthOpen += (target - mouthOpen) * (1 - Math.exp(-dt / tau))
    else mouthOpen = target
    if (mouthOpen < 0.001) mouthOpen = 0
  }

  /**
   * @param {{ state: string, events: string[], timestamp: number }} frame
   *   the state machine's output for this frame plus the frame clock (ms).
   */
  function update({ state, events, timestamp }) {
    const dt = lastTimestamp == null ? 0 : Math.min((timestamp - lastTimestamp) / 1000, 0.25)
    lastTimestamp = timestamp
    const has = (event) => events.includes(event)

    // Leaving the frame: a completed EXIT resets the whole story; otherwise park it to resume.
    if (has(EVENT.ENTER_IDLE)) {
      if (step === 5) {
        reset()
      } else {
        if (narrationKey) audio.pause(narrationKey, { fadeOut: config.fade.duck })
        if (runningAway) audio.pause(config.runningAway, { fadeOut: config.fade.duck })
        if (bedKey) audio.pause(bedKey, { fadeOut: config.fade.duck })
        runningAway = false
        text.clear()
      }
    }

    // Stepping back from ENTRY to APPROACH mid-story: save the act, play the running-away line.
    if (has(EVENT.ENTER_APPROACH)) {
      if (step === 1) {
        setBed(bedFor(1), config.fade.bed)
      } else {
        runningAway = true
        if (narrationKey) audio.pause(narrationKey, { fadeOut: config.fade.duck })
        setBed(bedFor(1), config.fade.bed)
        audio.play(config.runningAway, {
          bus: 'speech',
          fadeIn: config.fade.runningAway,
          volume: config.levels.narration,
        })
        text.clear()
      }
    }

    // Returning to ENTRY: start the story, or resume where it was left.
    if (has(EVENT.ENTER_ENTRY)) {
      if (step === 1) {
        enterStep(2, { fade: config.fade.narration })
      } else if (runningAway) {
        runningAway = false
        audio.pause(config.runningAway, { fadeOut: config.fade.runningAway })
        setBed(bedFor(step), config.fade.bed)
        resumeNarration(config.fade.narration)
      }
    }

    // The extend-hand trigger fires EXIT; open the climax.
    if (has(EVENT.ENTER_EXIT)) {
      startExit(timestamp)
    }

    // Auto-advance the ENTRY narration unless the player has stepped away.
    if (state === STATE.ENTRY && !runningAway && step >= 2 && step <= 3) {
      maybeAdvance(dt)
    }

    updatePrompt(dt, state)

    if (step === 5 && exitStartedAt != null) {
      updateExit(timestamp)
    }

    updateMouth(dt)
  }

  /** Stop everything and return to step 1 (after a completed EXIT the player has left). */
  function reset() {
    if (narrationKey) audio.stop(narrationKey, { fadeOut: config.fade.duck })
    if (runningAway) audio.stop(config.runningAway, { fadeOut: config.fade.duck })
    if (bedKey) audio.stop(bedKey, { fadeOut: config.fade.duck })

    narrationKey = null
    bedKey = null
    runningAway = false
    exitStartedAt = null
    suctionFired = false
    shatterFired = false
    personaShattered = false
    step = 1
    mouthOpen = 0
    promptOpacity = 0
    gapElapsed = 0
    text.clear()
    glass.reset?.()
  }

  return {
    update,
    reset,
    get step() {
      return step
    },
    get mouthOpen() {
      return mouthOpen
    },
    get runningAway() {
      return runningAway
    },
    /** True from the suction beat until the story resets; drives the persona dismissal. */
    get shattered() {
      return personaShattered
    },
  }
}
