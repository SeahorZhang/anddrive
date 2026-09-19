import { describe, expect, it } from 'vitest'

import { appSessionKey, findAppSession } from '../../electron/mirror/appSession.js'

describe('appSessionKey', () => {
  it('matches on device plus package only', () => {
    const base = { serial: '1.1.1.1:5555', packageName: 'com.x' }
    // 同一个应用的第二个快捷方式通常带不同标签，不能因此算成两个应用。
    expect(appSessionKey({ ...base, label: '另一个标签' })).toBe(appSessionKey(base))
  })

  it('separates the same package on different devices', () => {
    expect(appSessionKey({ serial: 'a', packageName: 'p' })).not.toBe(
      appSessionKey({ serial: 'b', packageName: 'p' }),
    )
  })

  it('tolerates missing fields', () => {
    expect(appSessionKey(undefined)).toBe('\u0000')
  })
})

describe('findAppSession', () => {
  const sessions = [
    { id: 'm-1', serial: 'a', packageName: 'com.x' },
    { id: 'm-2', serial: 'a', packageName: 'com.y' },
    { id: 'm-3', serial: 'b', packageName: 'com.x' },
  ]

  it('returns the session already playing that app on that device', () => {
    expect(findAppSession(sessions, { serial: 'a', packageName: 'com.y' })?.id).toBe('m-2')
    expect(findAppSession(sessions, { serial: 'b', packageName: 'com.x' })?.id).toBe('m-3')
  })

  it('returns null for another device or another app', () => {
    expect(findAppSession(sessions, { serial: 'c', packageName: 'com.x' })).toBe(null)
    expect(findAppSession(sessions, { serial: 'a', packageName: 'com.z' })).toBe(null)
  })

  it('returns null when there is no session at all', () => {
    expect(findAppSession([], { serial: 'a', packageName: 'com.x' })).toBe(null)
  })
})
