<script setup>
import PageHome from "./components/home/index.vue";
import PageSettings from "./components/Settings.vue";
import { Toaster } from "vue-sonner";
import { connectApi, disconnectApi, listConnectDevicesApi, getConnectedDeviceApi } from "@/api";
import { readableError } from "@/utils/errors";
import { notifyError } from "@/composables/useNotifications";

const DISCOVERY_INTERVAL_MS = 1000;

const pageType = ref("loading"); // loading | home | addDevice | settings
const settingsReturn = ref("addDevice");
const deviceDialogVisible = ref(false);
const device = ref(null);
const discoveredDevices = ref([]);
const disconnecting = ref(false);
const disconnectError = ref("");

// 接管已连接设备并进入首页（设备已在 adb devices 中，无需再次 connect）
function adoptDevice(target) {
  device.value = target;
  deviceDialogVisible.value = false;
  pageType.value = "home";
}

// 先 adb connect 再进入首页
async function connectTo(target) {
  try {
    await connectApi(target.address);
    adoptDevice(target);
  } catch (e) {
    notifyError(e, {
      title: "连接设备失败",
      action: { label: "重试", handler: () => connectTo(target) },
    });
  }
}

const connect = async () => {
  // 电脑已通过其他工具连上手机时，直接接管该连接进首页
  try {
    const connected = await getConnectedDeviceApi();
    if (connected) {
      adoptDevice(connected);
      return;
    }
  } catch (e) {
    console.error("获取已连接设备失败：", e);
  }

  device.value = null;
  pageType.value = "addDevice";
};

// 持续发现手机服务：只在未连接时轮询，连接后立即停止
// autoAdopt：启动后若发现已有连接（可能别的程序连的）自动进首页；
// 用户主动断开后不再自动接管，改为手动从列表选择。
let autoAdopt = true;
let discoveryRunning = false;
async function discoverLoop() {
  if (discoveryRunning) return;
  discoveryRunning = true;
  while (!device.value) {
    try {
      const devices = await listConnectDevicesApi();
      if (device.value) break;
      const connected = autoAdopt ? devices.find((d) => d.connected) : null;
      if (connected) {
        adoptDevice(connected);
        break;
      }
      discoveredDevices.value = devices;
    } catch (e) {
      console.error("发现设备失败：", e);
    }
    await new Promise((resolve) => setTimeout(resolve, DISCOVERY_INTERVAL_MS));
  }
  discoveryRunning = false;
}

onMounted(() => {
  connect();
  discoverLoop();
});

function connectDevice(target) {
  if (!target) return;
  adoptDevice(target);
}

async function disconnect() {
  if (!device.value) return;
  disconnecting.value = true;
  disconnectError.value = "";
  try {
    await disconnectApi(device.value.address);
    device.value = null;
    autoAdopt = false;
    pageType.value = "addDevice";
    discoverLoop();
  } catch (e) {
    disconnectError.value = readableError(e, "断开连接失败");
  } finally {
    disconnecting.value = false;
  }
}

function openSettings() {
  settingsReturn.value = pageType.value === "home" ? "home" : "addDevice";
  pageType.value = "settings";
}

function closeSettings() {
  pageType.value = settingsReturn.value;
}
</script>

<template>
  <PageHeader :pageType="pageType" :disconnecting="disconnecting" :disconnect-error="disconnectError"
    :devices="discoveredDevices" @disconnect="disconnect" @open-settings="openSettings" @close-settings="closeSettings"
    @connect-device="connectDevice" />

  <div v-if="pageType === 'loading'" class="flex flex-1 items-center justify-center">
    <span class="size-5 animate-spin rounded-full border-2 border-black/10 border-t-[#007aff]" aria-label="加载中" />
  </div>

  <PageHome v-else-if="pageType === 'home'" :device="device" />

  <PageSettings v-else-if="pageType === 'settings'" />

  <AddDevice v-else-if="pageType === 'addDevice'" v-model="deviceDialogVisible" />
  <AddDeviceDialog v-model="deviceDialogVisible" @paired="connectTo" />

  <Toaster position="top-right" theme="light" rich-colors close-button :offset="12" :visible-toasts="4" />
</template>
