/**
 * Story text overlay.
 *
 * A single full-screen, `pointer-events:none` layer with three slots:
 *   - `primary`   — the step-4 prompt, then quote line A;
 *   - `secondary` — quote line B;
 *   - `title`     — the "ALTER EGO" reveal.
 *
 * Opacity is written straight from the director each frame (so fades are frame-accurate and stay
 * in sync with the glass crack), but DOM writes are cached: the text is only touched when it
 * changes, so a per-frame opacity drive does not thrash layout.
 */
export function createTextOverlay({ container }) {
  const root = document.createElement('div')
  root.className = 'story'
  root.setAttribute('aria-hidden', 'true')

  const primary = document.createElement('div')
  primary.className = 'story-line story-line--primary'

  const secondary = document.createElement('div')
  secondary.className = 'story-line story-line--secondary'

  const title = document.createElement('div')
  title.className = 'story-title'

  root.append(primary, secondary, title)
  container.appendChild(root)

  const cache = new Map()

  const clamp01 = (value) =>
    Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0

  function apply(element, key, text, opacity) {
    if (text != null && cache.get(`${key}:text`) !== text) {
      element.textContent = text
      cache.set(`${key}:text`, text)
    }
    const value = clamp01(opacity)
    if (cache.get(`${key}:opacity`) !== value) {
      element.style.opacity = String(value)
      cache.set(`${key}:opacity`, value)
    }
  }

  /** @param {{ prompt?: boolean }} [options] `prompt` drops the line to the lower third. */
  function setPrimary(text, opacity = 1, { prompt = false } = {}) {
    primary.classList.toggle('story-line--prompt', Boolean(prompt))
    apply(primary, 'primary', text, opacity)
  }

  function setSecondary(text, opacity = 1) {
    apply(secondary, 'secondary', text, opacity)
  }

  function setTitle(text, opacity = 1) {
    apply(title, 'title', text, opacity)
  }

  function clear() {
    setPrimary('', 0, { prompt: false })
    setSecondary('', 0)
    setTitle('', 0)
  }

  function dispose() {
    root.remove()
    cache.clear()
  }

  return { setPrimary, setSecondary, setTitle, clear, dispose }
}
