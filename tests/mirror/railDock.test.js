import { describe, expect, it } from 'vitest'
import { clampRailTop, RAIL_EDGE_PAD } from '../../src/mirror/railDock.js'

describe('clampRailTop（长条纵向落点）', () => {
  // 窗口 1080 高、面板 361 高 ⇒ 可落区间 [-12, 1080-361-12=707]
  const PANEL = 361
  const VIEW = 1080

  it('区间内原样通过（拖到哪就停哪）', () => {
    expect(clampRailTop(0, PANEL, VIEW)).toBe(0)
    expect(clampRailTop(240, PANEL, VIEW)).toBe(240)
    expect(clampRailTop(707, PANEL, VIEW)).toBe(707)
  })

  it('往上过头夹到 -12、往下过头夹到窗口高减面板高再减呼吸位', () => {
    expect(clampRailTop(-500, PANEL, VIEW)).toBe(-RAIL_EDGE_PAD)
    expect(clampRailTop(99999, PANEL, VIEW)).toBe(VIEW - PANEL - RAIL_EDGE_PAD)
  })

  it('面板比窗口还高 = 没有可拖区间，钉回顶格（不能把条推到抓不回来的地方）', () => {
    expect(clampRailTop(400, 900, 300)).toBe(0)
    expect(clampRailTop(-400, 900, 300)).toBe(0)
  })

  it('脏值（NaN / undefined / Infinity）当 0，不写进 CSS', () => {
    for (const bad of [NaN, undefined, null, Infinity, -Infinity, 'abc']) {
      expect(clampRailTop(bad, PANEL, VIEW)).toBe(0)
    }
  })

  it('窗口高读不到（0）也钉回顶格而不是算出负区间', () => {
    expect(clampRailTop(300, PANEL, 0)).toBe(0)
  })
})
