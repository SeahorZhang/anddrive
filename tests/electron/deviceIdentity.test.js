import { describe, expect, it } from 'vitest'

import { collapseAddressKeys, isAddressLikeKey, pickStableId } from '../../electron/deviceIdentity.js'

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

describe('isAddressLikeKey', () => {
  it('recognises the shapes adb uses for one and the same phone', () => {
    for (const key of [
      '192.168.100.91:41185',
      '192.168.100.91:41759',
      'adb-af3d7abd-Zvci5V._adb-tls-connect._tcp',
      'adb-af3d7abd-Zvci5V',
    ]) {
      expect(isAddressLikeKey(key)).toBe(true)
    }
  })

  it('treats a plain serial number as stable', () => {
    expect(isAddressLikeKey('af3d7abd')).toBe(false)
    expect(isAddressLikeKey('2509FPN0BC')).toBe(false)
    expect(isAddressLikeKey('')).toBe(false)
  })
})

describe('collapseAddressKeys', () => {
  const legacy = {
    '192.168.100.91:41185': ['com.ss.android.ugc.aweme', 'com.phoenix.read'],
    '192.168.100.91:41335': ['com.kylin.read', 'com.phoenix.read'],
    'adb-af3d7abd-Zvci5V._adb-tls-connect._tcp': ['com.jingdong.app.mall'],
  }

  it('merges every address-shaped bucket into the stable key, deduped', () => {
    const { store, mergedCount } = collapseAddressKeys(legacy, 'af3d7abd')
    expect(Object.keys(store)).toEqual(['af3d7abd'])
    expect(store.af3d7abd.sort()).toEqual([
      'com.jingdong.app.mall',
      'com.kylin.read',
      'com.phoenix.read',
      'com.ss.android.ugc.aweme',
    ])
    expect(mergedCount).toBe(4) // 6 条里去掉重复的 com.phoenix.read，净增 4 条
  })

  it('keeps the existing stable bucket first and preserves non-address keys', () => {
    const store = {
      ...legacy,
      af3d7abd: ['com.example.kept'],
      'some-other-key': ['com.other.app'],
    }
    const result = collapseAddressKeys(store, 'af3d7abd')
    expect(result.store.af3d7abd[0]).toBe('com.example.kept')
    expect(result.store['some-other-key']).toEqual(['com.other.app'])
  })

  it('is a no-op when there is nothing legacy to merge', () => {
    const store = { af3d7abd: ['com.a'] }
    const result = collapseAddressKeys(store, 'af3d7abd')
    expect(result.store).toEqual(store)
    expect(result.mergedCount).toBe(0)
  })
})
