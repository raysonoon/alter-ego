import { SERIAL } from './config.js'

/**
 * LED LINK: pushes the interaction state to the Arduino UNO R4 WiFi over Web Serial.
 *
 * The firmware only listens for a single byte (`SERIAL.commands`) and lights the whole
 * addressable strip a solid colour for it. This module owns the serial connection and sends
 * that byte on each state transition.
 *
 * Web Serial is Chromium-only and needs a secure context (`localhost` qualifies, same as the
 * camera). The first-ever connection requires a user gesture (the connect button); after that
 * the permission is remembered and we reconnect on boot with no click.
 *
 * The link is deliberately optional: if `navigator.serial` is missing or the board is unplugged
 * the mirror keeps running, just without lights. Nothing here may throw into `main.js`.
 *
 * @param {{ container: HTMLElement, getState: () => string }} options
 *   `container` hosts the one-time connect button; `getState` returns the current state so a
 *   (re)connect can re-sync the strip immediately (covers a board reset on port open).
 */
export function createLedLink({ container, getState }) {
  // Fire-and-forget no-op link used when Web Serial is unavailable.
  const offline = {
    available: false,
    connect: () => {},
    autoConnect: () => {},
    sendState: () => {},
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

  const writeCommand = (command) => {
    if (!writer || command == null) return
    const data = new TextEncoder().encode(command)
    writeChain = writeChain
      .then(() => writer.write(data))
      .catch((error) => console.warn('LED serial write failed', error))
  }

  const sendState = (state) => {
    writeCommand(SERIAL.commands[state])
  }

  const openPort = async (nextPort) => {
    await nextPort.open({ baudRate: SERIAL.baudRate })
    port = nextPort
    writer = port.writable.getWriter()
    port.addEventListener('disconnect', onDisconnect)
    setConnected(true)
    // Re-sync: the board may have reset on open and fallen back to its boot colour.
    sendState(getState())
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
    sendState,
    dispose,
  }
}
