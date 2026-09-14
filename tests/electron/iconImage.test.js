import { describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-icon-image-'))

vi.mock('electron', () => ({
  app: { getPath: (name) => (name === 'userData' ? userDataDir : '') },
}))

const { composeMacosIconPng, iconPngBuffer, scrcpyIconDir } = await import(
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

describe('scrcpyIconDir', () => {
  it('writes scrcpy.png and reuses the same dir', async () => {
    const dir = await scrcpyIconDir(PNG_32X32)
    const file = path.join(dir, 'scrcpy.png')
    expect(await fs.readFile(file)).toEqual(PNG_32X32)
    expect(await scrcpyIconDir(PNG_32X32)).toBe(dir)
  })
})

describe.skipIf(process.platform !== 'darwin')('composeMacosIconPng', () => {
  it('returns the icon as-is when none is provided', async () => {
    expect(await composeMacosIconPng(null)).toBeNull()
  })

  it('draws the icon onto a padded 1024 canvas', async () => {
    const composed = await composeMacosIconPng(PNG_32X32)
    expect(composed.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(pngSize(composed)).toEqual({ width: 1024, height: 1024 })
  })

  it('caches the composed icon by content', async () => {
    const first = await composeMacosIconPng(PNG_32X32)
    const second = await composeMacosIconPng(PNG_32X32)
    expect(second.equals(first)).toBe(true)
  })
})
