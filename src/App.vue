<script setup>
import PageHome from "./components/home/index.vue";
import PageSettings from "./components/Settings.vue";
import { Toaster } from "vue-sonner";
import {
  connectApi,
  disconnectApi,
  listConnectDevicesApi,
  getConnectedDeviceApi,
  getDeviceStateApi,
  reconnectApi,
} from "@/api";
import { readableError } from "@/utils/errors";
import { notify, notifyError } from "@/composables/useNotifications";
import { autoReconnect } from "@/composables/useConnectionPreferences";

const DISCOVERY_INTERVAL_MS = 1000;
/** 连接健康检查间隔 */
const HEARTBEAT_INTERVAL_MS = 5000;
/** 自动重连尝试间隔 */
const RECONNECT_INTERVAL_MS = 3000;
/** 自动重连最大尝试次数（约 30s），失败后回落到添加设备页继续发现 */
const MAX_RECONNECT_ATTEMPTS = 10;
/** 连接状态通知的固定 key，用于原地更新同一条 toast */
const CONNECTION_TOAST_KEY = "connection";

const pageType = ref("loading"); // loading | home | addDevice | settings
const settingsReturn = ref("addDevice");
const deviceDialogVisible = ref(false);
const device = ref(null);
const discoveredDevices = ref([]);
const disconnecting = ref(false);
const disconnectError = ref("");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 断线后记住的设备，供自动重连使用 */
let lostDevice = null;
/** 启动后若发现已有连接则自动接管；用户主动断开后不再自动接管 */
let autoAdopt = true;

// ---------------------------------------------------------------------------
// 连接健康检查
// ---------------------------------------------------------------------------

let healthRunning = false;
/** 心跳：设备已连接时轮询其 adb 状态，掉线后进入重连或离线分支 */
async function healthLoop() {
  if (healthRunning) return;
  healthRunning = true;
  while (device.value) {
    const current = device.value;
    const state = await getDeviceStateApi(current.address).catch(() => null);
    if (device.value !== current) continue;
    if (state && state !== "device") {
      handleConnectionLost(current, state);
      break;
    }
    await sleep(HEARTBEAT_INTERVAL_MS);
  }
  healthRunning = false;
}

/**
 * 区分「设备离线」与「transport 断开」：
 * offline / unauthorized 表示设备仍登记在 adb 中但不可通信；absent 表示连接已断开。
 */
function handleConnectionLost(target, state) {
  if (device.value !== target) return;
  device.value = null;
  lostDevice = target;
  const label = target.label || target.name || "设备";
  const offline = state === "offline" || state === "unauthorized";
  const title = offline ? "设备离线" : "连接已断开";

  if (autoReconnect.value && autoAdopt) {
    notify.loading(`正在尝试恢复与 ${label} 的连接…`, {
      key: CONNECTION_TOAST_KEY,
      title,
    });
    pageType.value = "loading";
    startRecovery(target);
    return;
  }

  notify.error(offline ? "设备暂时无法访问，请检查网络后重试" : "与设备的无线连接已断开", {
    key: CONNECTION_TOAST_KEY,
    title,
    action: {
      label: "重新连接",
      handler: () => {
        autoAdopt = true;
        pageType.value = "loading";
        notify.loading(`正在尝试恢复与 ${label} 的连接…`, {
          key: CONNECTION_TOAST_KEY,
          title: "重新连接",
        });
        startRecovery(target);
      },
    },
  });
  pageType.value = "addDevice";
  discoverLoop();
}

// ---------------------------------------------------------------------------
// 自动重连
// ---------------------------------------------------------------------------

let recoveryRunning = false;
async function startRecovery(target) {
  if (recoveryRunning) return;
  recoveryRunning = true;
  for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS && !device.value; attempt += 1) {
    if (!autoReconnect.value) break;

    // 其他工具可能已经连上，直接接管
    const existing = await getConnectedDeviceApi().catch(() => null);
    if (existing) {
      adoptDevice(existing);
      notify.success("已重新连接设备", { key: CONNECTION_TOAST_KEY, title: "连接已恢复" });
      break;
    }

    // 主动 adb connect，成功后重新读取设备（connect 后 serial 会变成 host:port）
    const result = await reconnectApi(target?.address).catch(() => null);
    if (result?.online) {
      const fresh = await getConnectedDeviceApi().catch(() => null);
      adoptDevice(fresh || target);
      notify.success("已重新连接设备", { key: CONNECTION_TOAST_KEY, title: "连接已恢复" });
      break;
    }
    await sleep(RECONNECT_INTERVAL_MS);
  }
  recoveryRunning = false;

  if (!device.value) {
    if (autoReconnect.value) {
      notify.error("自动重连失败，请手动连接设备", {
        key: CONNECTION_TOAST_KEY,
        title: "重连失败",
        action: {
          label: "重试",
          handler: () => {
            autoAdopt = true;
            pageType.value = "loading";
            startRecovery(lostDevice);
          },
        },
      });
    } else {
      notify.dismiss(CONNECTION_TOAST_KEY);
    }
    pageType.value = "addDevice";
    autoAdopt = true;
    discoverLoop();
  }
}

// ---------------------------------------------------------------------------
// 连接 / 发现
// ---------------------------------------------------------------------------

// 接管已连接设备并进入首页（设备已在 adb devices 中，无需再次 connect）
function adoptDevice(target) {
  device.value = target;
  deviceDialogVisible.value = false;
  lostDevice = null;
  autoAdopt = true;
  pageType.value = "home";
  healthLoop();
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

// 持续发现手机服务：只在未连接时轮询，连接后立即停止。
// 用递增令牌让后一次调用取代上一次，避免旧的发现循环卡住导致重连后无人发现。
let discoveryToken = 0;
async function discoverLoop() {
  const token = ++discoveryToken;
  while (!device.value && token === discoveryToken) {
    try {
      const devices = await listConnectDevicesApi();
      if (device.value || token !== discoveryToken) break;
      const connected = autoAdopt ? devices.find((d) => d.connected) : null;
      if (connected) {
        adoptDevice(connected);
        break;
      }
      discoveredDevices.value = devices;
    } catch (e) {
      console.error("发现设备失败：", e);
    }
    await sleep(DISCOVERY_INTERVAL_MS);
  }
}

onMounted(() => {
  connect();
  discoverLoop();
});

function connectDevice(target) {
  if (!target) return;
  autoAdopt = true;
  adoptDevice(target);
}

async function disconnect() {
  if (!device.value) return;
  disconnecting.value = true;
  disconnectError.value = "";
  try {
    await disconnectApi(device.value.address);
    device.value = null;
    lostDevice = null;
    autoAdopt = false;
    notify.dismiss(CONNECTION_TOAST_KEY);
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
