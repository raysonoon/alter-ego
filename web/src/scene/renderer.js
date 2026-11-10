import * as THREE from 'three'

/**
 * Owns the WebGL renderer, the scene and the camera.
 *
 * The camera is orthographic on purpose: the persona has to line up with the player's
 * reflection in the mirror film, and a linear (non-perspective) mapping from normalised
 * landmark coordinates to the frame keeps that alignment exact however the player moves.
 *
 * The frustum is `[-halfWidth, halfWidth] x [-halfHeight, halfHeight]` with the origin at the
 * centre of the mirror. `halfWidth` tracks the window aspect so normalised x and y map at the
 * same scale.
 */
export function createRenderer({ container }) {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  // Black clears to the physical mirror, not to a "background".
  renderer.setClearColor(0x000000, 1)
  renderer.domElement.setAttribute('aria-hidden', 'true')
  container.appendChild(renderer.domElement)

  const scene = new THREE.Scene()

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 20)
  camera.position.z = 5

  /** Mutable view metrics shared with the persona, updated on resize. */
  const view = { halfWidth: 1, halfHeight: 1 }

  function resize() {
    // Clamp to >= 1: a hidden/zero-sized container would otherwise make `aspect` 0/0 (NaN) or
    // n/0 (Infinity), which poisons every landmark → world mapping downstream.
    const width = Math.max(container.clientWidth || window.innerWidth || 1, 1)
    const height = Math.max(container.clientHeight || window.innerHeight || 1, 1)
    const aspect = width / height

    view.halfWidth = Number.isFinite(aspect) ? aspect : 1
    view.halfHeight = 1

    camera.left = -aspect
    camera.right = aspect
    camera.top = 1
    camera.bottom = -1
    camera.updateProjectionMatrix()

    // `false`: the canvas is sized by CSS, so don't let Three write inline styles over it.
    renderer.setSize(width, height, false)
  }

  resize()
  window.addEventListener('resize', resize)

  return {
    renderer,
    scene,
    camera,
    view,
    resize,
    render() {
      renderer.render(scene, camera)
    },
    dispose() {
      window.removeEventListener('resize', resize)
      renderer.dispose()
      renderer.domElement.remove()
    },
  }
}
