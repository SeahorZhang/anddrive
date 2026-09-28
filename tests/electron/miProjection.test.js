import { describe, expect, it } from 'vitest'

import { KEY_SYNERGY, startMiProjection } from '../../electron/mirror/miProjection.js'

const SERIAL = 'dev:5555'

/**
 * 记录**落地顺序**（延迟之后才记）：设备上最终留下什么值只取决于落地顺序，
 * 记调用先后是假判据。`firstDelayMs` 用来造「置位还在途就关会话」的竞态。
 */
function createRecorder({ firstDelayMs = 0, restDelayMs = 0, failFirst = false } = {}) {
  const writes = []
  let calls = 0
  const put = async (serial, key, value) => {
    if (serial !== SERIAL) throw new Error(`发错设备：${serial}`)
    const delay = calls++ === 0 ? firstDelayMs : restDelayMs
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
    if (failFirst && calls === 1) throw new Error("写不进去")
    writes.push([key, value])
  }
  return { writes, put }
}

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))

describe('startMiProjection', () => {
  it('一开会话就声明协同投屏：官方 beginSynergy 只写这一个键', async () => {
    const { writes, put } = createRecorder()
    const restore = startMiProjection({ serial: SERIAL, put })
    await settle()
    expect(writes).toEqual([[KEY_SYNERGY, 1]])
    await restore()
  })

  it('还原把键清回 0，重复还原只清一次', async () => {
    const { writes, put } = createRecorder()
    const restore = startMiProjection({ serial: SERIAL, put })
    await settle()
    await restore()
    await restore()
    expect(writes).toEqual([
      [KEY_SYNERGY, 1],
      [KEY_SYNERGY, 0],
    ])
  })

  it('置位还在途时关会话，清除要等它落地，不能让设备最终留在 1', async () => {
    const { writes, put } = createRecorder({ firstDelayMs: 20, restDelayMs: 1 })
    const restore = startMiProjection({ serial: SERIAL, put })
    await restore()
    await settle()
    expect(writes).toEqual([
      [KEY_SYNERGY, 1],
      [KEY_SYNERGY, 0],
    ])
  })

})
