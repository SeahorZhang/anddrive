import { describe, expect, it } from 'vitest'
import { clampRailTop, railAnchorTop, RAIL_EDGE_PAD } from '../../src/mirror/railDock.js'

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

// 浮动态（画面够宽、长条浮在画面里）的默认落点：上下居中（用户 2026-10-14 第二条）。
describe('railAnchorTop（浮动态的锚点 = 上下居中）', () => {
  const PANEL = 361
  const VIEW = 1080

  it('上下留白一样多', () => {
    const top = railAnchorTop(PANEL, VIEW)
    expect(top).toBe((VIEW - PANEL) / 2)
    // 与窗口底之间那一截也是同一个数（这就是"居中"的意思）。
    expect(VIEW - PANEL - top).toBe(top)
  })

  it('面板矮下来锚点跟着下移，永远在正中间', () => {
    for (const panel of [200, 361, 500]) {
      expect(railAnchorTop(panel, VIEW)).toBe((VIEW - panel) / 2)
    }
  })

  /** 面板比窗口还高（窗口拖到最矮）：没有可落区间，与拖拽同一条规矩 —— 钉回顶格。 */
  it('面板比窗口还高时钉回顶格', () => {
    expect(railAnchorTop(900, 300)).toBe(0)
    expect(railAnchorTop(PANEL, 0)).toBe(0)
  })

  /**
   * 居中值在"面板不超过窗口"时**永远 ≥ 0** ⇒ `clampRailTop` 下沿那条 -12 夹取在这条路上够不着，
   * 只可能被上沿夹（面板与窗口差不多高时贴着顶）。
   */
  it('只可能被上沿夹取，不会算出负数顶出去', () => {
    // 面板 300、窗口 330：居中 15，上沿还剩 330-300-12=18 的余地 ⇒ 原样居中。
    expect(railAnchorTop(300, 330)).toBe(15)
    // 窗口只比面板高一点点：居中值超过上沿余地 ⇒ 夹到上沿（贴顶，下沿露一点）。
    expect(railAnchorTop(300, 320)).toBe(320 - 300 - RAIL_EDGE_PAD)
  })

  it('脏值（NaN / undefined / 非数字）不写进 CSS', () => {
    // 面板高读不出来 ⇒ 居中算式本身是 NaN ⇒ `clampRailTop` 那条 NaN 守卫把它压回 0（贴顶），
    // 而不是往 CSS 里写 `translate: 0 NaNpx`（那会让整条 translate 失效、面板跳回未位移的位置）。
    for (const bad of [NaN, undefined, 'abc']) {
      expect(railAnchorTop(bad, VIEW)).toBe(0)
    }
    // `null` 是 0 而不是 NaN（`Number(null) === 0`）⇒ 按"面板没有高度"居中。
    expect(railAnchorTop(null, VIEW)).toBe(VIEW / 2)
  })
})
