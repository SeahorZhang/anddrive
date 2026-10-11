import { describe, expect, it } from 'vitest'
import { createMacTextSink } from '../../src/mirror/macTextSink.js'

// Mac 输入法 → 手机输入框这段翻译的全部判据：合成期间一个字都不送，提交那一刻整串送一次。
// 送早了（`compositionupdate`）拼音字母会留在手机输入框里，送两次就是重复字 —— 这两条是钉死的。

function harness() {
  const committed = []
  const fellBack = []
  const composed = []
  const sink = createMacTextSink({
    commit: (text) => {
      committed.push(text)
      return true
    },
    fallback: (text) => fellBack.push(text),
    compose: (text) => composed.push(text),
  })
  return { sink, committed, fellBack, composed }
}

describe('macTextSink', () => {
  it('拼音合成过程中不送字，结束时整串送一次', () => {
    const { sink, committed, composed } = harness()
    sink.onCompositionStart()
    expect(sink.composing).toBe(true)
    // Chromium 的 `input` 在合成期间一路跟着发候选串，一个都不许漏到手机里。
    sink.onInput({ data: 'zhong' })
    sink.onCompositionUpdate({ data: '中文' })
    sink.onInput({ data: '中文' })
    expect(committed).toEqual([])
    // 但合成中的拼音要同步过去（观感：Mac 光标处的拼音胶囊）
    expect(composed).toEqual(['中文'])
    sink.onCompositionEnd({ data: '中文' })
    expect(sink.composing).toBe(false)
    // 结束时那条空串 = "合成结束了"，下游据此收起胶囊（见下面那条专门钉它）。
    expect(composed).toEqual(['中文', ''])
    expect(committed).toEqual(['中文'])
  })

  it('合成结束一定发一次空串（Esc 取消也要），否则"正在输入"的显示会一直挂着', () => {
    const { sink, composed, committed } = harness()
    sink.onCompositionStart()
    sink.onCompositionUpdate({ data: 'shou' })
    composed.length = 0
    // Esc 取消：`compositionend` 带空串 —— `emit` 对空串提前 return，谁也清不掉合成态。
    sink.onCompositionEnd({ data: '' })
    expect(composed).toEqual([''])
    expect(committed).toEqual([])
    expect(sink.composing).toBe(false)
  })

  it('不打字时按下的字符走 input；删除类 input（data 为 null）不送', () => {
    const { sink, committed } = harness()
    sink.onInput({ data: 'a' })
    sink.onInput({ data: null }) // Backspace / Delete：走按键那条路，这里不该翻成文本
    sink.onInput({})
    expect(committed).toEqual(['a'])
  })

  it('桥没连着就退给 injectText（ASCII 还能用，中文会丢是那条路本来的样子）', () => {
    const fellBack = []
    const sink = createMacTextSink({ commit: () => false, fallback: (t) => fellBack.push(t) })
    sink.onCompositionEnd({ data: '中文abc' })
    expect(fellBack).toEqual(['中文abc'])
  })

  it('合成过程中每次 update 都把当前拼音整串送过去（不是只送新增字母）', () => {
    const { sink, composed, committed } = harness()
    sink.onCompositionStart()
    sink.onCompositionUpdate({ data: 's' })
    sink.onCompositionUpdate({ data: 'sd' })
    sink.onCompositionUpdate({ data: 'sdf' })
    expect(composed).toEqual(['s', 'sd', 'sdf'])
    expect(committed).toEqual([])
  })

  it('空串什么都不发', () => {
    const { sink, committed, fellBack } = harness()
    sink.onCompositionEnd({ data: '' })
    sink.onCompositionEnd({})
    sink.onInput({ data: '' })
    expect(committed).toEqual([])
    expect(fellBack).toEqual([])
  })
})
