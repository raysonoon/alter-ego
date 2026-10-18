import { FilesetResolver } from '@mediapipe/tasks-vision'
import { WASM_PATH } from '../config.js'

let filesetPromise

/**
 * Loads the vendored tasks-vision WASM runtime once and shares it.
 *
 * Each `forVisionTasks` call instantiates its own copy of a multi-megabyte runtime, so the
 * pose and gesture models must go through this shared promise rather than calling
 * `FilesetResolver` themselves. A failure is not cached, so a retry can re-attempt.
 */
export function getVisionFileset() {
  filesetPromise ??= FilesetResolver.forVisionTasks(WASM_PATH).catch((error) => {
    filesetPromise = undefined
    throw error
  })

  return filesetPromise
}
