import { CAMERA } from '../config.js'

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
