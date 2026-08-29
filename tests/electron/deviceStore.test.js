import { beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const state = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => state.userData },
}))

const { listSavedDevices, saveDevice } = await import('../../electron/cache/deviceStore.js')

beforeEach(async () => {
  state.userData = await fs.mkdtemp(path.join(os.tmpdir(), 'anddrive-devices-'))
})

describe('deviceStore', () => {
  it('starts empty and saves a valid device', async () => {
    expect(await listSavedDevices()).toEqual([])
    const saved = await saveDevice({
      serial: '192.168.1.9:39957',
      address: '192.168.1.9:39957',
      deviceName: '2509FPN0BC',
    })
    expect(saved.serial).toBe('192.168.1.9:39957')
    const list = await listSavedDevices()
    expect(list).toHaveLength(1)
    expect(list[0].savedAt).toBeGreaterThan(0)
  })

  it('upserts by serial and keeps newest first', async () => {
    await saveDevice({ serial: 'a', deviceName: 'A' })
    await saveDevice({ serial: 'b', deviceName: 'B' })
    await saveDevice({ serial: 'a', deviceName: 'A2' })
    const list = await listSavedDevices()
    expect(list.map((d) => d.serial)).toEqual(['a', 'b'])
    expect(list[0].deviceName).toBe('A2')
  })

  it('rejects invalid payloads without writing', async () => {
    await saveDevice({ serial: 'keep' })
    await expect(saveDevice({ serial: '' })).rejects.toThrow()
    await expect(saveDevice({})).rejects.toThrow()
    const list = await listSavedDevices()
    expect(list).toHaveLength(1)
  })

  it('merges field-wise: empty new values keep saved ones', async () => {
    await saveDevice({
      serial: 'adb-x._tcp',
      address: '192.168.100.91:39957',
      deviceName: 'Xiaomi 17 Pro Max',
    })
    const merged = await saveDevice({ serial: 'adb-x._tcp', deviceName: '' })
    expect(merged.address).toBe('192.168.100.91:39957')
    expect(merged.deviceName).toBe('Xiaomi 17 Pro Max')
  })

  it('caps the stored list at 20 entries', async () => {
    for (let i = 0; i < 25; i++) await saveDevice({ serial: `s${i}` })
    const list = await listSavedDevices()
    expect(list).toHaveLength(20)
    expect(list[0].serial).toBe('s24')
  })
})
