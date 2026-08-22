import { describe, expect, it } from 'vitest'
import { selectDevice } from '../../shared/selectDevice.js'

describe('selectDevice', () => {
  it('reports none without an online device', () => {
    expect(selectDevice([])).toEqual({ status: 'none' })
    expect(selectDevice([{ serial: 'one', state: 'offline' }])).toEqual({ status: 'none' })
  })

  it('ignores unavailable devices and selects the only online device', () => {
    expect(
      selectDevice([
        { serial: 'one', state: 'unauthorized' },
        { serial: 'two', state: 'device' },
      ]),
    ).toEqual({ status: 'ok', device: { serial: 'two', state: 'device' } })
  })

  it('reports a conflict instead of silently picking the first device', () => {
    const devices = [
      { serial: 'one', state: 'device' },
      { serial: 'two', state: 'device' },
    ]
    expect(selectDevice(devices)).toEqual({ status: 'conflict', devices })
  })
})
