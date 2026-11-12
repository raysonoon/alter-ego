// Story audio, imported through Vite so the prop keeps working offline: the bundler emits
// hashed copies of each clip and these imports resolve to their URLs. Keep the keys stable —
// `config.STORY` refers to clips by these names.

import approachDrone from '../assets/sound_effects/approach-ambient-drone.mp3'
import entrySubBass from '../assets/sound_effects/entry-sub-bass.mp3'
import lowEndRumble from '../assets/sound_effects/low-end-rumble.mp3'
import quickAirSuction from '../assets/sound_effects/quick_air_suction.mp3'
import glassShatter from '../assets/sound_effects/glass_shatter.mp3'

import act1 from '../assets/narration/act_1.mp3'
import act2 from '../assets/narration/act_2.mp3'
import act3 from '../assets/narration/act_3.mp3'
import runningAway from '../assets/narration/running_away.mp3'

/** Every story clip, keyed by the name used in `config.STORY`. */
export const AUDIO_ASSETS = {
  approachDrone,
  entrySubBass,
  lowEndRumble,
  quickAirSuction,
  glassShatter,
  act1,
  act2,
  act3,
  runningAway,
}
