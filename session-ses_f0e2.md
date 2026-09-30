# 无线有线同时连接显示为两个设备

**Session ID:** ses_f0e226dcaffe3VIlsxBXVoxTPG
**Created:** 9/30/2026, 6:30:25 PM
**Updated:** 9/30/2026, 6:56:04 PM

---

## User

无线和有线同时连的时候应该是一个设备，现在显示2个

---

## Assistant (Build · MiMo-V2.6-Flash Free · 144.8s)

_Thinking:_

Let me explore the codebase to understand what this is about.

**Tool: bash**

**Input:**
```json
{
  "command": "ls"
}
```

**Output:**
```
auto-imports.d.ts
certs
components.d.ts
dist
dist-electron
docs
electron
electron-builder.beta.mjs
electron-builder.json
eslint.config.js
helper-app
index.html
jsconfig.json
jsconfig.typecheck.json
mirror.html
node_modules
package.json
pnpm-lock.yaml
pnpm-workspace.yaml
public
README.md
resources
scripts
session-ses_f11c.md
shared
src
tests
vite.config.js
vitest.config.js

```

**Tool: task**

**Input:**
```json
{
  "description": "Find device identity logic",
  "prompt": "在 /Users/xh/code/anddrive 代码库中搜索：设备列表/设备展示相关逻辑，特别是\"无线\"和\"有线\"连接（可能关键词：wireless, wired, wifi, usb, bluetooth, device list, devices, 设备）如何被识别为同一设备或多设备。目标是找出为什么同一设备同时无线和有线连接时会显示为2个设备。请返回相关文件路径和行号，以及关键代码片段。搜索thoroughness: medium。",
  "subagent_type": "explore"
}
```

**Output:**
```
<task id="ses_f0e225071ffexs2olYXiLtBu95" state="completed">
<task_result>
## 结论先说

**同一台手机同时插 USB + 开无线调试时会显示成 2 个设备，根因是：设备列表是把 `adb devices` 的每一行 1:1 映射成一条 UI 记录，从头到尾没有按"稳定设备标识"做过合并去重。** 代码库里其实已经有一套完整的稳定标识基础设施（`deviceIdentity.js` / `resolveDeviceStableId` / 别名表），但它**只服务于缓存、收藏、快捷方式、锁**，唯独没有用在设备列表上。

---

## 1. 根因位置：主进程设备列表

### `/Users/xh/code/anddrive/electron/adb.js:397-439` — `listConnectDevices()`（设备列表唯一数据源）

```js
async function listConnectDevices() {
  ensureConnectBrowser();
  await ensureServer();
  const [mdnsOutput, devicesOutput] = await Promise.all([
    adbExec("mdns", "services"),
    adbExec("devices"),
  ]);
  ...
  const entries = [...parseAdbDevices(devicesOutput)].filter(
    ([serial]) => !serial.startsWith("emulator-"),
  );

  return Promise.all(
    entries.map(async ([serial, state]) => {      // ← 每个 serial 一条，无合并
      const svc = bySerial.get(serial);
      if (state === "device") warmDeviceStableId(serial);   // ← 预热了稳定ID，但返回值被丢弃
      const label = state === "device"
          ? (svc && connectNames.get(svc.name)) || (await deviceDisplayName(serial)) || null
          : null;
      return {
        name: svc?.name || serial,
        type: svc?.type || "",
        address: serial,                          // ← UI 的唯一键就是 adb serial
        displayAddress: svc?.address || serial,
        label,
        connected: state === "device",
        state,
        transport: deviceTransport(serial),       // ← 只打标签，不做归并
      };
    }),
  );
}
```

关键点：
- **`entries` 直接来自 `adb devices`**。同一台手机 USB 连接的 serial 是 `af3d7abd`，无线连接的 serial 是 `192.168.1.5:37000` 或 `adb-af3d7abd-XXXX._adb-tls-connect._tcp` —— adb 里**本来就是两条独立 transport**，于是这里就输出两行。
- **`warmDeviceStableId(serial)`（`adb.js:901-903`）被调用了，但返回的稳定标识没有放进返回对象** —— 返回体里根本没有 `stableId` 字段，前端想合并也没数据可用。

### `/Users/xh/code/anddrive/electron/adb.js:233-240` — `parseAdbDevices()`（serial → state，天然不去重）

```js
export function parseAdbDevices(output) {
  const devices = new Map();
  for (const line of String(output ?? "").split("\n")) {
    const match = line.trim().match(ADB_DEVICE_LINE_RE);
    if (match) devices.set(match[1], match[2]);   // 按 serial 存，两个 serial = 两条
  }
  return devices;
}
```

注释（`adb.js:225-227`）本身就写明了三种 serial 形态并存：

```
 * 无线调试自动连接后 serial 形如 `adb-XXXX._adb-tls-connect._tcp`，
 * 手动 connect 后形如 `192.168.1.5:37000`，USB 有线则是设备自己的序列号
 * （形如 `fb637d72` / `R58M1234567`，不含冒号）。
```

---

## 2. 有线/无线是怎么被识别的（只分类，不合并）

### `/Users/xh/code/anddrive/electron/adb.js:145-155`

```js
export function isUsbSerial(serial) {
  if (typeof serial !== "string" || !serial.trim()) return false;
  if (serial.includes(":") || serial.includes("._adb-tls-connect._tcp")) return false;
  if (serial.startsWith("emulator-")) return false;
  return true;
}

/** 传输类型：USB 有线，其余（无线调试 / 老式 tcpip）按无线处理。 */
export function deviceTransport(serial) {
  return isUsbSerial(serial) ? "usb" : "wifi";
}
```

分类测试：`/Users/xh/code/anddrive/tests/electron/adbTransport.test.js:11-23`
- USB：`fb637d72`、`R58M1234567`、`0123456789ABCDEF`
- wifi：`192.168.1.20:5555`、`[::1]:5555`、`adb-ABC123._adb-tls-connect._tcp`

**注意：`transport` 这个字段只在 UI 上打 "USB" 角标 / 决定断开文案，全仓没有任何一处拿它做分组或归并。**

---

## 3. 稳定标识基础设施（已存在，但没接到列表上）

### `/Users/xh/code/anddrive/electron/deviceIdentity.js:1-29` — 问题与方案的完整说明

```js
// 问题：adb 的「传输地址」不稳定。同一台手机无线重连一次就换一个端口
// （实测 `192.168.100.91:41185` → `:41335` → `:41759`），走 mDNS 时还会变成
// `adb-af3d7abd-XXXX._adb-tls-connect._tcp` 这种形式。
// 解法：用设备自身的稳定序列号 `ro.serialno`（实测 `af3d7abd`，
// mDNS 服务名里嵌的也正是它）
export function pickStableId(candidates, fallback) { ... }
```

### `/Users/xh/code/anddrive/electron/adb.js:810-932` — 别名表与解析

| 行号 | 符号 | 用途 |
|---|---|---|
| `adb.js:814-816` | `ALIAS_FILE` / `stableAliases` | `transport → stableId` 落盘别名表 |
| `adb.js:862-865` | `stableIdOf(transport)` | **同步**取稳定 ID（读路径用） |
| `adb.js:873-898` | `resolveDeviceStableId(serial)` | 问设备拿 `ro.serialno` → `android_id` |
| `adb.js:901-903` | `warmDeviceStableId(serial)` | 列表里"顺手预热"（**只 fire-and-forget**） |
| `adb.js:913-932` | `findTransportByStableId` | 反查（仅快捷方式用） |

**这些符号的实际调用方（全部与"设备列表"无关）：**
- `/Users/xh/code/anddrive/electron/favorites.js:5, 68, 92` — 收藏按稳定 ID 分桶
- `/Users/xh/code/anddrive/electron/shortcut.js:22, 71-77` — 桌面快捷方式
- `/Users/xh/code/anddrive/electron/adb.js:675, 936, 985, 995, 1118, 1358` — 缓存文件路径 / 图标目录 / 锁键

→ **`stableId` 从未出现在 `listConnectDevices()` 的返回对象里，也从未在 `src/` 里出现过一次**（grep `stableId` 在 `src/**` 零命中）。

---

## 4. 前端渲染：按 `address` 当唯一键

### `/Users/xh/code/anddrive/src/components/PageHeader.vue:117, 41-43` — 右上角"切换设备"下拉

```vue
<button v-for="item in devices" :key="item.address" type="button"
```
```js
/** 下拉里这行是不是正在用的那台。 */
function isCurrent(device) {
  return !!props.activeDevice && device.address === props.activeDevice.address  // 按 serial 比
}
```

### `/Users/xh/code/anddrive/src/components/AddDeviceDialog.vue:187-189` — 扫码弹窗"可用设备"

```vue
<div v-for="device in props.devices" :key="device.address" ...>
```
```vue
<span v-if="device.transport === 'usb'" ...>USB</span>
```

### `/Users/xh/code/anddrive/src/App.vue:262-299` — 列表原样落库，无任何归并

```js
const devices = await listConnectDevicesApi();
...
discoveredDevices.value = devices;    // L276 / L293，直接赋值
```

### `/Users/xh/code/anddrive/src/utils/deviceState.js:25-30` — 提示行也按 serial 展示

```js
export function deviceHint(device) {
  if (stateText(device) === '待授权') {
    return device.transport === 'usb' ? '请在手机上点「允许 USB 调试」' : '请在手机上允许此电脑调试'
  }
  return device.displayAddress || device.address     // 一行显示两个地址 = 用户看到的"2 台设备"
}
```

---

## 5. 已有的、可直接复用的归并线索

`/Users/xh/code/anddrive/electron/adb.js:264-274` — **mDNS 服务名里已经嵌着 USB serial**

```js
/**
 * mDNS 服务实例名里的设备标识段：`adb-af3d7abd` / `adb-af3d7abd-Zvci5V` → `af3d7abd`。
 * 尾串是每次开无线调试现编的随机值，不能参与比较。
 */
export function serviceDeviceToken(name) {
  const value = String(name ?? "").split("._adb-")[0].trim();
  if (!value.startsWith("adb-")) return "";
  const parts = value.slice(4).split("-");
  return parts[0] === "" ? "" : parts[0].toLowerCase();
}
```

即：USB serial `af3d7abd` ↔ mDNS 实例名 `adb-af3d7abd-XXXX` 的 token 段是**同一个值**，这是最强的"同一设备"信号（`matchServiceScore` 在 `adb.js:286-289` 已经拿它做择优，但只用于配对，不用于列表去重）。

`/Users/xh/code/anddrive/electron/adb.js:405-411` — mDNS 索引（只按地址/实例名建索引，不按设备身份）

```js
const bySerial = new Map();
for (const s of mdns) {
  bySerial.set(`${s.name}._adb-tls-connect._tcp`, s);
  if (!bySerial.has(s.address)) bySerial.set(s.address, s);
}
```

---

## 6. 相关的已知记录（说明团队已意识到"同设备双传输地址"）

- `/Users/xh/code/anddrive/docs/TODO.md:28`
  > **D4 的残留窗口**：别名表还没建立时（冷启动直接刷列表），**同一台机器的两个传输地址会分到两把锁**。
- `/Users/xh/code/anddrive/electron/adb.js:1083-1086`（缓存锁的注释，同一问题的另一面）
  > 键用 `stableIdOf`：既让**同一台设备的两个传输地址共用一把锁**……代价是别名表还没建立时（冷启动第一次刷列表）**两个地址会分到两把锁**
- `/Users/xh/code/anddrive/docs/TODO.md:45` — 提到 `getConnectedDevice` 优先无线、多台在线时冷启动行为未定

---

## 7. 修复落点（按改动量排序）

| # | 文件:行号 | 改动 |
|---|---|---|
| 1 | `electron/adb.js:397-439` `listConnectDevices` | 在返回前按 `stableId` 合并；把 `resolveDeviceStableId(serial)` 的结果作为 `stableId` 字段返回（`warmDeviceStableId` 已经在调，改成取值即可） |
| 2 | `electron/adb.js:269-274` `serviceDeviceToken` | 现成的 usb-serial ↔ mDNS-name 桥接，可做**同步兜底**（别名表冷启动为空时，`adb-af3d7abd` 直接对上 USB serial `af3d7abd`） |
| 3 | `src/components/PageHeader.vue:117,42` + `src/components/AddDeviceDialog.vue:189` | `:key` 与 `isCurrent` 改用 `stableId \|\| address` |
| 4 | `src/utils/deviceState.js:29` | 合并后的行只展示一个地址，避免"两个地址看着像两台机器" |

**注意的副作用**：合并后 `device.address`（用于 `adb -s`）必须保留**当前可用的那一条 transport**（USB 的 `af3d7abd` 或无线的 `host:port`），`getConnectedDevice`（`adb.js:447-478`，优先无线）与 `releasePrevious`/`isCurrent` 的 address 比较都要跟着改，否则会出现"切换设备"点不动或切错台。
</task_result>
</task>
```

---

## Assistant (Build · MiMo-V2.6-Flash Free · 7.1s)

_Thinking:_

Let me look at the key code to implement merging. Let's read listConnectDevices and related functions.

**Tool: read**

**Input:**
```json
{
  "filePath": "/Users/xh/code/anddrive/electron/adb.js",
  "offset": 380,
  "limit": 140
}
```

**Output:**
```
<path>/Users/xh/code/anddrive/electron/adb.js</path>
<type>file</type>
<content>
380:     shell("getprop", "ro.product.marketname"),
381:   ]);
382:   const name = clean(bluetoothName) || clean(deviceName) || clean(marketName) || null;
383:   deviceNames.set(serial, name);
384:   return name;
385: }
386: 
387: /**
388:  * 以 `adb devices` 为准，返回所有已连接/已配对的设备（含 USB、老式 tcpip、
389:  * 无线调试），未配对过、只广播的 mDNS 设备不展示。
390:  *
391:  * 名称优先取 mDNS TXT 的 given_name，其次读设备上的展示名称。
392:  * `address` 一律取 adb 的 serial（可直接用于 `adb -s`），展示用 displayAddress。
393:  * `transport` 区分有线 / 无线：USB 直插的设备没有 mDNS 条目，展示与断开逻辑都按它分支。
394:  * 未授权（unauthorized）也返回，`connected: false` 供界面提示「在手机上点允许」。
395:  * @returns {Promise<{ name: string, type: string, address: string, displayAddress: string, label: string | null, connected: boolean, state: string, transport: "usb" | "wifi" }[]>}
396:  */
397: async function listConnectDevices() {
398:   ensureConnectBrowser();
399:   await ensureServer();
400:   const [mdnsOutput, devicesOutput] = await Promise.all([
401:     adbExec("mdns", "services"),
402:     adbExec("devices"),
403:   ]);
404: 
405:   const mdns = parseMdnsServices(mdnsOutput).filter((s) => s.type === "_adb-tls-connect._tcp");
406:   /** @type {Map<string, { name: string, type: string, address: string }>} serial → mDNS 服务 */
407:   const bySerial = new Map();
408:   for (const s of mdns) {
409:     bySerial.set(`${s.name}._adb-tls-connect._tcp`, s);
410:     if (!bySerial.has(s.address)) bySerial.set(s.address, s);
411:   }
412: 
413:   const entries = [...parseAdbDevices(devicesOutput)].filter(
414:     ([serial]) => !serial.startsWith("emulator-"),
415:   );
416: 
417:   return Promise.all(
418:     entries.map(async ([serial, state]) => {
419:       const svc = bySerial.get(serial);
420:       if (state === "device") warmDeviceStableId(serial);
421:       // 没授权的设备 shell 读什么都失败，直接不读，别让标签和名字一起卡住。
422:       const label =
423:         state === "device"
424:           ? (svc && connectNames.get(svc.name)) || (await deviceDisplayName(serial)) || null
425:           : null;
426:       return {
427:         name: svc?.name || serial,
428:         // USB 直插没有 mDNS 服务条目，不硬塞一个无线服务类型骗界面。
429:         type: svc?.type || "",
430:         address: serial,
431:         displayAddress: svc?.address || serial,
432:         label,
433:         connected: state === "device",
434:         state,
435:         transport: deviceTransport(serial),
436:       };
437:     }),
438:   );
439: }
440: 
441: /**
442:  * 返回当前 adb 已连接（状态 device）的设备，供启动时接管其他工具
443:  * （Android Studio / 终端 adb 等）已建立的连接。优先无线设备，
444:  * address 用 adb 的 serial，可直接用于后续 `adb -s`。
445:  * @returns {Promise<{ name: string, address: string, displayAddress: string, label: string | null, transport: "usb" | "wifi" } | null>}
446:  */
447: async function getConnectedDevice() {
448:   await ensureServer();
449:   const devices = parseAdbDevices(await adbExec("devices"));
450:   const online = [...devices]
451:     .filter(([serial, state]) => state === "device" && !serial.startsWith("emulator-"))
452:     .map(([serial]) => serial);
453:   if (!online.length) return null;
454: 
455:   const address =
456:     online.find((s) => s.includes(":") || s.endsWith("._adb-tls-connect._tcp")) ?? online[0];
457: 
458:   let name = address;
459:   let label = await deviceDisplayName(address);
460:   let displayAddress = address;
461:   try {
462:     ensureConnectBrowser();
463:     const services = parseMdnsServices(await adbExec("mdns", "services"));
464:     const matched = services.find(
465:       (s) =>
466:         s.type === "_adb-tls-connect._tcp" &&
467:         (`${s.name}._adb-tls-connect._tcp` === address || s.address === address),
468:     );
469:     if (matched) {
470:       name = matched.name;
471:       label = connectNames.get(matched.name) || label;
472:       displayAddress = matched.address;
473:     }
474:   } catch {
475:     // ignore
476:   }
477:   return { name, address, displayAddress, label, transport: deviceTransport(address) };
478: }
479: 
480: // ---------------------------------------------------------------------------
481: // 连接健康检查与重连
482: // ---------------------------------------------------------------------------
483: 
484: /**
485:  * 读取某台设备在 `adb devices` 中的实时状态，用于连接健康检查：
486:  * - `device`：在线可用
487:  * - `offline`：仍登记在 adb 中但无法通信（设备休眠 / 网络抖动）
488:  * - `unauthorized` / `authorizing`：未授权或正在等手机上点「允许」（USB 插入常见）
489:  * - `connecting`：transport 正在建立
490:  * - `absent`：transport 已断开，设备从列表消失（USB 场景 = 数据线被拔）
491:  * @param {string} serial
492:  * @returns {Promise<"device" | "offline" | "unauthorized" | "authorizing" | "connecting" | "absent">}
493:  */
494: export async function getDeviceState(serial) {
495:   if (typeof serial !== "string" || !serial) return "absent";
496:   await ensureServer();
497:   try {
498:     return parseAdbDevices(await adbExec("devices")).get(serial) || "absent";
499:   } catch (error) {
500:     // 问不到状态就按「离线」上报：心跳与快捷方式都据此走重连分支。
501:     // 旧行为是让它一直挂着，调用方永远等不到答案。
502:     if (isAdbTimeoutError(error)) return "offline";
503:     throw error;
504:   }
505: }
506: 
507: /**
508:  * 从 mDNS 连接服务里解析设备当前可用的 `host:port`，供断线重连使用。
509:  * @param {string} serial
510:  * @returns {Promise<string | null>}
511:  */
512: async function resolveReconnectAddress(serial) {
513:   if (typeof serial !== "string" || !serial) return null;
514:   await ensureServer();
515:   const services = parseMdnsServices(await adbExec("mdns", "services")).filter(
516:     (s) => s.type === "_adb-tls-connect._tcp",
517:   );
518:   const matched = services.find(
519:     (s) =>

(Showing lines 380-519 of 1972. Use offset=520 to continue.)
</content>
```

**Tool: read**

**Input:**
```json
{
  "filePath": "/Users/xh/code/anddrive/electron/adb.js",
  "offset": 800,
  "limit": 150
}
```

**Output:**
```
<path>/Users/xh/code/anddrive/electron/adb.js</path>
<type>file</type>
<content>
800:   for (const entry of keep.slice(MAX_APPS)) await removeFile(path.join(dir, entry.name));
801: }
802: 
803: // ---------------------------------------------------------------------------
804: // 稳定设备标识（背景见 ./deviceIdentity.js）
805: //
806: // 持久化键一律用设备自己的序列号，不用 adb 传输地址：无线每次重连地址就换一个，
807: // 拿地址当键会让收藏 / 应用缓存变成一次性的（用户看到的「重连后收藏没了」）。
808: // ---------------------------------------------------------------------------
809: 
810: /**
811:  * 传输地址 → 稳定标识的别名表，**落盘**：冷启动时设备还没连上，读缓存不能依赖 adb，
812:  * 只能靠上次连上时记下的对应关系。每台设备一行，读不到就当没有（回退传输地址）。
813:  */
814: const ALIAS_FILE = () => path.join(app.getPath("userData"), "device-aliases.json");
815: /** @type {Map<string, string>} transport → stableId */
816: const stableAliases = new Map();
817: /** @type {Map<string, Promise<string>>} 解析中的地址，避免并发重复问设备 */
818: const resolving = new Map();
819: let aliasesLoaded = false;
820: 
821: function loadAliases() {
822:   if (aliasesLoaded) return;
823:   aliasesLoaded = true;
824:   try {
825:     const parsed = JSON.parse(readFileSync(ALIAS_FILE(), "utf8"));
826:     for (const [transport, stable] of Object.entries(parsed ?? {})) {
827:       if (transport && stable && typeof transport === "string" && typeof stable === "string") {
828:         stableAliases.set(transport, stable);
829:       }
830:     }
831:   } catch {
832:     // 首次运行或文件损坏：没有别名表也能正常工作
833:   }
834: }
835: 
836: async function persistAliases() {
837:   const file = ALIAS_FILE();
838:   const temp = `${file}.${process.pid}.tmp`;
839:   try {
840:     await fs.mkdir(path.dirname(file), { recursive: true });
841:     await fs.writeFile(temp, JSON.stringify(Object.fromEntries(stableAliases)), {
842:       encoding: "utf8",
843:       mode: 0o600,
844:     });
845:     await fs.rename(temp, file);
846:   } catch (error) {
847:     console.warn("Failed to write device aliases:", error);
848:   }
849: }
850: 
851: function rememberAlias(transport, stable) {
852:   if (!transport || !stable || stable === transport) return;
853:   if (stableAliases.get(transport) === stable) return;
854:   stableAliases.set(transport, stable);
855:   void persistAliases();
856: }
857: 
858: /**
859:  * 同步取已知标识，没记录就回传输地址。**读路径用它**：设备还没连上也要能秒开缓存。
860:  * @param {string} transport
861:  */
862: export function stableIdOf(transport) {
863:   loadAliases();
864:   return stableAliases.get(transport) || transport;
865: }
866: 
867: /**
868:  * 向设备问一次稳定标识：`ro.serialno` → `ro.boot.serialno` → `settings secure android_id`。
869:  * 问不到（掉线、没这台设备）就回传输地址，并且**不写别名表**，下次连上还会再解析。
870:  * @param {string} serial
871:  * @returns {Promise<string>}
872:  */
873: export async function resolveDeviceStableId(serial) {
874:   if (typeof serial !== "string" || !serial) return "";
875:   loadAliases();
876:   const known = stableAliases.get(serial);
877:   if (known) return known;
878:   const pending = resolving.get(serial);
879:   if (pending) return pending;
880:   const task = (async () => {
881:     const { stdout, stderr } = await adbExecSafe(
882:       "-s",
883:       serial,
884:       "shell",
885:       "getprop ro.serialno; getprop ro.boot.serialno; settings get secure android_id",
886:     );
887:     const lines = `${stdout}\n${stderr}`.split("\n").map((line) => line.trim());
888:     const stable = pickStableId(lines.slice(0, 3), serial);
889:     rememberAlias(serial, stable);
890:     return stable;
891:   })().finally(() => resolving.delete(serial));
892:   resolving.set(serial, task);
893:   try {
894:     return await task;
895:   } catch {
896:     return serial;
897:   }
898: }
899: 
900: /** 设备列表里顺手预热别名（不阻塞返回）。 */
901: function warmDeviceStableId(serial) {
902:   void resolveDeviceStableId(serial).catch(() => {});
903: }
904: 
905: /**
906:  * 用稳定标识反查**当前**可用的 adb 传输地址。
907:  *
908:  * 桌面快捷方式里存的是稳定标识：无线 adb 每重连一次端口就换一个，存地址的快捷方式
909:  * 当场作废（点开没反应）—— AndroMeld 的 .adrx 里写的就是 `af3d7abd`，所以它一直能点开。
910:  * @param {string} stableId
911:  * @returns {Promise<string | null>}
912:  */
913: export async function findTransportByStableId(stableId) {
914:   if (typeof stableId !== "string" || !stableId) return null;
915:   loadAliases();
916:   for (const [transport, value] of stableAliases) {
917:     if (value !== stableId) continue;
918:     if ((await getDeviceState(transport)) === "device") return transport;
919:   }
920:   // 别名表没命中（比如换过端口还没连上）：问一遍在线设备，谁的稳定标识对得上用谁。
921:   let devices;
922:   try {
923:     devices = parseAdbDevices(await adbExec("devices"));
924:   } catch {
925:     return null;
926:   }
927:   for (const [serial, state] of devices) {
928:     if (state !== "device" || serial.startsWith("emulator-")) continue;
929:     if ((await resolveDeviceStableId(serial)) === stableId) return serial;
930:   }
931:   return null;
932: }
933: 
934: /** 读缓存的候选路径：稳定标识优先，其次别名还没建立时写过的那份传输地址文件。 */
935: function cacheCandidates(serial) {
936:   const known = stableIdOf(serial);
937:   const list = [cachePath(serial)];
938:   if (known !== serial) list.unshift(cachePath(known));
939:   return list;
940: }
941: 
942: async function removeFile(filePath) {
943:   try {
944:     await fs.unlink(filePath);
945:   } catch (error) {
946:     if (error?.code !== "ENOENT") console.warn("Failed to remove app cache:", error);
947:   }
948: }
949: 

(Showing lines 800-949 of 1972. Use offset=950 to continue.)
</content>
```

---

## Assistant (Build · MiMo-V2.6-Flash Free · 23.8s)

_Thinking:_

Now design the fix: in `listConnectDevices`, group entries by stable id and merge.

Key considerations:
- `address` must remain usable with `adb -s`.
- Need a synchronous grouping key: `stableIdOf(serial)` (alias table) plus a sync fallback: `serviceDeviceToken` for mDNS names and... USB serial equals token. Also wireless serial `192.168.1.5:37000` — no token. But the alias table may have it from previous warm.

Cold start case: USB serial `af3d7abd` and mDNS serial `adb-af3d7abd-XXXX._adb-tls-connect._tcp`. Wait — does the mDNS-form serial appear in `adb devices`? Yes when connected over wireless debugging with TLS, the serial can be `adb-XXXX._adb-tls-connect._tcp`. So sync fallback via serviceDeviceToken works for that pair. For `192.168.1.5:37000` we need the alias table (warmed in a previous session) or async resolve.

Approach: build group key = stableIdOf(serial) initially, but stableIdOf returns transport if unknown. Also apply serviceDeviceToken fallback: if serial contains `._adb-tls-connect._tcp`, token = serviceDeviceToken(serial); key = stableAliases-known or token (if token matches a USB serial present, they merge). Better: compute key for each entry:

```js
function groupKeyFor(serial) {
  loadAliases();
  const known = stableAliases.get(serial);
  if (known) return known;
  const token = serviceDeviceToken(serial); // for mDNS-form serials
  if (token) return token;
  return serial;
}
```

Hmm but for `192.168.1.5:37000` with no alias, key = serial → separate device. That's the cold start gap already documented (TODO D4). But we can improve: async resolve for connected entries and merge after? Merging after async resolution means list flickers/changes. But better correctness: wait for resolution? The current code already does `await deviceDisplayName(serial)` for connected state, so the list already awaits device shell calls. So we could await `resolveDeviceStableId(serial)` for state === "device" and use that as key. That handles all cases at cost of a shell call — but resolveDeviceStableId caches in alias table, and warmDeviceStableId was already fire-and-forget. Actually resolveDeviceStableId returns cached known immediately if alias exists. For unknown, one shell roundtrip (~fast). Since deviceDisplayName already does a shell roundtrip, an extra one is acceptable... but for unauthorized devices it will fail and return serial — fine.

Wait, ordering: label fetch already awaits; we can await stableId first for state==="device", else use sync key.

But careful: does the alias table for a USB serial exist? `resolveDeviceStableId(usbSerial)` queries device and remembers alias → `af3d7abd` → same as serial (pickStableId fallback... let's check pickStableId: candidates ro.serialno which for the device equals `af3d7abd` — likely same as USB serial). If stable === transport, rememberAlias skips storing (stable === transport returns). So stableIdOf returns transport anyway. Good.

For mDNS serial `adb-af3d7abd-XXXX._adb-tls-connect._tcp`: resolving shell gives ro.serialno = `af3d7abd`. So key = `af3d7abd` matches USB serial key (USB serial `af3d7abd` → resolve gives same → key `af3d7abd`). 

For `192.168.1.5:37000` → ro.serialno → `af3d7abd`. Merges.

So plan: await resolveDeviceStableId for state === "device"; for non-connected (unauthorized/offline) use sync key (stableIdOf or token).

Then group entries by key. Merged record:
- Which address to prefer? Need `address` usable for adb -s. Prefer a connected ("device") transport; among those, prefer USB? Existing getConnectedDevice prefers wireless. Hmm. For disconnect logic etc. Let's look at how the UI uses address and transport after merge. Let's check src usage: App.vue, PageHeader, disconnect logic.

Actually merging changes behavior significantly. Let's check how UI handles a device's transport for disconnect and for "current device" switching.

Let me grep in src for `transport`, `address`, `disconnect`.

**Tool: bash**

**Input:**
```json
{
  "command": "rg -n \"transport|displayAddress|listConnectDevices|\\.address\" src electron --glob '!node_modules' | head -80"
}
```

**Output:**
```
src/api/index.js:8:  listConnectDevices,
src/api/index.js:71:// 释放设备资源但不断开 transport：切换设备时让上一台收摊，随时可以切回去
src/api/index.js:78:export const listConnectDevicesApi = () => listConnectDevices();
src/components/AddDeviceDialog.vue:80:  statusMessage.value = `正在配对 ${device?.address || ''}…`
src/components/AddDeviceDialog.vue:87:      resolveConnectAddressApi({ name: device?.name, address: device?.address }).then(
src/components/AddDeviceDialog.vue:189:              :key="device.address"
src/components/AddDeviceDialog.vue:203:                    v-if="device.transport === 'usb'"
electron/adb.js:38: * adb 子进程超时。transport 半死（手机休眠、换地址、Wi-Fi 抖动）时 `adb` 会**一直挂着**：
electron/adb.js:158: * Disconnect an ADB transport. Missing transports are idempotent.
electron/adb.js:159: * USB 没有 tcp transport：`adb disconnect <serial>` 会把 USB 传输直接摘掉，
electron/adb.js:288:  if (hint.host && String(service.address).split(":")[0] === hint.host) return 2;
electron/adb.js:337:    typeof pairingService?.address === "string" && pairingService.address.length <= 256
electron/adb.js:338:      ? pairingService.address
electron/adb.js:392: * `address` 一律取 adb 的 serial（可直接用于 `adb -s`），展示用 displayAddress。
electron/adb.js:393: * `transport` 区分有线 / 无线：USB 直插的设备没有 mDNS 条目，展示与断开逻辑都按它分支。
electron/adb.js:395: * @returns {Promise<{ name: string, type: string, address: string, displayAddress: string, label: string | null, connected: boolean, state: string, transport: "usb" | "wifi" }[]>}
electron/adb.js:397:async function listConnectDevices() {
electron/adb.js:410:    if (!bySerial.has(s.address)) bySerial.set(s.address, s);
electron/adb.js:431:        displayAddress: svc?.address || serial,
electron/adb.js:435:        transport: deviceTransport(serial),
electron/adb.js:445: * @returns {Promise<{ name: string, address: string, displayAddress: string, label: string | null, transport: "usb" | "wifi" } | null>}
electron/adb.js:460:  let displayAddress = address;
electron/adb.js:467:        (`${s.name}._adb-tls-connect._tcp` === address || s.address === address),
electron/adb.js:472:      displayAddress = matched.address;
electron/adb.js:477:  return { name, address, displayAddress, label, transport: deviceTransport(address) };
electron/adb.js:489: * - `connecting`：transport 正在建立
electron/adb.js:490: * - `absent`：transport 已断开，设备从列表消失（USB 场景 = 数据线被拔）
electron/adb.js:520:      s.address === serial || s.name === serial || `${s.name}._adb-tls-connect._tcp` === serial,
electron/adb.js:522:  return matched?.address || null;
electron/adb.js:815:/** @type {Map<string, string>} transport → stableId */
electron/adb.js:826:    for (const [transport, stable] of Object.entries(parsed ?? {})) {
electron/adb.js:827:      if (transport && stable && typeof transport === "string" && typeof stable === "string") {
electron/adb.js:828:        stableAliases.set(transport, stable);
electron/adb.js:851:function rememberAlias(transport, stable) {
electron/adb.js:852:  if (!transport || !stable || stable === transport) return;
electron/adb.js:853:  if (stableAliases.get(transport) === stable) return;
electron/adb.js:854:  stableAliases.set(transport, stable);
electron/adb.js:860: * @param {string} transport
electron/adb.js:862:export function stableIdOf(transport) {
electron/adb.js:864:  return stableAliases.get(transport) || transport;
electron/adb.js:916:  for (const [transport, value] of stableAliases) {
electron/adb.js:918:    if ((await getDeviceState(transport)) === "device") return transport;
electron/adb.js:1850:ipcMain.handle(CHANNELS.adbListConnectDevices, listConnectDevices);
electron/adb.js:1863:  return adbExec({ timeoutMs: ADB_CONNECT_TIMEOUT_MS }, "pair", device.address, password);
electron/adb.js:1900: * 断开与切换设备共用它 —— 区别只在之后要不要动 transport。
electron/adb.js:1917:// 切换设备：只释放上一台的资源，transport 留在 adb 里，
electron/main.js:117:    if (!result.online || !result.address) {
electron/main.js:120:    address = result.address;
src/components/PageHeader.vue:27:const isUsb = computed(() => props.activeDevice?.transport === 'usb')
src/components/PageHeader.vue:42:  return !!props.activeDevice && device.address === props.activeDevice.address
src/components/PageHeader.vue:117:              <button v-for="item in devices" :key="item.address" type="button"
src/components/PageHeader.vue:130:                    <span v-if="item.transport === 'usb'"
electron/shortcut.js:73:    stableId = await resolveDeviceStableId(sanitizeSerial(payload?.address));
electron/shortcut.js:77:  const serial = sanitizeSerial(stableId || payload?.address);
electron/ipcContract.js:13:  adbListConnectDevices: 'adb:listConnectDevices',
electron/ipcContract.js:23:  /** 只释放设备资源（镜像 / 存储 / 连接池），保留 ADB transport，供切换设备用。 */
electron/webdav.js:159:      const { port } = server.address();
src/components/home/AppList.vue:78:const { isFavorite, toggleFavorite } = useFavorites(() => props.address)
src/components/home/AppList.vue:106:    await installHelperApi(props.address)
src/components/home/AppList.vue:117:    await uninstallHelperApi(props.address)
src/components/home/AppList.vue:127:    await deleteAppCacheApi(props.address)
src/components/home/AppList.vue:153:  if (!props.address) return
src/components/home/AppList.vue:157:    const cached = await getCachedAppsApi(props.address)
src/components/home/AppList.vue:166:    apps.value = await loadInstalledAppsApi(props.address)
src/components/home/AppList.vue:189:        patchIcons(await getAppIconsApi(props.address, group))
src/components/home/AppList.vue:228:      serial: props.address,
src/components/home/AppList.vue:273:      const result = await exportApkApi(props.address, app.packageName)
src/components/home/AppList.vue:289:        address: props.address,
src/components/home/AppList.vue:314:    appInfo.value = await getAppInfoApi(props.address, app.packageName)
src/components/home/AppList.vue:369:      await clearAppDataApi(props.address, app.packageName)
src/components/home/AppList.vue:381:      await uninstallAppApi(props.address, app.packageName)
src/components/home/AppList.vue:556:    <ScrcpyLaunchDialog v-model="launchDialogVisible" :serial="props.address"
electron/preload.js:37:    listConnectDevices: () => invoke(CHANNELS.adbListConnectDevices),
electron/mdns.js:333:        addresses: [...addresses],
src/components/home/index.vue:36:    getDeviceStatsApi(props.device.address),
src/components/home/index.vue:37:    getStorageVolumesApi(props.device.address),
src/components/home/index.vue:83:      <span :title="`${deviceTitle} · ${device.displayAddress || device.address}`"
src/components/home/index.vue:88:        {{ device.transport === 'usb' ? 'USB' : '无线' }}
src/components/home/index.vue:112:                <DeviceStats :serial="device.address" />
src/components/home/index.vue:127:                <StoragePanel :serial="device.address" :device-label="deviceTitle" />

```

**Tool: bash**

**Input:**
```json
{
  "command": "rg -n \"listConnectDevices|stableIdOf|resolveDeviceStableId|serviceDeviceToken\" electron src tests shared | head -50"
}
```

**Output:**
```
electron/favorites.js:5:import { resolveDeviceStableId } from "./adb.js";
electron/favorites.js:68:    return (await resolveDeviceStableId(serial)) || serial;
tests/electron/favorites.test.js:46:  resolveDeviceStableId: async (serial) => serial,
src/api/index.js:8:  listConnectDevices,
src/api/index.js:78:export const listConnectDevicesApi = () => listConnectDevices();
tests/electron/shortcut.test.js:29:  resolveDeviceStableId: async (address) => (address ? `stable-${address}` : ''),
electron/adb.js:269:export function serviceDeviceToken(name) {
electron/adb.js:287:  if (hint.token && serviceDeviceToken(service.name) === hint.token) return 3;
electron/adb.js:341:    token: serviceDeviceToken(name),
electron/adb.js:397:async function listConnectDevices() {
electron/adb.js:675:  const stable = stableIdOf(serial);
electron/adb.js:862:export function stableIdOf(transport) {
electron/adb.js:873:export async function resolveDeviceStableId(serial) {
electron/adb.js:902:  void resolveDeviceStableId(serial).catch(() => {});
electron/adb.js:929:    if ((await resolveDeviceStableId(serial)) === stableId) return serial;
electron/adb.js:936:  const known = stableIdOf(serial);
electron/adb.js:985:  return withCacheLock(cachePath(stableIdOf(serial)), async () => {
electron/adb.js:995:    iconPrunedAt.delete(iconDir(stableIdOf(serial)));
electron/adb.js:1083: * 键用 `stableIdOf`（只查已落盘的别名表，**绝不在这里 spawn adb**）：既让同一台设备的
electron/adb.js:1118:  const stable = stableIdOf(serial);
electron/adb.js:1358:  const stable = await resolveDeviceStableId(serial);
electron/adb.js:1850:ipcMain.handle(CHANNELS.adbListConnectDevices, listConnectDevices);
tests/electron/adbMdns.test.js:8:const { parseMdnsServices, parseAdbDevices, pickMdnsService, serviceDeviceToken } =
tests/electron/adbMdns.test.js:45:describe('serviceDeviceToken', () => {
tests/electron/adbMdns.test.js:47:    expect(serviceDeviceToken('adb-af3d7abd')).toBe('af3d7abd')
tests/electron/adbMdns.test.js:48:    expect(serviceDeviceToken('adb-af3d7abd-Zvci5V')).toBe('af3d7abd')
tests/electron/adbMdns.test.js:49:    expect(serviceDeviceToken('adb-af3d7abd-Zvci5V._adb-tls-connect._tcp')).toBe('af3d7abd')
tests/electron/adbMdns.test.js:53:    expect(serviceDeviceToken('printer._ipp._tcp')).toBe('')
tests/electron/adbMdns.test.js:54:    expect(serviceDeviceToken('adb-')).toBe('')
tests/electron/adbMdns.test.js:55:    expect(serviceDeviceToken(undefined)).toBe('')
tests/electron/adbMdns.test.js:57:    expect(serviceDeviceToken('ADB-AB12._adb-tls-pairing._tcp')).toBe('')
electron/shortcut.js:22:import { normalizePackageName, resolveDeviceStableId } from "./adb.js";
electron/shortcut.js:73:    stableId = await resolveDeviceStableId(sanitizeSerial(payload?.address));
electron/ipcContract.js:13:  adbListConnectDevices: 'adb:listConnectDevices',
src/App.vue:9:  listConnectDevicesApi,
src/App.vue:266:      const devices = await listConnectDevicesApi();
src/App.vue:291:      const devices = await listConnectDevicesApi();
electron/preload.js:37:    listConnectDevices: () => invoke(CHANNELS.adbListConnectDevices),

```

---

## Assistant (Build · MiMo-V2.6-Flash Free · 3.6s)

_Thinking:_

Let's see App.vue device handling (activeDevice, switching, disconnect), and disconnect logic around line 1900.

**Tool: read**

**Input:**
```json
{
  "filePath": "/Users/xh/code/anddrive/src/App.vue",
  "limit": 140,
  "offset": 230
}
```

**Output:**
```
<path>/Users/xh/code/anddrive/src/App.vue</path>
<type>file</type>
<content>
230:     await releasePrevious(target);
231:     adoptDevice(target);
232:     notify.success(`已切换到 ${label}`, { title: "设备已切换" });
233:   } finally {
234:     switching.value = false;
235:   }
236: }
237: 
238: /** 下拉里的「扫码配对新设备」：二维码弹窗始终挂着，直接打开即可。 */
239: function openPairDialog() {
240:   deviceDialogVisible.value = true;
241: }
242: 
243: const connect = async () => {
244:   // 电脑已通过其他工具连上手机时，直接接管该连接进首页
245:   try {
246:     const connected = await getConnectedDeviceApi();
247:     if (connected) {
248:       adoptDevice(connected);
249:       return;
250:     }
251:   } catch (e) {
252:     console.error("获取已连接设备失败：", e);
253:   }
254: 
255:   device.value = null;
256:   pageType.value = "addDevice";
257: };
258: 
259: // 持续发现手机服务：只在未连接时轮询，连接后立即停止。
260: // 用递增令牌让后一次调用取代上一次，避免旧的发现循环卡住导致重连后无人发现。
261: let discoveryToken = 0;
262: async function discoverLoop() {
263:   const token = ++discoveryToken;
264:   while (!device.value && token === discoveryToken) {
265:     try {
266:       const devices = await listConnectDevicesApi();
267:       if (device.value || token !== discoveryToken) break;
268:       // 扫码弹窗开着时**不接管**：人正盯着弹窗里的「可用设备」，自动进首页会把那份
269:       // 列表直接抽走（`discoveredDevices` 在接管分支里根本不会被赋值）。
270:       const connected =
271:         autoAdopt && !deviceDialogVisible.value ? devices.find((d) => d.connected) : null;
272:       if (connected) {
273:         adoptDevice(connected);
274:         break;
275:       }
276:       discoveredDevices.value = devices;
277:     } catch (e) {
278:       console.error("发现设备失败：", e);
279:     }
280:     await sleep(DISCOVERY_INTERVAL_MS);
281:   }
282: }
283: 
284: // 首页的设备下拉只在展开期间轮询：连着设备时 discoverLoop 已经停了，
285: // 不额外给 adb 加一条常驻的每秒请求；收起立刻用令牌停掉在途的循环。
286: let menuDevicesToken = 0;
287: async function startMenuDevicesPolling() {
288:   const token = ++menuDevicesToken;
289:   while (token === menuDevicesToken) {
290:     try {
291:       const devices = await listConnectDevicesApi();
292:       if (token !== menuDevicesToken) break;
293:       discoveredDevices.value = devices;
294:     } catch (e) {
295:       console.error("刷新设备列表失败：", e);
296:     }
297:     await sleep(DISCOVERY_INTERVAL_MS);
298:   }
299: }
300: 
301: function stopMenuDevicesPolling() {
302:   menuDevicesToken += 1;
303: }
304: 
305: function onDeviceMenuChange(open) {
306:   if (open) startMenuDevicesPolling();
307:   else stopMenuDevicesPolling();
308: }
309: 
310: onMounted(() => {
311:   connect();
312:   discoverLoop();
313:   startScrcpySessionPolling();
314:   disposeMirrorResult = onMirrorResultApi((result) => {
315:     if (result.ok) {
316:       notify.success(`已从桌面快捷方式启动 ${result.label}`, { title: "镜像已开启" });
317:       refreshScrcpySessions();
318:     } else {
319:       notify.error(result.message || "启动镜像失败", { title: `启动 ${result.label} 失败` });
320:     }
321:   });
322:   disposeMirrorExit = onMirrorExitApi((result) => {
323:     notify.error(result.message || "镜像已结束", { title: `${result.label} 镜像已结束` });
324:     refreshScrcpySessions();
325:   });
326: });
327: 
328: onUnmounted(() => {
329:   stopScrcpySessionPolling();
330:   disposeMirrorResult?.();
331:   disposeMirrorExit?.();
332: });
333: 
334: function connectDevice(target) {
335:   if (!target) return;
336:   autoAdopt = true;
337:   adoptDevice(target);
338: }
339: 
340: async function disconnect() {
341:   if (!device.value) return;
342:   disconnecting.value = true;
343:   disconnectError.value = "";
344:   try {
345:     await disconnectApi(device.value.address);
346:     device.value = null;
347:     lostDevice = null;
348:     autoAdopt = false;
349:     notify.dismiss(CONNECTION_TOAST_KEY);
350:     pageType.value = "addDevice";
351:     discoverLoop();
352:   } catch (e) {
353:     disconnectError.value = readableError(e, "断开连接失败");
354:   } finally {
355:     disconnecting.value = false;
356:   }
357: }
358: 
359: function openSettings() {
360:   settingsReturn.value = pageType.value;
361:   pageType.value = "settings";
362: }
363: 
364: function closeSettings() {
365:   pageType.value = settingsReturn.value;
366: }
367: </script>
368: 
369: <template>

(Showing lines 230-369 of 391. Use offset=370 to continue.)
</content>
```

**Tool: read**

**Input:**
```json
{
  "filePath": "/Users/xh/code/anddrive/electron/adb.js",
  "limit": 110,
  "offset": 1870
}
```

**Output:**
```
<path>/Users/xh/code/anddrive/electron/adb.js</path>
<type>file</type>
<content>
1870:  */
1871: const deviceTeardownHooks = new Set();
1872: 
1873: /**
1874:  * 注册设备清理钩子，返回取消函数。
1875:  * @param {(serial?: string) => unknown} hook
1876:  */
1877: export function onDeviceTeardown(hook) {
1878:   deviceTeardownHooks.add(hook);
1879:   return () => deviceTeardownHooks.delete(hook);
1880: }
1881: 
1882: /**
1883:  * 执行所有清理钩子；无 serial 表示整体退出。等待异步钩子完成。
1884:  * @param {string} [serial]
1885:  */
1886: export async function runDeviceTeardown(serial) {
1887:   await Promise.all(
1888:     [...deviceTeardownHooks].map(async (hook) => {
1889:       try {
1890:         await hook(serial);
1891:       } catch (error) {
1892:         console.warn("AndDrive: 设备清理钩子失败：", error?.message || error);
1893:       }
1894:     }),
1895:   );
1896: }
1897: 
1898: /**
1899:  * 释放一台设备在本机占用的资源：镜像会话、存储挂载、adb sync 连接池与内存缓存。
1900:  * 断开与切换设备共用它 —— 区别只在之后要不要动 transport。
1901:  * @param {string} serial
1902:  */
1903: async function releaseDeviceResources(serial) {
1904:   await runDeviceTeardown(serial);
1905:   deviceStatsCache.delete(serial);
1906:   videoCodecCapsCache.delete(serial);
1907: }
1908: 
1909: // 断开设备：先释放该设备的资源，再断开 ADB 传输（USB 只停用、不摘传输，
1910: // 详见 disconnectTransport）
1911: ipcMain.handle(CHANNELS.adbDisconnect, async (_, rawSerial) => {
1912:   const serial = normalizeDisconnectSerial(rawSerial);
1913:   await releaseDeviceResources(serial);
1914:   return disconnectTransport(serial);
1915: });
1916: 
1917: // 切换设备：只释放上一台的资源，transport 留在 adb 里，
1918: // 这样随时能从设备列表切回去，无线那台也不用重新 connect。
1919: ipcMain.handle(CHANNELS.adbReleaseDevice, async (_, rawSerial) => {
1920:   const serial = normalizeDisconnectSerial(rawSerial);
1921:   await releaseDeviceResources(serial);
1922:   return true;
1923: });
1924: 
1925: // 安装 Helper
1926: ipcMain.handle(CHANNELS.adbInstallHelper, async (_, serial) => {
1927:   return installHelper(serial);
1928: });
1929: 
1930: /**
1931:  * Load the installed-app list for one device. The app_process run is
1932:  * one-shot, so this resolves with the complete list.
1933:  * @param {string} address
1934:  */
1935: ipcMain.handle(CHANNELS.adbLoadInstalledApps, async (_, address) => {
1936:   return loadInstalledApps(address);
1937: });
1938: 
1939: // 批量获取应用图标（渲染层按每组 20 个包名调用）
1940: ipcMain.handle(CHANNELS.adbGetAppIcons, async (_, address, packages) => {
1941:   return getAppIcons(address, packages);
1942: });
1943: 
1944: // 卸载 Helper（部分 ROM 卸载成功也返回 code 1 + Failure，输出仅记录，不作判断）
1945: ipcMain.handle(CHANNELS.adbUninstallHelper, async (_, address) => {
1946:   return uninstallHelper(address);
1947: });
1948: 
1949: // 清除该设备的应用列表缓存
1950: ipcMain.handle(CHANNELS.adbDeleteAppCache, async (_, address) => {
1951:   return deleteAppCache(address);
1952: });
1953: 
1954: // 读取该设备的应用列表缓存，供界面秒开
1955: ipcMain.handle(CHANNELS.adbGetCachedApps, async (_, address) => {
1956:   return getCachedApps(address);
1957: });
1958: 
1959: // 应用操作：强制停止 / 清除数据 / 卸载 / 应用信息 / 导出 APK
1960: ipcMain.handle(CHANNELS.adbForceStop, (_, serial, pkg) => forceStopApp(serial, pkg));
1961: ipcMain.handle(CHANNELS.mirrorAppTask, (_, serial, pkg) => getAppTask(serial, pkg));
1962: ipcMain.handle(CHANNELS.mirrorMoveTask, (_, serial, taskId, displayId) =>
1963:   moveAppTaskToDisplay(serial, taskId, displayId),
1964: );
1965: ipcMain.handle(CHANNELS.adbClearData, (_, serial, pkg) => clearAppData(serial, pkg));
1966: ipcMain.handle(CHANNELS.adbUninstallApp, (_, serial, pkg) => uninstallApp(serial, pkg));
1967: ipcMain.handle(CHANNELS.adbAppInfo, (_, serial, pkg) => getAppInfo(serial, pkg));
1968: ipcMain.handle(CHANNELS.adbExportApk, (_, serial, pkg) => exportApk(serial, pkg));
1969: 
1970: // 设备信息：型号 / 系统 / 存储 / 电量 / 网络 / CPU / 内存（force=true 跳过缓存）
1971: ipcMain.handle(CHANNELS.adbGetDeviceStats, (_, serial, force) => getDeviceStats(serial, force === true));
1972: ipcMain.handle(CHANNELS.adbVideoCodecs, (_, serial) => getDeviceVideoCodecs(serial));

(End of file - total 1972 lines)
</content>
```

---

## Assistant (Build · MiMo-V2.6-Flash Free · 17.1s)

_Thinking:_

Now design merge in `listConnectDevices`.

Merged entry fields:
- `address`: must be an adb-usable serial of a connected transport. Prefer: connected first; among connected prefer... Which is more stable? USB serial is stable and works with `adb -s`. Wireless also works. If we pick USB when both connected, then when cable unplugged, next refresh picks wireless address. That's fine since address is recomputed each poll, but activeDevice is stored in `device.value` — UI compares address. Let's check `adoptDevice` and how `device.value` is refreshed (is there a health check that updates address?). Let's read App.vue top part.

Also `transport`: merged record — if both, which? UI shows USB badge and disconnect text. If we pick the address transport's type consistently, that's coherent. But maybe user prefers... I'd prefer USB when both available? Actually for disconnect behavior: disconnectTransport for USB "只停用" (adb usb) vs wifi disconnect. Hmm. If user clicks "断开" for a merged device with both, which should happen?

Let's read disconnectTransport and App.vue health-check logic.

**Tool: read**

**Input:**
```json
{
  "filePath": "/Users/xh/code/anddrive/src/App.vue",
  "limit": 230
}
```

**Output:**
```
<path>/Users/xh/code/anddrive/src/App.vue</path>
<type>file</type>
<content>
1: <script setup>
2: import PageHome from "./components/home/index.vue";
3: import PageSettings from "./components/Settings.vue";
4: import { Toaster } from "vue-sonner";
5: import {
6:   connectApi,
7:   disconnectApi,
8:   releaseDeviceApi,
9:   listConnectDevicesApi,
10:   getConnectedDeviceApi,
11:   getDeviceStateApi,
12:   reconnectApi,
13:   onMirrorResultApi,
14:   onMirrorExitApi,
15: } from "@/api";
16: import { readableError } from "@/utils/errors";
17: import { notify, notifyError } from "@/composables/useNotifications";
18: import { autoReconnect } from "@/composables/useConnectionPreferences";
19: import { isDark } from "@/composables/useTheme";
20: import {
21:   startScrcpySessionPolling,
22:   stopScrcpySessionPolling,
23:   refreshScrcpySessions,
24: } from "@/composables/useScrcpySessions";
25: 
26: const DISCOVERY_INTERVAL_MS = 1000;
27: /** 连接健康检查间隔 */
28: const HEARTBEAT_INTERVAL_MS = 5000;
29: /** 自动重连尝试间隔 */
30: const RECONNECT_INTERVAL_MS = 3000;
31: /** 自动重连最大尝试次数（约 30s），失败后回落到添加设备页继续发现 */
32: const MAX_RECONNECT_ATTEMPTS = 10;
33: /** 连接状态通知的固定 key，用于原地更新同一条 toast */
34: const CONNECTION_TOAST_KEY = "connection";
35: 
36: const pageType = ref("loading"); // loading | home | addDevice | settings
37: const settingsReturn = ref("home");
38: const deviceDialogVisible = ref(false);
39: const device = ref(null);
40: const discoveredDevices = ref([]);
41: const disconnecting = ref(false);
42: const disconnectError = ref("");
43: 
44: const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
45: 
46: /** 断线后记住的设备，供自动重连使用 */
47: let lostDevice = null;
48: /** 启动后若发现已有连接则自动接管；用户主动断开后不再自动接管 */
49: let autoAdopt = true;
50: /** 快捷方式唤起投屏结果的取消订阅函数 */
51: let disposeMirrorResult = null;
52: /** 原生镜像意外结束的取消订阅函数 */
53: let disposeMirrorExit = null;
54: 
55: // ---------------------------------------------------------------------------
56: // 连接健康检查
57: // ---------------------------------------------------------------------------
58: 
59: let healthRunning = false;
60: /** 心跳：设备已连接时轮询其 adb 状态，掉线后进入重连或离线分支 */
61: async function healthLoop() {
62:   if (healthRunning) return;
63:   healthRunning = true;
64:   while (device.value) {
65:     const current = device.value;
66:     const state = await getDeviceStateApi(current.address).catch(() => null);
67:     if (device.value !== current) continue;
68:     if (state && state !== "device") {
69:       handleConnectionLost(current, state);
70:       break;
71:     }
72:     await sleep(HEARTBEAT_INTERVAL_MS);
73:   }
74:   healthRunning = false;
75: }
76: 
77: /**
78:  * 区分「设备离线」与「transport 断开」：
79:  * offline / unauthorized 表示设备仍登记在 adb 中但不可通信；absent 表示连接已断开。
80:  */
81: function handleConnectionLost(target, state) {
82:   if (device.value !== target) return;
83:   device.value = null;
84:   // 设备没了就没有「这台能编什么」可问，设置页不许停留在无设备状态（入口也只在首页给）。
85:   if (pageType.value === "settings") pageType.value = "addDevice";
86:   lostDevice = target;
87:   const label = target.label || target.name || "设备";
88:   const usb = target.transport === "usb";
89:   const offline = ["offline", "unauthorized", "authorizing"].includes(state);
90:   const title = offline ? "设备离线" : "连接已断开";
91:   const offlineHint = usb
92:     ? "请检查数据线，并在手机上允许 USB 调试"
93:     : "设备暂时无法访问，请检查网络后重试";
94:   const lostHint = usb ? "USB 连接已断开，请检查数据线" : "与设备的无线连接已断开";
95: 
96:   if (autoReconnect.value && autoAdopt) {
97:     notify.loading(`正在尝试恢复与 ${label} 的连接…`, {
98:       key: CONNECTION_TOAST_KEY,
99:       title,
100:     });
101:     pageType.value = "loading";
102:     startRecovery(target);
103:     return;
104:   }
105: 
106:   notify.error(offline ? offlineHint : lostHint, {
107:     key: CONNECTION_TOAST_KEY,
108:     title,
109:     action: {
110:       label: "重新连接",
111:       handler: () => {
112:         autoAdopt = true;
113:         pageType.value = "loading";
114:         notify.loading(`正在尝试恢复与 ${label} 的连接…`, {
115:           key: CONNECTION_TOAST_KEY,
116:           title: "重新连接",
117:         });
118:         startRecovery(target);
119:       },
120:     },
121:   });
122:   pageType.value = "addDevice";
123:   discoverLoop();
124: }
125: 
126: // ---------------------------------------------------------------------------
127: // 自动重连
128: // ---------------------------------------------------------------------------
129: 
130: let recoveryRunning = false;
131: async function startRecovery(target) {
132:   if (recoveryRunning) return;
133:   recoveryRunning = true;
134:   for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS && !device.value; attempt += 1) {
135:     if (!autoReconnect.value) break;
136: 
137:     // 其他工具可能已经连上，直接接管
138:     const existing = await getConnectedDeviceApi().catch(() => null);
139:     if (existing) {
140:       adoptDevice(existing);
141:       notify.success("已重新连接设备", { key: CONNECTION_TOAST_KEY, title: "连接已恢复" });
142:       break;
143:     }
144: 
145:     // 主动 adb connect，成功后重新读取设备（connect 后 serial 会变成 host:port）
146:     const result = await reconnectApi(target?.address).catch(() => null);
147:     if (result?.online) {
148:       const fresh = await getConnectedDeviceApi().catch(() => null);
149:       adoptDevice(fresh || target);
150:       notify.success("已重新连接设备", { key: CONNECTION_TOAST_KEY, title: "连接已恢复" });
151:       break;
152:     }
153:     await sleep(RECONNECT_INTERVAL_MS);
154:   }
155:   recoveryRunning = false;
156: 
157:   if (!device.value) {
158:     if (autoReconnect.value) {
159:       notify.error("自动重连失败，请手动连接设备", {
160:         key: CONNECTION_TOAST_KEY,
161:         title: "重连失败",
162:         action: {
163:           label: "重试",
164:           handler: () => {
165:             autoAdopt = true;
166:             pageType.value = "loading";
167:             startRecovery(lostDevice);
168:           },
169:         },
170:       });
171:     } else {
172:       notify.dismiss(CONNECTION_TOAST_KEY);
173:     }
174:     pageType.value = "addDevice";
175:     autoAdopt = true;
176:     discoverLoop();
177:   }
178: }
179: 
180: // ---------------------------------------------------------------------------
181: // 连接 / 发现
182: // ---------------------------------------------------------------------------
183: 
184: // 接管已连接设备并进入首页（设备已在 adb devices 中，无需再次 connect）
185: function adoptDevice(target) {
186:   device.value = target;
187:   deviceDialogVisible.value = false;
188:   lostDevice = null;
189:   autoAdopt = true;
190:   pageType.value = "home";
191:   healthLoop();
192: }
193: 
194: // 换台设备前给上一台收摊：只释放镜像 / 存储 / 连接池，transport 留在 adb 里，
195: // 这样设备列表里它还在，随时能切回去（无线那台也不用重新 connect）。
196: async function releasePrevious(target) {
197:   const previous = device.value;
198:   if (!previous || previous.address === target.address) return;
199:   try {
200:     await releaseDeviceApi(previous.address);
201:   } catch (e) {
202:     // 收摊失败不该拦住切换：残留资源会在下次断开或退出时再清一次。
203:     console.error("释放上一台设备失败：", e);
204:   }
205: }
206: 
207: // 先 adb connect 再进入首页
208: async function connectTo(target) {
209:   try {
210:     await connectApi(target.address);
211:     await releasePrevious(target);
212:     adoptDevice(target);
213:   } catch (e) {
214:     notifyError(e, {
215:       title: "连接设备失败",
216:       action: { label: "重试", handler: () => connectTo(target) },
217:     });
218:   }
219: }
220: 
221: // 从首页右上角的下拉切到另一台：上一台收摊 → 接管新的这台。
222: // 首页各面板按 `:key="device.address"` 重挂，切过去会重新拉数据。
223: const switching = ref(false);
224: async function switchDevice(target) {
225:   if (!target?.connected || switching.value) return;
226:   if (device.value && target.address === device.value.address) return;
227:   const label = target.label || target.name || "设备";
228:   switching.value = true;
229:   try {
230:     await releasePrevious(target);

(Showing lines 1-230 of 391. Use offset=231 to continue.)
</content>
```

**Tool: read**

**Input:**
```json
{
  "filePath": "/Users/xh/code/anddrive/electron/adb.js",
  "limit": 130,
  "offset": 140
}
```

**Output:**
```
<path>/Users/xh/code/anddrive/electron/adb.js</path>
<type>file</type>
<content>
140:  * serial 是否是 USB（有线）传输：不是 `host:port`、不是无线调试的 mDNS 实例名、
141:  * 不是模拟器。USB serial 天然稳定（不像无线地址每次重连就换）。
142:  * @param {unknown} serial
143:  * @returns {boolean}
144:  */
145: export function isUsbSerial(serial) {
146:   if (typeof serial !== "string" || !serial.trim()) return false;
147:   if (serial.includes(":") || serial.includes("._adb-tls-connect._tcp")) return false;
148:   if (serial.startsWith("emulator-")) return false;
149:   return true;
150: }
151: 
152: /** 传输类型：USB 有线，其余（无线调试 / 老式 tcpip）按无线处理。 */
153: export function deviceTransport(serial) {
154:   return isUsbSerial(serial) ? "usb" : "wifi";
155: }
156: 
157: /**
158:  * Disconnect an ADB transport. Missing transports are idempotent.
159:  * USB 没有 tcp transport：`adb disconnect <serial>` 会把 USB 传输直接摘掉，
160:  * 而且 adb 不会自己恢复（要 kill-server 或重插才行），所以有线设备只做幂等成功，
161:  * 真正的「停用」由调用方的设备级清理（镜像、缓存）完成。
162:  * @param {string} serial
163:  */
164: async function disconnectTransport(serial) {
165:   if (isUsbSerial(serial)) return true;
166:   await ensureServer();
167:   try {
168:     await adbExec("disconnect", serial);
169:   } catch (error) {
170:     if (isAlreadyDisconnectedError(error)) return true;
171:     throw error;
172:   }
173:   return true;
174: }
175: 
176: // ---------------------------------------------------------------------------
177: // ADB 错误分类
178: // ---------------------------------------------------------------------------
179: 
180: /**
181:  * @param {unknown} value
182:  * @returns {string}
183:  */
184: export function normalizeDisconnectSerial(value) {
185:   if (typeof value !== "string") throw new Error("设备序列号无效");
186:   const serial = value.trim();
187:   if (!serial || serial.length > 1024 || /\s/.test(serial)) {
188:     throw new Error("设备序列号无效");
189:   }
190:   return serial;
191: }
192: 
193: /** @param {unknown} error */
194: export function isAlreadyDisconnectedError(error) {
195:   const message = error instanceof Error ? error.message : String(error || "");
196:   return /\bno such device\b|\bdevice(?:\s+['"\w.:[\]-]+)?\s+not found\b|\bnot connected\b/i.test(
197:     message,
198:   );
199: }
200: 
201: // ---------------------------------------------------------------------------
202: // mDNS 设备发现（使用 adb 自带的 mdns discovery）
203: // ---------------------------------------------------------------------------
204: 
205: /**
206:  * 解析 `adb mdns services` 的输出。每行形如：
207:  * `adb-XXXX	_adb-tls-connect._tcp	192.168.1.5:37000`
208:  * @param {string} output
209:  * @returns {{ name: string, type: string, address: string }[]}
210:  */
211: export function parseMdnsServices(output) {
212:   const services = [];
213:   for (const line of String(output ?? "").split("\n")) {
214:     const [name, type, address] = line.trim().split(/\s+/);
215:     if (!name || !type || !address || !type.startsWith("_")) continue;
216:     services.push({ name, type, address });
217:   }
218:   return services;
219: }
220: 
221: const ADB_DEVICE_LINE_RE = /^(\S+)\s+(device|offline|unauthorized|authorizing|connecting)\b/;
222: 
223: /**
224:  * 解析 `adb devices` 输出，返回 serial → 状态。
225:  * 无线调试自动连接后 serial 形如 `adb-XXXX._adb-tls-connect._tcp`，
226:  * 手动 connect 后形如 `192.168.1.5:37000`，USB 有线则是设备自己的序列号
227:  * （形如 `fb637d72` / `R58M1234567`，不含冒号）。
228:  * `authorizing` / `connecting` 是 USB 插入到可用之间的过渡态，也要认出来，
229:  * 否则等待授权的手机在界面上完全不出现。
230:  * @param {string} output
231:  * @returns {Map<string, string>}
232:  */
233: export function parseAdbDevices(output) {
234:   const devices = new Map();
235:   for (const line of String(output ?? "").split("\n")) {
236:     const match = line.trim().match(ADB_DEVICE_LINE_RE);
237:     if (match) devices.set(match[1], match[2]);
238:   }
239:   return devices;
240: }
241: 
242: // 递增令牌用于取消上一次仍在轮询的发现，语义与旧浏览器 stop 后 promise 悬挂一致。
243: let discoveryToken = 0;
244: 
245: /**
246:  * 轮询 `adb mdns services`，直到出现指定类型的服务。
247:  * @param {string} serviceType 如 `_adb-tls-pairing._tcp`
248:  * @param {{ token?: string, host?: string }} [hint] 目标设备线索（见 matchServiceScore）
249:  * @returns {Promise<{ name: string, type: string, address: string }>}
250:  */
251: async function waitForMdnsService(serviceType, hint) {
252:   const token = ++discoveryToken;
253:   await ensureServer();
254:   while (token === discoveryToken) {
255:     const output = await adbExec("mdns", "services");
256:     if (token !== discoveryToken) break;
257:     const service = pickMdnsService(parseMdnsServices(output), serviceType, hint);
258:     if (service) return service;
259:     await new Promise((resolve) => setTimeout(resolve, 1000));
260:   }
261:   return new Promise(() => null);
262: }
263: 
264: /**
265:  * mDNS 服务实例名里的设备标识段：`adb-af3d7abd` / `adb-af3d7abd-Zvci5V` → `af3d7abd`。
266:  * 尾串是每次开无线调试现编的随机值，不能参与比较。
267:  * @param {unknown} name
268:  */
269: export function serviceDeviceToken(name) {

(Showing lines 140-269 of 1972. Use offset=270 to continue.)
</content>
```

---

## Assistant (Build · MiMo-V2.6-Flash Free · 110.9s)

_Thinking:_

Now decide the merge design.

Plan:
1. In `listConnectDevices`, compute per-entry group key:
   - sync: `stableIdOf(serial)` if alias exists → that; else if mDNS-form serial, `serviceDeviceToken(serial)` (prefix `adb-<token>`) → but that token equals USB serial typically. Careful: token `af3d7abd` vs USB serial `af3d7abd` — matches. But what if mDNS token doesn't correspond to any USB serial in list? Then group key `af3d7abd` is its own group — fine.
   - For state === "device", also await `resolveDeviceStableId(serial)` for accuracy (catches `192.168.1.5:5555` without alias). But this spawns adb shell per device per poll... resolveDeviceStableId caches in alias map, so after first time it's sync-fast (returns known immediately). Wait: `if (known) return known` — known only if alias was stored. Alias isn't stored when stable === transport (USB case, rememberAlias returns early). But for USB serial, stableId = serial anyway, so we can short-circuit: if isUsbSerial and no alias, still calling resolve spawns a shell call each poll since known is undefined. Hmm — resolveDeviceStableId caches in `resolving` only during in-flight. For USB serial, stableIdOf returns... stableAliases.get(usbSerial) is empty (never remembered since stable===transport) → returns transport. So resolving USB serial would spawn adb shell every poll (1s!). Not great.

   Better: write a helper `deviceGroupKey(serial)`:
   ```js
   function deviceGroupKey(serial) {
     const known = stableIdOf(serial); // sync, falls back to serial
     if (known !== serial) return known;
     const token = serviceDeviceToken(serial); // mDNS form → token
     if (token) return token;
     return serial;
   }
   ```
   Hmm for mDNS form `adb-af3d7abd-XXXX._adb-tls-connect._tcp`: stableIdOf may have alias (warmed) → stable id `af3d7abd`. Else token `af3d7abd`. For USB serial `af3d7abd` → stableIdOf → `af3d7abd`. Merge ✓.
   For `192.168.1.5:5555` → no token (serviceDeviceToken returns "" for that), no alias initially → key = itself → separate. After first resolve (warmDeviceStableId fire-and-forget already resolves for state==="device"!) alias gets stored, so next poll merges. Actually warmDeviceStableId is already called for connected entries — it awaits resolveDeviceStableId which stores alias. So after ~1 poll (1s), the wireless entry merges. Good enough? User would see 2 devices briefly on first poll then1. Hmm, that flash is on cold start of the app.

   Better: await resolution for connected entries so first poll already merges. Cost: adb shell for each connected device the first time only (aliases persist for wireless; USB serial short-circuits? No—USB would spawn shell every time as analyzed).

   Let's fix by making resolveDeviceStableId remember even when stable === transport? rememberAlias explicitly skips `stable === transport` to avoid useless file entries. Instead, in listConnectDevices we can await resolve only when the sync key doesn't already unify... We can't know unification without resolving.

   Alternative: make warmDeviceStableId awaited only for wifi transports whose alias is unknown (`!stableAliases.has(serial)`), i.e., only entries where deviceGroupKey didn't come from alias AND it's wifi. For USB: key = serial, no shell. For wifi `192.168.1.5:5555` without alias: resolve → stable id, merges with USB serial if USB present. That's one shell call once (then alias cached). For mDNS-form: token fallback already handles sync.

   Actually simpler: only await resolve when `!stableAliases.has(serial) && !isUsbSerial(serial)`. Wait also USB could have alias stored if ro.serialno differs from the adb serial (some devices: adb serial = ro.serialno usually; but e.g. "unknown"? edge). Let's do: if alias known → use it. Else if usb → key = serial? But what if USB adb serial differs from ro.serialno? Then the mDNS token would match ro.serialno not adb serial... Actually mDNS instance name embeds... deviceIdentity.js says mDNS service name embeds ro.serialno (`af3d7abd`), and USB adb serial is typically ro.serialno too. But on some devices adb serial is ro.serialno; on others it's a different format (e.g. "unknown"). Hmm, safest: for connected devices await resolve (which for USB spawns one shell on cold start, then... no cache since rememberAlias skips equal). That means USB shell call every list refresh — bad (1s polling).

   Improve: make resolveDeviceStableId cache in memory even when stable === transport? Add a `resolvedOnce` set? Actually rememberAlias skips because writing `serial → serial` is pointless for persistence. But we could keep an in-memory map marking "already resolved, identity = serial". Simplest: in rememberAlias, if stable === transport, still set stableAliases in memory (skip persist). Hmm, but stableAliases is persisted wholesale via persistAliases (Object.fromEntries) — so setting it in memory would persist anyway on next persistAliases call. That would write redundant entries but harmless? It writes aliases file with self-aliases; loadAliases accepts them. Not harmful but grows file.

   Alternative cleaner: keep a separate in-memory `resolvedSerials = new Set()` marking serials we've asked, with their stable id (which may equal serial). Let's restructure:

   ```js
   const resolvedOnce = new Map(); // serial → stableId (in-memory, not persisted)
   ```

   Actually simpler: change resolveDeviceStableId to use stableAliases for lookups but write self-aliases only in memory... Let me minimize risk.

   Minimal approach for list: 
   ```js
   async function deviceGroupKey(serial) {
     loadAliases();
     if (stableAliases.has(serial)) return stableAliases.get(serial);
     if (isUsbSerial(serial) && !usbResolvingNeeded) ...
   }
   ```

   Hmm. Think about what cases actually matter for the bug: USB + wireless simultaneously. Entries:
   - USB serial: `af3d7abd` (stable == itself)
   - wireless: either `adb-af3d7abd-XXXX._adb-tls-connect._tcp` (auto TLS connect) or `192.168.1.x:port`.

   Case A (mDNS-form): sync token fallback merges immediately. ✓ no adb calls.
   Case B (host:port): needs alias. warmDeviceStableId already resolves on first connected refresh → merged from2nd poll. To merge on first poll, await resolve for non-USB serials lacking alias.

   For USB we never need to resolve (its key is itself, and the token path covers the mDNS side matching). Unless adb USB serial ≠ ro.serialno, in which case wireless merges to ro.serialno and USB stays separate — an edge case. Could handle by awaiting resolve for USB too, but cost per poll. Alternative: resolve USB once per session (in-memory memo) — i.e., add a `sessionResolved` Map. That's cheap: one shell call per serial per app session. Let's do that: modify resolveDeviceStableId to memoize in-memory for the whole session even when stable===transport? 

   Cleaner: add module-level `const resolvedThisSession = new Map()` and in resolveDeviceStableId check `resolvedThisSession.get(serial)` first? But persistence matters only for cold-start cache paths; session memo doesn't break anything. Actually resolveDeviceStableId currently: known from alias → return; else spawn shell. Adding session memo: after shell, set session memo. If stable === transport, alias not stored but session memo hits next time → no shell. That improves all callers (findTransportByStableId too). Risk: device reboots / serial changes identity? ro.serialno stable. Fine.

   But careful: shortcuts/favorites rely on aliases persisted for cold-start; session memo doesn't affect.

   OK design:

   1. Add session memo in resolveDeviceStableId (small, safe).
   2. In listConnectDevices: build entries with `key` = await resolveDeviceStableId(serial) for state === "device" (now cheap: cached or1 shell per serial per session), and sync fallback for non-connected states: `stableIdOf(serial)` / token.
   Wait — for unauthorized/authorizing devices shell resolve fails → returns serial. USB unauthorized + wireless authorized of the same phone: USB key = serial (`af3d7abd`), wireless resolved → `af3d7abd` → merge ✓ (assuming serial == ro.serialno).

   3. Merge groups: pick the representative:
      - Prefer connected (`state === "device"`).
      - Among connected, prefer USB? or wifi? Consider: transport badge, disconnect behavior, healthLoop (getDeviceState(address)).
      Hmm healthLoop: if we pick USB address and cable unplugged → state absent → connection lost → reconnect attempts. If wireless also connected, ideally the app should stay connected via wifi. Picking... Actually with merge, "one device" means if any transport is alive it should stay connected. But healthLoop checks only one address.

      Which is preferable to prefer? I think prefer USB when both online? Or prefer wireless (existing getConnectedDevice prefers wireless)? The existing app's takeover logic prefers wireless. Also if we prefer USB and user unplugs the cable, device drops to lost. If we prefer wifi and wifi drops, but USB still attached, device drops to lost → then getConnectedDevice in recovery finds USB and adopts... Actually recovery: `getConnectedDeviceApi()` returns the online one (prefers wireless, falls back to any online) → adoptDevice. So it recovers on next attempt (3s). Similar either way.

      Consider the reverse: prefer wifi when both → if wifi drops (network change), getConnectedDevice finds USB → recovers. Same.

      Hmm, but is there an "auto-reconnect" enabled default? If autoReconnect off, device goes offline page. Prefer USB seems better (wired more stable, and mirrors etc. more reliable)? But existing codebase convention prefers wireless for takeover. For consistency, prefer...      Actually think about display: user sees one row with USB badge vs无线 badge. Which do they expect when both plugged? Probably USB (有线在用). Hmm, but if we choose USB as address, disconnect() calls disconnectTransport(usbSerial) → returns true without disconnecting wireless → the wifi transport stays in adb devices → device still listed as connected after "断开". Whereas if address = wifi serial, disconnect removes wifi transport but USB remains → still listed. Either way, "断开" on a dual-connected device leaves the other transport. Merged entry would then still show connected → weird UX: clicking 断开 does nothing visible (device still there). Hmm.

      Maybe for merged devices disconnect should drop all transports? That's a behavior decision. Let's think about scope: user's complaint is "same device shows 2 entries". Minimal fix: merge rows. Disconnect semantics: current UI `disconnect` sets device.value=null and goes to addDevice page; discoverLoop then finds the remaining transport → auto-adopt (autoAdopt set to false in disconnect()! line 348: `autoAdopt = false`). So after disconnect, discoverLoop won't auto-adopt. But the device list will still show the merged row as connected (since other transport alive) — user clicks it again to connect. Acceptable-ish, though "断开" not fully disconnecting is a bit odd.

      Option: on disconnect, disconnect *all* transports of that stable id. That's more correct: disconnect = user wants device gone. We could implement: for the merged device, expose `transports: [serial...]` or handle in the IPC: when disconnecting, look up alias group. Hmm, USB can't really be "disconnected" via adb (disconnectTransport returns true for usb, comment says only device-level cleanup; USB stays in list). So even today, disconnecting a USB device leaves it in `adb devices` and it reappears in the list. So existing behavior already tolerates "still listed". Given that, minimal merge + keep disconnect on chosen address is fine.

      I'll prefer USB when both online? Let's reconsider healthLoop robustness: USB address `af3d7abd` in healthLoop; user unplugs cable → absent → lost → recovery loop → getConnectedDevice returns wireless → adopted (address becomes wifi serial). 3s blip. Fine.

      If prefer wifi and wifi port changes (reconnect) → state absent → recovery → getConnectedDevice returns USB. Fine too.

      I'll prefer USB (有线) since it's the more physically explicit connection and matches "有线+无线同时连" intuition, plus badge shows USB. Hmm, but wait: existing convention in getConnectedDevice prefers wireless. Rationale in comments? Let's check docs. Also there might be a reason: wifi preferred so that unplugging cable doesn't break? Not sure.

      Let me check docs/TODO.md and README for guidance.

Let me also check how `discoveredDevices` rows are used for the AddDeviceDialog "可用设备" and the switch dropdown keys — need stable key to avoid Vue re-render issues; use `stableId` field as key where available.

Also `isCurrent(device)` compares address; after merge, activeDevice.address is one of the transports (possibly chosen differently in list). E.g., device adopted via getConnectedDevice (wifi preferred) while list row prefers USB → isCurrent false → dropdown won't highlight current device. That's a real issue! So comparison should use stableId when both have it. But activeDevice from getConnectedDevice has no stableId. Options: give getConnectedDevice a stableId too (resolve it). And in PageHeader compare `device.stableId && device.stableId === activeDevice.stableId ? ... : address === address`.

Similarly switchDevice compares `target.address === device.value.address` — if same device but different transport, switching would release previous (same device) and adopt. With stableId comparison guard: if stableId equal → return (no-op). Need care.

And `releasePrevious` compares address too.

Simplest consistent approach: give every device record a `stableId`, and in the UI compare by `stableId || address` via a small helper. Let's find all such comparisons: PageHeader isCurrent, App.vue switchDevice, releasePrevious. Also home/index.vue `:key="device.address"` remount (fine).

Also healthLoop uses current.address — if list row address changes (usb→wifi) that doesn't affect device.value (stale object). device.value only updates on adopt/switch. So if user is connected via wifi serial and cable plugged in, device.value.address stays wifi — fine.

Hmm wait, there's another subtlety: device.value.address could become stale/absent (e.g. adopted wifi address, wifi reconnects with new port) — existing behavior, unchanged.

Let's now check PageHeader and getConnectedDevice stableId. I'll add stableId to getConnectedDevice result too (await resolveDeviceStableId(address)).

Now also AddDeviceDialog shows `device.transport === 'usb'` badge — merged row shows single badge.

What about `label` and `name` for merged: prefer the connected representative's own values; if one has a label (user-set name) prefer non-null label across group. Name: prefer mDNS given name (svc.name) since it's nicer; else representative name.

displayAddress: representative's displayAddress.

state/connected: representative's (or if any connected → connected true, state "device").

type: representative's.

Let's write the code:

```js
async function listConnectDevices() {
  ...entries as before...

  const records = await Promise.all(entries.map(async ([serial, state]) => { ... key ... return {...} }));

  // merge by key
}
```

Detailed merge helper:

```js
  const built = await Promise.all(
    entries.map(async ([serial, state]) => {
      const svc = bySerial.get(serial);
      if (state === "device") warmDeviceStableId(serial);
      const label = ...;
      const stableId = await deviceGroupKey(serial, state);
      return { key: stableId, record: {...} };
    }),
  );

  const merged = new Map();
  for (const item of built) {
    const existing = merged.get(item.key);
    if (!existing) { merged.set(item.key, item.record); continue; }
    merged.set(item.key, pickPreferred(existing, item.record));
  }
  return [...merged.values()];
```

deviceGroupKey:
```js
async function deviceGroupKey(serial, state) {
  const known = stableIdOf(serial);   // sync: alias or serial
  if (known !== serial) return known;
  const token = serviceDeviceToken(serial);
  if (token) return token;
  if (state !== "device") return serial;
  return (await resolveDeviceStableId(serial)) || serial;
}
```
Wait: if state !== device, we could still try token/alias (done above). Good.

Careful: serviceDeviceToken(serial) for USB serial `af3d7abd` → doesn't start with "adb-" → "" ✓. For serial `adb-...` → token ✓.

But subtle: token-based key for mDNS-form serial when ro.serialno ≠ USB adb serial → then token key ≠ USB serial key → still 2 rows. Edge case; the awaited resolve for USB... we skip resolve for usb when state device? In my helper, USB serial with state device → known===serial, token "" → falls to `await resolveDeviceStableId(serial)` → session-memoized after first → key = ro.serialno (matches token). 

So actually just always awaiting resolve for state==="device" handles everything and is cheap after memo. And with memo, USB shell call happens once per session. Acceptable (one extra adb shell per device per app session).

Hmm but resolveDeviceStableId failure for connected device returns serial — fine.

Also: what if resolve returns same as serial for both, and wireless has alias stored to ro.serialno which differs from USB adb serial... covered.

Now pickPreferred(recordA, recordB): 
- If connected differs → the connected one wins.
- If both connected: prefer USB? Let's decide. I'll prefer USB (有线) as representative: it's stable across polls (avoids address churn when wifi port changes) and badge/disconnect semantics align with "插着线". Actually address churn: with USB preferred, address stays stable = good for healthLoop stability. Strong argument: prefer USB.

Hmm, but consider getConnectedDevice prefers wireless for takeover at startup: adopts wifi serial. Then list row prefers USB. PageHeader isCurrent by stableId → OK if both have stableId.

But home page shows device.transport USB badge while healthLoop tracks wifi address... minor inconsistency: if user clicks "断开" → disconnectTransport(usb) does nothing transport-wise, resources released, page to addDevice, autoAdopt=false, list still shows the device (both transports) → user confused? Under old behavior disconnecting wifi removed wifi row but USB row remained anyway. So same-ish.

Hmm, alternatively prefer... let me reconsider: maybe prefer the transport that is *more connected*... Both are "device". 

I'll go with USB preferred (documented in comment).

Wait, one more: what if USB entry state is "authorizing" (not yet device) and wifi is "device"? connected preference → wifi wins ✓.

Merged state: representative's state; connected = true if any is "device"? If representative is connected then true. Since preference puts connected first, representative connected = any connected ✓.

Now label/name merging: prefer non-null label from either; name: prefer the mDNS name if any group member has svc.name, else representative's name. Simple: when merging, take `label: a.label || b.label`, `name: (a.name if has svc?)...`. Let's restructure record building to include a flag `hasServiceName` or just pick name: prefer one that isn't equal to its own address? Simpler: in building record, `name: svc?.name || serial`. When merging, prefer record whose name !== record.address (i.e., a nice mDNS name), else other's. Let's implement:

```js
function mergeDeviceRecords(a, b) {
  const primary = preferDeviceRecord(a, b);
  const secondary = primary === a ? b : a;
  return {
    ...primary,
    label: a.label || b.label || null,
    name: pickName(a, b),
    ...
  };
}
```

keep it simple:

```js
function preferDeviceRecord(a, b) {
  if (a.connected !== b.connected) return a.connected ? a : b;
  if (a.transport !== b.transport) return a.transport === "usb" ? a : b;
  return a;
}
function mergeDeviceRecords(a, b) {
  const main = preferDeviceRecord(a, b);
  const other = main === a ? b : a;
  const name = [a, b].find((r) => r.name && r.name !== r.address)?.name || main.name;
  return { ...main, name, label: a.label || b.label || null, stableId: main.stableId };
}
```

Also add `stableId` field to each record (= group key). And maybe `transports`? Not needed.

Hmm, should the merged record include `state`? main.state.

Ordering of results: Map preserves first-insert order; with merge, order may differ from adb order but fine. Actually better to keep stable ordering: sort by? Not needed.

Now update JSDoc for listConnectDevices return.

Now UI changes:
1. `PageHeader.vue` isCurrent: compare stableId if both present else address.
2. `:key` → `item.stableId || item.address`.
3. `AddDeviceDialog.vue` `:key` → `device.stableId || device.address`.
4. `App.vue` switchDevice guard `target.address === device.value.address` → also compare stableId; releasePrevious similar.5. `getConnectedDevice` add stableId.

Also `src/utils/deviceState.js` deviceHint shows displayAddress — for merged row it's one address; fine.

Let's also check: does anything rely on listConnectDevices length? tests? Let's grep tests for listConnectDevices.

Also check PageHeader full file and AddDeviceDialog keys.

Another consideration: favorites/shortcuts use resolveDeviceStableId — unaffected.

Let's read PageHeader.vue relevant part and tests.

**Tool: read**

**Input:**
```json
{
  "filePath": "/Users/xh/code/anddrive/src/components/PageHeader.vue",
  "limit": 160
}
```

**Output:**
```
<path>/Users/xh/code/anddrive/src/components/PageHeader.vue</path>
<type>file</type>
<content>
1: <script setup>
2: import { Icon } from '@iconify/vue'
3: import ConfirmDialog from './ConfirmDialog.vue'
4: import BaseButton from './BaseButton.vue'
5: import { stateText, stateClass, stateDotClass, deviceHint } from '@/utils/deviceState'
6: 
7: const props = defineProps({
8:   pageType: String,
9:   disconnecting: Boolean,
10:   disconnectError: { type: String, default: '' },
11:   devices: { type: Array, default: () => [] },
12:   // 当前活动设备：断开文案要按它的传输类型走（USB 不摘 ADB 传输），列表里要标出「当前」
13:   activeDevice: { type: Object, default: null },
14: })
15: const showConfirm = ref(false)
16: // 设备下拉的开合状态：交给父级决定什么时候拉设备列表（只在展开时轮询）
17: const menuOpen = ref(false)
18: const emit = defineEmits([
19:   'disconnect',
20:   'openSettings',
21:   'closeSettings',
22:   'switchDevice',
23:   'deviceMenuChange',
24:   'addDevice',
25: ])
26: 
27: const isUsb = computed(() => props.activeDevice?.transport === 'usb')
28: 
29: // 触发器上直接显示当前设备名，没连上时退回「切换设备」
30: const deviceName = computed(() => props.activeDevice?.label || props.activeDevice?.name || '切换设备')
31: 
32: watch(menuOpen, (open) => emit('deviceMenuChange', open))
33: 
34: const disconnectMessage = computed(() =>
35:   isUsb.value
36:     ? '将在 AndDrive 中断开这台 USB 设备（停止镜像与应用读取），数据线连接与手机上的调试授权都会保留。'
37:     : '将断开当前无线 ADB 连接。手机端的配对记录仍会保留，之后可以再次连接。若设备已经离线，断开操作仍会视为成功。',
38: )
39: 
40: /** 下拉里这行是不是正在用的那台。 */
41: function isCurrent(device) {
42:   return !!props.activeDevice && device.address === props.activeDevice.address
43: }
44: 
45: /** 选中另一台设备：关掉下拉，把切换交给父级（它负责给上一台收摊）。 */
46: function pickDevice(device) {
47:   if (isCurrent(device) || !device.connected) return
48:   menuOpen.value = false
49:   emit('switchDevice', device)
50: }
51: 
52: /** 从下拉去配对新设备（二维码弹窗在 App.vue，始终挂着）。 */
53: function openPairDialog() {
54:   menuOpen.value = false
55:   emit('addDevice')
56: }
57: 
58: const actions = computed(() => {
59:   if (props.pageType === 'settings') {
60:     return [{ icon: 'lucide:arrow-left', tip: '返回', event: 'closeSettings' }]
61:   }
62:   // 只有首页（= 连着设备）才有设置入口：投屏参数里那一串「这台设备能编什么」的列表
63:   // 没有设备就算不出来，给个半空的页面进去只会误导人。
64:   if (props.pageType !== 'home') return []
65:   return [{ icon: 'lucide:unplug', tip: '断开连接', event: 'disconnect' }]
66:     .concat([{ icon: 'lucide:settings', tip: '设置', event: 'openSettings' }])
67: })
68: 
69: function onAction(event) {
70:   if (event === 'disconnect') showConfirm.value = true
71:   else emit(event)
72: }
73: 
74: function handleConfirm() {
75:   emit('disconnect')
76: }
77: 
78: function handleCancel() {
79:   if (!props.disconnecting) showConfirm.value = false
80: }
81: 
82: watch(
83:   () => props.pageType,
84:   (pageType) => {
85:     // 离开首页：确认框和设备下拉一起收掉，否则下拉关着但父级还在为它轮询。
86:     if (pageType !== 'home') {
87:       showConfirm.value = false
88:       menuOpen.value = false
89:     }
90:   },
91: )
92: </script>
93: 
94: <template>
95:   <TooltipProvider :delay-duration="300">
96:     <div class="relative">
97:       <div style="-webkit-app-region: drag" class="h-11 w-full"></div>
98: 
99:       <div v-if="pageType !== 'loading'" style="-webkit-app-region: no-drag"
100:         class="absolute top-1/2 right-4 z-10 flex -translate-y-1/2 items-center gap-1">
101:         <ScrcpySessions />
102: 
103:         <!-- 切换设备：首页右上角的下拉，展开期间父级才轮询设备列表 -->
104:         <PopoverRoot v-if="pageType === 'home'" v-model:open="menuOpen">
105:           <PopoverTrigger as-child>
106:             <BaseButton variant="secondary" :title="`切换设备：${deviceName}`" aria-label="切换设备">
107:               <span class="max-w-[200px] truncate font-semibold">{{ deviceName }}</span>
108:               <Icon icon="lucide:chevron-down" :width="14" :height="14"
109:                 class="shrink-0 transition-transform duration-150" :class="menuOpen ? 'rotate-180' : ''" />
110:             </BaseButton>
111:           </PopoverTrigger>
112:           <PopoverPortal>
113:             <PopoverContent side="bottom" align="end" :side-offset="8"
114:               class="z-50 w-[300px] rounded-[12px] border border-line bg-surface p-1.5 shadow-pop outline-none backdrop-blur-xl">
115:               <div class="px-2 pt-1 pb-1.5 text-[11px] font-medium text-ink-3">切换设备</div>
116: 
117:               <button v-for="item in devices" :key="item.address" type="button"
118:                 class="flex w-full items-center gap-2.5 rounded-[9px] px-2 py-1.5 text-left outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-45"
119:                 :class="isCurrent(item) ? 'bg-accent/[0.08]' : 'hover:bg-fill disabled:hover:bg-transparent'"
120:                 :disabled="!item.connected" @click="pickDevice(item)">
121:                 <div
122:                   class="flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-gradient-to-b from-[#5ac8fa] to-accent text-white shadow-[0_1px_2px_rgba(0,122,255,0.3)]">
123:                   <Icon icon="lucide:smartphone" :width="14" :height="14" />
124:                 </div>
125:                 <div class="min-w-0 flex-1">
126:                   <div class="flex items-center gap-1.5">
127:                     <span class="truncate text-[12.5px] font-medium text-ink">
128:                       {{ item.label || item.name || '未知设备' }}
129:                     </span>
130:                     <span v-if="item.transport === 'usb'"
131:                       class="shrink-0 rounded-[4px] bg-fill px-1 py-0.5 text-[10px] leading-none font-medium text-ink-3">
132:                       USB
133:                     </span>
134:                   </div>
135:                   <div class="mt-0.5 truncate text-[11px] text-ink-3">
136:                     {{ deviceHint(item) }}
137:                   </div>
138:                 </div>
139:                 <Icon v-if="isCurrent(item)" icon="lucide:check" :width="15" :height="15"
140:                   class="shrink-0 text-accent" />
141:                 <span v-else class="flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] leading-none"
142:                   :class="stateClass(item)">
143:                   <span class="size-1.5 rounded-full" :class="stateDotClass(item)" />
144:                   {{ stateText(item) }}
145:                 </span>
146:               </button>
147: 
148:               <div v-if="!devices.length" class="px-2 py-2 text-[12px] text-ink-3">正在查找设备…</div>
149: 
150:               <div class="mx-1.5 my-1 h-px bg-line" />
151: 
152:               <button type="button"
153:                 class="flex w-full items-center gap-2 rounded-[9px] px-2 py-1.5 text-left text-[12.5px] font-medium text-ink-2 outline-none transition-colors duration-150 hover:bg-fill hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/40"
154:                 @click="openPairDialog">
155:                 <Icon icon="lucide:qr-code" :width="15" :height="15" class="shrink-0" />
156:                 扫码配对新设备
157:               </button>
158:             </PopoverContent>
159:           </PopoverPortal>
160:         </PopoverRoot>

(Showing lines 1-160 of 181. Use offset=161 to continue.)
</content>
```

**Tool: bash**

**Input:**
```json
{
  "command": "rg -n \"listConnectDevices\" tests electron src docs; ls tests/electron"
}
```

**Output:**
```
docs/TODO.md:67:- 仍在跑的**设备类别分支**（不算 app 定制，但属特殊处理，保留还是收敛需拍板）：跳过 `emulator-*` 有三处（`listConnectDevices` / `getConnectedDevice` / `resolveDeviceStableId` 附近）；`getConnectedDevice` 优先带 `:` 或 `._adb-tls-connect` 的无线 serial；设备网络信息里优先 `wlan` 网卡；设备名读 `ro.product.marketname`（小米口味）。
src/api/index.js:8:  listConnectDevices,
src/api/index.js:78:export const listConnectDevicesApi = () => listConnectDevices();
electron/ipcContract.js:13:  adbListConnectDevices: 'adb:listConnectDevices',
electron/adb.js:397:async function listConnectDevices() {
electron/adb.js:1850:ipcMain.handle(CHANNELS.adbListConnectDevices, listConnectDevices);
electron/preload.js:37:    listConnectDevices: () => invoke(CHANNELS.adbListConnectDevices),
src/App.vue:9:  listConnectDevicesApi,
src/App.vue:266:      const devices = await listConnectDevicesApi();
src/App.vue:291:      const devices = await listConnectDevicesApi();
adbErrors.test.js
adbMdns.test.js
adbServerStart.test.js
adbTimeout.test.js
adbTransport.test.js
appActions.test.js
appCache.test.js
appCacheSchema.test.js
appSearch.test.js
appSession.test.js
devfs.test.js
deviceIdentity.test.js
deviceStats.test.js
favorites.test.js
fileCache.test.js
helper.test.js
iconImage.test.js
ipcContract.test.js
miProjection.test.js
mirrorControl.test.js
mirrorOptions.test.js
mirrorSession.test.js
permissions.test.js
readWindow.test.js
scrcpyConfig.test.js
shortcut.test.js
storage.test.js
webdav.test.js

```

---

## Assistant (Build · MiMo-V2.6-Flash Free · 48.3s)

_Thinking:_

No tests for listConnectDevices (it's tied to adb exec). Let's check deviceIdentity.js and how tests are run (package.json scripts).

Let me write the implementation.

Plan of edits:
1. `electron/adb.js`:
   - session memo in `resolveDeviceStableId` (so USB/connected serials resolve once per session).
   - `listConnectDevices`: build records with `stableId`, merge groups.
   - `getConnectedDevice`: add `stableId`.
2. `src/components/PageHeader.vue`: key + isCurrent via stableId.
3. `src/components/AddDeviceDialog.vue`: key.
4. `src/App.vue`: switchDevice/releasePrevious same-device check by stableId.

Let's check whether resolveDeviceStableId's session memo could break `findTransportByStableId` — no, it only helps.

Actually wait: do I even need the session memo if I gate resolve on `state === "device"`? Every poll (1s while menu open / discovery) would spawn adb shell per connected device. Memo needed. Implementation:

```js
/**本次进程内已解析过的标识：别名表只为「稳定标识 ≠ 传输地址」的地址落盘，
 *  USB这种两者相同的每次都要重新问设备，会把1s 的列表轮询变成一串 shell。 */
const sessionStableIds = new Map();
```
In resolveDeviceStableId: after computing `stable`, `sessionStableIds.set(serial, stable)`. And check at top: `const memo = sessionStableIds.get(serial); if (memo) return memo;` — but should memo be checked before alias? Alias is same source essentially; check alias first then memo (both sync).

Hmm careful: memo should be invalidated if... device disconnected and reconnected with different identity? Rare. Fine.

Now write code.

For listConnectDevices merge, need `serviceDeviceToken` (exported, in same file, defined at line 269 — function declaration, hoisted ✓).

Code:

```js
async function listConnectDevices() {
  ...
  const built = await Promise.all(
    entries.map(async ([serial, state]) => {
      const svc = bySerial.get(serial);
      if (state === "device") warmDeviceStableId(serial);
      const label = ...;
      const stableId = await deviceListStableId(serial, state);
      return {
        stableId,
        record: {
          stableId,
          name: svc?.name || serial,
          type: svc?.type || "",
          address: serial,
          displayAddress: svc?.address || serial,
          label,
          connected: state === "device",
          state,
          transport: deviceTransport(serial),
        },
      };
    }),
  );

  const merged = new Map();
  for (const { stableId, record } of built) {
    const existing = merged.get(stableId);
    merged.set(stableId, existing ? mergeDeviceRecords(existing, record) : record);
  }
  return [...merged.values()];
}
```

Wait — warmDeviceStableId is fire-and-forget but I'm now awaiting resolve in deviceListStableId which dedupes via `resolving` map. Actually warm call before await: both go through resolving map → same promise. Could drop warm call and just await. But warm also serves when state !== "device"? It's only called for state==="device". I'll keep warmDeviceStableId removed? It'd be redundant since we await. But await returns after resolve; keeping both is harmless. Simpler: replace warm call with the awaited stableId computation (which for state!=="device" doesn't spawn shell). Actually deviceListStableId for non-device state → sync only. For device state → awaited resolve. So warmDeviceStableId call becomes redundant → remove it? It's harmless but duplicate. I'll remove it and rely on the await (which also warms the alias, same effect).

Hmm but if resolve throws... resolveDeviceStableId catches and returns serial. Safe.

deviceListStableId:
```js
/**
 * 列表里一行的归组键：同一台设备的 USB serial / `host:port` / mDNS 实例名要落到同一个键上。
 * 先走同步路径（别名表、mDNS 服务名里嵌的序列号），只有在线设备且还没记过才问一次设备。
 */
async function deviceListStableId(serial, state) {
  const known = stableIdOf(serial);
  if (known !== serial) return known;
  const token = serviceDeviceToken(serial);
  if (token) return token;
  if (state !== "device") return serial;
  try {
    return (await resolveDeviceStableId(serial)) || serial;
  } catch {
    return serial;
  }
}
```
resolveDeviceStableId never throws (catches), but fine to keep try? It can't throw. Remove try.

Wait: an important issue: for a USB serial where ro.serialno ≠ adb serial, stableIdOf(usb) returns usb serial (no alias), token "" → await resolve → returns ro.serialno and remembers alias → future polls use alias ✓. And mDNS token = ro.serialno ✓ merge.

But careful — for wireless `192.168.1.5:5555` resolve returns ro.serialno; rememberAlias stores. ✓.

Edge: what if ro.serialno is empty/unknown for some device → pickStableId fallback → serial. Then usb key = serial... and wifi key = ro.serialno result? pickStableId(candidates, fallback=serial) — for wifi serial fallback is `192.168.1.5:5555` if no candidates. So keys differ → not merged (correct-ish, can't identify). Let's read pickStableId to be sure about android_id fallback: candidates: ro.serialno, ro.boot.serialno, android_id. If ro.serialno empty → android_id used → both transports get same android_id ✓ merge. 

Now mergeDeviceRecords / preferDeviceRecord:

```js
/** 同一台设备的多条传输里挑一条当代表：在线的优先，其次有线（地址稳定，断开/心跳都按它走）。 */
function preferDeviceRecord(a, b) {
  if (a.connected !== b.connected) return a.connected ? a : b;
  if (a.transport !== b.transport) return a.transport === "usb" ? a : b;
  return a;
}

function mergeDeviceRecords(a, b) {
  const main = preferDeviceRecord(a, b);
  const other = main === a ? b : a;
  // 名字优先用 mDNS 的 given_name（它一定不是 serial），没有就退回代表行的。
  const name = [main, other].find((r) => r.name && r.name !== r.address)?.name ?? main.name;
  return { ...main, name, label: main.label || other.label || null };
}
```

Note `main === a` reference compare works since we pass actual objects.

JSDoc update for listConnectDevices return: add stableId.

Now getConnectedDevice: add `stableId: await resolveDeviceStableId(address)` — hmm it may return address; fine. But resolve spawns shell → we now have session memo, so cheap-ish (one call per session). getConnectedDevice is called in connect() at mount and during recovery. Acceptable. Use a sync-safe approach: `const stableId = stableIdOf(address)`? That would miss when alias unknown (cold start) → activeDevice.stableId = address while list row stableId = ro.serialno → isCurrent mismatch → dropdown doesn't mark current. So await resolve. Do it.

Actually careful: getConnectedDevice also called with address that may be a device not yet authorized → resolve returns address. And list row same → merge fine.

Now UI:

PageHeader:
```js
function deviceKey(device) {
  return device?.stableId || device?.address
}
function isCurrent(device) {
  return !!props.activeDevice && deviceKey(device) === deviceKey(props.activeDevice)
}
```
and `:key="deviceKey(item)"`.

App.vue:
- switchDevice: `if (device.value && sameDevice(target, device.value)) return;`
- releasePrevious: `if (!previous || sameDevice(previous, target)) return;`
Define helper:
```js
/** 同一台设备：合并 USB / 无线两条传输后 address会不同，优先按稳定标识比。 */
const sameDevice = (a, b) => !!a && !!b && (a.stableId || a.address) === (b.stableId || b.address)
```
Careful: if one has stableId and other doesn't, `(a.stableId || a.address) === (b.stableId || b.address)` may compare ro.serialno vs address → false even if same device. E.g. device.value from getConnectedDevice (now has stableId ✓), target from list (has stableId ✓). listConnectDevices rows always have stableId (group key). adopted via connectTo target from AddDeviceDialog devices list (from listConnectDevices ✓) or discoverLoop ✓. getConnectedDevice ✓ now has stableId. So all sources have stableId. Fallback to address when missing is fine.

Hmm: but what if one side stableId present and other side missing (e.g., some other path)? Then false negative → releasePrevious runs redundantly (harmless-ish: releases same device resources then adopt → would tear down current session! That's a real problem: switching to "same" device would release then adopt → reconnect needed). Where could that happen? `adoptDevice(fresh || target)` in recovery where fresh = getConnectedDevice (has stableId) ✓.

Safer sameDevice: consider equal if either stableIds match, or addresses match:
```js
const sameDevice = (a, b) => !!a && !!b && (
  (a.stableId && b.stableId && a.stableId === b.stableId) || a.address === b.address
)
```
Good.

AddDeviceDialog key: `:key="device.stableId || device.address"`.

Also check home/index.vue uses `:key="device.address"` for the page remount — device.value only changes on adopt, fine.

Also `src/utils/deviceState.js` deviceHint: shows displayAddress; merged row one address ✓.

Now, is there anywhere else that renders device lists? AddDeviceDialog lines ~187. Let's read that portion.

Also check `docs/TODO.md` D4 mention — maybe update docs? Not necessary.

Let's also double check that merge doesn't break the "unauthorized" pair display: USB unauthorized (authorizing) + wifi connected → connected wins → shows connected row with USB transport? preferDeviceRecord: connected differs → wifi record (connected) wins → transport wifi. Hmm if phone plugged but not yet authorized while wifi authorized — fine.

One more: multiple distinct devices shouldn't merge. Different ro.serialno → different keys ✓. But two different phones with same android_id? Impossible (android_id unique per device). Two phones where one has empty ro.serialno and android_id... fine.

Potential false merge: serviceDeviceToken for a *different* device's mDNS name vs USB serial — token is the USB serial of that same phone typically.

Now also consider: `stableIdOf` returns alias for an old port → merge ✓.

Let's write the code edits.

**Tool: read**

**Input:**
```json
{
  "filePath": "/Users/xh/code/anddrive/electron/deviceIdentity.js"
}
```

**Output:**
```
<path>/Users/xh/code/anddrive/electron/deviceIdentity.js</path>
<type>file</type>
<content>
1: // ---------------------------------------------------------------------------
2: // 稳定设备标识
3: //
4: // 问题：adb 的「传输地址」不稳定。同一台手机无线重连一次就换一个端口
5: // （实测 `192.168.100.91:41185` → `:41335` → `:41759`），走 mDNS 时还会变成
6: // `adb-af3d7abd-XXXX._adb-tls-connect._tcp` 这种形式。凡是拿传输地址当持久化键的
7: // 东西（收藏、应用/图标缓存）每次重连都变成孤儿数据 —— 用户看到的就是「收藏记不住设备」。
8: //
9: // 解法：用设备自身的稳定序列号 `ro.serialno`（实测 `af3d7abd`，mDNS 服务名里嵌的也正是它），
10: // 拿不到再退 `ro.boot.serialno` → `settings secure android_id` → 传输地址（至少不比原来差）。
11: // ---------------------------------------------------------------------------
12: 
13: /** 稳定序列号不接受的取值：空、adb 在 Android 12+ 常给的占位值。 */
14: const INVALID_IDS = new Set(["", "unknown", "null", "0"]);
15: 
16: /**
17:  * 从若干候选值里挑第一个能用的（调用方按优先级传）。
18:  * @param {string[]} candidates
19:  * @param {string} fallback 全不可用时回退到传输地址
20:  * @returns {string}
21:  */
22: export function pickStableId(candidates, fallback) {
23:   for (const raw of candidates ?? []) {
24:     if (typeof raw !== "string") continue;
25:     const value = raw.trim();
26:     if (value && !INVALID_IDS.has(value.toLowerCase())) return value;
27:   }
28:   return String(fallback ?? "").trim();
29: }

(End of file - total 29 lines)
</content>
```

**Tool: read**

**Input:**
```json
{
  "filePath": "/Users/xh/code/anddrive/src/components/AddDeviceDialog.vue",
  "limit": 60,
  "offset": 170
}
```

**Output:**
```
<path>/Users/xh/code/anddrive/src/components/AddDeviceDialog.vue</path>
<type>file</type>
<content>
170:           </div>
171:           <div class="mt-3 flex h-4 items-center justify-center gap-2 text-[12px]">
172:             <span
173:               class="size-1.5 rounded-full"
174:               :class="status === 'error' ? 'bg-[#ff453a]' : 'animate-pulse bg-[#34c759]'"
175:             />
176:             <span :class="status === 'error' ? 'text-[#ff6961]' : 'text-ink-2'">
177:               {{ statusMessage }}
178:             </span>
179:           </div>
180:         </div>
181: 
182:         <div class="h-px bg-line" />
183: 
184:         <div class="px-5 py-3.5">
185:           <div class="text-[11px] font-medium text-ink-3">可用设备</div>
186:           <div class="mt-2 flex max-h-[184px] flex-col gap-1.5 overflow-y-auto">
187:             <div
188:               v-for="device in props.devices"
189:               :key="device.address"
190:               class="flex items-center gap-2.5 rounded-[12px] bg-surface-2/70 px-3 py-2.5 ring-1 ring-line"
191:             >
192:               <div
193:                 class="flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-gradient-to-b from-[#5ac8fa] to-accent text-white shadow-[0_1px_2px_rgba(0,122,255,0.3)]"
194:               >
195:                 <Icon icon="lucide:smartphone" :width="15" :height="15" />
196:               </div>
197:               <div class="min-w-0 flex-1">
198:                 <div class="flex items-center gap-1.5">
199:                   <span class="truncate text-[12.5px] font-medium text-ink">
200:                     {{ device.label || device.name || '未知设备' }}
201:                   </span>
202:                   <span
203:                     v-if="device.transport === 'usb'"
204:                     class="shrink-0 rounded-[4px] bg-fill px-1 py-0.5 text-[10px] leading-none font-medium text-ink-3"
205:                   >
206:                     USB
207:                   </span>
208:                   <span
209:                     class="flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] leading-none"
210:                     :class="stateClass(device)"
211:                   >
212:                     <span class="size-1.5 rounded-full" :class="stateDotClass(device)" />
213:                     {{ stateText(device) }}
214:                   </span>
215:                 </div>
216:                 <div class="mt-0.5 truncate text-[11px] text-ink-3">
217:                   {{ deviceHint(device) }}
218:                 </div>
219:               </div>
220:               <BaseButton
221:                 variant="primary"
222:                 size="sm"
223:                 :disabled="!device.connected"
224:                 @click="emit('connect', device)"
225:               >
226:                 连接
227:               </BaseButton>
228:             </div>
229: 

(Showing lines 170-229 of 258. Use offset=230 to continue.)
</content>
```

---

## Assistant (Build · MiMo-V2.6-Flash Free · 765.9s)

_Thinking:_

Now implement edits.

Edit 1: adb.js listConnectDevices + helpers.

Now I'll implement the merge in the main process:

**Tool: edit**

**Input:**
```json
{
  "filePath": "/Users/xh/code/anddrive/electron/adb.js",
  "oldString": " * `address` 一律取 adb 的 serial（可直接用于 `adb -s`），展示用 displayAddress。\n * `transport` 区分有线 / 无线：USB 直插的设备没有 mDNS 条目，展示与断开逻辑都按它分支。\n * 未授权（unauthorized）也返回，`connected: false` 供界面提示「在手机上点允许」。\n * @returns {Promise<{ name: string, type: string, address: string, displayAddress: string, label: string | null, connected: boolean, state: string, transport: \"usb\" | \"wifi\" }[]>}\n */\nasync function listConnectDevices() {",
  "newString": " * `address` 一律取 adb 的 serial（可直接用于 `adb -s`），展示用 displayAddress。\n * `transport` 区分有线 / 无线：USB 直插的设备没有 mDNS 条目，展示与断开逻辑都按它分支。\n * 未授权（unauthorized）也返回，`connected: false` 供界面提示「在手机上点允许」。\n *\n * **同一台手机插着线又开着无线调试时只出一行**：adb 里那是两条 transport\n * （`af3d7abd` 和 `192.168.1.5:37000` / `adb-af3d7abd-XXXX._adb-tls-connect._tcp`），\n * 这里按稳定标识归成一组，`stableId` 就是组键，`address` 取组里可用的那条传输。\n * @returns {Promise<{ stableId: string, name: string, type: string, address: string, displayAddress: string, label: string | null, connected: boolean, state: string, transport: \"usb\" | \"wifi\" }[]>}\n */\nasync function listConnectDevices() {"
}
```

**Output:**
```
Edit applied successfully.
```

---

## Assistant (Build · MiMo-V2.6-Flash Free · 11.9s)

_Thinking:_

Now the body. Replace lines from `const entries = ...` to the return.

**Tool: edit**

**Input:**
```json
{
  "filePath": "/Users/xh/code/anddrive/electron/adb.js",
  "newString": "  const entries = [...parseAdbDevices(devicesOutput)].filter(\n    ([serial]) => !serial.startsWith(\"emulator-\"),\n  );\n\n  const built = await Promise.all(\n    entries.map(async ([serial, state]) => {\n      const svc = bySerial.get(serial);\n      // 没授权的设备 shell 读什么都失败，直接不读，别让标签和名字一起卡住。\n      const label =\n        state === \"device\"\n          ? (svc && connectNames.get(svc.name)) || (await deviceDisplayName(serial)) || null\n          : null;\n      const stableId = await deviceListStableId(serial, state);\n      return {\n        stableId,\n        record: {\n          stableId,\n          name: svc?.name || serial,\n          // USB 直插没有 mDNS 服务条目，不硬塞一个无线服务类型骗界面。\n          type: svc?.type || \"\",\n          address: serial,\n          displayAddress: svc?.address || serial,\n          label,\n          connected: state === \"device\",\n          state,\n          transport: deviceTransport(serial),\n        },\n      };\n    }),\n  );\n\n  const merged = new Map();\n  for (const { stableId, record } of built) {\n    const existing = merged.get(stableId);\n    merged.set(stableId, existing ? mergeDeviceRecords(existing, record) : record);\n  }\n  return [...merged.values()];\n}\n\n/**\n * 一行设备的归组键：同一台手机的三条传输形态（USB serial / `host:port` /\n * mDNS 实例名）必须落到同一个键上，否则插线 + 开无线调试就显示成两台。\n * 先走同步路径（别名表、mDNS 服务名里嵌的 USB 序列号），在线且还没记过才问一次设备。\n * @param {string} serial\n * @param {string} state\n * @returns {Promise<string>}\n */\nasync function deviceListStableId(serial, state) {\n  const known = stableIdOf(serial);\n  if (known !== serial) return known;\n  // `adb-af3d7abd-XXXX._adb-tls-connect._tcp` 的 `af3d7abd` 就是 USB serial，同步就能对上。\n  const token = serviceDeviceToken(serial);\n  if (token) return token;\n  if (state !== \"device\") return serial;\n  return (await resolveDeviceStableId(serial)) || serial;\n}\n\n/** 同一台设备的多条传输里挑代表行：在线优先，其次有线（serial 稳定，心跳与断开都按它走）。 */\nfunction preferDeviceRecord(a, b) {\n  if (a.connected !== b.connected) return a.connected ? a : b;\n  if (a.transport !== b.transport) return a.transport === \"usb\" ? a : b;\n  return a;\n}\n\n/** 把同一台设备的两条传输并成一行：代表行定 address / transport，名字标签取两边更好的那个。 */\nfunction mergeDeviceRecords(a, b) {\n  const main = preferDeviceRecord(a, b);\n  const other = main === a ? b : a;\n  // 名字优先用 mDNS 的 given_name（它一定不等于 serial），没有就退回代表行的。\n  const name = [main, other].find((r) => r.name && r.name !== r.address)?.name ?? main.name;\n  return { ...main, name, label: main.label || other.label || null };\n}",
  "oldString": "  const entries = [...parseAdbDevices(devicesOutput)].filter(\n    ([serial]) => !serial.startsWith(\"emulator-\"),\n  );\n\n  return Promise.all(\n    entries.map(async ([serial, state]) => {\n      const svc = bySerial.get(serial);\n      if (state === \"device\") warmDeviceStableId(serial);\n      // 没授权的设备 shell 读什么都失败，直接不读，别让标签和名字一起卡住。\n      const label =\n        state === \"device\"\n          ? (svc && connectNames.get(svc.name)) || (await deviceDisplayName(serial)) || null\n          : null;\n      return {\n        name: svc?.name || serial,\n        // USB 直插没有 mDNS 服务条目，不硬塞一个无线服务类型骗界面。\n        type: svc?.type || \"\",\n        address: serial,\n        displayAddress: svc?.address || serial,\n        label,\n        connected: state === \"device\",\n        state,\n        transport: deviceTransport(serial),\n      };\n    }),\n  );\n}"
}
```

**Output:**
```
Edit applied successfully.
```

---

## Assistant (Build · MiMo-V2.6-Flash Free · 7.4s)

_Thinking:_

Now: `warmDeviceStableId` may become unused — check other usages. Also add session memo in resolveDeviceStableId, and stableId in getConnectedDevice.

**Tool: bash**

**Input:**
```json
{
  "command": "rg -n \"warmDeviceStableId\" electron src"
}
```

**Output:**
```
electron/adb.js:950:function warmDeviceStableId(serial) {

```

---

## Assistant (Build · MiMo-V2.6-Flash Free · 8.9s)

_Thinking:_

warmDeviceStableId now unused → remove it (and its doc) to avoid lint unused error. But maybe better keep the "warm" semantic: it's the same as awaiting resolve. I'll remove it.

Also add session memo to resolveDeviceStableId.

**Tool: read**

**Input:**
```json
{
  "filePath": "/Users/xh/code/anddrive/electron/adb.js",
  "limit": 60,
  "offset": 895
}
```

**Output:**
```
<path>/Users/xh/code/anddrive/electron/adb.js</path>
<type>file</type>
<content>
895:   } catch (error) {
896:     console.warn("Failed to write device aliases:", error);
897:   }
898: }
899: 
900: function rememberAlias(transport, stable) {
901:   if (!transport || !stable || stable === transport) return;
902:   if (stableAliases.get(transport) === stable) return;
903:   stableAliases.set(transport, stable);
904:   void persistAliases();
905: }
906: 
907: /**
908:  * 同步取已知标识，没记录就回传输地址。**读路径用它**：设备还没连上也要能秒开缓存。
909:  * @param {string} transport
910:  */
911: export function stableIdOf(transport) {
912:   loadAliases();
913:   return stableAliases.get(transport) || transport;
914: }
915: 
916: /**
917:  * 向设备问一次稳定标识：`ro.serialno` → `ro.boot.serialno` → `settings secure android_id`。
918:  * 问不到（掉线、没这台设备）就回传输地址，并且**不写别名表**，下次连上还会再解析。
919:  * @param {string} serial
920:  * @returns {Promise<string>}
921:  */
922: export async function resolveDeviceStableId(serial) {
923:   if (typeof serial !== "string" || !serial) return "";
924:   loadAliases();
925:   const known = stableAliases.get(serial);
926:   if (known) return known;
927:   const pending = resolving.get(serial);
928:   if (pending) return pending;
929:   const task = (async () => {
930:     const { stdout, stderr } = await adbExecSafe(
931:       "-s",
932:       serial,
933:       "shell",
934:       "getprop ro.serialno; getprop ro.boot.serialno; settings get secure android_id",
935:     );
936:     const lines = `${stdout}\n${stderr}`.split("\n").map((line) => line.trim());
937:     const stable = pickStableId(lines.slice(0, 3), serial);
938:     rememberAlias(serial, stable);
939:     return stable;
940:   })().finally(() => resolving.delete(serial));
941:   resolving.set(serial, task);
942:   try {
943:     return await task;
944:   } catch {
945:     return serial;
946:   }
947: }
948: 
949: /** 设备列表里顺手预热别名（不阻塞返回）。 */
950: function warmDeviceStableId(serial) {
951:   void resolveDeviceStableId(serial).catch(() => {});
952: }
953: 
954: /**

(Showing lines 895-954 of 2021. Use offset=955 to continue.)
</content>
```

---

## Assistant (Build · MiMo-V2.6-Flash Free · 13.7s)

_Thinking:_

Add session memo:

- module: `/**本次进程内问到的标识：别名表只为「标识 ≠ 传输地址」的地址落盘，USB 这种相同的每次重问会把 1s 的列表轮询变成一串 shell。 */ const sessionStableIds = new Map();`

In resolveDeviceStableId: after known check, `const memo = sessionStableIds.get(serial); if (memo) return memo;` and inside task `sessionStableIds.set(serial, stable)`.

Careful: memo stores also failures? Only set on success path (stable computed). If adb shell fails → catch returns serial, not memoized → next poll retries. Good (device may come online later).

But note: for USB where stable === serial, memo hit means no alias. findTransportByStableId works anyway.

Also careful: memo vs `resolving` dedupe — both fine.

Hmm one concern: memo for a wireless serial whose port later changes → new serial key → separate memo entry. Fine.

Also if a device's identity changes (factory reset) — negligible.

Now remove warmDeviceStableId and replace with memo.

**Tool: edit**

**Input:**
```json
{
  "filePath": "/Users/xh/code/anddrive/electron/adb.js",
  "newString": "/** 本次进程内问到的标识：别名表只为「标识 ≠ 传输地址」的地址落盘，USB 这种相同的\n * 每次都重问会把 1s 一轮的设备列表变成一串 shell，所以进程内也记一份。 */\nconst sessionStableIds = new Map();\n\n/**\n * 向设备问一次稳定标识：`ro.serialno` → `ro.boot.serialno` → `settings secure android_id`。\n * 问不到（掉线、没这台设备）就回传输地址，并且**不写别名表**，下次连上还会再解析。\n * @param {string} serial\n * @returns {Promise<string>}\n */\nexport async function resolveDeviceStableId(serial) {\n  if (typeof serial !== \"string\" || !serial) return \"\";\n  loadAliases();\n  const known = stableAliases.get(serial) || sessionStableIds.get(serial);\n  if (known) return known;\n  const pending = resolving.get(serial);\n  if (pending) return pending;\n  const task = (async () => {\n    const { stdout, stderr } = await adbExecSafe(\n      \"-s\",\n      serial,\n      \"shell\",\n      \"getprop ro.serialno; getprop ro.boot.serialno; settings get secure android_id\",\n    );\n    const lines = `${stdout}\\n${stderr}`.split(\"\\n\").map((line) => line.trim());\n    const stable = pickStableId(lines.slice(0, 3), serial);\n    sessionStableIds.set(serial, stable);\n    rememberAlias(serial, stable);\n    return stable;\n  })().finally(() => resolving.delete(serial));\n  resolving.set(serial, task);\n  try {\n    return await task;\n  } catch {\n    return serial;\n  }\n}\n",
  "oldString": "/**\n * 向设备问一次稳定标识：`ro.serialno` → `ro.boot.serialno` → `settings secure android_id`。\n * 问不到（掉线、没这台设备）就回传输地址，并且**不写别名表**，下次连上还会再解析。\n * @param {string} serial\n * @returns {Promise<string>}\n */\nexport async function resolveDeviceStableId(serial) {\n  if (typeof serial !== \"string\" || !serial) return \"\";\n  loadAliases();\n  const known = stableAliases.get(serial);\n  if (known) return known;\n  const pending = resolving.get(serial);\n  if (pending) return pending;\n  const task = (async () => {\n    const { stdout, stderr } = await adbExecSafe(\n      \"-s\",\n      serial,\n      \"shell\",\n      \"getprop ro.serialno; getprop ro.boot.serialno; settings get secure android_id\",\n    );\n    const lines = `${stdout}\\n${stderr}`.split(\"\\n\").map((line) => line.trim());\n    const stable = pickStableId(lines.slice(0, 3), serial);\n    rememberAlias(serial, stable);\n    return stable;\n  })().finally(() => resolving.delete(serial));\n  resolving.set(serial, task);\n  try {\n    return await task;\n  } catch {\n    return serial;\n  }\n}\n\n/** 设备列表里顺手预热别名（不阻塞返回）。 */\nfunction warmDeviceStableId(serial) {\n  void resolveDeviceStableId(serial).catch(() => {});\n}\n"
}
```

**Output:**
```
Edit applied successfully.
```

---

## Assistant (Build · MiMo-V2.6-Flash Free · 4.5s)

_Thinking:_

Now getConnectedDevice: add stableId. Let's edit its return and JSDoc.

**Tool: edit**

**Input:**
```json
{
  "filePath": "/Users/xh/code/anddrive/electron/adb.js",
  "newString": " * @returns {Promise<{ stableId: string, name: string, address: string, displayAddress: string, label: string | null, transport: \"usb\" | \"wifi\" } | null>}\n */",
  "oldString": " * @returns {Promise<{ name: string, address: string, displayAddress: string, label: string | null, transport: \"usb\" | \"wifi\" } | null>}\n */"
}
```

**Output:**
```
Edit applied successfully.
```

---

## Assistant (Build · MiMo-V2.6-Flash Free · 6.9s)

_Thinking:_

Now the return statement of getConnectedDevice:

```js
  return { name, address, displayAddress, label, transport: deviceTransport(address) };
```
→ add `stableId: (await resolveDeviceStableId(address)) || address`.

Note: resolveDeviceStableId on a connected device costs a shell first time per session — acceptable.

Hmm, but wait: does this spawn for devices in `unauthorized` state? getConnectedDevice filters state === "device". OK.

Careful: resolveDeviceStableId might be slow-ish (3 commands in one shell). Only once per session.

**Tool: edit**

**Input:**
```json
{
  "filePath": "/Users/xh/code/anddrive/electron/adb.js",
  "newString": "  return {\n    name,\n    address,\n    displayAddress,\n    label,\n    transport: deviceTransport(address),\n    // 和设备列表同一套组键：切换设备下拉靠它认出「这就是同一台」\n    stableId: (await resolveDeviceStableId(address)) || address,\n  };\n}",
  "oldString": "  return { name, address, displayAddress, label, transport: deviceTransport(address) };\n}"
}
```

**Output:**
```
Edit applied successfully.
```

---

## Assistant (Build · MiMo-V2.6-Flash Free · 6.4s)

_Thinking:_

Now frontend:

1. PageHeader.vue: deviceKey + isCurrent + :key.
2. AddDeviceDialog.vue: :key.
3. App.vue: sameDevice helper for switchDevice & releasePrevious.

**Tool: edit**

**Input:**
```json
{
  "filePath": "/Users/xh/code/anddrive/src/components/PageHeader.vue",
  "newString": "/** 列表行的身份：同一台设备的有线/无线两条传输合并后 address 会不同，优先按稳定标识。 */\nfunction deviceKey(device) {\n  return device?.stableId || device?.address || ''\n}\n\n/** 下拉里这行是不是正在用的那台。 */\nfunction isCurrent(device) {\n  return !!props.activeDevice && !!deviceKey(device) && deviceKey(device) === deviceKey(props.activeDevice)\n}",
  "oldString": "/** 下拉里这行是不是正在用的那台。 */\nfunction isCurrent(device) {\n  return !!props.activeDevice && device.address === props.activeDevice.address\n}"
}
```

**Output:**
```
Edit applied successfully.
```

**Tool: edit**

**Input:**
```json
{
  "filePath": "/Users/xh/code/anddrive/src/components/PageHeader.vue",
  "newString": "              <button v-for=\"item in devices\" :key=\"deviceKey(item)\" type=\"button\"",
  "oldString": "              <button v-for=\"item in devices\" :key=\"item.address\" type=\"button\""
}
```

**Output:**
```
Edit applied successfully.
```

**Tool: edit**

**Input:**
```json
{
  "filePath": "/Users/xh/code/anddrive/src/components/AddDeviceDialog.vue",
  "newString": "              :key=\"device.stableId || device.address\"",
  "oldString": "              :key=\"device.address\""
}
```

**Output:**
```
Edit applied successfully.
```

---

## Assistant (Build · MiMo-V2.6-Flash Free · 6.6s)

_Thinking:_

Also PageHeader isCurrent guard in pickDevice uses isCurrent ✓.

Now App.vue: sameDevice for switchDevice and releasePrevious.

**Tool: edit**

**Input:**
```json
{
  "filePath": "/Users/xh/code/anddrive/src/App.vue",
  "newString": "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));\n\n// 同一台设备：列表里有线/无线已合并成一行，但接管进来的可能是其中任意一条传输，\n// 所以先比稳定标识，再退回 address。\nfunction sameDevice(a, b) {\n  if (!a || !b) return false\n  return (!!a.stableId && !!b.stableId && a.stableId === b.stableId) || a.address === b.address\n}",
  "oldString": "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));"
}
```

**Output:**
```
Edit applied successfully.
```

---

## Assistant (Build · MiMo-V2.6-Flash Free · 6.4s)

_Thinking:_

Wait — code style in App.vue uses semicolons (`const sleep = (ms) => new Promise(...);`). Let me match: my new function uses no semicolons. Fix to consistent style with semicolons.

**Tool: edit**

**Input:**
```json
{
  "filePath": "/Users/xh/code/anddrive/src/App.vue",
  "newString": "function sameDevice(a, b) {\n  if (!a || !b) return false;\n  return (!!a.stableId && !!b.stableId && a.stableId === b.stableId) || a.address === b.address;\n}",
  "oldString": "function sameDevice(a, b) {\n  if (!a || !b) return false\n  return (!!a.stableId && !!b.stableId && a.stableId === b.stableId) || a.address === b.address\n}"
}
```

**Output:**
```
Edit applied successfully.
```

---

## Assistant (Build · MiMo-V2.6-Flash Free · 4.5s)

_Thinking:_

Also PageHeader.vue style: no semicolons there (it uses no-semicolon style). My deviceKey/isCurrent additions use no semicolons ✓ matching.

Now update switchDevice and releasePrevious.

**Tool: edit**

**Input:**
```json
{
  "filePath": "/Users/xh/code/anddrive/src/App.vue",
  "newString": "async function releasePrevious(target) {\n  const previous = device.value;\n  if (!previous || sameDevice(previous, target)) return;",
  "oldString": "async function releasePrevious(target) {\n  const previous = device.value;\n  if (!previous || previous.address === target.address) return;"
}
```

**Output:**
```
Edit applied successfully.
```

**Tool: edit**

**Input:**
```json
{
  "filePath": "/Users/xh/code/anddrive/src/App.vue",
  "newString": "  if (device.value && sameDevice(target, device.value)) return;",
  "oldString": "  if (device.value && target.address === device.value.address) return;"
}
```

**Output:**
```
Edit applied successfully.
```

---

## Assistant (Build · MiMo-V2.6-Flash Free · 8.1s)

_Thinking:_

Also, the home page header: `src/components/home/index.vue` has `:key` with device? Let's check whether `:key="device.address"` exists there — line 83 title. It's `device` prop object passed; page remount key probably in App.vue template: let's check App.vue template for `:key="device.address"`.

Also deviceState.js deviceHint — fine.

Also healthLoop: if the adopted device.value.address is a transport that goes away while another transport of the same device is still alive, the app reports lost. Consider improving: healthLoop could check by stableId... Out of scope-ish, but is it? The user complaint is only display. Keep scope.

Hmm, but there's a subtle issue with merging + `releasePrevious`: previously switching away and back worked by address; unchanged.

Now check App.vue template keys.

**Tool: bash**

**Input:**
```json
{
  "command": "rg -n \"device.address|:key=\" src/App.vue src/components/home/index.vue"
}
```

**Output:**
```
src/components/home/index.vue:36:    getDeviceStatsApi(props.device.address),
src/components/home/index.vue:37:    getStorageVolumesApi(props.device.address),
src/components/home/index.vue:83:      <span :title="`${deviceTitle} · ${device.displayAddress || device.address}`"
src/components/home/index.vue:112:                <DeviceStats :serial="device.address" />
src/components/home/index.vue:127:                <StoragePanel :serial="device.address" :device-label="deviceTitle" />
src/components/home/index.vue:140:    <AppList :address="device.address" />
src/App.vue:229:// 首页各面板按 `:key="device.address"` 重挂，切过去会重新拉数据。
src/App.vue:388:  <PageHome v-else-if="pageType === 'home'" :key="device.address" :device="device" />
src/App.vue:391:  <PageSettings v-else-if="pageType === 'settings'" :key="device.address" :serial="device.address" />

```

**Tool: bash**

**Input:**
```json
{
  "command": "rg -n \"stableId\" src electron | grep -v node_modules"
}
```

**Output:**
```
electron/favorites.js:92:  const stableId = await resolveStableId(serial);
electron/favorites.js:94:  return store[stableId] || [];
electron/favorites.js:107:  const stableId = await resolveStableId(serial);
electron/favorites.js:109:  const current = new Set(store[stableId] || []);
electron/favorites.js:112:  store[stableId] = [...current].slice(0, MAX_FAVORITES_PER_DEVICE);
electron/favorites.js:118:  return store[stableId];
src/components/AddDeviceDialog.vue:189:              :key="device.stableId || device.address"
electron/adb.js:398: * 这里按稳定标识归成一组，`stableId` 就是组键，`address` 取组里可用的那条传输。
electron/adb.js:399: * @returns {Promise<{ stableId: string, name: string, type: string, address: string, displayAddress: string, label: string | null, connected: boolean, state: string, transport: "usb" | "wifi" }[]>}
electron/adb.js:429:      const stableId = await deviceListStableId(serial, state);
electron/adb.js:431:        stableId,
electron/adb.js:433:          stableId,
electron/adb.js:449:  for (const { stableId, record } of built) {
electron/adb.js:450:    const existing = merged.get(stableId);
electron/adb.js:451:    merged.set(stableId, existing ? mergeDeviceRecords(existing, record) : record);
electron/adb.js:465:  const known = stableIdOf(serial);
electron/adb.js:494: * @returns {Promise<{ stableId: string, name: string, address: string, displayAddress: string, label: string | null, transport: "usb" | "wifi" } | null>}
electron/adb.js:533:    stableId: (await resolveDeviceStableId(address)) || address,
electron/adb.js:732:  const stable = stableIdOf(serial);
electron/adb.js:872:/** @type {Map<string, string>} transport → stableId */
electron/adb.js:919:export function stableIdOf(transport) {
electron/adb.js:967: * @param {string} stableId
electron/adb.js:970:export async function findTransportByStableId(stableId) {
electron/adb.js:971:  if (typeof stableId !== "string" || !stableId) return null;
electron/adb.js:974:    if (value !== stableId) continue;
electron/adb.js:986:    if ((await resolveDeviceStableId(serial)) === stableId) return serial;
electron/adb.js:993:  const known = stableIdOf(serial);
electron/adb.js:1042:  return withCacheLock(cachePath(stableIdOf(serial)), async () => {
electron/adb.js:1052:    iconPrunedAt.delete(iconDir(stableIdOf(serial)));
electron/adb.js:1140: * 键用 `stableIdOf`（只查已落盘的别名表，**绝不在这里 spawn adb**）：既让同一台设备的
electron/adb.js:1175:  const stable = stableIdOf(serial);
src/components/PageHeader.vue:42:  return device?.stableId || device?.address || ''
electron/shortcut.js:71:  let stableId = "";
electron/shortcut.js:73:    stableId = await resolveDeviceStableId(sanitizeSerial(payload?.address));
electron/shortcut.js:77:  const serial = sanitizeSerial(stableId || payload?.address);
src/App.vue:50:  return (!!a.stableId && !!b.stableId && a.stableId === b.stableId) || a.address === b.address;

```

---

## Assistant (Build · MiMo-V2.6-Flash Free · 24.1s)

_Thinking:_

App.vue `:key="device.address"` for PageHome — device is adopted object; switching between transports of the same device (address change) would remount... only when device.value changes (adopt). When switching device rows of the same physical device (shouldn't happen now since merged). But if same device adopted via different transport while already home? e.g. switchDevice with sameDevice → returns early ✓. connect→adopt fresh. Fine.

Now: also consider the discoverLoop auto-adopt `devices.find((d) => d.connected)` — merged rows fine.

Now, a gap: `getDeviceState(current.address)` in healthLoop uses the address of the adopted record. If adopted record is USB and USB unplugged while wifi still connected → connection lost → recovery → getConnectedDevice returns wifi → re-adopt. Acceptable.

Now check whether there's an issue with `resolveDeviceStableId` being awaited inside listConnectDevices for state "device": for mDNS-form serial we return early with token (never spawn) ✓; for USB serial: known===serial (no alias) → token "" → await resolve → first time shell, memoized ✓; for `host:port` → alias or shell ✓.

Wait: there's an ordering issue — for USB serial, `stableIdOf` returns serial; then token for USB serial: serviceDeviceToken('af3d7abd') → value doesn't start with "adb-" → "" ✓.

But what about wireless serial `adb-XXXX._adb-tls-connect._tcp` where the token is a *random* id rather than the device's serial? serviceDeviceToken assumes `adb-<usbserial>[-random]`. On some Android versions, the mDNS instance name for wireless debugging is `adb-<random>` not containing serial! Comment in deviceIdentity says mDNS service name embeds ro.serialno (measured). But parseAdbDevices comment says `adb-XXXX._adb-tls-connect._tcp`. If XXXX is random and doesn't equal USB serial, then token key ≠ USB serial key → no merge (2 rows still), AND worse, token could theoretically collide across... no, random tokens are unique per device, so no false merge. Just missed merge in that case.

But could the token cause a *false* mismatch that breaks the alias path? In deviceListStableId, we check alias FIRST, so if alias exists we use it (correct). Token only used when no alias. So worst case = today's behavior.

Hmm, but actually if token is random and doesn't equal ro.serialno, then merging relies on alias from shell resolve of the mDNS serial → same ro.serialno as USB (after USB resolves too). But my order returns token before shell resolve → no merge. Better ordering: for mDNS-form serial, prefer shell resolve (which gives the true ro.serialno) but that spawns a shell each... no, session memo caches it. So for connected mDNS serial we could just always await resolve and use token only as a sync fallback for non-connected states.

Simplify deviceListStableId:
```js
async function deviceListStableId(serial, state) {
  const known = stableIdOf(serial);
  if (known !== serial) return known;
  if (state !== "device") {
    // 拿不到 shell（未授权/离线）时的同步兜底：mDNS 实例名里嵌的序列号
    return serviceDeviceToken(serial) || serial;
  }
  return (await resolveDeviceStableId(serial)) || serial;
}
```
This means for connected devices we always resolve via shell (memoized after first). If shell fails → returns serial (fallback). For mDNS-form serial with random token → resolve gives real ro.serialno → merges with USB if USB also resolved to same. ✓

Cost: one shell per serial per session. OK.

But subtlety: resolve for mDNS serial where shell works → remembers alias → good for cold start next time? Alias persists across sessions ✓ (only if stable ≠ transport, which holds for mDNS-form serial).

Let me rewrite deviceListStableId accordingly.

Also: what if shell resolve returns a *different* value than the USB serial's resolve? They both query the same phone → same ro.serialno ✓.

One more: two devices where one is offline/unauthorized — no merge possible; fine.

Now edge: USB serial connected but not authorized (state "authorizing") while the same phone is connected over wifi (state device): USB key = token||serial = serial; wifi key = ro.serialno. If ro.serialno === usb serial → merge ✓ (usb serial usually == ro.serialno). Good.

Let's apply.

**Tool: read**

**Input:**
```json
{
  "filePath": "/Users/xh/code/anddrive/electron/adb.js",
  "limit": 55,
  "offset": 415
}
```

**Output:**
```
<path>/Users/xh/code/anddrive/electron/adb.js</path>
<type>file</type>
<content>
415:   }
416: 
417:   const entries = [...parseAdbDevices(devicesOutput)].filter(
418:     ([serial]) => !serial.startsWith("emulator-"),
419:   );
420: 
421:   const built = await Promise.all(
422:     entries.map(async ([serial, state]) => {
423:       const svc = bySerial.get(serial);
424:       // 没授权的设备 shell 读什么都失败，直接不读，别让标签和名字一起卡住。
425:       const label =
426:         state === "device"
427:           ? (svc && connectNames.get(svc.name)) || (await deviceDisplayName(serial)) || null
428:           : null;
429:       const stableId = await deviceListStableId(serial, state);
430:       return {
431:         stableId,
432:         record: {
433:           stableId,
434:           name: svc?.name || serial,
435:           // USB 直插没有 mDNS 服务条目，不硬塞一个无线服务类型骗界面。
436:           type: svc?.type || "",
437:           address: serial,
438:           displayAddress: svc?.address || serial,
439:           label,
440:           connected: state === "device",
441:           state,
442:           transport: deviceTransport(serial),
443:         },
444:       };
445:     }),
446:   );
447: 
448:   const merged = new Map();
449:   for (const { stableId, record } of built) {
450:     const existing = merged.get(stableId);
451:     merged.set(stableId, existing ? mergeDeviceRecords(existing, record) : record);
452:   }
453:   return [...merged.values()];
454: }
455: 
456: /**
457:  * 一行设备的归组键：同一台手机的三条传输形态（USB serial / `host:port` /
458:  * mDNS 实例名）必须落到同一个键上，否则插线 + 开无线调试就显示成两台。
459:  * 先走同步路径（别名表、mDNS 服务名里嵌的 USB 序列号），在线且还没记过才问一次设备。
460:  * @param {string} serial
461:  * @param {string} state
462:  * @returns {Promise<string>}
463:  */
464: async function deviceListStableId(serial, state) {
465:   const known = stableIdOf(serial);
466:   if (known !== serial) return known;
467:   // `adb-af3d7abd-XXXX._adb-tls-connect._tcp` 的 `af3d7abd` 就是 USB serial，同步就能对上。
468:   const token = serviceDeviceToken(serial);
469:   if (token) return token;

(Showing lines 415-469 of 2029. Use offset=470 to continue.)
</content>
```

---

## Assistant (Build · MiMo-V2.6-Flash Free · 9.4s)

_Thinking:_

Rewrite the doc + function to prefer shell resolve for connected, token only as offline/unauthorized fallback.

**Tool: edit**

**Input:**
```json
{
  "filePath": "/Users/xh/code/anddrive/electron/adb.js",
  "newString": "/**\n * 一行设备的归组键：同一台手机的三条传输形态（USB serial / `host:port` /\n * mDNS 实例名）必须落到同一个键上，否则插线 + 开无线调试就显示成两台。\n *\n * 先查别名表（同步、已落盘）；在线设备再向它问一次 `ro.serialno`\n * （进程内有缓存，每台每次会话只问一回）；问不到（未授权 / 离线）才用同步兜底\n * ——mDNS 实例名 `adb-af3d7abd-XXXX._adb-tls-connect._tcp` 里嵌的就是 USB serial。\n * @param {string} serial\n * @param {string} state\n * @returns {Promise<string>}\n */\nasync function deviceListStableId(serial, state) {\n  const known = stableIdOf(serial);\n  if (known !== serial) return known;\n  if (state !== \"device\") return serviceDeviceToken(serial) || serial;\n  return (await resolveDeviceStableId(serial)) || serial;\n}",
  "oldString": "/**\n * 一行设备的归组键：同一台手机的三条传输形态（USB serial / `host:port` /\n * mDNS 实例名）必须落到同一个键上，否则插线 + 开无线调试就显示成两台。\n * 先走同步路径（别名表、mDNS 服务名里嵌的 USB 序列号），在线且还没记过才问一次设备。\n * @param {string} serial\n * @param {string} state\n * @returns {Promise<string>}\n */\nasync function deviceListStableId(serial, state) {\n  const known = stableIdOf(serial);\n  if (known !== serial) return known;\n  // `adb-af3d7abd-XXXX._adb-tls-connect._tcp` 的 `af3d7abd` 就是 USB serial，同步就能对上。\n  const token = serviceDeviceToken(serial);\n  if (token) return token;\n  if (state !== \"device\") return serial;\n  return (await resolveDeviceStableId(serial)) || serial;\n}"
}
```

**Output:**
```
Edit applied successfully.
```

---

## Assistant (Build · MiMo-V2.6-Flash Free · 15.2s)

_Thinking:_

Wait — there's a problem: for state !== "device" (e.g. USB `authorizing` + wifi `device`), the USB entry key = serial (token "" for usb serial). The wifi entry key = ro.serialno. If ro.serialno === usb serial → merge ✓ (common). Fine.

But worse: for a USB device in `authorizing` state alone: key = serial. Later it becomes `device` → resolve → key = ro.serialno which may differ from serial (rare). Row key changes across polls → Vue re-key → minor remount, fine.

Now consider `resolveDeviceStableId` failure (e.g. shell timeout) returns serial → for wifi serial key = `host:port` → row separate that poll, merges next poll. Acceptable.

Hmm, but there's a bigger risk: awaiting resolve adds latency to the list when alias unknown — resolveDeviceStableId runs adb shell (adbExecSafe with default timeout). deviceDisplayName already does the same for connected devices. But now we do it for *every* connected device every time the alias is unknown — that's just once per session per serial. However: for USB serial where ro.serialno === serial, rememberAlias skips persisting, so we rely on sessionStableIds memo — that's in-memory ✓ persists for app session.

But careful: `resolveDeviceStableId` is also called by favorites/shortcuts with same serial — they now benefit from memo.

Potential issue: `sessionStableIds` never invalidates even if device unplugged/replugged with a different identity (impossible for same port/serial).

Edge: `host:port` wireless serial reconnects with new port → new key needed → not in memo → resolves fresh ✓.

Now: what about *false merging* risk with android_id? If ro.serialno and ro.boot.serialno are invalid, both transports get android_id → same → merge ✓ correct.

Now the "label" for merged: representative chosen by connected>usb. Fine.

Next: potential issue with `mergeDeviceRecords` name selection: `[main, other].find(r => r.name && r.name !== r.address)?.name ?? main.name`. For USB record name = serial (=== address) → skipped; wifi record name = mDNS name → picked ✓. If neither has nice name → main.name = its own serial ✓.

Now run lint/typecheck and tests. Check package.json scripts.

**Tool: bash**

**Input:**
```json
{
  "command": "cat package.json | sed -n '1,60p'"
}
```

**Output:**
```
{
  "name": "anddrive_next",
  "version": "0.0.4",
  "private": true,
  "type": "module",
  "main": "dist-electron/main.js",
  "scripts": {
    "dev": "vite",
    "build:prod": "node scripts/verify-resources.mjs && vite build && electron-builder",
    "build": "export BETA_TAG=${BETA_TAG:-$(date -u +%Y%m%d%H%M)} APP_CHANNEL=beta; node scripts/verify-resources.mjs && vite build && electron-builder --config electron-builder.beta.mjs",
    "verify-resources": "node scripts/verify-resources.mjs",
    "build-helper": "bash scripts/build-helper.sh",
    "cert": "bash scripts/create-signing-cert.sh",
    "cert:export": "bash scripts/export-signing-cert.sh",
    "cert:install": "bash scripts/install-signing-cert.sh",
    "download-adb": "bash scripts/download-adb.sh",
    "mirror:spike": "node scripts/mirror-spike.mjs",
    "shortcut:fix": "node scripts/fix-shortcut-association.mjs",
    "preview": "vite preview",
    "lint": "run-s lint:oxlint lint:eslint",
    "lint:oxlint": "oxlint .",
    "lint:eslint": "eslint . --no-cache",
    "lint:fix": "run-s lint:fix:oxlint lint:fix:eslint",
    "lint:fix:oxlint": "oxlint . --fix",
    "lint:fix:eslint": "eslint . --fix --cache",
    "format": "oxfmt src electron shared tests scripts vite.config.js vitest.config.js eslint.config.js",
    "format:check": "oxfmt --check src electron shared tests scripts vite.config.js vitest.config.js eslint.config.js",
    "test": "vitest run --config vitest.config.js",
    "typecheck": "tsc --project jsconfig.typecheck.json",
    "test:helper": "helper-app/gradlew -p helper-app testDebugUnitTest",
    "lint:helper": "helper-app/gradlew -p helper-app lintDebug"
  },
  "devDependencies": {
    "@eslint/js": "^10.0.1",
    "@iconify-json/lucide": "^1.2.137",
    "@iconify/vue": "^5.0.3",
    "@tailwindcss/vite": "^4.3.3",
    "@types/node": "^26.6.3",
    "@typescript-eslint/parser": "^8.70.1",
    "@typescript/native": "npm:typescript@^7.0.2",
    "@vitejs/plugin-vue": "^6.0.9",
    "electron": "^44.4.5",
    "electron-builder": "^26.15.3",
    "eslint": "^10.11.0",
    "eslint-config-prettier": "^10.1.8",
    "eslint-plugin-oxlint": "~1.85.0",
    "eslint-plugin-vue": "~10.11.1",
    "globals": "^17.12.0",
    "motion-v": "^2.5.0",
    "npm-run-all2": "^9.0.3",
    "oxfmt": "^0.70.0",
    "oxlint": "~1.85.0",
    "reka-ui": "^2.10.5",
    "tailwindcss": "^4.3.3",
    "typescript": "npm:@typescript/typescript6@^6.0.2",
    "unplugin-auto-import": "^21.1.0",
    "unplugin-vue-components": "^32.1.0",
    "uqr": "^0.1.3",
    "vite": "^8.3.1",
    "vite-plugin-electron": "^1.1.2",

```

---

## Assistant (Build · MiMo-V2.6-Flash Free · 7.9s)

_Thinking:_

Run lint + typecheck + tests. Also maybe write a test for the merge? tests/electron has adbMdns.test.js which imports pure functions. listConnectDevices is not exported... it's internal (registered via ipcMain). Testing would require mocking adbExec — hard. Let's check how other tests mock (e.g., adbServerStart.test.js) to see if there's a pattern with vi.mock of child_process.

Maybe simpler: export the pure merge helpers? Actually merging logic depends on stableId grouping which is async. Could export a pure `mergeDeviceRecords` for a unit test... Let's first run lint/typecheck/tests.

**Tool: bash**

**Input:**
```json
{
  "command": "npx tsc --project jsconfig.typecheck.json 2>&1 | tail -20; npm run lint 2>&1 | tail -30",
  "timeout": 300000
}
```

**Output:**
```

> anddrive_next@0.0.4 lint
> run-s lint:oxlint lint:eslint


> anddrive_next@0.0.4 lint:oxlint
> oxlint .


> anddrive_next@0.0.4 lint:eslint
> eslint . --no-cache


```

---

## Assistant (Build · MiMo-V2.6-Flash Free · 6.0s)

_Thinking:_

Lint & typecheck pass (tsc produced no output = success).

Now run tests.

**Tool: bash**

**Input:**
```json
{
  "command": "npm test 2>&1 | tail -30",
  "timeout": 300000
}
```

**Output:**
```

> anddrive_next@0.0.4 test
> vitest run --config vitest.config.js


 RUN  v5.0.2 /Users/xh/code/anddrive


 Test Files  33 passed (33)
      Tests  330 passed | 1 skipped (331)
   Start at  18:51:33
   Duration  1.26s (tests 38%, transform 37%, import 23%, worker 2%)

  Transform  transforming modules took 2.12s · 37% of tracked time, re-done on every run
             persist transforms across runs with fsModuleCache: true
             learn more: https://vitest.dev/guide/improving-performance#caching-between-reruns


```

**Tool: bash**

**Input:**
```json
{
  "command": "npx oxfmt --check src electron 2>&1 | tail -20",
  "timeout": 120000
}
```

**Output:**
```
src/composables/useAppSearch.js (0ms)
src/composables/useCodecCaps.js (0ms)
src/composables/useConnectionPreferences.js (0ms)
src/composables/useFavorites.js (0ms)
src/composables/useNotifications.js (0ms)
src/composables/useScrcpyPreferences.js (0ms)
src/composables/useScrcpySessions.js (0ms)
src/main.js (0ms)
src/mirror/App.vue (702ms)
src/mirror/audio.js (4ms)
src/mirror/connect.js (3ms)
src/mirror/direct-session.js (4ms)
src/mirror/displayFollow.js (3ms)
src/mirror/session.js (3ms)
src/utils/clipboard.js (0ms)
src/utils/codecCaps.js (0ms)
src/utils/errors.js (0ms)

Format issues found in above 51 files. Run without `--check` to fix.
Finished in 718ms on 64 files using 10 threads.

```

---

## Assistant (Build · MiMo-V2.6-Flash Free · 7.6s)

_Thinking:_

Format check flags51 files — likely pre-existing (whole repo unformatted?). Let's check if my touched files are among them, and whether format:check passes on git stash baseline. Simpler: run oxfmt --check only on the files I changed and see; but51 files suggests the repo generally isn't oxfmt-formatted (maybe they never run format). Let's check git status to ensure only my files changed, and run check on those specific files.

**Tool: bash**

**Input:**
```json
{
  "command": "git status --porcelain; npx oxfmt --check src/App.vue src/components/PageHeader.vue src/components/AddDeviceDialog.vue electron/adb.js 2>&1 | tail -5"
}
```

**Output:**
```
 M electron/adb.js
 M src/App.vue
 M src/components/AddDeviceDialog.vue
 M src/components/PageHeader.vue
 M src/components/home/AppList.vue
 M src/components/home/index.vue
src/App.vue (166ms)
src/components/PageHeader.vue (181ms)

Format issues found in above 3 files. Run without `--check` to fix.
Finished in 182ms on 4 files using 10 threads.

```

---

## Assistant (Build · MiMo-V2.6-Flash Free · 7.1s)

_Thinking:_

Interesting: `src/components/home/AppList.vue` and `src/components/home/index.vue` are modified — but I didn't touch them! Did something modify them? Maybe lint:fix? No, I didn't run it. Let's check the diff — maybe oxfmt ran? No, I only ran --check. Hmm, maybe these were modified before my session (pre-existing dirty working tree). Let's check `git diff` for those files.

Also App.vue / PageHeader.vue format issues — need to check whether they were already failing before my edit (likely yes, since the repo has 51 failing files). Let's verify baseline by checking format on HEAD versions.

**Tool: bash**

**Input:**
```json
{
  "command": "git stash list; git diff --stat; git stash push -q -m fmtcheck && npx oxfmt --check src/App.vue src/components/PageHeader.vue src/components/AddDeviceDialog.vue electron/adb.js src/components/home/index.vue 2>&1 | tail -6; git stash pop"
}
```

**Output:**
```
stash@{0}: WIP on feat/native-mirror-client: 90bd4be a
stash@{1}: On feat/native-mirror-client: 2
stash@{2}: On main: 无边框镜像 + 悬浮控制条（先移除）
 electron/adb.js                    |  97 ++++++++++++++++++-----
 src/App.vue                        |  11 ++-
 src/components/AddDeviceDialog.vue |   2 +-
 src/components/PageHeader.vue      |   9 ++-
 src/components/home/AppList.vue    | 107 ++++++++++++++------------
 src/components/home/index.vue      | 154 ++++++++++++++++++++++++++-----------
 6 files changed, 263 insertions(+), 117 deletions(-)
electron/adb.js (2ms)
src/App.vue (197ms)
src/components/PageHeader.vue (211ms)

Format issues found in above 3 files. Run without `--check` to fix.
Finished in 212ms on 5 files using 10 threads.
On branch feat/native-mirror-client
Your branch is up to date with 'origin/feat/native-mirror-client'.

Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)
  (use "git restore <file>..." to discard changes in working directory)
	modified:   electron/adb.js
	modified:   src/App.vue
	modified:   src/components/AddDeviceDialog.vue
	modified:   src/components/PageHeader.vue
	modified:   src/components/home/AppList.vue
	modified:   src/components/home/index.vue

no changes added to commit (use "git add" and/or "git commit -a")
Dropped refs/stash@{0} (fc43a3b353e7db762ada9597d02ee02882281983)

```

---

## Assistant (Build · MiMo-V2.6-Flash Free · 8.3s)

_Thinking:_

Hmm — the stash also stashed the home/* changes (which existed before my session? or not?). Wait: the stash included home/AppList.vue and home/index.vue modifications — those were in the working tree before I started? I didn't touch them. Baseline format check after stash: `src/App.vue`, `src/components/PageHeader.vue`, `electron/adb.js` still fail format check at HEAD → so these files fail format at baseline too (pre-existing). Good — my changes don't need to fix formatting (repo isn't oxfmt-clean).

Wait, but after stash the check still shows App.vue/PageHeader/adb.js failing → baseline failures. Confirmed pre-existing.

But home/AppList.vue and home/index.vue are modified in working tree — were they modified before my session? Let's check their diff to see if something I ran modified them (e.g., oxfmt? I ran `npx oxfmt --check` which shouldn't write). The stash test: after stashing, those two files were gone from working tree (baseline clean), then popped back. So they were modified before my session started (user's uncommitted work) OR... Actually careful: could `npm run lint` have auto-fixed? No, lint:eslint without --fix.

Let's verify their diffs quickly to make sure they're not something I caused.

**Tool: bash**

**Input:**
```json
{
  "command": "git diff --stat src/components/home/; git diff src/components/home/index.vue | head -40"
}
```

**Output:**
```
 src/components/home/AppList.vue | 107 +++++++++++++++-------------
 src/components/home/index.vue   | 154 ++++++++++++++++++++++++++++------------
 2 files changed, 169 insertions(+), 92 deletions(-)
diff --git a/src/components/home/index.vue b/src/components/home/index.vue
index e7d64f1..172d8fd 100644
--- a/src/components/home/index.vue
+++ b/src/components/home/index.vue
@@ -3,6 +3,7 @@ import { Icon } from '@iconify/vue'
 import AppList from './AppList.vue'
 import DeviceStats from './DeviceStats.vue'
 import StoragePanel from './StoragePanel.vue'
+import { getDeviceStatsApi, getStorageVolumesApi } from '@/api'
 
 const props = defineProps({
   device: {
@@ -18,59 +19,124 @@ const deviceTitle = computed(() => {
 // 外观照 BaseButton 的 icon-only + default 变体（size-7 / rounded-[7px] / 图标 14）。
 // 不复用组件是因为它 `defineEmits(['click'])`：Reka 的 Trigger 在 as-child 下把 onClick
 // 当普通属性传下来，被 emits 声明吃掉后就落不到真正的 <button> 上 —— 点击挂不上，弹层打不开。
-const TRIGGER_CLASS =
-  'relative inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-[7px] whitespace-nowrap select-none text-ink-3 transition-[background-color,color,box-shadow] duration-150 outline-none hover:bg-fill hover:text-ink-2 active:bg-fill-strong focus-visible:ring-2 focus-visible:ring-accent/40'
+const CHIP_CLASS =
+  'inline-flex h-6 cursor-pointer items-center gap-1 rounded-[7px] px-1.5 whitespace-nowrap select-none text-[11px] text-ink-2 transition-colors duration-150 outline-none hover:bg-fill hover:text-ink active:bg-fill-strong focus-visible:ring-2 focus-visible:ring-accent/40'
 const POPOVER_CLASS =
   'z-50 w-[346px] rounded-[12px] border border-line bg-surface/95 p-3.5 shadow-pop outline-none backdrop-blur-xl'
+
+// 摘要行只放「每次都想瞟一眼」的三件事：连没连上、系统版本、电还剩多少、还剩多少空间。
+// 完整的型号 / 网络 / 内存 / CPU 留在弹层里，点开才拉（各 30s / 15s 缓存），
+// 首页常驻的只有这一次汇总读数。
+const stats = ref(null)
+const storage = ref(null)
+const summaryReady = ref(false)
+
+async function loadSummary() {
+  const [statsResult, storageResult] = await Promise.allSettled([
+    getDeviceStatsApi(props.device.address),
+    getStorageVolumesApi(props.device.address),
+  ])
+  if (statsResult.status === 'fulfilled') stats.value = statsResult.value
+  if (storageResult.status === 'fulfilled') storage.value = storageResult.value
+  summaryReady.value = true
+}
+

```

---

## Assistant (Build · MiMo-V2.6-Flash Free · 6.4s)

_Thinking:_

Those are pre-existing user changes (unrelated to my task). Fine — leave them alone.

Now, should I add a test? The repo has good test coverage for pure helpers. I could extract and test merge logic. The merge helpers are internal (not exported). To test, export `mergeDeviceRecords` and `preferDeviceRecord`? Exporting for tests only is acceptable in this codebase? Let's see if other internal functions are exported for tests: e.g., `parseAdbDevices`, `serviceDeviceToken`, `pickStableId` are exported and tested. So exporting merge helpers is consistent.

Better: test the actual grouping including async stable-id resolution? That needs adb mocking. Check how adbServerStart.test.js mocks.

Let's look at an existing test that mocks child_process to judge feasibility.

**Tool: bash**

**Input:**
```json
{
  "command": "sed -n 1,60p tests/electron/adbServerStart.test.js; echo ====; sed -n 1,50p tests/electron/adbMdns.test.js; echo ====; cat vitest.config.js"
}
```

**Output:**
```
import { describe, expect, it, vi } from 'vitest'

// `ensureServer()` 的并发竞态：标记要等 `start-server` 返回才置位，这段时间里每个调用者
// 都会各自 fork 一个 adb —— 第二个死在 `Address already in use`，上层就报「发现设备失败」。
// 这里把 execFile 换成计数器，验同一次进程内并发只会起一个。

const calls = vi.hoisted(() => [])
let failNext = false

vi.mock('electron', () => ({
  app: { getPath: () => '', getVersion: () => '0.0.0-test' },
  ipcMain: { handle: () => {}, on: () => {} },
  dialog: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 } }) },
  BrowserWindow: class {},
}))

vi.mock('node:child_process', () => ({
  execFile: (bin, args, opts, cb) => {
    calls.push(args.join(' '))
    queueMicrotask(() => {
      if (failNext) cb(Object.assign(new Error('ADB server didn\'t ACK'), { stderr: 'nope' }), '', '')
      else cb(null, '', '')
    })
  },
}))

const startServerCalls = () => calls.filter((line) => line === 'start-server').length

/** 模块级标记（serverStarted / 在途 promise）每个用例都要从零开始。 */
const freshAdb = async () => {
  vi.resetModules()
  calls.length = 0
  failNext = false
  return import('../../electron/adb.js')
}

describe('ensureServer', () => {
  it('并发调用共用同一次 start-server，不抢 5037', async () => {
    const { ensureServer } = await freshAdb()
    await Promise.all([ensureServer(), ensureServer(), ensureServer(), ensureServer()])
    expect(startServerCalls()).toBe(1)
  })

  it('启动失败不焊死状态：下一次调用会真的重试', async () => {
    const { ensureServer } = await freshAdb()
    failNext = true
    await expect(ensureServer()).rejects.toThrow()
    expect(startServerCalls()).toBe(1)

    failNext = false
    await ensureServer()
    expect(startServerCalls()).toBe(2)
  })
})
zsh:1: === not found

```

---

## Assistant (Build · MiMo-V2.6-Flash Free · 8.4s)

_Thinking:_

Mocking pattern exists: mock `node:child_process` execFile. So I can write a test for `listConnectDevices`:

- mock execFile to respond based on args: `devices` → two lines (USB serial + wifi serial), `mdns services` → maybe empty or one entry, `shell getprop...` → return `af3d7abd`.
- Need `adbExec` behavior: let's look at adbExec/adbExecSafe implementation to know how output/exit handled and how execFile args look.

Let's read top of adb.js (lines 1-140).

**Tool: read**

**Input:**
```json
{
  "filePath": "/Users/xh/code/anddrive/electron/adb.js",
  "limit": 140
}
```

**Output:**
```
<path>/Users/xh/code/anddrive/electron/adb.js</path>
<type>file</type>
<content>
1: import { app, dialog, ipcMain } from "electron";
2: import { execFile } from "node:child_process";
3: import { createHash, randomBytes } from "node:crypto";
4: import { promises as fs, readFileSync } from "node:fs";
5: import path from "node:path";
6: import { fileURLToPath } from "node:url";
7: import { CHANNELS } from "./ipcContract.js";
8: import { browse } from "./mdns.js";
9: import { pickStableId } from "./deviceIdentity.js";
10: import { parseEncoderMimes, VIDEO_ENCODER_PROBE_CMD } from "../shared/scrcpyConfig.js";
11: import { iconPngBuffer, MAX_ICON_BYTES, PNG_DATA_URL_PREFIX } from "./iconImage.js";
12: import helperVersion from "../resources/helper-app.version.json" with { type: "json" };
13: 
14: // ---------------------------------------------------------------------------
15: // 资源路径
16: // ---------------------------------------------------------------------------
17: 
18: const __dirname = path.dirname(fileURLToPath(import.meta.url));
19: 
20: /** 打包后取 resources 目录，开发环境取项目 ./resources。 */
21: function resourcesBase() {
22:   return app.isPackaged ? process.resourcesPath : path.join(__dirname, "..", "resources");
23: }
24: 
25: export const adbPath = () => path.join(resourcesBase(), "adb", "mac", "adb");
26: const helperApkPath = () => path.join(resourcesBase(), "helper-app.apk");
27: export const scrcpyServerPath = () => path.join(resourcesBase(), "scrcpy", "scrcpy-server");
28: 
29: // ---------------------------------------------------------------------------
30: // ADB 执行
31: // ---------------------------------------------------------------------------
32: 
33: let serverStarted = false;
34: /** 在途的 `start-server`；并发调用共用它，避免同时 fork 多个 adb 抢 5037。 */
35: let pendingServerStart = null;
36: 
37: /**
38:  * adb 子进程超时。transport 半死（手机休眠、换地址、Wi-Fi 抖动）时 `adb` 会**一直挂着**：
39:  * 不退出、不报错，于是调用它的 IPC 永远不返回 —— 界面停在 spinner，重连和提示都无从触发。
40:  * 这里宁可报「设备无响应」也不能永久卡住。
41:  */
42: const ADB_TIMEOUT_MS = 15_000;
43: /** `adb connect` / `adb pair`：对端不响应时要等 TCP 超时，给得更宽。 */
44: const ADB_CONNECT_TIMEOUT_MS = 45_000;
45: /** 安装 / 卸载 / 拉文件是分钟级的正常慢操作，不能用默认超时去掐。 */
46: const ADB_TRANSFER_TIMEOUT_MS = 5 * 60_000;
47: 
48: /** @typedef {{ timeoutMs?: number }} AdbCallOptions */
49: 
50: /**
51:  * 把写在最前面的选项对象从 adb 参数里摘出来：
52:  * `adbExec({ timeoutMs: ADB_TRANSFER_TIMEOUT_MS }, "-s", serial, "install", …)`。
53:  * @param {(string | AdbCallOptions)[]} args
54:  * @returns {[AdbCallOptions, string[]]}
55:  */
56: function splitCallOptions(args) {
57:   const first = args[0];
58:   if (first && typeof first === "object") return [first, args.slice(1)];
59:   return [{}, args];
60: }
61: 
62: /**
63:  * execFile 被超时杀掉的特征：Node 置 `killed`/`signal`，部分版本给 `ETIMEDOUT`。
64:  * @param {unknown} error
65:  */
66: function isAdbTimeoutError(error) {
67:   if (!error || typeof error !== "object") return false;
68:   const { killed, code } = /** @type {{ killed?: boolean, code?: unknown }} */ (error);
69:   return killed === true || code === "ETIMEDOUT";
70: }
71: 
72: /** 超时对用户来说就是「手机没反应」，文案统一从这里出。 */
73: const ADB_TIMEOUT_MESSAGE = "设备无响应（命令超时），可能已息屏休眠或换了地址";
74: 
75: /** 超时错误保留 ETIMEDOUT 标记，好让上层（如 getDeviceState）认出这是超时。 */
76: function adbTimeoutError() {
77:   return Object.assign(new Error(ADB_TIMEOUT_MESSAGE), { code: "ETIMEDOUT" });
78: }
79: 
80: /**
81:  * 起 adb 守护进程。**并发调用必须共用同一次启动**：标记要等 `start-server` 返回才置位，
82:  * 这段时间里每个调用者都会各自 fork 一个 adb，第二个会死在
83:  * `could not install *smartsocket* listener: Address already in use` → `ADB server didn't ACK`
84:  * → 上层报「发现设备失败」（真机踩过）。失败时清空在途 promise，让后续调用能重试。
85:  */
86: export function ensureServer() {
87:   if (serverStarted) return Promise.resolve();
88:   pendingServerStart ??= new Promise((resolve, reject) => {
89:     execFile(adbPath(), ["start-server"], { timeout: ADB_TIMEOUT_MS }, (err) => {
90:       pendingServerStart = null;
91:       if (err) {
92:         reject(err);
93:         return;
94:       }
95:       serverStarted = true;
96:       resolve();
97:     });
98:   });
99:   return pendingServerStart;
100: }
101: 
102: /** @param {...(string | AdbCallOptions)} args */
103: function adbExec(...args) {
104:   const [{ timeoutMs = ADB_TIMEOUT_MS }, command] = splitCallOptions(args);
105:   return new Promise((resolve, reject) => {
106:     execFile(adbPath(), command, { timeout: timeoutMs }, (err, stdout, stderr) => {
107:       if (err) reject(isAdbTimeoutError(err) ? adbTimeoutError() : new Error(stderr || err.message));
108:       else resolve(stdout.trim());
109:     });
110:   });
111: }
112: 
113: /**
114:  * Like adbExec but never rejects: resolves with `{ code, stdout, stderr }` so
115:  * callers can inspect exit codes and device output. adb exits non-zero while
116:  * still printing a meaningful message (e.g. uninstalling a missing package).
117:  * 超时也算「有结果」：`timedOut` 为真、`stderr` 是给用户看的中文说明。
118:  * @param {...(string | AdbCallOptions)} args
119:  */
120: export function adbExecSafe(...args) {
121:   const [{ timeoutMs = ADB_TIMEOUT_MS }, command] = splitCallOptions(args);
122:   return new Promise((resolve) => {
123:     execFile(adbPath(), command, { timeout: timeoutMs }, (err, stdout, stderr) => {
124:       const out = stdout?.trim() || "";
125:       if (!err) {
126:         resolve({ code: 0, stdout: out, stderr: stderr?.trim() || "" });
127:         return;
128:       }
129:       if (isAdbTimeoutError(err)) {
130:         resolve({ code: 1, stdout: out, stderr: ADB_TIMEOUT_MESSAGE, timedOut: true });
131:         return;
132:       }
133:       const code = typeof err.code === "number" ? err.code : 1;
134:       resolve({ code, stdout: out, stderr: stderr?.trim() || err.message });
135:     });
136:   });
137: }
138: 
139: /**
140:  * serial 是否是 USB（有线）传输：不是 `host:port`、不是无线调试的 mDNS 实例名、

(Showing lines 1-140 of 2029. Use offset=141 to continue.)
</content>
```

---

## Assistant (Build · MiMo-V2.6-Flash Free · 11.4s)

_Thinking:_

Note: `listConnectDevices` is not exported (registered via ipcMain.handle). For a test, I'd need to either export it or call the ipc handler. Mocking `electron` ipcMain.handle to capture the handler is a neat approach: in the test, mock ipcMain with `handle: (channel, fn) => handlers.set(channel, fn)` then invoke handler.

Let's write tests/electron/adbDeviceList.test.js:

```js
import { describe, expect, it, vi } from 'vitest'

const handlers = new Map()
vi.mock('electron', () => ({
  app: { getPath: () => '', getVersion: () => '0.0.0-test', isPackaged: false },
  ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), on: () => {} },
  dialog: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 } }) },
  BrowserWindow: class {},
}))
```
But `handlers` must be hoisted (vi.hoisted).

child_process mock: respond based on args:
- `start-server` → ok
- `devices` → output with two devices
- `mdns services` → one service line (mDNS) maybe
- `-s <serial> shell ...` → return 'af3d7abd' for both serials (ro.serialno)
- deviceDisplayName also runs shell commands: let's check deviceDisplayName (around line 380 earlier): it runs `getprop` etc. via... let's look.

deviceDisplayName implementation — uses `adbExecSafe`? Let's read lines 340-390.

Also `listConnectDevices` calls `ensureConnectBrowser()` — what's that? It may spawn browse/mdns. Let's check.

Then aliases persist: ALIAS_FILE uses app.getPath("userData") = '' in test → path.join('', 'device-aliases.json') = 'device-aliases.json' relative → loadAliases try/catch reads maybe real file in cwd. persistAliases would mkdir/write in cwd — that's a side effect during tests. Better mock app.getPath to a temp dir, or mock node:fs. Hmm. Existing tests: favorites.test.js mocks? Let's check how favorites.test handles userData/alias file.

Let's inspect ensureConnectBrowser, deviceDisplayName, and favorites.test.js.

**Tool: bash**

**Input:**
```json
{
  "command": "rg -n \"function ensureConnectBrowser|function deviceDisplayName|connectNames\" electron/adb.js | head; sed -n 340,400p electron/adb.js; echo =====; sed -n 1,60p tests/electron/favorites.test.js"
}
```

**Output:**
```
348:const connectNames = new Map();
350:function ensureConnectBrowser() {
355:      connectNames.set(service.name.split("._")[0], given.trim());
367:async function deviceDisplayName(serial) {
427:          ? (svc && connectNames.get(svc.name)) || (await deviceDisplayName(serial)) || null
520:      label = connectNames.get(matched.name) || label;
  return {
    token: serviceDeviceToken(name),
    host: address ? address.split(":")[0].trim() : "",
  };
}

let connectBrowser = null;
/** @type {Map<string, string>} 服务实例名（adb-XXXX）→ TXT 里的设备名称 */
const connectNames = new Map();

function ensureConnectBrowser() {
  if (connectBrowser) return;
  connectBrowser = browse("adb-tls-connect", (service) => {
    const given = service.txt?.given_name;
    if (typeof given === "string" && given.trim()) {
      connectNames.set(service.name.split("._")[0], given.trim());
    }
  });
}

/** @type {Map<string, string | null>} serial → 手机展示的名称 */
const deviceNames = new Map();

/**
 * 读取手机上展示的设备名称（蓝牙名 / 设备名，其次市场名）。按 serial 缓存。
 * @param {string} serial
 */
async function deviceDisplayName(serial) {
  if (deviceNames.has(serial)) return deviceNames.get(serial);
  const shell = async (...args) => {
    try {
      return (await adbExec("-s", serial, "shell", ...args)).trim() || null;
    } catch {
      return null;
    }
  };
  const clean = (value) => (value && value !== "null" ? value : null);
  const [bluetoothName, deviceName, marketName] = await Promise.all([
    shell("settings", "get", "secure", "bluetooth_name"),
    shell("settings", "get", "global", "device_name"),
    shell("getprop", "ro.product.marketname"),
  ]);
  const name = clean(bluetoothName) || clean(deviceName) || clean(marketName) || null;
  deviceNames.set(serial, name);
  return name;
}

/**
 * 以 `adb devices` 为准，返回所有已连接/已配对的设备（含 USB、老式 tcpip、
 * 无线调试），未配对过、只广播的 mDNS 设备不展示。
 *
 * 名称优先取 mDNS TXT 的 given_name，其次读设备上的展示名称。
 * `address` 一律取 adb 的 serial（可直接用于 `adb -s`），展示用 displayAddress。
 * `transport` 区分有线 / 无线：USB 直插的设备没有 mDNS 条目，展示与断开逻辑都按它分支。
 * 未授权（unauthorized）也返回，`connected: false` 供界面提示「在手机上点允许」。
 *
 * **同一台手机插着线又开着无线调试时只出一行**：adb 里那是两条 transport
 * （`af3d7abd` 和 `192.168.1.5:37000` / `adb-af3d7abd-XXXX._adb-tls-connect._tcp`），
 * 这里按稳定标识归成一组，`stableId` 就是组键，`address` 取组里可用的那条传输。
 * @returns {Promise<{ stableId: string, name: string, type: string, address: string, displayAddress: string, label: string | null, connected: boolean, state: string, transport: "usb" | "wifi" }[]>}
 */
zsh:1: ==== not found

```

---

## Assistant (Build · MiMo-V2.6-Flash Free · 9.6s)

_Thinking:_

`ensureConnectBrowser` calls `browse` from mdns.js — that likely spawns dns-sd or uses bonjour; in test could be problematic. Let's check mdns.js browse.

Also need `fs` for aliases: app.getPath("userData").

Let's check mdns.js browse implementation quickly.

**Tool: bash**

**Input:**
```json
{
  "command": "rg -n \"export function browse\" -A 40 electron/mdns.js"
}
```

**Output:**
```
368:export function browse(type, onService) {
369-  return new MdnsBrowser(type, onService).start()
370-}

```

**Tool: bash**

**Input:**
```json
{
  "command": "sed -n 1,70p tests/electron/favorites.test.js"
}
```

**Output:**
```
import { describe, expect, it, vi } from 'vitest'

const fsState = vi.hoisted(() => ({
  /** 收藏文件内容；null 表示文件不存在。 */
  raw: null,
  writeFails: false,
  /** writeFile 写好、还没 rename 的临时内容。 */
  pending: undefined,
  /** 最后一次成功写入的内容。 */
  written: null,
}))

vi.mock('node:fs', () => ({
  promises: {
    readFile: () =>
      fsState.raw === null
        ? Promise.reject(new Error('ENOENT'))
        : Promise.resolve(Buffer.from(fsState.raw)),
    mkdir: () => Promise.resolve(),
    writeFile: (_file, data) => {
      if (fsState.writeFails) return Promise.reject(new Error('ENOSPC: no space left on device'))
      fsState.written = JSON.parse(data)
      fsState.pending = data
      return Promise.resolve()
    },
    // 真实实现是「写临时文件 → rename 覆盖」，这里让 rename 才把内容落到 raw，
    // 顺带保证下一次读取读到的是上一笔真正落盘的数据。
    rename: () => {
      if (fsState.pending !== undefined) {
        fsState.raw = fsState.pending
        fsState.pending = undefined
      }
      return Promise.resolve()
    },
  },
  copyFile: () => Promise.resolve(),
}))

vi.mock('electron', () => ({
  app: { getPath: () => '' },
  ipcMain: { handle: vi.fn() },
}))

// 稳定标识解析要真 adb；测试里让它原样返回，走的还是同一条代码路径。
vi.mock('../../electron/adb.js', () => ({
  resolveDeviceStableId: async (serial) => serial,
}))

const { sanitizePackage, sanitizeFavoriteList, sanitizeStore, toggleFavorite } = await import(
  '../../electron/favorites.js'
)

describe('sanitizePackage', () => {
  it('trims valid package names', () => {
    expect(sanitizePackage('  com.example.app  ')).toBe('com.example.app')
  })

  it('rejects empty, non-string and overlong values', () => {
    expect(sanitizePackage('')).toBeNull()
    expect(sanitizePackage('   ')).toBeNull()
    expect(sanitizePackage(42)).toBeNull()
    expect(sanitizePackage(null)).toBeNull()
    expect(sanitizePackage('a'.repeat(513))).toBeNull()
  })
})

describe('sanitizeFavoriteList', () => {
  it('drops invalid entries and de-duplicates', () => {
    expect(sanitizeFavoriteList(['com.a', 'com.a', '', 7, 'com.b'])).toEqual(['com.a', 'com.b'])
  })

```

---

## Assistant (Build · MiMo-V2.6-Flash Free · 56.1s)

_Thinking:_

Good, mocking patterns exist. Now writing a test for listConnectDevices requires mocking:
- electron (app.getPath, ipcMain.handle capture, BrowserWindow for mdns browse?)
- node:child_process execFile
- node:fs (for alias file) — but adb.js imports `promises as fs` and `readFileSync` from node:fs. Mock node:fs fully like favorites does? adb.js also uses fs elsewhere but only when called.

mdns.js `browse` — will spawn something. Let's inspect MdnsBrowser.start to see whether it spawns dns-sd (macOS). We could mock '../../electron/mdns.js' with `browse: () => () => {}`.

Careful: adb.js imports browse from ./mdns.js; mocking that module is fine as long as we provide `browse`. Does adb.js import anything else from mdns.js? Let's check: `import { browse } from "./mdns.js";` only? grep.

Also adb.js imports `../shared/scrcpyConfig.js`, `./iconImage.js`, helper version json — those should import fine.

Plan for test file `tests/electron/adbDeviceList.test.js`:

```js
import { describe, expect, it, vi } from 'vitest'

const ipcHandlers = vi.hoisted(() => new Map())
const fsState = vi.hoisted(() => ({ raw: null }))  // alias file
const adbOut = vi.hoisted(() => ({ devices: '', mdns: '', shell: {} }))

vi.mock('electron', () => ({
  app: { getPath: () => '', getVersion: () => '0.0.0-test', isPackaged: false },
  ipcMain: { handle: (channel, fn) => ipcHandlers.set(channel, fn), on: () => {} },
  dialog: {},
  BrowserWindow: class {},
}))
vi.mock('node:child_process', () => ({ execFile: (bin, args, opts, cb) => { ... } }))
vi.mock('node:fs', () => ({ promises: {...}, readFileSync: () => { throw ... } }))
vi.mock('../../electron/mdns.js', () => ({ browse: () => () => {} }))
```

Wait — adb.js also imports `readFileSync` and `promises as fs`. And iconImage.js? adb.js imports from ./iconImage.js which may import fs too; mocking node:fs globally affects it — fine.

execFile mock: dispatch on args:
- `['start-server']` → cb(null,'','')
- `['devices']` → cb(null, adbOut.devices, '')
- `['mdns','services']` → cb(null, adbOut.mdns, '')
- args includes 'shell':
  - if joined contains 'getprop ro.serialno' → cb(null, shell stableId output for that serial, '')
  - deviceDisplayName: `-s X shell settings get secure bluetooth_name` → cb(null, '','') or a name.

adbExecSafe resolves err → code; for shell resolve we want stdout `af3d7abd\n\n\n`? pickStableId takes lines.slice(0,3) of stdout+stderr split lines: line1=ro.serialno, line2=ro.boot.serialno, line3=android_id. So output "af3d7abd\n\nnull\n0123456789ABCDEF" works: line1 used.

Wait: in mock, for `settings get secure android_id` the real adb merges all into one shell command string: `"getprop ro.serialno; getprop ro.boot.serialno; settings get secure android_id"` as a single arg after "shell". So args = ['-s', serial, 'shell', 'getprop ro.serialno; ...'].

deviceDisplayName: args = ['-s', serial, 'shell', 'settings', 'get', 'secure', 'bluetooth_name'].

Test cases:
1. USB serial `af3d7abd` + wifi `192.168.1.5:37000`, both state device, shell returns ro.serialno `af3d7abd` for both → list has 1 entry, transport 'usb' (preferred), address 'af3d7abd', stableId 'af3d7abd'.
2. mDNS-form serial `adb-af3d7abd-Zvci5V._adb-tls-connect._tcp` + USB → 1 entry (and ideally without needing shell for wifi? we do shell anyway).
3. Two distinct devices → 2 entries.
4. Maybe: wifi connected + USB unauthorized → merged into 1 (connected one wins, transport wifi).

Also test that a lone wifi device stays 1 entry.

Careful about ordering: `Promise.all` over entries.

One concern: `ensureConnectBrowser()` calls mocked browse ✓.

Another: `ensureServer` → execFile start-server ✓.

Alias persistence: app.getPath('userData') = '' → path.join('', 'device-aliases.json') → 'device-aliases.json'. loadAliases: readFileSync → we mock to throw ENOENT ✓. rememberAlias → persistAliases → fs.mkdir(path.dirname('device-aliases.json')) = '.' → mocked mkdir resolves; writeFile mocked; rename mocked. If we mock node:fs promises as no-ops, fine. But careful: adb.js uses `fs.mkdir`, `fs.writeFile`, `fs.rename`, `fs.readFile`... Also `readFileSync`. Provide all as safe stubs.

Hmm, but does mocking node:fs break other imports (iconImage.js might import fs)? Provide functions used. Let's check what fs APIs adb.js and iconImage use:
- adb.js: `promises as fs, readFileSync`; uses fs.mkdir, fs.writeFile, fs.rename, fs.unlink, fs.readFile?, fs.readdir, fs.stat, fs.rm?
Let's just provide a broad mock: promises: new Proxy? Simpler: create functions for common ops: readFile, writeFile, mkdir, rename, unlink, readdir, stat, rm, copyFile, access, open... Return promises. Use a Proxy returning `() => Promise.resolve()`? But readFile must reject for ENOENT in loadAliases. Let's do explicit: readFile → reject ENOENT; others → resolve.

Actually loadAliases uses readFileSync (mock throws) — persist uses promises. So promises.readFile may not be needed... other code paths not executed in this test.

I'll mock:
```js
vi.mock('node:fs', () => ({
  promises: {
    mkdir: () => Promise.resolve(),
    writeFile: () => Promise.resolve(),
    rename: () => Promise.resolve(),
    unlink: () => Promise.resolve(),
    readFile: () => Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
    readdir: () => Promise.resolve([]),
    stat: () => Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
    rm: () => Promise.resolve(),
  },
  readFileSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
  default: {},
}))
```
Hmm, if adb.js or iconImage does `import fs from 'node:fs'` default import, we need default. iconImage imports? Let's check quickly. Also `import { promises as fs, readFileSync }`.

Also careful: vitest environment may need fs for its own module loading, but vi.mock only affects the mocked module within this test file's module graph — Vitest itself uses its own context. Should be fine (favorites.test does it).

Also need `deviceNames` cache etc. — module-level state; use `vi.resetModules()` + fresh import per case like adbServerStart test. With resetModules, ipcHandlers Map from hoisted survives (same module scope? vi.hoisted runs in the test file scope; the Map object reference persists across resets ✓). But handlers map accumulates entries — set overwrites by channel name ✓.

Also each fresh import re-runs module → new `aliasesLoaded=false` ✓ good isolation.

Let's also confirm `CHANNELS.adbListConnectDevices` = 'adb:listConnectDevices'.

Let's write the test.

One more: does `browse` get called with (type, cb) → returns disposer; our mock returns () => {} ✓.

Also `screen`, `BrowserWindow` may be referenced at module top-level in adb.js? It imports dialog, app, ipcMain... `dialog` used in functions. Provide stubs anyway.

Let's check what adb.js top-level does at import: it defines constants; registers ipcMain.handle(...) at module level (line ~1900) ✓ our capture works.

Now also `helperVersion` json import with `with { type: "json" }` — vitest handles ✓ (other tests import adb.js fine).

Write the test file.

Shell mock details:
```js
execFile: (_bin, args, _opts, cb) => {
  const line = args.join(' ')
  queueMicrotask(() => {
    if (line === 'start-server') return cb(null, '', '')
    if (line === 'devices') return cb(null, adbOut.devices, '')
    if (line === 'mdns services') return cb(null, adbOut.mdns, '')
    if (line.includes('getprop ro.serialno')) {
      const serial = args[1]
      return cb(null, adbOut.stableIds[serial] ?? '', '')
    }
    // deviceDisplayName 的三条 shell 读取：回空，让 label 为 null
    return cb(null, '', '')
  })
}
```
Careful: adbExec resolves stdout.trim(); err null.

For deviceDisplayName, stdout '' → clean('') → null ✓ label null.

Test1: devices output:
```
List of devices attached
af3d7abd\tdevice
192.168.1.5:37000\tdevice
```
mdns: maybe empty '' (so svc undefined) — then wifi record name = serial, displayAddress = serial. Fine.

stableIds: { 'af3d7abd': 'af3d7abd\n\n\n', '192.168.1.5:37000': 'af3d7abd\n\n\n' } — wait pickStableId(lines.slice(0,3), serial): stdout.trim() then split lines: 'af3d7abd','','', → actually 'af3d7abd\n\n\n'.trim() = 'af3d7abd' → lines = ['af3d7abd'] → slice(0,3) = ['af3d7abd'] → returns 'af3d7abd' ✓.

Expect result: length 1; stableId 'af3d7abd'; transport 'usb'; address 'af3d7abd'; connected true.

Test 2 (mDNS-form): devices: `af3d7abd device` + `adb-af3d7abd-Zvci5V._adb-tls-connect._tcp device`; stableIds both → 'af3d7abd' → 1 row. Also add a case where shell fails for the mDNS serial (cb with error) → resolveDeviceStableId catches → returns serial... then key differs → 2 rows. Hmm that's the fallback weakness; but token fallback isn't used for state device... Actually in deviceListStableId, for state 'device' we call resolve which on error returns serial → no merge. Should we fall back to token if resolve fails? Yes! Better:

```js
if (state !== "device") return serviceDeviceToken(serial) || serial;
const stable = await resolveDeviceStableId(serial);
return stable && stable !== serial ? stable : serviceDeviceToken(serial) || stable || serial;
```
Hmm careful: for USB serial where ro.serialno === serial, resolve returns serial → token = '' → returns serial ✓.
For mDNS serial where shell fails → stable === serial → token 'af3d7abd' → returns 'af3d7abd' → merges with USB key (USB resolves to 'af3d7abd') ✓. 
For mDNS serial where shell fails and no USB → key = token 'af3d7abd' — still its own row ✓.

But what if shell fails for mDNS serial AND token is random (not matching USB serial)? Then key = random token — no worse.

Edge risk: mDNS token path applied when stable === serial — but what if resolve legitimately returns a value equal to... no.

So write:
```js
async function deviceListStableId(serial, state) {
  const known = stableIdOf(serial);
  if (known !== serial) return known;
  if (state !== "device") return serviceDeviceToken(serial) || serial;
  const stable = await resolveDeviceStableId(serial);
  return (stable && stable !== serial ? stable : null) || serviceDeviceToken(serial) || serial;
}
```
Slightly convoluted. Clearer:
```js
  const stable = await resolveDeviceStableId(serial);
  if (stable && stable !== serial) return stable;
  // 问不到设备（掉线 / 超时）时，mDNS 实例名里嵌的 USB 序列号还能对上
  return serviceDeviceToken(serial) || stable || serial;
```
`serviceDeviceToken(serial) || stable || serial` — stable could be '' only if serial invalid. fine.

Hmm wait, one problem: for a *wifi-only* device with mDNS-form serial and USB serial... n/a.

Another subtlety: if stable === serial for USB and token is '' → returns serial ✓.

OK implement, then write tests including the shell-failure fallback case.

Also consider: should we prefer token over stable when both differ? No — shell truth wins.

Let's apply the edit.

**Tool: edit**

**Input:**
```json
{
  "filePath": "/Users/xh/code/anddrive/electron/adb.js",
  "newString": "async function deviceListStableId(serial, state) {\n  const known = stableIdOf(serial);\n  if (known !== serial) return known;\n  if (state !== \"device\") return serviceDeviceToken(serial) || serial;\n  const stable = await resolveDeviceStableId(serial);\n  if (stable && stable !== serial) return stable;\n  // 问不到设备（掉线 / 超时）时的兜底：mDNS 实例名 `adb-af3d7abd-XXXX…` 里的\n  // `af3d7abd` 正是这台机器的 USB serial，照样能和有线那条并成一行。\n  return serviceDeviceToken(serial) || stable || serial;\n}",
  "oldString": "async function deviceListStableId(serial, state) {\n  const known = stableIdOf(serial);\n  if (known !== serial) return known;\n  if (state !== \"device\") return serviceDeviceToken(serial) || serial;\n  return (await resolveDeviceStableId(serial)) || serial;\n}"
}
```

**Output:**
```
Edit applied successfully.
```

---

## Assistant (Build · MiMo-V2.6-Flash Free · 22.9s)

_Thinking:_

Wait: careful — if resolveDeviceStableId returns the same as serial for a `host:port` device (shell failed), serviceDeviceToken('192.168.1.5:37000') → doesn't start with "adb-" → "" → returns stable (== serial) ✓.

Now write the test file.

**Tool: write**

**Input:**
```json
{
  "filePath": "/Users/xh/code/anddrive/tests/electron/adbDeviceList.test.js",
  "content": "import { describe, expect, it, vi } from 'vitest'\n\n// 同一台手机插着线又开着无线调试时，adb 里是两条 transport\n// （USB serial + `host:port` / `adb-XXXX._adb-tls-connect._tcp`），\n// 设备列表必须按稳定标识并成一行，否则界面上就是「一台机器显示两个」。\n\nconst ipcHandlers = vi.hoisted(() => new Map())\nconst adbOut = vi.hoisted(() => ({\n  devices: '',\n  mdns: '',\n  /** serial → `getprop ro.serialno; …` 的输出；undefined 表示这条命令失败。 */\n  stableIds: {},\n  /** 每次 execFile 的参数，断言用。 */\n  calls: [],\n}))\n\nvi.mock('electron', () => ({\n  app: { getPath: () => '', getVersion: () => '0.0.0-test', isPackaged: false },\n  ipcMain: { handle: (channel, fn) => ipcHandlers.set(channel, fn), on: () => {} },\n  dialog: {},\n  BrowserWindow: class {},\n}))\n\nvi.mock('node:child_process', () => ({\n  execFile: (_bin, args, _opts, cb) => {\n    const line = args.join(' ')\n    adbOut.calls.push(line)\n    queueMicrotask(() => {\n      if (line === 'start-server') return cb(null, '', '')\n      if (line === 'devices') return cb(null, adbOut.devices, '')\n      if (line === 'mdns services') return cb(null, adbOut.mdns, '')\n      if (line.includes('getprop ro.serialno')) {\n        const serial = args[1]\n        if (adbOut.stableIds[serial] === undefined) return cb(new Error('device offline'), '', '')\n        return cb(null, adbOut.stableIds[serial], '')\n      }\n      // deviceDisplayName 的那三条读取：回空，label 保持 null\n      return cb(null, '', '')\n    })\n  },\n}))\n\nvi.mock('node:fs', () => ({\n  promises: {\n    mkdir: () => Promise.resolve(),\n    writeFile: () => Promise.resolve(),\n    rename: () => Promise.resolve(),\n    unlink: () => Promise.resolve(),\n    readFile: () => Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),\n    readdir: () => Promise.resolve([]),\n    stat: () => Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),\n    rm: () => Promise.resolve(),\n  },\n  readFileSync: () => {\n    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })\n  },\n}))\n\n// ensureConnectBrowser 起的是真 mDNS 浏览器，这里给个空实现\nvi.mock('../../electron/mdns.js', () => ({ browse: () => () => {} }))\n\n/** 每个用例从零开始（别名表 / 设备名缓存 / ipc 注册都在模块级）。 */\nasync function listDevices({ devices, mdns = '', stableIds = {} }) {\n  vi.resetModules()\n  adbOut.devices = devices\n  adbOut.mdns = mdns\n  adbOut.stableIds = stableIds\n  adbOut.calls.length = 0\n  await import('../../electron/adb.js')\n  const handler = ipcHandlers.get('adb:listConnectDevices')\n  expect(handler).toBeTypeOf('function')\n  return handler()\n}\n\nconst USB = 'af3d7abd'\nconst WIFI = '192.168.1.5:37000'\nconst MDNS = 'adb-af3d7abd-Zvci5V._adb-tls-connect._tcp'\n\ndescribe('listConnectDevices 的同设备归并', () => {\n  it('USB + 无线同一台 serial 时只出一行，代表行取有线', async () => {\n    const list = await listDevices({\n      devices: `List of devices attached\\n${USB}\\tdevice\\n${WIFI}\\tdevice\\n`,\n      stableIds: { [USB]: 'af3d7abd', [WIFI]: 'af3d7abd' },\n    })\n    expect(list).toHaveLength(1)\n    expect(list[0]).toMatchObject({\n      stableId: 'af3d7abd',\n      address: USB,\n      transport: 'usb',\n      connected: true,\n      state: 'device',\n    })\n  })\n\n  it('无线调试的 mDNS 实例名与 USB serial 归成一行', async () => {\n    const list = await listDevices({\n      devices: `List of devices attached\\n${USB}\\tdevice\\n${MDNS}\\tdevice\\n`,\n      stableIds: { [USB]: 'af3d7abd', [MDNS]: 'af3d7abd' },\n    })\n    expect(list).toHaveLength(1)\n    expect(list[0]).toMatchObject({ stableId: 'af3d7abd', address: USB, transport: 'usb' })\n  })\n\n  it('问不到设备时靠 mDNS 实例名里嵌的序列号兜底', async () => {\n    const list = await listDevices({\n      devices: `List of devices attached\\n${USB}\\tdevice\\n${MDNS}\\tdevice\\n`,\n      stableIds: { [USB]: 'af3d7abd' },\n    })\n    expect(list).toHaveLength(1)\n    expect(list[0]).toMatchObject({ stableId: 'af3d7abd', address: USB })\n  })\n\n  it('USB 还没授权、无线已在线时也只出一行，代表行取在线的无线', async () => {\n    const list = await listDevices({\n      devices: `List of devices attached\\n${USB}\\tauthorizing\\n${WIFI}\\tdevice\\n`,\n      stableIds: { [WIFI]: 'af3d7abd' },\n    })\n    expect(list).toHaveLength(1)\n    expect(list[0]).toMatchObject({\n      address: WIFI,\n      transport: 'wifi',\n      connected: true,\n      state: 'device',\n    })\n  })\n\n  it('两台不同的手机不会被并到一起', async () => {\n    const other = '192.168.1.6:5555'\n    const list = await listDevices({\n      devices: `List of devices attached\\n${USB}\\tdevice\\n${other}\\tdevice\\n`,\n      stableIds: { [USB]: 'af3d7abd', [other]: 'c0ffee00' },\n    })\n    expect(list).toHaveLength(2)\n    expect(list.map((d) => d.stableId).sort()).toEqual(['af3d7abd', 'c0ffee00'])\n  })\n\n  it('只连无线时仍是单独一行', async () => {\n    const list = await listDevices({\n      devices: `List of devices attached\\n${WIFI}\\tdevice\\n`,\n      stableIds: { [WIFI]: 'af3d7abd' },\n    })\n    expect(list).toHaveLength(1)\n    expect(list[0]).toMatchObject({ address: WIFI, transport: 'wifi', stableId: 'af3d7abd' })\n  })\n})\n"
}
```

**Output:**
```
Wrote file successfully.
```

---

## Assistant (Build · MiMo-V2.6-Flash Free · 15.1s)

_Thinking:_

Careful: in the "问不到设备" case, USB serial resolves to 'af3d7abd' but for MDNS serial resolve fails → returns serial (since resolveDeviceStableId catch returns serial) → stable === serial → token 'af3d7abd' → key 'af3d7abd' ✓ merges.

But wait: the mock returns cb(new Error(...)) for unknown serial — adbExecSafe: err with no numeric code and not timeout → resolves { code: 1, stdout:'', stderr: err.message }. So no throw; stdout empty → pickStableId([], serial) → returns serial! So stable === serial, not an exception. Same result ✓ (my code path: stable === serial → token fallback ✓).

Also for the USB serial in that test: stableIds[USB] = 'af3d7abd' → shell returns 'af3d7abd' → stable 'af3d7abd' ✓ key.

For the authorizing case: USB state authorizing → deviceListStableId: known (stableIdOf) = serial (no alias) → state !== device → token(USB)='' → key = serial 'af3d7abd' ✓; WIFI resolves → 'af3d7abd' ✓ merge. Representative: wifi connected vs usb not → wifi ✓ transport wifi ✓.

For case "两台不同": USB resolves 'af3d7abd' key; other resolves 'c0ffee00' ✓.

Also `deviceDisplayName` is called for connected entries:3 shell calls each, mock returns '' → label null ✓.

Note the label chain: `(svc && connectNames.get(svc.name)) || (await deviceDisplayName(serial)) || null` — svc undefined → skip connectNames ✓.

mdns output '' → parseMdnsServices('') → [] ✓.

Potential issue: `ensureServer` — our execFile mock handles 'start-server' ✓.

Potential issue: adb.js module-level code may read files at import? e.g., `helperVersion` import json ✓; `app.getPath` only in ALIAS_FILE() called lazily ✓.

Another: adb.js imports `../shared/scrcpyConfig.js`, `./iconImage.js` — iconImage may import node:fs (mocked) and maybe others like `sharp`? Let's just run the test.

Also `ipcHandlers` — channel key: is it `'adb:listConnectDevices'`? CHANNELS.adbListConnectDevices = 'adb:listConnectDevices' ✓.

Run.

**Tool: bash**

**Input:**
```json
{
  "command": "npx vitest run --config vitest.config.js tests/electron/adbDeviceList.test.js 2>&1 | tail -40",
  "timeout": 180000
}
```

**Output:**
```

 RUN  v5.0.2 /Users/xh/code/anddrive

 ❯ tests/electron/adbDeviceList.test.js (6 tests | 1 failed) 39ms
   ❯ listConnectDevices 的同设备归并 (6)
     × 问不到设备时靠 mDNS 实例名里嵌的序列号兜底 3ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/electron/adbDeviceList.test.js > listConnectDevices 的同设备归并 > 问不到设备时靠 mDNS 实例名里嵌的序列号兜底
AssertionError: expected [ Array(2) ] to have a length of 1 but got 2

- Expected
+ Received

- 1
+ 2

 ❯ tests/electron/adbDeviceList.test.js:109:18
    107|       stableIds: { [USB]: 'af3d7abd' },
    108|     })
    109|     expect(list).toHaveLength(1)
       |                  ^
    110|     expect(list[0]).toMatchObject({ stableId: 'af3d7abd', address: USB…
    111|   })

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 5 passed (6)
   Start at  18:54:07
   Duration  111ms (tests 65%, transform 24%, import 8%, worker 2%)


```

---

## Assistant (Build · MiMo-V2.6-Flash Free · 20.7s)

_Thinking:_

The fallback case failed. Why? For MDNS serial with failed shell: adbExecSafe gets err → but wait, my mock calls `cb(new Error('device offline'), '', '')`. isAdbTimeoutError? no. → resolve({code:1, stdout:'', stderr:'device offline'}). Then pickStableId([], serial) → serial. So stable === serial → then `serviceDeviceToken(serial)`.

serviceDeviceToken(MDNS): value = name.split("._adb-")[0] → 'adb-af3d7abd-Zvci5V' → starts with 'adb-' ✓ → parts = slice(4).split('-') = ['af3d7abd','Zvci5V'] → parts[0]='af3d7abd' lowercase → 'af3d7abd'. So key should be 'af3d7abd'...

Unless USB key isn't 'af3d7abd'. Hmm, maybe `stableIdOf(USB)`? No alias. So key for USB = resolve → 'af3d7abd' ✓.

Wait — maybe the failure is different: maybe the shell for MDNS *did* fail but resolveDeviceStableId... hmm, but wait: mock for `line.includes('getprop ro.serialno')` uses `args[1]` as serial — for shell the args are ['-s', serial, 'shell', 'cmd'] → args[1] = serial ✓.

But the actual issue might be that `rememberAlias` is NOT called on failure, but... let's debug: print the actual list. Possibly the two rows have stableIds 'af3d7abd' and MDNS? Or maybe USB row got key 'af3d7abd' and MDNS row also 'af3d7abd' but... it says length 2.

Hmm wait — could `serviceDeviceToken` be returning '' because... Let me debug quickly by adding a console log or writing a small script. Actually let's check: is the error thrown *before* pickStableId? adbExecSafe resolves (never rejects) ✓.

Unless... resolveDeviceStableId's `sessionStableIds` — fresh module each test ✓.

Let me debug by printing list.

**Tool: bash**

**Input:**
```json
{
  "command": "cat > /tmp/dbg.test.js <<'EOF'\nimport { describe, expect, it, vi } from 'vitest'\nconst adbOut = vi.hoisted(() => ({ devices: '', mdns: '', stableIds: {}, calls: [] }))\nconst ipcHandlers = vi.hoisted(() => new Map())\nvi.mock('electron', () => ({ app: { getPath: () => '', getVersion: () => '0.0.0-test', isPackaged: false }, ipcMain: { handle: (c, f) => ipcHandlers.set(c, f), on: () => {} }, dialog: {}, BrowserWindow: class {} }))\nvi.mock('node:child_process', () => ({ execFile: (_b, args, _o, cb) => { const line = args.join(' '); adbOut.calls.push(line); queueMicrotask(() => { if (line === 'start-server') return cb(null,'',''); if (line === 'devices') return cb(null, adbOut.devices, ''); if (line === 'mdns services') return cb(null, adbOut.mdns, ''); if (line.includes('getprop ro.serialno')) { const s = args[1]; if (adbOut.stableIds[s] === undefined) return cb(new Error('device offline'),'',''); return cb(null, adbOut.stableIds[s], ''); } return cb(null,'','') }) } }))\nvi.mock('node:fs', () => ({ promises: { mkdir: () => Promise.resolve(), writeFile: () => Promise.resolve(), rename: () => Promise.resolve(), unlink: () => Promise.resolve(), readFile: () => Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })), readdir: () => Promise.resolve([]), stat: () => Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })), rm: () => Promise.resolve() }, readFileSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) } }))\nvi.mock('../../electron/mdns.js', () => ({ browse: () => () => {} }))\nit('dbg', async () => {\n  vi.resetModules()\n  adbOut.devices = 'List of devices attached\\naf3d7abd\\tdevice\\nadb-af3d7abd-Zvci5V._adb-tls-connect._tcp\\tdevice\\n'\n  adbOut.stableIds = { af3d7abd: 'af3d7abd' }\n  const mod = await import('/Users/xh/code/anddrive/electron/adb.js')\n  const list = await ipcHandlers.get('adb:listConnectDevices')()\n  console.log(JSON.stringify(list, null, 2))\n  console.log(adbOut.calls)\n  console.log('token:', mod.serviceDeviceToken('adb-af3d7abd-Zvci5V._adb-tls-connect._tcp'))\n})\nEOF\nnpx vitest run --config vitest.config.js /tmp/dbg.test.js 2>&1 | tail -60",
  "timeout": 120000
}
```

**Output:**
```

 RUN  v5.0.2 /Users/xh/code/anddrive

No test files found, exiting with code 1

filter: /tmp/dbg.test.js
include: tests/**/*.test.js
exclude:  **/node_modules/**, **/.git/**


```

---

## Assistant (Build · MiMo-V2.6-Flash Free · 6.5s)

_Thinking:_

Can't run outside tests dir. Put debug into the real test temporarily? Easier: add a temporary console.log in the failing test. Let's just edit the test temporarily to log.

**Tool: bash**

**Input:**
```json
{
  "command": "cd /Users/xh/code/anddrive && python3 - <<'EOF'\nimport re\np='tests/electron/adbDeviceList.test.js'\ns=open(p).read()\ns=s.replace(\"\"\"    expect(list).toHaveLength(1)\n    expect(list[0]).toMatchObject({ stableId: 'af3d7abd', address: USB })\"\"\",\"\"\"    console.log(JSON.stringify(list), adbOut.calls)\n    expect(list).toHaveLength(1)\n    expect(list[0]).toMatchObject({ stableId: 'af3d7abd', address: USB })\"\"\")\nopen(p,'w').write(s)\nEOF\nnpx vitest run --config vitest.config.js tests/electron/adbDeviceList.test.js -t \"问不到\" 2>&1 | head -40",
  "timeout": 120000
}
```

**Output:**
```

 RUN  v5.0.2 /Users/xh/code/anddrive

stdout | tests/electron/adbDeviceList.test.js > listConnectDevices 的同设备归并 > 问不到设备时靠 mDNS 实例名里嵌的序列号兜底
[{"stableId":"af3d7abd","name":"af3d7abd","type":"","address":"af3d7abd","displayAddress":"af3d7abd","label":null,"connected":true,"state":"device","transport":"usb"},{"stableId":"device offline","name":"adb-af3d7abd-Zvci5V._adb-tls-connect._tcp","type":"","address":"adb-af3d7abd-Zvci5V._adb-tls-connect._tcp","displayAddress":"adb-af3d7abd-Zvci5V._adb-tls-connect._tcp","label":null,"connected":true,"state":"device","transport":"wifi"}] [
  'start-server',
  'mdns services',
  'devices',
  '-s af3d7abd shell settings get secure bluetooth_name',
  '-s af3d7abd shell settings get global device_name',
  '-s af3d7abd shell getprop ro.product.marketname',
  '-s adb-af3d7abd-Zvci5V._adb-tls-connect._tcp shell settings get secure bluetooth_name',
  '-s adb-af3d7abd-Zvci5V._adb-tls-connect._tcp shell settings get global device_name',
  '-s adb-af3d7abd-Zvci5V._adb-tls-connect._tcp shell getprop ro.product.marketname',
  '-s af3d7abd shell getprop ro.serialno; getprop ro.boot.serialno; settings get secure android_id',
  '-s adb-af3d7abd-Zvci5V._adb-tls-connect._tcp shell getprop ro.serialno; getprop ro.boot.serialno; settings get secure android_id'
]

 ❯ tests/electron/adbDeviceList.test.js (6 tests | 1 failed | 5 skipped) 35ms
   ❯ listConnectDevices 的同设备归并 (6)
     × 问不到设备时靠 mDNS 实例名里嵌的序列号兜底 35ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/electron/adbDeviceList.test.js > listConnectDevices 的同设备归并 > 问不到设备时靠 mDNS 实例名里嵌的序列号兜底
AssertionError: expected [ Array(2) ] to have a length of 1 but got 2

- Expected
+ Received

- 1
+ 2

 ❯ tests/electron/adbDeviceList.test.js:110:18
    108|     })
    109|     console.log(JSON.stringify(list), adbOut.calls)
    110|     expect(list).toHaveLength(1)
       |                  ^
    111|     expect(list[0]).toMatchObject({ stableId: 'af3d7abd', address: USB…
    112|   })

```

---

## Assistant (Build · MiMo-V2.6-Flash Free · 28.7s)

_Thinking:_

Interesting! The MDNS stableId came out as `"device offline"` — the error message! Because adbExecSafe with err: `const code = typeof err.code === 'number' ? err.code : 1; resolve({ code, stdout: out, stderr: ... })` — stdout '' → pickStableId(lines.slice(0,3), serial): lines = `${stdout}\n${stderr}`.split → ['','device offline'] → slice(0,3) = ['', 'device offline'] → pickStableId skips '' → picks 'device offline'!! 

That's a pre-existing quirk: when adb shell fails, stderr text can be picked as stable id. In real adb, a failing shell command produces stderr like "/system/bin/sh: ... not found" — could be picked as stable id! That's a real bug (pre-existing) but rarely hit since resolve only runs on connected devices... but adbExecSafe failure does happen (device offline at that moment).

Hmm — should I fix it? My `deviceListStableId` would then return 'device offline' as a key — bogus, could even collide across devices (both devices offline → same key → merged incorrectly! serious). Yes, worth guarding: only accept the resolved stable id when it doesn't look like garbage... but pickStableId is the shared authority.

Better fix: in resolveDeviceStableId, if the shell command failed (code !== 0 or stdout empty), fall back to serial without persisting. The doc says "问不到（掉线、没这台设备）就回传输地址" — so returning stderr text violates the documented intent. Let's fix in resolveDeviceStableId:

```js
const { stdout, stderr, code } = await adbExecSafe(...);
const lines = `${stdout}\n${stderr}`...
```
Proper fix: only consider stdout lines when code === 0? adb `getprop` on a missing prop prints empty line and exits 0 for the whole compound command? The compound `a; b; c` exit code = last command's. `settings get secure android_id` returns 0 normally. If device offline, adbExecSafe returns code 1 with stderr message.

I'll change to: if `code !== 0` → throw (→ catch returns serial, no alias written, no session memo) — matches "问不到就回传输地址，不写别名表". But careful: code non-zero could happen if only the last command failed while getprop succeeded... e.g., `settings get secure android_id` on some devices might fail? Then we'd lose the ro.serialno. Safer: build candidates from stdout only (not stderr), and if no candidate → fallback serial.

But then in my test, adbExecSafe with error → stdout '' → lines = '' → pickStableId([''] ... ) → wait `${stdout}\n${stderr}` → I'd change to use stdout only: `String(stdout).split("\n")` → [''] → pickStableId → fallback serial ✓.

Is stderr ever needed? The three commands write to stdout normally. If adb fails, stdout empty → fallback serial ✓. Using stdout only is strictly better. Also apply code check? If code !== 0 but stdout has content (partial), using stdout is fine.

But careful: `adbExecSafe` on timeout gives stdout '' + stderr ADB_TIMEOUT_MESSAGE → fallback ✓ (previously would pick "设备无响应..." as stable id! real bug).

So fix resolveDeviceStableId to read stdout only. This also improves findTransportByStableId/favorites.

Also should I guard against garbage in general? E.g. pickStableId INVALID_IDS handles 'unknown','null','0'. A stderr sentence could still leak if... not anymore since we only use stdout.

Let's apply: replace```js
    const lines = `${stdout}\n${stderr}`.split("\n").map((line) => line.trim());
```
with
```js
    // 只认 stdout：失败时 stderr 是给人看的中文说明（「设备无响应…」），会被 pickStableId
    // 当成序列号写进别名表，之后所有按标识的查找都对不上。
    const lines = String(stdout ?? "").split("\n").map((line) => line.trim());
```
and drop `stderr` destructure? Keep `const { stdout } = await ...`.

Then in test, the MDNS key = serial (fallback) → token → 'af3d7abd' ✓ merges.

Let's apply and also check `favorites`/`shortcut` tests unaffected.

Also remove the debug console.log from the test.

**Tool: edit**

**Input:**
```json
{
  "filePath": "/Users/xh/code/anddrive/electron/adb.js",
  "newString": "  const task = (async () => {\n    const { stdout } = await adbExecSafe(\n      \"-s\",\n      serial,\n      \"shell\",\n      \"getprop ro.serialno; getprop ro.boot.serialno; settings get secure android_id\",\n    );\n    // 只认 stdout：命令失败时 stderr 是给人看的说明（如「设备无响应（命令超时）…」），\n    // 混进候选会被 pickStableId 当成序列号写进别名表，之后按标识的查找全对不上。\n    const lines = String(stdout ?? \"\")\n      .split(\"\\n\")\n      .map((line) => line.trim());\n    const stable = pickStableId(lines.slice(0, 3), serial);",
  "oldString": "  const task = (async () => {\n    const { stdout, stderr } = await adbExecSafe(\n      \"-s\",\n      serial,\n      \"shell\",\n      \"getprop ro.serialno; getprop ro.boot.serialno; settings get secure android_id\",\n    );\n    const lines = `${stdout}\\n${stderr}`.split(\"\\n\").map((line) => line.trim());\n    const stable = pickStableId(lines.slice(0, 3), serial);"
}
```

**Output:**
```
Edit applied successfully.
```

**Tool: edit**

**Input:**
```json
{
  "filePath": "/Users/xh/code/anddrive/tests/electron/adbDeviceList.test.js",
  "newString": "    expect(list).toHaveLength(1)\n    expect(list[0]).toMatchObject({ stableId: 'af3d7abd', address: USB })",
  "oldString": "    console.log(JSON.stringify(list), adbOut.calls)\n    expect(list).toHaveLength(1)\n    expect(list[0]).toMatchObject({ stableId: 'af3d7abd', address: USB })"
}
```

**Output:**
```
Edit applied successfully.
```

---

## Assistant (Build · MiMo-V2.6-Flash Free · 11.8s)

_Thinking:_

Wait: with stdout-only, when shell succeeds but the device returns only android_id etc. Fine.

But there's a subtlety: `${stdout}` was trimmed by adbExecSafe already (`stdout: out` trimmed) — so trailing empty lines are gone; `lines.slice(0,3)` for 'af3d7abd' → ['af3d7abd'] ✓. For a device where ro.serialno empty and android_id present: stdout = '\n\n0123...' trimmed → '0123...' → lines ['0123...'] → picks android_id ✓ (position lost but value right).

Hmm — trimming loses position info: if ro.serialno is empty and ro.boot.serialno = 'xyz', trimmed stdout = 'xyz\nandroid_id' → picks 'xyz' ✓ still correct (first non-empty). Trimming only collapses leading empties, values still in priority order ✓.

Now run the full test suite.

**Tool: bash**

**Input:**
```json
{
  "command": "npm test 2>&1 | tail -15",
  "timeout": 300000
}
```

**Output:**
```

> anddrive_next@0.0.4 test
> vitest run --config vitest.config.js


 RUN  v5.0.2 /Users/xh/code/anddrive


 Test Files  34 passed (34)
      Tests  336 passed | 1 skipped (337)
   Start at  18:55:14
   Duration  760ms (tests 46%, transform 26%, import 25%, worker 3%)


```

---

## Assistant (Build · MiMo-V2.6-Flash Free · 11.6s)

_Thinking:_

All 336 pass. Now run lint + typecheck + format check on changed files.

Also verify `resolveDeviceStableId`'s doc mention of stderr? Fine.

Also consider: should `getConnectedDevice`'s stableId... already done.

Let's run lint/typecheck.

**Tool: bash**

**Input:**
```json
{
  "command": "npx tsc --project jsconfig.typecheck.json; npm run lint 2>&1 | tail -20; npx oxfmt --check tests/electron/adbDeviceList.test.js 2>&1 | tail -3; git diff --stat",
  "timeout": 300000
}
```

**Output:**
```

> anddrive_next@0.0.4 lint
> run-s lint:oxlint lint:eslint


> anddrive_next@0.0.4 lint:oxlint
> oxlint .


> anddrive_next@0.0.4 lint:eslint
> eslint . --no-cache


All matched files use the correct format.
Finished in 0ms on 1 files using 10 threads.
 electron/adb.js                    | 109 ++++++++++++++++++++------
 src/App.vue                        |  11 ++-
 src/components/AddDeviceDialog.vue |   2 +-
 src/components/PageHeader.vue      |   9 ++-
 src/components/home/AppList.vue    | 107 ++++++++++++++------------
 src/components/home/index.vue      | 154 ++++++++++++++++++++++++++-----------
 6 files changed, 273 insertions(+), 119 deletions(-)

```

---

## Assistant (Build · MiMo-V2.6-Flash Free · 3.2s)

_Thinking:_

All green. (home/* diffs are pre-existing user changes, untouched by me.)

Let me review the final diff of my changes to double check quality.

**Tool: bash**

**Input:**
```json
{
  "command": "git diff electron/adb.js src/App.vue src/components/PageHeader.vue src/components/AddDeviceDialog.vue"
}
```

**Output:**
```
diff --git a/electron/adb.js b/electron/adb.js
index 7fa907d..0b06860 100644
--- a/electron/adb.js
+++ b/electron/adb.js
@@ -392,7 +392,11 @@ async function deviceDisplayName(serial) {
  * `address` 一律取 adb 的 serial（可直接用于 `adb -s`），展示用 displayAddress。
  * `transport` 区分有线 / 无线：USB 直插的设备没有 mDNS 条目，展示与断开逻辑都按它分支。
  * 未授权（unauthorized）也返回，`connected: false` 供界面提示「在手机上点允许」。
- * @returns {Promise<{ name: string, type: string, address: string, displayAddress: string, label: string | null, connected: boolean, state: string, transport: "usb" | "wifi" }[]>}
+ *
+ * **同一台手机插着线又开着无线调试时只出一行**：adb 里那是两条 transport
+ * （`af3d7abd` 和 `192.168.1.5:37000` / `adb-af3d7abd-XXXX._adb-tls-connect._tcp`），
+ * 这里按稳定标识归成一组，`stableId` 就是组键，`address` 取组里可用的那条传输。
+ * @returns {Promise<{ stableId: string, name: string, type: string, address: string, displayAddress: string, label: string | null, connected: boolean, state: string, transport: "usb" | "wifi" }[]>}
  */
 async function listConnectDevices() {
   ensureConnectBrowser();
@@ -414,35 +418,84 @@ async function listConnectDevices() {
     ([serial]) => !serial.startsWith("emulator-"),
   );
 
-  return Promise.all(
+  const built = await Promise.all(
     entries.map(async ([serial, state]) => {
       const svc = bySerial.get(serial);
-      if (state === "device") warmDeviceStableId(serial);
       // 没授权的设备 shell 读什么都失败，直接不读，别让标签和名字一起卡住。
       const label =
         state === "device"
           ? (svc && connectNames.get(svc.name)) || (await deviceDisplayName(serial)) || null
           : null;
+      const stableId = await deviceListStableId(serial, state);
       return {
-        name: svc?.name || serial,
-        // USB 直插没有 mDNS 服务条目，不硬塞一个无线服务类型骗界面。
-        type: svc?.type || "",
-        address: serial,
-        displayAddress: svc?.address || serial,
-        label,
-        connected: state === "device",
-        state,
-        transport: deviceTransport(serial),
+        stableId,
+        record: {
+          stableId,
+          name: svc?.name || serial,
+          // USB 直插没有 mDNS 服务条目，不硬塞一个无线服务类型骗界面。
+          type: svc?.type || "",
+          address: serial,
+          displayAddress: svc?.address || serial,
+          label,
+          connected: state === "device",
+          state,
+          transport: deviceTransport(serial),
+        },
       };
     }),
   );
+
+  const merged = new Map();
+  for (const { stableId, record } of built) {
+    const existing = merged.get(stableId);
+    merged.set(stableId, existing ? mergeDeviceRecords(existing, record) : record);
+  }
+  return [...merged.values()];
+}
+
+/**
+ * 一行设备的归组键：同一台手机的三条传输形态（USB serial / `host:port` /
+ * mDNS 实例名）必须落到同一个键上，否则插线 + 开无线调试就显示成两台。
+ *
+ * 先查别名表（同步、已落盘）；在线设备再向它问一次 `ro.serialno`
+ * （进程内有缓存，每台每次会话只问一回）；问不到（未授权 / 离线）才用同步兜底
+ * ——mDNS 实例名 `adb-af3d7abd-XXXX._adb-tls-connect._tcp` 里嵌的就是 USB serial。
+ * @param {string} serial
+ * @param {string} state
+ * @returns {Promise<string>}
+ */
+async function deviceListStableId(serial, state) {
+  const known = stableIdOf(serial);
+  if (known !== serial) return known;
+  if (state !== "device") return serviceDeviceToken(serial) || serial;
+  const stable = await resolveDeviceStableId(serial);
+  if (stable && stable !== serial) return stable;
+  // 问不到设备（掉线 / 超时）时的兜底：mDNS 实例名 `adb-af3d7abd-XXXX…` 里的
+  // `af3d7abd` 正是这台机器的 USB serial，照样能和有线那条并成一行。
+  return serviceDeviceToken(serial) || stable || serial;
+}
+
+/** 同一台设备的多条传输里挑代表行：在线优先，其次有线（serial 稳定，心跳与断开都按它走）。 */
+function preferDeviceRecord(a, b) {
+  if (a.connected !== b.connected) return a.connected ? a : b;
+  if (a.transport !== b.transport) return a.transport === "usb" ? a : b;
+  return a;
+}
+
+/** 把同一台设备的两条传输并成一行：代表行定 address / transport，名字标签取两边更好的那个。 */
+function mergeDeviceRecords(a, b) {
+  const main = preferDeviceRecord(a, b);
+  const other = main === a ? b : a;
+  // 名字优先用 mDNS 的 given_name（它一定不等于 serial），没有就退回代表行的。
+  const name = [main, other].find((r) => r.name && r.name !== r.address)?.name ?? main.name;
+  return { ...main, name, label: main.label || other.label || null };
 }
 
 /**
  * 返回当前 adb 已连接（状态 device）的设备，供启动时接管其他工具
  * （Android Studio / 终端 adb 等）已建立的连接。优先无线设备，
  * address 用 adb 的 serial，可直接用于后续 `adb -s`。
- * @returns {Promise<{ name: string, address: string, displayAddress: string, label: string | null, transport: "usb" | "wifi" } | null>}
+ * @returns {Promise<{ stableId: string, name: string, address: string, displayAddress: string, label: string | null, transport: "usb" | "wifi" } | null>}
  */
 async function getConnectedDevice() {
   await ensureServer();
@@ -474,7 +527,15 @@ async function getConnectedDevice() {
   } catch {
     // ignore
   }
-  return { name, address, displayAddress, label, transport: deviceTransport(address) };
+  return {
+    name,
+    address,
+    displayAddress,
+    label,
+    transport: deviceTransport(address),
+    // 和设备列表同一套组键：切换设备下拉靠它认出「这就是同一台」
+    stableId: (await resolveDeviceStableId(address)) || address,
+  };
 }
 
 // ---------------------------------------------------------------------------
@@ -864,6 +925,10 @@ export function stableIdOf(transport) {
   return stableAliases.get(transport) || transport;
 }
 
+/** 本次进程内问到的标识：别名表只为「标识 ≠ 传输地址」的地址落盘，USB 这种相同的
+ * 每次都重问会把 1s 一轮的设备列表变成一串 shell，所以进程内也记一份。 */
+const sessionStableIds = new Map();
+
 /**
  * 向设备问一次稳定标识：`ro.serialno` → `ro.boot.serialno` → `settings secure android_id`。
  * 问不到（掉线、没这台设备）就回传输地址，并且**不写别名表**，下次连上还会再解析。
@@ -873,19 +938,24 @@ export function stableIdOf(transport) {
 export async function resolveDeviceStableId(serial) {
   if (typeof serial !== "string" || !serial) return "";
   loadAliases();
-  const known = stableAliases.get(serial);
+  const known = stableAliases.get(serial) || sessionStableIds.get(serial);
   if (known) return known;
   const pending = resolving.get(serial);
   if (pending) return pending;
   const task = (async () => {
-    const { stdout, stderr } = await adbExecSafe(
+    const { stdout } = await adbExecSafe(
       "-s",
       serial,
       "shell",
       "getprop ro.serialno; getprop ro.boot.serialno; settings get secure android_id",
     );
-    const lines = `${stdout}\n${stderr}`.split("\n").map((line) => line.trim());
+    // 只认 stdout：命令失败时 stderr 是给人看的说明（如「设备无响应（命令超时）…」），
+    // 混进候选会被 pickStableId 当成序列号写进别名表，之后按标识的查找全对不上。
+    const lines = String(stdout ?? "")
+      .split("\n")
+      .map((line) => line.trim());
     const stable = pickStableId(lines.slice(0, 3), serial);
+    sessionStableIds.set(serial, stable);
     rememberAlias(serial, stable);
     return stable;
   })().finally(() => resolving.delete(serial));
@@ -897,11 +967,6 @@ export async function resolveDeviceStableId(serial) {
   }
 }
 
-/** 设备列表里顺手预热别名（不阻塞返回）。 */
-function warmDeviceStableId(serial) {
-  void resolveDeviceStableId(serial).catch(() => {});
-}
-
 /**
  * 用稳定标识反查**当前**可用的 adb 传输地址。
  *
diff --git a/src/App.vue b/src/App.vue
index c5976e6..9edfe0d 100644
--- a/src/App.vue
+++ b/src/App.vue
@@ -43,6 +43,13 @@ const disconnectError = ref("");
 
 const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
 
+// 同一台设备：列表里有线/无线已合并成一行，但接管进来的可能是其中任意一条传输，
+// 所以先比稳定标识，再退回 address。
+function sameDevice(a, b) {
+  if (!a || !b) return false;
+  return (!!a.stableId && !!b.stableId && a.stableId === b.stableId) || a.address === b.address;
+}
+
 /** 断线后记住的设备，供自动重连使用 */
 let lostDevice = null;
 /** 启动后若发现已有连接则自动接管；用户主动断开后不再自动接管 */
@@ -195,7 +202,7 @@ function adoptDevice(target) {
 // 这样设备列表里它还在，随时能切回去（无线那台也不用重新 connect）。
 async function releasePrevious(target) {
   const previous = device.value;
-  if (!previous || previous.address === target.address) return;
+  if (!previous || sameDevice(previous, target)) return;
   try {
     await releaseDeviceApi(previous.address);
   } catch (e) {
@@ -223,7 +230,7 @@ async function connectTo(target) {
 const switching = ref(false);
 async function switchDevice(target) {
   if (!target?.connected || switching.value) return;
-  if (device.value && target.address === device.value.address) return;
+  if (device.value && sameDevice(target, device.value)) return;
   const label = target.label || target.name || "设备";
   switching.value = true;
   try {
diff --git a/src/components/AddDeviceDialog.vue b/src/components/AddDeviceDialog.vue
index 9abb550..84a0cbd 100644
--- a/src/components/AddDeviceDialog.vue
+++ b/src/components/AddDeviceDialog.vue
@@ -186,7 +186,7 @@ onUnmounted(stopWaiting)
           <div class="mt-2 flex max-h-[184px] flex-col gap-1.5 overflow-y-auto">
             <div
               v-for="device in props.devices"
-              :key="device.address"
+              :key="device.stableId || device.address"
               class="flex items-center gap-2.5 rounded-[12px] bg-surface-2/70 px-3 py-2.5 ring-1 ring-line"
             >
               <div
diff --git a/src/components/PageHeader.vue b/src/components/PageHeader.vue
index b557f49..8ad2a3c 100644
--- a/src/components/PageHeader.vue
+++ b/src/components/PageHeader.vue
@@ -37,9 +37,14 @@ const disconnectMessage = computed(() =>
     : '将断开当前无线 ADB 连接。手机端的配对记录仍会保留，之后可以再次连接。若设备已经离线，断开操作仍会视为成功。',
 )
 
+/** 列表行的身份：同一台设备的有线/无线两条传输合并后 address 会不同，优先按稳定标识。 */
+function deviceKey(device) {
+  return device?.stableId || device?.address || ''
+}
+
 /** 下拉里这行是不是正在用的那台。 */
 function isCurrent(device) {
-  return !!props.activeDevice && device.address === props.activeDevice.address
+  return !!props.activeDevice && !!deviceKey(device) && deviceKey(device) === deviceKey(props.activeDevice)
 }
 
 /** 选中另一台设备：关掉下拉，把切换交给父级（它负责给上一台收摊）。 */
@@ -114,7 +119,7 @@ watch(
               class="z-50 w-[300px] rounded-[12px] border border-line bg-surface p-1.5 shadow-pop outline-none backdrop-blur-xl">
               <div class="px-2 pt-1 pb-1.5 text-[11px] font-medium text-ink-3">切换设备</div>
 
-              <button v-for="item in devices" :key="item.address" type="button"
+              <button v-for="item in devices" :key="deviceKey(item)" type="button"
                 class="flex w-full items-center gap-2.5 rounded-[9px] px-2 py-1.5 text-left outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-45"
                 :class="isCurrent(item) ? 'bg-accent/[0.08]' : 'hover:bg-fill disabled:hover:bg-transparent'"
                 :disabled="!item.connected" @click="pickDevice(item)">

```

---

## Assistant (Build · MiMo-V2.6-Flash Free · 34.3s)

_Thinking:_

A couple of refinements to consider:

1. `sessionStableIds.set(serial, stable)` before `rememberAlias` — fine.

2. In `mergeDeviceRecords`, if both records are connected and both wifi (same device over two wifi transports? possible: `host:port` and mDNS-form both connected) → prefer first. Fine.

3. `getConnectedDevice` now awaits resolveDeviceStableId — if the device is connected but shell hangs, up to 15s timeout... Hmm, getConnectedDevice is called on startup and during reconnect loops. resolve uses adbExecSafe with 15s timeout and never throws. Could add latency in recovery path (3s loop). But session memo means it happens once. Still, if it takes 15s (device offline-but-listed) — getConnectedDevice only picks state === "device" devices, so shell should respond. Acceptable? Risk: startup blocking for 15s in a bad case. Hmm.

Could instead make stableId lazy... but simpler: in getConnectedDevice, resolve with a race? Overkill. Alternatively use `stableIdOf(address)` (sync) plus token — same approach as deviceListStableId's sync part, but for the wifi `host:port` case alias may be unknown at cold start → stableId would be the address → dropdown "current" highlight mismatch with list row (whose stableId is ro.serialno). That mismatch is exactly what we're fixing.

Middle ground: keep the await — one shell per session. If it times out, 15s delay. Given deviceDisplayName already does3 shells in listConnectDevices (also up to timeouts) — but list is not the startup critical path... actually connect() calls getConnectedDevice at mount.

To be safe, I can give the resolve a shorter timeout? resolveDeviceStableId doesn't accept options. I'll leave it: adbExecSafe with `device` state normally returns in ms.

Actually, hmm: consider Android devices where shell commands are slow (screen off → still responds). Fine.

4. One more scenario to verify: `discoveredDevices` in AddDeviceDialog lists devices including the *currently connected* one; connect button disabled? Not related.

5. docs/TODO.md D4 mentions the dual-lock window; maybe worth a small doc note? Not required.

Now — the display side: with merged row showing transport usb, `deviceHint` shows displayAddress (serial) ✓ one address.

6. What about `stateText` for merged: representative state ✓.

Let's double-check `home/index.vue` shows `device.transport === 'usb' ? 'USB' : '无线'` → USB ✓.

7. Potential regression: `discoverLoop` auto-adopt picks `devices.find(d => d.connected)` — order now follows first-seen key order. With USB + wifi merged → one row, address = usb ✓.

8. `getDeviceState` healthLoop on usb address; if USB drops → lost → recovery → getConnectedDevice → prefers wireless (wifi serial online) → adopt wifi row ✓ good.

I think the change is complete. Let's also run the full verification once more (lint already ran, typecheck ran, tests ran). Also format check on my files: adb.js, App.vue, PageHeader were failing pre-existing; are they *newly* failing due to my edits? Baseline check earlier showed App.vue, PageHeader, adb.js failing at HEAD too → pre-existing. But could my edits add *additional* violations? Since whole file fails anyway, can't tell. Let's check whether oxfmt --check output for my files lists specific lines... oxfmt only reports files. To be safe, run `npx oxfmt` on a copy of HEAD version vs current? Let's do: create temp copies of HEAD file and current, run oxfmt on temp dir and diff to see if my added lines are oxfmt-clean.

Simpler approach: copy current file to temp, run oxfmt (write) on temp, then diff against current → shows what oxfmt would change; check whether any changed region overlaps my edits.

**Tool: bash**

**Input:**
```json
{
  "command": "mkdir -p /var/folders/5z/_wwjcl014_bcv_tkbjw4rts40000gn/T/opencode/fmt && cp electron/adb.js src/App.vue src/components/PageHeader.vue /var/folders/5z/_wwjcl014_bcv_tkbjw4rts40000gn/T/opencode/fmt/ && npx oxfmt /var/folders/5z/_wwjcl014_bcv_tkbjw4rts40000gn/T/opencode/fmt/adb.js /var/folders/5z/_wwjcl014_bcv_tkbjw4rts40000gn/T/opencode/fmt/App.vue /var/folders/5z/_wwjcl014_bcv_tkbjw4rts40000gn/T/opencode/fmt/PageHeader.vue >/dev/null 2>&1; diff -u electron/adb.js /var/folders/5z/_wwjcl014_bcv_tkbjw4rts40000gn/T/opencode/fmt/adb.js | head -40; echo \"---APP---\"; diff -u src/App.vue /var/folders/5z/_wwjcl014_bcv_tkbjw4rts40000gn/T/opencode/fmt/App.vue | head -30; echo \"---HDR---\"; diff -u src/components/PageHeader.vue /var/folders/5z/_wwjcl014_bcv_tkbjw4rts40000gn/T/opencode/fmt/PageHeader.vue | head -30"
}
```

**Output:**
```
--- electron/adb.js	2026-09-30 18:55:03
+++ /var/folders/5z/_wwjcl014_bcv_tkbjw4rts40000gn/T/opencode/fmt/adb.js	2026-09-30 18:56:04
@@ -1,49 +1,49 @@
-import { app, dialog, ipcMain } from "electron";
-import { execFile } from "node:child_process";
-import { createHash, randomBytes } from "node:crypto";
-import { promises as fs, readFileSync } from "node:fs";
-import path from "node:path";
-import { fileURLToPath } from "node:url";
-import { CHANNELS } from "./ipcContract.js";
-import { browse } from "./mdns.js";
-import { pickStableId } from "./deviceIdentity.js";
-import { parseEncoderMimes, VIDEO_ENCODER_PROBE_CMD } from "../shared/scrcpyConfig.js";
-import { iconPngBuffer, MAX_ICON_BYTES, PNG_DATA_URL_PREFIX } from "./iconImage.js";
-import helperVersion from "../resources/helper-app.version.json" with { type: "json" };
+import { app, dialog, ipcMain } from 'electron'
+import { execFile } from 'node:child_process'
+import { createHash, randomBytes } from 'node:crypto'
+import { promises as fs, readFileSync } from 'node:fs'
+import path from 'node:path'
+import { fileURLToPath } from 'node:url'
+import { CHANNELS } from './ipcContract.js'
+import { browse } from './mdns.js'
+import { pickStableId } from './deviceIdentity.js'
+import { parseEncoderMimes, VIDEO_ENCODER_PROBE_CMD } from '../shared/scrcpyConfig.js'
+import { iconPngBuffer, MAX_ICON_BYTES, PNG_DATA_URL_PREFIX } from './iconImage.js'
+import helperVersion from '../resources/helper-app.version.json' with { type: 'json' }
 
 // ---------------------------------------------------------------------------
 // 资源路径
 // ---------------------------------------------------------------------------
 
-const __dirname = path.dirname(fileURLToPath(import.meta.url));
+const __dirname = path.dirname(fileURLToPath(import.meta.url))
 
 /** 打包后取 resources 目录，开发环境取项目 ./resources。 */
 function resourcesBase() {
-  return app.isPackaged ? process.resourcesPath : path.join(__dirname, "..", "resources");
+  return app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', 'resources')
 }
---APP---
--- src/App.vue	2026-09-30 18:51:49
+++ /var/folders/5z/_wwjcl014_bcv_tkbjw4rts40000gn/T/opencode/fmt/App.vue	2026-09-30 18:56:04
@@ -1,7 +1,7 @@
 <script setup>
-import PageHome from "./components/home/index.vue";
-import PageSettings from "./components/Settings.vue";
-import { Toaster } from "vue-sonner";
+import PageHome from './components/home/index.vue'
+import PageSettings from './components/Settings.vue'
+import { Toaster } from 'vue-sonner'
 import {
   connectApi,
   disconnectApi,
@@ -12,73 +12,73 @@
   reconnectApi,
   onMirrorResultApi,
   onMirrorExitApi,
-} from "@/api";
-import { readableError } from "@/utils/errors";
-import { notify, notifyError } from "@/composables/useNotifications";
-import { autoReconnect } from "@/composables/useConnectionPreferences";
-import { isDark } from "@/composables/useTheme";
+} from '@/api'
+import { readableError } from '@/utils/errors'
+import { notify, notifyError } from '@/composables/useNotifications'
+import { autoReconnect } from '@/composables/useConnectionPreferences'
+import { isDark } from '@/composables/useTheme'
 import {
   startScrcpySessionPolling,
   stopScrcpySessionPolling,
---HDR---
--- src/components/PageHeader.vue	2026-09-30 18:51:49
+++ /var/folders/5z/_wwjcl014_bcv_tkbjw4rts40000gn/T/opencode/fmt/PageHeader.vue	2026-09-30 18:56:04
@@ -27,7 +27,9 @@
 const isUsb = computed(() => props.activeDevice?.transport === 'usb')
 
 // 触发器上直接显示当前设备名，没连上时退回「切换设备」
-const deviceName = computed(() => props.activeDevice?.label || props.activeDevice?.name || '切换设备')
+const deviceName = computed(
+  () => props.activeDevice?.label || props.activeDevice?.name || '切换设备',
+)
 
 watch(menuOpen, (open) => emit('deviceMenuChange', open))
 
@@ -44,7 +46,11 @@
 
 /** 下拉里这行是不是正在用的那台。 */
 function isCurrent(device) {
-  return !!props.activeDevice && !!deviceKey(device) && deviceKey(device) === deviceKey(props.activeDevice)
+  return (
+    !!props.activeDevice &&
+    !!deviceKey(device) &&
+    deviceKey(device) === deviceKey(props.activeDevice)
+  )
 }
 
 /** 选中另一台设备：关掉下拉，把切换交给父级（它负责给上一台收摊）。 */
@@ -67,8 +73,9 @@
   // 只有首页（= 连着设备）才有设置入口：投屏参数里那一串「这台设备能编什么」的列表
   // 没有设备就算不出来，给个半空的页面进去只会误导人。
   if (props.pageType !== 'home') return []

```

---

## Assistant (Build · MiMo-V2.6-Flash Free)

---

