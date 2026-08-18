/**
 * Selects the first online device for the current single-device-first UI.
 * Multi-device conflict handling belongs to the later session refactor.
 *
 * @param {import('./types.js').AdbDevice[]} devices
 * @returns {import('./types.js').AdbDevice | null}
 */
export function selectDevice(devices) {
  return devices.find((device) => device.state === 'device') ?? null
}
