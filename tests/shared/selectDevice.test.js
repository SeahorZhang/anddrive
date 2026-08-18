import { describe, expect, it } from 'vitest'
import { selectDevice } from '../../shared/selectDevice.js'

describe('selectDevice', () => {
  it('returns null without an online device', () => {
    expect(selectDevice([])).toBeNull()
    expect(selectDevice([{ serial: 'one', state: 'offline' }])).toBeNull()
  })

  it('ignores unavailable devices and returns the online device', () => {
    expect(
      selectDevice([
        { serial: 'one', state: 'unauthorized' },
        { serial: 'two', state: 'device' },
      ]),
    ).toEqual({ serial: 'two', state: 'device' })
  })

  it('keeps stable first-device behavior when multiple devices are online', () => {
    expect(
      selectDevice([
        { serial: 'one', state: 'device' },
        { serial: 'two', state: 'device' },
      ]),
    ).toEqual({ serial: 'one', state: 'device' })
  })
})
