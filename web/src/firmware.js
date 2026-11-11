import { LED, SERIAL } from './config.js'

/**
 * LED LINK: pushes the interaction state and brightness to the Arduino UNO R4 WiFi over Web
 * Serial.
 *
 * The firmware reads a two-byte frame — `[command, brightness]` — and lights the whole
 * addressable strip a solid colour for the command at that brightness. This module owns the
 * serial connection, sends the frame on each state transition, and streams updates while the
 * strip's brightness changes (the APPROACH ramp) at a modest rate so the 9600-baud link is not
 * flooded.
 *
 * Web Serial is Chromium-only and needs a secure context (`localhost` qualifies, same as the
 * camera). The first-ever connection requires a user gesture (the connect button); after that
 * the permission is remembered and we reconnect on boot with no click.
 *
 * The link is deliberately optional: if `navigator.serial` is missing or the board is unplugged
 * the mirror keeps running, just without lights. Nothing here may throw into `main.js`.
 *
 * @param {{ container: HTMLElement, getLed: () => { state: string, brightness?: number } }} options
 *   `container` hosts the one-time connect button; `getLed` returns the current state and
 *   brightness so a (re)connect can re-sync the strip immediately (covers a board reset on
 *   port open).
 */
export function createLedLink({ container, getLed }) {
  // Fire-and-forget no-op link used when Web Serial is unavailable.
  const offline = {
    available: false,
    connect: () => {},
    autoConnect: () => {},
    sendLed: () => {},
    dispose: () => {},
  }

  if (!('serial' in navigator)) {
    console.warn('Web Serial unavailable in this browser; LED strip will not light.')
    return offline
  }

  let port = null
  let writer = null
  let connected = false
  let writeChain = Promise.resolve()

  // The last frame actually written, so identical frames are skipped and continuous brightness
  // updates can be throttled without ever dropping the final value (it is re-sent next call).
  let lastState = null
  let lastBrightness = -1
  let lastSentAt = -Infinity

  const button = document.createElement('button')
  button.className = 'led-connect'
  button.textContent = 'connect LEDs'
  button.hidden = true
  container.appendChild(button)

  const setConnected = (value) => {
    connected = value
    button.hidden = value
  }

  const release = () => {
    // Guarded: releasing a writer that errored (e.g. device unplugged) still resolves.
    try {
      writer?.releaseLock()
    } catch {
      /* ignore */
    }
    writer = null
    try {
      port?.close()
    } catch {
      /* ignore */
    }
    port = null
  }

  const onDisconnect = () => {
    release()
    setConnected(false)
    // The connect button returns so the operator can plug the board back in.
  }

  const writeFrame = (command, brightness) => {
    if (!writer || command == null) return
    const data = new Uint8Array([command.charCodeAt(0), brightness])
    writeChain = writeChain
      .then(() => writer.write(data))
      .catch((error) => console.warn('LED serial write failed', error))
  }

  const sendLed = ({ state, brightness = 1 }) => {
    const command = SERIAL.commands[state]
    if (command == null) return

    const byte = Math.max(0, Math.min(255, Math.round(brightness * 255)))
    const now = performance.now()
    const stateChanged = state !== lastState
    // A new state is written immediately; within a state, brightness updates are throttled.
    if (!stateChanged && byte === lastBrightness) return
    if (!stateChanged && now - lastSentAt < LED.streamIntervalMs) return

    lastState = state
    lastBrightness = byte
    lastSentAt = now
    writeFrame(command, byte)
  }

  // Force the current state/brightness through, regardless of the throttle (reconnect re-sync).
  const resync = () => {
    lastState = null
    lastBrightness = -1
    sendLed(getLed())
  }

  const openPort = async (nextPort) => {
    await nextPort.open({ baudRate: SERIAL.baudRate })
    port = nextPort
    writer = port.writable.getWriter()
    port.addEventListener('disconnect', onDisconnect)
    setConnected(true)
    // Re-sync: the board may have reset on open and fallen back to its boot colour.
    resync()
  }

  // Opens a port the user previously granted, without needing a gesture.
  const autoConnect = async () => {
    try {
      const ports = await navigator.serial.getPorts()
      const previous = ports[0]
      if (previous) await openPort(previous)
    } catch (error) {
      console.warn('LED auto-connect failed', error)
    }
    if (!connected) button.hidden = false
  }

  // Requires a user gesture; invoked from the button click.
  const connect = async () => {
    button.disabled = true
    try {
      const requested = await navigator.serial.requestPort()
      await openPort(requested)
    } catch (error) {
      // Thrown when the user dismisses the chooser; that's not an error worth surfacing.
      if (error.name !== 'NotFoundError') console.warn('LED connect failed', error)
    } finally {
      button.disabled = false
    }
  }

  button.addEventListener('click', connect)

  const dispose = () => {
    port?.removeEventListener('disconnect', onDisconnect)
    release()
    button.remove()
  }

  return {
    available: true,
    connect,
    autoConnect,
    sendLed,
    dispose,
  }
}
