import { describe, expect, it } from 'vitest'
import {
  clampRailPos,
  clampRailTop,
  railAnchorTop,
  RAIL_DRAG_THRESHOLD,
  RAIL_EDGE_PAD,
} from '../../src/mirror/railDock.js'

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

/**
 * 窗口态那条胶囊的落点（2026-10-16 用户「右侧操作栏可拖动」）：横纵各夹一遍，返回左上角坐标。
 * 调用方（`App.vue` 的 `onRailDragMove` / `syncRailDock`）传 `pad = 0` —— 胶囊浮在画面上，
 * 露到窗口外那一截会被窗口裁掉（半个按钮看不见），所以它连呼吸位都不留。
 */
describe('clampRailPos（窗口态胶囊的落点）', () => {
  const SIZE = { width: 180, height: 28 }
  const VIEW = { width: 380, height: 820 }

  it('区间内原样通过（拖到哪就停哪）', () => {
    expect(clampRailPos({ x: 100, y: 300 }, SIZE, VIEW, 0)).toEqual({ x: 100, y: 300 })
    // 默认位置（贴右上、与三颗中线对齐）也在区间内 ⇒ 按下那一刻写进去不会跳。
    expect(clampRailPos({ x: VIEW.width - SIZE.width - 12, y: 5 }, SIZE, VIEW, 0)).toEqual({
      x: VIEW.width - SIZE.width - 12,
      y: 5,
    })
  })

  it('两轴各自夹：右下过头贴到窗口内沿（pad = 0 ⇒ 胶囊完整留在窗口里）', () => {
    expect(clampRailPos({ x: 9999, y: 9999 }, SIZE, VIEW, 0)).toEqual({
      x: VIEW.width - SIZE.width,
      y: VIEW.height - SIZE.height,
    })
  })

  it('左上过头夹回 0', () => {
    expect(clampRailPos({ x: -9999, y: -9999 }, SIZE, VIEW, 0)).toEqual({ x: 0, y: 0 })
  })

  it('不传 pad 时是 RAIL_EDGE_PAD（与纵向那条同一套规矩）', () => {
    expect(clampRailPos({ x: -9999, y: -9999 }, SIZE, VIEW)).toEqual({
      x: -RAIL_EDGE_PAD,
      y: -RAIL_EDGE_PAD,
    })
    expect(clampRailPos({ x: 9999, y: 9999 }, SIZE, VIEW)).toEqual({
      x: VIEW.width - SIZE.width - RAIL_EDGE_PAD,
      y: VIEW.height - SIZE.height - RAIL_EDGE_PAD,
    })
  })

  it('胶囊比窗口还宽 / 还高时钉回起始边（没有可拖区间）', () => {
    expect(clampRailPos({ x: 50, y: 50 }, { width: 900, height: 900 }, VIEW, 0)).toEqual({ x: 0, y: 0 })
    // 只有一轴超（宽超、高不超）：超的那轴回 0，另一轴照常。
    expect(clampRailPos({ x: 50, y: 400 }, { width: 900, height: 28 }, VIEW, 0)).toEqual({ x: 0, y: 400 })
  })

  it('脏值（NaN / undefined / 尺寸读不到）当 0，不写进 CSS', () => {
    expect(clampRailPos(undefined, SIZE, VIEW, 0)).toEqual({ x: 0, y: 0 })
    expect(clampRailPos({ x: NaN, y: 'abc' }, SIZE, VIEW, 0)).toEqual({ x: 0, y: 0 })
    expect(clampRailPos({ x: 10, y: 10 }, undefined, VIEW, 0)).toEqual({ x: 0, y: 0 })
  })
})

/**
 * 拖动阈值：胶囊里几乎全是按钮（6 颗 22px 的键把 159px 占满，只剩 3px padding 能抓），
 * 只认"抓空白处"等于没法拖 ⇒ 按在按钮上挪过这个数就转成拖整条。
 * ⚠️ 它**必须是个小正数**：0 会让"点按钮"退化成"一按就拖"，太大又变成拖不动。
 */
describe('RAIL_DRAG_THRESHOLD（点 vs 拖那条线）', () => {
  it('是 1..8 之间的小正数（手抖不该把条挪走，也不该拖不动）', () => {
    expect(RAIL_DRAG_THRESHOLD).toBeGreaterThan(0)
    expect(RAIL_DRAG_THRESHOLD).toBeLessThanOrEqual(8)
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
