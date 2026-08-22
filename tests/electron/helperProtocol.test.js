import { describe, expect, it } from 'vitest'
import { parseIconBatch } from '../../electron/helper/helperProtocol.js'

function iconFrame(packageName, icon) {
  const name = Buffer.from(packageName)
  const body = Buffer.from(icon)
  const header = Buffer.alloc(2 + name.length + 4)
  header.writeUInt16BE(name.length, 0)
  name.copy(header, 2)
  header.writeUInt32BE(body.length, 2 + name.length)
  return Buffer.concat([header, body])
}

describe('parseIconBatch', () => {
  it('parses multiple big-endian frames and skips empty icons', () => {
    const buffer = Buffer.concat([
      iconFrame('com.one', [1, 2, 3]),
      iconFrame('com.empty', []),
      iconFrame('com.two', [4]),
    ])
    expect(parseIconBatch(buffer)).toEqual([
      { packageName: 'com.one', iconUrl: 'data:image/png;base64,AQID' },
      { packageName: 'com.two', iconUrl: 'data:image/png;base64,BA==' },
    ])
  })

  it('returns complete frames before a truncated frame', () => {
    const valid = iconFrame('com.one', [1])
    const truncated = iconFrame('com.two', [2, 3]).subarray(0, -1)
    expect(parseIconBatch(Buffer.concat([valid, truncated]))).toEqual([
      { packageName: 'com.one', iconUrl: 'data:image/png;base64,AQ==' },
    ])
  })

  it('rejects a zero-length package frame without throwing', () => {
    expect(parseIconBatch(Buffer.from([0, 0]))).toEqual([])
  })
})
