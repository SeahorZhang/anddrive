import { describe, expect, it } from 'vitest'
import { orderApps, pruneMru } from '../../src/composables/appOrdering.js'

const a = { packageName: 'com.a', label: 'A' }
const b = { packageName: 'com.b', label: 'B' }
const c = { packageName: 'com.c', label: 'C' }

describe('orderApps', () => {
  it('puts recently launched apps first, rest in original order', () => {
    expect(orderApps([a, b, c], ['com.c', 'com.a'])).toEqual([c, a, b])
  })

  it('skips recency entries without a matching app', () => {
    expect(orderApps([a, b], ['com.x', 'com.b'])).toEqual([b, a])
  })

  it('keeps the last entry when package names repeat', () => {
    const renamed = { packageName: 'com.a', label: 'A2' }
    expect(orderApps([a, renamed], [])).toEqual([renamed])
  })

  it('handles empty and missing inputs', () => {
    expect(orderApps([], ['com.a'])).toEqual([])
    expect(orderApps(null, undefined)).toEqual([])
    expect(orderApps([a, b], null)).toEqual([a, b])
  })
})

describe('pruneMru', () => {
  it('drops entries whose app disappeared and keeps order', () => {
    expect(pruneMru(['com.c', 'com.a', 'com.x'], [c, a])).toEqual(['com.c', 'com.a'])
  })

  it('returns empty without apps or recency', () => {
    expect(pruneMru(['com.a'], [])).toEqual([])
    expect(pruneMru(undefined, [a])).toEqual([])
  })
})
