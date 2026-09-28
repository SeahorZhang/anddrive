# AndDrive 待办总账

> **这份文档是什么**：全仓**唯一**的待办/缺陷/优化/功能清单。它合并了原先三份文档 —— `AUDIT_2026-09.md`（2026-09-22 体检，D/O/F/G/H 编号）、`FEATURE_ROADMAP.md`（P0–P3 排期）、`CLEANUP_2026-09-28.md`（精简盘点，B/X/W 编号）。
> **原编号保留不重排**，因为 git 历史、提交信息和 `NATIVE_MIRROR.md` 里都在引用它们。
> **口径**：每条带 `file:line`，动手前自己复核；核对不上的不写进来。规模 **S** ≈ 半小时内 · **M** ≈ 半天到一天 · **L** ≈ 多天或要先决策。
> 状态 `[ ]` 未开始 · `[~]` 进行中 · `[x]` 已完成 · **结案** = 已证明不该做（见 §8）。
> 架构与刻意设计见 [`ARCHITECTURE.md`](ARCHITECTURE.md)；镜像取证与实测数据见 [`NATIVE_MIRROR.md`](NATIVE_MIRROR.md)。

## 0. 一分钟结论

1. 有一个**正式版必崩**的 bug（B1 音频第一帧），一行守卫。
2. **画面「卡住」问题目前零防线在跑**：9-28 那版「息屏弹醒一次 + 90s 冷却」已从工作树整体消失（全仓 grep `watchSleepBounce` / `wakeDisplay` / `mirrorWake*` 零命中）。三类根因（A 断链 / B1 系统收回 / B2 停合成）、统一理论与**已判死的七条救法**现已补进 `NATIVE_MIRROR.md` §排查记录 2026-09-28 —— 之前只存在于对话里、从未进过提交。要不要重做是产品决策，先拍板（§9 第 3 批）。
3. **轮询/定时器 15 处**（§5）。可收口的是三条"UI 想知道设备状态"的轮询，以及建了不拆的 mDNS socket。
4. **按包名/机型的 app 特殊定制在可执行代码里已经清零**（§4）。别再去找"哪里在特判抖音"。
5. **裁切 / 铺满 / 黑边仍未解决**，根因怀疑点在**几何有两个主人**（§3），牵扯未验证假设，要单独一轮。
6. 最划算的结构刀是拆 `electron/adb.js`（1615 行 / 8 职责），但它那些"保持既有引用"的再导出**对测试仍承重**。

---

## 1. 真 bug（用户能感觉到）

| # | 现象 | 证据 | 建议 | 规模 |
| --- | --- | --- | --- | --- |
| B1 | 正式版收到第一个音频包就 `TypeError`：`debugAudio` 非 DEV 时是 `null`，调用点无守卫 | `src/mirror/App.vue:313`（`: null`）vs `:332` 裸调 | 删掉这个 dev-only 闭包，计数留在 `hud.audioPackets`；或 `import.meta.env.DEV &&` 包一层 | S |
| B2 | 镜像窗口没有 Home / 多任务 / 音量 / 电源，只有 Esc 当返回 | 动作分支与 keycode 表早就写好：`electron/mirror/control.js:82-123`（`case 'action'` + `TAP_ACTIONS`）；唯一发控制消息的 `src/mirror/useMirrorInput.js:14` 只发 `touch/scroll/key/text`；`shared/keys.js:35` 只有 `Escape: back` | = **D2 / F4**，控制条 UI 在 2026-09-16 被删后一直没接线。加悬浮或菜单栏入口挂 5 个动作，或先做快捷键。注意带 Cmd 的组合一律不发设备（`useMirrorInput.js:89-90`，为让 ⌘Q/⌘W 归系统），所以 **Cmd+V 不会贴进手机** | S–M |
| B3 | `beforeunload` 每次 `bootstrap()` 重复注册 → 接管/复用路径挂多份监听 | `src/mirror/session.js:36`（注册）；`:21-22` 注释明说 `bootstrap()` 可重复调用 | 注册移到模块顶层做一次 | S |
| B4 | 拼错的 `installHelpera` 已进 API 契约 | `electron/preload.js:41` → `src/api/index.js:11,81` | 改 `installHelper`；与 §5 X 组的"删 api 透传壳"一起做 | S |
| O10 | 配对弹窗有一处未捕获异常：`findDeviceApi()` 落在 `try` 之外，失败即 unhandled rejection，界面停在「等待设备扫码」，且无超时/取消 | `src/components/AddDeviceDialog.vue:24`（try 从 `:26` 才起） | 纳入 try + 加超时和取消入口 | S |
| D4 | 多个图标批次互相**丢写**，且每批重写整个设备缓存 JSON | `electron/adb.js` `readAppCache`→内存合并→`writeAppCache` 无按设备串行；渲染层并发 3 个 worker（`src/components/home/AppList.vue:35-37`、`:168-192`） | 主进程按稳定标识串 promise 链；或图标单独按包名落文件（= 同一改动的两面，顺带解决 **O6**） | M |
| D7 | 多台在线时可能**解析到另一台**的地址 | `resolveConnectAddress()` 不接参数却被当"按 serial 解析"调（`electron/adb.js:249` vs `:1507,1510`）；底层 `waitForMdnsService` 只返回第一个匹配条目 | 按服务实例名里嵌的稳定标识过滤（`adb-<serial>-xxxx._adb-tls-connect._tcp`）。单设备原则下不致命，做 **P3-1/P3-2** 必踩 | S–M |

---

## 2. 工程优化与文档事实

- **O1 拆 `electron/adb.js`（1615 行，8 职责）**：adb 执行与错误归一 / 输出解析 / mDNS 发现与设备名 / 健康与重连 / 应用缓存与图标 / 稳定标识别名 / 应用操作 / 设备信息 / IPC 注册（这文件自己就注册 23 个 handler，全仓 39 个）。`tests/electron/` 已按这些主题分文件，主进程按同一刀切最自然。⚠️ 拆前必须解决"再导出对测试承重"（见 §5 X 组）。**L**
- **O5 应用列表 300+ 应用时的成本**：没虚拟化（每格一套 ContextMenu/Portal，`AppList.vue:460-537`）、`patchIcons` 整数组替换（`:81-89`）→ 每 20 个图标全表重排、`sections` 过滤两遍（`:68-78`）、搜索无 debounce（`:58-62`）。顺序：debounce + `sections` 合成一遍 → 图标按包名增量合并 → 真要扛 1000 个再上虚拟化。**M**
- **O6 图标走 base64 data URL**（上限 512KB，`electron/iconImage.js:23` `MAX_ICON_BYTES`），渲染只有 44px（`size-11`，`src/components/home/AppList.vue:477`）：helper 已按 128px 缩过（`helper-app/.../ListMain.java:33`），可落盘成文件用 `file://` 引用，省 IPC 与缓存体积（与 D4 同解）。**M**
- **O9 对话框是手搓的 Motion div**（`AppInfoDialog.vue:37-95`、`AddDeviceDialog.vue`）：无焦点陷阱、无 Esc、无 dialog 角色；reka-ui 已在依赖里且已用其 Dialog/ContextMenu，换过去白拿可达性。**S–M**
- **O11 设备信息面板无数据时是空白**（`DeviceStats.vue:116` 只有 `v-else-if="stats"`，无空态/错误态）；写着「更新于」但不会自动刷新。**S**
- **O8 可达性细节**：几处 `outline-none` 没补焦点环（`Settings.vue:146,156`、`DeviceStats.vue:93,175`、`ScrcpySessions.vue:72,96,101`）；纯图标按钮无可访问名称（`PageHeader.vue:57`、`AppList.vue:405-427`）；`<html lang="">` 是空的（`index.html:2`、`mirror.html:2`）；`prefers-reduced-motion` 只在镜像页处理（`src/mirror/App.vue:459`）。**S–M**
- **O3 两套 IPC 访问方式并存**：主窗口走 `src/api/index.js` + preload，镜像窗口裸 `window.__anddriveIpc` + `CHANNELS`（`src/mirror/session.js:1-8`）。镜像页 `nodeIntegration` 有意为之，已在 `ARCHITECTURE.md` §1 写明边界；改 IPC 时两边都要看。**记录，不改**
- **O7 没有深色模式**：全仓零 `dark:`，`src/App.vue:311` 写死 `theme="light"`。主要成本是把 `src/styles/index.css` 的底色 token 化，不是逐组件改写。**M**（对应 P3-4）
- **O12 没有 CI**：`.github/` 不存在。本地门已齐（`typecheck` + `lint` + `test` + `format:check` + `verify-resources`），先串成一条 `pnpm verify` 再上 Actions。**S**
- **O13 渲染层零测试**：`tests/` 只覆盖 electron 与 mirror 纯逻辑。`useFavorites` 回滚、`needsIcon`/`patchIcons` 合并、`sections` 分组、`readableError` 都是纯函数，成本极低。**S–M**
- **文案一致性**：镜像/投屏/投屏镜像三种叫法混用（`src/App.vue:242` vs `:245` vs `Settings.vue:145`）；「恢复默认」在两处语义不同（`Settings.vue:147` 恢复全局默认 vs `ScrcpyLaunchDialog.vue:105` 恢复到代码默认值）；关闭类按钮有 取消/关闭/断开 三种。**S**
- **文档漂移**（本轮已随三份合并解决大半）：`PRINCIPLE_DOCUMENT.md` 五个失效引用（`usePairing.js`、`useAppLauncher.js`、`appOrdering.js`、`shared/deviceSession.js`、`src/icons.js` —— 全部不存在）已随该文件删除而消失，重写为 `ARCHITECTURE.md`；`NATIVE_MIRROR.md` 里指向不存在 `docs/archive` 的那句已删；仍待你决定的是 **"多设备不得静默降级"这条原则要不要落地**（`ARCHITECTURE.md` §4 已把它标成目标而非现状）。

---

## 3. 镜像几何：裁切 / 铺满 / 黑边（仍未解决）

**状态**：`NATIVE_MIRROR.md` §排查记录 2026-09-22 一节标题就是「问题仍未解决」。症状有两种读法（画面在窗口内被裁一圈 vs 窗口自己跑到屏外），**尚未区分**；把 server 改成按比例收缩后你实测症状照旧，改动已回退。下次别再从「比例被裁」入手。

结构性债务（这节才是精简重点）：

- **几何有两个主人**：主进程按设备分辨率算窗口 bounds（`electron/mirror/options.js:113-148`，`MAX_EDGE=1000`、`MARGIN=80`、`FALLBACK_RATIO=9/19.5`、下限 320/280；调用入口 `electron/mirror/session.js:139-140`）；渲染层按窗口 CSS 独立算显示像素（`shared/scrcpyConfig.js:66-76` `computeDisplayMetrics`，调用点 `src/mirror/connect.js:60-64` 与 `src/mirror/direct-session.js:24-31` —— **同一套数学写了两遍**）。两套比例决策靠「app 会铺满显示」这个服务端假设才不打架（`options.js:121-125`、`electron/mirror/session.js:49-51` 注释）。这是裁切难定位的直接原因。
- **渲染层手写 letterbox**：`src/mirror/App.vue:206-226` `syncCanvasBox`（min-scale + 取整 + `objectFit:'fill'`）重新实现了 CSS `object-fit: contain`；有 3 条触发路径（ResizeObserver / `sizeChanged` / `meta`）+ 「尺寸未知先拉伸、之后重贴」的两段式兜底。
- **遮罩/重排状态机约 90 行**：`src/mirror/App.vue:82-154`（`COVER_*`、`armCover/endCover/coverForReflow/cancelCover/onFrameSizeChanged`、`reflowGate`、`aspectDiffers` 容差 0.02），只为盖住 resize 闪烁；`displayFollow.js:150-154` 自陈是盖在早先「只看时间」的修复之上。建议收口成**只以 `reflowGate` 为单一判据**。**M**
- **默认值会走偏**：`options.js:30` `DEFAULT_NEW_DISPLAY="1280x960/160"` 的 dpi 160 与档位 dpi 不一致，只在渲染层覆盖送不到时用到。
- **编解码降级分家**：`options.js:86-97` `NATIVE_SUPPORTED_CODECS`（丢 av1）与 `connect.js` 各管一半。
- **未结的另一半**：`resizeDisplay` 不带 dpi，档位只在开会话时生效（中途换档就 1dp≠1CSSpx）。AndroMeld 的 resize 命令带 dpi（三个 int w/h/dpi），要跟就得**扩我们自己的协议** —— 那才能做到"窗口任意大也不掉清晰度/不漂移"。**M–L**
- 待查假设（都还没验证）：若是窗口跑屏外 → 看 Electron 侧边界（`mirrorWindowBounds` 只约束**初始**尺寸，手动拖拽无 workArea 上限）；若是窗内被裁 → 看 contain-fit 的尺寸来源（`syncCanvasBox` 取解码器帧尺寸，与 `resizeDisplay` 后的真实显示尺寸之间是否漏同步一次）。
- 顺带的真实缺陷（正常窗口尺寸不触发）：上游 `NewDisplayCapture` 对 flex display 用 `Size.constrain(constraints, false)` **逐维裁剪**，越界时显示形状与窗口形状脱钩（5600x5600 → 比例 1.296）。这台机 h265 上限**短边 4320 / 长边 8192**，倍率 3 下窗口任一边 >~1440 CSS px 就越界。
- 未验：只有竖屏排版、没有宽布局的 app 在横形显示上会怎样；真机反馈后再决定要不要按包豁免（但注意 §4 的"仓库不留单 app 适配"）。

---

## 4. App / 包名特殊定制：**代码侧已清零**

- 抖音适配随 `081f110` 删干净；`NATIVE_MIRROR.md` 写明「仓库不留单 app 适配」。全仓（`src/` + `electron/` + `shared/`）**没有任何按包名 / 应用名 / 机型 / 厂商分支的可执行代码**。历史产生过的 `padMode.js`、`kickDisplaySize`、`relayout.js`、`frameProbe.js`、`tablet` 模式、按包豁免全部删除。
- 仅剩注释痕迹：`shared/scrcpyConfig.js:42-43`（默认档位选 sharp 的理由是抖音顶部 tab 像素硬编码）、`electron/mirror/appSession.js:5-6`（引 MIUI `SecondaryDisplayLauncher` 行为）、`src/mirror/displayFollow.js:9`、测试 fixture 里的 `com.ss.android.ugc.aweme`。
- 仍在跑的**设备类别分支**（不算 app 定制，但属特殊处理，保留还是收敛需拍板）：`adb.js:319,350,673` 跳过 `emulator-*`；`:355` 优先带 `:` / `._adb-tls-connect` 的无线 serial；`:1412` 优先 `wlan` 网卡；`:287` 设备名读 `ro.product.marketname`（小米口味）。
- `debug.anddrive.vd.isr` 是留作 A/B 的逃生口，**既定接口，别动**。

---

## 5. 轮询 / 定时 / 调度（15 处）+ 死代码（X 组）

### 5.1 轮询与定时器

**主进程**

| 位置 | 周期 | 做什么 | 判断 |
| --- | --- | --- | --- |
| `electron/mdns.js:13,254` | 1000ms | PTR 重查，且 `adb.js:257-265` 起的 browser **没有 stop 路径** | **该修**：常驻 1s 组播 + UDP socket 只换一个 TXT 字段（= **D9**） |
| `electron/adb.js:218-229` | 1000ms | `waitForMdnsService` 轮询 `adb mdns services`；`:228` 取消时返回**永不 resolve 的 Promise** | **该修**：改事件驱动；取消要 reject 明确的"已取消" |
| `electron/adb.js:1292,1447` | 30s TTL | 设备统计缓存，与渲染层 1s 轮询叠成两层节流 | 与 HUD 那条一起收口 |
| `electron/main.js:204-215` | 3s | `TEARDOWN_TIMEOUT_MS` 与 `runDeviceTeardown` 赛跑 | 保留（退出兜底） |
| `electron/main.js:234-239` | 1000ms | dev-only `ppid===1` 孤儿看门狗 | 保留（dev 专用） |
| `electron/permissions.js:113` | 2000ms | `dns-sd` 探测「假设已授权」兜底 | 保留，但文案要说明是推测 |

**渲染层**

| 位置 | 周期 | 做什么 | 判断 |
| --- | --- | --- | --- |
| `src/App.vue:24-30` | 1s / 5s / 3s×10 | 发现 / 心跳 / 重连三个魔数 | 至少提成常量组；`:65` 切设备时 `continue` **不 sleep 就重查**，有 busy-spin 风险 → **该修** |
| `src/App.vue:217-237` | 1s | `discoverLoop` 被 **4 个调用点**重启（`:114`、`:167`、`:241`、`:280`） | 收成单入口 |
| `src/composables/useScrcpySessions.js:11,33` | 2000ms | 会话列表轮询 | **三条状态类轮询合成一条主进程事件推送** |
| `src/mirror/direct-session.js:263-283` | 2500ms | `watchAppStolen` → 每次设备侧 `dumpsys window \| grep -A4 \| grep -oE`（`adb.js:1101-1107`） | = **D8**：改成 focus / `visibilitychange` 时查一次；`decoder.sizeChanged` 是免费事件源 |
| `src/mirror/direct-session.js:244-260` | 100ms×1500ms / 4×400ms | `waitForDisplayId`、`ensureAppHere` 重试环 | 补的是 `:74` 从 server stdout 正则捞 displayId 的脆弱解析；服务端把 displayId 传出来就能一起删 |
| `src/mirror/App.vue:253-265` | 1000ms | HUD 统计轮询，**dev 专用却在正式包里照跑** | 加 `showHud` 守卫（顺手与 B1 一起） |
| `src/mirror/App.vue:89-119,164-172` | 420/3000/80/150/2400ms | 遮罩状态机 + 提示自消 | 见 §3，随遮罩收口一起简化 |
| `src/mirror/displayFollow.js:23,117` | 250ms | **debounce，刻意设计 + 有单测** | **别当轮询删**（理由见 `ARCHITECTURE.md` §4） |
| `src/mirror/audio.js:8-10,74-75,142` | 0.08/0.4/0.03s | 音频排程余量、队列阈值 120 | 保留 |
| `AppList.vue:35-39` | 20 / 3 / 7天 | 图标批次与并发 | 与 D4/O5 一起 |

> 顺带纠正一处误记：代码里**唯一的「90」是 `adb.js:450` `CACHE_MAX_AGE_MS = 90 天`**（应用快照过期），不存在 90s 冷却。

### 5.2 X 组：可直接删的死代码

- `electron/fsUtil.js:16,29` — `pruneStaleEntries`、`onceAsync` **全仓零调用**（已复核），文件塌成只留 `pathExists`。**S**
- `engine: "native"\|"scrcpy"` **没有任何代码分支读它**，却在各处活着：`shared/scrcpyConfig.js:14,79,110`、`src/components/ScrcpyLaunchDialog.vue:26`（写死 `native`）、`shared/types.js:33,47-56`（其中 `ScrcpySession.pid` typedef 已失效，pid 早就不存在）。= **O4**，与 `normalizeScrcpyConfig` 里的 `ENGINES` 一起删；渲染层默认参数改为 import shared 那份，别再手抄第二份（`useScrcpyPreferences.js:12-22`）。**S**
- `electron/adb.js:1162-1174` — 导出的 `launchApp` 无主进程也无 IPC 调用方。**S**
- `electron/adb.js:1507,1510` 把 `serial` 传给无参的 `resolveConnectAddress()`（= **D7**）；`:1570-1599` 六个 handler 的 `event` 参数未用。**S**
- **四个从未调用的 `use*()` 包装**：`useScrcpySessions.js:43`、`useNotifications.js:126`、`useConnectionPreferences.js:11`、`useScrcpyPreferences.js:62`；`useFavorites.js:62` 的 `favorites`/`reload` 唯一消费者不用；`useNotifications.js:112` 的 `notify.info` 从未用。**S**
- `src/api/index.js` — 约 40 个一行透传壳，纯重复 preload 命名（含 **B4**）。删层或删壳，二选一。**M**
- `ConfirmDialog.vue:13,20-29` — `cancel` 与 `close` 两个 emit 行为相同，调用点还都绑一样（`AppList.vue:558`、`PageHeader.vue:71`）。**S**
- `src/mirror/displayFollow.js:128` `lastSentKey` getter 只有测试用；`src/mirror/direct-session.js:212` `getController` 单调用方；`src/mirror/session.js`（88 行）是 8 个 handler 1:1 的转发壳 → **并进 `direct-session.js`**；`electron/mirror/appSession.js`（34 行）单调用方 → 可内联。**M**
- 迁移类遗留（可设到期日一次性删）：`electron/favorites.js:68-90` `collapseLegacy`（带 `.bak` + 进程标志）、`electron/scrcpyConfig.js:38-39,48-49` 的 `stored` 标志、`src/composables/useScrcpyPreferences.js:15-26,40-55` 渲染侧版本（localStorage → 主进程的一次性搬迁，两边各存一份）。**S**
- 重复校验：serial/package 合法性在 `electron/adb.js:157-164`、`:1066-1072`、`electron/shortcutCore.js:31-38`、`electron/favorites.js:118,131`、`electron/mirror/session.js:118-121` 各写一遍（package 一处正则、一处只判长度）。IPC 边界已校验，内部再校验属冗余 → 收成一个 `validators.js`。**S–M**
- 空 catch 吞异常（对照 `ARCHITECTURE.md` §4 的分寸）：`adb.js:278-281,373-375`、`iconImage.js:104`、`favorites.js:84-86`、`direct-session.js:99-101,123,128,135`（`:81-87` 双层嵌套全吞）。**S**
- 目录名与版本号的漂移：`electron/adb.js:534` 缓存目录仍叫 `apps-v1`，而版本常量已是 `CACHE_VERSION = 2`（`:449`）。**已复核这不致命** —— `:490` 读、`:506`/`:519` 写用的都是同一个常量，所以不会每次启动都作废缓存；只是目录名骗人，改名要连迁移一起做。**S**
- `main.js:24` 重复 `import "./mirror/session.js"`（`:12` 已导入）；`adb.js:108-132` `adbExecSafe` + `:60-64` `splitCallOptions` 靠嗅探 `args[0]` 区分调用形式，守的全是内部调用点。**S**
- ⚠️ **删再导出前先查测试**：`tests/electron/scrcpy.test.js:9-11` 现在从 `adb.js` 拿 `normalizeScrcpyConfig`/`DEFAULT_SCRCPY_CONFIG` 的**再导出**。把测试改成直接 import `shared/scrcpyConfig.js`，`adb.js:15,18` 那两条透传才能删。
- 已核实的一条同类死重：`electron/scrcpyConfig.js:24-31` 整块再导出（`computeDisplayMetrics` / `DISPLAY_BASE_DPI` / `DISPLAY_PIXEL_SCALE` / `DISPLAY_QUALITY_TIERS`）—— **渲染层三个消费点全部直接 import `shared/scrcpyConfig.js`**（`src/mirror/direct-session.js:3`、`src/mirror/connect.js:52`、`src/components/ScrcpyConfigFields.vue:3`），主进程侧也没人从这块取。可整块删。**S**

### 5.3 会话归属与跨层混淆（改动要谨慎）

- 两套「session」概念撞车：`useScrcpySessions`（主进程窗口注册表，UI 轮询）vs `direct-session.current`（每窗口 scrcpy 客户端）；`direct-session.js:50,58` 把 `current.info` **写两次**。
- 字段所有权倒挂：`electron/mirror/session.js:244-256` 把 codec/hasAudio 这些**渲染层拥有**的字段存进主进程记录；复用与新起两条路径返回**不同形状**（`:129` vs `:177`）；`:256` 大括号缩进错位。
- 状态双份：`electron/mirror/session.js:167-175` `pendingInit` 同时下发原始 `config` 与主进程派生 `prefs`，渲染层再规范化一遍（`electron/mirror/options.js:41,94,105`）；`turnScreenOff` 主进程决策、渲染层发控制消息执行。
- 通道命名说谎：`mirror:appTask` / `mirror:moveTask` 注册在 `adb.js:1605-1608`。
- 设备状态编排由渲染层定时器驱动（`direct-session.js:226-239` `reclaimApp` + `watchAppStolen`）。搬回应用一律用 `am display move-stack`，**绝不 force-stop**。

---

## 6. 功能点子（按是否需要授权分组）

### 6.1 只用 adb / shell uid，不需要用户点头（性价比最高）

| # | 功能 | 可行性依据 | 规模 | 对应 |
| --- | --- | --- | --- | --- |
| F1 | 一键截图到 Mac（同时进剪贴板） | `exec-out` 通道仓库已在用，`screencap -p` 无需权限 | S | P2-3 |
| F2 | 文件互传（拖拽 push/pull + 进度） | `adb pull` 已用于导 APK；进度按字节算，别解析 pull 的 stderr | M | P2-2 |
| F3 | APK 拖拽批量安装 | 安装链路已跑通（`install -r`） | S–M | P2-1 |
| F4 | 镜像里的系统动作键 | 就是 **B2/D2**，代码早写完，缺调用方 | S | — |
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
- **H4 Presenter 模式**：只推画面、Mac 当遥控器（翻页/音量/播放暂停走 F4），配合已有的全屏启动 —— 手机当演示笔。
- **H5 软键盘策略**：`displayImePolicy` 我们现在完全忽略（`options.js` 未映射）。加开关避免"投屏时手机弹键盘占半屏"。
- **H6 使用时长本地统计**：`dumpsys usagestats` shell 可读，首页给"今天最常用"，并给 MRU 排序（P1-4）提供真实数据源。
- **H7 镜像画面标注/截图卡片**：截一帧连应用名+时间戳存成卡片（截图见 F1，图标能力已在 `iconImage.js`），做"今天在手机上看过的东西"留痕。

---

## 7. 路线图剩余项（原 P0–P3，已完成的不再列）

| # | 项 | 状态与备注 |
| --- | --- | --- |
| P0-3 | 操作进行态与进度反馈 | Helper 安装/升级分阶段、图标补取 `已完成/总数`、禁用重复触发并暴露取消重试 |
| P0-4 | 设置持久化 | 上次设备 serial、scrcpy 默认参数、**窗口几何**、自动重连开关；「恢复默认」语义要先统一（见 §2 文案一致性） |
| P0-5 | 列表刷新与失败重试 | 刷新入口、图标批次指数退避（当前失败只记录）、区分「无应用」与「读取失败」空态 |
| P0-6 | 测试与 CI | = O12 + O13 |
| P1-1 | 搜索/排序 | `[~]` 收藏已完成；**待办**：拼音首字母搜索、名称/安装时间排序、MRU（依赖 P1-4）。注意现状**根本没有 MRU**（`ARCHITECTURE.md` §3） |
| P1-4 | MRU 跨会话持久化 | 按设备记录最近启动 + 上限淘汰 + 损坏降级为空；数据源可用 H6 |
| P2-4 | 快捷键与命令面板 | ⌘K 面板、⌘R 刷新、⌘, 设置、Esc 关闭 |
| P2-5 | 分组、标签与隐藏 | 自定义分组/标签/隐藏/显示名，本地持久化 |
| P3-1 | 多设备支持 | **待决策**，与"单设备优先"冲突；建议默认单设备 + 显式进入多设备模式。做之前先修 D7 |
| P3-2 | 记忆设备与启动自动重连 | 启动读上次 serial → mDNS 解析 → connect → 直接进首页。同样先修 D7 |
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
| **第 2 批：零风险清理** | §5.2 的 X 组（`fsUtil`、`engine` 字段、四个 `use*` 包装、`launchApp`、未用参数、`main.js` 重复 import、版本漂移），B1/B3/B4 | 每条独立可验，删完跑 `pnpm lint && typecheck && test` 就是回归 |
| **第 3 批：卡住问题拍板** | §0.2 那条：要不要重做「息屏弹醒」；不做就把 A/B1/B2 三类根因归档为已知限制 | 这是你点名的"最严重问题"，目前**零防线在跑**，别让它悬着 |
| **第 4 批：链路收口** | §5.1 三条状态轮询合成一条事件推送、mDNS browser 补 stop、D8 改事件驱动、D7 按 serial 解析、D4+O5+O6 图标链路 | 第 4 批开始要动 UI/链路，需要小设计 |
| **第 5 批：结构与几何** | O1 拆 `adb.js`、§3 遮罩与几何单一主人化、§5.3 会话归属合并、`session.js` 并进 `direct-session.js` | 拆分与几何都要一次做透；**几何要先按 `NATIVE_MIRROR.md` §4.0 的纪律复现一次再改** |
| **并行可插队** | B2/F4 动作键、F1 截图、F7 二维码页、O12 一条 CI、O9/O10 对话框与空态 | 便宜且用户可感 |

---

## 10. 口径与「已经确认不是问题」

- 本文所有 `file:line` 由并行探查主进程 / 渲染层 / 文档三路后**逐条复核**；复核不上的（包括一些被夸大的性能说法）没写进来。
- **安全边界已处理好**：包名进设备 shell 前有正则+长度校验（`adb.js` 起），`moveAppTaskToDisplay` 只接受校验过的整数；serial 走 `execFile` 参数数组而非拼 shell；dev launcher 脚本路径经 `shellQuote`（`shortcut.js:144`）；osascript 只接 argv（`iconImage.js:81`）；`.adr` 内容经 `URLSearchParams` 编解码并在读取时重新校验（`shortcutCore.js:67-93`）。
- **并发与原子性已有守卫**：稳定标识解析有 in-flight 去重、缓存写 tmp+rename 原子、发现循环令牌化。D4 是"守卫不够细"，不是"没有守卫"。
- **反馈链路已修过一轮**：P0-1（`useNotifications` + 列表/图标/Helper 失败提示）与 P0-2（心跳 + 退避重连）确实交付了。仍漏的死角：O10，以及 `useScrcpyPreferences.js:42` 那个 `.catch(() => {})` 把参数保存失败吞干净了。
- **当前基线**：`adbExec` / `adbExecSafe` 每次调用都带超时（默认 15s、connect/pair 45s、安装卸载拉文件 5min），超时统一报「设备无响应」，`getDeviceState` 把超时归为 `offline`；`CHANNELS` 是唯一通道来源并有唯一性单测守着。**2026-09-28 复跑的绿灯**：`typecheck` 通过、`test` 197 passed / 1 skipped、`oxlint` 83 文件 0 错、`eslint` 0 错（原体检里的 **O0「lint 门是红的」确已修掉**，故不再列为待办）。
