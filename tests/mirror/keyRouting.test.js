import { describe, expect, it } from 'vitest'
import { isImeKey, routeKeyDown } from '../../src/mirror/keyRouting.js'

// 这里钉住的是"一个键归谁管"。10-11 的真 bug：中文输入法用空格选候选，那个空格被
// 当成普通按键又给手机发了一遍 ⇒ 手机上多出一个空格（用户：「输入中感觉会多个空格」）。
// 空格 / 回车都在 `KEYBOARD_KEYS` 里，所以"合成态"这条判据必须排在查表**之前**。

function ev(partial) {
  return { key: '', keyCode: 0, isComposing: false, ...partial }
}

describe('isImeKey', () => {
  it('合成态（isComposing）算输入法吃掉', () => {
    expect(isImeKey(ev({ key: ' ', isComposing: true }))).toBe(true)
  })

  it('keyCode 229 算输入法吃掉（部分实现只给这个）', () => {
    expect(isImeKey(ev({ key: 'Enter', keyCode: 229 }))).toBe(true)
  })

  it('普通按键不算', () => {
    expect(isImeKey(ev({ key: 'a', keyCode: 65 }))).toBe(false)
  })

  it('空事件不算（不炸）', () => {
    expect(isImeKey(null)).toBe(false)
    expect(isImeKey(undefined)).toBe(false)
  })
})

describe('routeKeyDown', () => {
  it('选候选的空格不转发给手机（这就是多空格的根因）', () => {
    expect(routeKeyDown(ev({ key: ' ', isComposing: true }))).toBeNull()
    expect(routeKeyDown(ev({ key: ' ', keyCode: 229 }))).toBeNull()
  })

  it('选候选的回车同样不转发（否则手机多一个换行）', () => {
    expect(routeKeyDown(ev({ key: 'Enter', isComposing: true }))).toBeNull()
  })

  it('合成态里改拼音的退格不转发（那是 Mac 本地的事）', () => {
    expect(routeKeyDown(ev({ key: 'Backspace', isComposing: true }))).toBeNull()
  })

  it('不在合成态的空格照旧当按键转发', () => {
    expect(routeKeyDown(ev({ key: ' ' }))).toBe('key')
  })

  it('退格 / 回车 / 方向键 / Esc / Tab 都走按键', () => {
    for (const key of ['Backspace', 'Enter', 'Tab', 'Escape', 'ArrowLeft', 'ArrowUp', 'Delete', 'PageDown']) {
      expect(routeKeyDown(ev({ key }))).toBe('key')
    }
  })

  it('Cmd 组合键交给系统，一个都不碰', () => {
    expect(routeKeyDown(ev({ key: 'q', metaKey: true }))).toBeNull()
    expect(routeKeyDown(ev({ key: 'Backspace', metaKey: true }))).toBeNull()
    expect(routeKeyDown(ev({ key: ' ', metaKey: true }))).toBeNull()
  })

  it('可打印字符归谁：收字字段没在收时走文本注入，在收时谁都不发', () => {
    expect(routeKeyDown(ev({ key: 'a' }), { captureText: false })).toBe('text')
    expect(routeKeyDown(ev({ key: 'a' }), { captureText: true })).toBeNull()
  })

  it('Ctrl / Alt 组合不处理', () => {
    expect(routeKeyDown(ev({ key: 'a', ctrlKey: true }))).toBeNull()
    expect(routeKeyDown(ev({ key: 'a', altKey: true }))).toBeNull()
  })

  it('命名键（Shift / F5 之类）不管', () => {
    expect(routeKeyDown(ev({ key: 'Shift' }))).toBeNull()
    expect(routeKeyDown(ev({ key: 'F5' }))).toBeNull()
  })

  it('收字字段在收时，字母既不发按键也不发文本（只由隐藏字段送）', () => {
    expect(routeKeyDown(ev({ key: 'z' }), { captureText: true })).toBeNull()
    // 但退格仍要走按键 —— 隐藏字段的 `input` 里 `data` 是 null，翻不成删除。
    expect(routeKeyDown(ev({ key: 'Backspace' }), { captureText: true })).toBe('key')
  })
})
