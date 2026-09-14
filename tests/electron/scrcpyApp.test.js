import { describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-scrcpy-app-'))

vi.mock('electron', () => ({
  app: { getPath: (name) => (name === 'userData' ? userDataDir : '') },
}))

const { resolveScrcpyExecutable } = await import('../../electron/scrcpyApp.js')

// 32x32 纯色 PNG，仅用于让 sips 产出 icns。
const PNG_32X32 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAL0lEQVR4nO3OIQEAAAgDMLLRjcZ4iHEzMb/q2UsqAQEBAQEBAQEBAQEBAQGBdOABaxLol58gSrcAAAAASUVORK5CYII=',
  'base64',
)

async function makeSource() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-scrcpy-src-'))
  const binaryPath = path.join(dir, 'scrcpy')
  const serverPath = path.join(dir, 'scrcpy-server')
  await fs.writeFile(binaryPath, '#!/bin/sh\n', { mode: 0o755 })
  await fs.writeFile(serverPath, 'server')
  return { dir, binaryPath, serverPath }
}

describe.skipIf(process.platform !== 'darwin')('resolveScrcpyExecutable', () => {
  it('returns null without an icon', async () => {
    const { binaryPath, serverPath } = await makeSource()
    expect(await resolveScrcpyExecutable({ binaryPath, serverPath, iconPng: null })).toBeNull()
  })

  it('builds a bundle with the icon and reuses it', async () => {
    const { binaryPath, serverPath } = await makeSource()
    const executable = await resolveScrcpyExecutable({
      binaryPath,
      serverPath,
      iconPng: PNG_32X32,
      label: '示例应用',
    })

    expect(executable).not.toBeNull()
    const contents = path.dirname(path.dirname(executable))
    expect(await fs.readFile(path.join(contents, 'Info.plist'), 'utf8')).toContain(
      '<string>scrcpy</string>',
    )
    expect(await fs.readFile(path.join(contents, 'Resources', 'AppIcon.icns'))).toBeTruthy()
    expect(await fs.readFile(path.join(contents, 'MacOS', 'scrcpy-server'), 'utf8')).toBe('server')

    const again = await resolveScrcpyExecutable({
      binaryPath,
      serverPath,
      iconPng: PNG_32X32,
      label: '示例应用',
    })
    expect(again).toBe(executable)
  })

  it('keys the bundle by icon and label', async () => {
    const { binaryPath, serverPath } = await makeSource()
    const a = await resolveScrcpyExecutable({ binaryPath, serverPath, iconPng: PNG_32X32, label: 'A' })
    const b = await resolveScrcpyExecutable({ binaryPath, serverPath, iconPng: PNG_32X32, label: 'B' })
    expect(a).not.toBe(b)
  })
})
