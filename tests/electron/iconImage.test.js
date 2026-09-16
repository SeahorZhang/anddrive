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
