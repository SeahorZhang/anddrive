import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createChromeReveal, isOutsideRect, RAIL_HIDE_DELAY_MS } from '../../src/mirror/chromeReveal.js'

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

// 「鼠标在栏里移动就展示/隐藏来回抖」的回归判据：面板显形会盖到触发格上面，命中层一变
// 浏览器就补发一次 pointerleave，坐标其实还在格子里 —— 所以收起必须先过这道几何关。
describe('isOutsideRect（什么才算真的移出悬浮栏）', () => {
  // 镜像窗里那一格的形状：右边 86px 宽、整扇高。
  const slot = { left: 436, top: 0, right: 522, bottom: 755 }

  it('坐标还在格子里就不算移出（补发的那次 leave 就是这种）', () => {
    expect(isOutsideRect({ clientX: 521, clientY: 754 }, slot)).toBe(false)
    expect(isOutsideRect({ clientX: 437, clientY: 1 }, slot)).toBe(false)
    expect(isOutsideRect({ clientX: 479, clientY: 400 }, slot)).toBe(false)
  })

  it('四条边出界都算：往画面那侧、往窗口外、上下出去', () => {
    expect(isOutsideRect({ clientX: 436, clientY: 400 }, slot)).toBe(true) // 贴左沿（画面那侧）
    expect(isOutsideRect({ clientX: 400, clientY: 400 }, slot)).toBe(true)
    expect(isOutsideRect({ clientX: 522, clientY: 400 }, slot)).toBe(true)
    expect(isOutsideRect({ clientX: 479, clientY: 0 }, slot)).toBe(true)
    expect(isOutsideRect({ clientX: 479, clientY: 755 }, slot)).toBe(true)
    expect(isOutsideRect({ clientX: 479, clientY: -1 }, slot)).toBe(true)
  })
})
