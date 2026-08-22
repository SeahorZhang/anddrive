import { describe, expect, it } from 'vitest'
import { buildScrcpyRequest } from '../../electron/scrcpyRequest.js'

const validInput = {
  serial: 'device:5555',
  packageName: 'com.example.app',
  label: 'Example',
  iconDataUrl: 'data:image/png;base64,AQ==',
}

describe('buildScrcpyRequest', () => {
  it('builds the scrcpy CLI invocation from domain data', () => {
    expect(buildScrcpyRequest(validInput)).toEqual({
      args: [
        '-s',
        'device:5555',
        '--new-display=1920x1080/320',
        '--start-app=com.example.app',
        '--video-codec=h265',
        '-b',
        '24M',
        '--window-x=auto',
        '--window-y=auto',
        '--window-title=Example',
      ],
      iconDataUrl: 'data:image/png;base64,AQ==',
    })
  })

  it.each([null, undefined, 'request'])('rejects invalid request objects', (value) => {
    expect(() => buildScrcpyRequest(value)).toThrow('启动参数无效')
  })

  it.each(['', 1, 'a b', 'x'.repeat(1025)])('rejects invalid serials', (serial) => {
    expect(() => buildScrcpyRequest({ ...validInput, serial })).toThrow('设备序列号无效')
  })

  it.each(['', 1, 'x'.repeat(257)])('rejects invalid package names', (packageName) => {
    expect(() => buildScrcpyRequest({ ...validInput, packageName })).toThrow('应用包名无效')
  })

  it.each(['', 1, 'x'.repeat(257)])('rejects invalid labels', (label) => {
    expect(() => buildScrcpyRequest({ ...validInput, label })).toThrow('应用名称无效')
  })

  it.each([
    '',
    'data:text/plain;base64,AQ==',
    1,
    `data:image/png;base64,${'A'.repeat(1024 * 1024)}`,
  ])('rejects invalid icon data URLs', (iconDataUrl) => {
    expect(() => buildScrcpyRequest({ ...validInput, iconDataUrl })).toThrow('应用图标无效')
  })
})
