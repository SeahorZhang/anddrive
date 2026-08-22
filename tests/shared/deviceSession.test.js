import { describe, expect, it } from 'vitest'
import { resolveSession } from '../../shared/deviceSession.js'

describe('resolveSession', () => {
  it('returns empty without an online device', () => {
    expect(resolveSession([])).toEqual({ status: 'empty' })
    expect(resolveSession([{ serial: 'one', state: 'offline' }])).toEqual({ status: 'empty' })
  })

  it('ignores unavailable devices and connects to the only online device', () => {
    expect(
      resolveSession([
        { serial: 'one', state: 'unauthorized' },
        { serial: 'two', state: 'device' },
      ]),
    ).toEqual({ status: 'connected', serial: 'two' })
  })

  it('reports a conflict instead of silently picking the first online device', () => {
    expect(
      resolveSession([
        { serial: 'one', state: 'offline' },
        { serial: 'two', state: 'device' },
        { serial: 'three', state: 'device' },
      ]),
    ).toEqual({ status: 'conflict', serials: ['two', 'three'] })
  })
})
