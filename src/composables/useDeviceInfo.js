export function useDeviceInfo(serial) {
  const device = ref({
    model: '',
    brand: '',
    deviceName: '',
    battery: -1,
    isCharging: false,
    storage: '0/0 GB',
    storagePercent: 0,
    error: null,
  });

  const loading = ref(false);
  const lastError = ref(null);

  const loadDeviceInfo = async () => {
    if (!serial) {
      device.value = {
        model: '',
        brand: '',
        deviceName: '',
        battery: -1,
        isCharging: false,
        storage: '0/0 GB',
        storagePercent: 0,
        error: null,
      };
      return;
    }

    loading.value = true;
    lastError.value = null;
    device.value.error = null;

    try {
      const api = window.electronAPI?.adb;

      if (!api || typeof api.getprop !== 'function') {
        throw new Error('ADB API not available');
      }

      // 并行获取所有设备信息（添加 fallback 保护）
      const [
        modelOutput,
        brandOutput,
        marketnameOutput,
        batteryOutput,
        storageOutput,
        // fallback 存储命令（防止 df -h 失败）
        storageFallback
      ] = await Promise.all([
        api.getprop(serial, "ro.product.model").catch(() => "Unknown"),
        api.getprop(serial, "ro.product.brand").catch(() => ""),
        api.getprop(serial, "ro.product.marketname").catch(() => ""),
        api.dumpsys(serial, "battery").catch(() => ""),
        api.df(serial, "-h").catch(() => "0/0"),
        api.df(serial, "-h").catch(() => "0/0"),
      ]);

      // 品牌 + 型号组合（marketname 优先）
      let deviceName = "";
      const brand = brandOutput.trim();
      const marketname = marketnameOutput.trim();
      if (marketname) {
        deviceName = marketname;
      } else if (brand) {
        deviceName = `${brand} ${modelOutput.trim()}`.trim();
      } else {
        deviceName = modelOutput.trim() || "未知设备";
      }

      // 解析电量
      let battery = -1;
      let isCharging = false;
      const batteryMatch = batteryOutput.match(/level:\s*(\d+)/);
      if (batteryMatch) {
        battery = parseInt(batteryMatch[1], 10);
        // 检查充电状态（dumpsys battery 格式：status: 2 表示充电）
        const statusMatch = batteryOutput.match(/status:\s*(\d+)/);
        isCharging = statusMatch?.[1] === "2";
      }

      // 解析存储空间（df -h 格式：如 "Data  59G  10G  49G  17%"）
      let storage = "0/0 GB";
      let storagePercent = 0;
      if (storageOutput && storageOutput.includes("/")) {
        const lines = storageOutput.trim().split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.endsWith(" /data") || trimmed.includes("Data")) {
            const parts = trimmed.split(/\s+/).filter(Boolean);
            if (parts.length >= 5) {
              const used = parts[2] || "0";
              const total = parts[1] || "0";
              const percent = parseInt(parts[4] || "0", 10) || 0;
              storage = `${used}/${total} GB`;
              storagePercent = percent;
              break;
            }
          }
        }
      } else {
        // fallback 解析
        const parts = storageFallback.match(/(\d+)[GMK]/);
        if (parts) {
          const total = parts[1];
          storage = `0/${total} GB`;
          storagePercent = 0;
        }
      }

      device.value = {
        model: modelOutput.trim(),
        brand: brandOutput.trim(),
        deviceName,
        battery,
        isCharging,
        storage,
        storagePercent,
        error: null,
      };

      lastError.value = null;
    } catch (err) {
      console.error("获取设备信息失败:", err);
      device.value.error = err.message || "获取设备信息失败";
      lastError.value = err.message || "获取设备信息失败";
    } finally {
      loading.value = false;
    }
  };

  return { device, loading, lastError, loadDeviceInfo };
}
