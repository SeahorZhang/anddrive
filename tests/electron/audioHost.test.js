import { describe, expect, it } from 'vitest'
import { pickAudioHost } from '../../electron/mirror/audioHost.js'

// 设备级音频会话的宿主选举：Android 上只有一条 `AUDIO_DEVICE_OUT_REMOTE_SUBMIX`，
// 同一台设备同时只允许一条采集（两条并存的机制后果见 `options.js` 与 `session.js`）。
describe('pickAudioHost（谁承载这台设备那条唯一的音频会话）', () => {
  it('挑最早打开的那个', () => {
    expect(
      pickAudioHost([
        { id: 'mirror-2', startedAt: 200 },
        { id: 'mirror-1', startedAt: 100 },
        { id: 'mirror-3', startedAt: 300 },
      ]),
    ).toBe('mirror-1')
  })

  it('同刻用 id 兜底：同一份输入永远给出同一个答案', () => {
    // 判据必须只依赖当前活着的集合，两次调用不能给出不同的宿主 —— 否则会出现两条采集。
    const list = [
      { id: 'mirror-b', startedAt: 100 },
      { id: 'mirror-a', startedAt: 100 },
    ]
    expect(pickAudioHost(list)).toBe('mirror-a')
    expect(pickAudioHost([...list].reverse())).toBe('mirror-a')
  })

  it('没有候选（这台设备没窗口了）回 null = 该收摊', () => {
    expect(pickAudioHost([])).toBeNull()
    expect(pickAudioHost(null)).toBeNull()
    expect(pickAudioHost(undefined)).toBeNull()
  })

  it('脏数据跳过而不是当候选：宁可不承载，也不要挑一个读不出 id 的', () => {
    expect(pickAudioHost([null, undefined, { id: 123, startedAt: 1 }, { id: 'mirror-1', startedAt: 5 }]))
      .toBe('mirror-1')
    expect(pickAudioHost([{ startedAt: 1 }, null])).toBeNull()
  })

  it('缺 startedAt 按 0 算（= 最早），不会因为 NaN 把整轮选举搅乱', () => {
    expect(pickAudioHost([{ id: 'mirror-2', startedAt: 100 }, { id: 'mirror-1' }])).toBe('mirror-1')
    expect(pickAudioHost([{ id: 'mirror-2', startedAt: Number.NaN }])).toBe('mirror-2')
  })
})
