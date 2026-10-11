import { describe, expect, it } from 'vitest'
import { capsuleBox, capsuleRect, macTextCapsule } from '../../src/mirror/macTextCapsule.js'

// 拼音胶囊的两条判据：**什么时候出现**（三条叠着，任一条不成立都不画）与**画在哪**
// （贴锚点横向并夹进画面、顶边贴正文行下沿、高 ≈1.3 个行高、宽 ≈3.4 个胶囊高固定
// —— 竞品是「正文行 → 胶囊 → 候选条」三层）。
// 画错的三种表现都很难查：不该出现时挂着一条胶囊、位置跟手机光标错开一行、
// 或者系统候选条压在胶囊上（把矩形放在正文行那一格就会这样）。
// 第四轮加的两个约束（固定宽度、不越出画面右缘）也一样：错了的表现是"长拼音把胶囊顶出画面、
// 被裁掉半截"，或者"靠近右缘打字时字段与胶囊错开"（夹取必须落在同一个矩形上）。

describe('macTextCapsule', () => {
  it('归属是我们的 + 字段有焦点 + 正在合成 ⇒ 出现，并显示合成串', () => {
    const r = macTextCapsule({ capturing: true, focused: true, composing: 'shou' })
    expect(r.visible).toBe(true)
    expect(r.text).toBe('shou')
  })

  it('没在合成（纯 ASCII 直接落字）⇒ 不出现', () => {
    expect(macTextCapsule({ capturing: true, focused: true, composing: '' }).visible).toBe(false)
  })

  it('归属不是我们的（用户按了 × 让出）⇒ 不出现', () => {
    expect(macTextCapsule({ capturing: false, focused: true, composing: 'shou' }).visible).toBe(false)
  })

  it('字段没拿到焦点（按键归长条）⇒ 不出现', () => {
    expect(macTextCapsule({ capturing: true, focused: false, composing: 'shou' }).visible).toBe(false)
  })

  it('合成串不是字符串 ⇒ 不出现，且不炸', () => {
    expect(macTextCapsule({ capturing: true, focused: true, composing: undefined })).toEqual({ visible: false, text: '' })
    expect(macTextCapsule({ capturing: true, focused: true, composing: null }).visible).toBe(false)
  })

  it('什么都不传 ⇒ 不出现', () => {
    expect(macTextCapsule().visible).toBe(false)
    expect(macTextCapsule().text).toBe('')
  })
})

describe('capsuleRect', () => {
  it('横向贴锚点，纵向**顶边贴在那一行的下沿**，高度按 1.3 个行高放大、宽度按 3.4 个胶囊高固定', () => {
    const rect = capsuleRect({ left: 100, top: 40, height: 20 })
    expect(rect.left).toBe(100)
    // 40 + 20 = 60 —— 不是 40 + 20/2。竞品三层排布的关键就在这一步：胶囊自己占一行下面的那一格。
    expect(rect.top).toBe(60)
    expect(rect.height).toBeCloseTo(26, 5) // 20 × 1.3
    expect(rect.width).toBeCloseTo(88.4, 5) // 26 × 3.4
  })

  it('宽度**只由高度决定**，与合成串无关（固定宽度，不再被内容撑开）', () => {
    const rect = capsuleRect({ left: 0, top: 0, height: 20 })
    expect(rect.width).toBeCloseTo(88.4, 5)
    // 同一个矩形反复算，结果必须一样 —— 这里没有"文本入参"，所以结构上就变不了。
    expect(capsuleRect({ left: 0, top: 0, height: 20 }).width).toBe(rect.width)
  })

  it('左边缘夹进画面：right 不越出 screenWidth', () => {
    // 88.4 宽、画面 520 ⇒ 最右只能到 431.6。
    expect(capsuleRect({ left: 500, top: 40, height: 20 }, 520).left).toBeCloseTo(431.6, 5)
    // 没越界时不动。
    expect(capsuleRect({ left: 100, top: 40, height: 20 }, 520).left).toBe(100)
  })

  it('画面比胶囊还窄 / 锚点在画面外 ⇒ 贴左沿 0，不出现负 left', () => {
    expect(capsuleRect({ left: 10, top: 0, height: 20 }, 50).left).toBe(0)
    expect(capsuleRect({ left: -30, top: 0, height: 20 }, 520).left).toBe(0)
  })

  it('画面宽未知（缺省 / 0 / 非有限数）⇒ **不夹**，宁可按真实锚点摆', () => {
    expect(capsuleRect({ left: 500, top: 0, height: 20 }).left).toBe(500)
    expect(capsuleRect({ left: 500, top: 0, height: 20 }, 0).left).toBe(500)
    expect(capsuleRect({ left: 500, top: 0, height: 20 }, Number.NaN).left).toBe(500)
  })

  it('高度为 0 / 非有限数 / 缺矩形 ⇒ 不定位（不许兜底成 0，那就是把胶囊锚回左上角）', () => {
    expect(capsuleRect(null)).toBeNull()
    expect(capsuleRect(undefined)).toBeNull()
    expect(capsuleRect({ left: 0, top: 0, height: 0 })).toBeNull()
    expect(capsuleRect({ left: Number.NaN, top: 0, height: 20 })).toBeNull()
    expect(capsuleRect({ left: 0, top: 0 })).toBeNull()
  })
})

describe('capsuleBox', () => {
  it('位置/宽高与 capsuleRect 同源，字号按胶囊高的 0.48', () => {
    const box = capsuleBox({ left: 100, top: 40, height: 20 })
    expect(box.left).toBe('100px')
    expect(box.top).toBe('60px')
    expect(box.width).toBe('88.4px')
    expect(box.height).toBe('26px')
    expect(box.fontSize).toBe('12.48px') // 26 × 0.48
  })

  it('夹取与 capsuleRect 同一个出处（字段位置与胶囊不会一个夹了一个没夹）', () => {
    const box = capsuleBox({ left: 500, top: 40, height: 20 }, 520)
    expect(box.left).toBe('431.6px')
    expect(box.width).toBe('88.4px')
  })

  it('行高很小的时候字号有下限（不然糊成一团）', () => {
    expect(capsuleBox({ left: 0, top: 0, height: 4 }).fontSize).toBe('10px')
  })

  it('高度为 0 / 非有限数 / 缺矩形 ⇒ 不定位（不许兜底成 0，那就是把胶囊锚回左上角）', () => {
    expect(capsuleBox(null)).toBeNull()
    expect(capsuleBox(undefined)).toBeNull()
    expect(capsuleBox({ left: 0, top: 0, height: 0 })).toBeNull()
    expect(capsuleBox({ left: Number.NaN, top: 0, height: 20 })).toBeNull()
    expect(capsuleBox({ left: 0, top: 0 })).toBeNull()
  })
})
