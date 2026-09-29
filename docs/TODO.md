# AndDrive 待办总账

> **这份文档是什么**：全仓**唯一**的待办/缺陷/优化/功能清单。它合并了原先三份文档 —— `AUDIT_2026-09.md`（2026-09-22 体检，D/O/F/G/H 编号）、`FEATURE_ROADMAP.md`（P0–P3 排期）、`CLEANUP_2026-09-28.md`（精简盘点，B/X/W 编号）。
> **原编号保留不重排**，因为 git 历史、提交信息和 `NATIVE_MIRROR.md` 里都在引用它们。
> **口径**：每条带 `file:line`，动手前自己复核；核对不上的不写进来。规模 **S** ≈ 半小时内 · **M** ≈ 半天到一天 · **L** ≈ 多天或要先决策。
> 状态 `[ ]` 未开始 · `[~]` 进行中 · `[x]` 已完成 · **结案** = 已证明不该做（见 §8）。
> 架构与刻意设计见 [`ARCHITECTURE.md`](ARCHITECTURE.md)；镜像取证与实测数据见 [`NATIVE_MIRROR.md`](NATIVE_MIRROR.md)。

## 0. 一分钟结论

1. **§1 已清空**：2026-09-28 一轮修掉 6 条真 bug（B1/B3/B4/O10/D4/D7）、删掉 1 条不要的能力（B2），条目本身已从本文移除。**剩下的全是优化 / 结构 / 功能。**
2. **画面「卡住」三类根因里，「停合成」那一类（9-28 记作 B2，与本文的 bug 编号 B2 无关）已于 2026-09-29 结案**：`electron/mirror/miProjection.js` 照小米互联那条门在会话期间登记 `synergy_mode`，真机三种时序（超时灭屏 / 电源键锁屏 / 锁屏起会话）都不再定住。**客户端断链与 MIUI 收回窗口两类仍未修**，判据与已判死的救法都在 `NATIVE_MIRROR.md` §排查记录 2026-09-28~29。旧的「息屏弹醒」方案已作废，不要重做。
3. **设置页不再有「屏幕策略」**：`keepActive` / `turnOff` / `normal` 三选连同 `setDisplayPower(false)` 那条直调于 2026-09-29 整体删除 —— 我们对设备屏幕**完全不干预**。老存盘里残留的 `screenMode` 由 `normalizeScrcpyConfig` 静默丢弃，不需要迁移。
4. **轮询/定时器 15 处**（§5）。可收口的是三条"UI 想知道设备状态"的轮询，以及建了不拆的 mDNS socket。
5. **按包名/机型的 app 特殊定制在可执行代码里已经清零**（§4）。别再去找"哪里在特判抖音"。
6. **裁切症状已结案**（用户 2026-09-28：原因他已找到，不用再查；根因未入库）。§3 只剩结构债；本轮收口的「显示像素只有一个主人」与「`newDisplay` 必填、不许有默认尺寸」两条已作为**刻意设计**写进 `ARCHITECTURE.md` §4，不再出现在待办里。
7. 最划算的结构刀是拆 `electron/adb.js`（全仓最大文件，8 个职责挤在一起）；透传再导出已经删干净了，剩下的耦合只是 `tests/electron/*` 用 `await import("../../electron/adb.js")` 按主题取符号 —— 拆文件要连这些 import 一起改。

---

## 1. 真 bug（用户能感觉到）

**当前没有未修的真 bug。** 2026-09-28 这一轮修掉的六条（B1/B3/B4/O10/D4/D7）与按决策删除的一条（B2）都已从本文移除，要细节查 git 历史或提交信息。

**从这批里挑出来的、仍然开着的两件**：

- **D7 欠真机验证**：多台设备同时广播时，`_adb-tls-pairing` 与 `_adb-tls-connect` 的实例名是否真的共用同一段设备标识 —— 目前的择优逻辑是按 adb 惯例 + 测试夹具推的，**没在两台真机上验过**。要做时先修现场：两台同时开无线调试，比对 `adb mdns services` 原文。
- **D4 的残留窗口**：别名表还没建立时（冷启动直接刷列表），同一台机器的两个传输地址会分到两把锁。实际链路里连接/心跳会先填好别名，窗口极短，但**不是零**。
- ⚠️ **老用户兼容已按 2026-09-28 的决定全部删除**，代价是**升级后这些东西重来一次**（不是丢设备上的数据，只是本地缓存/偏好）：① 旧收藏里按 adb 传输地址存的那些桶**不再并入**稳定标识（`collapseLegacy` + `favorites.json.bak` 已删）→ 老用户可能看到收藏少了几条，重新星标即可；② `scrcpyConfig` 不再读 localStorage 旧参数（`stored` 标志一并删）→ 首次升级后投屏参数回到默认；③ 快照里的内联图标不再迁移成文件 → 图标重拉一轮。别当成 bug 报回来，也**别再提"加一段迁移"**（见 §8）。

---

## 2. 工程优化与文档事实

- **O1 拆 `electron/adb.js`（8 职责挤在一个文件，全仓最大）**：adb 执行与错误归一 / 输出解析 / mDNS 发现与设备名 / 健康与重连 / 应用缓存与图标 / 稳定标识别名 / 应用操作 / 设备信息 / IPC 注册（这文件自己就注册二十多个 handler）。`tests/electron/` 已按这些主题分文件，主进程按同一刀切最自然；拆的时候要把测试里的 `await import("../../electron/adb.js")` 一起改指向。**L**
- **O5 应用列表 300+ 应用时的成本**：没虚拟化（每格一套 ContextMenu/Portal，`AppList.vue:460-537`）、`patchIcons` 整数组替换（`:81-89`）→ 每 20 个图标全表重排、`sections` 过滤两遍（`:68-78`）、搜索无 debounce（`:58-62`）。顺序：debounce + `sections` 合成一遍 → 真要扛 1000 个再上虚拟化。**M**
- ⚠️ **图标有效期有两个主人**（2026-09-28 我把图标拆成文件时**自己造的**债）：主进程 `electron/adb.js` 的 `ICON_TTL_MS`（决定文件还给不给）与渲染层 `src/components/home/AppList.vue` 的 `ICON_REFRESH_MS`（决定要不要再要一批），两者都是 7 天但**没有共同来源**，改一个忘一个的后果是"每次都重拉"或"过期了还不重拉"。收成一个（渲染层只信主进程：它不给就是缺）。**S**
- **O9 对话框是手搓的 Motion div**（`AppInfoDialog.vue:37-95`、`AddDeviceDialog.vue`）：无焦点陷阱、无 Esc、无 dialog 角色；reka-ui 已在依赖里且已用其 Dialog/ContextMenu，换过去白拿可达性。**S–M**
- **O11 设备信息面板无数据时是空白**（`DeviceStats.vue:116` 只有 `v-else-if="stats"`，无空态/错误态）；写着「更新于」但不会自动刷新。**S**
- **O8 可达性细节**：几处 `outline-none` 没补焦点环（`Settings.vue:146,156`、`DeviceStats.vue:93,175`、`ScrcpySessions.vue:72,96,101`）；纯图标按钮无可访问名称（`PageHeader.vue:57`、`AppList.vue:405-427`）；`<html lang="">` 是空的（`index.html:2`、`mirror.html:2`）；`prefers-reduced-motion` 只在镜像页处理（`src/mirror/App.vue` 样式里的 `@media (prefers-reduced-motion)`）。**S–M**
- **O3 两套 IPC 访问方式并存**：主窗口走 `src/api/index.js` + preload，镜像窗口裸 `window.__anddriveIpc` + `CHANNELS`（`src/mirror/session.js` 开头）。镜像页 `nodeIntegration` 有意为之，已在 `ARCHITECTURE.md` §1 写明边界；改 IPC 时两边都要看。**记录，不改**
- **O7 没有深色模式**：全仓零 `dark:`，`src/App.vue` 的 `<Toaster>` 写死 `theme="light"`。主要成本是把 `src/styles/index.css` 的底色 token 化，不是逐组件改写。**M**（对应 P3-4）
- **O12 没有 CI**：`.github/` 不存在。本地门已齐（`typecheck` + `lint` + `test` + `format:check` + `verify-resources`），先串成一条 `pnpm verify` 再上 Actions。**S**
- **O13 渲染层零测试**：`tests/` 只覆盖 electron 与 mirror 纯逻辑。`useFavorites` 回滚、`needsIcon`/`patchIcons` 合并、`sections` 分组、`readableError` 都是纯函数，成本极低。**S–M**
- ⚠️ **我原先那句「关闭类按钮有 取消/关闭/断开 三种 = 不一致」是错的，撤回**：核对后它们是三种职责 ——「取消」关确认框、「关闭」关信息框（`AppInfoDialog`）、「断开」是确认框里的**肯定动作**（`confirm-label="断开"`）。同屏不会出现两个都表示关掉的词，不该强行统一。
- **仍待你决定**："多设备不得静默降级"这条原则要不要落地（`ARCHITECTURE.md` §4 已把它标成目标而非现状）。
- 文档引用**改用符号锚点**（`waitForMdnsService`、`COVER_*`、`TEARDOWN_TIMEOUT_MS`…）：删代码会让行号集体漂移，2026-09-28 就漂了一次，换算时还发现两处**本来就错**的范围（`options.js` 的 bounds 常量、`mirror/session.js` 的调用入口）。新写条目请沿用符号锚点。

---

## 3. 镜像几何：裁切 / 铺满 / 黑边（症状已结案，只剩结构债）

**状态**（2026-09-28 用户口径）：**裁切症状的原因他已找到，这件事不需要再查**；根因**没有记进仓库**，本文与 `NATIVE_MIRROR.md` 都只有历史取证，别再据此重开调查。本节剩下的只是**结构性债务**（已收口的两条契约：显示像素单一主人 + `newDisplay` 必填，写进 `ARCHITECTURE.md` §4「刻意设计」）。

- **几何的两个主人**（这不算错，只是两套决策靠假设对齐）：主进程定窗口 bounds —— `electron/mirror/options.js` 的 `mirrorWindowBounds`（2026-09-29 起写死 850x600，不再按设备分辨率算，所以原来那组常量 `MIRROR_WINDOW_MAX_EDGE=1000` / `MARGIN=80` / `FALLBACK_RATIO=9/19.5` / 下限 320/280 已删），调用入口 `electron/mirror/session.js` 的 `startMirrorSession`；渲染层按窗口 CSS 算显示像素（`shared/scrcpyConfig.js` 的 `computeDisplayMetrics`）。两边靠「app 会铺满显示」这个服务端假设才不打架。
- **渲染层手写 letterbox**：`src/mirror/App.vue` 的 `syncCanvasBox`（min-scale + 取整 + `objectFit:'fill'`）重新实现了 CSS `object-fit: contain`；有 3 条触发路径（ResizeObserver / `sizeChanged` / `meta`）+ 「尺寸未知先拉伸、之后重贴」的两段式兜底。
- **遮罩/重排状态机约 90 行**：`src/mirror/App.vue` 的遮罩那一块（`armCover/endCover/coverForReflow/cancelCover/onFrameSizeChanged`、`reflowGate`、`aspectDiffers` 容差 0.02），只为盖住 resize 闪烁；`displayFollow.js` 的 `createReflowGate` 注释自陈是盖在早先「只看时间」的修复之上。建议收口成**只以 `reflowGate` 为单一判据**。**M**
- **未结的另一半**：`resizeDisplay` 不带 dpi，档位只在开会话时生效（中途换档就 1dp≠1CSSpx）。AndroMeld 的 resize 命令带 dpi（三个 int w/h/dpi），要跟就得**扩我们自己的协议** —— 那才能做到"窗口任意大也不掉清晰度/不漂移"。**M–L**
- 顺带的真实缺陷（正常窗口尺寸不触发）：上游 `NewDisplayCapture` 对 flex display 用 `Size.constrain(constraints, false)` **逐维裁剪**，越界时显示形状与窗口形状脱钩（5600x5600 → 比例 1.296）。这台机 h265 上限**短边 4320 / 长边 8192**，倍率 3 下窗口任一边 >~1440 CSS px 就越界。
- 未验：只有竖屏排版、没有宽布局的 app 在横形显示上会怎样；真机反馈后再决定要不要按包豁免（但注意 §4 的"仓库不留单 app 适配"）。**2026-09-29 起窗口固定 850x600（横屏），这从边角情况变成了默认形态**，优先级该往上提。

---

## 4. App / 包名特殊定制：**代码侧已清零**

- 抖音适配随 `081f110` 删干净；`NATIVE_MIRROR.md` 写明「仓库不留单 app 适配」。全仓（`src/` + `electron/` + `shared/`）**没有任何按包名 / 应用名 / 机型 / 厂商分支的可执行代码**。历史产生过的 `padMode.js`、`kickDisplaySize`、`relayout.js`、`frameProbe.js`、`tablet` 模式、按包豁免全部删除。
- 仅剩注释痕迹：`shared/scrcpyConfig.js` 的 `DISPLAY_QUALITY_TIERS` 注释（默认档位选 sharp 的理由是抖音顶部 tab 像素硬编码）、`electron/mirror/appSession.js:5-6`（引 MIUI `SecondaryDisplayLauncher` 行为）、`src/mirror/displayFollow.js:9`、测试 fixture 里的 `com.ss.android.ugc.aweme`。
- 仍在跑的**设备类别分支**（不算 app 定制，但属特殊处理，保留还是收敛需拍板）：跳过 `emulator-*` 有三处（`listConnectDevices` / `getConnectedDevice` / `resolveDeviceStableId` 附近）；`getConnectedDevice` 优先带 `:` 或 `._adb-tls-connect` 的无线 serial；设备网络信息里优先 `wlan` 网卡；设备名读 `ro.product.marketname`（小米口味）。
- `debug.anddrive.vd.isr` 是留作 A/B 的逃生口，**既定接口，别动**。

---

## 5. 轮询 / 定时 / 调度（15 处）+ 死代码（X 组）

### 5.1 轮询与定时器

**主进程**

| 位置 | 周期 | 做什么 | 判断 |
| --- | --- | --- | --- |
| `electron/mdns.js` 的 `QUERY_INTERVAL_MS` | 1000ms | PTR 重查，且 `adb.js` 的 `ensureConnectBrowser` 起的 browser **没有 stop 路径** | **该修**：常驻 1s 组播 + UDP socket 只换一个 TXT 字段（= **D9**） |
| `electron/adb.js` 的 `waitForMdnsService` | 1000ms | 轮询 `adb mdns services`；函数末尾那句 `return new Promise(() => null)` 就是**永不 settle 的取消语义** | **该修**：改事件驱动；取消要 reject 明确的"已取消" |
| `electron/adb.js` 的 `STATS_CACHE_TTL_MS` + `getDeviceStats` | 30s TTL | 设备统计缓存，与渲染层 1s 轮询叠成两层节流 | 与 HUD 那条一起收口 |
| `electron/main.js` 的 `TEARDOWN_TIMEOUT_MS` | 3s | `TEARDOWN_TIMEOUT_MS` 与 `runDeviceTeardown` 赛跑 | 保留（退出兜底） |
| `electron/main.js` 的 dev 孤儿看门狗（查 `process.ppid === 1`） | 1000ms | dev-only `ppid===1` 孤儿看门狗 | 保留（dev 专用） |
| `electron/permissions.js:113` | 2000ms | `dns-sd` 探测「假设已授权」兜底 | 保留，但文案要说明是推测 |

**渲染层**

| 位置 | 周期 | 做什么 | 判断 |
| --- | --- | --- | --- |
| `src/App.vue` 顶部的 `*_INTERVAL_MS` 三个常量 | 1s / 5s / 3s×10 | 发现 / 心跳 / 重连三个魔数 | 至少提成常量组；`healthLoop` 里切设备时 `continue` **不 sleep 就重查**，有 busy-spin 风险 → **该修** |
| `src/App.vue` 的 `discoverLoop` | 1s | `discoverLoop` 被 **4 个调用点**重启（`connect` / `handleConnectionLost` / `startRecovery` / `disconnect`） | 收成单入口 |
| `src/composables/useScrcpySessions.js` 的 `POLL_INTERVAL_MS` | 2000ms | 会话列表轮询 | **三条状态类轮询合成一条主进程事件推送** |
| `src/mirror/direct-session.js` 的 `watchAppStolen` | 2500ms | `watchAppStolen` → 每次设备侧 `dumpsys window \| grep -A4 \| grep -oE`（`adb.js` 的 `getAppTask`） | = **D8**：改成 focus / `visibilitychange` 时查一次；`decoder.sizeChanged` 是免费事件源 |
| `src/mirror/direct-session.js` 的 `waitForDisplayId` / `ensureAppHere` | 100ms×1500ms / 4×400ms | `waitForDisplayId`、`ensureAppHere` 重试环 | 补的是 `startSession` 从 server stdout 正则捞 displayId 的脆弱解析；服务端把 displayId 传出来就能一起删 |
| `src/mirror/App.vue` 的 `statsTimer` | 1000ms | HUD 统计轮询，**dev 专用却在正式包里照跑** | 加 `showHud` 守卫（dev 才需要 HUD） |
| `src/mirror/App.vue` 的 `COVER_*` 常量与 `showNotice` | 420/3000/80/150/2400ms | 遮罩状态机 + 提示自消 | 见 §3，随遮罩收口一起简化 |
| `src/mirror/displayFollow.js:23,117` | 250ms | **debounce，刻意设计 + 有单测** | **别当轮询删**（理由见 `ARCHITECTURE.md` §4） |
| `src/mirror/audio.js:8-10,74-75,142` | 0.08/0.4/0.03s | 音频排程余量、队列阈值 120 | 保留 |
| `AppList.vue:35-39` | 20 / 3 / 7天 | 图标批次与并发 | 快照串行锁 + 图标落盘后，一批不再改快照；剩 O5 的渲染重排成本 |

> 顺带纠正一处误记：代码里**唯一的「90」是 `adb.js` 的 `CACHE_MAX_AGE_MS = 90 天`**（应用快照过期），不存在 90s 冷却。

### 5.2 X 组：死代码清理

**仍然开着的**（要么不是零调用，要么删/改会动到行为或结构，所以不能当死码删）：

- `src/api/index.js` — 约 40 个一行透传壳，纯重复 preload 命名。删层或删壳，二选一。**M**
- `ConfirmDialog.vue` 的 `cancel` 与 `close` 两个 emit 行为相同，调用点还都绑一样（`AppList.vue`、`PageHeader.vue`）。**S**
- `src/mirror/displayFollow.js` 的 `lastSentKey` getter（只有测试用）；`src/mirror/session.js` 是 8 个 handler 1:1 的转发壳 → **并进 `direct-session.js`**；`electron/mirror/appSession.js` 单调用方 → 可内联。**M**
- 重复校验：serial/package 合法性在 `adb.js`、`shortcutCore.js`、`favorites.js`、`mirror/session.js` 各写一遍（package 一处正则、一处只判长度）。IPC 边界已校验，内部再校验属冗余 → 收成一个 `validators.js`。**S–M**
- 空 catch 吞异常（对照 `ARCHITECTURE.md` §4 的分寸）：`adb.js` 两处、`iconImage.js` 的 `composeMacosIconPng`、`favorites.js` 的写盘回滚分支、`direct-session.js` 四处（含一处双层嵌套全吞）。**S**
- 目录名与版本号的漂移：缓存目录仍叫 `apps-v1`，版本常量已是 `CACHE_VERSION = 2`。**已复核不致命**（读写同一常量，不会每次启动作废），只是名字骗人。**S**
- `adb.js` 的 `adbExecSafe` + `splitCallOptions`：靠嗅探 `args[0]` 是不是配置对象来区分调用形式，守的全是内部调用点。**S**

### 5.3 会话归属与跨层混淆（改动要谨慎）

- 两套「session」概念撞车：`useScrcpySessions`（主进程窗口注册表，UI 轮询）vs `direct-session.js` 的 `current`（每窗口 scrcpy 客户端）。
- 字段所有权倒挂：`electron/mirror/session.js` 的 `mirrorState` 上报把 codec / hasAudio 这些**渲染层拥有**的字段存进主进程记录；`startMirrorSession` 的复用与新起两条路径返回**不同形状**（一条带 `reused` 与快照字段，一条只带 id/serial/packageName/label/startedAt）。
- 状态双份：同文件的 `pendingInit` 同时下发原始 `config` 与主进程派生的 `prefs`，渲染层再规范化一遍（`options.js` 的 `normalizeScrcpyConfig` / `resolveNativeCodec` / `resolveRuntimePrefs`）；`turnScreenOff` 主进程决策、渲染层发控制消息执行。
- 通道命名说谎：`mirror:appTask` / `mirror:moveTask` 注册在 `adb.js` 末尾的 `ipcMain.handle` 那一段（`mirrorAppTask` / `mirrorMoveTask`）。
- 设备状态编排由渲染层定时器驱动（`direct-session.js` 的 `reclaimApp` + `watchAppStolen`）。搬回应用一律用 `am display move-stack`，**绝不 force-stop**。

---

## 6. 功能点子（按是否需要授权分组）

### 6.1 只用 adb / shell uid，不需要用户点头（性价比最高）

| # | 功能 | 可行性依据 | 规模 | 对应 |
| --- | --- | --- | --- | --- |
| F1 | 一键截图到 Mac（同时进剪贴板） | `exec-out` 通道仓库已在用，`screencap -p` 无需权限 | S | P2-3 |
| F2 | 文件互传（拖拽 push/pull + 进度） | `adb pull` 已用于导 APK；进度按字节算，别解析 pull 的 stderr | M | P2-2 |
| F3 | APK 拖拽批量安装 | 安装链路已跑通（`install -r`） | S–M | P2-1 |
| F4 | ~~镜像里的系统动作键（返回/Home/多任务/音量/电源）~~ | **已结案，2026-09-28 整套删除**（编号保留不重排，见 §8）。原 `D2/B2` 一并关闭 | — | — |
| F5 | 应用元信息增强：标注「固定竖屏 / 不可调整」 | helper 自己拼 JSON，加字段便宜（`helper-app/.../ListMain.java` 的类注释是契约）。正好解释用户常问的"为什么这个 app 投出来中间一条" | S–M | — |
| F6 | 权限 / appops 面板 | shell uid 有这些权限；MIUI/HyperOS 可能拦，要按 OEM 分支并给失败出口 | S–M | — |
| F7 | 「把手机带到无线调试二维码页」 | helper 里的 `QrPairActivity`（manifest `:11`）**Mac 侧从来没调用过**；已连接时一条 `am start` 就够。适合放进"添加第二台设备 / 无线调试失效"两个入口 | S | P3-5 |
| F8 | logcat 面板 + 崩溃过滤 + 导出 | `adb logcat` 流式；面板关闭要杀进程（复用 `runDeviceTeardown` 钩子） | M | P2-6 |
| F9 | 音频-only / 反向转发 | `adb reverse/forward` 是 shell 级；纯音频只需放开 `options.js` 写死的 `video: true` | S | — |
| F10 | 存储面板 + Finder 挂载（**可写**） `[x]` | **已落地**（2026-09-29）：`shared/storageVolumes.js` 按卷建模（内部存储 / 可移动卡 / 根目录），入口是设备名后第二个图标，设备信息弹层里的存储两行随之删除。挂载 = 本地 WebDAV（`electron/webdav.js` + `devfs.js`）挂到 `~/Volumes/<设备> <卷>`，走 `mount_webdav`，**只读**；面板是**三格横排**（相机 / 内部存储 / 根目录，相机是从内部存储派生的 `DCIM` 目录、不是卷），未挂载给「挂载」，已挂载给「打开 + 取消挂载」 | — | P2-? |

**F10 当初的两条路（2026-09-29 选了 B1 并已落地；B2 仍然是唯一能拿到"原生 Finder 观感"的路，留档）**

AndroMeld 那套「挂载」不是 adb 命令，也不是 FUSE：随包 `Contents/PlugIns/AndDriveFileProvider.appex`
（bundle id `com.catchingnow.andfiles.fileproviderextension`，`NSExtensionPointIdentifier =
com.apple.fileprovider-nonui`）是个 **macOS FileProvider 扩展**，「挂载/弹出/打开」=
向 `NSFileProviderDomain` 注册/注销一个 Finder 卷。词表能对上：`mount.segment.{camera,sd_card,root}`、
`mount.control.{mount,eject}`、`mount.action.{register,refresh,remove}`、
`app_state.no_finder_mount`。所以要"抄"它，抄的是扩展，不是命令。

- **B1 本地 WebDAV + `mount_webdav`（推荐，Electron 里能做完）**：主进程用 `@yume-chan/adb` 起一个
  只监听 127.0.0.1 的 WebDAV，再 `mount_webdav` 挂到 `/Volumes/…`，弹出用 `diskutil eject`。
  不需要 appex、不需要额外安装、不需要 entitlement；顺带把 F2 文件互传的读写底座一起拿到。
  代价：Finder 侧缓存与增量得自己做对，根目录在 shell uid 下只能读到全局可读的那部分（本机实测
  `ls /` 可列、`ls /data` 拒绝），要读全得走 root。
- **B2 原生 FileProvider appex（等价于 AndroMeld）**：Finder 观感最好（原生图标、缩略图、增量），
  但要新增 Swift 扩展 target、签名 entitlement、`electron-builder` 嵌 `PlugIns/`、扩展与主进程 IPC。
  按多天算，且和现在的打包链路冲突。

**容量口径（2026-09-29 与竞品逐位对齐，别再改回去）**

采集只有一条路：helper 的 `StorageMain`（`app_process`，shell uid）→ `shared/storageVolumes.js` 建模。
内部卷的总容量**不走 StatFs**，走 `IStorageStatsManager.getTotalBytes(null, "com.android.shell")`
= 528,000,000,000；可用量走 `StatFs(path).getAvailableBytes()`；已用 = 总 − 可用 = 255.8 GB → 48%。
这三个数与竞品在同一台机器上的读数逐位相同，也和手机设置一致。

踩过的三个坑，别再踩：

1. **`df -k` / `stat -f`（= Java `StatFs`）/ `dumpsys diskstats` 三者完全一致，但都是文件系统容量**
   （这台机 512.4 GB），比设置页少 ~15.6 GB 保留区 —— 拿它当"总共"就会永远和手机设置对不上。
   显示侧另外还有一处：必须按 **1000 进制**（`src/utils/format.js` 的 `formatStorage`），
   按 1024 进制会把 512 GB 的机器显示成 477 GB。内存仍按 1024（`formatBytes`）。
2. **`StorageManager.UUID_DEFAULT` 原样送进服务会抛 `Failed to find storage device for UUID 41217664-…`**，
   传 **null** 才落到默认卷（实测 null → 528000000000）。
3. **app_process 里造不出 shell 包上下文**：`createPackageContext("com.android.shell", IGNORE_SECURITY)`
   拿到的 `getOpPackageName()` 仍是 `"android"`（竞品用 `getSystemService` + 这个上下文能过，我们不行），
   所以直接打 binder、把 `callingPackage` 显式传成 `com.android.shell`（uid 2000 与它自洽，服务侧
   `watchUid` 才不报错）。方法按名字找，不绑版本。

`VolumeInfo` 常量：TYPE_PUBLIC=0 / TYPE_PRIVATE=1 / TYPE_EMULATED=2；**内部卷 = type 2 且 id 以
`emulated` 开头**，TYPE_PRIVATE 只是它的底层挂载点，不单独列行。竞品那条**分段用量条**的数据源是
它 helper 的 `apps` 命令（逐包 `StorageStatsManager.queryStatsForPackage` 累加 app/data/cache），
不是一次调用能拿到的。

**挂载落地后的实测与边界（2026-09-29，同一台 2509FPN0BC 无线 adb）**

- 挂载 0.4s、列一层目录 0.5s、经挂载点读 2.6 MB 文件 1.3s 且**字节与 `adb exec-out cat` 完全一致**；
  一次「挂载 + 列根 + 读一个文件」总共只有 13 个 HTTP 请求（macOS 不会把它拆成海量小请求）。
- `mount_webdav` 允许普通用户挂到**任意自有目录**，所以挂载点放 `~/Volumes/`；
  `/Volumes` 建目录要管理员，别往那儿写。
- **可写**（2026-09-29）：PUT/MKCOL/DELETE/MOVE/COPY 已落地，真机验收过 —— 2.6 MB 二进制经挂载点
  写进手机后 **sha256 与本机完全一致**，改名与删除也生效。写用 `adb push`（先落本机临时文件）：
  **不能走 `adb shell "cat > 文件"`**，那条经过 pty 会改坏二进制；这版 adb 的 `push` 又不吃 stdin。
- ⚠️ **必须是 WebDAV Class 2（会答 `LOCK`）才可写**：`man 8 mount_webdav` 写明连 Class 1 服务器时
  即使没要求也会强制 `rdonly`。锁只是记账（同一路径给个 opaque token，UNLOCK 幂等回 204），
  不做并发强制。`dav` / `ms-author-via` 头**每个响应都要带**，漏一次 `mount_webdav` 就静默挂不上
  且不报错（踩过）。
- 访达自造的 `.DS_Store` / `._xxx` / `.Spotlight-V100` 一律**吞掉**（回成功但不落手机），
  所以从 Mac 往卷里 `touch .DS_Store` 会看到 EPERM —— 这是预期。
- 媒体扫描**不用我们做**：实测 `cp` 进 DCIM/Camera 的照片立刻能 `content query` 查到（Android 16
  的 FUSE 自己通知 MediaProvider），广播是多余的。
- 按卷决定可写：`/`（根目录卷）在 Android 上是只读文件系统（实测 `touch /x` → Read-only file system），
  所以 `readOnly` 挂在 adapter 上，面板那格标「只读」。
- **热路径走 adb sync 长连接**（2026-09-29）：`electron/devfs.js` 用 `@yume-chan/adb-server-node-tcp`
  建一条 per-serial 的 `Adb` 连接，列目录/取属性/读/写全跑 `adb.sync`（它自带 socket 池）。
  实测（同一台机、无线 adb）：`createAdb` 11ms（spawn 一次 adb ≈ 300ms）、895 项目录 readdir 111ms
  （shell `stat -c` 200–360ms）、RECV 2.6MB 208ms（`exec-out cat` 1.3s）。设备断开时连接随
  `onDeviceTeardown` 一起关掉。
  - ⚠️ **必须显式传 `compression: 0`（None）**：`@yume-chan/adb` 的 `chooseFormat` 在设备支持时会自动升到
    **Zstd**，而这一跳是本机 adb server、根本不过网络，压缩纯属倒贴 —— 实测写 2.6 MB 自动档 **4.4s**，
    关掉后 **433ms**。那个枚举没从包导出，值取自 AOSP `file_sync_protocol.h`（None=0/Brotli=2/Lz4=3/Zstd=4），
    改的时候别按名字去找。
  - sync 没有对应操作的（带偏移的读、`mkdir/rm/mv/cp`）也走**同一条连接上的 `exec:`**
    （`adb.subprocess.noneProtocol`，不分配 pty 所以二进制安全；但仍经设备侧 `sh -c`，参数必须自己引）。
    全文件读与元数据操作已经不再 spawn adb 进程。
- **开文件慢的两次真因（2026-09-29 实测，别再照直觉改）**：
  1. 带 Range 的读原先用 `tail -c +N`：设备侧要 350–830ms。换成
     `toybox dd if=<f> bs=1M iflag=skip_bytes,count_bytes skip=<字节> count=<字节>` 后是 100–150ms，
     **字节精确**且不用本机截断（`openDeviceFile` 第三个参数就是长度）。
  2. 访达每打开一个文件会**逐层 PROPFIND 解析路径**（实测一次开视频 12 次）。加了
     `createTtlCache`（stat 与目录清单，TTL 2s，按 serial 隔离，写操作精确失效"自身+内容+父目录清单"）：
     同样 12 次查询冷 395ms → 热 **20ms**；新建文件后立刻列父目录仍然看得见（失效路径真机验过）。
  合起来：开视频那三步（PROPFIND + 头 1MB + 尾 1MB）现在 **674ms**，其中大头是尾块 1MB 的传输本身。
- **窗大小按"访问形状"分两档，大窗在背后补**（2026-09-29 改，`planWindowFetch` + `prefetchWindow`）：
  未命中时同步只取 `max(请求长度, 256 KB)`；只有这次请求**正好接在上一窗尾部**（播放/拷贝的形状）
  才按 2 MB 档取，并立刻在背后把它补满 8 MB 大窗。
  - ⚠️ 旧规则"不管请求多小都按 2 MB 起取"是给图片夹造的祸：访达要缩略图就是每个文件读文件头
    100–230 KB，一开文件夹就是几十个文件各拉 2 MB。**同轮 A/B（2509FPN0BC 无线，24 张 12 MB 照片
    并发 6 路各读 128 KB）：旧规则墙钟 4175ms（单张平均 823ms）→ 新规则 649ms（平均 129ms）**。
  - 顺序读不能跟着缩小（实测同一串 40×64 KB：小窗档 800ms，2 MB 档 350ms）—— 所以要分两档，
    不是把下限一刀调小。
  - **别把大窗算进用户正在等的那一块**：把"顺序读就同步取 8 MB"写成这样，播放式读从 350ms
    劣化到 900ms（8 MB 的传输全算在第二个 64 KB 请求上）。补窗必须放背后。
  - ② 未命中时只取被要求的 64 KB 也太慢（整窗落地前每个分块各自往返一次）—— 这条仍然成立。
  - ① **"背后预取整窗更慢"作废，别当结论用**：那组数是带着下面 `storeWindow` 那个守卫 bug 量的
    （换偏移量的新窗被旧窗挡下，取回来的整块直接丢掉），所以它测的是"白取"而不是"预取抢链路"。
    现在后台补窗是正常路径，别再拿那条旧结论否它。
- ⚠️ **"要不要整份留在本地"必须按真被取走的字节算，不能按请求长度算**（2026-09-29 修）：
  访达对每个文件都发一条"从这个偏移一直到文件尾"的读、实际只要前几百 KB 就收手；按请求长度累计时
  相册里每张 12 MB 照片都被判定成"值得物化"，于是每张白拉一整份。现在由 `noteServed` 只累计
  窗口真正交出去的字节，流式路径（客户端本来就在整份读）根本不触发物化。
- ⚠️ **缓存条目随时可能消失，两条崩溃路径（2026-09-29 修，都是能把主进程带崩的）**：
  1. `fileCache.read` 原来直接 `createReadStream(path)`，而它是**延后开文件**的：条目正当中被
     LRU 淘汰或 `invalidatePath` 删掉，就会抛一个没人监听的 ENOENT。现在先 `await open()` 拿到
     FileHandle 再交流，打不开就返回 null（调用方正好按"本地没有"走设备侧）。
  2. 任何一路读流报错都不能没人接：`webdav.sendFile` 现在 `stream.on('error', () => res.destroy())`。
     `pipe` 不转发源头的 error，没监听就是未捕获异常（回归测试：删掉那句就红）。
- ⚠️ **别拿这台机器的绝对毫秒当结论**：无线 adb 吞吐抖得厉害，同一个"从头读 2 MB"在不同轮次
  量到 446 / 471 / 723 / 2808 ms。可信的是**同轮内的相对量**（窗内请求 0–1ms vs 窗前 100–350ms、
  40 次逐条目属性 13ms vs 冷 440ms+）。要判绝对性能得换 USB 或让用户体感定。
- 命中窗口时响应直接 `res.end(buffer)`，不要走 `stream.pipe(res)`：数据已在内存，走一遍流
  每次多 ~70ms（实测）。
- ⚠️ **`storeWindow` 的"别拿小窗盖大窗"必须同时比 `start`**（2026-09-29 修）：写成只比长度时，
  换偏移量的新窗会被旧窗挡下 —— 越过第一窗之后每个请求都重取一整块又被丢弃，且完全没症状
  （数据是对的，只是慢）。实测播放式 5MB：修前 **14.5s（0.3 MB/s）**，修后 **1.0s（4.9 MB/s）**。
  存放规则已拆成 `electron/readWindow.js` 并带回归测试（把守卫改回只比长度，测试立刻红）。
- **内容缓存 = 抄 Sideport 的物化**（`electron/fileCache.js`，2026-09-29）：第一次读某个文件时
  除了把要的那段给它，还在背后把整份拉到 `userData/file-cache/`；之后所有读（含拖进度条的随机
  seek）走本地盘。真机实测（12 MB 的 jpg）：首读 4 MB **560ms** 并触发物化，等它落地后尾段 1 MB
  **22ms**。键里带 `size + mtime`，所以手机侧改过的文件自动落到新键，不需要"检测变更"。
  上限：单文件 2 GB（`MATERIALIZE_MAX_BYTES`）、整盘 4 GB（按 atime LRU 淘汰）。
  - ⚠️ **之前记的那组"2ms / 9ms"不成立**：`fileCache.materialize` 要的 fetch 是**解析成 Buffer**，
    而 `devfs` 交上去的是 `{ stream, close }`，`sink.write` 收到对象当场抛错被 catch 吞掉 →
    物化在产品里一次都没成功过，缓存目录永远是空的。契约改动必须两边对齐（现已统一为 Buffer）。
  - ⚠️ **写入端要按需创建，清理要先等 `'close'` 再 `unlink`**：`createWriteStream` 是**延后开文件**的，
    一字节没写就 `destroy()` + `unlink()` 会删在 open 之前，实测留下永远清不掉的 `.part`（堆在缓存目录
    里就是白白占预算）。现在第一轮就在让路的话连文件都不开。
  - 让路是有代价的：258 MB 的视频按 `2MB 块 + 块间歇 800ms` 物化，实测只跑到 ~1.8 MB/s，
    整份要几分钟。这是"不和播放抢链路"换来的，不是 bug。
  物化的让路判据必须是**"这个文件最近没被读"**（`waitForFileIdle`，4 秒），不是"链路当前空闲"：
  窗内命中是 0ms，播放时链路永远看着是空的，判据写错就会让后台拷贝和播放抢同一条 8 MB/s。
  另抄两条：**同时在飞的设备操作限 6**（`MAX_CONCURRENT_DEVICE_OPS`，不限会排队堵死自己）；
  元数据操作改走 **`shell,v2,raw:`**（stdout/stderr 分开 + 真退出码，不再靠"有输出即失败"猜），
  老设备自动退回 `exec:`。
- ⚠️ **窗下限那条改完用户仍然说慢**（2026-09-29），真正的量级在下一条的"取一段要几次往返"上：
  缩略图是整份读，文件又小，固定开销比带宽先到。别只盯着窗大小。
- **图片夹真正慢的原因（2026-09-29 用挂载点实测，别再按"请求数"猜）**：`mount_webdav` 要缩略图时
  发的是**整份文件**一条 Range（实测 `bytes=0-<size-1>`，几十 KB 到 12 MB 都整份），所以每个文件
  都要走完一次传输，代价 = 文件大小 ÷ 链路速率 + **一次设备往返**。于是瓶颈落在"取一段要几次往返"上：
  - `toybox dd` 要**在设备上 spawn 进程**，100–400 KB 的小文件实测串行 **131ms/个**；同一个文件
    用 sync RECV（读够 `want` 就取消整条 RECV）只要 **45ms/个**。⚠️ `adb.sync.read(path)` 那个 API
    是**懒的**（实测 1ms 就 resolve，215MB 的文件也是），别拿它当"读完整份"。
  - 所以 `fetchBytes` 现在按偏移量分原语：**`start === 0` 一律 sync RECV**，只有从中间偏移取才 `dd`
    （RECV 不支持偏移）。并发 6 路整份读 12 张小图的 A/B：**dd 平均 26–28ms/张 → RECV 17–19ms/张**。
  - 经挂载点整份读小图（冷，无内核缓存）：**改前 104–266ms/张 → 改后 32ms/张**。
- ⚠️ **访达自己造的 `._xxx` / `.DS_Store` / `.Spotlight-V100` 这些名字，读也不要去问设备**
  （2026-09-29）：它们我们从不真写到手机上（MUTATORS 里早就吞掉写），所以答案必然是 404；
  690 项的相机夹一次打开能多跑几百次 `sync.stat`。现在 `webdav` 在进设备前直接回 404（有回归测试，
  断言"只有真文件被问过设备"）。副作用：手机上**真的**叫 `._foo` 的文件在卷里打不开（列表里还在），
  为了几百次往返换掉这个几乎不存在的形状，判定划算。
- 天花板记在这里，别去找包：**无线 adb 实测上限 ~8 MB/s**（`dd if=/dev/zero` 32MB 走 adb 4.16s），
  而手机读自己的文件是 2.4 GB/s。所以首读慢是链路，不是代码；能做的只有"少读几次"（窗口 + 物化）
  或换 USB。Sideport / AndroMeld 也没有更快，它们靠 FileProvider 让 macOS 替它们做同一件物化。
  - 写也不再落本机临时文件（sync SEND 全程流式），之前"大文件双写本机磁盘"这条缺点已消。
- 生命周期：`before-quit` 与设备断开都会先 `umount` 再关服务，否则访达上会留一个点开就报错的死卷。
  应用崩溃是留死卷的 —— 目前没有开机回收。
- **卷名能改到哪一步（2026-09-29 逐个试过）**：挂载点目录名、访达窗口标题、桌面磁盘图标都是
  `Xiaomi 17 Pro Max 相机存储`（卷的显示名改了这里就跟着改，见 `shared/storageVolumes.js` 的 label）；
  但**侧栏「位置」那一行固定显示 URL 主机名 `127.0.0.1`**，试过
  PROPFIND 的 `displayname` 与 `mount_webdav -v <name>` 都改不动它（两处仍保留：`-v` 让挂载点撞名
  带 ` 2` 后缀时卷名依旧干净，displayname 给非 webdavfs 客户端看）。换成可读主机名是唯一能改侧栏的
  路子，但要么写 `/etc/hosts`（要管理员），要么用一个不存在的 `.local` 名（实测 `mount_webdav`
  直接挂住不返回）。**要在侧栏也显示 app 名，只能走 B2 的 FileProvider 扩展** —— AndroMeld 侧栏
  那个 `AndroMeld - 2509FPN0BC` 就是这么来的。
- ⚠️ **卸载后的挂载点只允许 `rmdir`（空目录才删得掉），绝不能递归删**：`umount` 失败时目录里那些
  文件其实还在手机上，递归删等于删用户设备数据。三格同时挂载已实测（相机 15 项 / 内部 16 项 / 根 31 项）。
- **图片夹剩下的那部分开销（已知，未做）**：访达要缩略图时对每个文件都发一条
  "从这个偏移一直到文件尾"的读，而且**偏移会往回重叠**（实测一张 12 MB 照片要 3–5 条这样的读）。
  大窗只覆盖 ≤ 8 MB 的请求，所以大于 8 MB 的文件每条都单独起一次设备侧 `dd`，重叠的那截白拉一遍。
  真正的解法是**按偏移记账的稀疏物化**（把已经流过给客户端的字节顺手落进 `.part`，缺口事后再补），
  现在不做是因为最狠的那条（2 MB 下限 = 16 倍放大）已经单独改掉了，剩下的重叠只是常数倍。

### 6.2 需要 helper 变厚（先决策：helper 定位是「零权限、零后台组件的代码容器」）

| # | 功能 | 卡点 | 规模 |
| --- | --- | --- | --- |
| G1 | Mac 中文输入法直投 | `ime enable/set` shell 合法，但 helper 得提供 `InputMethodService`，且**会临时顶掉用户键盘**，会话结束必须还原；打破 helper 定位 | M |
| G2 | 通知同步到 Mac + 回复 + 验证码复制 | adb 走不到，需真 `NotificationListenerService` + 用户手动开一次开关。可以不做弹权限，但要做"一键跳到那个开关" | M–L |
| G3 | 剪贴板双向同步 —— **已放弃，见 §8** | 若重启：正解是 helper 出借前台焦点的 `ReadClipboardActivity`，用广播里带的 Binder 回传（参照 app 就这么做，日志 tag 还叫 `AndDriveReadClipboard`） | M–L |

### 6.3 差异化（AndroMeld 没有的）

- **H1 专注投屏**：镜像开着时自动静音 Mac 通知（DND API）+ 设备侧免打扰，结束自动恢复。对"投屏看视频/演示"是实打实的体验差。
- **H2 菜单栏常驻会话**：把当前会话放进 macOS 菜单栏（`Tray`），一键聚焦/关闭/接回（接回逻辑已有）。和已做好的 ⌘Q 语义（`electron/menu.js`）是一套。
- **H3 「工作台」预设**：多块镜像的窗口位置/尺寸/应用存成布局一键恢复（`mirrorWindowBounds` 已算好初始尺寸，缺持久化与恢复）。
- **H4 Presenter 模式**：只推画面、Mac 侧当遥控器（翻页/音量/播放暂停原本要走 F4 动作键，**F4 已删** → 这条得改为直接给 Tango `injectKeyCode` 注入具体键值，不再恢复 `kind:'action'` 那层），配合已有的全屏启动 —— 手机当演示笔。
- **H5 软键盘策略**：`displayImePolicy` 我们现在完全忽略（`options.js` 未映射）。加开关避免"投屏时手机弹键盘占半屏"。
- **H6 使用时长本地统计**：`dumpsys usagestats` shell 可读，首页给"今天最常用"，并给 MRU 排序（P1-4）提供真实数据源。
- **H7 镜像画面标注/截图卡片**：截一帧连应用名+时间戳存成卡片（截图见 F1，图标能力已在 `iconImage.js`），做"今天在手机上看过的东西"留痕。

---

## 7. 路线图剩余项（原 P0–P3，已完成的不再列）

| # | 项 | 状态与备注 |
| --- | --- | --- |
| P0-3 | 操作进行态与进度反馈 | Helper 安装/升级分阶段、图标补取 `已完成/总数`、禁用重复触发并暴露取消重试 |
| P0-4 | 设置持久化 | 上次设备 serial、scrcpy 默认参数、**窗口几何**、自动重连开关 |
| P0-5 | 列表刷新与失败重试 | 刷新入口、图标批次指数退避（当前失败只记录）、区分「无应用」与「读取失败」空态 |
| P0-6 | 测试与 CI | = O12 + O13 |
| P1-1 | 搜索/排序 | 拼音首字母搜索、名称/安装时间排序、MRU（依赖 P1-4）。注意现状**根本没有 MRU**（`ARCHITECTURE.md` §3） |
| P1-4 | MRU 跨会话持久化 | 按设备记录最近启动 + 上限淘汰 + 损坏降级为空；数据源可用 H6 |
| P2-4 | 快捷键与命令面板 | ⌘K 面板、⌘R 刷新、⌘, 设置、Esc 关闭 |
| P2-5 | 分组、标签与隐藏 | 自定义分组/标签/隐藏/显示名，本地持久化 |
| P3-1 | 多设备支持 | **待决策**，与"单设备优先"冲突；建议默认单设备 + 显式进入多设备模式。动手前先补 §1 那条 **D7 的真机验证**（多台同时广播的命名） |
| P3-2 | 记忆设备与启动自动重连 | 启动读上次 serial → mDNS 解析 → connect → 直接进首页。同样卡在 D7 的真机验证；冷启动时别名表还没建立，解析要能容错 |
| P3-3 | 自动更新与提示 | 自签名 + 非公证，`electron-updater` 需适配；建议先做"更新提示 + 手动安装" |
| P3-4 | 深色模式与 i18n | = O7 + 文案抽离 |
| P3-5 | 新手引导与帮助 | 首次启动分步引导（开无线调试 → 扫码 → 浏览/启动）；F7 是它的廉价前半 |
| 镜像 P1 | 指针习惯 | 右键→返回、中键→主屏（操作栏已删，鼠标侧手势是主要入口）；多指/捏合（`pointerId` 现在固定 0） |
| 镜像 P2 | 截图保存、会话列表增强（重开/置顶）、窗口尺寸记忆、断线自动重连（复用 `adb.js` 重连逻辑） | |
| 镜像 P3 | AV1 验证并移出回落名单、控制错误可见性（现仅 `console.warn`）、消费 `client.output` 把 scrcpy 报错并入异常退出提示、设备侧旋转剩余观感（`--no-vd-system-decorations` 或把启动应用放服务端侧） | |

**里程碑**：M1 = P0 全（反馈/重连已交，剩进度/持久化/CI）；M2 = P1 全；M3 = P2 全；M4 = P3 全（多设备与自动更新不确定性最高）。
**风险**：OEM ROM 差异（保持解析容错、留原始 stderr）、自签名分发限制（更新走手动）、scrcpy 进程泄漏（会话集中管理 + 退出统一 teardown）、多设备并发写缓存（已按稳定标识隔离 + 原子写，可复用）。

---

## 8. 已结案 / 明确不做（避免反复讨论）

- **抖音直播「上下裁」= 镜像侧无解**：裁切发生在抖音内部（播放器 cover 稳态），与显示几何、虚拟性、ISR 无关。必要且充分变量是 `ro.build.characteristics` 含 tablet；改 prop 必须配 `pm clear` 重注册。品牌分发已逆向（小米/Redmi 看 characteristics+isMiui、vivo 看 `FtDeviceInfo`、OPPO 看 feature、其他品牌看 characteristics &&（`screenLayout≥large` 或 xdpi 对角线 ≥7.0″），结果缓存 Keva）；折叠屏走 `FoldIdentifyUtils` **完全不读 characteristics**。非 root 判死（`ro.*`/`persist.sys.*` 是 `system_prop`，adb shell uid 2000 写不动）。唯一出路是换信源（平板 AVD / 真平板 / 折叠机，均已实测同一条 AndDrive 链路版式天然正常）。取证链全文见 `NATIVE_MIRROR.md` §2026-09-27~28。
- **系统动作键那套能力已整体删除（2026-09-28，B2/D2/F4 结案）**：返回 / Home / 多任务 / 音量 / 电源、旋转、通知栏、以及 `kind:'action'` 消息通道 —— 按决策**不要**，代码已清空，**别再提"接线"**。删除范围：`electron/mirror/control.js` 的 `TAP_ACTIONS` + `applyAction` + `case 'action'`（连带 `KEY_CODES` 再导出）、`shared/keys.js` 里只为它服务的五个键值别名（home / appSwitch / power / volumeUp / volumeDown）。（当时还在的「启动后息屏」走的是另一支直调 Tango `setDisplayPower(false)`，2026-09-29 随屏幕策略一起删除。）回归测试已改成断言 `kind:'action'` 现在抛「未知控制消息」。若将来要做鼠标手势（NATIVE_MIRROR §P1 那条仍然开放），直接给 `controller.injectKeyCode` 传官方键值，不要恢复这层抽象。
- **黑边的变量不是比例，是 Android 的 600dp 大屏门槛**（`smallestWidth ≥ 600dp` 时系统忽略 app 方向锁并 letterbox）。比例吸附、600dp dpi 下限、`tablet` 模式、`MAX_DISPLAY_PIXELS` 都已试过并删除。
- **模糊遮罩挡不住重排闪烁**（透明度低于 ~95% 就看得见），现方案是不透明遮罩 + 等关键帧。
- **`force-stop` 不是"把应用接回来"**：会冷启。正确做法 `am display move-stack`（真机验证 pid 不变）。「重新启动」按钮当天加了又删 —— 和"接回"并排会误点。
- **剪贴板同步 G3 = 已放弃**：服务端写完同进程回读拿到 `null`，这一条判据分不清「读被挡」与「写没落地」，**不足以下"ROM 挡剪贴板"的结论**（曾据此断言过，被驳回，记录在此免得重犯）。也别动 appop（`READ_CLIPBOARD` 本来就 allow）。
- **采集别人的虚拟显示可以，resize 与销毁不行**（`VirtualDisplay` 与创建它的进程绑死）。多窗口共览一块显示需要一个常驻持有者，这一档暂不做。
- **不要用 `audioDup`**（会让手机出声，与"投屏时手机静音"的要求相反）。
- **`wm size` / `wm density` 改物理屏、compat 强制平板那套** —— 已删，别再碰；真横屏走自编 server 的 `setIgnoreActivitySizeRestrictions`。唯一还挂着的一条未验路子：那排抖音 tab 也可能是按**物理屏 density**（恒 480）算而非真写死，若是，临时抬 `wm density` 能两全 —— 但设备有锁屏密码，测不了。
- **不做老用户兼容（2026-09-28 决定，迁移代码已全删）**：收藏的传输地址桶、`scrcpyConfig` 的 localStorage 旧参数、快照里的内联图标迁移、`stored` 标志 —— 一律不再写"升级一次"的适配，代价见 §1 那条。**默认别再提议加迁移**；真要发布时靠一次性手动清缓存解决。（别名表 `device-aliases.json` 不是兼容代码，是运行时必需，留着。）
- **非目标**：Windows/Linux、账号与云同步、遥测/崩溃上报（若引入必须 opt-in 且可离线）、删除设备端配对记录（断开只移 transport）、把 helper 改成常驻后台/监听端口的服务。
- **待决策**：多设备模式（建议显式入口默认关）、自动更新方案、拼音搜索是否引依赖（建议预生成索引）、录屏是否带音频（建议先做无音频）。

---

## 9. 建议动手顺序

> 批次编号不重排：第 1 批（D1/D3/D5/D6/D10/O0/O2 + README 纠偏）已于 2026-09-22 交付并从本表移除。

| 批次 | 内容 | 为什么这么排 |
| --- | --- | --- |
| **第 2 批：零风险清理** | 要动结构/行为的四条：api 透传壳、`src/mirror/session.js` 合并、`validators.js` 收口、空 catch | 每条独立可验，改完跑 `pnpm lint && typecheck && test` 就是回归 |
| **第 3 批：卡住问题剩下的两类** | 「停合成」那类已结案（9-29，见 §0.2）；剩**客户端断链**与**MIUI 息屏收回窗口**两类待拍板：修，还是归档为已知限制 | 这是你点名的"最严重问题"的后两格；收回那类目前只有手动「接回画面」入口 |
| **第 4 批：链路收口** | §5.1 三条状态轮询合成一条事件推送、mDNS browser 补 stop（D9）、D8 改事件驱动 | 第 4 批开始要动 UI/链路，需要小设计 |
| **第 5 批：结构与几何** | O1 拆 `adb.js`、§3 遮罩收口与 letterbox 换成 CSS、§5.3 会话归属合并、`src/mirror/session.js` 并进 `direct-session.js` | 拆分与几何都要一次做透 |
| **并行可插队** | F1 截图、F7 二维码页、O12 一条 CI、O9 对话框换 reka-ui | 便宜且用户可感 |

---

## 10. 口径与「已经确认不是问题」

- 本文所有 `file:line` 由并行探查主进程 / 渲染层 / 文档三路后**逐条复核**；复核不上的（包括一些被夸大的性能说法）没写进来。
- **安全边界已处理好**：包名进设备 shell 前有正则+长度校验（`adb.js` 起），`moveAppTaskToDisplay` 只接受校验过的整数；serial 走 `execFile` 参数数组而非拼 shell；dev launcher 脚本路径经 `shellQuote`（`shortcut.js:144`）；osascript 只接 argv（`iconImage.js:81`）；`.adr` 内容经 `URLSearchParams` 编解码并在读取时重新校验（`shortcutCore.js:67-93`）。
- **并发与原子性已有守卫**：稳定标识解析有 in-flight 去重、缓存写 tmp+rename 原子、发现循环令牌化。**2026-09-28 补上第四、五、六道**：应用缓存的读-改-写按设备文件串行（`mutateAppCache`）；图标改成每包一个文件，一批只写自己的 png，不再参与快照的合并（图标批次之间已无共享可变状态）；`deleteAppCache` 走同一把锁（清除不会与在途写入互相覆盖）。注意锁守的是「同一台设备的多个批次」，不是「多台设备」。
- **反馈链路**：P0-1（`useNotifications` + 列表/图标/Helper 失败提示）与 P0-2（心跳 + 退避重连）确实交付了。仍漏的死角只剩 `src/composables/useScrcpyPreferences.js` 里保存参数那条 `.catch(() => {})` 把失败吞干净了。⚠️ 配对弹窗那次的**根因仍在**：主进程 `waitForMdnsService` 不返回、被取代时返回永不 settle 的 Promise（= **D9**），弹窗侧只是自卫；真修要按 §5.1 改事件驱动。
- **当前基线**：`adbExec` / `adbExecSafe` 每次调用都带超时（默认 15s、connect/pair 45s、安装卸载拉文件 5min），超时统一报「设备无响应」，`getDeviceState` 把超时归为 `offline`；`CHANNELS` 是唯一通道来源并有唯一性单测守着。**2026-09-28 复跑**：`typecheck` 通过、`test` **209 passed / 1 skipped / 21 文件**（净变化：动作键用例 -2、D4 串行 +1、D7 命名与择优 +7、图标落盘与冷启动 +5、删重复的 `scrcpy.test.js` 套件 -4、删老兼容 -6、`deleteAppCache` 补锁 +1、`newDisplay` 必填与 `formatNewDisplay` +2、启动参数带图标的新套件 +3）、`oxlint` 0 错、`eslint` 0 错（原体检里的 **O0「lint 门是红的」确已修掉**，故不再列为待办）。
- ⚠️ **`pnpm format:check` 现在是红的（56 个文件），与本轮改动无关**：拿未被触碰的 HEAD 版 `src/App.vue` 单独跑 `oxfmt --check` 同样报错 —— 是 `oxfmt` 升版（0.67 → 0.70，见 `9e3bfca`）后想重排全仓。**但它就是 O12 上 CI 的第一颗雷**：要么先单独跑一次 `pnpm format` 生成一个巨型重排提交（推荐单独一刀，别混在功能改动里），要么 CI 先不挂 `format:check`。
