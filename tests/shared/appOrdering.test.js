import { describe, expect, it } from 'vitest'
import { orderAppsByMru, promoteToMruFront } from '../../shared/appOrdering.js'

const app = (packageName, label = packageName) => ({ packageName, label, iconUrl: null })

describe('orderAppsByMru', () => {
  it('keeps arrival order without mru entries', () => {
    const apps = [app('a'), app('b')]
    expect(orderAppsByMru(apps, [])).toEqual({ apps: [app('a'), app('b')], mru: [] })
    expect(orderAppsByMru(apps)).toEqual({ apps: [app('a'), app('b')], mru: [] })
  })

  it('places mru packages first in mru order and prunes stale entries', () => {
    const apps = [app('a'), app('b'), app('c')]
    expect(orderAppsByMru(apps, ['c', 'gone', 'a'])).toEqual({
      apps: [app('c'), app('a'), app('b')],
      mru: ['c', 'a'],
    })
  })

  it('dedupes apps by packageName with the last one winning', () => {
    const apps = [app('a', 'old'), app('a', 'new'), app('b')]
    expect(orderAppsByMru(apps, ['a'])).toEqual({ apps: [app('a', 'new'), app('b')], mru: ['a'] })
  })

  it('ignores invalid entries and duplicate mru packages', () => {
    const apps = [null, undefined, { label: 'no pkg' }, app('a')]
    expect(orderAppsByMru(apps, ['a', 'a'])).toEqual({ apps: [app('a')], mru: ['a'] })
  })

  it('does not mutate its inputs', () => {
    const apps = [app('a'), app('b')]
    const mru = ['b']
    orderAppsByMru(apps, mru)
    expect(apps.map((item) => item.packageName)).toEqual(['a', 'b'])
    expect(mru).toEqual(['b'])
  })
})

describe('promoteToMruFront', () => {
  it('moves an existing package to the front without duplicates', () => {
    expect(promoteToMruFront(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c'])
  })

  it('prepends a package that is not yet in the list', () => {
    expect(promoteToMruFront(['a'], 'new')).toEqual(['new', 'a'])
    expect(promoteToMruFront([], 'new')).toEqual(['new'])
  })
})
