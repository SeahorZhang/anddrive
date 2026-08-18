import { describe, expect, it } from 'vitest'
import { validateScrcpyRequest } from '../../electron/scrcpyRequest.js'

const validRequest = {
  args: ['-s', 'device:5555', '--start-app=com.example.app'],
  packageName: 'com.example.app',
  iconDataUrl: 'data:image/png;base64,AQ==',
}

describe('validateScrcpyRequest', () => {
  it('returns a validated request', () => {
    expect(validateScrcpyRequest(validRequest)).toEqual(validRequest)
  })

  it.each([null, undefined, 'request'])('rejects invalid request objects', (value) => {
    expect(() => validateScrcpyRequest(value)).toThrow('启动参数无效')
  })

  it.each([[], Array.from({ length: 33 }, () => 'arg'), [''], [1], ['x'.repeat(1025)]])(
    'rejects invalid args',
    (args) => {
      expect(() => validateScrcpyRequest({ ...validRequest, args })).toThrow('scrcpy 参数无效')
    },
  )

  it.each(['', 1, 'x'.repeat(257)])('rejects invalid package names', (packageName) => {
    expect(() => validateScrcpyRequest({ ...validRequest, packageName })).toThrow('应用包名无效')
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
