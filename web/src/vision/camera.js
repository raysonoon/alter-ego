import { CAMERA } from '../config.js'

/**
 * Lock the video track's exposure to the value the camera chose under the current ambient light,
 * so the LED strip lighting up cannot make the auto-exposure swing and wash out the hand mid
 * reach. Chromium exposes this through the track's capabilities; webcams without manual exposure
 * silently keep their auto settings, so the mirror is never blocked by a failed lock.
 *
 * @param {MediaStreamTrack | undefined} track
 */
async function lockExposure(track) {
  const capabilities = track?.getCapabilities?.()
  if (!capabilities?.exposureMode?.includes('manual')) return

  const range = capabilities.exposureTime
  const desired = CAMERA.exposureTime ?? track.getSettings?.().exposureTime
  const exposureTime = range
    ? Math.min(range.max, Math.max(range.min, desired ?? (range.min + range.max) / 2))
    : desired

  try {
    await track.applyConstraints({
      advanced: [{ exposureMode: 'manual', ...(exposureTime != null ? { exposureTime } : {}) }],
    })
    if (range) console.info('Camera exposure locked', { exposureTime, range })
  } catch (error) {
    console.warn('Camera exposure lock failed; auto-exposure stays on.', error)
  }
}

/**
 * Requests the USB webcam and returns a playing, hidden <video> ready to feed the
 * MediaPipe landmarkers.
 *
 * `getUserMedia` only exists in a secure context, so in dev this must be opened via
 * `localhost` rather than a LAN IP, otherwise the call below throws before touching
 * the camera at all.
 */
export async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      'Camera unavailable: getUserMedia requires a secure context. Open the dev server via localhost, not a LAN IP.',
    )
  }

  const video = document.createElement('video')
  video.playsInline = true
  video.muted = true
  video.autoplay = true
  video.setAttribute('aria-hidden', 'true')
  video.className = CAMERA.preview ? 'camera-feed camera-feed--preview' : 'camera-feed'

  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: CAMERA.width },
      height: { ideal: CAMERA.height },
      facingMode: CAMERA.facingMode,
    },
    audio: false,
  })

  // Lock exposure before the LED ramp can brighten the scene, so the reading the camera settled
  // on under ambient light is the one it keeps while the player is at the mirror.
  if (CAMERA.lockExposure) await lockExposure(stream.getVideoTracks()[0])

  const ready = new Promise((resolve, reject) => {
    video.addEventListener('loadeddata', resolve, { once: true })
    video.addEventListener(
      'error',
      () => reject(new Error('Camera stream failed to load.')),
      { once: true },
    )
  })

  video.srcObject = stream
  document.querySelector('#app').append(video)

  try {
    await ready
    await video.play()
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop())
    video.remove()
    throw error
  }

  return {
    video,
    stop() {
      stream.getTracks().forEach((track) => track.stop())
      video.remove()
    },
  }
}
