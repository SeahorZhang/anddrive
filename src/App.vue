<script setup>
import PageHome from "./components/home/index.vue";
import PageSettings from "./components/Settings.vue";
import { Toaster } from "vue-sonner";
import {
  connectApi,
  disconnectApi,
  releaseDeviceApi,
  listConnectDevicesApi,
  getConnectedDeviceApi,
  reconnectApi,
  onMirrorResultApi,
  onMirrorExitApi,
} from "@/api";
import { readableError } from "@/utils/errors";
import {
  transportState,
  sameDevice,
  markDevicesKnown,
  watchNewConnectedDevices,
  pickAdoptableDevice,
} from "@/utils/deviceState";
import { notify, notifyError } from "@/composables/useNotifications";
import { autoReconnect } from "@/composables/useConnectionPreferences";
import { isDark } from "@/composables/useTheme";
import {
  startScrcpySessionPolling,
  stopScrcpySessionPolling,
  refreshScrcpySessions,
} from "@/composables/useScrcpySessions";

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
const settingsReturn = ref("home");
const deviceDialogVisible = ref(false);
const device = ref(null);
const discoveredDevices = ref([]);
const disconnecting = ref(false);
const disconnectError = ref("");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 首页与顶栏显示的当前设备：展示字段（名称、接法标记、状态）跟着设备列表那一行走，
 * 拔了线那枚 USB 就跟着少掉；address 仍钉在会话正在用的那条 transport 上，
 * 免得列表刷新把镜像和面板挪到另一条连接去。
 */
const activeDevice = computed(() => {
  const current = device.value;
  if (!current) return null;
  const row = discoveredDevices.value.find((d) => sameDevice(d, current));
  return row ? { ...row, address: current.address, transport: current.transport } : current;
});

/** 断线后记住的设备，供自动重连使用 */
let lostDevice = null;
/** 启动后若发现已有连接则自动接管；用户主动断开后不再自动接管 */
let autoAdopt = true;
/** 快捷方式唤起投屏结果的取消订阅函数 */
let disposeMirrorResult = null;
/** 原生镜像意外结束的取消订阅函数 */
let disposeMirrorExit = null;

// ---------------------------------------------------------------------------
// 连接健康检查
// ---------------------------------------------------------------------------

// 心跳顺带盯着新设备：插了另一台手机时不动当前这台，只在右上角提醒可以连接。
/** 已经见过的设备 stableId（按轮次差集用），从列表消失后摘掉，再插回来算新设备 */
const seenDevices = new Set();
const NEW_DEVICE_TOAST_PREFIX = "new-device:";

function notifyNewDevices(devices) {
  for (const fresh of watchNewConnectedDevices(devices, seenDevices, device.value)) {
    const label = fresh.label || fresh.name || fresh.address;
    notify({
      key: NEW_DEVICE_TOAST_PREFIX + fresh.stableId,
      title: "新设备",
      message: `发现 ${label}，可以连接`,
      duration: 0,
      action: { label: "连接", handler: () => switchDevice(fresh) },
    });
  }
}

let healthRunning = false;
/** 心跳：设备已连接时轮询其 adb 状态，掉线后进入重连或离线分支 */
async function healthLoop() {
  if (healthRunning) return;
  healthRunning = true;
  while (device.value) {
    const current = device.value;
    let state = null;
    try {
      const devices = await refreshDeviceList();
      state = transportState(devices, current.address);
      notifyNewDevices(devices);
    } catch (e) {
      console.error("心跳刷新设备列表失败：", e);
    }
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
 * 设备列表的唯一一份数据：下拉、首页上方的接法标记和心跳都读它，
 * 免得同一个「这台现在怎么连着」的问题在几处各问一遍 adb。
 */
async function refreshDeviceList() {
  const devices = await listConnectDevicesApi();
  discoveredDevices.value = devices;
  return devices;
}

/**
 * 区分「设备离线」与「transport 断开」：
 * offline / unauthorized 表示设备仍登记在 adb 中但不可通信；absent 表示连接已断开。
 */
function handleConnectionLost(target, state) {
  if (device.value !== target) return;
  device.value = null;
  // 设备没了就没有「这台能编什么」可问，设置页不许停留在无设备状态（入口也只在首页给）。
  if (pageType.value === "settings") pageType.value = "addDevice";
  lostDevice = target;
  const label = target.label || target.name || "设备";
  const usb = target.transport === "usb";
  const offline = ["offline", "unauthorized", "authorizing"].includes(state);
  const title = offline ? "设备离线" : "连接已断开";
  const offlineHint = usb
    ? "请检查数据线，并在手机上允许 USB 调试"
    : "设备暂时无法访问，请检查网络后重试";
  const lostHint = usb ? "USB 连接已断开，请检查数据线" : "与设备的无线连接已断开";

  if (autoReconnect.value && autoAdopt) {
    notify.loading(`正在尝试恢复与 ${label} 的连接…`, {
      key: CONNECTION_TOAST_KEY,
      title,
    });
    pageType.value = "loading";
    startRecovery(target);
    return;
  }

  notify.error(offline ? offlineHint : lostHint, {
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

    // 其他工具可能已经连上，直接接管 —— 但只接管**丢的那台**。
    // 曾经这里无条件 adopt，结果 USB 一抖就 adopt 到列表里另一台无线的手机上。
    const existing = await getConnectedDeviceApi().catch(() => null);
    if (existing && sameDevice(existing, target)) {
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
  // 接管这一台之前列表里就有的其他设备不算「新出现」，别在进首页那一秒弹提醒。
  // 种子必须含这台自己：扫码页只把扫码那条写进列表，USB 那台往往不在里面。
  markDevicesKnown([...discoveredDevices.value, target], seenDevices);
  pageType.value = "home";
  healthLoop();
}

// 换台设备前给上一台收摊：只释放存储 / 连接池 / 缓存，transport 留在 adb 里，
// 这样设备列表里它还在，随时能切回去（无线那台也不用重新 connect）。
// 上一台**已经开着的镜像不动**：切设备是换首页在看谁，不是关掉在投的画面。
async function releasePrevious(target) {
  const previous = device.value;
  if (!previous || sameDevice(previous, target)) return;
  try {
    await releaseDeviceApi(previous.address, { keepMirror: true });
  } catch (e) {
    // 收摊失败不该拦住切换：残留资源会在下次断开或退出时再清一次。
    console.error("释放上一台设备失败：", e);
  }
}

// 先 adb connect 再进入首页
async function connectTo(target) {
  try {
    await connectApi(target.address);
    await releasePrevious(target);
    adoptDevice(target);
  } catch (e) {
    notifyError(e, {
      title: "连接设备失败",
      action: { label: "重试", handler: () => connectTo(target) },
    });
  }
}

// 从首页右上角的下拉切到另一台：上一台收摊 → 接管新的这台。
// 首页各面板按 `:key="device.address"` 重挂，切过去会重新拉数据。
const switching = ref(false);
async function switchDevice(target) {
  if (!target?.connected || switching.value) return;
  if (device.value && sameDevice(target, device.value)) return;
  switching.value = true;
  try {
    await releasePrevious(target);
    adoptDevice(target);
    // 不弹「已切换」：顶栏那行设备名就是反馈，再多一条 toast 只是挡视线。
  } finally {
    switching.value = false;
  }
}

/** 下拉里的「扫码配对新设备」：二维码弹窗始终挂着，直接打开即可。 */
function openPairDialog() {
  deviceDialogVisible.value = true;
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
      const devices = await refreshDeviceList();
      if (device.value || token !== discoveryToken) break;
      // 扫码弹窗开着时**不接管**：人正盯着弹窗里的「可用设备」，自动进首页会把那份
      // 列表直接抽走。多台在线时也不接管，规则在 `pickAdoptableDevice`。
      const connected =
        autoAdopt && !deviceDialogVisible.value ? pickAdoptableDevice(devices) : null;
      if (connected) {
        adoptDevice(connected);
        break;
      }
    } catch (e) {
      console.error("发现设备失败：", e);
    }
    await sleep(DISCOVERY_INTERVAL_MS);
  }
}

// 首页的设备下拉只在展开期间轮询：连着设备时靠心跳那一轮就够，
// 不额外给 adb 加一条常驻的每秒请求；收起立刻用令牌停掉在途的循环。
let menuDevicesToken = 0;
async function startMenuDevicesPolling() {
  const token = ++menuDevicesToken;
  while (token === menuDevicesToken) {
    try {
      await refreshDeviceList();
      if (token !== menuDevicesToken) break;
    } catch (e) {
      console.error("刷新设备列表失败：", e);
    }
    await sleep(DISCOVERY_INTERVAL_MS);
  }
}

function stopMenuDevicesPolling() {
  menuDevicesToken += 1;
}

function onDeviceMenuChange(open) {
  if (open) startMenuDevicesPolling();
  else stopMenuDevicesPolling();
}

onMounted(() => {
  connect();
  discoverLoop();
  startScrcpySessionPolling();
  disposeMirrorResult = onMirrorResultApi((result) => {
    if (result.ok) {
      notify.success(`已从桌面快捷方式启动 ${result.label}`, { title: "镜像已开启" });
      refreshScrcpySessions();
    } else {
      notify.error(result.message || "启动镜像失败", { title: `启动 ${result.label} 失败` });
    }
  });
  disposeMirrorExit = onMirrorExitApi((result) => {
    notify.error(result.message || "镜像已结束", { title: `${result.label} 镜像已结束` });
    refreshScrcpySessions();
  });
});

onUnmounted(() => {
  stopScrcpySessionPolling();
  disposeMirrorResult?.();
  disposeMirrorExit?.();
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

/**
 * 下拉里断开一台不在用的设备：它名下的每条 transport 都摘掉，
 * 只摘代表那条会留下另一条，看起来就像「断开没生效」。
 */
async function disconnectListedDevice(target) {
  if (!target) return;
  // 列表是按秒刷的，理论上会点到已经变成当前设备的那行 —— 那就走带收摊的正式断开。
  if (device.value && sameDevice(target, device.value)) {
    await disconnect();
    return;
  }
  const addresses = target.connections?.length
    ? target.connections.map((c) => c.address)
    : [target.address];
  for (const address of addresses) {
    try {
      await disconnectApi(address);
    } catch (e) {
      console.error("断开设备失败：", e);
    }
  }
  try {
    await refreshDeviceList();
  } catch (e) {
    console.error("刷新设备列表失败：", e);
  }
}

function openSettings() {
  settingsReturn.value = pageType.value;
  pageType.value = "settings";
}

function closeSettings() {
  pageType.value = settingsReturn.value;
}
</script>

<template>
  <PageHeader :pageType="pageType" :disconnecting="disconnecting" :disconnect-error="disconnectError"
    :devices="discoveredDevices" :active-device="activeDevice"
    @disconnect="disconnect" @disconnect-device="disconnectListedDevice" @open-settings="openSettings"
    @close-settings="closeSettings" @switch-device="switchDevice"
    @device-menu-change="onDeviceMenuChange" @add-device="openPairDialog" />

  <div v-if="pageType === 'loading'" class="flex flex-1 items-center justify-center">
    <span class="size-5 animate-spin rounded-full border-2 border-line border-t-accent" aria-label="加载中" />
  </div>

  <!-- 按设备地址重挂：AppList / DeviceStats 只在挂载时拉一次数据，不换 key 的话
       在首页直接连另一台设备会留着上一台的列表。 -->
  <PageHome v-else-if="pageType === 'home'" :key="device.address" :device="activeDevice" />

  <!-- 编码列表要按「这台设备能不能编」筛，所以把当前设备地址带进设置页，与右键启动对话框同一套判据。 -->
  <PageSettings v-else-if="pageType === 'settings'" :key="device.address" :serial="device.address" />

  <AddDevice v-else-if="pageType === 'addDevice'" v-model="deviceDialogVisible" />
  <AddDeviceDialog v-model="deviceDialogVisible" :devices="discoveredDevices" @paired="connectTo"
    @connect="connectDevice" />

  <Toaster position="top-right" :theme="isDark ? 'dark' : 'light'" :offset="12" :visible-toasts="4" />
</template>
