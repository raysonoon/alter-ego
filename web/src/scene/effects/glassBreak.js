import * as THREE from 'three'
import { GLASS } from '../../config.js'

/**
 * Glass crack: a screen-space overlay that reads as the mirror itself cracking.
 *
 * On `trigger()` it builds a procedural spider-web of jittered lines radiating from an impact
 * point and a full-frame white flash, then animates them:
 *   - the flash is a sharp pop that decays over `flashMs`;
 *   - the crack lines snap on almost instantly and then stay at full opacity for the rest of the
 *     EXIT beat — the story reset clears them for the next player.
 *
 * It lives in the renderer's orthographic scene (world units match the mirror frame) with
 * `depthTest:false` and a high render order, so it always draws over the persona. It stays a
 * separate layer from the story/title overlay: the "ALTER EGO" title is HTML drawn in front of
 * it, and fading that title never fades the cracks.
 */
export function createGlassBreak({ scene, view, config = GLASS }) {
  const group = new THREE.Group()
  group.visible = false
  group.renderOrder = 100
  scene.add(group)

  let lines = null
  let lineMaterial = null
  let flash = null
  let flashMaterial = null
  let startedAt = null
  let active = false

  function clear() {
    if (lines) {
      group.remove(lines)
      lines.geometry.dispose()
      lines.material.dispose()
      lines = null
      lineMaterial = null
    }
    if (flash) {
      group.remove(flash)
      flash.geometry.dispose()
      flash.material.dispose()
      flash = null
      flashMaterial = null
    }
  }

  function buildCracks(impact) {
    const halfWidth = Math.max(view?.halfWidth ?? 1, 0.1)
    const halfHeight = Math.max(view?.halfHeight ?? 1, 0.1)
    const extent = Math.hypot(halfWidth, halfHeight)

    const count = Math.max(1, config.crackCount)
    const positions = []

    for (let c = 0; c < count; c += 1) {
      // Evenly spread the main cracks, then let each wander so the web is not a perfect star.
      const angle = (c / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.26
      const length = extent * (0.78 + Math.random() * 0.5)
      const steps = 7 + Math.floor(Math.random() * 6)
      const perpX = Math.cos(angle + Math.PI / 2)
      const perpY = Math.sin(angle + Math.PI / 2)

      let x = impact.x
      let y = impact.y
      for (let s = 0; s < steps; s += 1) {
        const t = (s + 1) / steps
        const wobble = (Math.random() - 0.5) * config.jitter * length * t
        const nx = impact.x + Math.cos(angle) * length * t + perpX * wobble
        const ny = impact.y + Math.sin(angle) * length * t + perpY * wobble
        positions.push(x, y, 0, nx, ny, 0)
        x = nx
        y = ny
      }
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))

    lineMaterial = new THREE.LineBasicMaterial({
      color: config.color,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    })

    lines = new THREE.LineSegments(geometry, lineMaterial)
    lines.frustumCulled = false
    lines.renderOrder = 101
    group.add(lines)
  }

  function buildFlash() {
    const halfWidth = Math.max(view?.halfWidth ?? 1, 0.1)
    const halfHeight = Math.max(view?.halfHeight ?? 1, 0.1)

    const geometry = new THREE.PlaneGeometry(halfWidth * 2, halfHeight * 2)
    flashMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    })

    flash = new THREE.Mesh(geometry, flashMaterial)
    flash.position.z = 2
    flash.frustumCulled = false
    flash.renderOrder = 102
    group.add(flash)
  }

  /**
   * @param {{ x?: number, y?: number }} [impact] impact point in mirror-frame world units
   *   (origin = centre of the mirror).
   */
  function trigger({ x = 0, y = 0 } = {}) {
    clear()
    buildCracks({ x, y })
    buildFlash()
    group.visible = true
    startedAt = performance.now()
    active = true
  }

  function update(timestamp = performance.now()) {
    if (!active || startedAt == null) return
    const elapsed = (timestamp - startedAt) / 1000

    // Flash: squared decay so it reads as a pop rather than a slow glow.
    if (flashMaterial) {
      const flashT = Math.max(0, 1 - elapsed / (config.flashMs / 1000))
      flashMaterial.opacity = config.flashPeak * flashT * flashT
    }

    // Crack lines: snap on and stay. Unlike the flash, the broken mirror is not a transient
    // effect — the title resolves over a crack that remains visible until the story resets.
    if (lineMaterial) {
      lineMaterial.opacity = Math.min(1, elapsed / 0.04)
    }
  }

  function reset() {
    clear()
    group.visible = false
    active = false
    startedAt = null
  }

  function dispose() {
    reset()
    scene.remove(group)
  }

  return { trigger, update, reset, dispose }
}
