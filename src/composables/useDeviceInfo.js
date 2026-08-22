import { useAdb } from './useAdb'

const emptyDevice = () => ({
  model: '',
  brand: '',
  deviceName: '',
  error: null,
})

export function useDeviceInfo(serial) {
  const { getDeviceInfo } = useAdb()
  const device = ref(emptyDevice())
  const loading = ref(false)
  const lastError = ref(null)

  const loadDeviceInfo = async () => {
    const currentSerial = typeof serial === 'function' ? serial() : serial
    if (!currentSerial) {
      device.value = emptyDevice()
      lastError.value = null
      return
    }

    loading.value = true
    lastError.value = null
    try {
      device.value = { ...(await getDeviceInfo(currentSerial)), error: null }
    } catch (error) {
      const message = error?.message || '获取设备信息失败'
      device.value = { ...emptyDevice(), error: message }
      lastError.value = message
    } finally {
      loading.value = false
    }
  }

  return { device, loading, lastError, loadDeviceInfo }
}
