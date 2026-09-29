import { describe, expect, it } from 'vitest'

const { parseHelperReport } = await import('../../shared/storageVolumes.js')

// 2509FPN0BC（HyperOS / Android 16）上 `StorageMain 0` 的真实输出。
// 竞品在同一台机器上报「总共 528.0 GB、已用 255.8 GB、48%」，两个数都要能对上。
const HELPER_OUT =
  '{"volumes":[{"id":"internal","kind":"internal","description":null,"path":"/storage/emulated/0","totalBytes":528000000000,"freeBytes":272192565248,"entryCount":105}],"rootEntries":40}'

describe('parseHelperReport', () => {
  it('内部卷用服务给的卷容量，已用按「总量 − 可用」算', () => {
    const { volumes, summary } = parseHelperReport(HELPER_OUT)
    const internal = volumes.find((item) => item.id === 'internal')

    expect(internal).toMatchObject({
      id: 'internal',
      label: '内部存储',
      kind: 'shared',
      path: '/storage/emulated/0',
      totalBytes: 528000000000,
      usedBytes: 255807434752,
      availableBytes: 272192565248,
      percentUsed: 48,
      entryCount: 105,
    })
    expect(summary.totalBytes).toBe(528000000000)
    expect(summary.percentUsed).toBe(48)
  })

  it('相机从内部存储派生，排在最前且不冒充容量', () => {
    const { volumes } = parseHelperReport(HELPER_OUT)
    expect(volumes.map((item) => item.id)).toEqual(['camera', 'internal', 'root'])
    expect(volumes[0]).toMatchObject({
      id: 'camera',
      label: '相机存储',
      kind: 'camera',
      path: '/storage/emulated/0/DCIM',
      totalBytes: null,
      entryCount: null,
    })
  })

  it('根目录排在最后，只带条目数不带容量', () => {
    const root = parseHelperReport(HELPER_OUT).volumes.at(-1)
    expect(root).toMatchObject({ id: 'root', label: '根目录', path: '/', kind: 'root', entryCount: 40 })
    expect(root.totalBytes).toBeNull()
    expect(root.usedBytes).toBeNull()
  })

  it('可移动卷用设备给的名字，没有名字才退回「SD 卡」', () => {
    const out =
      '{"volumes":[{"id":"internal","kind":"internal","path":"/storage/emulated/0","totalBytes":100,"freeBytes":40,"entryCount":2},{"id":"3437-3536","kind":"portable","description":"SD 卡 3437-3536","path":"/storage/3437-3536","totalBytes":61079552000,"freeBytes":52068352000,"entryCount":7},{"id":"xyz","kind":"adopted","description":null,"path":"/storage/xyz","totalBytes":0,"freeBytes":0,"entryCount":-1}],"rootEntries":0}'
    const { volumes } = parseHelperReport(out)
    const byId = Object.fromEntries(volumes.map((item) => [item.id, item]))

    expect(byId['sd:3437-3536']).toMatchObject({
      label: 'SD 卡 3437-3536',
      kind: 'removable',
      percentUsed: 15,
    })
    expect(byId['sd:xyz'].label).toBe('SD 卡')
    // totalBytes 为 0 视为读不到，不画「0 字节用了 0%」；-1 是 helper 无权访问，与 0 项不同。
    expect(byId['sd:xyz']).toMatchObject({ totalBytes: null, usedBytes: null, percentUsed: null, entryCount: null })
    // rootEntries 是 0 就报 0 项，别和「看不见」混成一个空值。
    expect(byId.root).toMatchObject({ entryCount: 0 })
  })

  it('容忍 JSON 前后的 linker/ART 噪声', () => {
    const noisy = `WARNING: linker: ...\\n${HELPER_OUT}\nFailed to allocate`
    expect(parseHelperReport(noisy).summary.totalBytes).toBe(528000000000)
  })

  it('拿不到对象就报错，不给一张空表', () => {
    expect(() => parseHelperReport('StorageMain failed: ClassNotFoundException')).toThrow(
      'Helper 存储输出无法解析',
    )
  })
})
