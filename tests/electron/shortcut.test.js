import { describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('electron', () => ({
  app: {
    getPath: (name) => (name === 'desktop' ? process.env.AD_TEST_DESKTOP || '' : ''),
    setAsDefaultProtocolClient: vi.fn(),
  },
  ipcMain: { handle: vi.fn() },
  shell: { showItemInFolder: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
}))

const {
  buildMirrorUrl,
  buildShortcutContent,
  parseMirrorUrl,
  parseShortcutContent,
  sanitizeShortcutName,
  extractMirrorUrl,
  extractShortcutFile,
} = await import('../../electron/shortcutCore.js')
const { createAppShortcut, readShortcutFile } = await import('../../electron/shortcut.js')

describe('sanitizeShortcutName', () => {
  it('removes path separators and control characters', () => {
    expect(sanitizeShortcutName('微信/WeChat', 'fallback')).toBe('微信 WeChat')
    expect(sanitizeShortcutName('a:b*c?', 'fallback')).toBe('a b c')
    expect(sanitizeShortcutName('  ..hidden  ', 'fallback')).toBe('hidden')
  })

  it('falls back when label is empty', () => {
    expect(sanitizeShortcutName('', 'com.example.app')).toBe('com.example.app')
    expect(sanitizeShortcutName('   ', '')).toBe('AndDrive 投屏')
  })
})

describe('mirror url', () => {
  it('round-trips serial, package and label', () => {
    const request = {
      serial: '192.168.1.5:5555',
      packageName: 'com.example.app',
      label: '示例 & "应用"',
    }
    const url = buildMirrorUrl(request)
    expect(url.startsWith('anddrive://mirror?')).toBe(true)
    const parsed = parseMirrorUrl(url)
    expect(parsed).toEqual(request)
  })

  it('keeps the url free of shell-unsafe quotes', () => {
    const url = buildMirrorUrl({
      serial: '10.0.0.2:5555',
      packageName: 'com.example.app',
      label: 'a"b$c`d',
    })
    expect(url).not.toContain('"')
    expect(url).not.toContain('$')
    expect(url).not.toContain('`')
  })

  it('rejects unrelated or malformed urls', () => {
    expect(parseMirrorUrl('https://example.com')).toBeNull()
    expect(parseMirrorUrl('anddrive://other?address=a&package=b')).toBeNull()
    expect(parseMirrorUrl('anddrive://mirror?address=a')).toBeNull()
    expect(parseMirrorUrl('not a url')).toBeNull()
    expect(parseMirrorUrl(42)).toBeNull()
  })

  it('defaults label to package name when absent', () => {
    const url = buildMirrorUrl({ serial: '1.2.3.4:5555', packageName: 'com.a.b' })
    expect(parseMirrorUrl(url).label).toBe('com.a.b')
  })
})

describe('extractMirrorUrl', () => {
  it('finds the mirror url among argv entries', () => {
    const url = 'anddrive://mirror?address=a&package=b'
    expect(extractMirrorUrl(['/Applications/AndDrive.app/Contents/MacOS/AndDrive', url])).toBe(url)
    expect(extractMirrorUrl(['--foo', 'bar'])).toBeNull()
    expect(extractMirrorUrl(undefined)).toBeNull()
    expect(extractMirrorUrl([42, null])).toBeNull()
  })
})

describe('shortcut file', () => {
  it('round-trips a request through file content', () => {
    const request = {
      serial: '192.168.1.5:5555',
      packageName: 'com.example.app',
      label: '示例应用',
    }
    const parsed = parseShortcutContent(buildShortcutContent(request))
    expect(parsed).toEqual(request)
  })

  it('round-trips the app icon url', () => {
    const request = {
      serial: '192.168.1.5:5555',
      packageName: 'com.example.app',
      label: '示例应用',
      iconUrl: 'data:image/png;base64,iVBORw0KGgo=',
    }
    expect(parseShortcutContent(buildShortcutContent(request))).toEqual(request)
  })

  it('only accepts json-wrapped content', () => {
    const url = 'anddrive://mirror?address=a&package=com.a.b'
    expect(parseShortcutContent(JSON.stringify({ type: 'anddrive-mirror-shortcut', url }))).toEqual(
      parseMirrorUrl(url),
    )
    expect(parseShortcutContent(url)).toBeNull()
    expect(parseShortcutContent('')).toBeNull()
    expect(parseShortcutContent('{ not json')).toBeNull()
    expect(parseShortcutContent('https://example.com')).toBeNull()
    expect(parseShortcutContent(42)).toBeNull()
  })

  it('finds a .adr path among argv entries', () => {
    expect(extractShortcutFile(['/Applications/AndDrive.app/Contents/MacOS/AndDrive'])).toBeNull()
    expect(extractShortcutFile(['--foo', '/Users/me/Desktop/微信.adr'])).toBe(
      '/Users/me/Desktop/微信.adr',
    )
    expect(extractShortcutFile(['/tmp/App.ADR'])).toBe('/tmp/App.ADR')
    expect(extractShortcutFile(undefined)).toBeNull()
  })
})

describe('createAppShortcut', () => {
  it('writes a .adr shortcut file with the mirror url', async () => {
    const desktop = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-shortcut-'))
    process.env.AD_TEST_DESKTOP = desktop
    try {
      const result = await createAppShortcut({
        address: '192.168.1.5:5555',
        packageName: 'com.example.app',
        label: '示例应用',
      })

      expect(result.name).toBe('示例应用')
      expect(result.path.endsWith('示例应用.adr')).toBe(true)

      const parsed = await readShortcutFile(result.path)
      expect(parsed.serial).toBe('192.168.1.5:5555')
      expect(parsed.packageName).toBe('com.example.app')
      expect(parsed.label).toBe('示例应用')
    } finally {
      await fs.rm(desktop, { recursive: true, force: true })
      delete process.env.AD_TEST_DESKTOP
    }
  })

  it('rejects unsafe package names', async () => {
    await expect(
      createAppShortcut({ address: '1.2.3.4:5555', packageName: 'com.a; rm -rf /' }),
    ).rejects.toThrow('应用包名无效')
  })
})
