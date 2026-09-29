import { describe, expect, it } from 'vitest'

import { ensurePinyin, matchesAppQuery, pinyinInitials, pinyinReady } from '../../shared/appSearch.js'

const SETTINGS = { label: '设置', packageName: 'com.android.settings' }

describe('matchesAppQuery（拼音表未加载时）', () => {
  it('首字母搜不到，但名字与包名照常 —— 所以懒加载不需要骨架或禁用输入框', () => {
    expect(pinyinReady()).toBe(false)
    expect(pinyinInitials('抖音')).toBe('')
    expect(matchesAppQuery({ label: '抖音', packageName: 'com.ss.android.ugc.aweme' }, 'dy')).toBe(false)
    expect(matchesAppQuery(SETTINGS, 'set')).toBe(true)
    expect(matchesAppQuery({ label: '抖音', packageName: 'x' }, '抖音')).toBe(true)
  })
})

describe('拼音首字母（加载完成后）', () => {
  it('ensurePinyin 是幂等的，加载完 pinyinReady 转真', async () => {
    await Promise.all([ensurePinyin(), ensurePinyin()])
    expect(pinyinReady()).toBe(true)
  })

  it('多音字按词判：重庆 → cq（这是选 pinyin-pro 而不是 ICU 排序区间的唯一理由）', async () => {
    await ensurePinyin()
    expect(pinyinInitials('重庆')).toBe('cq')
    expect(pinyinInitials('QQ浏览器')).toBe('qqllq')
  })
})

describe('matchesAppQuery', () => {
  it('空搜索词不过滤', () => {
    expect(matchesAppQuery(SETTINGS, '')).toBe(true)
    expect(matchesAppQuery(SETTINGS, '   ')).toBe(true)
    expect(matchesAppQuery(SETTINGS, null)).toBe(true)
  })

  it('按名字匹配（大小写不敏感）', () => {
    expect(matchesAppQuery({ label: 'Camera', packageName: 'x' }, 'cam')).toBe(true)
    expect(matchesAppQuery({ label: 'Camera', packageName: 'x' }, 'CAMERA')).toBe(true)
    expect(matchesAppQuery(SETTINGS, '相机')).toBe(false)
  })

  it('字母也能搜到：命中包名', () => {
    expect(matchesAppQuery(SETTINGS, 'android.settings')).toBe(true)
    expect(matchesAppQuery(SETTINGS, 'set')).toBe(true)
  })

  it('拼音首字母也能搜到', async () => {
    await ensurePinyin()
    expect(pinyinInitials('抖音')).toBe('dy')
    expect(pinyinInitials('计算器')).toBe('jsq')
    expect(matchesAppQuery({ label: '抖音', packageName: 'com.ss.android.ugc.aweme' }, 'dy')).toBe(true)
    expect(matchesAppQuery(SETTINGS, 'sz')).toBe(true)
    expect(matchesAppQuery(SETTINGS, 'szx')).toBe(false)
  })

  it('字段缺失不炸', () => {
    expect(matchesAppQuery({}, 'a')).toBe(false)
    expect(matchesAppQuery(undefined, 'a')).toBe(false)
  })
})
