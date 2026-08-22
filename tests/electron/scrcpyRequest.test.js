import { describe, expect, it } from 'vitest'
import { buildScrcpyArgs, validateScrcpyRequest } from '../../electron/scrcpy/scrcpyRequest.js'

const validRequest = {
  serial: 'device:5555',
  packageName: 'com.example.app',
  label: 'Example App',
  iconDataUrl: 'data:image/png;base64,AQ==',
}

describe('validateScrcpyRequest', () => {
  it('returns a validated domain request', () => {
    expect(validateScrcpyRequest(validRequest)).toEqual(validRequest)
  })

  it.each([null, undefined, 'request'])('rejects invalid request objects', (value) => {
    expect(() => validateScrcpyRequest(value)).toThrow('启动参数无效')
  })

  it.each(['', 1, 'x'.repeat(257)])('rejects invalid serials', (serial) => {
    expect(() => validateScrcpyRequest({ ...validRequest, serial })).toThrow('设备序列号无效')
  })

  it.each(['', 1, 'x'.repeat(257)])('rejects invalid package names', (packageName) => {
    expect(() => validateScrcpyRequest({ ...validRequest, packageName })).toThrow('应用包名无效')
  })

  it.each([1, 'x'.repeat(513)])('rejects invalid labels', (label) => {
    expect(() => validateScrcpyRequest({ ...validRequest, label })).toThrow('应用名称无效')
  })

  it.each([
    '',
    'data:text/plain;base64,AQ==',
    1,
    `data:image/png;base64,${'A'.repeat(1024 * 1024)}`,
  ])('rejects invalid icon data URLs', (iconDataUrl) => {
    expect(() => validateScrcpyRequest({ ...validRequest, iconDataUrl })).toThrow('应用图标无效')
  })
})

describe('buildScrcpyArgs', () => {
  it('builds args from domain data with the shared display and bitrate policy', () => {
    expect(buildScrcpyArgs(validRequest)).toEqual([
      '-s',
      'device:5555',
      '--new-display=1920x1080/320',
      '--start-app=com.example.app',
      '--video-codec=h265',
      '-b',
      '24M',
      '--window-x=auto',
      '--window-y=auto',
      '--window-title=Example App',
    ])
  })

  it('falls back to the package name for the window title when label is empty', () => {
    const args = buildScrcpyArgs({ ...validRequest, label: '' })
    expect(args.at(-1)).toBe('--window-title=com.example.app')
  })
})
