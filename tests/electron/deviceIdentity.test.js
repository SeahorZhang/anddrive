import { describe, expect, it } from 'vitest'

import { pickStableId } from '../../electron/deviceIdentity.js'

describe('pickStableId', () => {
  it('takes the first usable candidate', () => {
    expect(pickStableId(['af3d7abd', 'other', 'x'], '1.2.3.4:5555')).toBe('af3d7abd')
    expect(pickStableId(['', 'af3d7abd', 'x'], 't')).toBe('af3d7abd')
    expect(pickStableId(['  af3d7abd  '], 't')).toBe('af3d7abd')
  })

  it('skips the placeholders adb gives on Android 12+', () => {
    expect(pickStableId(['unknown', 'UNKNOWN', '', 'null', '0', '4776655a'], 't')).toBe('4776655a')
  })

  it('falls back to the transport address when nothing is usable', () => {
    expect(pickStableId(['unknown', ''], '192.168.1.9:5555')).toBe('192.168.1.9:5555')
    expect(pickStableId([], 't')).toBe('t')
    expect(pickStableId(undefined, undefined)).toBe('')
  })
})
