import { describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-icon-image-'))

vi.mock('electron', () => ({
  app: { getPath: (name) => (name === 'userData' ? userDataDir : '') },
}))

const { composeMacosIconPng, iconPngBuffer } = await import(
  '../../electron/iconImage.js'
)

// 32x32 纯色 PNG。
const PNG_32X32 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAL0lEQVR4nO3OIQEAAAgDMLLRjcZ4iHEzMb/q2UsqAQEBAQEBAQEBAQEBAQGBdOABaxLol58gSrcAAAAASUVORK5CYII=',
  'base64',
)

function pngSize(buffer) {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

describe('iconPngBuffer', () => {
  it('decodes a png data url and rejects other input', () => {
    expect(iconPngBuffer(`data:image/png;base64,${PNG_32X32.toString('base64')}`)).toEqual(PNG_32X32)
    expect(iconPngBuffer('data:image/jpeg;base64,AAAA')).toBeNull()
    expect(iconPngBuffer(null)).toBeNull()
  })
})

describe('composeMacosIconPng', () => {
  const composedDir = path.join(userDataDir, 'icon-cache', 'composed')

  // 合成用的是 osascript(AppKit) + sips，只有 macOS 上有意义。
  // Android 图标是铺满画布的方形，不合成就会比 macOS 其他图标明显大一圈。
  it.runIf(process.platform === 'darwin')(
    '合成成 1024 见方，并且结果按内容缓存',
    async () => {
      const composed = await composeMacosIconPng(PNG_32X32)
      expect(composed).not.toBeNull()
      expect(pngSize(composed)).toEqual({ width: 1024, height: 1024 })

      // 第二次应当直接命中缓存（同内容同哈希），不再新落一份文件。
      const again = await composeMacosIconPng(PNG_32X32)
      expect(again?.equals(composed)).toBe(true)
      const files = await fs.readdir(composedDir)
      expect(files.filter((name) => name.endsWith('.png'))).toHaveLength(1)
    },
    30_000,
  )

  it.runIf(process.platform !== 'darwin')('非 macOS 原样返回', async () => {
    expect(await composeMacosIconPng(PNG_32X32)).toBe(PNG_32X32)
  })
})
