# AndDrive 待办总账

> **这份文档是什么**：全仓**唯一**的待办/缺陷/优化/功能清单。它合并了原先三份文档 —— `AUDIT_2026-09.md`（2026-09-22 体检，D/O/F/G/H 编号）、`FEATURE_ROADMAP.md`（P0–P3 排期）、`CLEANUP_2026-09-28.md`（精简盘点，B/X/W 编号）。
> **原编号保留不重排**，因为 git 历史、提交信息和 `NATIVE_MIRROR.md` 里都在引用它们。
> **口径**：每条带 `file:line`，动手前自己复核；核对不上的不写进来。规模 **S** ≈ 半小时内 · **M** ≈ 半天到一天 · **L** ≈ 多天或要先决策。
> 状态 `[ ]` 未开始 · `[~]` 进行中 · `[x]` 已完成 · **结案** = 已证明不该做（见 §8）。
> 架构与刻意设计见 [`ARCHITECTURE.md`](ARCHITECTURE.md)；镜像取证与实测数据见 [`NATIVE_MIRROR.md`](NATIVE_MIRROR.md)。

## 0. 一分钟结论

1. **§1 已清空**：2026-09-28 一轮修掉 6 条真 bug（B1/B3/B4/O10/D4/D7）、删掉 1 条不要的能力（B2），条目本身已从本文移除。**剩下的全是优化 / 结构 / 功能。**
2. **画面「卡住」问题目前零防线在跑**：9-28 那版「息屏弹醒一次 + 90s 冷却」已从工作树整体消失（全仓 grep `watchSleepBounce` / `wakeDisplay` / `mirrorWake*` 零命中）。三类根因（A 断链 / B1 系统收回 / B2 停合成）、统一理论与**已判死的七条救法**现已补进 `NATIVE_MIRROR.md` §排查记录 2026-09-28 —— 之前只存在于对话里、从未进过提交。要不要重做是产品决策，先拍板（§9 第 3 批）。
3. **轮询/定时器 15 处**（§5）。可收口的是三条"UI 想知道设备状态"的轮询，以及建了不拆的 mDNS socket。
4. **按包名/机型的 app 特殊定制在可执行代码里已经清零**（§4）。别再去找"哪里在特判抖音"。
5. **裁切症状已结案**（用户 2026-09-28：原因他已找到，不用再查；根因未入库）。§3 只剩结构债，其中「同一套显示尺寸数学写两遍」和死兜底 `DEFAULT_NEW_DISPLAY` 本轮已清掉。
6. 最划算的结构刀是拆 `electron/adb.js`（1615 行 / 8 职责），但它那些"保持既有引用"的再导出**对测试仍承重**。

---

## 1. 真 bug（用户能感觉到）

**当前没有未修的真 bug。** 2026-09-28 这一轮修掉并已从本文删掉的条目：B1（正式版静默丢音频）、B3（`beforeunload` 重复注册）、B4（`installHelpera` 进契约）、O10（配对弹窗未捕获异常）、D4（图标批次互相丢写）、D7（多台在线解析到另一台地址）；B2（镜像系统动作键）按决策整体删除。要细节查 git 历史或提交信息。

**从这批里挑出来的、仍然开着的两件**：

- **D7 欠真机验证**：多台设备同时广播时，`_adb-tls-pairing` 与 `_adb-tls-connect` 的实例名是否真的共用同一段设备标识 —— 目前的择优逻辑是按 adb 惯例 + 测试夹具推的，**没在两台真机上验过**。要做时先修现场：两台同时开无线调试，比对 `adb mdns services` 原文。
- **D4 的残留窗口**：别名表还没建立时（冷启动直接刷列表），同一台机器的两个传输地址会分到两把锁。实际链路里连接/心跳会先填好别名，窗口极短，但**不是零**。
- ⚠️ **老用户兼容已按 2026-09-28 的决定全部删除**，代价是**升级后这些东西重来一次**（不是丢设备上的数据，只是本地缓存/偏好）：① 旧收藏里按 adb 传输地址存的那些桶**不再并入**稳定标识（`collapseLegacy` + `favorites.json.bak` 已删）→ 老用户可能看到收藏少了几条，重新星标即可；② `scrcpyConfig` 不再读 localStorage 旧参数（`stored` 标志一并删）→ 首次升级后投屏参数回到默认；③ 快照里的内联图标不再迁移成文件 → 图标重拉一轮。**这条决定本身要记在 §8**，别再把它当 bug 报回来。

---

## 2. 工程优化与文档事实

- **O1 拆 `electron/adb.js`（1615 行，8 职责）**：adb 执行与错误归一 / 输出解析 / mDNS 发现与设备名 / 健康与重连 / 应用缓存与图标 / 稳定标识别名 / 应用操作 / 设备信息 / IPC 注册（这文件自己就注册 23 个 handler，全仓 39 个）。`tests/electron/` 已按这些主题分文件，主进程按同一刀切最自然。⚠️ 拆前必须解决"再导出对测试承重"（见 §5 X 组）。**L**
- **O5 应用列表 300+ 应用时的成本**：没虚拟化（每格一套 ContextMenu/Portal，`AppList.vue:460-537`）、`patchIcons` 整数组替换（`:81-89`）→ 每 20 个图标全表重排、`sections` 过滤两遍（`:68-78`）、搜索无 debounce（`:58-62`）。顺序：debounce + `sections` 合成一遍 → 真要扛 1000 个再上虚拟化。**M**
- ⚠️ **图标有效期有两个主人**（2026-09-28 我把图标拆成文件时**自己造的**债）：主进程 `electron/adb.js` 的 `ICON_TTL_MS`（决定文件还给不给）与渲染层 `src/components/home/AppList.vue` 的 `ICON_REFRESH_MS`（决定要不要再要一批），两者都是 7 天但**没有共同来源**，改一个忘一个的后果是"每次都重拉"或"过期了还不重拉"。收成一个（渲染层只信主进程：它不给就是缺）。**S**
- **O9 对话框是手搓的 Motion div**（`AppInfoDialog.vue:37-95`、`AddDeviceDialog.vue`）：无焦点陷阱、无 Esc、无 dialog 角色；reka-ui 已在依赖里且已用其 Dialog/ContextMenu，换过去白拿可达性。**S–M**
- **O11 设备信息面板无数据时是空白**（`DeviceStats.vue:116` 只有 `v-else-if="stats"`，无空态/错误态）；写着「更新于」但不会自动刷新。**S**
- **O8 可达性细节**：几处 `outline-none` 没补焦点环（`Settings.vue:146,156`、`DeviceStats.vue:93,175`、`ScrcpySessions.vue:72,96,101`）；纯图标按钮无可访问名称（`PageHeader.vue:57`、`AppList.vue:405-427`）；`<html lang="">` 是空的（`index.html:2`、`mirror.html:2`）；`prefers-reduced-motion` 只在镜像页处理（`src/mirror/App.vue` 样式里的 `@media (prefers-reduced-motion)`）。**S–M**
- **O3 两套 IPC 访问方式并存**：主窗口走 `src/api/index.js` + preload，镜像窗口裸 `window.__anddriveIpc` + `CHANNELS`（`src/mirror/session.js` 开头）。镜像页 `nodeIntegration` 有意为之，已在 `ARCHITECTURE.md` §1 写明边界；改 IPC 时两边都要看。**记录，不改**
- **O7 没有深色模式**：全仓零 `dark:`，`src/App.vue:311` 写死 `theme="light"`。主要成本是把 `src/styles/index.css` 的底色 token 化，不是逐组件改写。**M**（对应 P3-4）
- **O12 没有 CI**：`.github/` 不存在。本地门已齐（`typecheck` + `lint` + `test` + `format:check` + `verify-resources`），先串成一条 `pnpm verify` 再上 Actions。**S**
- **O13 渲染层零测试**：`tests/` 只覆盖 electron 与 mirror 纯逻辑。`useFavorites` 回滚、`needsIcon`/`patchIcons` 合并、`sections` 分组、`readableError` 都是纯函数，成本极低。**S–M**
- ✅ **文案一致性已修（2026-09-28）**：① 功能名统一成「镜像」——`Settings.vue` 段标题「投屏镜像」→「镜像」、辅助功能说明「投屏时…」→「镜像时…」、`App.vue` 快捷方式失败提示「启动投屏失败」→「启动镜像失败」、会话面板「运行中镜像」→「运行中的镜像」（与它的 tooltip 对齐）；代码注释里说"别的投屏软件"的保留，那不是本功能的名字。② **「恢复默认」确实有两处不同含义**，已改名区分：设置页保留「恢复默认」（写全局并持久化），启动对话框那颗改成 **「重置本次参数」**（只改本次草稿、回到代码默认值）。
- ⚠️ **我原先那句「关闭类按钮有 取消/关闭/断开 三种 = 不一致」是错的，撤回**：核对后它们是三种职责 ——「取消」关确认框、「关闭」关信息框（`AppInfoDialog`）、「断开」是确认框里的**肯定动作**（`confirm-label="断开"`）。同屏不会出现两个都表示关掉的词，不该强行统一。
- **仍待你决定**："多设备不得静默降级"这条原则要不要落地（`ARCHITECTURE.md` §4 已把它标成目标而非现状）。
- 文档引用**改用符号锚点**（`waitForMdnsService`、`COVER_*`、`TEARDOWN_TIMEOUT_MS`…）：删代码会让行号集体漂移，2026-09-28 就漂了一次，换算时还发现两处**本来就错**的范围（`options.js` 的 bounds 常量、`mirror/session.js` 的调用入口）。新写条目请沿用符号锚点。

---

## 3. 镜像几何：裁切 / 铺满 / 黑边（症状已结案，只剩结构债）

**状态**（2026-09-28 用户口径）：**裁切症状的原因他已找到，这件事不需要再查**；根因**没有记进仓库**，本文与 `NATIVE_MIRROR.md` 都只有历史取证，别再据此重开调查。本节剩下的只是**结构性债务**。

- ✅ **「同一套数学写了两遍」已收口（2026-09-28）**：显示像素现在只有 `src/mirror/direct-session.js` 的 `displayFor(css)` 一处算（建显示与 `resizeDisplay` 同源）；`src/mirror/connect.js` 的 `startScrcpy` 改成**接收**算好的 `display`，自己不再读 DOM。建显示用的 CSS 优先取主进程传来的 `info.initialCss`（`electron/mirror/session.js` 里由 `win.getContentBounds()` 得到），**读不到才回落 DOM** —— 顺手落了之前"已验证未入库"的深链冷启动修复：页面还没排版完时 `clientWidth` 会读到 Electron 默认的 512x512，于是一开就开出 `512x512/480` 这块错尺寸显示。
- ✅ ~~默认值会走偏~~ **已删（2026-09-28）**：`DEFAULT_NEW_DISPLAY="1280x960/160"` 是死码（生产唯一调用方总会覆盖，且 dpi 160 与任何档位都不符，真走到就静默开出错密度显示）。`buildMirrorOptions` 的 `newDisplay` 改成**必填**（缺了就抛），拼串收成一个 `formatNewDisplay(display)`（含非法尺寸抛错），喂死码的那条断言已改掉。

仍然开着的：

- **几何的两个主人**（这不算错，只是两套决策靠假设对齐）：主进程按设备分辨率算窗口 bounds —— `electron/mirror/options.js` 里 `mirrorWindowBounds` 用的那组常量（`MIRROR_WINDOW_MAX_EDGE=1000`、`MARGIN=80`、`FALLBACK_RATIO=9/19.5`、下限 320/280），调用入口 `electron/mirror/session.js` 的 `startMirrorSession`；渲染层按窗口 CSS 算显示像素（`shared/scrcpyConfig.js` 的 `computeDisplayMetrics`）。两边靠「app 会铺满显示」这个服务端假设才不打架。
- **渲染层手写 letterbox**：`src/mirror/App.vue` 的 `syncCanvasBox`（min-scale + 取整 + `objectFit:'fill'`）重新实现了 CSS `object-fit: contain`；有 3 条触发路径（ResizeObserver / `sizeChanged` / `meta`）+ 「尺寸未知先拉伸、之后重贴」的两段式兜底。
- **遮罩/重排状态机约 90 行**：`src/mirror/App.vue` 的遮罩那一块（`armCover/endCover/coverForReflow/cancelCover/onFrameSizeChanged`、`reflowGate`、`aspectDiffers` 容差 0.02），只为盖住 resize 闪烁；`displayFollow.js` 的 `createReflowGate` 注释自陈是盖在早先「只看时间」的修复之上。建议收口成**只以 `reflowGate` 为单一判据**。**M**
- **编解码降级分家**：`options.js` 的 `NATIVE_SUPPORTED_CODECS`（丢 av1）与 `connect.js` 各管一半。
- **未结的另一半**：`resizeDisplay` 不带 dpi，档位只在开会话时生效（中途换档就 1dp≠1CSSpx）。AndroMeld 的 resize 命令带 dpi（三个 int w/h/dpi），要跟就得**扩我们自己的协议** —— 那才能做到"窗口任意大也不掉清晰度/不漂移"。**M–L**
- ~~待查假设（窗口跑屏外 / 窗内被裁）~~：随症状结案一并移除。
- 顺带的真实缺陷（正常窗口尺寸不触发）：上游 `NewDisplayCapture` 对 flex display 用 `Size.constrain(constraints, false)` **逐维裁剪**，越界时显示形状与窗口形状脱钩（5600x5600 → 比例 1.296）。这台机 h265 上限**短边 4320 / 长边 8192**，倍率 3 下窗口任一边 >~1440 CSS px 就越界。
- 未验：只有竖屏排版、没有宽布局的 app 在横形显示上会怎样；真机反馈后再决定要不要按包豁免（但注意 §4 的"仓库不留单 app 适配"）。

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

**2026-09-28 已删干净、因此从本清单移除的**：`fsUtil` 的两个零调用函数、`engine` 字段全套（含 `ENGINES`、`ScrcpySession.pid` 与被镜像页遮蔽的 `MirrorSession` 重复 typedef）、`adb.js` 的 `launchApp`、七个 handler 的未用 `event` 形参、四个从未被调用的 `use*()` 包装与 `notify.info`、`main.js` 重复 import、`adb.js` 与 `electron/scrcpyConfig.js` 的透传再导出（连带把 `tests/electron/scrcpy.test.js` 那份**重复的** `normalizeScrcpyConfig` 套件折进 `scrcpyConfig.test.js` 并删文件，独有断言一条没丢）、`options.js` 的死兜底 `DEFAULT_NEW_DISPLAY`（同时把 `newDisplay` 改成必填，见 §3）。

**仍然开着的**（要么不是零调用，要么删/改会动到行为或结构，所以没归进这轮）：

- `src/api/index.js` — 约 40 个一行透传壳，纯重复 preload 命名。删层或删壳，二选一。**M**
- `ConfirmDialog.vue:13,20-29` — `cancel` 与 `close` 两个 emit 行为相同，调用点还都绑一样（`AppList.vue:558`、`PageHeader.vue:71`）。**S**
- `src/mirror/displayFollow.js` 的 `lastSentKey` getter（只有测试用）；`src/mirror/session.js`（88 行）是 8 个 handler 1:1 的转发壳 → **并进 `direct-session.js`**；`electron/mirror/appSession.js`（34 行）单调用方 → 可内联。**M**
- ✅ ~~`deleteAppCache` 不持锁~~ **已修（2026-09-28）**：删除动作整块包进与写路径同一把 `withCacheLock`，否则一次正在收尾的 rename 会让「清除缓存」后列表原地复活。回归用例 `waits for an in-flight write before clearing the cache` **已证伪**（旁路掉锁就立刻红）。至此 §5.2 里我自己造的洞只剩 §1 那条「别名未建立时锁会裂」。
- 重复校验：serial/package 合法性在 `adb.js`、`shortcutCore.js`、`favorites.js`、`mirror/session.js` 各写一遍（package 一处正则、一处只判长度）。IPC 边界已校验，内部再校验属冗余 → 收成一个 `validators.js`。**S–M**
- 空 catch 吞异常（对照 `ARCHITECTURE.md` §4 的分寸）：`adb.js` 两处、`iconImage.js:104`、`favorites.js:84-86`、`direct-session.js` 四处（含一处双层嵌套全吞）。**S**
- 目录名与版本号的漂移：缓存目录仍叫 `apps-v1`，版本常量已是 `CACHE_VERSION = 2`。**已复核不致命**（读写同一常量，不会每次启动作废），只是名字骗人；改名要连迁移一起做。**S**
- `adb.js` 的 `adbExecSafe` + `splitCallOptions`：靠嗅探 `args[0]` 是不是配置对象来区分调用形式，守的全是内部调用点。**S**

### 5.3 会话归属与跨层混淆（改动要谨慎）

- ⚠️ **镜像窗口为取一个图标而读整台设备的图标**（本轮把图标拆成文件后**没有变差、但也没变好**，值得单独收一刀）：`src/mirror/App.vue` 的 `loadIcon` 调 `adb:getCachedApps` 拿全量列表再 `find` 那一个包名 —— 以前是把整份含 base64 的 JSON 读一遍，现在是 readdir + 每张 png 一次 stat/read，量级相同。正解很便宜：**开会话时就已经带著 iconUrl**（`startMirrorSession` 的 request 里有，`AppList.vue:217` 传进来的），把它放进 `pendingInit` 即可，镜像页从此不碰缓存。顺带还能修掉 `.adr` 冷启动路径拿不到图标的老问题。**S**

- 两套「session」概念撞车：`useScrcpySessions`（主进程窗口注册表，UI 轮询）vs `direct-session.current`（每窗口 scrcpy 客户端）；`direct-session.js:50,58` 把 `current.info` **写两次**。
- 字段所有权倒挂：`electron/mirror/session.js:244-256` 把 codec/hasAudio 这些**渲染层拥有**的字段存进主进程记录；复用与新起两条路径返回**不同形状**（`:129` vs `:177`）；`:256` 大括号缩进错位。
- 状态双份：`electron/mirror/session.js:167-175` `pendingInit` 同时下发原始 `config` 与主进程派生 `prefs`，渲染层再规范化一遍（`electron/mirror/options.js:41,94,105`）；`turnScreenOff` 主进程决策、渲染层发控制消息执行。
- 通道命名说谎：`mirror:appTask` / `mirror:moveTask` 注册在 `adb.js` 末尾的 `ipcMain.handle` 那一段（`mirrorAppTask` / `mirrorMoveTask`）。
- 设备状态编排由渲染层定时器驱动（`direct-session.js:226-239` `reclaimApp` + `watchAppStolen`）。搬回应用一律用 `am display move-stack`，**绝不 force-stop**。

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
| P0-4 | 设置持久化 | 上次设备 serial、scrcpy 默认参数、**窗口几何**、自动重连开关（「恢复默认」的歧义已于 2026-09-28 解决，见 §2） |
| P0-5 | 列表刷新与失败重试 | 刷新入口、图标批次指数退避（当前失败只记录）、区分「无应用」与「读取失败」空态 |
| P0-6 | 测试与 CI | = O12 + O13 |
| P1-1 | 搜索/排序 | `[~]` 收藏已完成；**待办**：拼音首字母搜索、名称/安装时间排序、MRU（依赖 P1-4）。注意现状**根本没有 MRU**（`ARCHITECTURE.md` §3） |
| P1-4 | MRU 跨会话持久化 | 按设备记录最近启动 + 上限淘汰 + 损坏降级为空；数据源可用 H6 |
| P2-4 | 快捷键与命令面板 | ⌘K 面板、⌘R 刷新、⌘, 设置、Esc 关闭 |
| P2-5 | 分组、标签与隐藏 | 自定义分组/标签/隐藏/显示名，本地持久化 |
| P3-1 | 多设备支持 | **待决策**，与"单设备优先"冲突；建议默认单设备 + 显式进入多设备模式。~~做之前先修 D7~~（D7 已于 2026-09-28 修，但**未上真机验证过多台同时广播的命名**） |
| P3-2 | 记忆设备与启动自动重连 | 启动读上次 serial → mDNS 解析 → connect → 直接进首页。同样依赖 D7（已修）；冷启动时别名表还没建立，解析要能容错 |
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
- **系统动作键那套能力已整体删除（2026-09-28，B2/D2/F4 结案）**：返回 / Home / 多任务 / 音量 / 电源、旋转、通知栏、以及 `kind:'action'` 消息通道 —— 按决策**不要**，代码已清空，**别再提"接线"**。删除范围：`electron/mirror/control.js` 的 `TAP_ACTIONS` + `applyAction` + `case 'action'`（连带 `KEY_CODES` 再导出）、`shared/keys.js` 里只为它服务的五个键值别名（home / appSwitch / power / volumeUp / volumeDown）。**不影响「启动后息屏」**：那条走 `src/mirror/direct-session.js` 里 `turnScreenOff` 那一支直调 Tango `setDisplayPower(false)`，本来就不经过这层（原 B2 描述里把它算进动作键是错的）。回归测试已改成断言 `kind:'action'` 现在抛「未知控制消息」。若将来要做鼠标手势（NATIVE_MIRROR §P1 那条仍然开放），直接给 `controller.injectKeyCode` 传官方键值，不要恢复这层抽象。
- **黑边的变量不是比例，是 Android 的 600dp 大屏门槛**（`smallestWidth ≥ 600dp` 时系统忽略 app 方向锁并 letterbox）。比例吸附、600dp dpi 下限、`tablet` 模式、`MAX_DISPLAY_PIXELS` 都已试过并删除。
- **模糊遮罩挡不住重排闪烁**（透明度低于 ~95% 就看得见），现方案是不透明遮罩 + 等关键帧。
- **`force-stop` 不是"把应用接回来"**：会冷启。正确做法 `am display move-stack`（真机验证 pid 不变）。「重新启动」按钮当天加了又删 —— 和"接回"并排会误点。
- **剪贴板同步 G3 = 已放弃**：服务端写完同进程回读拿到 `null`，这一条判据分不清「读被挡」与「写没落地」，**不足以下"ROM 挡剪贴板"的结论**（曾据此断言过，被驳回，记录在此免得重犯）。也别动 appop（`READ_CLIPBOARD` 本来就 allow）。
- **采集别人的虚拟显示可以，resize 与销毁不行**（`VirtualDisplay` 与创建它的进程绑死）。多窗口共览一块显示需要一个常驻持有者，这一档暂不做。
- **不要用 `audioDup`**（会让手机出声，与"投屏时手机静音"的要求相反）。
- **`wm size` / `wm density` 改物理屏、compat 强制平板那套** —— 已删，别再碰；真横屏走自编 server 的 `setIgnoreActivitySizeRestrictions`。唯一还挂着的一条未验路子：那排抖音 tab 也可能是按**物理屏 density**（恒 480）算而非真写死，若是，临时抬 `wm density` 能两全 —— 但设备有锁屏密码，测不了。
- **非目标**：Windows/Linux、账号与云同步、遥测/崩溃上报（若引入必须 opt-in 且可离线）、删除设备端配对记录（断开只移 transport）、把 helper 改成常驻后台/监听端口的服务。
- **待决策**：多设备模式（建议显式入口默认关）、自动更新方案、拼音搜索是否引依赖（建议预生成索引）、录屏是否带音频（建议先做无音频）。

---

## 9. 建议动手顺序

| 批次 | 内容 | 为什么这么排 |
| --- | --- | --- |
| **第 1 批 ✅ 已完成**（2026-09-22） | D1 息屏、D3 收藏写失败要说话、D5 adb 全面超时、D6 换设备重载、D10 重复 `getDeviceState`、O0 六条死码、O2 通道收口 + CHANNELS 唯一性单测、README 五处漂移 | 都是"用户已会撞到但不知道为什么"，互不干扰 |
| **第 2 批：零风险清理** | X 组的**零调用那一半、全部老用户兼容代码、`deleteAppCache` 补锁已于 2026-09-28 做完**（见 §5.2）。剩的是要动结构/行为的：api 透传壳、`session.js` 合并、`validators.js` 收口、空 catch | 每条独立可验，改完跑 `pnpm lint && typecheck && test` 就是回归 |
| **第 3 批：卡住问题拍板** | §0.2 那条：要不要重做「息屏弹醒」；不做就把 A/B1/B2 三类根因归档为已知限制 | 这是你点名的"最严重问题"，目前**零防线在跑**，别让它悬着 |
| **第 4 批：链路收口** | §5.1 三条状态轮询合成一条事件推送、mDNS browser 补 stop（D9）、D8 改事件驱动 | 第 4 批开始要动 UI/链路，需要小设计 |
| **第 5 批：结构与几何** | O1 拆 `adb.js`、§3 遮罩与几何单一主人化、§5.3 会话归属合并、`session.js` 并进 `direct-session.js` | 拆分与几何都要一次做透；**几何要先按 `NATIVE_MIRROR.md` §4.0 的纪律复现一次再改** |
| **并行可插队** | F1 截图、F7 二维码页、O12 一条 CI、O9 对话框换 reka-ui | 便宜且用户可感 |

---

## 10. 口径与「已经确认不是问题」

- 本文所有 `file:line` 由并行探查主进程 / 渲染层 / 文档三路后**逐条复核**；复核不上的（包括一些被夸大的性能说法）没写进来。
- **安全边界已处理好**：包名进设备 shell 前有正则+长度校验（`adb.js` 起），`moveAppTaskToDisplay` 只接受校验过的整数；serial 走 `execFile` 参数数组而非拼 shell；dev launcher 脚本路径经 `shellQuote`（`shortcut.js:144`）；osascript 只接 argv（`iconImage.js:81`）；`.adr` 内容经 `URLSearchParams` 编解码并在读取时重新校验（`shortcutCore.js:67-93`）。
- **并发与原子性已有守卫**：稳定标识解析有 in-flight 去重、缓存写 tmp+rename 原子、发现循环令牌化。**2026-09-28 补上第四、五、六道**：应用缓存的读-改-写按设备文件串行（`mutateAppCache`）；图标改成每包一个文件，一批只写自己的 png，不再参与快照的合并（图标批次之间已无共享可变状态）；`deleteAppCache` 走同一把锁（清除不会与在途写入互相覆盖）。注意锁守的是「同一台设备的多个批次」，不是「多台设备」。
- **反馈链路**：P0-1（`useNotifications` + 列表/图标/Helper 失败提示）与 P0-2（心跳 + 退避重连）确实交付了。仍漏的死角只剩 `src/composables/useScrcpyPreferences.js` 里保存参数那条 `.catch(() => {})` 把失败吞干净了。⚠️ 配对弹窗那次的**根因仍在**：主进程 `waitForMdnsService` 不返回、被取代时返回永不 settle 的 Promise（= **D9**），弹窗侧只是自卫；真修要按 §5.1 改事件驱动。
- **当前基线**：`adbExec` / `adbExecSafe` 每次调用都带超时（默认 15s、connect/pair 45s、安装卸载拉文件 5min），超时统一报「设备无响应」，`getDeviceState` 把超时归为 `offline`；`CHANNELS` 是唯一通道来源并有唯一性单测守着。**2026-09-28 复跑**：`typecheck` 通过、`test` **206 passed / 1 skipped / 20 文件**（净变化：动作键用例 -2、D4 串行 +1、D7 命名与择优 +7、图标落盘与冷启动 +5、删重复的 `scrcpy.test.js` 套件 -4、删老兼容 -6、`deleteAppCache` 补锁 +1、`newDisplay` 必填与 `formatNewDisplay` +2）、`oxlint` 0 错、`eslint` 0 错（原体检里的 **O0「lint 门是红的」确已修掉**，故不再列为待办）。
- ⚠️ **`pnpm format:check` 现在是红的（56 个文件），与本轮改动无关**：拿未被触碰的 HEAD 版 `src/App.vue` 单独跑 `oxfmt --check` 同样报错 —— 是 `oxfmt` 升版（0.67 → 0.70，见 `9e3bfca`）后想重排全仓。**但它就是 O12 上 CI 的第一颗雷**：要么先单独跑一次 `pnpm format` 生成一个巨型重排提交（推荐单独一刀，别混在功能改动里），要么 CI 先不挂 `format:check`。
