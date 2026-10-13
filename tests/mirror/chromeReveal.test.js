import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createChromeReveal, chromeZone, RAIL_HIDE_DELAY_MS } from '../../src/mirror/chromeReveal.js'

// 「往外扩那一圈」的显隐判据（用户 2026-10-10 第三次改）：**进到悬浮栏就出，离开它 1 秒后才收**。
// 之前两版都作废过：「停手 1.5s 自动淡出」（在栏里不动也会收）与「只有移出窗口才收」（回到画面上还杵着）。
// 所以下面这三组要分开钉：① 在栏里放着不动 = 一直显形；② 离开后延一档才收；③ 延的这一档能被"回来"取消。

const settle = (reveal, seen) => ({ reveal, seen })

function make() {
  const seen = []
  const reveal = createChromeReveal({ onShow: (v) => seen.push(v) })
  return settle(reveal, seen)
}

describe('createChromeReveal（悬浮栏的显隐）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('第一次 poke 显形，之后反复 poke 不重复报（poke 挂在 pointermove 上，每帧都调）', () => {
    const { reveal, seen } = make()
    reveal.poke()
    reveal.poke()
    reveal.poke()
    expect(seen).toEqual([true])
  })

  /** 这条钉住「不是停手就淡出」：显形之后什么事件都不来，也不该自己收。 */
  it('在栏里放着不动不会自己收起', () => {
    const { reveal, seen } = make()
    reveal.poke()
    vi.advanceTimersByTime(RAIL_HIDE_DELAY_MS * 60)
    expect(seen).toEqual([true])
  })

  it('离开悬浮栏：到点才收，而且只报一次', () => {
    const { reveal, seen } = make()
    reveal.poke()
    reveal.leave()
    expect(seen).toEqual([true])
    vi.advanceTimersByTime(RAIL_HIDE_DELAY_MS - 1)
    expect(seen).toEqual([true])
    vi.advanceTimersByTime(1)
    expect(seen).toEqual([true, false])
    vi.advanceTimersByTime(5000)
    expect(seen).toEqual([true, false])
  })

  /** 鼠标在格子边缘来回出界会连着发好几次 leave：只许有第一次那个到期时间。 */
  it('重复 leave 不叠加计时（不会提前收，也不会收完再收一次）', () => {
    const { reveal, seen } = make()
    reveal.poke()
    reveal.leave()
    vi.advanceTimersByTime(600)
    reveal.leave()
    reveal.leave()
    vi.advanceTimersByTime(399)
    expect(seen).toEqual([true]) // 第一次 leave 起满 1000ms 才收，后两次不算
    vi.advanceTimersByTime(1)
    expect(seen).toEqual([true, false])
  })

  /** 这条是「1 秒」存在的意义：穿过格子边缘去点画面，不该闪一下就没了。 */
  it('延的这一档能被"回来"取消', () => {
    const { reveal, seen } = make()
    reveal.poke()
    reveal.leave()
    vi.advanceTimersByTime(900)
    reveal.poke()
    vi.advanceTimersByTime(RAIL_HIDE_DELAY_MS * 10)
    expect(seen).toEqual([true])
  })

  it('还没显形时 leave 什么都不报（也不会留一个悬着的计时）', () => {
    const { reveal, seen } = make()
    reveal.leave()
    vi.advanceTimersByTime(RAIL_HIDE_DELAY_MS * 5)
    expect(seen).toEqual([])
  })

  it('收起之后再进来，能再显形、也能再收（不是一次性的）', () => {
    const { reveal, seen } = make()
    reveal.poke()
    reveal.leave()
    vi.advanceTimersByTime(RAIL_HIDE_DELAY_MS)
    reveal.poke()
    reveal.leave()
    vi.advanceTimersByTime(RAIL_HIDE_DELAY_MS)
    expect(seen).toEqual([true, false, true, false])
  })

  it('可以自己定这一档多长（默认 1000ms）', () => {
    expect(RAIL_HIDE_DELAY_MS).toBe(1000)
    const seen = []
    const reveal = createChromeReveal({ onShow: (v) => seen.push(v), hideAfterMs: 300 })
    reveal.poke()
    reveal.leave()
    vi.advanceTimersByTime(301)
    expect(seen).toEqual([true, false])
  })
})

// 长条上那颗「一直显示」（2026-10-11 用户点单）：常驻之后 leave 不该再收；取消常驻要干净地回到
// 上面那套 hover 判据 —— 既不能留下一个陈旧的到期时间，也不能自己排一个新的（点那颗按钮时指针
// 就在条上，条不该在 1 秒后从指针底下消失）。
describe('createChromeReveal 的常驻开关', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('按下去就显形 —— 不必先 poke（常驻该独立于 hover 生效）', () => {
    const { reveal, seen } = make()
    reveal.setPinned(true)
    expect(seen).toEqual([true])
  })

  it('常驻期间 leave 排不出到期时间：离开多久都在', () => {
    const { reveal, seen } = make()
    reveal.setPinned(true)
    reveal.leave()
    reveal.leave()
    vi.advanceTimersByTime(RAIL_HIDE_DELAY_MS * 100)
    expect(seen).toEqual([true])
  })

  it('常驻期间 poke 不重复报（poke 挂在 pointermove 上，每帧都调）', () => {
    const { reveal, seen } = make()
    reveal.setPinned(true)
    reveal.poke()
    reveal.poke()
    expect(seen).toEqual([true])
  })

  /** 鼠标刚移出去（排队中）又按了常驻：那个到期时间必须被撤掉，否则 1 秒后条会自己收掉。 */
  it('排队中的那次收回会被常驻撤掉', () => {
    const { reveal, seen } = make()
    reveal.poke()
    reveal.leave()
    vi.advanceTimersByTime(RAIL_HIDE_DELAY_MS - 1)
    reveal.setPinned(true)
    vi.advanceTimersByTime(RAIL_HIDE_DELAY_MS * 10)
    expect(seen).toEqual([true])
  })

  it('取消常驻**不**自己排计时（指针就在条上，条不该在指针底下消失）', () => {
    const { reveal, seen } = make()
    reveal.setPinned(true)
    reveal.setPinned(false)
    vi.advanceTimersByTime(RAIL_HIDE_DELAY_MS * 10)
    expect(seen).toEqual([true])
    // 没常驻过就取消 = 什么也不发生（不许冒一条多余的 onShow）。
    const fresh = make()
    fresh.reveal.setPinned(false)
    expect(fresh.seen).toEqual([])
  })

  it('取消常驻之后回到原来那套：离开 1 秒后照收，再进来照弹', () => {
    const { reveal, seen } = make()
    reveal.setPinned(true)
    reveal.setPinned(false)
    reveal.leave()
    vi.advanceTimersByTime(RAIL_HIDE_DELAY_MS)
    expect(seen).toEqual([true, false])
    reveal.poke()
    expect(seen).toEqual([true, false, true])
  })
})

// 「鼠标在栏里移动就展示/隐藏来回抖」的回归判据：面板显形会盖到触发格上面，命中层一变
// 浏览器就补发一次 pointerleave，坐标其实还在格子里 —— 所以收起必须先过这道几何关。
// chrome 是 **L 形**（用户 2026-10-12「鼠标移动到右侧和上边都要展示边框」）⇒ 两条臂各有一条进线/出线。
// 数按 `App.vue` 那两组常量取：右臂 = 长条格 86，上臂 = 顶条最上面那 12px 触发带
// （顶条其余是 drag 区，DOM 收不到事件，见 `MIRROR_TITLEBAR.revealHeight`）。
describe('chromeZone（L 形两条臂：右边长条 + 顶部那条，进出一条线、中间迟滞）', () => {
  const W = 1600
  const H = 900
  const ENTER = { x: 86, y: 12 }
  const EXIT = { x: 206, y: 132 } // 各自 +120：多给的那一截留给按钮左边的 tooltip
  const MID = { clientX: 800, clientY: 450 } // 两条臂都够不到的那一片

  it('右臂：进 86px 以内 = enter（条自己的那一格）', () => {
    expect(chromeZone({ ...MID, clientX: 1599 }, W, H, ENTER, EXIT)).toBe('enter')
    expect(chromeZone({ ...MID, clientX: 1515 }, W, H, ENTER, EXIT)).toBe('enter')
    expect(chromeZone({ ...MID, clientX: 1514 }, W, H, ENTER, EXIT)).toBe('enter') // 正好压在进线
  })

  it('上臂：顶部那 12px 触发带也算触发区（用户点名要的两条边之一）', () => {
    expect(chromeZone({ ...MID, clientY: 0 }, W, H, ENTER, EXIT)).toBe('enter')
    expect(chromeZone({ ...MID, clientY: 11 }, W, H, ENTER, EXIT)).toBe('enter')
    expect(chromeZone({ ...MID, clientY: 12 }, W, H, ENTER, EXIT)).toBe('enter') // 正好压在线下沿
    // 横坐标压根不贴边也得认 —— 上臂与右臂是**或**的关系
    expect(chromeZone({ clientX: 40, clientY: 6 }, W, H, ENTER, EXIT)).toBe('enter')
  })

  it('两条臂**都**越出各自的出线才算 leave', () => {
    expect(chromeZone(MID, W, H, ENTER, EXIT)).toBe('leave')
    expect(chromeZone({ clientX: 1393, clientY: 450 }, W, H, ENTER, EXIT)).toBe('leave') // 1600-207
    expect(chromeZone({ clientX: 800, clientY: 133 }, W, H, ENTER, EXIT)).toBe('leave') // 12+120+1
  })

  it('中间那一圈是 hold：既不出也不收 —— 鼠标停在按钮左沿外或压在 tooltip 上时不该闪', () => {
    expect(chromeZone({ ...MID, clientX: 1513 }, W, H, ENTER, EXIT)).toBe('hold') // 刚出右臂进线
    expect(chromeZone({ ...MID, clientX: 1450 }, W, H, ENTER, EXIT)).toBe('hold') // tooltip 那一截
    expect(chromeZone({ ...MID, clientX: 1394 }, W, H, ENTER, EXIT)).toBe('hold') // 正好压右臂出线
    expect(chromeZone({ ...MID, clientY: 13 }, W, H, ENTER, EXIT)).toBe('hold') // 刚出上臂进线（drag 区那 16px）
    expect(chromeZone({ ...MID, clientY: 132 }, W, H, ENTER, EXIT)).toBe('hold') // 正好压上臂出线
  })

  it('一条臂出去、另一条还留着 ⇒ 不收（L 形不能各判各的）', () => {
    // 从顶部条滑到画面中间，但还贴右边缘
    expect(chromeZone({ clientX: 1550, clientY: 450 }, W, H, ENTER, EXIT)).toBe('enter')
    // 从右边缘挪到中间，但还贴顶边
    expect(chromeZone({ clientX: 800, clientY: 5 }, W, H, ENTER, EXIT)).toBe('enter')
  })
})
