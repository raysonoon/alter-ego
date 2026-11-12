/**
 * Audio engine: one Web Audio graph shared by the story's narration and sound-effect beds.
 *
 * Two buses keep the layers independent:
 *   - `speech` — narration + the "running away" line. It runs through an AnalyserNode so the
 *     persona's mouth can follow the spoken loudness (lip-sync).
 *   - `sfx`    — ambient beds and one-shot accents. Never feeds the analyser, so a rumble cannot
 *     make the mouth move.
 *
 * Clips are plain `HTMLAudioElement`s (streamed from disk, seekable, pause/resume for free) routed
 * through a per-clip GainNode for fades and crossfades. If Web Audio is unavailable the engine
 * degrades to element `.volume` control, so the prop still speaks.
 *
 * Autoplay policy: a fresh AudioContext starts suspended until a user gesture. `main.js` calls
 * `unlock()` on the first pointerdown/keydown; the camera-permission click or the LED connect
 * button is enough.
 */

const FADE_FLOOR = 0.0001

export function createAudioEngine({ assets }) {
  const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext
  const ctx = AudioCtx ? new AudioCtx() : null

  const clips = new Map()

  let master = null
  let speechBus = null
  let sfxBus = null
  let analyser = null
  let analyserData = null

  if (ctx) {
    master = ctx.createGain()
    master.gain.value = 1
    master.connect(ctx.destination)

    speechBus = ctx.createGain()
    speechBus.gain.value = 1
    analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    analyserData = new Uint8Array(analyser.fftSize)
    speechBus.connect(analyser)
    analyser.connect(master)

    sfxBus = ctx.createGain()
    sfxBus.gain.value = 1
    sfxBus.connect(master)
  }

  function makeClip(key, bus) {
    const elem = new Audio(assets[key])
    elem.preload = 'auto'
    elem.loop = false

    let source = null
    let gain = null
    if (ctx) {
      // A media element can only ever have one MediaElementSourceNode, so create it once here
      // and reuse the element for the whole session.
      source = ctx.createMediaElementSource(elem)
      gain = ctx.createGain()
      gain.gain.value = 0
      source.connect(gain)
      gain.connect(bus === 'speech' ? speechBus : sfxBus)
    }

    return { key, elem, source, gain, bus, pauseTimer: null, volume: 1, intended: false }
  }

  function clip(key, bus = 'sfx') {
    let entry = clips.get(key)
    if (!entry) {
      entry = makeClip(key, bus)
      clips.set(key, entry)
    }
    return entry
  }

  const clock = () => (ctx ? ctx.currentTime : 0)

  function clearPauseTimer(entry) {
    if (entry.pauseTimer != null) {
      clearTimeout(entry.pauseTimer)
      entry.pauseTimer = null
    }
  }

  /** Resume the AudioContext. Safe to call repeatedly; required from a user gesture. */
  async function unlock() {
    if (!ctx) return false
    if (ctx.state !== 'running') {
      try {
        await ctx.resume()
      } catch {
        /* still blocked; the next gesture retries */
      }
    }
    if (ctx.state !== 'running') return false

    // Replay anything a blocked autoplay policy silenced before this gesture.
    for (const entry of clips.values()) {
      if (entry.intended && entry.elem.paused && !entry.elem.ended) {
        try {
          await entry.elem.play()
        } catch {
          /* ignore */
        }
      }
    }
    return true
  }

  /**
   * Start (or restart) a clip and fade it in.
   *
   * @param {string} key asset key
   * @param {{ bus?: 'speech'|'sfx', loop?: boolean, fadeIn?: number, volume?: number, restart?: boolean }} [options]
   */
  async function play(key, { bus = 'sfx', loop = false, fadeIn = 0, volume = 1, restart = false } = {}) {
    if (!assets[key]) {
      console.warn(`audio: no asset named "${key}"`)
      return null
    }

    const entry = clip(key, bus)
    clearPauseTimer(entry)
    entry.volume = volume
    entry.elem.loop = loop
    entry.intended = true

    if (restart) {
      try {
        entry.elem.currentTime = 0
      } catch {
        /* not seekable until metadata arrives */
      }
    }

    if (ctx) {
      await unlock()
      const t = clock()
      const node = entry.gain.gain
      node.cancelScheduledValues(t)
      if (fadeIn > 0) {
        node.setValueAtTime(FADE_FLOOR, t)
        node.linearRampToValueAtTime(volume, t + fadeIn)
      } else {
        node.setValueAtTime(volume, t)
      }
    } else {
      entry.elem.volume = volume
    }

    try {
      await entry.elem.play()
    } catch (error) {
      // AbortError is the normal "a new play() superseded this one" churn; only warn otherwise.
      if (error?.name !== 'AbortError') console.warn(`audio: play("${key}") blocked`, error)
    }
    return entry
  }

  /** Resume a paused clip at its current position, optionally fading in. */
  async function resume(key, { fadeIn = 0, volume } = {}) {
    const entry = clips.get(key)
    if (!entry) return
    clearPauseTimer(entry)
    if (volume != null) entry.volume = volume
    entry.intended = true

    if (ctx) {
      await unlock()
      const t = clock()
      const node = entry.gain.gain
      node.cancelScheduledValues(t)
      if (fadeIn > 0) {
        node.setValueAtTime(FADE_FLOOR, t)
        node.linearRampToValueAtTime(entry.volume, t + fadeIn)
      } else {
        node.setValueAtTime(entry.volume, t)
      }
    } else {
      entry.elem.volume = entry.volume
    }

    try {
      await entry.elem.play()
    } catch {
      /* ignore */
    }
  }

  /** Pause a clip, optionally after a fade-out. The position is kept for a later `resume`. */
  function pause(key, { fadeOut = 0 } = {}) {
    const entry = clips.get(key)
    if (!entry) return
    clearPauseTimer(entry)
    entry.intended = false

    if (ctx && fadeOut > 0) {
      const t = clock()
      const node = entry.gain.gain
      node.cancelScheduledValues(t)
      node.setValueAtTime(Math.max(node.value, FADE_FLOOR), t)
      node.linearRampToValueAtTime(FADE_FLOOR, t + fadeOut)
      entry.pauseTimer = setTimeout(() => {
        entry.pauseTimer = null
        try {
          entry.elem.pause()
        } catch {
          /* ignore */
        }
      }, fadeOut * 1000 + 30)
    } else {
      if (ctx) entry.gain.gain.setValueAtTime(0, clock())
      try {
        entry.elem.pause()
      } catch {
        /* ignore */
      }
    }
  }

  /** Pause and rewind a clip to the start (for a fresh play next time). */
  function stop(key, { fadeOut = 0 } = {}) {
    const entry = clips.get(key)
    if (!entry) return
    pause(key, { fadeOut })
    const rewind = () => {
      try {
        entry.elem.currentTime = 0
      } catch {
        /* ignore */
      }
    }
    if (fadeOut > 0) setTimeout(rewind, fadeOut * 1000 + 60)
    else rewind()
  }

  const hasEnded = (key) => Boolean(clips.get(key)?.elem.ended)
  const isPlaying = (key) => {
    const entry = clips.get(key)
    return Boolean(entry && !entry.elem.paused && !entry.elem.ended)
  }

  /** Seconds played so far, or 0 before the clip has been started. */
  function position(key) {
    const entry = clips.get(key)
    return entry ? entry.elem.currentTime : 0
  }

  /** Seconds left in a clip, or null until its duration is known. */
  function timeRemaining(key) {
    const entry = clips.get(key)
    if (!entry) return null
    const duration = entry.elem.duration
    if (!Number.isFinite(duration) || duration <= 0) return null
    return Math.max(0, duration - entry.elem.currentTime)
  }

  /**
   * RMS of the speech bus, 0–1. Drives lip-sync; it reflects only narration (and the running-away
   * line), never the ambient beds.
   */
  function getSpeechLevel() {
    if (!analyser || !analyserData) return 0
    analyser.getByteTimeDomainData(analyserData)
    let sum = 0
    for (let i = 0; i < analyserData.length; i += 1) {
      const v = (analyserData[i] - 128) / 128
      sum += v * v
    }
    return Math.sqrt(sum / analyserData.length)
  }

  function dispose() {
    for (const entry of clips.values()) {
      clearPauseTimer(entry)
      try {
        entry.elem.pause()
      } catch {
        /* ignore */
      }
      try {
        entry.source?.disconnect()
      } catch {
        /* ignore */
      }
      try {
        entry.gain?.disconnect()
      } catch {
        /* ignore */
      }
      entry.elem.src = ''
    }
    clips.clear()

    try {
      analyser?.disconnect()
    } catch {
      /* ignore */
    }
    try {
      speechBus?.disconnect()
    } catch {
      /* ignore */
    }
    try {
      sfxBus?.disconnect()
    } catch {
      /* ignore */
    }
    try {
      master?.disconnect()
    } catch {
      /* ignore */
    }
    ctx?.close?.().catch?.(() => {})
  }

  return {
    available: Boolean(ctx),
    unlock,
    play,
    resume,
    pause,
    stop,
    hasEnded,
    isPlaying,
    position,
    timeRemaining,
    getSpeechLevel,
    dispose,
  }
}
