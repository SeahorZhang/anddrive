import { describe, expect, it } from 'vitest'
import { formatBytes, formatStorage, clampPercent } from '../../src/utils/format.js'

// 512 GB 的机器被读成 477 GB 就是这么来的：字节没错，进制选错了。
const DEVICE_TOTAL = 512376156160

describe('formatStorage', () => {
  it('按 1000 进制读存储，GB 起带一位小数（对齐竞品读数）', () => {
    expect(formatStorage(528000000000)).toBe('528.0 GB')
    expect(formatStorage(255807434752)).toBe('255.8 GB')
    expect(formatStorage(272192565248)).toBe('272.2 GB')
    expect(formatStorage(DEVICE_TOTAL)).toBe('512.4 GB')
  })

  it('GB 以下取整，TB 仍带一位小数', () => {
    expect(formatStorage(1_500_000)).toBe('2 MB')
    expect(formatStorage(500_000)).toBe('500 KB')
    expect(formatStorage(2_500_000_000_000)).toBe('2.5 TB')
  })

  it('非正数与非数字都画成破折号', () => {
    expect(formatStorage(0)).toBe('—')
    expect(formatStorage(null)).toBe('—')
    expect(formatStorage(Number.NaN)).toBe('—')
  })
})

describe('formatBytes', () => {
  it('内存仍按 1024 进制', () => {
    expect(formatBytes(DEVICE_TOTAL)).toBe('477 GB')
    expect(formatBytes(3836524 * 1024)).toBe('3.7 GB')
  })
})

describe('clampPercent', () => {
  it('把非数字收成 0，并把越界值夹住', () => {
    expect(clampPercent(47)).toBe(47)
    expect(clampPercent(120)).toBe(100)
    expect(clampPercent(-5)).toBe(0)
    expect(clampPercent(undefined)).toBe(0)
  })
})
