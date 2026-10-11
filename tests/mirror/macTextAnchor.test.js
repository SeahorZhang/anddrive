import { describe, expect, it } from 'vitest'
import { clientToDevice, deviceToScreen, emSizePx, estimateAdvancePx } from '../../src/mirror/macTextAnchor.js'

// 候选窗锚点的判据（G1 续）：macOS 把输入法候选窗摆在**宿主给的 caret 矩形**处，Electron 里
// 那个矩形就是收字字段的 DOM caret —— 所以「候选窗贴哪」完全等于「字段被摆成什么矩形」。
// 三个量各有一组判据：位置（两个方向互为逆变换）、高度（1px 会压在文字行上）、
// 以及**推进宽度**（设备侧拿不到真实光标，只能按送出去的文本自己算）。

/** 1080×2400 的竖屏，按 letterbox 铺进 360×800 的显示矩形（scale = 1/3，比例一致）。 */
const rect = { left: 100, top: 50, width: 360, height: 800 }
const size = { width: 1080, height: 2400 }
/** 定位祖先（`.mirror-screen`）在视口里的位置 —— 字段坐标是相对它的。 */
const screenRect = { left: 40, top: 20 }

describe('macTextAnchor 位置换算', () => {
  it('窗口里的点按显示矩形的比例换算成设备坐标', () => {
    expect(clientToDevice({ clientX: 280, clientY: 450, rect, size })).toEqual({ x: 540, y: 1200 })
    expect(clientToDevice({ clientX: 100, clientY: 50, rect, size })).toEqual({ x: 0, y: 0 })
    expect(clientToDevice({ clientX: 460, clientY: 850, rect, size })).toEqual({ x: 1080, y: 2400 })
  })

  it('点到 letterbox 的黑边上时夹进画面内，不把候选窗甩出画面', () => {
    expect(clientToDevice({ clientX: 50, clientY: 10, rect, size })).toEqual({ x: 0, y: 0 })
    expect(clientToDevice({ clientX: 600, clientY: 900, rect, size })).toEqual({ x: 1080, y: 2400 })
  })

  it('设备坐标换算回显示坐标时减掉定位祖先的偏移', () => {
    expect(deviceToScreen({ point: { x: 540, y: 1200 }, rect, size, screenRect })).toEqual({
      left: 240,
      top: 430,
      height: 0,
    })
  })

  it('两个方向互为逆变换（同一块显示矩形）', () => {
    const clientX = 280
    const clientY = 450
    const point = clientToDevice({ clientX, clientY, rect, size })
    const screen = deviceToScreen({ point, rect, size, screenRect })
    expect(screen.left + screenRect.left).toBeCloseTo(clientX)
    expect(screen.top + screen.height / 2 + screenRect.top).toBeCloseTo(clientY)
  })

  it('尺寸未知或矩形为零时返回 null（不许兜底成 0 —— 那就是锚到左上角）', () => {
    expect(clientToDevice({ clientX: 280, clientY: 450, rect, size: null })).toBeNull()
    expect(clientToDevice({ clientX: 280, clientY: 450, rect, size: { width: 0, height: 2400 } })).toBeNull()
    expect(clientToDevice({ clientX: 280, clientY: 450, rect: null, size })).toBeNull()
    expect(clientToDevice({ clientX: 280, clientY: 450, rect: { ...rect, height: 0 }, size })).toBeNull()
    expect(deviceToScreen({ point: { x: 540, y: 1200 }, rect: null, size, screenRect })).toBeNull()
    expect(deviceToScreen({ point: { x: 540, y: 1200 }, rect, size, screenRect: null })).toBeNull()
  })

  it('还没点过画面（没有锚点）时不产生位置，交给调用方兜底', () => {
    expect(deviceToScreen({ point: null, rect, size, screenRect })).toBeNull()
  })
})

describe('macTextAnchor caret 矩形高度', () => {
  it('矩形以锚点为中心：底边落在锚点下方半个行高处', () => {
    // 60 设备 px 的行高 → 显示 20 CSS px；锚点原本在 430，于是顶边抬到 420。
    expect(deviceToScreen({ point: { x: 540, y: 1200 }, rect, size, screenRect, caretHeightPx: 60 })).toEqual({
      left: 240,
      top: 420,
      height: 20,
    })
  })

  it('行高为零或缺失时退回一个点（不产生高度，也不平移）', () => {
    expect(deviceToScreen({ point: { x: 540, y: 1200 }, rect, size, screenRect, caretHeightPx: 0 })).toEqual({
      left: 240,
      top: 430,
      height: 0,
    })
    expect(deviceToScreen({ point: { x: 540, y: 1200 }, rect, size, screenRect, caretHeightPx: -5 }).height).toBe(0)
  })
})

describe('macTextAnchor 字号与推进宽度', () => {
  it('1sp = dpi/160 px；16sp 在 440dpi 上是 44px', () => {
    expect(emSizePx(440)).toBe(44)
    expect(emSizePx(160)).toBe(16)
  })

  it('宽字符按 1 em、拉丁按 0.55 em 估', () => {
    expect(estimateAdvancePx('你好', 44)).toBeCloseTo(88)
    expect(estimateAdvancePx('shd', 44)).toBeCloseTo(72.6)
    expect(estimateAdvancePx('a你', 44)).toBeCloseTo(68.2)
    // 全角标点也算宽字符：不然「你好，」的逗号会少算半个字，越打越偏。
    expect(estimateAdvancePx('，', 44)).toBeCloseTo(44)
  })

  it('空串与无字号时不推进', () => {
    expect(estimateAdvancePx('', 44)).toBe(0)
    expect(estimateAdvancePx('你好', 0)).toBe(0)
    expect(estimateAdvancePx(null, 44)).toBe(0)
  })
})
